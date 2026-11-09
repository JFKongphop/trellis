// Story-style demo video (like Sprout's): narrated, full-screen app shots with zooms, cut between big text cards.
// Narration drives the timing: every line is spoken by a local voice model (Kokoro via `hyperframes tts`, free,
// nothing leaves the machine), and each scene lasts as long as its lines. Footage shots are retimed to fit.
//
//   node demo/compose-story.mjs [--take demo-video/story-take] [--project demo-video/story]
// then render with one browser:  (cd demo-video/story && npx hyperframes@0.8.78 render -o ../trellis-story.mp4 -w 1)
// Needs: ffmpeg, and HYPERFRAMES_PYTHON pointing at a python with kokoro-onnx + soundfile.
import { execFileSync, spawnSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const TAKE = path.resolve(arg('take', `${ROOT}/demo-video/story-take`));
const PROJECT = path.resolve(arg('project', `${ROOT}/demo-video/story`));
const VO_CACHE = `${ROOT}/demo-video/vo`;
const VOICE = arg('voice', 'af_heart'), SPEED = arg('speed', '1.05');
const HF = 'hyperframes@0.8.78';
const W = 1920, H = 1080, FOOT_W = 1440; // the page is recorded at 1440x810 CSS px (2x device pixels with --scale 2)

// ── the story ────────────────────────────────────────────────────────────────
// card: big centred line(s), *word* = gradient highlight. shot: footage from marker `from` to marker `to`.
const SEARCH_CHAR = 0.075, SEARCH_HOLD = 0.75; // search scene: seconds per typed character, pause after each question
const STORY = [
  { id: 'search', kind: 'search', questions: ['is my NEAR loan safe?', 'what if NEAR drops tonight?', 'can I trust a bot with my wallet?'],
    vo: ['Is my NEAR loan safe? What if NEAR drops tonight? Can I trust a bot with my wallet?'] },
  { id: 'night', kind: 'card', tone: 'crash', lines: ['every leveraged position', 'ends at *3 a.m.*'], sub: 'watching the chart, hoping it holds',
    cues: ['every leveraged', 'ends the same'], subCue: 'watching the chart',
    vo: ['Every leveraged position ends the same way. At three a.m., watching the chart, hoping it holds.'] },
  { id: 'pitch', kind: 'card', logo: true, lines: ['you set the *rules*.', 'Trellis does the *rest*.'], sub: 'an AI agent on NEAR, fenced in by your own vault contract',
    cues: ['you set the', 'trellis does the'], subCue: 'an ai agent',
    vo: ['With Trellis, you set the rules once. Trellis does the rest. An AI agent on NEAR, fenced in by your own vault contract.'] },
  { id: 'ask', kind: 'shot', from: '@ask', to: '@plan',
    vo: ['Just say what you want. Like this. Loop my vault to one point eight x, and keep my health factor above one point five.'] },
  { id: 'plan', kind: 'shot', from: '@plan', to: '@guardian',
    vo: ['Trellis reads live Rhea Lending markets and oracle prices, then builds the plan. Borrow USDC, swap it on Ref, supply the NEAR back.',
      'Here is the money flow. Where every token goes. Health factor three point five six, down to one point six. Still above your line.'] },
  { id: 'guardian', kind: 'shot', from: '@guardian', to: '@rules', toOff: -0.65,
    vo: ['Then the guardian reads it back. Fixed checks that never miss the basics, and an agent that reads the plan itself. One click to approve.'] },
  { id: 'fence', kind: 'card', lines: ['the agent can only do', 'what your *vault* allows.'], sub: 'rules enforced on-chain, not by a prompt',
    cues: ['the agent can', 'what your vault'], subCue: 'checked on chain',
    vo: ['The agent can only do what your vault allows. It never holds your keys. Every move is checked on chain, not by a prompt.'] },
  { id: 'rules', kind: 'shot', from: '@rules', to: '@vault', toOff: -0.55,
    vo: ["Pick the tokens and pools it may touch. Cap every action, and every day. Set the lowest health factor you'll ever accept."] },
  { id: 'vault', kind: 'shot', from: '@vault', to: '@crash',
    vo: ['Your vault holds a leveraged position on Rhea Lending. The Trellis agent watches it, day and night.'] },
  { id: 'turn', kind: 'card', tone: 'crash', lines: ['then NEAR *crashes*.'], sub: '$5.00 → $1.75',
    cues: ['then near crashes'], subCue: 'five dollars',
    vo: ['Then NEAR crashes. Five dollars, down to one seventy-five.'] },
  { id: 'crash', kind: 'shot', tone: 'crash', from: '@crash', to: '@protect',
    vo: ['Health factor, one point two five. Below your trigger, and close to liquidation.'] },
  { id: 'protect', kind: 'shot', from: '@protect', to: '@money',
    vo: ['The agent acts on its own. Withdraw collateral, swap on Ref, repay the debt. Three moves. No signature from you.'] },
  { id: 'money', kind: 'shot', tone: 'heal', from: '@money', to: '@activity',
    vo: ['Every step stays inside your rules. Health factor back to two point one six, while you slept.'] },
  { id: 'activity', kind: 'shot', from: '@activity', to: '@feed',
    vo: ["And every move lands on chain, tagged automatic, with the agent's reason."] },
  { id: 'feed', kind: 'shot', from: '@feed', fromOff: 2.0, to: '@portfolio',
    vo: ['The feed shows every agent move, across every vault. Live.'] },
  // ── on NEAR testnet: the TEE agent, then the agent gone rogue (screenshots of testnet.nearblocks.io in demo-video/proof/)
  { id: 'tee', kind: 'card', lines: ['the agent’s key lives', 'inside a *TEE*.'], sub: 'generated in Intel TDX by OutLayer · no server, no person ever holds it',
    cues: ['the agents key', 'inside a tee'], subCue: 'its generated',
    vo: ["And the agent's key lives inside a TEE. It's generated in a secure Intel enclave, run by OutLayer. No server, and no person, ever holds it."] },
  { id: 'teeproof', kind: 'proof', img: 'tee-repay.png', url: 'testnet.nearblocks.io/txns/GmuKA6SFbQDfQvBFAW35tvwbcbs48FCp4ecpXoBYLH38',
    eyebrow: 'NEAR TESTNET · PUBLIC EXPLORER', title: 'the repay, signed by the *TEE*',
    rings: [{ box: [66, 131, 514, 40], cue: 'this is the' }, { box: [256, 290, 92, 38], cue: 'it went through' }],
    vo: ["This is the agent's repay on NEAR testnet. Signed by the enclave's own account, on your vault. And it went through."] },
  { id: 'rogue', kind: 'card', tone: 'crash', lines: ['what if the agent', 'goes *rogue*?'], sub: 'we tried it on testnet, signed as the real agent',
    cues: ['what if the', 'goes rogue'], subCue: 'we tried it',
    vo: ['But what if the agent goes rogue? We tried it on testnet, signed as the real agent.'] },
  { id: 'refused', kind: 'proof', tone: 'crash', img: 'refused.png', url: 'testnet.nearblocks.io/txns/4oEXGqsB1vYo4U2Dyk6AT5Py79mECCPsL38Nu1TjJ6za',
    eyebrow: 'NEAR TESTNET · 4 ATTEMPTS, 4 REFUSALS', title: 'your vault says *no*.',
    rings: [{ box: [66, 131, 514, 40], cue: 'rewrite its own' }, { box: [256, 290, 336, 38], cue: 'refused every' }],
    chips: [{ t: 'rewrite its own rules → ERR_NOT_OWNER', cue: 'rewrite its own' }, { t: 'unapproved pool → ERR_POOL_NOT_ALLOWED', cue: 'a pool you' },
      { t: 'over the cap → ERR_PER_ACTION_CAP', cue: 'break your cap' }, { t: 'below your floor → min_health_factor', cue: 'borrow below' }],
    vo: ['It tried to rewrite its own rules. Swap through a pool you never allowed. Break your cap. Borrow below your floor. Your vault refused every one, on chain.'] },
  { id: 'intents', kind: 'card', lines: ['fund it from *any chain*.'], sub: 'BTC · ETH · SOL · USDC → your vault, through NEAR Intents',
    cues: ['fund it from'], subCue: 'bitcoin',
    vo: ['And you can fund it from any chain. Bitcoin, Ether, Solana or USDC, delivered straight to your vault through NEAR Intents.'] },
  { id: 'bounded', kind: 'card', lines: ['rules that never *sleep*.', 'an agent that *can’t* break them.'], sub: 'deterministic where it must be, intelligent where it can be',
    cues: ['rules that never', 'an agent that'], subCue: 'deterministic where',
    vo: ["Rules that never sleep. And an agent that can't break them. Deterministic where it must be, intelligent where it can be."] },
  { id: 'billion', kind: 'card', lines: ['the next billion won’t', 'watch *charts*.'], sub: 'they’ll set the rules, and sleep',
    cues: ['the next billion', 'watch charts'], subCue: 'theyll set',
    vo: ["The next billion won't watch charts. They'll set the rules, and sleep."] },
  { id: 'outro', kind: 'outro', cues: ['set the rules'], vo: ['Trellis. Set the rules, and sleep.'] },
];

// ── helpers ──────────────────────────────────────────────────────────────────
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts }).toString();
const dur = (f) => Number(sh('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]));
const r2 = (x) => +x.toFixed(2);
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const hi = (s) => esc(s).replace(/\*(.+?)\*([.,!?]?)/g, '<em>$1$2</em>');

fs.mkdirSync(VO_CACHE, { recursive: true });
fs.mkdirSync(`${PROJECT}/assets`, { recursive: true });

function tts(text) {
  const h = crypto.createHash('sha1').update(`${VOICE}|${SPEED}|${text}`).digest('hex').slice(0, 14);
  const f = `${VO_CACHE}/${h}.wav`;
  if (!fs.existsSync(f)) {
    sh('npx', [HF, 'tts', text, '-v', VOICE, '-s', SPEED, '-o', f], { cwd: VO_CACHE });
    if (!fs.existsSync(f)) throw new Error(`tts failed: ${text}`);
  }
  const out = `${PROJECT}/assets/vo-${h}.wav`;
  if (!fs.existsSync(out)) fs.copyFileSync(f, out);
  return { file: `assets/vo-${h}.wav`, d: dur(f) };
}

// Phrase onsets from the audio: Kokoro pauses at punctuation, so silences split a clip into its phrases.
// cueIn(text, d, file, needle) = seconds into the clip when `needle` is spoken (onset of its phrase + share of that phrase).
const norm = (s) => s.toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const onsetCache = new Map();
function phrases(file, d) {
  if (onsetCache.has(file)) return onsetCache.get(file);
  const err = spawnSync('ffmpeg', ['-hide_banner', '-i', file, '-af', 'silencedetect=noise=-38dB:d=0.12', '-f', 'null', '-'], { encoding: 'utf8' }).stderr; // silencedetect logs to stderr
  const segs = []; let cur = 0;
  for (const line of err.split('\n')) {
    const a = line.match(/silence_start: ([\d.]+)/), b = line.match(/silence_end: ([\d.]+)/);
    if (a) { const x = +a[1]; if (x - cur > 0.08) segs.push([cur, x]); cur = null; }
    if (b) cur = +b[1];
  }
  if (cur !== null && d - cur > 0.08) segs.push([cur, d]);
  onsetCache.set(file, segs);
  return segs;
}
function cueIn(text, d, file, needle) {
  const raw = text.split(/(?<=[.,?!;:])\s+/);
  const n = norm(needle), full = raw.map(norm).join(' ');
  const at = full.indexOf(n);
  if (at < 0) throw new Error(`cue "${needle}" not in narration "${text}"`);
  const segs = phrases(file, d);
  // the voice doesn't pause at every comma: keep the strongest k-1 boundaries (sentence ends first) to match k pauses
  let groups = raw.map((c) => [c]);
  if (segs.length >= 1 && segs.length < raw.length) {
    const keep = raw.slice(0, -1).map((c, i) => ({ i, s: /[.?!]$/.test(c) ? 2 : 1 }))
      .sort((a, b) => b.s - a.s || a.i - b.i).slice(0, segs.length - 1).map((b) => b.i).sort((a, b) => a - b);
    groups = []; let cur = [];
    raw.forEach((c, i) => { cur.push(c); if (keep.includes(i) || i === raw.length - 1) { groups.push(cur); cur = []; } });
  }
  const chunks = groups.map((g) => norm(g.join(' ')));
  if (process.env.CUE_DEBUG) console.error(`cue ${JSON.stringify(needle)}: ${segs.length} pauses vs ${chunks.length} phrase groups`);
  if (segs.length === chunks.length) {
    let ci = 0, off = at;
    while (off > chunks[ci].length) { off -= chunks[ci].length + 1; ci++; }
    const [s0, s1] = segs[ci];
    return s0 + (s1 - s0) * (off / Math.max(1, chunks[ci].length));
  }
  // pauses didn't line up with punctuation: fall back to a share of the speech time
  const sp0 = segs[0]?.[0] ?? 0, sp1 = segs.at(-1)?.[1] ?? d;
  return sp0 + (sp1 - sp0) * (at / Math.max(1, full.length));
}

// markers from the take (edited timeline)
const marks = JSON.parse(fs.readFileSync(`${TAKE}/chapters.json`, 'utf8'));
const markT = (name) => { const m = marks.find((x) => x.html === name); if (!m) throw new Error(`marker ${name} missing`); return m.t; };
const zooms = marks.filter((m) => m.html.startsWith('@zoom ')).map((m) => {
  const [, name, x, y, w, h] = m.html.split(' ');
  return { t: m.t, name, x: +x, y: +y, w: +w, h: +h };
});

// ── timing ───────────────────────────────────────────────────────────────────
const LEAD = 0.35, GAP = 0.3, TAIL = 0.55, MAX_SPEED = 1.9, MIN_SPEED = 0.8;
let t = 0;
const scenes = STORY.map((s) => {
  const voice = s.vo.map(tts);
  const voLen = voice.reduce((a, l) => a + l.d, 0) + GAP * (voice.length - 1);
  let d = LEAD + voLen + TAIL;
  if (s.kind === 'shot') {
    // fromOff / toOff (seconds of the take) cut a page load at a shot's edge, so no blank loading frame shows
    const a = markT(s.from) + (s.fromOff ?? 0), b = markT(s.to) + (s.toOff ?? 0);
    d = Math.max(d, (b - a) / MAX_SPEED);
    s.a = a; s.b = b;
  }
  if (s.kind === 'outro') d = Math.max(d, 6);
  if (s.kind === 'proof') fs.copyFileSync(`${ROOT}/demo-video/proof/${s.img}`, `${PROJECT}/assets/proof-${s.img}`);
  const sc = { ...s, start: r2(t), d: r2(d), voice };
  let lt = t + LEAD;
  sc.lineAt = voice.map((l) => { const at = r2(lt); lt += l.d + GAP; return at; });
  // when (scene-relative) a needle is spoken, searching the voice lines in order
  sc.cue = (needle) => {
    for (let i = 0; i < s.vo.length; i++) if (norm(s.vo[i]).includes(norm(needle))) return sc.lineAt[i] - sc.start + cueIn(s.vo[i], voice[i].d, `${PROJECT}/${voice[i].file}`, needle);
    throw new Error(`cue "${needle}" not in ${s.id} narration`);
  };
  if (s.kind === 'search') { // room to finish typing the last question
    const last = s.questions.at(-1);
    sc.d = r2(Math.max(sc.d, sc.cue(last.split(' ').slice(0, 3).join(' ')) + last.length * SEARCH_CHAR + 1.0));
  }
  t += sc.d;
  return sc;
});
const TOTAL = r2(t);

// ── footage shots: retime each to its scene length (speed up, or slow a little and hold the last frame). Shots keep
// the full 2x resolution; the page zooms them with a transform, so a zoom never upscales a small picture.
const [SW, SH] = sh('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', `${TAKE}/edited.mp4`]).trim().split(',').map(Number);
const PX = SW / FOOT_W; // source pixels per CSS pixel of the recorded page
const ZD = 1.1; // seconds per zoom move
for (const [idx, s] of scenes.entries()) {
  if (s.kind !== 'shot') continue;
  // a shot right after another shot continues from where that one's camera ended (no jump back to full frame)
  const prev = scenes[idx - 1];
  s.afterShot = prev?.kind === 'shot';
  const len = s.b - s.a;
  const k = Math.max(len / s.d, MIN_SPEED); // playback speed
  s.k = k;
  const out = `${PROJECT}/assets/shot-${s.id}.mp4`;
  const pad = Math.max(0, s.d - len / k) + 0.2;
  // crop rects in source pixels: { at, d, w, x, y }
  const rects = [s.afterShot && prev.endRect ? prev.endRect : { w: SW, x: 0, y: 0 }];
  s.startRect = rects[0];
  const moves = [];
  s.zooms = zooms.filter((z) => z.t >= s.a && z.t < s.b).map((z) => {
    const bw = z.w * PX, bh = z.h * PX, cx = (z.x + z.w / 2) * PX, cy = (z.y + z.h / 2) * PX;
    const zs = Math.min(1.75, Math.max(1.15, Math.min((SW * 0.86) / bw, (SH * 0.8) / bh)));
    const w = SW / zs, h = SH / zs;
    const x = Math.min(SW - w, Math.max(0, cx - w / 2)), y = Math.min(SH - h, Math.max(0, cy - h / 2));
    return { at: (z.t - s.a) / k + 0.15, z: r2(zs), w, x, y };
  });
  for (const z of s.zooms) { moves.push({ at: z.at, d: ZD, from: rects.at(-1), to: z }); rects.push(z); }
  if (!s.zooms.length) { // slow push-in
    const w = SW / 1.04;
    moves.push({ at: 0, d: s.d, from: rects[0], to: { w, x: (SW - w) * 0.7, y: (SH - SH / 1.04) * 0.35 } });
  }
  s.endRect = moves.length ? moves.at(-1).to : rects.at(-1);
  s.moves = moves; // zoom is done in the page with a GSAP transform: sub-pixel smooth (per-frame ffmpeg crops snap to whole pixels and shake)
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', s.a.toFixed(3), '-t', len.toFixed(3), '-i', `${TAKE}/edited.mp4`,
    '-vf', `setpts=(PTS-STARTPTS)/${k.toFixed(4)},tpad=stop_mode=clone:stop_duration=${pad.toFixed(2)},fps=30,format=yuv420p`,
    '-an', '-c:v', 'libx264', '-crf', '16', '-preset', 'medium', '-movflags', '+faststart', out], { stdio: 'inherit' });
}

