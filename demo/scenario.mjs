// Trellis demo video (hyperframes-app-demo skill). Records the light replay demo (`pnpm demo`).
// Run from the repo root, with the replay demo already on :3000:
//   node .claude/skills/hyperframes-app-demo/scripts/record.mjs --scenario demo/scenario.mjs --base-url http://localhost:3000 --out demo-video/take
// Memory: one browser for the take, and render with `-w 1` (one Chrome), never more.

export const config = {
  hide: [],
};

const TRELLIS_SVG =
  '<svg viewBox="0 0 24 24" width="40" height="40" fill="none"><path d="M4 20 20 4M4 12l8-8M12 20l8-8M4 4l16 16M4 12l8 8M12 4l8 8" stroke="#ffffff" stroke-width="2.4" stroke-linecap="round"/></svg>';

export const video = {
  theme: 'soft', // only for its white-label overlay on the active chapter; everything visible is restyled by `css` below
  brand: {
    name: 'trellis',
    mark: 'T',
    markSvg: TRELLIS_SVG,
    accent: '#ee7b3d',
    accent2: '#b04fc7',
    alert: '#ee7b3d',
    ink: '#111111',
    bg: '#f6f5f3',
    fontDisplay: 'Labil Grotesk', // the app's font (web/src/app/Variable.woff2), bundled into the video project
    fontMono: 'Sometype Mono',
  },
  intro: {
    title: 'Set the rules.',
    highlight: 'Trellis grows it on NEAR.',
    chips: ['Rhea Lending', 'Ref DEX', 'NEAR Intents', { text: 'Policy vault', live: true }],
    seconds: 6.5,
  },
  problem: {
    eyebrow: 'THE PROBLEM',
    stat: '−65%',
    note: 'NEAR $5.00 → $1.75 in this demo · a 1.25x position: health factor 3.56 → 1.25',
    lines: [
      'A leveraged position can be liquidated <b>while you sleep</b>.',
      'Trellis lets an AI agent protect it, and a <b>vault contract</b> decides what the agent may do.',
    ],
    seconds: 7.5,
  },
  footage: { startAt: /^<b>1 ·/, pill: '● Real app · recorded sandbox run' },
  chapters: [
    { match: /^<b>1 ·/, label: 'Ask Trellis' },
    { match: /^<b>2 ·/, label: 'Set the rules' },
    { match: /^<b>3 ·/, label: 'Your vault' },
    { match: /^<b>4 ·/, label: 'NEAR crashes' },
    { match: /^<b>5 ·/, label: 'The agent protects it' },
    { match: /^<b>6 ·/, label: 'Money flow' },
    { match: /^<b>7 ·/, label: 'Every move on record' },
    { match: /^<b>8 ·/, label: 'The feed' },
  ],
  railTitle: "What you'll see",
  outro: {
    items: [
      { k: 'BUILT ON', v: 'NEAR · Rhea · Ref' },
      { k: 'ENFORCED BY', v: 'Rust vault contract' },
      { k: 'TRY IT', v: 'pnpm demo' },
    ],
    tagline: 'github.com/JFKongphop/trellis',
    seconds: 8,
  },
  // Trellis's own look (web/src/app/globals.css): warm canvas with orange/violet/pink glows, white cards with
  // hairline + soft shadow, ink #111 for dark fills, orange → purple brand gradient, Labil Grotesk + wordmark font.
  css: `
      @font-face { font-family: 'Labil Grotesk'; src: url('assets/LabilGrotesk.woff2') format('woff2'); font-weight: 100 800; }
      @font-face { font-family: 'Trellis Wordmark'; src: url('assets/TrellisWordmark.ttf') format('truetype'); }
      #root { background-color: #f6f5f3 !important; background-size: auto !important; background-image:
          radial-gradient(900px 620px at 6% 96%, rgba(249,115,22,.17), transparent 70%),
          radial-gradient(860px 600px at 94% 4%, rgba(139,111,199,.20), transparent 70%),
          radial-gradient(760px 520px at 62% 104%, rgba(236,72,153,.10), transparent 70%) !important; }
      .box, .stack { border: 0 !important; border-radius: 16px !important; background: #fff;
          box-shadow: 0 0 0 1px rgba(17,17,17,.05), 0 1px 2px rgba(17,17,17,.04), 0 22px 44px -24px rgba(17,17,17,.24) !important; }
      .logo .c { background: #111 !important; border: 0 !important; border-radius: 14px !important; box-shadow: 0 10px 24px -12px rgba(17,17,17,.5) !important; }
      .logo .w { font-family: 'Trellis Wordmark', 'Labil Grotesk', sans-serif !important; font-weight: 600 !important; text-transform: lowercase; letter-spacing: -.01em !important; }
      #intro h1 { font-weight: 500 !important; font-size: 132px !important; line-height: 1 !important; letter-spacing: -.035em !important; }
      #t2 span { background: linear-gradient(100deg, #d9622a 0%, #ee7b3d 32%, #c46ad8 72%, #b04fc7 100%) !important;
          -webkit-background-clip: text !important; background-clip: text !important; color: transparent !important;
          border: 0 !important; box-shadow: none !important; border-radius: 0 !important; padding: 0 0 20px !important; margin-top: 8px !important; }
      .chip { background: #111 !important; color: #fff !important; border: 0 !important; border-radius: 999px !important; box-shadow: none !important;
          font: 500 22px 'Labil Grotesk', sans-serif !important; padding: 12px 22px !important; }
      .chip.live { background: linear-gradient(100deg, #ee7b3d, #b04fc7) !important; color: #fff !important; }
      #p-eyebrow { color: #ee7b3d !important; font-family: 'Sometype Mono', monospace !important; }
      #p-num { font-weight: 500 !important; letter-spacing: -.045em !important; background: linear-gradient(100deg, #d9622a, #ee7b3d 45%, #b04fc7) !important;
          -webkit-background-clip: text !important; background-clip: text !important; color: transparent !important; }
      #p-sub { color: #6d6c6b !important; font-family: 'Sometype Mono', monospace !important; font-size: 28px !important; }
      .pl { font-weight: 500 !important; }
      .pl b { background: none !important; border: 0 !important; padding: 0 !important; border-radius: 0 !important; color: #b04fc7 !important; font-weight: 600 !important; }
      .pill { background: #fff !important; color: #111 !important; border: 0 !important; border-radius: 999px !important;
          box-shadow: 0 0 0 1px rgba(17,17,17,.06), 0 6px 16px -10px rgba(17,17,17,.3) !important; font: 500 18px 'Labil Grotesk', sans-serif !important; }
      #barwrap { background: #ecebea !important; border: 0 !important; border-radius: 999px !important; }
      #bar { background: linear-gradient(90deg, #ee7b3d, #b04fc7) !important; }
      .cap { color: #111 !important; font-weight: 500 !important; }
      #rail h3 { color: #6d6c6b !important; font-family: 'Sometype Mono', monospace !important; }
      #rail h2 { font-weight: 500 !important; letter-spacing: -.02em !important; }
      #hl { background: #111 !important; border: 0 !important; border-radius: 12px !important; box-shadow: 0 12px 26px -14px rgba(17,17,17,.55) !important; }
      .row .lbl { font-weight: 500 !important; }
      .row .n { color: #6d6c6b !important; font-family: 'Sometype Mono', monospace !important; }
      #rail .row.on .lbl { color: #fff !important; } #rail .row.on .n { color: #b8b6b3 !important; }
      .row .tick { color: #47d096 !important; }
      .stack .k { font-family: 'Sometype Mono', monospace !important; }
      .stack .v { font-weight: 600 !important; letter-spacing: -.01em; }
      .stack.s0 { background: #fff !important; color: #111 !important; }
      .stack.s1 { background: #111 !important; color: #fff !important; } .stack.s1 .k { color: #b8b6b3 !important; }
      .stack.s2 { background: linear-gradient(100deg, #ee7b3d, #b04fc7) !important; color: #fff !important; } .stack.s2 .k { color: rgba(255,255,255,.85) !important; }
      #o-live { font-family: 'Sometype Mono', monospace !important; color: #6d6c6b !important; }
      /* no subtitles under the footage (captions still drive the chapter rail) */
      .cap { display: none !important; }
  `,
  hyperframesVersion: '0.8.78',
};

