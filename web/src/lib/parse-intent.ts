// Example prompt chips on the idle hero: starters across the Trellis surface
// (frontend-spec §4.1). Read prompts work today; the action prompts make the
// agent explain the plan until wallet-mode executePlan / vault actions land.
import { NEAR_NETWORK } from "@/lib/near/config";

export const EXAMPLE_PROMPTS: { label: string; text: string }[] = [
  { label: "what's my health factor?", text: "what's my health factor on Rhea?" },
  { label: "best yield for my USDC?", text: "what's the best yield for my USDC?" },
  { label: "what's in my wallet?", text: "what's in my wallet?" },
  { label: "what does borrowing cost?", text: "what does it cost to borrow USDC on Rhea right now?" },
  { label: "loop my vault to 1.8x", text: "loop my vault to 1.8x" },
  NEAR_NETWORK === "testnet"
    ? { label: "show me the demo vault", text: "show me the demo vault and its health factor" }
    : { label: "bring 100 USDC from Base", text: "bring 100 USDC from Base" },
  { label: "how does a leverage loop work?", text: "explain how a leverage loop works" },
];
