import "server-only";

// Wallet-mode plan builder (frontend-spec §6): validated steps → resolved
// steps + NEAR transactions (user-signed) + deterministic Guardian rows.
// Shapes: rhea-burrow-lending actions.md (§2 ft_transfer_call msgs, §3–4
// execute / execute_with_pyth), ref-dex-swaps classic-pools.md §3 (instant
// swap), near-frontend wallet.md (storage_deposit, 1 yocto rules).
//
// Plans on NEAR are NOT atomic: every step is its own transaction(s). Amounts
// chained from an earlier step use that step's guaranteed minimum output.

import {
  BURROW,
  NATIVE_NEAR_ID,
  REF_EXCHANGE,
  WRAP_NEAR,
  isValidAccountId,
  poolFor,
  REF_POOLS,
} from "@/lib/near/config";
import { readBalances } from "@/lib/near/balances";
import {
  projectHealth,
  positionAmountsBase,
  readLendingMarkets,
  type HealthDelta,
} from "@/lib/near/burrow";
import { factoryVaultOf, vaultTokens } from "@/lib/near/vault";
import { fc, fromBase, NEAR_YOCTO, ONE_YOCTO, toBase, transfer, type NearAction, type NearTx } from "@/lib/near/tx";
import type { WalletStep } from "@/lib/ai/plan-schema";
import type { GuardianRow, PlanRisk, ResolvedStep, WalletPlan } from "@/lib/ai/plan-types";
import {
  PlanError,
  accountExists,
  fmt,
  ftId,
  isStorageRegistered,
  quoteRef,
  resolveToken,
  storageMin,
  type ResolvedToken,
} from "@/lib/plan/common";

const NEAR_GAS_RESERVE = toBase("0.1", 24); // keep for gas + storage
const BURROW_STORAGE = NEAR_YOCTO("0.15"); // ≥ 0.1 NEAR min; frontend uses 0.15
const MSG_COLLATERAL = '"OnlyIncreaseCollateral"';
const MSG_REPAY = '"OnlyRepay"';

type Output = { token: ResolvedToken; amount: bigint };

