// Contingent demo scenario for the `hyperframes-app-demo` skill.
// Run from contingent/frontend (it has playwright + ethers):
//   FUNDER_PK=0x… <repo>/.claude/skills/hyperframes-app-demo/scripts/make-video.sh \
//     --scenario ../demo-video/scenario.mjs --out ../demo-video/hf --probe "CONNECT WALLET" --probe-path /app \
//     --serve "npm run dev" --before-take "cd .. && ./script/new-event-round.sh auto" \
//     --burner 0.03 --rpc https://sepolia-rollup.arbitrum.io/rpc

const HEDGE = '0x670b2dC8EEa68Cb6BA2caC4021FCE02b85C51Dcf';

export const config = {
  wallet: { rpc: 'https://sepolia-rollup.arbitrum.io/rpc', chainId: 421614, privateKeyEnv: 'WALLET_PK' },
  logConsole: /^\[(cofhe|demo)\]/, // surface the app's FHE decrypt retries in the take log
};

export const video = {
  brand: { name: 'CONTINGENT', mark: 'C', accent: '#00E5FF', accent2: '#00F076', alert: '#FF3366' },
  intro: {
    title: 'Leverage with a capped crash.',
    highlight: 'Fully Encrypted.',
    chips: ['ETH-PERP 1–10x', 'Prediction-market protection', 'Fhenix FHE', { text: '● Live · Arbitrum Sepolia', live: true }],
  },
  problem: {
    eyebrow: 'THE PROBLEM',
    seconds: 12.5, // long enough to read every line (and to voice it)
    stat: '$19B+',
    note: 'liquidated in a single day · 10 Oct 2025',
    lines: [
      'On-chain perps publish every size, side and liquidation price — cascades and stop-hunts feed on them.',
      'Contingent <b>encrypts</b> the position and <b>caps the crash</b> with a prediction market.',
    ],
  },
  explainer: [
    { kind: 'odds', seconds: 8, title: 'A prediction market prices “will it happen?”', event: 'ETH ≥ $2,500 at expiry', yes: 65,
      note: '<b>NO</b> pays out if ETH ends below $2,500 — the market prices it at 35%.' },
    { kind: 'bars', seconds: 9, title: 'A leveraged long loses everything in a crash',
      bars: [{ label: 'LONG ETH 5x', sub: '100 USDG collateral', value: -100 }],
      note: 'ETH crashes to $2,150 → the position is liquidated → <b>−100</b>.' },
    { kind: 'bars', seconds: 9, title: 'Add protection: buy NO for 35',
      bars: [{ label: 'Perp', sub: 'liquidated', value: -100 }, { label: 'NO cover 100', sub: 'premium 35 · pays 100', value: 65 }],
      note: 'Same crash, ETH ends below $2,500 → NO pays <b>100</b> (net +65).' },
    { kind: 'bars', seconds: 8, title: 'The crash is capped',
      bars: [{ label: 'Perp', value: -100, dim: true }, { label: 'NO', value: 65, dim: true }, { label: 'Protected', sub: 'perp + NO', value: -35, highlight: true }],
      note: 'You pay a <b>known premium</b> instead of losing everything — opened in one transaction.' },
    { kind: 'redacted', seconds: 7, title: 'And nobody can see it',
      rows: ['Collateral', 'Position size', 'Long / short', 'Liquidation price', 'Protection side', 'Cover'],
      note: 'Encrypted with <b>Fhenix FHE</b> — the protection side is picked on the ciphertext, so it can’t leak your direction.', noteAt: 3 },
  ],
  footage: { startAt: /ETH-PERP/, endAt: /Uniswap v4 prices it/, pill: '● LIVE ON ARBITRUM SEPOLIA · REAL TXS · SPED-UP WAITS' },
  chapters: [
    { match: /ETH-PERP/, label: 'ETH-PERP overview' },
    { match: /^<b>1 ·/, label: 'Encrypted collateral' },
    { match: /^<b>2 ·/, label: 'You vs. the chain' },
    { match: /^<b>3 ·/, label: 'Protected long · 1 tx' },
    { match: /^<b>4 ·/, label: 'Redacted position' },
    { match: /^<b>5 ·/, label: 'Close both' },
    { match: /^<b>6 ·/, label: 'Prediction market' },
    { match: /^<b>7 ·/, label: 'Encrypted hedge' },
    { match: /^<b>8 ·/, label: 'Resolve & settle' },
    { match: /^<b>9 ·/, label: 'Premiums → LPs' },
  ],
  outro: {
    items: [{ k: 'PRICES IT', v: 'Prediction market' }, { k: 'HIDES IT', v: 'Fhenix FHE' }, { k: 'SETTLES IT', v: 'USDG' }],
    tagline: 'Live & source-verified on Arbitrum Sepolia',
  },
};

