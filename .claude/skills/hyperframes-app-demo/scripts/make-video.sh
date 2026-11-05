#!/usr/bin/env bash
# One-shot app demo video: record (Playwright) → speed up waits → HyperFrames compose → check → render → check frames.
# Run from the target project root.
#
#   make-video.sh --scenario demo/scenario.mjs [options]
#
#   --base-url URL        app URL (default: auto — scan localhost:3000-3010 for --probe text)
#   --probe TEXT          text that proves a port serves THIS app (default: none → first port answering 200)
#   --probe-path PATH     path to probe (default: /)
#   --serve "CMD"         start the app with CMD if nothing is serving (e.g. "npm run dev")
#   --out DIR             output dir (default: demo-video)
#   --before-take "CMD"   run before every take attempt (reset state: seed DB, open a fresh market, …)
#   --burner ETH          dapps: fund a fresh wallet with ETH from $FUNDER_PK over --rpc; passed to the take as WALLET_PK
#   --rpc URL             RPC for --burner
#   --attempts N          retries on a failed take (default 3)
#   --pace N              pause multiplier (default 1.4 ≈ 3.5–4.5 s per readable step)
#   --no-render           stop after `hyperframes check`
set -euo pipefail
SKILL=$(cd "$(dirname "$0")/.." && pwd)
SCENARIO=demo/scenario.mjs; BASE=auto; PROBE=""; PROBE_PATH=/; SERVE=""; OUT=demo-video; BEFORE=""
BURNER=""; RPC=""; ATTEMPTS=3; PACE=1.4; RENDER=1
while [[ $# -gt 0 ]]; do
  case $1 in
    --scenario) SCENARIO=$2; shift ;; --base-url) BASE=$2; shift ;; --probe) PROBE=$2; shift ;;
    --probe-path) PROBE_PATH=$2; shift ;; --serve) SERVE=$2; shift ;; --out) OUT=$2; shift ;;
    --before-take) BEFORE=$2; shift ;; --burner) BURNER=$2; shift ;; --rpc) RPC=$2; shift ;;
    --attempts) ATTEMPTS=$2; shift ;; --pace) PACE=$2; shift ;; --no-render) RENDER=0 ;;
    *) echo "unknown flag $1"; exit 2 ;;
  esac; shift
done
PROJ=$(pwd); WORK=$(mktemp -d "${TMPDIR:-/tmp}/app-demo.XXXXXX")   # burner keys live here, never in the project
HF=$(node -e "import('file://$PROJ/$SCENARIO').then(m=>console.log('hyperframes@'+(m.video?.hyperframesVersion||'0.8.78')))")
log() { printf '\n\033[1m▶ %s\033[0m\n' "$*"; }
trap 'rm -rf "$WORK"' EXIT

log "preflight"
[[ -f $SCENARIO ]] || { echo "scenario not found: $SCENARIO"; exit 1; }
for b in node npx ffmpeg ffprobe curl; do command -v $b >/dev/null || { echo "missing: $b"; exit 1; }; done
[[ -z $BURNER ]] || { command -v cast >/dev/null && command -v jq >/dev/null && [[ -n ${FUNDER_PK:-} && -n $RPC ]] || { echo "--burner needs cast, jq, \$FUNDER_PK and --rpc"; exit 1; }; }
node -e "require.resolve('playwright')" 2>/dev/null || { echo "installing playwright in $PROJ"; npm i -D playwright >/dev/null; }
npx playwright install chromium >/dev/null 2>&1 || true

probe() { local body; body=$(curl -s --max-time 5 "$1$PROBE_PATH") || return 1
  if [[ -n $PROBE ]]; then grep -q -- "$PROBE" <<<"$body"; else [[ $(curl -s --max-time 5 -o /dev/null -w '%{http_code}' "$1$PROBE_PATH") == 200 ]]; fi; }
find_app() { for p in $(seq 3000 3010); do probe "http://localhost:$p" && { echo "http://localhost:$p"; return; }; done; }
if [[ $BASE == auto ]]; then
  BASE=$(find_app || true)
  if [[ -z $BASE && -n $SERVE ]]; then
    log "starting app: $SERVE"; nohup bash -c "$SERVE" > "$WORK/serve.log" 2>&1 &
    for _ in $(seq 1 90); do BASE=$(find_app || true); [[ -n $BASE ]] && break; sleep 1; done
  fi
  [[ -n $BASE ]] || { echo "app not found on :3000-3010 (use --base-url, --probe or --serve)"; exit 1; }
fi
curl -s -o /dev/null "$BASE$PROBE_PATH" || true
echo "app $BASE"

ok=0
for a in $(seq 1 "$ATTEMPTS"); do
  log "take $a/$ATTEMPTS"
  [[ -z $BEFORE ]] || { echo "before-take: $BEFORE"; bash -c "$BEFORE"; }
  if [[ -n $BURNER ]]; then
    cast wallet new --json > "$WORK/burner.json"
    export WALLET_PK=$(jq -r '.[0].private_key' "$WORK/burner.json")
    B=$(jq -r '.[0].address' "$WORK/burner.json")
    cast send --rpc-url "$RPC" --private-key "$FUNDER_PK" "$B" --value "${BURNER}ether" >/dev/null && echo "burner $B funded with $BURNER ETH"
  fi
  rm -rf "$OUT/take"
  CAPTIONS=0 PACE=$PACE node "$SKILL/scripts/record.mjs" --scenario "$SCENARIO" --base-url "$BASE" --out "$OUT/take" | tee "$WORK/take.log" | grep -E "✓|❌|✅|resend|error" || true
  grep -q "✅ recorded" "$WORK/take.log" && { ok=1; break; }
  # only a failure *inside* the scenario (❌) is worth retrying — a crash in the recorder itself won't fix itself
  grep -q "❌" "$WORK/take.log" || { echo "recorder crashed before the scenario ran:"; tail -8 "$WORK/take.log"; exit 1; }
  echo "take failed — see $OUT/take/FAIL.png"
done
[[ $ok == 1 ]] || { echo "all $ATTEMPTS takes failed"; exit 1; }

log "edit"
node "$SKILL/scripts/edit.mjs" --out "$OUT/take"
log "compose"
node "$SKILL/scripts/compose.mjs" --scenario "$SCENARIO" --take "$OUT/take" --project "$OUT/hyperframes"
(cd "$OUT/hyperframes" && npx --yes "$HF" check 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -E "error\(s\)|WCAG|Check (passed|failed)")
[[ $RENDER == 1 ]] || { echo "--no-render: composition at $OUT/hyperframes/index.html"; exit 0; }

log "render (≈2–3 min)"
(cd "$OUT/hyperframes" && npx --yes "$HF" render -o ../demo-hyperframes.mp4 --fps 30 --quality high --video-frame-format png -w 4 2>&1 \
  | sed 's/\x1b\[[0-9;]*m//g' | grep -E "MB ·|rror" || true)
FINAL=$OUT/demo-hyperframes.mp4
DUR=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$FINAL")
mkdir -p "$OUT/check"; rm -f "$OUT/check"/*.png
for f in 0.02 0.06 0.25 0.5 0.75 0.97; do t=$(awk "BEGIN{printf \"%.1f\", $DUR*$f}"); ffmpeg -v error -y -ss "$t" -i "$FINAL" -frames:v 1 -vf scale=960:-1 "$OUT/check/t$t.png"; done
rm -rf "$OUT/take/raw"
printf '\n✅ %s (%.0fs) · frames to check: %s/check/\n' "$FINAL" "$DUR" "$OUT"
