import "server-only";

// NEP-413 sign-in → HMAC session cookie (frontend-spec §3.1, §7).
//
// Nonce: 32 bytes = 8-byte ms timestamp ‖ 16 random bytes ‖ 8-byte HMAC tag,
// so the server can check it was issued here and is < 5 min old without a
// database. Single use is enforced with an in-memory set (per instance).
// TODO: move used nonces + sessions to a shared KV for multi-instance deploys.
//
// Signature check: near-api-js `verifyMessage` serializes the NEP-413 payload
// and checks the key is a FULL-ACCESS key of the account via RPC.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { baseDecode } from "near-api-js";
import { verifyMessage } from "near-api-js/nep413";
import { readProvider } from "@/lib/near/rpc";
import { isValidAccountId } from "@/lib/near/config";
import { AUTH_MESSAGE, AUTH_RECIPIENT } from "@/lib/auth-message";

export const SESSION_COOKIE_NAME = "trellis_session";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const NONCE_TTL_MS = 5 * 60 * 1000;

let devSecret: string | null = null;
function secret(): string {
  const s = process.env.AUTH_SECRET || process.env.API_SIGNING_SECRET;
  if (s && s.length >= 16) return s;
  if (process.env.NODE_ENV === "production") {
    throw new Error("AUTH_SECRET (or API_SIGNING_SECRET) must be set in production.");
  }
  if (!devSecret) {
    devSecret = randomBytes(32).toString("hex");
    console.warn("[auth] AUTH_SECRET unset: using a random per-process secret (dev only).");
  }
  return devSecret;
}

const mac = (data: Buffer | string) => createHmac("sha256", secret()).update(data).digest();

/** HMAC-SHA256 (base64url) with the auth secret, for other signed server tokens. */
export const signServerData = (data: string) => mac(data).toString("base64url");
export function verifyServerData(data: string, sig: string): boolean {
  const a = Buffer.from(sig);
  const b = Buffer.from(signServerData(data));
  return a.length === b.length && timingSafeEqual(a, b);
}

export function issueNonce(): string {
  const ts = Buffer.alloc(8);
  ts.writeBigUInt64BE(BigInt(Date.now()));
  const rnd = randomBytes(16);
  const body = Buffer.concat([ts, rnd]);
  const tag = mac(Buffer.concat([Buffer.from("nonce|"), body])).subarray(0, 8);
  return Buffer.concat([body, tag]).toString("base64");
}

const usedNonces = new Map<string, number>();
function consumeNonce(nonceB64: string): boolean {
  let buf: Buffer;
  try {
    buf = Buffer.from(nonceB64, "base64");
  } catch {
    return false;
  }
  if (buf.length !== 32) return false;
  const body = buf.subarray(0, 24);
  const tag = buf.subarray(24);
  const expect = mac(Buffer.concat([Buffer.from("nonce|"), body])).subarray(0, 8);
  if (!timingSafeEqual(tag, expect)) return false;
  const issued = Number(body.readBigUInt64BE(0));
  if (Date.now() - issued > NONCE_TTL_MS || issued > Date.now() + 60_000) return false;
  const now = Date.now();
  for (const [k, t] of usedNonces) if (now - t > NONCE_TTL_MS) usedNonces.delete(k);
  // Key by the decoded bytes: base64 has non-canonical spellings of the same bytes.
  const key = buf.toString("hex");
  if (usedNonces.has(key)) return false;
  usedNonces.set(key, now);
  return true;
}

export type SignInBody = {
  accountId: string;
  publicKey: string;
  signature: string;
  nonce: string; // base64, as issued
  message: string;
  recipient: string;
};

/** Verifies a NEP-413 sign-in. Returns the account id or an error string. */
export async function verifySignIn(b: SignInBody): Promise<{ accountId: string } | { error: string }> {
  if (!b || typeof b.accountId !== "string" || !isValidAccountId(b.accountId)) return { error: "bad account id" };
  if (b.message !== AUTH_MESSAGE || b.recipient !== AUTH_RECIPIENT) return { error: "unexpected message or recipient" };
  if (typeof b.signature !== "string" || typeof b.publicKey !== "string") return { error: "missing signature" };
  if (!consumeNonce(b.nonce)) return { error: "stale, reused or forged nonce" };
  // Wallets return base64; some may return "ed25519:<base58>" [VERIFY per wallet].
  const sig = b.signature.startsWith("ed25519:")
    ? baseDecode(b.signature.slice("ed25519:".length))
    : Uint8Array.from(Buffer.from(b.signature, "base64"));
  try {
    await verifyMessage({
      signerAccountId: b.accountId,
      signerPublicKey: b.publicKey,
      payload: {
        message: b.message,
        recipient: b.recipient,
        nonce: Uint8Array.from(Buffer.from(b.nonce, "base64")),
      },
      signature: sig,
      provider: readProvider(),
    });
  } catch (e) {
    const msg = (e as Error).message ?? "";
    // The failover provider reports "key not found on this account" as "Exceeded N providers".
    return {
      error: /Exceeded \d+ providers|does not exist|not have/i.test(msg)
        ? "the signing key is not a full-access key of this account"
        : `invalid signature: ${msg.slice(0, 120)}`,
    };
  }
  return { accountId: b.accountId };
}

function encodeSession(accountId: string): string {
  const payload = Buffer.from(JSON.stringify({ a: accountId, e: Date.now() + SESSION_TTL_MS })).toString("base64url");
  return `${payload}.${mac(`sess|${payload}`).toString("base64url")}`;
}

function decodeSession(raw: string | undefined): string | null {
  if (!raw) return null;
  const [payload, sig] = raw.split(".");
  if (!payload || !sig) return null;
  const expect = mac(`sess|${payload}`).toString("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const { a: acct, e } = JSON.parse(Buffer.from(payload, "base64url").toString()) as { a: string; e: number };
    if (typeof acct !== "string" || Date.now() > e) return null;
    return acct;
  } catch {
    return null;
  }
}

export async function setSessionCookie(accountId: string) {
  (await cookies()).set(SESSION_COOKIE_NAME, encodeSession(accountId), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
  });
}

export async function clearSessionCookie() {
  (await cookies()).delete(SESSION_COOKIE_NAME);
}

/** The NEP-413-verified account of this request, or null. */
export async function sessionAccount(): Promise<string | null> {
  return decodeSession((await cookies()).get(SESSION_COOKIE_NAME)?.value);
}
