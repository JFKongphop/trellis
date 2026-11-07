// NEAR transaction shapes shared by the plan builder (server), the plan card
// and the wallet (client). ConnectorAction format from @hot-labs/near-connect:
// plain JSON, gas/deposit as yocto strings (near-frontend skill, wallet.md).

export type NearAction =
  | {
      type: "FunctionCall";
      params: { methodName: string; args: Record<string, unknown>; gas: string; deposit: string };
    }
  | { type: "Transfer"; params: { deposit: string } };

export type NearTx = {
  receiverId: string;
  actions: NearAction[];
  /** Plain-English summary shown in the transaction list. */
  label: string;
  /** Plan step ids this transaction belongs to. */
  stepIds: string[];
};

export const ONE_YOCTO = "1";
export const tgas = (n: number) => (BigInt(n) * BigInt(10) ** BigInt(12)).toString();

export const fc = (
  methodName: string,
  args: Record<string, unknown>,
  gasTgas = 30,
  deposit = "0",
): NearAction => ({
  type: "FunctionCall",
  params: { methodName, args, gas: tgas(gasTgas), deposit },
});

export const transfer = (yocto: string): NearAction => ({
  type: "Transfer",
  params: { deposit: yocto },
});

/** Human decimal string/number → base units, exact (no float rounding up). */
export function toBase(human: number | string, decimals: number): bigint {
  // Shortest decimal form of the number (0.1 → "0.1", 1e-7 → "0.0000001").
  const s =
    typeof human === "number"
      ? human.toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: 20 })
      : human.trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`Bad amount: ${human}`);
  const [w, f = ""] = s.split(".");
  const frac = (f + "0".repeat(decimals)).slice(0, decimals);
  return BigInt(w) * BigInt(10) ** BigInt(decimals) + BigInt(frac || "0");
}

/** Base units → human number (display only). */
export function fromBase(raw: bigint | string, decimals: number): number {
  const b = BigInt(raw);
  const d = BigInt(10) ** BigInt(decimals);
  return Number(b / d) + Number(b % d) / 10 ** decimals;
}

export const NEAR_YOCTO = (near: number | string) => toBase(near, 24).toString();
