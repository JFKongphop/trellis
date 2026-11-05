// Generic web-app demo recorder (Playwright). Runs a *scenario* module against a live app and records a video,
// adding a visible cursor, typed input, eased scrolling, optional captions, and an optional injected EIP-1193
// wallet for dapps. Logs every slow wait (for speed-up) and every caption change (for HyperFrames sync).
//
// Usage (from the target project, which must have `playwright` installed — and `ethers` if the wallet is used):
//   node <skill>/scripts/record.mjs --scenario demo/scenario.mjs --base-url http://localhost:3000 --out demo-video/take
// Env: CAPTIONS=0 (don't draw captions — HyperFrames draws them), PACE=1.4 (pause multiplier), WALLET_PK=0x… (dapps)
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { pathToFileURL } from 'url';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const SCENARIO = path.resolve(arg('scenario', 'demo/scenario.mjs'));
const BASE = arg('base-url', process.env.BASE_URL || 'http://localhost:3000');
const OUT = path.resolve(arg('out', 'demo-video/take'));
const CAPTIONS = process.env.CAPTIONS !== '0';
const PACE = Number(process.env.PACE || 1.4);
const [VW, VH] = (arg('viewport', '1440x900')).split('x').map(Number);
// --scale 2: sharp capture for zooms. Records device pixels (VW*2 x VH*2) as high-quality JPEG frames over CDP instead of
// Playwright's video (which is VP8 at ~1 Mbit/s and goes soft when zoomed), then builds raw/take.mp4 from them.
const SCALE = Number(arg('scale', 1));

// resolve dependencies from the project we're recording, not from the skill folder
const req = createRequire(path.join(process.cwd(), 'package.json'));
// CommonJS packages arrive as { default: {...} } via import() — merge so named exports (chromium, ethers) work
const load = async (name) => { const m = await import(pathToFileURL(req.resolve(name)).href); return m.default ? { ...m.default, ...m } : m; };
const { chromium } = await load('playwright');

const scenario = await import(pathToFileURL(SCENARIO).href);
const cfg = scenario.config ?? {};
fs.mkdirSync(`${OUT}/raw`, { recursive: true });

// the screencast ignores deviceScaleFactor; only this flag makes it send device-pixel frames
const browser = await chromium.launch(SCALE > 1 ? { args: [`--force-device-scale-factor=${SCALE}`] } : {});
const context = await browser.newContext(SCALE > 1
  ? { viewport: { width: VW, height: VH }, deviceScaleFactor: SCALE }
  : { viewport: { width: VW, height: VH }, recordVideo: { dir: `${OUT}/raw`, size: { width: VW, height: VH } } });
const page = await context.newPage();
const t0 = Date.now();
const frames = []; // { f, t } for --scale
// stepped scrolls (--scale): the screencast only manages ~15 uneven fps at 2x, so scrolls stutter. Instead we move the
// page one even step per captured frame and give those frames even 1/30 s timestamps; `warp` removes the extra wall
// time the stepping took, so every later timestamp (frames, marks, captions) stays on the same virtual clock.
let warp = 0, stepping = null, onFrame = null, frameNo = 0;
let cdp = null;
if (SCALE > 1) {
  fs.mkdirSync(`${OUT}/raw/frames`, { recursive: true });
  cdp = await context.newCDPSession(page);
  cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
    const f = `${OUT}/raw/frames/${String(frameNo++).padStart(6, '0')}.jpg`; // own counter: stepped scrolls drop frames
    frames.push({ f, t: metadata.timestamp - t0 / 1000 - warp });
    if (stepping) stepping.push(frames.length - 1);
    if (onFrame) { const r = onFrame; onFrame = null; r(); }
    fs.writeFile(f, Buffer.from(data, 'base64'), () => {});
    cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: VW * SCALE, maxHeight: VH * SCALE, everyNthFrame: 1 });
}
const now = () => (Date.now() - t0) / 1000 - warp;
const marks = []; // slow waits { s, e, label }
const captions = []; // { t, html }
const sent = []; // wallet txs { to, hash }
// echo matching browser console lines into the take log (scenario can widen it via config.logConsole)
const LOGRE = cfg.logConsole ?? /^\[demo\]/;
page.on('console', (m) => { if (LOGRE.test(m.text())) console.log('   ' + m.text()); });