// ── fonts ────────────────────────────────────────────────────────────────────
fs.copyFileSync(`${ROOT}/web/src/app/Variable.woff2`, `${PROJECT}/assets/LabilGrotesk.woff2`);
fs.copyFileSync(`${ROOT}/web/src/app/Brand-wordmark.ttf`, `${PROJECT}/assets/TrellisWordmark.ttf`);

// ── page ─────────────────────────────────────────────────────────────────────
const MARK = (c = '#fff', size = 46) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none"><path d="M4 20 20 4M4 12l8-8M12 20l8-8M4 4l16 16M4 12l8 8M12 4l8 8" stroke="${c}" stroke-width="2.4" stroke-linecap="round"/></svg>`;
const logo = (id) => `<div class="logo" id="${id}"><span class="c">${MARK()}</span><span class="w">trellis</span></div>`;

let body = '', js = '';
const tw = (sel, from, to, at) => { js += `tl.fromTo(${JSON.stringify(sel)}, ${JSON.stringify(from)}, ${JSON.stringify({ ...to, immediateRender: false })}, ${at});\n`; };
const to = (sel, v, at) => { js += `tl.to(${JSON.stringify(sel)}, ${JSON.stringify(v)}, ${at});\n`; };
const set = (sel, v, at) => { js += `tl.set(${JSON.stringify(sel)}, ${JSON.stringify(v)}, ${at});\n`; };

