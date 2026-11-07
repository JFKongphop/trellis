// Money-flow graph for a plan (or a run of agent moves): nodes are the places money sits or passes
// through (your wallet or vault, wrap.near, a Ref pool, Rhea Lending, a recipient), edges are the
// token moves between them, numbered in the order they happen. Pure: no React, no imports.

export type FlowStepInput = {
  id: string;
  /** Plan step kind (wrap, unwrap, swap, supply, borrow, repay, withdraw, send, depositToVault, wrapNear,
   *  withdrawCollateral, withdrawSupplied). */
  kind: string;
  label?: string;
  tokenIn?: string;
  amountIn?: number;
  tokenOut?: string;
  amountOut?: number;
  minOut?: number;
  pool?: number;
  to?: string;
  /** Earlier step whose output this step uses (otherwise it starts from the wallet / vault). */
  fromStep?: string;
};

export type FlowNodeKind = "wallet" | "vault" | "wrap" | "ref" | "rhea" | "recipient";

export type FlowNode = {
  id: string;
  kind: FlowNodeKind;
  title: string;
  sub?: string;
  /** Net effect lines, e.g. "collateral +49.8 USDC". */
  details: string[];
};

export type FlowEdge = {
  id: string;
  from: string;
  to: string;
  /** 1-based step numbers this move belongs to: one, or two when an output flows straight into the next step. */
  steps: number[];
  amount: string;
  /** Estimated (a swap quote), not exact. */
  estimate?: boolean;
};

export type MoneyFlow = { nodes: FlowNode[]; edges: FlowEdge[] };

export type FlowOptions = {
  mode: "wallet" | "vault";
  healthBefore?: number | null;
  healthAfter?: number | null;
};

const num = (n: number | undefined) => {
  if (n === undefined || !Number.isFinite(n)) return "?";
  const abs = Math.abs(n);
  return n.toLocaleString("en-US", { maximumFractionDigits: abs >= 100 ? 2 : abs >= 1 ? 4 : 6 });
};
const amt = (n: number | undefined, t: string | undefined) => `${num(n)} ${t ?? ""}`.trim();
const hf = (h: number | null | undefined) => (h === null ? "∞" : h === undefined ? "?" : h.toFixed(2));

