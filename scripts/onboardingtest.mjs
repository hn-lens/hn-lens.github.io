// First-run onboarding test — guards the feature: a brand-new user gets a one-time
// prompt to pick interests, which seed keywordsBoost + For You; picking + "Get
// started" persists and it never shows again. Also guards that it's SUPPRESSED under
// automation by default (so it can't block the rest of the suite) — the harness opts
// in with localStorage 'hn:onboard'='force'.
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:4173/';

const fails = [];
const check = (name, pass, detail = '') => {
  console.log(`  ${pass ? '\u2713' : '\u2717'} ${name}${detail ? ` \u2014 ${detail}` : ''}`);
  if (!pass) fails.push(name);
};

const b = await chromium.launch({ headless: true });
const mockHN = async (page) => {
  await page.route(/hacker-news\.firebaseio\.com/, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.route(/hn\.algolia\.com|google\.com\/s2/, (r) => r.fulfill({ status: 200, body: '{}' }));
};
const dialogShown = (page) => page.evaluate(() => !!document.querySelector('[role="dialog"][aria-label^="Welcome to Hacker Lens"]'));

// ---- Context A: opt in → onboarding shows, applying seeds interests + persists ----
{
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await page.addInitScript(() => localStorage.setItem('hn:onboard', 'force'));
  await mockHN(page);
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__hnlens && window.__hnlens.prefs, null, { timeout: 20000 });
  await page.waitForTimeout(400);
  check('first-run onboarding is shown to a new user', await dialogShown(page));

  await page.getByRole('button', { name: 'Rust', exact: true }).click();
  await page.getByRole('button', { name: 'Python', exact: true }).click();
  await page.getByRole('button', { name: /Start with 2 interests/ }).click();
  await page.waitForTimeout(400);

  const boost = await page.evaluate(() => window.__hnlens.prefs.getState().keywordsBoost);
  const onboarded = await page.evaluate(() => window.__hnlens.prefs.getState().hasOnboarded);
  check('picking interests seeds keywordsBoost', boost.includes('rust') && boost.includes('python'), JSON.stringify(boost));
  check('onboarding marks hasOnboarded = true', onboarded === true);
  check('onboarding dialog closes after finishing', !(await dialogShown(page)));

  // reload — must NOT show again (hasOnboarded persisted)
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__hnlens, null, { timeout: 20000 });
  await page.waitForTimeout(400);
  check('onboarding does NOT show again after completion', !(await dialogShown(page)));
  await ctx.close();
}

// ---- Context B: no opt-in → onboarding is suppressed under automation ----
{
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await mockHN(page);
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__hnlens && window.__hnlens.prefs, null, { timeout: 20000 });
  await page.waitForTimeout(400);
  check('onboarding is suppressed under automation without the opt-in (protects other tests)', !(await dialogShown(page)));
  await ctx.close();
}

// ---- Context C: tiny viewport — exits stay reachable (sticky footer) + Escape dismisses ----
{
  const ctx = await b.newContext({ viewport: { width: 320, height: 440 } }); // short → content overflows the 90vh panel
  const page = await ctx.newPage();
  await page.addInitScript(() => localStorage.setItem('hn:onboard', 'force'));
  await mockHN(page);
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__hnlens && window.__hnlens.prefs, null, { timeout: 20000 });
  await page.waitForTimeout(400);
  check('onboarding shows at a tiny viewport', await dialogShown(page));
  // The Skip exit must be within the viewport without scrolling (sticky footer). Pre-fix it sat at the
  // end of the overflowing content, below the fold.
  const skipInView = await page.evaluate(() => {
    const dlg = document.querySelector('[role="dialog"][aria-label^="Welcome to Hacker Lens"]');
    const skip = [...(dlg?.querySelectorAll('button') ?? [])].find((btn) => /^skip$/i.test(btn.textContent?.trim() ?? ''));
    if (!skip) return { found: false };
    const r = skip.getBoundingClientRect();
    return { found: true, top: Math.round(r.top), bottom: Math.round(r.bottom), vh: window.innerHeight, inView: r.top >= 0 && r.bottom <= window.innerHeight + 1 };
  });
  check('M12: the Skip exit is within the viewport at a tiny height (sticky footer)', skipInView.found && skipInView.inView, JSON.stringify(skipInView));
  // Escape dismisses (Onboarding binds no Escape pre-fix).
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  check('M12: Escape dismisses the onboarding', !(await dialogShown(page)));
  await ctx.close();
}

await b.close();
console.log(`\n${fails.length === 0 ? 'RESULT: ONBOARDING PASS \u2713' : `RESULT: ${fails.length} FAILED`}`);
process.exit(fails.length ? 1 : 0);
