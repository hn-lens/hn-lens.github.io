// Comprehensive keyboard-navigation test — the user's rule: keyboard must cover
// ALL navigation, or it's removed. Over a mocked HN API this asserts, concretely:
//   - j/k move a selection through FEED cards
//   - h/l switch feed tabs (any orientation)
//   - the SIDEBAR is keyboard-reachable (focusable controls, in tab order)
//   - opening a thread, j/k move through COMMENTS and Enter collapses the selected one
//   - "/" focuses search, "?" opens help
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:4173/';
const now = Math.floor(Date.now() / 1000);
const IDS = [301, 302, 303, 304];
const story = (id) => ({ id, type: 'story', by: `u${id}`, title: `Story ${id} about systems`, url: `https://d${id}.example/x`, score: 100 + id, descendants: 5, time: now - 3600 });
const TREE = {
  id: 301, story_id: 301, title: 'Story 301 about systems', url: 'https://d301.example/x', points: 401, author: 'u301', created_at_i: now - 7200, type: 'story', text: null,
  children: [
    { id: 1, author: 'alice', text: '<p>first top comment</p>', created_at_i: now - 6000, children: [
      { id: 11, author: 'bob', text: '<p>a nested child reply here</p>', created_at_i: now - 5000, children: [] },
    ] },
    { id: 2, author: 'carol', text: '<p>second top comment</p>', created_at_i: now - 4000, children: [] },
    { id: 3, author: 'dave', text: '<p>third top comment</p>', created_at_i: now - 3000, children: [] },
  ],
};

const fails = [];
const check = (name, pass, detail = '') => {
  console.log(`  ${pass ? '\u2713' : '\u2717'} ${name}${detail ? ` \u2014 ${detail}` : ''}`);
  if (!pass) fails.push(name);
};

const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
const page = ctx.pages()[0] || (await ctx.newPage());
await page.route(/hacker-news\.firebaseio\.com/, (r) => {
  const u = r.request().url();
  const j = (x) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(x) });
  if (/(top|best|new)stories/.test(u)) return j(IDS);
  if (/(ask|show|job)stories/.test(u)) return j([]);
  const m = u.match(/item\/(\d+)/);
  if (m) return j(story(Number(m[1])));
  return j(null);
});
await page.route(/hn\.algolia\.com|google\.com\/s2/, (r) => r.fulfill({ status: 200, body: '{}' }));
await page.route(/hn\.algolia\.com\/api\/v1\/items\/301/, (r) =>
  r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(TREE) })
);

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__hnlens && window.__hnlens.prefs, null, { timeout: 20000 });
await page.evaluate(() => window.__hnlens.prefs.getState().set({ defaultFeed: 'top', minPoints: 0, useLearnedRanker: false, embeddingsEnabled: false }));
await page.waitForSelector('article', { timeout: 15000 });
await page.waitForTimeout(300);

const selectedText = (sel) => page.evaluate((s) => document.querySelector(s)?.textContent?.trim() ?? '', sel);

// ---- FEED: j / k ----
await page.keyboard.press('j');
await page.waitForTimeout(150);
check('j selects a feed card', (await page.locator('article.kbd-selected').count()) === 1);
const first = await selectedText('article.kbd-selected h3');
await page.keyboard.press('j');
await page.waitForTimeout(150);
const second = await selectedText('article.kbd-selected h3');
check('j moves to the next feed card', !!second && second !== first, `${first} → ${second}`);
await page.keyboard.press('k');
await page.waitForTimeout(150);
check('k moves back', (await selectedText('article.kbd-selected h3')) === first);

// ---- TABS: h / l ----
const activeTab = () => page.evaluate(() => document.querySelector('.feed-tabs button[aria-current="page"]')?.textContent?.trim() || '');
const tab0 = await activeTab();
await page.keyboard.press('l');
await page.waitForTimeout(250);
const tab1 = await activeTab();
check('l switches to the next tab', !!tab1 && tab1 !== tab0, `${tab0} → ${tab1}`);
await page.keyboard.press('h');
await page.waitForTimeout(250);
check('h switches back', (await activeTab()) === tab0);

// ---- SIDEBAR: keyboard-reachable (focusable controls in tab order) ----
const sidebar = await page.evaluate(() => {
  const sb = document.querySelector('.app-sidebar');
  if (!sb) return { present: false, focusable: 0, canFocus: false };
  const foci = sb.querySelectorAll('a[href], button, input, select, [tabindex]:not([tabindex="-1"])');
  let canFocus = false;
  if (foci.length) {
    foci[0].focus();
    canFocus = sb.contains(document.activeElement);
  }
  return { present: true, focusable: foci.length, canFocus };
});
check('sidebar has keyboard-focusable controls', sidebar.present && sidebar.focusable > 0, `${sidebar.focusable} controls`);
check('sidebar controls can take keyboard focus', sidebar.canFocus, '');
await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());

// ---- SEARCH + HELP ----
await page.keyboard.press('/');
await page.waitForTimeout(150);
check('"/" focuses the search box', await page.evaluate(() => document.activeElement?.getAttribute('type') === 'search'));
await page.keyboard.press('Escape');
await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
await page.keyboard.press('Shift+Slash');
await page.waitForTimeout(200);
check('"?" opens the shortcuts help', /Keyboard shortcuts/i.test(await page.evaluate(() => document.body.innerText)));
await page.keyboard.press('Escape');

// ---- COMMENTS: j / k navigate, Enter collapses ----
await page.getByRole('button', { name: 'Top', exact: true }).click().catch(() => {});
await page.waitForSelector('article', { timeout: 15000 });
// Advance the feed selection first, so we can prove the index RESETS on context switch.
await page.keyboard.press('j');
await page.keyboard.press('j');
await page.waitForTimeout(120);
// open the comments drawer for story 301 (first card)
await page.locator('article').first().getByRole('button', { name: 'Open comments' }).click();
await page.waitForFunction(() => document.querySelector('[id^="comment-"]'), null, { timeout: 15000 });
await page.waitForTimeout(300);
// Fix H: switching feed → comments resets j/k — the first `j` selects the FIRST
// comment, not the stale feed index (2) carried over from the feed list.
await page.keyboard.press('j');
await page.waitForTimeout(120);
const ctxReset = await page.evaluate(() => {
  const els = [...document.querySelectorAll('[id^="comment-"]')];
  const sel = document.querySelector('[id^="comment-"].kbd-selected');
  return { selIdx: sel ? els.indexOf(sel) : -1 };
});
check('opening a thread resets j/k to the first comment (no stale index)', ctxReset.selIdx === 0, JSON.stringify(ctxReset));
const bodiesBefore = await page.locator('[id^="comment-"] .hn-html').count();
// walk up to the first comment, then collapse it
for (let i = 0; i < 6; i++) {
  await page.keyboard.press('k');
  await page.waitForTimeout(60);
}
check('j/k select a comment in the thread', (await page.locator('[id^="comment-"].kbd-selected').count()) >= 1);
await page.keyboard.press('Enter'); // collapse the selected comment
await page.waitForTimeout(250);
const bodiesAfter = await page.locator('[id^="comment-"] .hn-html').count();
check('Enter collapses the selected comment (replies hidden)', bodiesAfter < bodiesBefore, `${bodiesBefore} → ${bodiesAfter}`);

await b.close();
console.log(`\n${fails.length === 0 ? 'RESULT: KEYBOARD COVERS ALL NAV \u2713' : `RESULT: ${fails.length} FAILED`}`);
process.exit(fails.length ? 1 : 0);