// ── optional injected wallet (web3 dapps) ─────────────────────────────────────
let wallet = null;
if (cfg.wallet) {
  const { ethers } = await load('ethers');
  const pk = process.env[cfg.wallet.privateKeyEnv || 'WALLET_PK'];
  if (!pk) throw new Error(`scenario.config.wallet set but ${cfg.wallet.privateKeyEnv || 'WALLET_PK'} is empty`);
  const rpc = new ethers.JsonRpcProvider(cfg.wallet.rpc, cfg.wallet.chainId);
  const signer = new ethers.Wallet(pk, rpc);
  const retry = async (fn, n = 6) => { for (let i = 0; ; i++) { try { return await fn(); } catch (e) { if (i >= n) throw e; await new Promise((r) => setTimeout(r, 1500)); } } };
  let nonce = null;
  const hexChain = '0x' + Number(cfg.wallet.chainId).toString(16);
  const handle = async ({ method, params = [] }) => {
    switch (method) {
      case 'eth_requestAccounts': case 'eth_accounts': return [signer.address];
      case 'eth_chainId': return hexChain;
      case 'net_version': return String(cfg.wallet.chainId);
      case 'wallet_switchEthereumChain': case 'wallet_addEthereumChain': return null;
      case 'eth_sendTransaction': {
        // sign once, rebroadcast the same bytes: a flaky RPC can never duplicate an action
        const t = params[0];
        if (nonce === null) nonce = await retry(() => rpc.getTransactionCount(signer.address, 'pending'));
        const big = (v) => (v ? BigInt(v) : undefined);
        // like a real wallet, price the tx ourselves when the dapp asks for a zero tip (some chains refuse it)
        if (t.maxPriorityFeePerGas && BigInt(t.maxPriorityFeePerGas) === 0n) { delete t.maxFeePerGas; delete t.maxPriorityFeePerGas; }
        const tx = await retry(() => signer.populateTransaction({ to: t.to, data: t.data, nonce, value: big(t.value) ?? 0n,
          gasLimit: big(t.gas), maxFeePerGas: big(t.maxFeePerGas), maxPriorityFeePerGas: big(t.maxPriorityFeePerGas) }));
        const raw = await signer.signTransaction(tx);
        const hash = ethers.keccak256(raw);
        for (let i = 0; ; i++) {
          try { await rpc.send('eth_sendRawTransaction', [raw]); break; } catch (e) {
            const m = String(e.info?.error?.message ?? e.error?.message ?? e.shortMessage ?? e.message); // the node's own words first
            if (/already known|nonce too low|known transaction/i.test(m)) break;
            if (i >= 6) throw e;
            console.log(`   resend ${i + 1}: ${m.slice(0, 100)}`);
            await new Promise((r) => setTimeout(r, 2000));
          }
        }
        nonce++; sent.push({ to: (t.to || '').toLowerCase(), hash });
        return hash;
      }
      case 'personal_sign': return signer.signMessage(ethers.getBytes(params[0]));
      case 'eth_signTypedData_v4': { const { domain, types, message } = JSON.parse(params[1]); delete types.EIP712Domain; return signer.signTypedData(domain, types, message); }
      default: return retry(() => rpc.send(method, params));
    }
  };
  await page.exposeFunction('__eth', async (r) => { try { return await handle(r); } catch (e) { console.log(`   wallet error [${r.method}]: ${String(e.shortMessage ?? e.message).slice(0, 200)}`); throw e; } });
  wallet = { address: signer.address, sent, rpc, ethers };
}