export default async function scenario({ page, goto, caption, click, type, point, scrollTo, scrollY, hold, waitFor }) {
  // start from a calm market (the replay keeps its state between takes); not part of the footage
  await goto('/vault');
  await waitFor('vault loads', /Health factor/i);
  await page.getByRole('button', { name: /Reset to \$5\.00/ }).click();
  await waitFor('price reset', /Oracle NEAR price:\s*\$5\.00/);

  // 1 · landing + chat: ask, watch Trellis answer with a vault plan (money flow + Guardian)
  await goto('/');
  await waitFor('landing', page.getByPlaceholder(/what do you want to do/i));
  await caption('<b>1 ·</b> Ask in plain English: Trellis answers with a vault plan, its money flow and every risk');
  await hold(1400);
  await type(page.getByPlaceholder(/what do you want to do/i), 'loop my vault to 1.8x and keep my health factor above 1.5');
  await hold(700);
  await page.keyboard.press('Enter');
  await waitFor('Trellis plans', /Vault plan/, { pill: '⏳ Trellis is planning · sped up' });
  await hold(1600);
  await scrollTo(page.getByText('Rhea Lending', { exact: true }).first(), 220);
  await hold(3200);
  await waitFor('answer', /Click Approve/);
  await scrollTo(page.getByText(/Click Approve/), 380);
  await hold(3000);

  // 2 · rules
  await goto('/vault/setup?step=rules');
  await waitFor('rules page', /Rules for the agent/);
  await caption('<b>2 ·</b> Set the rules once: tokens, pools, limits per action and per day, the lowest health factor allowed');
  await point(page.getByText('Minimum health factor', { exact: true }));
  await hold(2200);
  await scrollTo(page.getByText('per day').first(), 260);
  await hold(2600);

  // 3 · vault
  await goto('/vault');
  await waitFor('vault loads', /Agent: Active/);
  await caption('<b>3 ·</b> Your vault holds a leveraged wNEAR position on Rhea Lending, and the Trellis agent watches it');
  await point(page.getByText('Health factor', { exact: true }).first());
  await hold(2600);
  await scrollTo(page.getByText('Rules', { exact: true }).first(), 160);
  await hold(2600);
  await scrollY(0);

  // 4 · crash
  await caption('<b>4 ·</b> NEAR crashes from $5.00 to $1.75. The health factor falls below your 1.3 trigger');
  await click(page.getByRole('button', { name: /Crash NEAR to \$1\.75/ }));
  await waitFor('price crash', /Oracle NEAR price:\s*\$1\.75/);
  await point(page.getByText('Health factor', { exact: true }).first());
  await hold(2600);

  // 5 · agent moves
  await caption('<b>5 ·</b> The agent acts on its own: withdraw collateral, swap on Ref, repay. No signature from you');
  await waitFor('agent move 1', /made \d automatic move/, { pill: '⏳ agent working · sped up' });
  await hold(1800);
  await waitFor('agent moves 2 and 3', /made 3 automatic moves/, { pill: '⏳ agent working · sped up' });
  await point(page.getByText(/While you were away/));
  await hold(3000);

  // 6 · money flow
  await caption('<b>6 ·</b> Money flow: Rhea → Ref → Rhea. Health factor 1.25 → 2.14, every step inside your rules');
  await scrollTo(page.getByRole('button', { name: 'Money flow' }), 140);
  await point(page.getByText('Rhea Lending', { exact: true }).first());
  await hold(3600);

  // 7 · activity
  await caption('<b>7 ·</b> Every move is an on-chain receipt, tagged automatic, with the agent\'s reason');
  await scrollTo(page.getByText('Agent activity', { exact: true }), 120);
  await hold(3600);

  // 8 · feed
  await scrollY(0);
  await caption('<b>8 ·</b> The Feed shows every agent move across all vaults');
  await click(page.getByRole('link', { name: 'Feed' }).first());
  await waitFor('feed', /Agent feed/);
  await hold(2200);
  await click(page.getByRole('button', { name: /Automatic/ }));
  await hold(3200);
}