export async function buildWalletPlan(
  accountId: string,
  steps: WalletStep[],
  agentRisks: PlanRisk[] = [],
): Promise<WalletPlan> {
  if (steps.length === 0) throw new PlanError("Plan has no steps.");
  const ids = new Set<string>();
  for (const s of steps) {
    if (ids.has(s.id)) throw new PlanError(`Duplicate step id "${s.id}".`, "Give every step a unique id.");
    ids.add(s.id);
  }

  const bal = await readBalances(accountId);
  if (!bal.exists) throw new PlanError(`Account ${accountId} does not exist.`);
  const balances = new Map<string, bigint>(bal.balances.map((b) => [b.tokenId, BigInt(b.balanceRaw)]));
  const get = (id: string) => balances.get(id) ?? BigInt(0);
  const add = (id: string, d: bigint) => balances.set(id, get(id) + d);

  const txs: NearTx[] = [];
  const resolved: ResolvedStep[] = [];
  const guardian: GuardianRow[] = [];
  const outputs = new Map<string, Output>();
  const deltas: HealthDelta[] = [];
  const storageDone = new Set<string>(); // `${contract}|${account}`
  let storageNear = BigInt(0);
  let lending = false;
  const shortfalls: string[] = [];
  const markets = await readLendingMarkets().catch(() => []);

  const pushTx = (tx: NearTx) => {
    txs.push(tx);
    return txs.length - 1;
  };

  /** storage_deposit action if `account` isn't registered on `contract` (deduped). */
  async function storageAction(contract: string, account: string, registrationOnly = true): Promise<NearAction | null> {
    const key = `${contract}|${account}`;
    if (storageDone.has(key)) return null;
    storageDone.add(key);
    if (await isStorageRegistered(contract, account)) return null;
    const amt = contract === BURROW ? BigInt(BURROW_STORAGE) : await storageMin(contract);
    storageNear += amt;
    add(NATIVE_NEAR_ID, -amt);
    return fc("storage_deposit", { account_id: account, registration_only: registrationOnly }, 10, amt.toString());
  }

  /** Separate tx registering `account` on `contract` when needed. */
  async function ensureStorageTx(contract: string, account: string, why: string, stepId: string) {
    const a = await storageAction(contract, account, contract !== BURROW);
    if (a) pushTx({ receiverId: contract, actions: [a], label: `Register ${why}`, stepIds: [stepId] });
  }

  async function inputAmount(
    step: { id: string; origin: unknown },
    token: ResolvedToken,
  ): Promise<bigint> {
    const o = step.origin as { from: string; amount?: number; percent?: number; stepId?: string };
    if (o.from === "amount") return toBase(o.amount!, token.decimals);
    if (o.from === "percent") {
      let avail = get(token.id);
      if (token.native) avail -= NEAR_GAS_RESERVE;
      if (avail <= BigInt(0)) {
        throw new PlanError(`The wallet holds no spendable ${token.symbol}.`, "Check getBalances and use a token the user holds.");
      }
      return (avail * BigInt(Math.round(o.percent! * 100))) / BigInt(10000);
    }
    const out = outputs.get(o.stepId!);
    if (!out) throw new PlanError(`Step "${step.id}" uses output of "${o.stepId}", which doesn't exist or comes later.`);
    if (ftId(out.token) !== ftId(token) && out.token.id !== token.id) {
      throw new PlanError(
        `Step "${o.stepId}" outputs ${out.token.symbol}, but "${step.id}" spends ${token.symbol}.`,
        `Set the token of "${step.id}" to ${out.token.symbol} or add a swap step.`,
      );
    }
    return out.amount;
  }

  function spend(token: ResolvedToken, amount: bigint, stepId: string) {
    const id = token.id;
    if (get(id) < amount) {
      shortfalls.push(
        `${stepId}: needs ${fmt(fromBase(amount, token.decimals))} ${token.symbol}, wallet will have ${fmt(fromBase(get(id) < BigInt(0) ? BigInt(0) : get(id), token.decimals))}`,
      );
    }
    add(id, -amount);
  }

  /** Actions that put `amount` of a token on its FT contract (wrapping NEAR first). */
  async function sourceActions(token: ResolvedToken, amount: bigint): Promise<NearAction[]> {
    if (!token.native) return [];
    const reg = await storageAction(WRAP_NEAR, accountId);
    return [...(reg ? [reg] : []), fc("near_deposit", {}, 10, amount.toString())];
  }

  for (const step of steps) {
    const refs: number[] = [];
    switch (step.kind) {
      case "wrap": {
        const near = await resolveToken("near");
        const amount = await inputAmount(step, near);
        spend(near, amount, step.id);
        const actions = await sourceActions(near, amount);
        refs.push(pushTx({ receiverId: WRAP_NEAR, actions, label: `Wrap ${fmt(fromBase(amount, 24))} NEAR → wNEAR`, stepIds: [step.id] }));
        const w = await resolveToken("wnear");
        add(WRAP_NEAR, amount);
        outputs.set(step.id, { token: w, amount });
        resolved.push({ id: step.id, kind: step.kind, label: `Wrap ${fmt(fromBase(amount, 24))} NEAR into wNEAR`, tokenIn: "NEAR", amountIn: fromBase(amount, 24), tokenOut: "wNEAR", amountOut: fromBase(amount, 24), refs });
        break;
      }
      case "unwrap": {
        const w = await resolveToken("wnear");
        const amount = await inputAmount(step, w);
        spend(w, amount, step.id);
        refs.push(pushTx({ receiverId: WRAP_NEAR, actions: [fc("near_withdraw", { amount: amount.toString() }, 10, ONE_YOCTO)], label: `Unwrap ${fmt(fromBase(amount, 24))} wNEAR → NEAR`, stepIds: [step.id] }));
        const near = await resolveToken("near");
        add(NATIVE_NEAR_ID, amount);
        outputs.set(step.id, { token: near, amount });
        resolved.push({ id: step.id, kind: step.kind, label: `Unwrap ${fmt(fromBase(amount, 24))} wNEAR into NEAR`, tokenIn: "wNEAR", amountIn: fromBase(amount, 24), tokenOut: "NEAR", amountOut: fromBase(amount, 24), refs });
        break;
      }
      case "swap": {
        const tin = await resolveToken(step.token);
        const tout = await resolveToken(step.toToken);
        const pool = poolFor(ftId(tin), ftId(tout));
        if (!pool) {
          throw new PlanError(
            `No allowlisted single-hop Ref pool for ${tin.symbol} → ${tout.symbol}.`,
            `Allowed pairs: ${REF_POOLS.map((p) => p.label).join(", ")}. Route through wNEAR with two swap steps, or use an allowed pair.`,
          );
        }
        if (tout.native) {
          throw new PlanError("Swaps output wNEAR, not native NEAR.", 'Swap to "wNEAR", then add an "unwrap" step if the user wants native NEAR.');
        }
        const amount = await inputAmount(step, tin);
        spend(tin, amount, step.id);
        const slipBps = Math.round((step.slippagePct ?? 0.5) * 100);
        const q = await quoteRef(pool.id, tin, tout, amount, slipBps);
        await ensureStorageTx(tout.id, accountId, `your account on ${tout.symbol}`, step.id);
        const msg = JSON.stringify({
          actions: [
            {
              pool_id: pool.id,
              token_in: ftId(tin),
              token_out: tout.id,
              amount_in: amount.toString(),
              min_amount_out: q.minOut.toString(),
            },
          ],
          skip_unwrap_near: true,
        });
        const actions = [
          ...(await sourceActions(tin, amount)),
          fc("ft_transfer_call", { receiver_id: REF_EXCHANGE, amount: amount.toString(), msg }, 180, ONE_YOCTO),
        ];
        const outH = fromBase(q.amountOut, tout.decimals);
        const minH = fromBase(q.minOut, tout.decimals);
        refs.push(
          pushTx({
            receiverId: ftId(tin),
            actions,
            label: `${tin.native ? "Wrap + swap" : "Swap"} ${fmt(fromBase(amount, tin.decimals))} ${tin.symbol} → ≥ ${fmt(minH)} ${tout.symbol} on Ref (pool ${pool.id})`,
            stepIds: [step.id],
          }),
        );
        add(tout.id, q.minOut);
        outputs.set(step.id, { token: tout, amount: q.minOut });
        resolved.push({
          id: step.id,
          kind: step.kind,
          label: `Swap ${fmt(fromBase(amount, tin.decimals))} ${tin.symbol} for about ${fmt(outH)} ${tout.symbol} (at least ${fmt(minH)}) on Ref pool ${pool.id}`,
          tokenIn: tin.symbol,
          amountIn: fromBase(amount, tin.decimals),
          tokenOut: tout.symbol,
          amountOut: outH,
          minOut: minH,
          refs,
          pool: pool.id,
        });
        if (q.impactPct !== undefined) {
          const lvl = q.impactPct >= 5 ? "block" : q.impactPct >= 1 ? "flag" : "pass";
          guardian.push({
            id: `impact-${step.id}`,
            source: "check",
            level: lvl,
            title: `Price vs oracle: ${q.impactPct.toFixed(2)}%`,
            note:
              lvl === "pass"
                ? `Ref's quote is within ${Math.max(q.impactPct, 0).toFixed(2)}% of the oracle price (includes the 0.3% pool fee).`
                : `This swap gets ${q.impactPct.toFixed(2)}% less than the oracle price implies (${fmt(q.oracleOut!)} ${tout.symbol}). Consider a smaller amount.`,
          });
        }
        if (pool.kind === "degen") {
          guardian.push({
            id: `degen-${step.id}`,
            source: "check",
            level: "flag",
            title: "Oracle-priced pool",
            note: `Pool ${pool.id} (${pool.label}) re-prices from an oracle. It's deep, but less battle-tested than pool 4512.`,
          });
        }
        break;
      }
      case "supply": {
        const t = await resolveToken(step.token);
        const amount = await inputAmount(step, t);
        spend(t, amount, step.id);
        lending = true;
        await ensureStorageTx(BURROW, accountId, "with Rhea Lending (0.15 NEAR, refundable)", step.id);
        const asCollateral = step.asCollateral ?? true;
        const actions = [
          ...(await sourceActions(t, amount)),
          fc(
            "ft_transfer_call",
            { receiver_id: BURROW, amount: amount.toString(), msg: asCollateral ? MSG_COLLATERAL : "" },
            100,
            ONE_YOCTO,
          ),
        ];
        const sym = t.native ? "wNEAR" : t.symbol;
        refs.push(
          pushTx({
            receiverId: ftId(t),
            actions,
            label: `${t.native ? "Wrap + supply" : "Supply"} ${fmt(fromBase(amount, t.decimals))} ${sym} to Rhea Lending${asCollateral ? " as collateral" : ""}`,
            stepIds: [step.id],
          }),
        );
        if (asCollateral) deltas.push({ tokenId: ftId(t), collateralBase: amount });
        resolved.push({ id: step.id, kind: step.kind, label: `Supply ${fmt(fromBase(amount, t.decimals))} ${sym} to Rhea Lending${asCollateral ? " as collateral" : " (not collateral)"}`, tokenIn: sym, amountIn: fromBase(amount, t.decimals), refs });
        break;
      }
      case "borrow": {
        const t = await resolveToken(step.token);
        if (t.native) throw new PlanError("Borrow wNEAR, not native NEAR.", 'Use token "wNEAR".');
        const m = markets.find((x) => x.tokenId === t.id);
        if (!m || !m.canBorrow) throw new PlanError(`${t.symbol} can't be borrowed on Rhea Lending.`, "Call getLendingMarkets for borrowable tokens.");
        const amount = toBase(step.amount, t.decimals);
        if (fromBase(amount, t.decimals) > m.availableLiquidity) {
          guardian.push({ id: `liq-${step.id}`, source: "check", level: "block", title: "Not enough pool liquidity", note: `Only about ${fmt(m.availableLiquidity)} ${t.symbol} can be borrowed right now.` });
        }
        const pos = await positionAmountsBase(accountId, t.id);
        const inner = (amount * BigInt(10) ** BigInt(pos.extraDecimals)).toString();
        lending = true;
        await ensureStorageTx(t.id, accountId, `your account on ${t.symbol}`, step.id);
        refs.push(
          pushTx({
            receiverId: BURROW,
            actions: [
              fc(
                "execute_with_pyth",
                { actions: [{ Borrow: { token_id: t.id, amount: inner } }, { Withdraw: { token_id: t.id, max_amount: inner } }] },
                300,
                ONE_YOCTO,
              ),
            ],
            label: `Borrow ${fmt(step.amount)} ${t.symbol} from Rhea Lending to your wallet`,
            stepIds: [step.id],
          }),
        );
        // Burrow can credit 1 inner unit short → expect up to 1 base unit less.
        const out = amount > BigInt(1) ? amount - BigInt(1) : amount;
        add(t.id, out);
        outputs.set(step.id, { token: t, amount: out });
        deltas.push({ tokenId: t.id, debtBase: amount });
        guardian.push({
          id: `cost-${step.id}`,
          source: "check",
          level: m.borrowAprPct >= 30 ? "flag" : "pass",
          title: `Borrow cost: ${m.borrowAprPct.toFixed(1)}%/yr`,
          note: `${t.symbol} borrowing currently costs ${m.borrowAprPct.toFixed(1)}% a year (variable; pool ${m.utilizationPct.toFixed(0)}% used). Interest slowly lowers your health factor.`,
        });
        resolved.push({ id: step.id, kind: step.kind, label: `Borrow ${fmt(step.amount)} ${t.symbol} at ~${m.borrowAprPct.toFixed(1)}% APR`, tokenOut: t.symbol, amountOut: step.amount, refs });
        break;
      }
      case "repay": {
        const t = await resolveToken(step.token);
        const pos = await positionAmountsBase(accountId, ftId(t));
        if (pos.debt === BigInt(0)) throw new PlanError(`No ${t.symbol} debt to repay on Rhea Lending.`, "Call getLendingPosition first.");
        let amount: bigint;
        if ((step.origin as { from: string }).from === "all") {
          // Debt + ~10 minutes of interest + 1 unit; any excess lands as "supplied".
          const buffer = (pos.debt * BigInt(Math.ceil(pos.debtAprPct * 100))) / BigInt(10000 * 52560) + BigInt(1);
          amount = pos.debt + buffer;
          const have = get(t.id);
          if (have < amount && have > BigInt(0)) amount = have;
        } else {
          amount = await inputAmount(step, t);
        }
        spend(t, amount, step.id);
        lending = true;
        const actions = [
          ...(await sourceActions(t, amount)),
          fc("ft_transfer_call", { receiver_id: BURROW, amount: amount.toString(), msg: MSG_REPAY }, 100, ONE_YOCTO),
        ];
        const sym = t.native ? "wNEAR" : t.symbol;
        refs.push(pushTx({ receiverId: ftId(t), actions, label: `Repay ${fmt(fromBase(amount, t.decimals))} ${sym} of Rhea debt`, stepIds: [step.id] }));
        deltas.push({ tokenId: ftId(t), debtBase: -amount });
        if (amount > pos.debt) {
          guardian.push({ id: `overpay-${step.id}`, source: "check", level: "pass", title: "Tiny overpayment stays supplied", note: `Repaying a little more than the debt so interest can't leave dust. The extra (< ${fmt(fromBase(amount - pos.debt, t.decimals))} ${sym}) stays on Rhea as a plain deposit you can withdraw.` });
        }
        resolved.push({ id: step.id, kind: step.kind, label: `Repay ${fmt(fromBase(amount, t.decimals))} ${sym} (debt ${fmt(fromBase(pos.debt, t.decimals))})`, tokenIn: sym, amountIn: fromBase(amount, t.decimals), refs });
        break;
      }
      case "withdraw": {
        const t = await resolveToken(step.token);
        const id = ftId(t);
        const pos = await positionAmountsBase(accountId, id);
        const have = step.source === "collateral" ? pos.collateral : pos.supplied;
        if (have === BigInt(0)) throw new PlanError(`No ${step.source} ${t.symbol} on Rhea Lending.`, "Call getLendingPosition first.");
        const amount = step.amount !== undefined ? toBase(step.amount, t.decimals) : have;
        if (amount > have) throw new PlanError(`Only ${fmt(fromBase(have, t.decimals))} ${t.symbol} ${step.source} available.`);
        const k = BigInt(10) ** BigInt(pos.extraDecimals);
        const inner = (amount * k).toString();
        lending = true;
        await ensureStorageTx(id, accountId, `your account on ${t.native ? "wNEAR" : t.symbol}`, step.id);
        let actions;
        let method = "execute";
        let gas = 100;
        if (step.source === "collateral") {
          if (step.amount === undefined && pos.hasAnyDebt) {
            throw new PlanError("Can't withdraw ALL collateral while the account has debt.", "Repay the debt first, or give an amount.");
          }
          if (pos.hasAnyDebt) {
            method = "execute_with_pyth";
            gas = 300;
          }
          actions =
            step.amount === undefined
              ? [{ DecreaseCollateral: { token_id: id } }, { Withdraw: { token_id: id } }]
              : [{ DecreaseCollateral: { token_id: id, amount: inner } }, { Withdraw: { token_id: id, max_amount: inner } }];
          deltas.push({ tokenId: id, collateralBase: -amount });
        } else {
          actions = step.amount === undefined ? [{ Withdraw: { token_id: id } }] : [{ Withdraw: { token_id: id, max_amount: inner } }];
        }
        refs.push(pushTx({ receiverId: BURROW, actions: [fc(method, { actions }, gas, ONE_YOCTO)], label: `Withdraw ${fmt(fromBase(amount, t.decimals))} ${t.native ? "wNEAR" : t.symbol} ${step.source} from Rhea Lending`, stepIds: [step.id] }));
        const wt = t.native ? await resolveToken("wnear") : t;
        add(wt.id, amount);
        outputs.set(step.id, { token: wt, amount });
        resolved.push({ id: step.id, kind: step.kind, label: `Withdraw ${fmt(fromBase(amount, t.decimals))} ${wt.symbol} ${step.source} from Rhea Lending`, tokenOut: wt.symbol, amountOut: fromBase(amount, t.decimals), refs });
        break;
      }
      case "send": {
        const t = await resolveToken(step.token);
        const to = step.recipient.trim();
        if (!isValidAccountId(to)) throw new PlanError(`"${to}" is not a valid NEAR account id.`);
        if (!(await accountExists(to)) && !/^[0-9a-f]{64}$/.test(to)) {
          throw new PlanError(`Account ${to} does not exist.`, "Double-check the recipient with the user.");
        }
        const amount = await inputAmount(step, t);
        spend(t, amount, step.id);
        if (t.native) {
          refs.push(pushTx({ receiverId: to, actions: [transfer(amount.toString())], label: `Send ${fmt(fromBase(amount, 24))} NEAR to ${to}`, stepIds: [step.id] }));
        } else {
          const reg = await storageAction(t.id, to);
          refs.push(
            pushTx({
              receiverId: t.id,
              actions: [...(reg ? [reg] : []), fc("ft_transfer", { receiver_id: to, amount: amount.toString() }, 30, ONE_YOCTO)],
              label: `Send ${fmt(fromBase(amount, t.decimals))} ${t.symbol} to ${to}`,
              stepIds: [step.id],
            }),
          );
        }
        guardian.push({ id: `send-${step.id}`, source: "check", level: "flag", title: "Irreversible send", note: `Funds sent to ${to} can't be pulled back. Make sure the account id is exactly right.` });
        resolved.push({ id: step.id, kind: step.kind, label: `Send ${fmt(fromBase(amount, t.decimals))} ${t.symbol} to ${to}`, tokenIn: t.symbol, amountIn: fromBase(amount, t.decimals), refs, to });
        break;
      }
      case "depositToVault": {
        const t = await resolveToken(step.token);
        const vaultId = await factoryVaultOf(accountId);
        if (!vaultId) throw new PlanError("This account has no Trellis vault yet.", "Tell the user to create one at /vault/setup.");
        const amount = await inputAmount(step, t);
        spend(t, amount, step.id);
        if (t.native) {
          refs.push(pushTx({ receiverId: vaultId, actions: [transfer(amount.toString())], label: `Send ${fmt(fromBase(amount, 24))} NEAR to your vault`, stepIds: [step.id] }));
        } else {
          const registered = (await vaultTokens(vaultId)).some(([id]) => id === t.id);
          if (!registered) {
            guardian.push({ id: `vault-token-${step.id}`, source: "check", level: "block", title: `Vault doesn't accept ${t.symbol} yet`, note: `Register ${t.symbol} in your vault rules first; otherwise the deposit is refunded.` });
          }
          refs.push(pushTx({ receiverId: t.id, actions: [fc("ft_transfer_call", { receiver_id: vaultId, amount: amount.toString(), msg: "" }, 60, ONE_YOCTO)], label: `Deposit ${fmt(fromBase(amount, t.decimals))} ${t.symbol} into your vault`, stepIds: [step.id] }));
        }
        resolved.push({ id: step.id, kind: step.kind, label: `Move ${fmt(fromBase(amount, t.decimals))} ${t.symbol} into your Trellis vault (${vaultId})`, tokenIn: t.symbol, amountIn: fromBase(amount, t.decimals), refs });
        break;
      }
    }
  }

  // ── Deterministic Guardian rows (frontend-spec §4.3) ──
  if (txs.length > 1) {
    guardian.unshift({
      id: "non-atomic",
      source: "check",
      level: "flag",
      title: `Not all-or-nothing: ${txs.length} transactions`,
      note: "Each transaction lands on its own. If a later one fails, the earlier ones still count; Trellis shows where you ended up and lets you retry the rest.",
    });
  }
  let healthBefore: number | null | undefined;
  let healthAfter: number | null | undefined;
  if (deltas.length > 0) {
    const p = await projectHealth(accountId, deltas).catch(() => null);
    if (p) {
      healthBefore = p.before;
      healthAfter = p.after;
      const after = p.after;
      const lvl = after === null ? "pass" : after < 1.1 ? "block" : after < 1.5 ? "flag" : "pass";
      guardian.push({
        id: "hf-after",
        source: "check",
        level: lvl,
        title: `Health factor after: ${after === null ? "no debt" : after.toFixed(2)}`,
        note:
          after === null
            ? "No debt after this plan, so nothing can be liquidated."
            : `Now ${p.before === null ? "no debt" : p.before.toFixed(2)} → ${after.toFixed(2)}. Liquidation starts below 1.0${after < 1.5 ? "; Trellis recommends staying above 1.5" : ""}.${p.notes.length ? " " + p.notes.join(" ") : ""}`,
      });
    }
  }
  if (lending) {
    guardian.push({ id: "oracle", source: "check", level: "pass", title: "Prices from Rhea's oracle", note: "Health factor and liquidation use aggregate-oracle.near prices, the same feed Rhea Lending uses." });
  }
  if (storageNear > BigInt(0)) {
    guardian.push({ id: "storage", source: "check", level: "pass", title: `Storage deposits: ${fmt(fromBase(storageNear, 24))} NEAR`, note: "One-time, refundable registrations so your account can hold these tokens / use these protocols." });
  }
  if (shortfalls.length > 0) {
    guardian.push({ id: "balance", source: "check", level: "block", title: "Insufficient balance", note: shortfalls.join("; ") });
  }
  if (get(NATIVE_NEAR_ID) < NEAR_GAS_RESERVE) {
    guardian.push({ id: "gas-reserve", source: "check", level: "flag", title: "Low NEAR for gas", note: "This plan leaves less than 0.1 NEAR for gas and storage. Keep some NEAR unwrapped." });
  }
  for (const r of agentRisks.slice(0, 6)) {
    guardian.push({ id: `agent-${guardian.length}`, source: "agent", ...r });
  }

  const blocked = guardian.some((g) => g.level === "block");
  // money-flow graph: which earlier step's output each step uses
  for (const r of resolved) {
    const src = steps.find((x) => x.id === r.id) as { origin?: { from: string; stepId?: string } } | undefined;
    if (src?.origin?.from === "step" && src.origin.stepId) r.fromStep = src.origin.stepId;
  }
  return {
    mode: "wallet",
    accountId,
    steps: resolved,
    txs,
    guardian,
    blocked,
    summary: resolved.map((s) => s.label).join(" → "),
    healthBefore,
    healthAfter,
    createdAt: Date.now(),
  };
}