for (const s of scenes) {
  const st = s.start, en = r2(s.start + s.d);
  if (s.kind === 'search') {
    const qs = s.questions;
    body += `<section id="${s.id}" class="clip scene" data-start="${st}" data-duration="${s.d}"><div class="search"><span class="mag">⌕</span>${qs.map((q, i) => `<span class="q" id="q${i}">${[...q].map((ch) => `<i>${ch === ' ' ? '&nbsp;' : esc(ch)}</i>`).join('')}</span>`).join('')}<span class="caret" id="caret"></span></div></section>\n`;
    tw(`#${s.id} .search`, { opacity: 0, y: 30, scale: 0.97 }, { opacity: 1, y: 0, scale: 1, duration: 0.7, ease: 'power3.out' }, st + 0.1);
    // one character at a time, starting as the voice says the question; each char takes no space (display:none) until typed
    const starts = qs.map((q) => r2(st + Math.max(0.5, s.cue(q.split(' ').slice(0, 3).join(' ')) - 0.12)));
    qs.forEach((q, i) => {
      const room = (i < qs.length - 1 ? starts[i + 1] - starts[i] - SEARCH_HOLD * 0.6 : SEARCH_CHAR * q.length);
      const perChar = Math.min(SEARCH_CHAR, room / q.length);
      set(`#q${i}`, { display: 'inline' }, starts[i]);
      js += `tl.to("#q${i} i", {display:"inline", duration:0.01, stagger:${perChar.toFixed(3)}}, ${starts[i]});\n`;
      if (i < qs.length - 1) set(`#q${i}`, { display: 'none' }, r2(starts[i + 1] - 0.02));
    });
    to(`#${s.id} .search`, { opacity: 0, scale: 1.04, duration: 0.4 }, r2(en - 0.4));
  } else if (s.kind === 'card') {
    body += `<section id="${s.id}" class="clip scene card${s.tone ? ' ' + s.tone : ''}" data-start="${st}" data-duration="${s.d}">${s.logo ? logo(`${s.id}-logo`) : ''}<h1>${s.lines.map((l) => `<span class="ln">${hi(l)}</span>`).join('')}</h1>${s.sub ? `<p class="sub">${esc(s.sub)}</p>` : ''}</section>\n`;
    if (s.logo) tw(`#${s.id}-logo`, { opacity: 0, y: 20 }, { opacity: 1, y: 0, duration: 0.6, ease: 'power3.out' }, st + 0.05);
    let prev = st + 0.1;
    s.lines.forEach((_, i) => {
      const at = Math.max(prev, st + (s.cues ? s.cue(s.cues[i]) - 0.15 : 0.15 + 0.32 * i));
      prev = at + 0.12;
      js += `tl.fromTo("#${s.id} .ln:nth-child(${i + 1})", {opacity:0, y:46, filter:"blur(10px)"}, {opacity:1, y:0, filter:"blur(0px)", duration:0.7, ease:"power3.out", immediateRender:false}, ${r2(at)});\n`;
    });
    js += `tl.fromTo("#${s.id} em", {backgroundPosition:"0% 50%"}, {backgroundPosition:"100% 50%", duration:${s.d}, ease:"none", immediateRender:false}, ${st});\n`;
    if (s.sub) tw(`#${s.id} .sub`, { opacity: 0, y: 14 }, { opacity: 1, y: 0, duration: 0.6, ease: 'power2.out' }, r2(Math.max(prev, st + (s.subCue ? s.cue(s.subCue) - 0.15 : 0.6 + 0.32 * s.lines.length))));
    to(`#${s.id} h1, #${s.id} .sub, #${s.id} .logo`, { opacity: 0, y: -16, duration: 0.35, ease: 'power2.in' }, r2(en - 0.38));
  } else if (s.kind === 'shot') {
    // the video is timed on its own, as a direct child of the stage; its wrapper carries the zoom
    body += `<video id="v-${s.id}" class="clip shot" src="assets/shot-${s.id}.mp4" muted playsinline data-start="${st}" data-duration="${s.d}" data-media-start="0"></video>\n`;
    // fade in after a card; straight cut after another shot of the same app (a fade there flashes the page)
    if (!s.afterShot) tw(`#v-${s.id}`, { opacity: 0 }, { opacity: 1, duration: 0.4, ease: 'power2.out' }, st);
    // zoom: crop rect (source px) → transform of the full-frame video (scale about the top-left corner)
    const tf = (r) => { const sc = SW / r.w; return { scale: +sc.toFixed(5), x: +(-r.x * (W / SW) * sc).toFixed(3), y: +(-r.y * (H / SH) * sc).toFixed(3) }; };
    set(`#v-${s.id}`, { ...tf(s.startRect), transformOrigin: '0 0' }, st);
    for (const m of s.moves) to(`#v-${s.id}`, { ...tf(m.to), duration: +m.d.toFixed(3), ease: m.d > ZD ? 'none' : 'sine.inOut' }, r2(st + m.at));
  } else if (s.kind === 'proof') {
    // a NearBlocks screenshot (1394x586) in a browser frame; rings land on the fields the voice names
    const IW = 1394, IH = 586, SHOW = 1180, k = SHOW / IW;
    const ring = (b, i) => `<div class="ring" id="${s.id}-r${i}" style="left:${(b[0] * k).toFixed(1)}px;top:${(b[1] * k).toFixed(1)}px;width:${(b[2] * k).toFixed(1)}px;height:${(b[3] * k).toFixed(1)}px"></div>`;
    body += `<section id="${s.id}" class="clip scene proof${s.tone ? ' ' + s.tone : ''}" data-start="${st}" data-duration="${s.d}"><div class="ph"><span class="eyebrow">${esc(s.eyebrow)}</span><h2>${hi(s.title)}</h2></div><div class="win"><div class="bar"><i></i><i></i><i></i><span class="u">${esc(s.url)}</span></div><div class="pic" style="width:${SHOW}px;height:${(IH * k).toFixed(1)}px"><img src="assets/proof-${s.img}" alt="" />${s.rings.map((r, i) => ring(r.box, i)).join('')}</div></div>${s.chips ? `<div class="rchips">${s.chips.map((c, i) => `<span class="rc" id="${s.id}-c${i}">${esc(c.t)}</span>`).join('')}</div>` : ''}</section>\n`;
    tw(`#${s.id} .ph > *`, { opacity: 0, y: 20 }, { opacity: 1, y: 0, duration: 0.55, stagger: 0.1, ease: 'power3.out' }, st + 0.1);
    tw(`#${s.id} .win`, { opacity: 0, y: 40 }, { opacity: 1, y: 0, duration: 0.65, ease: 'power3.out' }, st + 0.25);
    s.rings.forEach((r, i) => tw(`#${s.id}-r${i}`, { opacity: 0, scale: 1.08 }, { opacity: 1, scale: 1, duration: 0.35, ease: 'power2.out' }, r2(st + Math.max(0.9, s.cue(r.cue) - 0.1))));
    (s.chips ?? []).forEach((c, i) => tw(`#${s.id}-c${i}`, { opacity: 0, y: 12 }, { opacity: 1, y: 0, duration: 0.4, ease: 'power2.out' }, r2(st + Math.max(0.9, s.cue(c.cue) - 0.1))));
    to(`#${s.id} .ph, #${s.id} .win, #${s.id} .rchips`, { opacity: 0, y: -16, duration: 0.35, ease: 'power2.in' }, r2(en - 0.38));
  } else if (s.kind === 'outro') {
    body += `<section id="${s.id}" class="clip scene card outro" data-start="${st}" data-duration="${s.d}">${logo('o-logo')}<h1><span class="ln">set the rules. <em>sleep.</em></span></h1><div class="chips"><span class="chip">NEAR</span><span class="chip">Rhea Lending</span><span class="chip">Ref DEX</span><span class="chip">NEAR Intents</span><span class="chip">OutLayer TEE</span><span class="chip g">Rust policy vault</span></div><p class="url">github.com/JFKongphop/trellis · <b>live on NEAR testnet</b></p></section>\n`;
    tw('#o-logo', { opacity: 0, scale: 0.9 }, { opacity: 1, scale: 1, duration: 0.7, ease: 'back.out(1.6)' }, st + 0.1);
    js += `tl.fromTo("#o-logo .c path", {strokeDasharray:140, strokeDashoffset:140}, {strokeDashoffset:0, duration:1.6, ease:"power2.inOut", immediateRender:false}, ${r2(st + 0.2)});\n`;
    tw(`#${s.id} .ln`, { opacity: 0, y: 40, filter: 'blur(10px)' }, { opacity: 1, y: 0, filter: 'blur(0px)', duration: 0.75, ease: 'power3.out' }, r2(st + s.cue(s.cues[0]) - 0.15));
    js += `tl.fromTo("#${s.id} .chip", {opacity:0, y:16}, {opacity:1, y:0, duration:0.45, stagger:0.1, ease:"power2.out", immediateRender:false}, ${r2(st + s.cue(s.cues[0]) + 0.7)});\n`;
    tw(`#${s.id} .url`, { opacity: 0 }, { opacity: 1, duration: 0.6 }, r2(st + s.cue(s.cues[0]) + 1.4));
  }
  // voice
  s.voice.forEach((l, i) => { body += `<audio id="vo-${s.id}-${i}" src="${l.file}" data-start="${s.lineAt[i]}" data-duration="${r2(l.d)}" data-volume="1"></audio>\n`; });
}

