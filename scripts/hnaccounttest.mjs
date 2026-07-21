// Hermetic test for the HN-account sidebar (mocked user + Algolia). Covers the
// data-derived displays: profile stats, "You post most from",
// "Recent posts", the invalid-username error, and — the Recently-read bug class —
// the dual-purpose `countHnImport()` value that drives BOTH the button label
// (Use my history ⇄ Re-import…) AND the "N … personalizing your feed" line.
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:4173/';
const now = Math.floor(Date.now() / 1000);
const USER = 'testuser';
const STORY_HITS = [
  { objectID: '501', title: 'My post about Rust internals', url: 'https://rust-lang.org/a', author: USER, points: 120, num_comments: 30, created_at_i: now - 8000 },
  { objectID: '502', title: 'A second Rust post', url: 'https://rust-lang.org/b', author: USER, points: 80, num_comments: 10, created_at_i: now - 9000 },
];
const COMMENT_HITS = [
  { objectID: '999', story_id: 601, story_title: "Someone else's big thread", story_url: 'https://example.com/z', author: USER, created_at_i: now - 7000 },
];

const fails = [];
const check = (name, pass, detail = '') => {
  console.log(`  ${pass ? '\u2713' : '\u2717'} ${name}${detail ? ` \u2014 ${detail}` : ''}`);
  if (!pass) fails.push(name);
};

const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ viewport: { width: 1280, height: 1000 } });
const page = ctx.pages()[0] || (await ctx.newPage());
await page.route(/hacker-news\.firebaseio\.com/, (r) => {
  const u = r.request().url();
  const j = (x) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(x) });
  if (/\/user\/testuser/.test(u)) return j({ id: USER, karma: 4200, created: now - 99999999 });
  if (/stories/.test(u)) return j([]);
  return j(null);
});
await page.route(/hn\.algolia\.com/, (r) => {
  const u = r.request().url();
  const isComment = /comment/.test(u);
  const hits = isComment ? COMMENT_HITS : STORY_HITS;
  const nbHits = isComment ? 37 : 2; // commentCount comes from nbHits
  return r.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ hits, nbHits, page: 0, nbPages: 1, hitsPerPage: hits.length }),
  });
});
await page.route(/google\.com\/s2/, (r) => r.fulfill({ status: 200, body: '' }));

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__hnlens && window.__hnlens.prefs, null, { timeout: 20000 });
await page.evaluate(() => window.__hnlens.prefs.getState().set({ defaultFeed: 'foryou', minPoints: 0, hnUsername: '' }));
await page.waitForTimeout(400);

const sidebarText = () => page.evaluate(() => document.querySelector('.app-sidebar')?.innerText ?? '');

// ---- invalid username shows an error, does NOT connect ----
await page.getByPlaceholder('HN username').fill('!!');
await page.getByRole('button', { name: 'Connect' }).click();
await page.waitForTimeout(200);
check('invalid username shows an error', /Invalid HN username/i.test(await sidebarText()));

// ---- connect a valid user → profile stats render ----
await page.getByPlaceholder('HN username').fill(USER);
await page.getByRole('button', { name: 'Connect' }).click();
await page.waitForFunction(() => /karma/i.test(document.querySelector('.app-sidebar')?.innerText ?? ''), null, { timeout: 15000 });
const stats = await sidebarText();
check('shows karma', /4,200/.test(stats), '');
check('shows post count', /\b2\b/.test(stats) && /posts/i.test(stats), '');
check('shows comment count (from nbHits)', /\b37\b/.test(stats), '');
check('shows "You post most from" domain', /rust-lang\.org/.test(stats), '');
check('shows a "Recent posts" title', /Rust internals/.test(stats), '');

// ---- before import: button invites import, no "personalizing" line ----
check('button reads "Use my history" before import', (await page.getByRole('button', { name: /Use my history/i }).count()) > 0, '');
check('no "personalizing your feed" line yet', !/personalizing your feed/i.test(stats), '');

// ---- import → message + button flips to Re-import ----
await page.getByRole('button', { name: /Use my history/i }).click();
await page.waitForFunction(() => /Imported \d+ posts/i.test(document.querySelector('.app-sidebar')?.innerText ?? ''), null, { timeout: 15000 });
const afterImport = await sidebarText();
check('import reports what it imported', /Imported 2 posts \+ 1 discussions/i.test(afterImport), '');
check('button flips to "Re-import…"', (await page.getByRole('button', { name: /Re-import/i }).count()) > 0, '');

// ---- reload → the persistent "N … personalizing your feed" line (countHnImport) ----
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => /personalizing your feed/i.test(document.querySelector('.app-sidebar')?.innerText ?? ''), null, { timeout: 15000 });
const reloaded = await sidebarText();
// 2 posts (open_link) + 1 discussion (open_comments) = 3 hn_import signals
check('persistent line shows the import count (3)', /\b3\b of your posts & discussions are personalizing/i.test(reloaded), reloaded.match(/\d+ of your posts/i)?.[0] ?? '');
check('button still "Re-import…" after reload', (await page.getByRole('button', { name: /Re-import/i }).count()) > 0, '');

await b.close();
console.log(`\n${fails.length === 0 ? 'RESULT: HN ACCOUNT DISPLAYS PASS \u2713' : `RESULT: ${fails.length} FAILED`}`);
process.exit(fails.length ? 1 : 0);
