# Wallet: NEAR Connect in Next.js App Router

Verified against `@hot-labs/near-connect@0.11.4` type defs + `build/NearConnector.js`, and
`near-connect-hooks@1.1.6` `dist/useNearWallet.js` (2026-10-22).

```bash
pnpm add @hot-labs/near-connect@0.11.4 near-api-js@7.3.1
pnpm add near-connect-hooks@1.1.6        # optional convenience layer
```

## API surface you actually use

```ts
import { NearConnector, type NearWalletBase, type ConnectorAction } from "@hot-labs/near-connect";

new NearConnector({
  network?: "mainnet" | "testnet",        // default "mainnet" (near-connect itself)
  features?: Partial<WalletFeatures>,     // filter wallets, e.g. { signMessage: true }
  walletConnect?: SignClient | Promise<SignClient>,
  footerBranding?: FooterBranding | null, // null hides "NEAR Connector" footer
  excludedWallets?: string[], autoConnect?: boolean, cspNonce?: string,
  providers?: { mainnet?: string[]; testnet?: string[] },
});
connector.whenManifestLoaded: Promise<void>
connector.connect({ walletId?, signMessageParams?, addFunctionCallKey? }): Promise<NearWalletBase>
connector.disconnect(wallet?): Promise<void>
connector.getConnectedWallet(): Promise<{ wallet, accounts }>   // throws if none
connector.wallet(id?): Promise<NearWalletBase>                  // throws "No accounts found"
connector.on("wallet:signIn" | "wallet:signInAndSignMessage" | "wallet:signOut" | "selector:walletsChanged", cb)

wallet.getAccounts(): Promise<{ accountId: string; publicKey?: string }[]>
wallet.signAndSendTransaction({ receiverId, actions, signerId?, network? }): Promise<FinalExecutionOutcome>
wallet.signAndSendTransactions({ transactions: [{ receiverId, actions }] }): Promise<FinalExecutionOutcome[]>
wallet.signMessage({ message, recipient, nonce: Uint8Array }): Promise<{ accountId; publicKey; signature }>
wallet.signDelegateActions({ delegateActions: [{ receiverId, actions }] }): Promise<{ signedDelegateActions: string[] }>
```

`actions` accepts either ConnectorAction objects (`{ type: "FunctionCall", params: { methodName, args, gas, deposit } }`)
or near-api-js `actions.functionCall(...)` objects (converted by `nearActionsToConnectorActions`).
Use ConnectorAction in the browser: plain JSON, easy to show in Trellis's transaction viewer.

## Next.js App Router setup (own provider, recommended)

near-connect is SSR-guarded internally, but wallets/iframes/IndexedDB only exist in the browser,
so create the connector in an effect inside a `"use client"` module.

```tsx
// src/components/near/near-wallet-provider.tsx
"use client";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { NearConnector, NearWalletBase } from "@hot-labs/near-connect";

type Ctx = {
  connector: NearConnector | null;
  wallet: NearWalletBase | null;
  accountId: string | null;
  ready: boolean;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
};
const NearWalletCtx = createContext<Ctx | null>(null);

export function NearWalletProvider({ children }: { children: ReactNode }) {
  const [connector, setConnector] = useState<NearConnector | null>(null);
  const [wallet, setWallet] = useState<NearWalletBase | null>(null);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { NearConnector } = await import("@hot-labs/near-connect"); // browser-only chunk
      const c = new NearConnector({
        network: "mainnet",
        footerBranding: { heading: "Trellis", link: "https://trellis.example", linkText: "What is NEAR?" },
      });
      c.on("wallet:signIn", async ({ wallet, accounts }) => {
        setWallet(wallet);
        setAccountId(accounts[0]?.accountId ?? null);
      });
      c.on("wallet:signOut", () => { setWallet(null); setAccountId(null); });
      // Restore a previous session (selected wallet id is kept in localStorage by near-connect).
      const existing = await c.getConnectedWallet().catch(() => null);
      if (cancelled) return;
      if (existing) { setWallet(existing.wallet); setAccountId(existing.accounts[0]?.accountId ?? null); }
      setConnector(c);
      setReady(true);
    })();
    return () => { cancelled = true; };
  }, []);

  const value = useMemo<Ctx>(() => ({
    connector, wallet, accountId, ready,
    connect: async () => { if (connector) await connector.connect(); }, // opens wallet picker popup
    disconnect: async () => { if (connector && wallet) await connector.disconnect(wallet); },
  }), [connector, wallet, accountId, ready]);

  return <NearWalletCtx.Provider value={value}>{children}</NearWalletCtx.Provider>;
}

export function useNearWallet() {
  const ctx = useContext(NearWalletCtx);
  if (!ctx) throw new Error("useNearWallet must be used inside <NearWalletProvider>");
  return ctx;
}
```

