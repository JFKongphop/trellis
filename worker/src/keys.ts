// Deterministic per-vault function-call keys: one secret (AGENT_KEY_SEED) instead of N stored keys.
// A leaked seed exposes every vault key, but each key is still bounded by its vault's policy and
// owners can revoke the agent instantly. Rotate by bumping the version tag and re-adding keys.
import { createHmac } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import { baseEncode, KeyPair, KeyPairSigner, type KeyPairString } from "near-api-js";

const VERSION = "v1";

export function vaultSecretKey(seed: string, vaultId: string): KeyPairString {
  const sk = createHmac("sha256", seed).update(`trellis-agent:${VERSION}:${vaultId}`).digest(); // 32 bytes
  const pk = ed25519.getPublicKey(new Uint8Array(sk));
  return `ed25519:${baseEncode(new Uint8Array([...sk, ...pk]))}` as KeyPairString; // NEAR secret = seed‖pubkey
}

export function vaultPublicKey(seed: string, vaultId: string): string {
  return KeyPair.fromString(vaultSecretKey(seed, vaultId)).getPublicKey().toString();
}

const cache = new Map<string, KeyPairSigner>();
export function signerFor(seed: string, vaultId: string): KeyPairSigner {
  let s = cache.get(vaultId);
  if (!s) {
    s = KeyPairSigner.fromSecretKey(vaultSecretKey(seed, vaultId));
    cache.set(vaultId, s);
  }
  return s;
}
