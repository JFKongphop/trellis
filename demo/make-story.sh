#!/usr/bin/env bash
# Story video (Sprout style): record → speed up waits → narrate + compose → render.
# Run from the repo root with the light replay demo running (`pnpm demo`, :3000).
# Memory: one headless browser for the take, one for the render (-w 1). Never more.
# Voice: Kokoro via `hyperframes tts` (local, free). One-time setup:
#   python3 -m venv ~/.cache/hf-tts-venv && ~/.cache/hf-tts-venv/bin/pip install kokoro-onnx soundfile
set -euo pipefail
SKILL=.claude/skills/hyperframes-app-demo/scripts
export HYPERFRAMES_PYTHON=${HYPERFRAMES_PYTHON:-$HOME/.cache/hf-tts-venv/bin/python}
rm -rf demo-video/story-take
CAPTIONS=0 PACE=1.4 node $SKILL/record.mjs --scenario demo/story-scenario.mjs --base-url http://localhost:3000 \
  --out demo-video/story-take --viewport 1440x810 --scale 2 | grep -E '✓|✅|❌'
ls demo-video/story-take/raw/take.* >/dev/null  # the recorder writes take.mp4 (older versions: take.webm)
node $SKILL/edit.mjs --out demo-video/story-take
rm -f demo-video/story/assets/shot-*
node demo/compose-story.mjs
(cd demo-video/story && npx --yes hyperframes@0.8.78 render -o ../trellis-story.new.mp4 --fps 30 --quality high --video-frame-format png -w 1)
mv demo-video/trellis-story.new.mp4 demo-video/trellis-story.mp4
echo "✅ demo-video/trellis-story.mp4"
