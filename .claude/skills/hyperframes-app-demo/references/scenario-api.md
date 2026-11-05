# Scenario API

A scenario is an ES module in the target project (e.g. `demo/scenario.mjs`). It doesn't import anything. Every
helper arrives as an argument to its default export.

## `export default async function (h)`

| Helper | What it does |
|---|---|
| `page` | the Playwright `Page` (full API for anything not covered below) |
| `goto(path = '/')` | navigate relative to the base URL and wait for `networkidle` |
| `caption(html \| null)` | show a caption (drawn only if `CAPTIONS≠0`) and **log it** (always) for HyperFrames. `null` hides it. Allowed HTML: `<b>`, `&amp;` |
| `point(locatorOrText)` | scroll into view and glide the visible cursor to it |
| `click(locatorOrText)` | point, ripple, click |
| `type(locatorOrText, text)` | click, clear, type character by character |
| `scrollTo(locatorOrText, offset = 120, ms = 1600)` | eased scroll so the element sits `offset` px from the top |
| `scrollY(y, ms = 1600)` | eased scroll to an absolute y (`scrollY(0)` = back to top) |
| `hold(ms)` | pause, multiplied by `PACE` (default 1.4) |
| `waitFor(label, ok, { error, timeout = 240000, pill })` | wait for `ok` (text, RegExp or locator). Fail fast if `error` (text, RegExp or locator) appears. The stretch is logged and sped up in the edit. `pill` changes the on-screen "⏳ waiting · sped up" label |
| `wallet` | when `config.wallet` is set: `{ address, sent: [{to, hash}], rpc, ethers }` (read receipts, compute ids) |
| `env`, `base` | `process.env`, the base URL |

A string passed where a locator is expected means `page.getByText(str).first()`.

## `export const config`

```js
{
  wallet: { rpc: 'https://<testnet-rpc>', chainId: <chainId>, privateKeyEnv: 'WALLET_PK' }, // optional: inject window.ethereum
  hide: ['.cookie-banner', '#intercom-container'],   // optional: CSS selectors to hide
  logConsole: /^\[(demo|myapp)\]/,                   // optional: browser console lines to echo into the take log
  overlay: 'soft',                                    // optional: calm style for the recorded cursor ripple / wait pill
}
```

The injected wallet answers `eth_requestAccounts`, `eth_chainId`, `eth_sendTransaction` (sign once, rebroadcast),
`personal_sign` and `eth_signTypedData_v4`, and forwards every other call to `rpc`. It looks like MetaMask
(`isMetaMask: true`) and never shows popups. Tell the user the video has no wallet popups. If they want one on
screen, they can record a short real-MetaMask clip to splice in.

## `export const video` (all optional except what you want shown)

```js
{
  brand:   { name: 'ACME', mark: 'A', accent: '#00E5FF', accent2: '#00F076', alert: '#FF3366',
             ink: '#111', bg: '#f1f1f1', fontDisplay: 'Space Grotesk', fontMono: 'JetBrains Mono' },  // Google Fonts names
  intro:   { title: 'One-line promise.', highlight: 'Punchline.', chips: ['Feature', { text: '● Live', live: true }], seconds: 6.5 },
  problem: { eyebrow: 'THE PROBLEM', stat: '6 hrs', note: 'what the stat means · source/date',
             lines: ['Why it hurts.', 'How we fix it — <b>highlight</b> words.'], seconds: 7.5 },   // omit for no problem card
  explainer: [                                                 // optional "how it works" slides between problem and footage
    { kind: 'odds', title: '…', event: 'Will X happen?', yes: 65, note: '…' },                    // YES/NO split bar
    { kind: 'bars', title: '…', bars: [{ label, sub?, value, dim?, highlight? }, …], note: '…' },  // animated P&L bars (±)
    { kind: 'redacted', title: '…', rows: ['Field', …], note: '…', noteAt: 3 },                   // hidden-fields panel
    { kind: 'text', title: '…', note: '…' },                                                       // title + note only
  ],                                                            // each slide: seconds (default 8), eyebrow, note HTML allows <b>
  footage: { startAt: /first caption to show/, endAt: /caption where the outro takes over/, pill: '● LIVE · REAL DATA' },
  chapters: [{ match: /^<b>1 ·/, label: 'Short label' }, …],  // omit → one chapter per caption (label = caption text)
  captionStrip: /^<b>\d+ ·<\/b>\s*/,                           // removed from lower-thirds (default shown)
  railTitle: "What you'll see",
  outro:   { items: [{ k: 'BUILT ON', v: 'Next.js' }, …3 max], tagline: 'yourapp.com · try it free', seconds: 8 },
  theme: 'soft',                                              // optional: 'bold' (default, neo-brutalist) or 'soft' (luxury white)
  fontLinks: ['https://fonts.googleapis.com/css2?family=Archivo+Black&display=swap'], // optional: extra stylesheets (fonts)
  css: `#intro h1 { font-family: 'Archivo Black'; }`,          // optional: CSS appended last — the project's own look
                                                              //   (brand.markSvg: inline SVG to use as the logo mark)
  hyperframesVersion: '0.8.78',
}
```

Layout (fixed, 1920×1080): intro, then problem, then explainer slides, then footage in a 1392×870 frame (16:10, so record at 1440×900)
with a 396 px chapter rail, a progress bar and a centred lower-third, then the outro. Up to ~10 chapters fit
comfortably. Beyond that, rows shrink.

Footage starts 1.4 s before the `startAt` caption, so the landing page can be skipped when the intro card replaces it.

## Examples

- `example-webapp-scenario.mjs`: a plain web app (sign-up, create an item, share it). No wallet, no problem card.
- `example-dapp-scenario.mjs`: a real DeFi dapp. It has an injected wallet, on-chain waits with an error locator,
  numbered captions matched into chapters, and reads a tx receipt mid-flow to get an id for a later step.