// background shader cues
const cue = scenes.map((s) => ({ s: s.start, d: s.d, kind: s.kind, tone: s.tone ?? '' }));

const FRAG = `
precision highp float;
uniform vec2 R; uniform float T, uCrash, uHeal, uDim;
vec3 mod289(vec3 x){return x-floor(x*(1./289.))*289.;} vec2 mod289(vec2 x){return x-floor(x*(1./289.))*289.;}
vec3 permute(vec3 x){return mod289(((x*34.)+1.)*x);}
float snoise(vec2 v){ const vec4 C=vec4(.211324865405187,.366025403784439,-.577350269189626,.024390243902439);
  vec2 i=floor(v+dot(v,C.yy)); vec2 x0=v-i+dot(i,C.xx); vec2 i1=(x0.x>x0.y)?vec2(1.,0.):vec2(0.,1.);
  vec4 x12=x0.xyxy+C.xxzz; x12.xy-=i1; i=mod289(i);
  vec3 p=permute(permute(i.y+vec3(0.,i1.y,1.))+i.x+vec3(0.,i1.x,1.));
  vec3 m=max(.5-vec3(dot(x0,x0),dot(x12.xy,x12.xy),dot(x12.zw,x12.zw)),0.); m=m*m; m=m*m;
  vec3 x=2.*fract(p*C.www)-1.; vec3 h=abs(x)-.5; vec3 ox=floor(x+.5); vec3 a0=x-ox;
  m*=1.79284291400159-.85373472095314*(a0*a0+h*h);
  vec3 g; g.x=a0.x*x0.x+h.x*x0.y; g.yz=a0.yz*x12.xz+h.yz*x12.yw; return 130.*dot(m,g); }
float fbm(vec2 p){ float a=.5, s=0.; for(int i=0;i<3;i++){ s+=a*snoise(p); p*=1.9; a*=.5; } return s; }
void main(){
  vec2 uv = gl_FragCoord.xy / R;
  vec2 p = (gl_FragCoord.xy - .5*R) / R.y;
  vec3 base = vec3(.965,.961,.953);
  float t = T*.035;
  vec2 q = vec2(fbm(p*.25 + vec2(0., t)), fbm(p*.25 + vec2(5.2, -t)));
  vec2 r = vec2(fbm(p*.3 + .8*q + vec2(1.7, 9.2) + t*.7), fbm(p*.3 + .8*q + vec2(8.3, 2.8) - t*.5));
  float f = fbm(p*.3 + r);
  vec3 orange = vec3(.976,.451,.086), violet = vec3(.545,.435,.78), pink = vec3(.925,.282,.6);
  vec3 col = mix(orange, violet, smoothstep(-.4, .6, r.x));
  col = mix(col, pink, smoothstep(.2, .9, q.y) * .5);
  col = mix(col, vec3(.9,.2,.16), uCrash * .7);
  col = mix(col, vec3(.2,.78,.55), uHeal * .6);
  float amt = smoothstep(-.05, .75, f);
  // a soft blob in the lower right, like the app's own glow; the centre stays calm for the text
  // Sprout-like: a clean canvas with one soft glow in the lower right (and a faint one top left)
  vec2 bc = vec2(.9 + .03*sin(T*.21), .1 + .04*cos(T*.17));
  float blob = smoothstep(.95, .0, length((uv - bc) * vec2(1.25, 1.)));
  float blob2 = smoothstep(.7, .0, length((uv - vec2(.04, .98)) * vec2(1.5, 1.))) * .45;
  float glow = max(blob, blob2);
  float strength = glow * (.55 + .35*smoothstep(-.3, .6, f)) * (1. - uDim*.5);
  strength += uCrash * .08 * glow * (.5 + .5*sin(T*5.));
  vec3 c = mix(base, col, strength);
  gl_FragColor = vec4(c, 1.);
}`;