// ── presentation layer (never intercepts clicks) ─────────────────────────────
await page.addInitScript(({ captions, injectWallet, hide, soft }) => {
  if (injectWallet) window.ethereum = { isMetaMask: true, request: (a) => window.__eth(a), on: () => {}, removeListener: () => {} };
  const css = `
    #demo-cursor{position:fixed;left:50%;top:50%;width:22px;height:22px;z-index:2147483647;pointer-events:none;
      transition:left .8s cubic-bezier(.4,0,.2,1),top .8s cubic-bezier(.4,0,.2,1)}
    #demo-cursor svg{filter:drop-shadow(2px 2px 0 rgba(0,0,0,.35))}
    .demo-ripple{position:fixed;width:34px;height:34px;margin:-17px 0 0 -17px;border:3px solid #00E5FF;border-radius:50%;
      z-index:2147483646;pointer-events:none;animation:demo-rip .5s ease-out forwards}
    @keyframes demo-rip{from{transform:scale(.3);opacity:1}to{transform:scale(1.6);opacity:0}}
    #demo-cap{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);z-index:2147483645;pointer-events:none;
      background:#111;color:#fff;border:2px solid #000;box-shadow:4px 4px 0 #00E5FF;padding:10px 18px;white-space:nowrap;
      font:600 17px system-ui,sans-serif;max-width:95vw;text-align:center;transition:opacity .3s;opacity:0}
    #demo-cap b{color:#00E5FF}
    #demo-wait{position:fixed;left:50%;top:14px;transform:translateX(-50%);z-index:2147483645;pointer-events:none;background:#FFE500;
      border:2px solid #000;box-shadow:3px 3px 0 #000;padding:6px 12px;font:700 13px ui-monospace,monospace;opacity:0;transition:opacity .2s}
    ${hide.map((s) => `${s}{display:none!important}`).join('')}
    ${soft ? `/* overlay: 'soft' — calm UI style for the recorded overlays */
      .demo-ripple{border:2px solid rgba(15,23,42,.55)}
      #demo-cap{background:#0f172a;border:0;border-radius:12px;box-shadow:0 18px 40px -18px rgba(15,23,42,.6)}
      #demo-cap b{color:#a7f3d0}
      #demo-wait{background:#fff;color:#0f172a;border:1px solid rgba(15,23,42,.12);border-radius:999px;
        box-shadow:0 10px 24px -12px rgba(15,23,42,.35);font-weight:600}` : ''}`;
  const mount = () => {
    if (document.getElementById('demo-cursor')) return;
    const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
    const c = document.createElement('div'); c.id = 'demo-cursor';
    c.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24"><path d="M3 2l7 19 2.6-7.6L20 11z" fill="#fff" stroke="#000" stroke-width="2" stroke-linejoin="round"/></svg>';
    document.body.appendChild(c);
    const cap = document.createElement('div'); cap.id = 'demo-cap'; if (!captions) cap.style.display = 'none'; document.body.appendChild(cap);
    const w = document.createElement('div'); w.id = 'demo-wait'; w.textContent = '⏳ waiting · sped up'; document.body.appendChild(w);
  };
  document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', mount) : mount();
  window.__demo = {
    move: (x, y) => { mount(); const c = document.getElementById('demo-cursor'); c.style.left = x + 'px'; c.style.top = y + 'px'; },
    ripple: (x, y) => { const r = document.createElement('div'); r.className = 'demo-ripple'; r.style.left = x + 'px'; r.style.top = y + 'px'; document.body.appendChild(r); setTimeout(() => r.remove(), 600); },
    caption: (h) => { mount(); const el = document.getElementById('demo-cap'); if (!h) { el.style.opacity = 0; return; } el.innerHTML = h; el.style.opacity = 1; },
    wait: (on, label) => { mount(); const w = document.getElementById('demo-wait'); if (label) w.textContent = label; w.style.opacity = on ? 1 : 0; },
  };
}, { captions: CAPTIONS, injectWallet: !!cfg.wallet, hide: ['nextjs-portal', 'vite-error-overlay', ...(cfg.hide ?? [])], soft: cfg.overlay === 'soft' });