Mount it in a client `providers.tsx` that `app/layout.tsx` renders (replacing Trellis's dapp-kit providers).
`connector.connect()` rejects with `Error("User rejected")` when the picker is closed: catch it silently.

### Alternative: near-connect-hooks

```tsx
"use client"; // the package itself has no "use client" directive
import { NearProvider, useNearWallet } from "near-connect-hooks";

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <NearProvider config={{ network: "mainnet", providers: { mainnet: ["https://free.rpc.fastnear.com"] } }}>
      {children}
    </NearProvider>
  );
}
// useNearWallet() → { signedAccountId ("" when signed out), loading, signIn, signOut, viewFunction,
//   callFunction, callFunctionRaw, signAndSendTransaction(s), signNEP413Message, getBalance, provider, connector }
```
Caveats from source: default network is **testnet**; it constructs `NearConnector` inside `useMemo` during render
(so wrap with `dynamic(() => import("./providers"), { ssr: false })` if you see hydration noise); `callFunction`
defaults gas 30 Tgas / deposit "0"; it installs `function-call-key-plugin` (stores local FC keys) — not needed by Trellis.

## Trellis transactions (user-signed)

Gas/deposit constants (strings, ConnectorAction format):

```ts
export const TGAS = (n: number) => (BigInt(n) * 10n ** 12n).toString();
export const ONE_YOCTO = "1";
export const NEAR = (n: string) => nearToYocto(n as `${number}`).toString(); // from near-api-js
```

```ts
import type { ConnectorAction, NearWalletBase } from "@hot-labs/near-connect";
import { getTransactionLastResult } from "near-api-js";

const fc = (methodName: string, args: object, gas = TGAS(30), deposit = "0"): ConnectorAction => ({
  type: "FunctionCall", params: { methodName, args, gas, deposit },
});

// 1) Create the user's vault via the factory (payable). Gas: [VERIFY] measure in sandbox.
export async function createVault(wallet: NearWalletBase, factoryId: string) {
  const outcome = await wallet.signAndSendTransaction({
    receiverId: factoryId,
    actions: [fc("create_vault", {}, TGAS(150), NEAR("1"))],
  });
  return { txHash: outcome.transaction.hash, result: getTransactionLastResult(outcome) };
}

// 2) Owner method with assert_one_yocto (set_policy / revoke_agent / withdraw_ft / pause)
export const revokeAgent = (w: NearWalletBase, vaultId: string) =>
  w.signAndSendTransaction({ receiverId: vaultId, actions: [fc("revoke_agent", {}, TGAS(30), ONE_YOCTO)] });

// 3) Deposit USDC into the vault: storage_deposit (if needed) + ft_transfer_call, as two txs in one wallet prompt.
//    ft_transfer_call needs exactly 1 yocto and enough gas for the receiver's ft_on_transfer + resolve.
export async function depositFt(w: NearWalletBase, token: string, vaultId: string, amount: string, needsStorage: boolean) {
  const txs = [];
  if (needsStorage) txs.push({ receiverId: token, actions: [fc("storage_deposit", { account_id: vaultId, registration_only: true }, TGAS(10), NEAR("0.00125"))] });
  txs.push({ receiverId: token, actions: [fc("ft_transfer_call", { receiver_id: vaultId, amount, msg: "" }, TGAS(60), ONE_YOCTO)] });
  return w.signAndSendTransactions({ transactions: txs }); // FinalExecutionOutcome[] in order
}
```
- Check storage first with a view call: `storage_balance_of({ account_id: vaultId })` → `null` means unregistered.
  0.00125 NEAR is the usual NEP-145 minimum for `wrap.near`/USDC; read `storage_balance_bounds` to be exact.
- Multiple **actions** in one tx all target one receiver and are atomic; multiple **transactions** are not atomic
  (later ones can still run after an earlier failure). Trellis's "not all-or-nothing" guardian row applies here.
- Outcome parsing (failures in later receipts, events): see `near-api-js.md`.

## NEP-413 sign-in (prove account ownership to the server)

Client: get a server nonce, sign, POST back. Use `connect({ signMessageParams })` to do sign-in + signature in one prompt
(only wallets with `signInAndSignMessage`); otherwise `wallet.signMessage` after connect.

```ts
// client
const { nonce } = await fetch("/api/auth/nonce").then((r) => r.json());           // base64 of 32 random bytes
const nonceBytes = Uint8Array.from(atob(nonce), (c) => c.charCodeAt(0));
const message = "Sign in to Trellis";
const recipient = "trellis.app";                                                  // your domain / app id
const signed = await wallet.signMessage({ message, recipient, nonce: nonceBytes });
await fetch("/api/auth/verify", { method: "POST", body: JSON.stringify({ ...signed, message, recipient, nonce }) });
```

Server (Node runtime route; near-api-js `verifyMessage` checks the key is a **FullAccess** key of `accountId` via RPC,
serializes the NEP-413 payload with the 2^31+413 prefix tag, and verifies ed25519):

```ts
// src/app/api/auth/verify/route.ts
import "server-only";
import { verifyMessage } from "near-api-js/nep413";
import { provider } from "@/lib/near/provider"; // FailoverRpcProvider, see near-api-js.md

export async function POST(req: Request) {
  const { accountId, publicKey, signature, message, recipient, nonce } = await req.json();
  if (recipient !== "trellis.app" || message !== "Sign in to Trellis") return new Response("bad payload", { status: 400 });
  if (!(await consumeNonce(nonce))) return new Response("stale nonce", { status: 401 }); // single-use, TTL ~5 min
  const sigBytes = signature.startsWith("ed25519:")                 // some wallets may return base58 [VERIFY]
    ? (await import("near-api-js")).baseDecode(signature.slice(8))
    : Uint8Array.from(Buffer.from(signature, "base64"));
  try {
    await verifyMessage({
      signerAccountId: accountId,
      signerPublicKey: publicKey,
      payload: { message, recipient, nonce: Uint8Array.from(Buffer.from(nonce, "base64")) },
      signature: sigBytes,
      provider,
    }); // throws on bad sig or non-FullAccess key
  } catch {
    return new Response("invalid signature", { status: 401 });
  }
  return issueSessionCookie(accountId); // your JWT/iron-session; replaces Trellis's memory-token grant
}
```
`consumeNonce` / `issueSessionCookie` are yours (KV/Upstash or signed cookie). Alternative verifier with no RPC:
`verifyNep413Signature({ publicKey, signature, message, nonce, recipient })` from `@fastnear/utils` (accepts base64 or
`ed25519:` base58) — but then you must check the key belongs to the account yourself (`provider.viewAccessKey`).

## Wallets in the live manifest (2026-10-22) and what they support

Fetched from `raw.githubusercontent.com/hot-dao/near-selector/refs/heads/main/repository/manifest.json` (v1.1.0):

| id | signMessage | signInAndSignMessage | signDelegateActions | testnet flag |
|---|---|---|---|---|
| hot-wallet | ✓ | ✓ | ✓ | – (throws on testnet) |
| meteor-wallet | ✓ | ✓ | ✓ | ✓ |
| intear-wallet | ✓ | ✓ | ✓ | ✓ |
| ledger | ✓ | ✓ | ✓ | ✓ |
| near-mobile | ✓ | ✓ | ✓ | – |
| near-cli | ✓ | ✓ | ✓ | ✓ |
| mynearwallet, okx-wallet | ✓ | ✓ | – | – |
| nightly-wallet, wallet-connect, unity-wallet | ✓ | ✓ | – | ✓ |
| hana-wallet | ✓ | – | – | – |
| trezu-wallet, ethereum-wallets | – | – | – | (eth: ✓) |

- On `network: "testnet"` near-connect hides wallets without the `testnet` feature.
- `wallet-connect`/`unity-wallet` need the `walletConnect` option (they have `permissions.walletConnect`).
- For a gasless flow only offer delegate-capable wallets: `connector.connect()` after constructing with
  `features: { signDelegateActions: true }`, or check `wallet.manifest.features.signDelegateActions` before calling it.
- The manifest is remote and changes without a redeploy; re-check before the demo.

## Gotchas

- `FinalExecutionOutcome` from the wallet is already final-ish; still poll `viewTransactionStatus` if you need `FINAL`.
- `signerId`/`network` params are optional; omit them (the wallet uses the signed-in account).
- `addFunctionCallKey` on connect lets a wallet add a limited key for the app. Trellis doesn't need it: agent keys live on
  `agent.trellis.near`, not on the user account. Don't ask users for it.
- Nonce for NEP-413 must be exactly 32 bytes.
- CSP with nonces: pass `cspNonce` or the wallet iframe scripts won't run.
