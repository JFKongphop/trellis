// Speeds up the slow waits logged by record.mjs and renders <out>/edited.mp4, plus chapters.json
// (caption times mapped onto the edited timeline, for HyperFrames sync).
// A wait of d seconds plays in ~KEEP + (d − KEEP)/SQUEEZE seconds; waits ≤ KEEP+0.5 s stay real-time.
//
// Usage: node <skill>/scripts/edit.mjs --out demo-video/take [--keep 2] [--squeeze 8] [--max 6]
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const OUT = path.resolve(arg('out', 'demo-video/take'));
const KEEP = Number(arg('keep', 2)), SQUEEZE = Number(arg('squeeze', 8)), MAX = Number(arg('max', 6)); // no wait longer than MAX s on screen
const src = fs.existsSync(`${OUT}/raw/take.mp4`) ? `${OUT}/raw/take.mp4` : `${OUT}/raw/take.webm`; // take.mp4 = sharp --scale capture
const marks = JSON.parse(fs.readFileSync(`${OUT}/marks.json`, 'utf8'));
const dur = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', src]).toString());

const segs = []; // [start, end, speed]
let t = 0;
for (const m of marks) {
  if (m.s > t) segs.push([t, m.s, 1]);
  const d = m.e - m.s;
  segs.push([m.s, m.e, d <= KEEP + 0.5 ? 1 : d / Math.min(MAX, KEEP + (d - KEEP) / SQUEEZE)]);
  t = m.e;
}
if (t < dur) segs.push([t, dur, 1]);

const parts = segs.map(([s, e, k], i) => `[0:v]trim=start=${s.toFixed(3)}:end=${e.toFixed(3)},setpts=(PTS-STARTPTS)/${k.toFixed(4)}[v${i}]`);
const filter = `${parts.join(';')};${segs.map((_, i) => `[v${i}]`).join('')}concat=n=${segs.length}:v=1:a=0,fps=30,format=yuv420p[out]`;
execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', src, '-filter_complex', filter, '-map', '[out]',
  '-c:v', 'libx264', '-crf', '18', '-preset', 'slow', '-movflags', '+faststart', `${OUT}/edited.mp4`], { stdio: 'inherit' });

const mapT = (x) => segs.reduce((a, [s, e, k]) => a + (x <= s ? 0 : (Math.min(x, e) - s) / k), 0);
const caps = fs.existsSync(`${OUT}/captions.json`) ? JSON.parse(fs.readFileSync(`${OUT}/captions.json`, 'utf8')) : [];
fs.writeFileSync(`${OUT}/chapters.json`, JSON.stringify(caps.map((c) => ({ t: +mapT(c.t).toFixed(2), html: c.html })), null, 2));
const final = mapT(dur);
console.log(`raw ${dur.toFixed(1)}s → edited ${final.toFixed(1)}s (${Math.floor(final / 60)}:${String(Math.round(final % 60)).padStart(2, '0')}) → ${OUT}/edited.mp4`);
