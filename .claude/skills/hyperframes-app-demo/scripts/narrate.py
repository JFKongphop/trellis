#!/usr/bin/env python3
"""Add an ElevenLabs voice-over to a finished demo video.

  narrate.py --video demo.mp4 --script narration.json --env .env --out demo-vo.mp4

narration.json: {"voice": "<voice_id>", "model": "eleven_multilingual_v2", "lines": [{"t": 0.4, "max": 5.5, "text": "..."}]}
  t    when the line starts, in seconds of the final video
  max  how long it may run before the next scene; a longer clip is sped up (up to 1.15x), past that the run fails
Each line is generated once and cached by voice + text in <out dir>/vo/, so editing one line regenerates only that one.
The key is read from ELEVENLABS_API_KEY in the environment or in --env, and never printed.
"""
import argparse, hashlib, json, os, subprocess, sys, urllib.request

ap = argparse.ArgumentParser()
ap.add_argument('--video', required=True); ap.add_argument('--script', required=True)
ap.add_argument('--env'); ap.add_argument('--out', required=True); ap.add_argument('--gain', type=float, default=1.0)
a = ap.parse_args()

key = os.environ.get('ELEVENLABS_API_KEY')
if not key and a.env:
    for line in open(a.env):
        if line.startswith('ELEVENLABS_API_KEY='): key = line.split('=', 1)[1].strip().strip('"\'')
if not key: sys.exit('ELEVENLABS_API_KEY is not set')

S = json.load(open(a.script))
cache = os.path.join(os.path.dirname(os.path.abspath(a.out)), 'vo'); os.makedirs(cache, exist_ok=True)
dur = lambda f: float(subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f], capture_output=True, text=True).stdout)

def tts(text):
    h = hashlib.sha1(f"{S['voice']}|{S.get('model')}|{json.dumps(S.get('settings'))}|{text}".encode()).hexdigest()[:16]
    f = os.path.join(cache, f'{h}.mp3')
    if not os.path.exists(f):
        body = {'text': text, 'model_id': S.get('model', 'eleven_multilingual_v2')}
        if S.get('settings'): body['voice_settings'] = S['settings']
        req = urllib.request.Request(f"https://api.elevenlabs.io/v1/text-to-speech/{S['voice']}?output_format=mp3_44100_128",
                                     data=json.dumps(body).encode(), headers={'xi-api-key': key, 'Content-Type': 'application/json'})
        try:
            with urllib.request.urlopen(req) as r: open(f, 'wb').write(r.read())
        except urllib.error.HTTPError as e: sys.exit(f'TTS failed ({e.code}): {e.read().decode()[:300]}')
    return f

vlen = dur(a.video); inputs, filters, bad = [], [], []
for i, L in enumerate(S['lines']):
    f = tts(L['text']); d = dur(f); room = L.get('max', 99); tempo = 1.0
    if d > room: tempo = d / room
    end = L['t'] + d / tempo
    flag = '' if tempo == 1 else f'  sped {tempo:.2f}x'
    if tempo > 1.15: flag = f'  TOO LONG ({d:.1f}s for {room}s)'; bad.append(i)
    if end > vlen: flag += '  PAST THE END'; bad.append(i)
    print(f"{L['t']:7.2f}–{end:7.2f}  {d:5.2f}s{flag}  {L['text'][:70]}")
    inputs += ['-i', f]
    chain = f"[{i + 1}:a]aresample=48000,aformat=channel_layouts=stereo"
    if tempo > 1: chain += f",atempo={tempo:.4f}"
    filters.append(chain + f",adelay={int(L['t'] * 1000)}|{int(L['t'] * 1000)}[a{i}]")
if bad: sys.exit(f'{len(bad)} line(s) do not fit: shorten them or move them')

n = len(S['lines'])
fc = ';'.join(filters) + ';' + ''.join(f'[a{i}]' for i in range(n)) + f'amix=inputs={n}:normalize=0:dropout_transition=0,volume={a.gain},apad[mix]'
subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', a.video, *inputs, '-filter_complex', fc, '-map', '0:v', '-map', '[mix]',
                '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', a.out], check=True)
print('→', a.out, f'{dur(a.out):.1f}s')
