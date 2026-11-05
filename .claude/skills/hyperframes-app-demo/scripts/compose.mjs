// Builds a HyperFrames composition from an edited take + the scenario's `video` config:
// intro card → optional problem card → framed app footage with a synced chapter rail, progress bar and
// lower-third captions → outro. Initialises the HyperFrames project on first use.
//
// Usage: node <skill>/scripts/compose.mjs --scenario demo/scenario.mjs --take demo-video/take --project demo-video/hyperframes
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { pathToFileURL } from 'url';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const SCENARIO = path.resolve(arg('scenario', 'demo/scenario.mjs'));
const TAKE = path.resolve(arg('take', 'demo-video/take'));
const PROJECT = path.resolve(arg('project', 'demo-video/hyperframes'));
const { video: V = {} } = await import(pathToFileURL(SCENARIO).href);
const HF = `hyperframes@${V.hyperframesVersion || '0.8.78'}`;

const B = { name: 'APP', mark: 'A', accent: '#00E5FF', accent2: '#00F076', alert: '#FF3366', ink: '#111', bg: '#f1f1f1',
  fontDisplay: 'Space Grotesk', fontMono: 'JetBrains Mono', ...(V.brand || {}) };
const esc = (s) => String(s).replace(/&(?!amp;|lt;|gt;|#)/g, '&amp;');
const plain = (h) => String(h ?? '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').trim();
const video = `${TAKE}/edited.mp4`;
const chapters = JSON.parse(fs.readFileSync(`${TAKE}/chapters.json`, 'utf8'));
const vdur = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', video]).toString());
const find = (re) => (re ? chapters.find((c) => re.test(c.html ?? '')) : undefined);

// ── timeline ──
const INTRO = V.intro?.seconds ?? 6.5;
const PROBLEM = V.problem ? (V.problem.seconds ?? 7.5) : 0;
const OUTRO = V.outro ? (V.outro.seconds ?? 8) : 0;
const skip = Math.max(0, (find(V.footage?.startAt)?.t ?? 1.4) - 1.4);
const endAt = find(V.footage?.endAt)?.t ?? vdur;
const SLIDES = (V.explainer ?? []).map((sl) => ({ seconds: 8, ...sl }));
const E0 = INTRO + PROBLEM, EX = SLIDES.reduce((a, sl) => a + sl.seconds, 0);
const F0 = +(E0 + EX).toFixed(2), FD = +(endAt - skip).toFixed(2), TOTAL = +(F0 + FD + OUTRO).toFixed(2);
const at = (t) => +(F0 + (t - skip)).toFixed(2);
const strip = V.captionStrip ?? /^<b>\d+ ·<\/b>\s*/;

const inFootage = chapters.filter((c) => c.html && c.t >= skip - 0.01 && c.t < endAt);
const steps = (V.chapters?.length
  ? V.chapters.map((s) => ({ label: s.label, t: find(s.match)?.t })).filter((s) => s.t !== undefined)
  : inFootage.map((c) => ({ label: plain(c.html.replace(strip, '')).slice(0, 26), t: c.t }))
).map((s) => ({ ...s, t: at(s.t) }));
const caps = inFootage.map((c, i, a) => ({ t: at(c.t), end: at(a[i + 1]?.t ?? endAt), html: esc(c.html.replace(strip, '')) }));

// ── project + assets ──
if (!fs.existsSync(`${PROJECT}/hyperframes.json`)) {
  fs.mkdirSync(path.dirname(PROJECT), { recursive: true });
  execFileSync('npx', ['-y', HF, 'init', path.basename(PROJECT), '--non-interactive', '--example', 'blank', '--skip-transcribe'],
    { cwd: path.dirname(PROJECT), env: { ...process.env, HYPERFRAMES_SKIP_SKILLS: '1' }, stdio: 'ignore' });
}
fs.mkdirSync(`${PROJECT}/assets`, { recursive: true });
fs.copyFileSync(video, `${PROJECT}/assets/app.mp4`);

// ── layout: 1920×1080 · footage frame 1392×870 (16:10) · rail 396 wide ──
const RAIL_TOP = 150, ROW = Math.min(70, Math.floor(700 / Math.max(1, steps.length)));
const rows = steps.map((s, i) => `
        <div class="row" id="row${i}" style="top:${RAIL_TOP + i * ROW}px"><span class="n">${String(i + 1).padStart(2, '0')}</span><span class="lbl">${esc(s.label)}</span><span class="tick" id="tick${i}">✓</span></div>`).join('');
const rowsOn = V.theme === 'soft' ? steps.map((s, i) => `
        <div class="row on" id="rowon${i}" style="top:${RAIL_TOP + i * ROW}px"><span class="n">${String(i + 1).padStart(2, '0')}</span><span class="lbl">${esc(s.label)}</span></div>`).join('') : '';
const capEls = caps.map((c, i) => `\n      <div class="cap" id="cap${i}">${c.html}</div>`).join('');
const chips = (V.intro?.chips ?? []).map((c) => (typeof c === 'string' ? { text: c } : c))
  .map((c) => `<span class="chip${c.live ? ' live' : ''}">${esc(c.text)}</span>`).join('');
const pLines = (V.problem?.lines ?? []).map((l, i) => `<div id="p-line${i}" class="pl">${l}</div>`).join('\n        ');
const outroItems = (V.outro?.items ?? []).map((it, i) => `<div class="stack box s${i % 3}"><div class="k">${esc(it.k)}</div><div class="v">${esc(it.v)}</div></div>`).join('');

// ── explainer slides: odds (YES/NO bar) · bars (animated P&L) · redacted (hidden fields) · text ──
const exHtml = [], exAnim = [];
let exT = E0;
SLIDES.forEach((sl, i) => {
  const id = `ex${i}`, t = +exT.toFixed(2), d = sl.seconds;
  const head = `<div class="ex-eyebrow">${esc(sl.eyebrow ?? 'HOW IT WORKS')} · ${i + 1}/${SLIDES.length}</div><h2 class="ex-title">${esc(sl.title ?? '')}</h2>`;
  let body = '';
  exAnim.push(`tl.fromTo('#${id} .ex-eyebrow', {opacity:0, y:16}, {opacity:1, y:0, duration:.4}, ${t + .15})`);
  exAnim.push(`tl.fromTo('#${id} .ex-title', {opacity:0, y:26}, {opacity:1, y:0, duration:.55, ease:'power3.out'}, ${t + .3})`);
  if (sl.kind === 'odds') {
    const yes = Math.max(1, Math.min(99, sl.yes ?? 50));
    body = `<div class="ex-event">${esc(sl.event ?? '')}</div>
          <div class="ex-odds"><div class="ex-yes" style="width:${yes}%">YES ${yes}%</div><div class="ex-no" style="width:${100 - yes}%">NO ${100 - yes}%</div></div>`;
    exAnim.push(`tl.fromTo('#${id} .ex-event', {opacity:0, scale:.9}, {opacity:1, scale:1, duration:.5, ease:'back.out(1.6)'}, ${t + .9})`);
    exAnim.push(`tl.fromTo('#${id} .ex-odds', {opacity:0, scaleX:0}, {opacity:1, scaleX:1, duration:.9, ease:'power3.out'}, ${t + 1.4})`);
  } else if (sl.kind === 'bars') {
    const bars = sl.bars ?? [], max = Math.max(1, ...bars.map((b) => Math.abs(b.value)));
    const W = 250, GAP = 90, total = bars.length * W + (bars.length - 1) * GAP, x0 = (1600 - total) / 2, Z = 250, PX = 200 / max;
    body = `<div class="ex-chart"><div class="ex-zero"></div>` + bars.map((b, j) => {
      const h = Math.max(6, Math.abs(b.value) * PX), up = b.value >= 0, x = x0 + j * (W + GAP);
      const cls = `ex-bar ${up ? 'up' : 'dn'}${b.dim ? ' dim' : ''}${b.highlight ? ' hi' : ''}`;
      const top = up ? Z - h : Z, valY = up ? Z - h - 58 : Z + h + 10, labY = up ? Z + 14 : Z - 70;
      return `<div class="${cls}" id="${id}b${j}" style="left:${x}px;top:${top}px;width:${W}px;height:${h}px"></div>
            <div class="ex-val ${up ? 'up' : 'dn'}" id="${id}v${j}" style="left:${x}px;top:${valY}px;width:${W}px">${b.value > 0 ? '+' : b.value < 0 ? '−' : ''}${Math.abs(b.value)}</div>
            <div class="ex-lab" id="${id}l${j}" style="left:${x - 30}px;top:${labY}px;width:${W + 60}px">${esc(b.label ?? '')}${b.sub ? `<span>${esc(b.sub)}</span>` : ''}</div>`;
    }).join('') + `</div>`;
    bars.forEach((b, j) => {
      const bt = t + 1.0 + j * 0.9;
      exAnim.push(`tl.fromTo('#${id}l${j}', {opacity:0}, {opacity:1, duration:.4}, ${bt.toFixed(2)})`);
      exAnim.push(`tl.fromTo('#${id}b${j}', {scaleY:0}, {scaleY:1, duration:.7, ease:'power3.out'}, ${(bt + .15).toFixed(2)})`);
      exAnim.push(`tl.fromTo('#${id}v${j}', {opacity:0, y:${b.value >= 0 ? 10 : -10}}, {opacity:1, y:0, duration:.4}, ${(bt + .7).toFixed(2)})`);
    });
  } else if (sl.kind === 'redacted') {
    body = `<div class="ex-red">` + (sl.rows ?? []).map((r, j) => `<div class="ex-row" id="${id}r${j}"><span>${esc(r)}</span><i style="width:${[180, 230, 120, 210, 110, 160][j % 6]}px"></i></div>`).join('') + `</div>`;
    (sl.rows ?? []).forEach((_, j) => exAnim.push(`tl.fromTo('#${id}r${j}', {opacity:0, x:-24}, {opacity:1, x:0, duration:.4}, ${(t + 1 + j * .25).toFixed(2)})`));
  }
  const note = sl.note ? `<div class="ex-note">${sl.note}</div>` : '';
  if (note) exAnim.push(`tl.fromTo('#${id} .ex-note', {opacity:0, y:16}, {opacity:1, y:0, duration:.5}, ${(t + Math.min(d - 2.2, sl.noteAt ?? d * .55)).toFixed(2)})`);
  exAnim.push(`tl.to('#${id}', {opacity:0, duration:.35}, ${(t + d - .35).toFixed(2)})`);
  exHtml.push(`
      <section id="${id}" class="clip ex ex-kind-${sl.kind ?? 'text'}" data-start="${t}" data-duration="${d}" data-track-index="0">
        ${head}
        <div class="ex-body">${body}</div>
        ${note}
      </section>`);
  exT += d;
});

const A = [];
A.push(`tl.fromTo('#logo', {opacity:0, y:30}, {opacity:1, y:0, duration:.6, ease:'power3.out'}, .2)`);
A.push(`tl.fromTo('#t1', {opacity:0, y:40}, {opacity:1, y:0, duration:.7, ease:'power3.out'}, .6)`);
A.push(`tl.fromTo('#t2', {opacity:0, y:40}, {opacity:1, y:0, duration:.7, ease:'power3.out'}, 1.1)`);
if (chips) A.push(`tl.fromTo('.chip', {opacity:0, y:20}, {opacity:1, y:0, duration:.5, stagger:.12, ease:'power2.out'}, 1.9)`);
A.push(`tl.to('#intro', {opacity:0, duration:.5}, ${INTRO - 0.5})`);
if (V.problem) {
  const P = INTRO;
  A.push(`tl.fromTo('#p-eyebrow', {opacity:0, y:20}, {opacity:1, y:0, duration:.5}, ${P + .2})`);
  A.push(`tl.fromTo('#p-num', {opacity:0, scale:.85}, {opacity:1, scale:1, duration:.7, ease:'back.out(1.6)'}, ${P + .5})`);
  A.push(`tl.fromTo('#p-sub', {opacity:0, y:20}, {opacity:1, y:0, duration:.5}, ${P + 1.2})`);
  (V.problem.lines ?? []).forEach((_, i) => A.push(`tl.fromTo('#p-line${i}', {opacity:0, x:-30}, {opacity:1, x:0, duration:.6}, ${(P + 2.2 + i * 1.4).toFixed(2)})`));
  A.push(`tl.to('#problem', {opacity:0, duration:.5}, ${P + PROBLEM - 0.5})`);
}
A.push(...exAnim);
A.push(`tl.fromTo('#frame', {opacity:0, scale:.94}, {opacity:1, scale:1, duration:.7, ease:'power3.out'}, ${F0})`);
A.push(`tl.fromTo('#vid', {opacity:0}, {opacity:1, duration:.7}, ${F0 + .2})`);
A.push(`tl.fromTo('#rail', {opacity:0, x:40}, {opacity:1, x:0, duration:.6, ease:'power3.out'}, ${F0 + .3})`);
A.push(`tl.fromTo('#bar', {scaleX:0}, {scaleX:1, duration:${FD}, ease:'none'}, ${F0})`);
steps.forEach((s, i) => {
  A.push(`tl.to('#hl', {y:${i * ROW}, duration:.45, ease:'power2.inOut'}, ${s.t})`);
  if (V.theme === 'soft') {
    const next = steps[i + 1]?.t ?? F0 + FD;
    // swap the dark row for its white copy while the step is active (never both visible at rest)
    A.push(`tl.to('#row${i}', {opacity:0, duration:.25}, ${(s.t + .2).toFixed(2)})`);
    A.push(`tl.fromTo('#rowon${i}', {opacity:0}, {opacity:1, duration:.25}, ${(s.t + .2).toFixed(2)})`);
    if (steps[i + 1]) {
      A.push(`tl.to('#rowon${i}', {opacity:0, duration:.2}, ${(next - .05).toFixed(2)})`);
      A.push(`tl.to('#row${i}', {opacity:1, duration:.2}, ${(next - .05).toFixed(2)})`);
    }
  }
  if (i > 0) A.push(`tl.to('#tick${i - 1}', {opacity:1, duration:.3}, ${s.t})`);
});
if (steps.length) A.push(`tl.to('#tick${steps.length - 1}', {opacity:1, duration:.3}, ${(F0 + FD - .4).toFixed(2)})`);
caps.forEach((c, i) => {
  A.push(`tl.fromTo('#cap${i}', {opacity:0, y:14}, {opacity:1, y:0, duration:.35, ease:'power2.out'}, ${c.t})`);
  A.push(`tl.to('#cap${i}', {opacity:0, duration:.25}, ${Math.max(c.t + .4, c.end - .25).toFixed(2)})`);
});
A.push(`tl.to(['#app', '#vid'], {opacity:0, duration:.5}, ${(F0 + FD - .5).toFixed(2)})`);
if (V.outro) {
  const O = F0 + FD;
  A.push(`tl.fromTo('#o-logo', {opacity:0, y:24}, {opacity:1, y:0, duration:.6, ease:'power3.out'}, ${(O + .3).toFixed(2)})`);
  if (outroItems) A.push(`tl.fromTo('.stack', {opacity:0, y:24}, {opacity:1, y:0, duration:.5, stagger:.18, ease:'power2.out'}, ${(O + .8).toFixed(2)})`);
  A.push(`tl.fromTo('#o-live', {opacity:0}, {opacity:1, duration:.6}, ${(O + 2.4).toFixed(2)})`);
}

// theme 'soft': luxury-white look for calm product UIs — hairlines, soft shadows, rounded corners, ink highlights.
// Appended after the base (bold) CSS, so it only overrides. Default theme is 'bold'.
const SOFT_CSS = `
      .box { border: 1px solid rgba(15,23,42,.10); border-radius: 20px;
        box-shadow: 0 1px 2px rgba(15,23,42,.04), 0 24px 48px -24px rgba(15,23,42,.22); }
      .logo .c { background: #0f172a; color: #fff; border: 0; border-radius: 16px; box-shadow: 0 12px 28px -12px rgba(15,23,42,.55); }
      #topbar .logo .c { border-radius: 12px; box-shadow: 0 8px 20px -10px rgba(15,23,42,.5); }
      #t2 span { background: #0f172a; color: #fff; border: 0; border-radius: 22px; box-shadow: 0 24px 48px -22px rgba(15,23,42,.6); }
      .chip { border: 1px solid rgba(15,23,42,.12); border-radius: 999px; box-shadow: 0 1px 2px rgba(15,23,42,.05); font-weight: 600; }
      .chip.live { background: #ecfdf5; color: #047857; border-color: #a7f3d0; }
      #p-eyebrow { color: #e11d48; } #p-num { color: #e11d48; }
      .pl b { background: #0f172a; color: #fff; border: 0; border-radius: 10px; padding: 0 12px; }
      .pill { background: #ecfdf5; color: #047857; border: 1px solid #a7f3d0; border-radius: 999px; box-shadow: none; }
      #frame { border-radius: 20px; }
      #vid { border-radius: 16px; }
      #barwrap { border: 1px solid rgba(15,23,42,.10); border-radius: 999px; overflow: hidden; background: #eef0f3; }
      #bar { background: #0f172a; }
      .cap { color: #0f172a; } .cap b { background: #0f172a; color: #fff; border: 0; border-radius: 8px; padding: 0 10px; }
      #rail h3 { color: #64748b; }
      #hl { background: #0f172a; border: 0; border-radius: 14px; box-shadow: 0 14px 28px -14px rgba(15,23,42,.6); }
      .row.on { opacity: 0; } .row.on .lbl { color: #fff; } .row.on .n { color: #94a3b8; }
      .row .n { color: #64748b; } .row .tick { color: #059669; }
      .ex-eyebrow { color: #64748b; }
      .ex-note b { background: #0f172a; color: #fff; border: 0; border-radius: 10px; padding: 0 12px; }
      .ex-event { border: 1px solid rgba(15,23,42,.12); border-radius: 999px; box-shadow: 0 12px 28px -16px rgba(15,23,42,.35); }
      .ex-odds { border: 1px solid rgba(15,23,42,.10); border-radius: 999px; overflow: hidden; box-shadow: 0 18px 40px -20px rgba(15,23,42,.35); }
      .ex-yes { background: #10b981; color: #fff; border-right: 2px solid #fff; } .ex-no { background: #e11d48; }
      .ex-zero { height: 2px; background: #cbd5e1; }
      .ex-bar { border: 0; border-radius: 16px; box-shadow: 0 18px 36px -18px rgba(15,23,42,.45); }
      .ex-bar.up { background: #10b981; } .ex-bar.dn { background: #e11d48; }
      .ex-bar.hi { outline: 3px solid #0f172a; outline-offset: 5px; }
      .ex-val.up { color: #047857; } .ex-val.dn { color: #e11d48; }
      .ex-red { border: 1px solid rgba(15,23,42,.10); border-radius: 20px; box-shadow: 0 24px 48px -24px rgba(15,23,42,.25); }
      .ex-row { border-bottom: 1px dashed #e2e8f0; } .ex-row i { background: #0f172a; border-radius: 6px; }
      .stack { border-radius: 20px; } .stack.s0 { background: #fff; } .stack.s1 { background: #0f172a; color: #fff; } .stack.s1 .k { color: #94a3b8; }
      .stack.s2 { background: #ecfdf5; color: #047857; } .stack.s2 .k { color: #059669; }
`;
const fontsHref = `https://fonts.googleapis.com/css2?family=${B.fontDisplay.replace(/ /g, '+')}:wght@500;600;700&family=${B.fontMono.replace(/ /g, '+')}:wght@500;700&display=swap`;
// brand.markSvg (optional): inline SVG markup used as the logo mark instead of the `mark` letter
const logo = (id = '') => `<div ${id ? `id="${id}" ` : ''}class="logo"><span class="c${B.markSvg ? ' svg' : ''}">${B.markSvg || esc(B.mark)}</span><span class="w">${esc(B.name)}</span></div>`;
const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=1920, height=1080" />
    <link rel="stylesheet" href="${fontsHref}" />
${(V.fontLinks || []).map((h) => `    <link rel="stylesheet" href="${h}" />`).join('\n')}
    <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { width: 1920px; height: 1080px; overflow: hidden; background: ${B.bg}; }
      #root { position: relative; width: 1920px; height: 1080px; font-family: '${B.fontDisplay}', system-ui, sans-serif; color: ${B.ink};
        background-color: ${B.bg}; background-image: linear-gradient(rgba(0,0,0,.05) 1px, transparent 1px), linear-gradient(90deg, rgba(0,0,0,.05) 1px, transparent 1px); background-size: 48px 48px; }
      .clip { position: absolute; inset: 0; }
      .box { border: 4px solid #000; box-shadow: 8px 8px 0 #000; background: #fff; }
      .logo { display: inline-flex; align-items: center; gap: 18px; }
      .logo .c { width: 64px; height: 64px; background: ${B.accent}; border: 4px solid #000; box-shadow: 5px 5px 0 #000; display: grid; place-items: center; font: 700 38px '${B.fontDisplay}'; }
      .logo .w { font: 700 34px '${B.fontDisplay}'; letter-spacing: .02em; }
      #intro, #problem { display: flex; flex-direction: column; justify-content: center; padding: 0 160px; }
      #intro { gap: 34px; } #problem { gap: 22px; }
      #intro h1 { font: 700 104px/1.02 '${B.fontDisplay}'; letter-spacing: -.02em; }
      #t2 span { background: ${B.accent}; border: 5px solid #000; box-shadow: 9px 9px 0 #000; padding: 6px 28px 20px; line-height: 1; display: inline-block; margin-top: 18px; } /* room for descenders (y, p, g) */
      .chips { display: flex; gap: 16px; flex-wrap: wrap; }
      .chip { font: 700 22px '${B.fontMono}'; border: 3px solid #000; box-shadow: 4px 4px 0 #000; background: #fff; padding: 10px 18px; }
      .chip.live { background: ${B.accent2}; }
      #p-eyebrow { font: 700 24px '${B.fontMono}'; letter-spacing: .14em; color: ${B.alert}; }
      #p-num { font: 700 220px/1 '${B.fontDisplay}'; letter-spacing: -.03em; color: ${B.alert}; transform-origin: left center; }
      #p-sub { font: 500 34px '${B.fontMono}'; color: #444; }
      .pl { font: 600 44px/1.25 '${B.fontDisplay}'; max-width: 1500px; }
      .pl b { background: ${B.accent}; padding: 0 10px; border: 3px solid #000; }
      .ex { display: flex; flex-direction: column; padding: 110px 160px 0; }
      .ex-eyebrow { font: 700 22px '${B.fontMono}'; letter-spacing: .14em; color: #555; }
      .ex-title { font: 700 70px/1.08 '${B.fontDisplay}'; letter-spacing: -.02em; margin-top: 16px; max-width: 1600px; }
      .ex-body { position: relative; margin-top: 60px; height: 520px; }
      .ex-note { position: absolute; left: 160px; right: 160px; bottom: 90px; font: 600 36px/1.3 '${B.fontDisplay}'; }
      .ex-note b { background: ${B.accent}; padding: 0 10px; border: 3px solid #000; }
      .ex-event { display: inline-block; font: 700 40px '${B.fontMono}'; background: #fff; border: 4px solid #000; box-shadow: 6px 6px 0 #000; padding: 14px 26px; }
      .ex-odds { display: flex; margin-top: 60px; width: 1600px; height: 120px; border: 4px solid #000; box-shadow: 8px 8px 0 #000; transform-origin: left center; }
      .ex-yes, .ex-no { display: flex; align-items: center; padding: 0 30px; font: 700 44px '${B.fontMono}'; }
      .ex-yes { background: ${B.accent2}; border-right: 4px solid #000; } .ex-no { background: ${B.alert}; color: #fff; justify-content: flex-end; }
      .ex-chart { position: absolute; left: 0; top: 0; width: 1600px; height: 520px; }
      .ex-zero { position: absolute; left: 0; right: 0; top: 250px; height: 4px; background: #000; }
      .ex-bar { position: absolute; border: 4px solid #000; box-shadow: 6px 6px 0 #000; }
      .ex-bar.up { background: ${B.accent2}; transform-origin: bottom center; } .ex-bar.dn { background: ${B.alert}; transform-origin: top center; }
      .ex-bar.dim { opacity: .35; } .ex-bar.hi { outline: 6px solid ${B.accent}; outline-offset: 6px; }
      .ex-val { position: absolute; text-align: center; font: 700 48px '${B.fontMono}'; }
      .ex-val.up { color: #00875a; } .ex-val.dn { color: ${B.alert}; }
      .ex-lab { position: absolute; text-align: center; font: 700 26px '${B.fontDisplay}'; line-height: 1.2; }
      .ex-lab span { display: block; font: 500 20px '${B.fontMono}'; color: #555; }
      .ex-red { display: grid; grid-template-columns: 1fr 1fr; gap: 18px 80px; width: 1300px; background: #fff; border: 4px solid #000; box-shadow: 8px 8px 0 #000; padding: 34px 44px; }
      .ex-row { display: flex; align-items: center; justify-content: space-between; border-bottom: 2px dashed #ccc; padding: 10px 0; font: 600 32px '${B.fontDisplay}'; }
      .ex-row i { display: block; height: 26px; background: #000; border-radius: 3px; }
      #topbar { position: absolute; left: 48px; top: 26px; right: 48px; height: 60px; display: flex; align-items: center; justify-content: space-between; }
      #topbar .logo .c { width: 48px; height: 48px; font-size: 28px; box-shadow: 4px 4px 0 #000; }
      #topbar .logo .w { font-size: 28px; }
      .pill { font: 700 18px '${B.fontMono}'; border: 3px solid #000; box-shadow: 4px 4px 0 #000; padding: 8px 16px; background: ${B.accent2}; }
      #frame { position: absolute; left: 48px; top: 104px; width: 1392px; height: 870px; }
      #vid { position: absolute; inset: auto; left: 52px; top: 108px; width: 1384px; height: 862px; object-fit: cover; z-index: 5; }
      #barwrap { position: absolute; left: 48px; top: 986px; width: 1392px; height: 10px; border: 3px solid #000; background: #fff; }
      #bar { height: 100%; width: 100%; background: ${B.accent}; transform-origin: left center; }
      .cap { position: absolute; left: 48px; top: 1010px; width: 1392px; text-align: center; opacity: 0; font: 600 30px '${B.fontDisplay}'; }
      .cap b { background: ${B.accent}; padding: 0 8px; border: 2px solid #000; }
      #rail { position: absolute; left: 1476px; top: 104px; width: 396px; height: 870px; }
      #rail h3 { position: absolute; left: 22px; top: 26px; font: 700 20px '${B.fontMono}'; letter-spacing: .14em; color: #666; }
      #rail h2 { position: absolute; left: 22px; top: 60px; font: 700 34px '${B.fontDisplay}'; }
      #hl { position: absolute; left: 12px; top: ${RAIL_TOP}px; width: 364px; height: ${ROW - 10}px; background: ${B.accent}; border: 3px solid #000; box-shadow: 4px 4px 0 #000; }
      .row { position: absolute; left: 12px; width: 364px; height: ${ROW - 10}px; display: flex; align-items: center; gap: 14px; padding: 0 16px; }
      .row .n { font: 700 18px '${B.fontMono}'; color: #555; width: 28px; }
      .row .lbl { font: 600 ${ROW < 60 ? 20 : 23}px '${B.fontDisplay}'; flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .row .tick { font: 700 22px '${B.fontMono}'; color: #00a854; opacity: 0; }
      #outro { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 30px; text-align: center; }
      #outro .stacks { display: flex; gap: 22px; }
      .stack { padding: 22px 30px; width: 420px; } /* equal widths — no card looks less important */ .stack.s0 { background: #fff; } .stack.s1 { background: ${B.accent}; } .stack.s2 { background: ${B.accent2}; }
      .stack .k { font: 700 18px '${B.fontMono}'; letter-spacing: .12em; color: #555; }
      .stack .v { font: 700 40px '${B.fontDisplay}'; margin-top: 6px; }
      #o-live { font: 600 30px '${B.fontMono}'; color: #333; }
${V.theme === 'soft' ? SOFT_CSS : ''}${V.css ? `\n      /* project brand overrides (video.css) */\n${V.css}\n` : ''}    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-duration="${TOTAL}" data-width="1920" data-height="1080">

      <section id="intro" class="clip" data-start="0" data-duration="${INTRO}" data-track-index="0">
        ${logo('logo')}
        <h1><div id="t1">${esc(V.intro?.title ?? B.name)}</div>${V.intro?.highlight ? `<div id="t2"><span>${esc(V.intro.highlight)}</span></div>` : '<div id="t2"></div>'}</h1>
        ${chips ? `<div class="chips">${chips}</div>` : ''}
      </section>
${V.problem ? `
      <section id="problem" class="clip" data-start="${INTRO}" data-duration="${PROBLEM}" data-track-index="0">
        <div id="p-eyebrow">${esc(V.problem.eyebrow ?? 'THE PROBLEM')}</div>
        <div id="p-num">${esc(V.problem.stat ?? '')}</div>
        <div id="p-sub">${esc(V.problem.note ?? '')}</div>
        ${pLines}
      </section>
` : ''}
${exHtml.join('')}
      <section id="app" class="clip" data-start="${F0}" data-duration="${FD}" data-track-index="0">
        <div id="topbar">${logo()}${V.footage?.pill ? `<span class="pill">${esc(V.footage.pill)}</span>` : ''}</div>
        <div id="frame" class="box"></div>
        <div id="barwrap"><div id="bar"></div></div>
        <div id="rail" class="box" data-layout-allow-overlap><h3>DEMO</h3><h2>${esc(V.railTitle ?? "What you'll see")}</h2><div id="hl"></div>${rows}${rowsOn}
        </div>${capEls}
      </section>

      <!-- the video is timed on its own as a direct child of the stage (never inside a timed section) -->
      <video id="vid" class="clip" src="assets/app.mp4" muted playsinline data-start="${F0}" data-duration="${FD}" data-media-start="${skip.toFixed(2)}" data-track-index="1"></video>
${V.outro ? `
      <section id="outro" class="clip" data-start="${+(F0 + FD).toFixed(2)}" data-duration="${OUTRO}" data-track-index="0">
        ${logo('o-logo')}
        ${outroItems ? `<div class="stacks">${outroItems}</div>` : ''}
        <div id="o-live">${esc(V.outro.tagline ?? '')}</div>
      </section>
` : ''}
    </div>
    <script>
      const tl = gsap.timeline({ paused: true });
      ${A.join(';\n      ')};
      window.__timelines = window.__timelines || {};
      window.__timelines["main"] = tl;
      tl.seek(0);
    </script>
  </body>
</html>
`;
fs.writeFileSync(`${PROJECT}/index.html`, html);
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
console.log(`composition: intro ${INTRO}s${V.problem ? ` + problem ${PROBLEM}s` : ''}${SLIDES.length ? ` + explainer ${EX}s (${SLIDES.length} slides)` : ''} + footage ${FD}s (from ${skip.toFixed(1)}s) + outro ${OUTRO}s = ${TOTAL}s (${mmss(TOTAL)}) · ${steps.length} chapters · ${caps.length} captions`);