export default async function scenario({ page, wallet, goto, caption, click, type, point, scrollTo, scrollY, hold, waitFor }) {
  const err = page.locator('div.font-mono', { hasText: '✕' }).first(); // the app's error status line
  const chain = (label, ok) => waitFor(label, ok, { error: err, pill: '⏳ on-chain · sped up' });
  const tab = (name) => page.getByRole('button', { name, exact: true });

  await goto('/');
  await caption('<b>Contingent</b> — leveraged perps with a capped crash, fully encrypted · live on Arbitrum Sepolia');
  await hold(3500);
  await click(page.getByRole('link', { name: /LAUNCH APP/ }).first());
  await page.waitForURL('**/app'); await page.waitForLoadState('networkidle');
  await caption(null); await hold(1200);
  await click(page.getByRole('button', { name: /CONNECT WALLET/ }));
  await page.getByText(wallet.address.slice(0, 6)).first().waitFor({ timeout: 30_000 });

  await caption('<b>ETH-PERP</b> · live Chainlink price · 1–10x leverage · the house pool is the counterparty');
  await point(page.getByText('MARK PRICE', { exact: false }).first()); await hold(1800);
  await point(page.getByText('size & side hidden').first()); await hold(2200);

  await scrollTo(page.getByText('Open an encrypted position'), 20, 2000);
  await caption('<b>1 ·</b> Wrap USDG and deposit it as <b>encrypted</b> collateral');
  const fund = page.getByRole('button', { name: 'MINT + WRAP' });
  await type(fund.locator('xpath=preceding-sibling::input'), '1000');
  await click(fund); await chain('mint + wrap', /Wrapped/); await hold(1200);
  const dep = page.getByRole('button', { name: 'DEPOSIT', exact: true });
  await type(dep.locator('xpath=preceding-sibling::input'), '600');
  await click(dep); await chain('encrypted deposit', /Deposited/); await hold(1500);
  await caption('<b>2 ·</b> Only <b>you</b> can decrypt your balance — everyone else sees a ciphertext handle');
  await click(page.getByRole('button', { name: /REVEAL/ }).first()); await chain('private reveal', /USDG free to trade/);
  await point(page.getByText('🌐 Everyone else')); await hold(3200);

  await caption('<b>3 ·</b> Long ETH 5x <b>+ protection</b> from the prediction market — worst case −100 → −35');
  await point(page.getByText('Protect with the event market')); await hold(2200);
  await point(page.getByText(/Liquidated & ETH below strike/)); await hold(2600);
  await click(page.getByRole('button', { name: /OPEN PROTECTED LONG 5X/i }));
  await caption('<b>3 ·</b> Perp + NO hedge opened in <b>one transaction</b> — side picked on the ciphertext');
  await chain('open protected long', /Opened PROTECTED/); await hold(2500);

  const pos = page.locator('div.neo-card').filter({ hasText: 'Your positions' }).last();
  await scrollTo(pos, 260);
  await caption('<b>4 ·</b> On-chain your position is <b>redacted</b> — size, side, liquidation price');
  await point(pos.getByText(/est\. PnL/).first()); await hold(2600);
  await click(pos.getByRole('button', { name: /REVEAL/ }).first()); await chain('reveal position', /HIDE/);
  await caption('<b>4 ·</b> Decrypted in your browser with a signed permit — nobody else can'); await hold(3200);
  await caption('<b>5 ·</b> Close the perp <b>and</b> its protection in one click');
  await click(pos.getByRole('button', { name: 'CLOSE BOTH' }).first()); await chain('close both', /Closed #/); await hold(3000);

  await scrollY(0); await click(tab('MARKET'));
  await caption('<b>6 ·</b> The prediction market is <b>public</b> — it prices every hedge. Positions stay private.'); await hold(2800);
  const stakeNo = page.getByRole('button', { name: /STAKE NO/ });
  await scrollTo(stakeNo, 520); await click(stakeNo); await chain('stake', /Staked/);
  await point(page.getByText('Prices your hedge')); await hold(3000);

  await scrollY(0); await click(tab('HEDGE'));
  await caption('<b>7 ·</b> Or hedge the event directly — an encrypted binary derivative');
  await scrollTo(page.getByText('Open an encrypted event derivative'), 20);
  await point(page.getByText(/Binary derivative · payoff/)); await hold(2600);
  await click(page.getByRole('button', { name: /OPEN ENCRYPTED HEDGE/ })); await chain('open hedge', /Opened encrypted/); await hold(1500);
  // the settle step needs the new hedge's id — read it from the HedgeOpened log of the tx we just sent
  const last = [...wallet.sent].reverse().find((t) => t.to === HEDGE.toLowerCase());
  let rc = null; for (let i = 0; i < 20 && !rc; i++) { rc = await wallet.rpc.getTransactionReceipt(last.hash).catch(() => null); if (!rc) await hold(700); }
  const hedgeId = String(BigInt(rc.logs.find((l) => l.address.toLowerCase() === HEDGE.toLowerCase() && l.topics.length === 4).topics[1]));

  await scrollY(0); await click(tab('SETTLE'));
  await caption('<b>8 ·</b> Chainlink resolves the event — only the <b>winning payout</b> is ever decrypted'); await hold(1500);
  await click(page.getByRole('button', { name: /RESOLVE EVENT/ })); await chain('resolve', /Resolved · outcome/);
  await type(page.locator('input').first(), hedgeId);
  await click(page.getByRole('button', { name: /SETTLE POSITION/ })); await chain('settle', /Paid .* USDG to the winner|payout 0/); await hold(3000);
  await caption('<b>9 ·</b> Premiums go to the LPs — only the <b>aggregate</b> is revealed');
  await click(page.getByRole('button', { name: /SWEEP PREMIUMS/ })); await chain('sweep', /Swept/); await hold(3000);
  await caption('<b>Contingent</b> · Uniswap v4 prices it · Fhenix hides it · live &amp; verified on Arbitrum Sepolia'); await hold(4500);
}
