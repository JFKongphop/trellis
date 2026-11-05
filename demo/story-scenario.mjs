// Footage for the story video (demo/make-story.sh), in the style of Sprout's demo: full-screen app shots with
// zooms, cut between narrated text cards. Records the light replay demo (`pnpm demo`) at 1440x810 (16:9).
//
// Markers: caption('@name') marks a shot boundary; focus(loc, 'name') also logs the element's box so the
// composer can zoom into it. Both land in chapters.json on the edited timeline. Captions are never drawn.

// hidden in the footage: the 'waiting' pill (the story cuts around waits) and the bottom 'Demo mode' badge
export const config = { hide: ['#demo-wait', 'div.fixed:has(svg.lucide-flask-conical)'] };

export default async function scenario({ page, goto, caption, click, type, point, scrollTo, scrollY, hold, waitFor }) {
  const focus = async (loc, name, pad = 24) => {
    await loc.scrollIntoViewIfNeeded();
    const b = await loc.boundingBox();
    await caption(`@zoom ${name} ${Math.round(b.x - pad)} ${Math.round(b.y - pad)} ${Math.round(b.width + 2 * pad)} ${Math.round(b.height + 2 * pad)}`);
  };

  // calm market before the take (not used in the video)
  await goto('/vault');
  await waitFor('vault loads', /Health factor/i);
  await page.getByRole('button', { name: /Reset to \$5\.00/ }).click();
  await waitFor('price reset', /Oracle NEAR price:\s*\$5\.00/);

  // ── ask ─────────────────────────────────────────────────────────
  await goto('/');
  await waitFor('landing', page.getByPlaceholder(/what do you want to do/i));
  await caption('@ask');
  await hold(1200);
  await type(page.getByPlaceholder(/what do you want to do/i), 'loop my vault to 1.8x and keep my health factor above 1.5');
  await hold(600);
  await page.keyboard.press('Enter');
  await waitFor('Trellis plans', /Vault plan/, { pill: ' ' });
  await caption('@plan');
  await hold(1200);
  await scrollTo(page.getByText('Rhea Lending', { exact: true }).first(), 160);
  await hold(800);
  await focus(page.locator('.react-flow').first(), 'flow');
  await hold(3600);
  await waitFor('answer', /Click Approve/);
  await caption('@guardian');
  await scrollTo(page.getByText(/Click Approve/), 420);
  await hold(1000);
  await focus(page.locator('[data-guardian]').first(), 'guardian', 12);
  await hold(3400);

  // ── rules ───────────────────────────────────────────────────────
  await goto('/vault/setup?step=rules');
  await waitFor('rules page', /Rules for the agent/);
  await caption('@rules');
  await point(page.getByText('Minimum health factor', { exact: true }));
  await hold(2000);
  await scrollTo(page.getByText('per day').first(), 260);
  await hold(2600);

  // ── vault ───────────────────────────────────────────────────────
  await goto('/vault');
  await waitFor('vault loads', /Agent: Active/);
  await caption('@vault');
  await point(page.getByText('Health factor', { exact: true }).first());
  await hold(2400);
  await scrollTo(page.getByText('Rules', { exact: true }).first(), 160);
  await hold(2200);
  await scrollY(0);

  // ── crash ───────────────────────────────────────────────────────
  await caption('@crash');
  await click(page.getByRole('button', { name: /Crash NEAR to \$1\.75/ }));
  await waitFor('price crash', /Oracle NEAR price:\s*\$1\.75/);
  await focus(page.getByText('Health factor', { exact: true }).first().locator('xpath=..').locator('xpath=..'), 'hf', 60);
  await hold(2600);

  // ── the agent protects it ───────────────────────────────────────
  await caption('@protect');
  await waitFor('agent move 1', /made \d automatic move/, { pill: ' ' });
  await hold(1600);
  await waitFor('agent moves 2 and 3', /made 3 automatic moves/, { pill: ' ' });
  await focus(page.getByText(/While you were away/).first().locator('xpath=..').locator('xpath=..'), 'away', 20);
  await hold(3000);

  // ── money flow ──────────────────────────────────────────────────
  await caption('@money');
  await scrollTo(page.getByRole('button', { name: 'Money flow' }), 140);
  await hold(600);
  await focus(page.locator('.react-flow').first(), 'flow2');
  await hold(3800);

  // ── activity ────────────────────────────────────────────────────
  await caption('@activity');
  await scrollTo(page.getByText('Agent activity', { exact: true }), 120);
  await hold(3400);

  // ── feed ────────────────────────────────────────────────────────
  await scrollY(0);
  await caption('@feed');
  await click(page.getByRole('link', { name: 'Feed' }).first());
  await waitFor('feed', /Agent feed/);
  await hold(1800);
  await click(page.getByRole('button', { name: /Automatic/ }));
  await hold(2800);

  // ── portfolio ───────────────────────────────────────────────────
  await caption('@portfolio');
  await click(page.getByRole('link', { name: 'Portfolio' }).first());
  await waitFor('portfolio', /Total value/);
  await hold(1400);
  await scrollY(380, 2200);
  await hold(2600);
  await caption('@end');
  await hold(500);
}
