// Example scenario: a plain web app (no wallet). A note-sharing SaaS — sign up, create a note, share it.
// Put your own version at demo/scenario.mjs in the project and run:
//   <repo>/.claude/skills/hyperframes-app-demo/scripts/make-video.sh --scenario demo/scenario.mjs \
//     --probe "Notely" --serve "npm run dev" --before-take "npm run db:reset"

export const config = {
  hide: ['.cookie-banner'], // anything that shouldn't appear in the video
};

export const video = {
  brand: { name: 'NOTELY', mark: 'N', accent: '#FFD84D', accent2: '#7CF3C5', alert: '#FF5A5F' },
  intro: { title: 'Notes your team actually reads.', highlight: 'Shared in one click.', chips: ['Markdown', 'Real-time', 'Free tier'] },
  // no `problem` → no problem card
  footage: { startAt: /^<b>1 ·/, pill: '● REAL APP · NO MOCKUPS' },
  // no `chapters` → one chapter per caption, labelled from the caption text
  outro: {
    items: [{ k: 'WRITE', v: 'Markdown' }, { k: 'SHARE', v: 'One link' }, { k: 'TRACK', v: 'Read receipts' }],
    tagline: 'notely.app · try it free',
  },
};

export default async function scenario({ page, goto, caption, click, type, point, scrollTo, hold, waitFor, env }) {
  await goto('/');
  await caption('<b>1 ·</b> Sign up with just an email');
  await click(page.getByRole('link', { name: 'Get started' }));
  await type(page.getByLabel('Email'), 'demo@notely.app');
  await click(page.getByRole('button', { name: 'Create account' }));
  await waitFor('sign up', /Welcome/, { error: /Something went wrong/ }); // slow → sped up in the edit
  await hold(2500);

  await caption('<b>2 ·</b> Write in Markdown — it renders as you type');
  await click(page.getByRole('button', { name: 'New note' }));
  await type(page.getByPlaceholder('Title'), 'Launch checklist');
  await type(page.getByRole('textbox', { name: 'Body' }), '- [x] Record demo\n- [ ] Ship it');
  await point(page.getByTestId('preview'));
  await hold(3000);

  await caption('<b>3 ·</b> Share with one link — see who read it');
  await click(page.getByRole('button', { name: 'Share' }));
  await waitFor('create link', /Link copied/);
  await scrollTo(page.getByText('Read receipts'), 200);
  await hold(3500);
}
