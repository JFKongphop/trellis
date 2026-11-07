// Demo mode, set by `pnpm demo` (demo/run.mjs):
// - "replay" (default, light): only the web app runs; it replays a recorded local-sandbox run.
// - "1" / live (`pnpm demo:live`, heavy): a real local NEAR sandbox with real Rhea / Ref / wNEAR code
//   and the Trellis worker; the server signs as a demo account instead of a browser wallet.
const MODE = process.env.NEXT_PUBLIC_DEMO_MODE;
export const DEMO = MODE === "1" || MODE === "replay";
export const DEMO_REPLAY = MODE === "replay";

export type DemoInfo = {
  accountId: string;
  vault: string;
  nearUsd: number;
  startNearUsd: number;
  mode: "live" | "replay";
  /** Native NEAR of the demo account (replay: there is no chain to read it from). */
  nearBalance?: number;
};