const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${W}, height=${H}" />
    <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Sometype+Mono:wght@500;700&display=swap" />
    <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
    <style>
      @font-face { font-family: 'Labil Grotesk'; src: url('assets/LabilGrotesk.woff2') format('woff2'); font-weight: 100 800; }
      @font-face { font-family: 'Trellis Wordmark'; src: url('assets/TrellisWordmark.ttf') format('truetype'); }
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { width: ${W}px; height: ${H}px; overflow: hidden; background: #f6f5f3; }
      #root { position: relative; width: ${W}px; height: ${H}px; overflow: hidden; background: #f6f5f3; font-family: 'Labil Grotesk', system-ui, sans-serif; color: #111; }
      .clip { position: absolute; inset: 0; }
      #fx { position: absolute; left: 0; top: 0; width: ${W}px; height: ${H}px; z-index: 0; }
      .scene { z-index: 2; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; gap: 30px; }
      .shotwrap { z-index: 3; overflow: hidden; background: #f6f5f3; }
      .shot { z-index: 3; background: #f6f5f3; position: absolute; left: 0; top: 0; width: ${W}px; height: ${H}px; transform-origin: 0 0; object-fit: cover; }
      .card h1 { font-weight: 500; font-size: 112px; line-height: 1.04; letter-spacing: -.04em; display: flex; flex-direction: column; color: #1b1a19; }
      .card h1 .ln { display: block; }
      /* everything that animates in starts hidden; a staggered tween only takes over when its own turn starts */
      .card h1 .ln, .card .sub, .logo, .chip, .url, .search { opacity: 0; }
      em { font-style: normal; background: linear-gradient(100deg, #d9622a 0%, #ee7b3d 30%, #c46ad8 70%, #b04fc7 100%); background-size: 240% 100%;
        -webkit-background-clip: text; background-clip: text; color: transparent; padding-bottom: .08em; }
      .card.crash em { background-image: linear-gradient(100deg, #e5482f, #f07a2c 50%, #e5482f); }
      .sub { font: 500 34px 'Sometype Mono', monospace; color: #8a8785; letter-spacing: -.01em; }
      .card.crash .sub { color: #c4553b; }
      .logo { display: inline-flex; align-items: center; gap: 20px; }
      .logo .c { width: 78px; height: 78px; background: #111; border-radius: 18px; display: grid; place-items: center; box-shadow: 0 14px 30px -14px rgba(17,17,17,.55); }
      .logo .w { font: 600 60px 'Trellis Wordmark', 'Labil Grotesk', sans-serif; letter-spacing: -.01em; }
      .search { position: relative; width: 1180px; height: 132px; background: #fff; border-radius: 999px; display: flex; align-items: center; gap: 26px; padding: 0 56px;
        box-shadow: 0 0 0 1px rgba(17,17,17,.06), 0 2px 4px rgba(17,17,17,.04), 0 40px 80px -36px rgba(17,17,17,.35); font-size: 52px; font-weight: 500; letter-spacing: -.02em; text-align: left; }
      .search .mag { font-size: 64px; color: #b8b6b3; transform: translateY(-4px); }
      .search .q { display: none; white-space: nowrap; } .search .q i { font-style: normal; display: none; }
      .search .caret { width: 4px; height: 60px; background: #ee7b3d; border-radius: 2px; margin-left: -20px; }
      .outro h1 { font-size: 96px; }
      .chips { display: flex; gap: 14px; }
      .chip { background: #111; color: #fff; border-radius: 999px; font: 500 26px 'Labil Grotesk', sans-serif; padding: 13px 26px; }
      .chip.g { background: linear-gradient(100deg, #ee7b3d, #b04fc7); }
      .url { font: 500 32px 'Sometype Mono', monospace; color: #6d6c6b; } .url b { color: #111; }
      .proof { gap: 26px; } .proof .ph { display: flex; flex-direction: column; align-items: center; gap: 14px; } .proof .ph > * { opacity: 0; }
      .proof .eyebrow { font: 700 22px 'Sometype Mono', monospace; letter-spacing: .06em; color: #fff; background: #111; border-radius: 10px; padding: 8px 16px; }
      .proof.crash .eyebrow { background: #c4553b; }
      .proof h2 { font-weight: 500; font-size: 64px; line-height: 1.05; letter-spacing: -.03em; color: #1b1a19; }
      .proof .win { opacity: 0; background: #fff; border-radius: 18px; overflow: hidden; box-shadow: 0 0 0 1px rgba(17,17,17,.06), 0 40px 80px -34px rgba(17,17,17,.4); }
      .proof .bar { height: 48px; background: #eef0f3; display: flex; align-items: center; gap: 9px; padding: 0 18px; border-bottom: 1px solid #e2e5ea; }
      .proof .bar i { width: 12px; height: 12px; border-radius: 50%; background: #d4d7dc; } .proof .bar i:nth-child(1) { background: #ff5f57; } .proof .bar i:nth-child(2) { background: #febc2e; } .proof .bar i:nth-child(3) { background: #28c840; }
      .proof .bar .u { margin-left: 14px; flex: 1; height: 30px; border-radius: 8px; background: #fff; display: flex; align-items: center; padding: 0 12px; font: 500 16px 'Sometype Mono', monospace; color: #4b5563; white-space: nowrap; overflow: hidden; text-align: left; }
      .proof .pic { position: relative; } .proof .pic img { display: block; width: 100%; height: 100%; }
      .proof .ring { position: absolute; border: 4px solid #ee7b3d; border-radius: 12px; opacity: 0; }
      .proof.crash .ring { border-color: #e5482f; }
      .rchips { display: flex; flex-wrap: wrap; justify-content: center; gap: 12px; max-width: 1500px; }
      .rc { opacity: 0; background: #fff; border: 2px solid #e5482f; color: #9b2f1d; border-radius: 999px; font: 600 22px 'Sometype Mono', monospace; padding: 9px 18px; }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-duration="${TOTAL}" data-width="${W}" data-height="${H}">
      <canvas id="fx" width="960" height="540"></canvas>
${body}
    </div>
    <script>
      const tl = gsap.timeline({ paused: true });
${js}
      // caret blink in the search scene
      for (let k = 0; k < 14; k++) tl.set('#caret', { opacity: k % 2 ? 0 : 1 }, ${scenes[0].start} + k * 0.5);
      window.__timelines = window.__timelines || {};
      window.__timelines["main"] = tl;
    </script>
    <script>
    (function () {
      var tl = window.__timelines.main;
      var cv = document.getElementById('fx');
      var gl = cv.getContext('webgl', { preserveDrawingBuffer: true, antialias: false, alpha: false });
      if (!gl) { tl.seek(0); return; }
      function sh(type, src) { var s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; }
      var pr = gl.createProgram();
      gl.attachShader(pr, sh(gl.VERTEX_SHADER, 'attribute vec2 a; void main(){ gl_Position = vec4(a, 0., 1.); }'));
      gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, ${JSON.stringify(FRAG)}));
      gl.linkProgram(pr); gl.useProgram(pr);
      var buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      var loc = gl.getAttribLocation(pr, 'a'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      var names = ['T', 'uCrash', 'uHeal', 'uDim'];
      var L = {}; names.forEach(function (n) { L[n] = gl.getUniformLocation(pr, n); });
      gl.uniform2f(gl.getUniformLocation(pr, 'R'), cv.width, cv.height);
      var V = { T: 0, uCrash: 0, uHeal: 0, uDim: 0 };
      function draw() { names.forEach(function (n) { gl.uniform1f(L[n], V[n]); }); gl.viewport(0, 0, cv.width, cv.height); gl.drawArrays(gl.TRIANGLES, 0, 3); }
      // tl.seek suppresses callbacks, so redraw from property setters, once per seek
      var queued = false, U = {};
      names.forEach(function (n) {
        Object.defineProperty(U, n, { get: function () { return V[n]; }, set: function (v) {
          V[n] = v; if (!queued) { queued = true; Promise.resolve().then(function () { queued = false; draw(); }); } } });
      });
      var C = ${JSON.stringify(cue)};
      tl.fromTo(U, { T: 0 }, { T: ${TOTAL}, duration: ${TOTAL}, ease: 'none' }, 0);
      C.forEach(function (c) {
        var crash = c.tone === 'crash' ? 1 : 0, heal = c.tone === 'heal' ? 1 : 0;
        tl.to(U, { uCrash: crash, uHeal: heal, duration: 0.8, ease: 'power2.out' }, Math.max(0, c.s - 0.2));
      });
      tl.seek(0);
      draw();
    })();
    </script>
  </body>
</html>
`;

fs.writeFileSync(`${PROJECT}/index.html`, html);
for (const f of ['package.json', 'hyperframes.json', 'meta.json']) {
  const src = `${ROOT}/demo-video/hyperframes/${f}`;
  if (fs.existsSync(src) && !fs.existsSync(`${PROJECT}/${f}`)) fs.copyFileSync(src, `${PROJECT}/${f}`);
}
console.log(scenes.map((s) => `${String(s.start).padStart(6)}  ${s.d.toFixed(1).padStart(5)}s  ${s.kind.padEnd(6)} ${s.id}${s.k ? `  footage x${s.k.toFixed(2)}` : ''}${s.zooms?.length ? `  zoom ${s.zooms.map((z) => z.z).join(',')}` : ''}`).join('\n'));
console.log(`total ${TOTAL}s (${Math.floor(TOTAL / 60)}:${String(Math.round(TOTAL % 60)).padStart(2, '0')}) → ${PROJECT}/index.html`);
