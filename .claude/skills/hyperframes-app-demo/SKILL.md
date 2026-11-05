---
name: hyperframes-app-demo
description: Make a polished product demo video of any web app or dapp with Playwright + HyperFrames — record a scripted run of the real app (visible cursor, typed input, smooth scrolling, optional injected test wallet for web3), speed up slow waits (transactions, API calls), and render a 1920×1080 HyperFrames cut with a title card, an optional problem card, the framed footage with a synced chapter rail and captions, and an outro. Use this whenever the user wants a demo video, product walkthrough, hackathon / buildathon / pitch submission video, launch video or screen-recorded tour of their own app — or wants to re-record, retake, speed up/slow down or restyle one — even if they don't mention Playwright or HyperFrames.
---

# App demo video (Playwright + HyperFrames)

Turns a running web app into a ~2–3 min, 1920×1080 demo video that shows the **real** app doing real things.
Only slow waits are sped up, and they're labelled on screen, so the video stays honest.

`<skill>` below means this skill's folder: `.claude/skills/hyperframes-app-demo` at the root of the repo it
lives in. **To reuse it in another project**, copy the whole folder into that project's `.claude/skills/`. It has no
project-specific code; everything app-specific lives in the scenario file you write there.

Pipeline: **scenario** (you write) → `record.mjs` → `edit.mjs` → `compose.mjs` → `hyperframes check` → `render` →
verification frames. `scripts/make-video.sh` runs it end to end with retries.

## 1 · Understand the app and agree the story

Before writing anything, read the app (routes, main components, the happy path) and agree the storyboard with the
user: 6–10 steps, each with one clear on-screen claim. Keep the final video at or under ~3:00 — judges and viewers
rarely watch longer, and each readable step needs ~3.5–4.5 s. Ask only what you can't infer (which features to show,
the one-line pitch, the "problem" stat if they want a problem card).

Check the facts you put on cards. A stat on the problem card is a claim in the user's name — if you didn't verify it
in this session, say so and let them confirm it.

## 2 · Write the scenario (`demo/scenario.mjs` in the project)

A scenario is a JS module with three exports. Read `references/scenario-api.md` for every helper and config field,
and one of the examples: `references/example-webapp-scenario.mjs` (plain web app) or
`references/example-dapp-scenario.mjs` (a real DeFi dapp: wallet, on-chain waits, chapter matching, reading a tx
receipt mid-flow).

```js
export const config = { /* optional: wallet: { rpc, chainId, privateKeyEnv: 'WALLET_PK' }, hide: ['.cookie-banner'] */ };
export const video  = { brand, intro, problem?, footage, chapters?, outro };   // what HyperFrames draws
export default async function ({ page, goto, caption, click, type, point, scrollTo, scrollY, hold, waitFor, wallet }) {
  await goto('/');
  await caption('<b>1 ·</b> Sign up in one click');       // numbered captions become chapters + lower-thirds
  await click(page.getByRole('button', { name: 'Sign up' }));
  await waitFor('account created', /Welcome/);             // slow step → logged → sped up in the edit
  await hold(2500);                                        // let the viewer read the result
}
```

Why the conventions matter:
- **`waitFor` for anything slow** (tx confirmations, API calls, builds). It fails fast on an error locator you pass
  and logs the stretch so `edit.mjs` compresses it. Plain `page.waitFor…` calls are *not* sped up.
- **Captions are logged even when not drawn.** The take records with `CAPTIONS=0`, and HyperFrames draws synced
  lower-thirds from the log, so caption text is also the chapter source. Prefix steps `<b>N ·</b>` so they're easy to match.
- **Hold after every result** (`hold(2500–3500)` before `PACE`). A result on screen for under 2 s isn't read.
- **Prefer role/label locators** (`getByRole`, `getByLabel`) over text. The injected caption element also contains
  text and can collide with `getByText` — use exact, emoji-prefixed or scoped locators when that happens.

## 3 · Run it

From the project root (where `playwright` is installed or can be installed):

```bash
<skill>/scripts/make-video.sh --scenario demo/scenario.mjs \
  --probe "text only your app renders" --serve "npm run dev"              # web app
# dapp: + --burner 0.03 --rpc <RPC> with FUNDER_PK exported; + --before-take "<reset cmd>" if a take is one-way
```

It takes ~10 min (mostly waits + render), so run it in the background and tell the user. Useful flags:
`--no-render` (stop after the composition check), `--pace 1.2` (shorter pauses), `--attempts N`, `--out DIR`.

**Don't edit the scenario, scripts or any file the run uses while it is running.** Bash and Node read them during
the run, and a mid-run edit corrupts the take. Make changes between runs.

When iterating on the scenario, first do a quick take without rendering to find broken selectors
(`--no-render`, then look at `take/FAIL.png` if it fails).

**One-way flows need a reset.** If a take changes state for good (resolves a market, uses a one-time invite,
consumes a seed record), pass `--before-take` with a command that creates fresh state. Every retry runs it first.
**Fresh accounts** make a clean screen: `--burner` creates a new wallet per take, so old positions don't show.

## 4 · Verify, then hand over

`make-video.sh` saves frames at 2/6/25/50/75/97 % to `<out>/check/`. Read them. You should see the title card,
the problem card (if any), the framed app with the rail highlighting a step and a caption under it, and the outro.
Then `open` the MP4 for the user and report its length, what each part shows, and anything that was retried or is
unverified (e.g. the problem stat).

## Changing the video

| Want | Change | New take? |
|---|---|---|
| Card text, chapters, colours, fonts, outro | `video` export → rerun `compose.mjs`, `check`, `render` only | No |
| Pace | `--pace` | Yes |
| Scenes / order | scenario function | Yes |
| App UI changed | nothing — rerun | Yes |

Re-render from an existing take:
```bash
node <skill>/scripts/compose.mjs --scenario demo/scenario.mjs --take demo-video/take --project demo-video/hyperframes
cd demo-video/hyperframes && npx --yes hyperframes@0.8.78 check && npx --yes hyperframes@0.8.78 render -o ../demo-hyperframes.mp4 --quality high --video-frame-format png -w 4
```

## Troubleshooting

- **HyperFrames `video_nested_in_timed_element`**: the `<video>` must be a direct child of the stage, not inside a timed
  section, or its frames desync. `compose.mjs` does this; keep it that way if you customise the HTML.
- **Wrong app on the port**: another process can hold :3000. Pass `--probe` with text only your app renders, or `--base-url`.
- **Flaky RPC ("could not coalesce", timeouts)**: the injected wallet signs each tx once and rebroadcasts the same
  bytes, so a retry can't duplicate an action. Persistent failures → the take is retried with `--before-take`.
- **Slow async services** (e.g. an FHE decryption network, indexers, webhooks): make the *app* retry, and pass a
  generous `timeout` to `waitFor`. `edit.mjs` caps any wait at `--max` seconds on screen (default 6).
- **Dev overlays** (Next.js badge, Vite error overlay) are hidden automatically; add others via `config.hide`.
