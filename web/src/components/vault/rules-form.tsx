"use client";

import { Input } from "@/components/ui/input";
import { Tag } from "@/components/ui/tag";
import { cn } from "@/lib/utils";
import {
  PRESETS,
  VAULT_TOKENS,
  rulesSummary,
  validateRules,
  type PresetId,
  type RulesForm,
} from "@/lib/vault-presets";

/** Vault rules form with Careful / Balanced / Custom presets (frontend-spec §3.3). */
export function RulesFormView({
  value,
  onChange,
}: {
  value: RulesForm;
  onChange: (f: RulesForm) => void;
}) {
  const set = (patch: Partial<RulesForm>) => onChange({ ...value, ...patch, preset: patch.preset ?? "custom" });
  const errors = validateRules(value);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-2">
        {(["careful", "balanced", "custom"] as PresetId[]).map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => (p === "custom" ? set({ preset: "custom" }) : onChange({ ...PRESETS[p] }))}
            className={cn(
              "surface-panel px-3 py-2.5 text-left rounded-card ring-1 transition-colors",
              value.preset === p ? "ring-midnight-ink" : "ring-hairline hover:ring-midnight-ink/30",
            )}
          >
            <div className="text-body-sm font-medium capitalize text-midnight-ink">{p}</div>
            <div className="text-caption text-muted-ash">
              {p === "careful" ? "~1.5x · HF ≥ 1.7" : p === "balanced" ? "~1.8x · HF ≥ 1.5" : "your numbers"}
            </div>
          </button>
        ))}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <NumField label="Target leverage (x)" hint="Advisory: what the agent aims for" value={value.targetLeverage} step={0.1} onChange={(v) => set({ targetLeverage: v })} />
        <NumField label="Minimum health factor" hint="The vault rejects any borrow/withdraw below this" value={value.minHf} step={0.05} onChange={(v) => set({ minHf: v })} />
        <NumField label="Deleverage below" hint="Agent may repay below this health factor" value={value.deleverageTrigger} step={0.05} onChange={(v) => set({ deleverageTrigger: v })} />
        <NumField label="Emergency floor" hint="Lowest HF a deleverage step may touch" value={value.emergencyFloor} step={0.05} onChange={(v) => set({ emergencyFloor: v })} />
        <NumField label="Max slippage (%)" hint="Vs the oracle price, enforced on-chain" value={value.maxSlippagePct} step={0.1} onChange={(v) => set({ maxSlippagePct: v })} />
        <NumField label="Agent expiry (days, 0 = never)" value={value.agentExpiryDays} step={1} onChange={(v) => set({ agentExpiryDays: Math.max(0, Math.round(v)) })} />
      </div>

      <div className="space-y-2">
        <div className="text-[10px] font-medium uppercase tracking-wider text-muted-ash">Tokens and spending limits</div>
        {VAULT_TOKENS.map((t) => {
          const on = value.tokens.includes(t.id);
          return (
            <div key={t.id} className="flex flex-wrap items-center gap-2 surface-panel px-3 py-2 rounded-card">
              <label className="flex w-24 items-center gap-2 text-body-sm font-medium text-midnight-ink">
                <input
                  type="checkbox"
                  checked={on}
                  onChange={(e) =>
                    set({ tokens: e.target.checked ? [...value.tokens, t.id] : value.tokens.filter((x) => x !== t.id) })
                  }
                />
                {t.symbol}
              </label>
              {on && (
                <>
                  <span className="text-caption text-muted-ash">per action</span>
                  <Input
                    type="number"
                    min={0}
                    className="h-8 w-24"
                    value={value.perAction[t.id] ?? 0}
                    onChange={(e) => set({ perAction: { ...value.perAction, [t.id]: Number(e.target.value) } })}
                  />
                  <span className="text-caption text-muted-ash">per day</span>
                  <Input
                    type="number"
                    min={0}
                    className="h-8 w-24"
                    value={value.daily[t.id] ?? 0}
                    onChange={(e) => set({ daily: { ...value.daily, [t.id]: Number(e.target.value) } })}
                  />
                </>
              )}
            </div>
          );
        })}
        <div className="flex items-center gap-2 text-caption text-muted-ash">
          <Tag>NEAR Intents routing: off</Tag> Needs verified 1Click quotes; coming later.
        </div>
      </div>

      <p className="surface-panel px-3 py-2.5 text-body-sm text-midnight-ink rounded-card">{rulesSummary(value)}</p>
      {errors.length > 0 && (
        <ul className="space-y-0.5 text-caption text-destructive">
          {errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function NumField({
  label,
  hint,
  value,
  step,
  onChange,
}: {
  label: string;
  hint?: string;
  value: number;
  step: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="block space-y-1">
      <span className="text-caption font-medium text-midnight-ink">{label}</span>
      <Input type="number" step={step} value={Number.isFinite(value) ? value : 0} onChange={(e) => onChange(Number(e.target.value))} />
      {hint && <span className="block text-[11px] text-muted-ash">{hint}</span>}
    </label>
  );
}