export function buildMoneyFlow(steps: FlowStepInput[], opts: FlowOptions): MoneyFlow {
  const home = opts.mode === "vault" ? "vault" : "wallet";
  const nodes = new Map<string, FlowNode>();
  const edges: FlowEdge[] = [];
  const node = (id: string, kind: FlowNodeKind, title: string, sub?: string) => {
    if (!nodes.has(id)) nodes.set(id, { id, kind, title, sub, details: [] });
    return id;
  };
  node(home, home, opts.mode === "vault" ? "Your vault" : "Your wallet");
  const rhea = () => node("rhea", "rhea", "Rhea Lending", "contract.main.burrow.near");
  const wrap = () => node("wrap", "wrap", "wrap.near", "NEAR ⇄ wNEAR");
  const ref = (pool?: number) => node(`ref:${pool ?? "?"}`, "ref", "Ref DEX", pool !== undefined ? `pool ${pool}` : "swap");

  // where each step's output sits until someone uses it
  const outAt = new Map<string, string>();
  const consumed = new Set(steps.map((s) => s.fromStep).filter((x): x is string => !!x));
  const lend = new Map<string, number>(); // "collateral|USDC" → net change
  const bump = (k: string, d: number | undefined) => lend.set(k, (lend.get(k) ?? 0) + (d ?? 0));

  const stepNo = new Map(steps.map((s, i) => [s.id, i + 1]));
  steps.forEach((s, i) => {
    const step = i + 1;
    const chained = !!(s.fromStep && outAt.get(s.fromStep));
    const src = chained ? outAt.get(s.fromStep!)! : home;
    const inSteps = chained ? [stepNo.get(s.fromStep!)!, step] : [step];
    // the edge carrying this step's input; any other edge of the step is its own output
    let first = true;
    const edge = (from: string, to: string, amount: string, estimate = false) => {
      edges.push({ id: `${s.id}:${edges.length}`, from, to, steps: first ? inSteps : [step], amount, estimate });
      first = false;
    };
    // output goes back home unless a later step picks it up
    const deliver = (at: string, amount: string, estimate = false) => {
      outAt.set(s.id, at);
      if (!consumed.has(s.id) && at !== home) {
        first = false; // an output edge, not the input one
        edge(at, home, amount, estimate);
      }
    };

    switch (s.kind) {
      case "wrap":
      case "wrapNear":
        edge(src, wrap(), amt(s.amountIn ?? s.amountOut, "NEAR"));
        deliver(wrap(), amt(s.amountOut ?? s.amountIn, "wNEAR"));
        break;
      case "unwrap":
        edge(src, wrap(), amt(s.amountIn, "wNEAR"));
        deliver(wrap(), amt(s.amountOut ?? s.amountIn, "NEAR"));
        break;
      case "swap": {
        const r = ref(s.pool);
        edge(src, r, amt(s.amountIn, s.tokenIn));
        deliver(r, `≈ ${amt(s.amountOut ?? s.minOut, s.tokenOut)}`, true);
        break;
      }
      case "supply": {
        edge(src, rhea(), amt(s.amountIn, s.tokenIn));
        const notCollateral = /not collateral/i.test(s.label ?? "");
        bump(`${notCollateral ? "supplied" : "collateral"}|${s.tokenIn}`, s.amountIn);
        outAt.set(s.id, rhea());
        break;
      }
      case "repay":
        edge(src, rhea(), amt(s.amountIn, s.tokenIn));
        bump(`debt|${s.tokenIn}`, -(s.amountIn ?? 0));
        outAt.set(s.id, rhea());
        break;
      case "borrow":
        bump(`debt|${s.tokenOut}`, s.amountOut);
        deliver(rhea(), amt(s.amountOut, s.tokenOut));
        break;
      case "withdraw":
      case "withdrawCollateral":
      case "withdrawSupplied": {
        const supplied = s.kind === "withdrawSupplied" || /supplied/i.test(s.label ?? "");
        bump(`${supplied ? "supplied" : "collateral"}|${s.tokenOut}`, -(s.amountOut ?? 0));
        deliver(rhea(), s.amountOut !== undefined ? amt(s.amountOut, s.tokenOut) : `all ${s.tokenOut ?? ""}`.trim());
        break;
      }
      case "send": {
        const to = s.to ?? "recipient";
        edge(src, node(`to:${to}`, "recipient", to, "irreversible"), amt(s.amountIn, s.tokenIn));
        break;
      }
      case "depositToVault":
        edge(src, node("vault", "vault", "Your vault"), amt(s.amountIn, s.tokenIn));
        break;
      default:
        break;
    }
  });

  const r = nodes.get("rhea");
  if (r) {
    for (const [k, v] of lend) {
      if (Math.abs(v) < 1e-12) continue;
      const [what, token] = k.split("|");
      r.details.push(`${what} ${v > 0 ? "+" : "−"}${num(Math.abs(v))} ${token}`);
    }
    if (opts.healthBefore !== undefined || opts.healthAfter !== undefined) {
      r.details.push(`health factor ${hf(opts.healthBefore)} → ${hf(opts.healthAfter)}`);
    }
  }
  // a node nothing flows through (e.g. the vault when every move chains Rhea → Ref → Rhea) is noise
  const used = new Set(edges.flatMap((e) => [e.from, e.to]));
  return { nodes: [...nodes.values()].filter((n) => used.has(n.id)), edges };
}

/** Agent moves (vault receipts, oldest first) as flow steps: each move uses the previous one's
 *  output when the token matches (withdraw → swap → repay). */
export function stepsFromMoves(
  moves: { id: string; kind: string; tokenIn?: string; amountIn?: number; tokenOut?: string; amountOut?: number }[],
): FlowStepInput[] {
  const map: Record<string, string> = {
    WithdrawCollateral: "withdrawCollateral",
    WithdrawSupplied: "withdrawSupplied",
    SwapRef: "swap",
    Repay: "repay",
    Supply: "supply",
    Borrow: "borrow",
    WrapNear: "wrapNear",
  };
  const out: FlowStepInput[] = [];
  for (const m of moves) {
    const kind = map[m.kind];
    if (!kind) continue;
    const prev = out[out.length - 1];
    const prevOut = prev?.tokenOut;
    out.push({
      id: m.id,
      kind,
      tokenIn: m.tokenIn,
      amountIn: m.amountIn,
      tokenOut: m.tokenOut,
      amountOut: m.amountOut,
      fromStep: prev && prevOut && m.tokenIn === prevOut ? prev.id : undefined,
    });
  }
  return out;
}