// ── helpers handed to the scenario ────────────────────────────────────────────
const toLoc = (x) => (typeof x === 'string' ? page.getByText(x, { exact: false }).first() : x);
const hold = (ms) => page.waitForTimeout(ms * PACE);
const h = {
  page, base: BASE, wallet, env: process.env,
  hold,
  goto: (p = '/') => page.goto(new URL(p, BASE).href, { waitUntil: 'networkidle' }),
  caption: (html) => { captions.push({ t: now(), html }); return page.evaluate((x) => window.__demo?.caption(x), html); },
  async point(x) {
    const loc = toLoc(x); await loc.scrollIntoViewIfNeeded();
    const b = await loc.boundingBox(); const px = b.x + b.width / 2, py = b.y + b.height / 2;
    await page.evaluate(([a, c]) => window.__demo.move(a, c), [px, py]); await hold(700); return [px, py];
  },
  async click(x) { const loc = toLoc(x); const [px, py] = await h.point(loc); await page.evaluate(([a, c]) => window.__demo.ripple(a, c), [px, py]); await loc.click(); await hold(250); },
  async type(x, text) { const loc = toLoc(x); await h.click(loc); await loc.fill(''); await loc.pressSequentially(String(text), { delay: 150 }); await hold(300); },
  async scrollY(y, ms = 1600) {
    if (cdp) { // stepped: one even step per captured frame, 30 steps per second of virtual time
      const from = await page.evaluate(() => window.scrollY);
      const e = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
      const n = Math.max(2, Math.round((ms / 1000) * 30));
      const v0 = now(), w0 = Date.now();
      stepping = [];
      for (let i = 1; i <= n; i++) {
        const got = new Promise((r) => { onFrame = r; setTimeout(r, 400); }); // no frame if nothing moved (page end)
        await page.evaluate((to) => new Promise((done) => { window.scrollTo(0, to); requestAnimationFrame(() => requestAnimationFrame(done)); }), Math.round(from + (y - from) * e(i / n)));
        await got;
        stepping.push(-1); // step boundary
      }
      // keep only the last frame of each step, timed evenly; drop the rest (in-between paints)
      const steps = []; let cur = [];
      for (const x of stepping) { if (x < 0) { steps.push(cur); cur = []; } else cur.push(x); }
      stepping = null;
      const drop = new Set();
      steps.forEach((ix, i) => { ix.slice(0, -1).forEach((j) => drop.add(j)); if (ix.length) frames[ix.at(-1)].t = v0 + (i + 1) / 30; });
      for (let j = frames.length - 1; j >= 0; j--) if (drop.has(j)) frames.splice(j, 1);
      warp += (Date.now() - w0) / 1000 - n / 30;
      await hold(400);
      return;
    }
    await page.evaluate(([to, d]) => new Promise((done) => { const f = window.scrollY, dy = to - f, s = performance.now();
      const e = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
      const st = (n) => { const k = Math.min(1, (n - s) / d); window.scrollTo(0, f + dy * e(k)); k < 1 ? requestAnimationFrame(st) : done(); };
      requestAnimationFrame(st); }), [y, ms]);
    await hold(400);
  },
  async scrollTo(x, offset = 120, ms = 1600) { const y = await toLoc(x).evaluate((el, o) => el.getBoundingClientRect().top + window.scrollY - o, offset); await h.scrollY(Math.max(0, y), ms); },
  // wait for a slow result (tx, API, render); fails fast if `error` appears; logged so the editor speeds it up
  async waitFor(label, ok, { error = null, timeout = 240_000, pill } = {}) {
    const s = now();
    await page.evaluate(([on, l]) => window.__demo.wait(on, l), [true, pill ?? null]);
    const okLoc = toLoc(typeof ok === 'string' || ok instanceof RegExp ? page.getByText(ok).first() : ok);
    const races = [okLoc.waitFor({ timeout }).then(() => 'ok')];
    const errLoc = error ? toLoc(typeof error === 'string' || error instanceof RegExp ? page.getByText(error).first() : error) : null;
    if (errLoc) races.push(errLoc.waitFor({ timeout }).then(() => 'err'));
    const won = await Promise.race(races);
    await page.evaluate(() => window.__demo.wait(false));
    marks.push({ s, e: now(), label });
    if (won === 'err') throw new Error(`${label}: ${await errLoc.innerText()}`);
    const msg = (await okLoc.innerText()).replace(/\s+/g, ' ').trim();
    console.log(`  ✓ ${label} (${(now() - s).toFixed(1)}s) ${msg.slice(0, 110)}`);
    return msg;
  },
};

try {
  await scenario.default(h);
  console.log(`\n✅ recorded ${now().toFixed(0)}s`);
} catch (e) {
  console.log(`\n❌ ${e.message}`);
  await page.screenshot({ path: `${OUT}/FAIL.png`, fullPage: true }).catch(() => {});
  process.exitCode = 1;
} finally {
  const video = SCALE > 1 ? null : page.video();
  const end = now();
  if (cdp) await cdp.send('Page.stopScreencast').catch(() => {});
  await context.close(); await browser.close();
  if (video) fs.renameSync(await video.path(), `${OUT}/raw/take.webm`);
  if (SCALE > 1 && frames.length) {
    // each frame shows until the next one; the first one also covers the time before it
    await new Promise((r) => setTimeout(r, 500)); // let pending frame writes land
    const list = frames.map((x, i) => `file '${x.f}'\nduration ${Math.max(0.001, (frames[i + 1]?.t ?? end) - (i ? x.t : 0)).toFixed(4)}`).join('\n') + `\nfile '${frames.at(-1).f}'\n`;
    fs.writeFileSync(`${OUT}/raw/frames.txt`, list);
    const { execFileSync } = await import('child_process');
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', `${OUT}/raw/frames.txt`, '-vf', `fps=30,scale=${VW * SCALE}:${VH * SCALE},format=yuv420p`,
      '-c:v', 'libx264', '-crf', '12', '-preset', 'fast', `${OUT}/raw/take.mp4`], { stdio: 'inherit' });
    fs.rmSync(`${OUT}/raw/frames`, { recursive: true, force: true });
    console.log(`${frames.length} sharp frames → ${OUT}/raw/take.mp4`);
  }
  fs.writeFileSync(`${OUT}/marks.json`, JSON.stringify(marks, null, 2));
  fs.writeFileSync(`${OUT}/captions.json`, JSON.stringify(captions, null, 2));
  console.log(`video → ${OUT}/raw/take.webm`);
}
