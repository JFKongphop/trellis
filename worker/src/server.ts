// HTTP API for the web app. The web server authenticates the vault owner (NEP-413) and then calls this
// with a shared bearer token. Even if this API were abused, the vault contract still enforces the policy:
// this only decides WHEN the agent acts, not WHAT it may do.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { config, AGENT_METHODS } from "./config.ts";
import { state, save, log, reasonsFor, type Plan } from "./store.ts";
import { health } from "./health-status.ts";

const MAX_BODY = 64 * 1024;
const PLAN_STEPS_MAX = 10;
const ACCOUNT_RE = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

function send(res: ServerResponse, code: number, body: unknown) {
  const text = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

function authorized(req: IncomingMessage): boolean {
  const h = req.headers.authorization ?? "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  const a = Buffer.from(token);
  const b = Buffer.from(config.apiToken);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function body(req: IncomingMessage): Promise<any> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new Error("body too large");
    chunks.push(c as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

const isAccount = (s: unknown): s is string => typeof s === "string" && s.length >= 2 && s.length <= 64 && ACCOUNT_RE.test(s);

export function startServer() {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://x");
      if (req.method === "GET" && url.pathname === "/healthz") {
        return send(res, 200, { ok: health.ok(), lastTickAt: health.lastTickAt, lastError: health.lastError, vaults: Object.keys(state.vaults).length });
      }
      if (!authorized(req)) return send(res, 401, { error: "unauthorized" });

      // vault ids are public on-chain; owners aren't returned
      if (req.method === "GET" && url.pathname === "/vaults") {
        return send(res, 200, { vaults: Object.keys(state.vaults) });
      }

      if (req.method === "POST" && url.pathname === "/vaults") {
        const b = await body(req);
        if (!isAccount(b.vaultId) || !isAccount(b.owner)) return send(res, 400, { error: "vaultId and owner must be account ids" });
        state.vaults[b.vaultId] = { owner: b.owner, addedAt: Date.now(), failures: 0, breakerOpen: false };
        save();
        log("vault_registered", { vault: b.vaultId, owner: b.owner });
        return send(res, 200, { ok: true });
      }

      if (req.method === "POST" && url.pathname === "/plans") {
        const b = await body(req);
        if (typeof b.planId !== "string" || b.planId.length > 80 || state.plans[b.planId]) return send(res, 400, { error: "bad or duplicate planId" });
        if (!isAccount(b.vaultId) || !isAccount(b.owner)) return send(res, 400, { error: "bad vaultId/owner" });
        const v = state.vaults[b.vaultId];
        if (!v) return send(res, 404, { error: "vault not registered" });
        if (v.owner !== b.owner) return send(res, 403, { error: "owner mismatch" });
        if (!Array.isArray(b.steps) || b.steps.length === 0 || b.steps.length > PLAN_STEPS_MAX) return send(res, 400, { error: `1..${PLAN_STEPS_MAX} steps` });
        const steps = [];
        for (const s of b.steps) {
          if (!AGENT_METHODS.includes(s?.method) || s.method === "sync_position") return send(res, 400, { error: `method not allowed: ${s?.method}` });
          if (typeof s.args !== "object" || s.args === null || "reason_hash" in s.args) return send(res, 400, { error: "args must be an object without reason_hash" });
          steps.push({ label: String(s.label ?? s.method).slice(0, 120), method: s.method, args: s.args, status: "pending" as const });
        }
        const plan: Plan = { planId: b.planId, vaultId: b.vaultId, owner: b.owner, reasoning: String(b.reasoning ?? "").slice(0, 2000), status: "queued", steps, createdAt: Date.now() };
        state.plans[plan.planId] = plan;
        save();
        log("plan_queued", { plan: plan.planId, vault: plan.vaultId, steps: steps.map((s) => s.method) });
        return send(res, 202, { planId: plan.planId });
      }

      const rv = url.pathname.match(/^\/vaults\/([^/]+)\/reasons$/);
      if (req.method === "GET" && rv) {
        const vaultId = decodeURIComponent(rv[1]!);
        if (!isAccount(vaultId)) return send(res, 400, { error: "bad vaultId" });
        return send(res, 200, { reasons: reasonsFor(vaultId) });
      }

      const m = url.pathname.match(/^\/plans\/([^/]+)$/);
      if (req.method === "GET" && m) {
        const plan = state.plans[decodeURIComponent(m[1]!)];
        if (!plan) return send(res, 404, { error: "not found" });
        const { owner: _o, reasoning: _r, createdAt: _c, ...pub } = plan;
        return send(res, 200, { ...pub, steps: plan.steps.map(({ args: _a, ...s }) => s) });
      }
      return send(res, 404, { error: "not found" });
    } catch (e) {
      return send(res, 400, { error: e instanceof Error ? e.message : "bad request" });
    }
  });
  server.listen(config.port, () => log("server_listening", { port: config.port }));
  return server;
}
