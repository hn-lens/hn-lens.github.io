// Discussion-view surface tests — two behaviours the rest of the suite drove only
// on the /item permalink (never through the FEED → drawer path a real user takes):
//
//   [A] The "Show AI summary controls in comments" setting (showAiSummaries) must
//       actually GATE the AI discussion-summary control in the comments view. It is a
//       persisted, wired toggle whose label promises an effect; before the fix it was
//       read by NO component, so turning it off did nothing (a dead control).
//
//   [B] The "new since last visit" comment badge must work when a discussion is
//       opened from a feed card (the comments DRAWER) — not only on /item. Before the
//       fix, StoryCard.onOpenComments pre-marked the story "seen" before CommentsView
//       captured the previous seen timestamp, so lastVisit ≈ now and NO comment was
//       ever flagged "new" on the drawer path.
//
// Hermetic: fully mocked HN API, chromium, no WebGPU. (Without WebGPU the AI summary
// control renders its "needs WebGPU" box, which is still the control being gated — so
// the gate is testable without a GPU.)
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:4173/';
const now = Math.floor(Date.now() / 1000);

// Two stories in Top. Each Algolia tree has one OLD comment (before the prior visit)
// and two FRESH comments (after it) so the "new" badge has a definite expected count.
const STORY_IDS = [1000, 1001];
const mkStory = (id) => ({ id, type: 'story', by: `op${id}`, title: `Story ${id}`, url: `https://d${id}.example/x`, score: 150, descendants: 3, time: now - 100000 });
const mkTree = (id) => ({
  id, story_id: id, title: `Story ${id}`, url: `https://d${id}.example/x`, points: 150, author: `op${id}`,
  created_at_i: now - 100000, type: 'story', text: null,
  children: [
    { id: id * 10 + 1, author: 'oldtimer', text: '<p>An OLD comment from before your last visit.</p>', created_at_i: now - 90000, children: [] },
    { id: id * 10 + 2, author: 'freshA', text: '<p>A FRESH comment posted after your last visit.</p>', created_at_i: now - 1800, children: [] },
    { id: id * 10 + 3, author: 'freshB', text: '<p>Another FRESH comment after your last visit.</p>', created_at_i: now - 1700, children: [] },
  ],
});

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
  if (u.includes('/topstories.json')) return j(STORY_IDS);
  for (const ep of ['beststories', 'newstories', 'askstories', 'showstories', 'jobstories']) if (u.includes(`/${ep}.json`)) return j([]);
  const m = u.match(/item\/(\d+)/);
  if (m) return j(STORY_IDS.includes(Number(m[1])) ? mkStory(Number(m[1])) : null);
  if (u.includes('/user/')) return j({ id: 'x', karma: 1, created: now });
  if (u.includes('maxitem')) return j(9999);
  return j(null);
});
await page.route(/hn\.algolia\.com\/api\/v1\/search/, (r) =>
  r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ nbHits: 0, page: 0, nbPages: 0, hits: [] }) })
);
await page.route(/hn\.algolia\.com\/api\/v1\/items\/(\d+)/, (r) => {
  const id = Number(r.request().url().match(/items\/(\d+)/)[1]);
  r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(mkTree(id)) });
});
await page.route(/google\.com\/s2\/favicons/, (r) => r.fulfill({ status: 200, body: '' }));

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__hnlens && window.__hnlens.prefs, null, { timeout: 20000 });
await page.evaluate(async () => {
  const i = await window.__hnlens.interactions();
  await i.clearAllData();
  window.__hnlens.prefs.getState().set({ useLearnedRanker: false, embeddingsEnabled: false, defaultFeed: 'top', minPoints: 0, mutedDomains: [], mutedUsers: [] });
});

const summaryControlVisible = () =>
  page.evaluate(() => /AI discussion summary|AI summaries need WebGPU/i.test(document.body.innerText));
// The discoverability CTA shown when local AI is OFF (so the feature isn't invisible).
const ctaVisible = () =>
  page.evaluate(() => /Enable local AI|Summarize this discussion/i.test(document.body.innerText));

// ===== [A] showAiSummaries gates the comments AI summary control =====
console.log('\n[A] "Show AI summary controls in comments" (showAiSummaries) gates the control');

// A1: llm ON + showAiSummaries ON → control is present
await page.evaluate(() => window.__hnlens.prefs.getState().set({ llmEnabled: true, showAiSummaries: true }));
await page.goto(`${BASE}#/item/1000`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => /comments/i.test(document.body.innerText), null, { timeout: 15000 });
await page.waitForTimeout(500);
check('with LLM on + showAiSummaries ON, the AI summary control is shown', await summaryControlVisible());

// A2: toggle showAiSummaries OFF (live) → control disappears
await page.evaluate(() => window.__hnlens.prefs.getState().set({ showAiSummaries: false }));
await page.waitForTimeout(400);
check('turning showAiSummaries OFF hides the AI summary control', !(await summaryControlVisible()), 'still visible after OFF ⇒ dead toggle');

// A3: OFF persists across a reload of the item page
await page.goto(`${BASE}#/item/1000`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => /comments/i.test(document.body.innerText), null, { timeout: 15000 });
await page.waitForTimeout(500);
check('showAiSummaries OFF keeps the control hidden after reload', !(await summaryControlVisible()));

// A4: with LLM OFF (default) the summarize CONTROL is hidden, but a discoverability
// CTA is shown so the feature isn't invisible on a long thread.
await page.evaluate(() => window.__hnlens.prefs.getState().set({ llmEnabled: false, showAiSummaries: true }));
await page.goto(`${BASE}#/item/1000`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => /comments/i.test(document.body.innerText), null, { timeout: 15000 });
await page.waitForTimeout(400);
check('with LLM off, the summarize control itself is hidden', !(await summaryControlVisible()));
check('with LLM off, a discoverability CTA to enable local AI IS shown', await ctaVisible(), 'feature must not be invisible');

// A5: turning showAiSummaries OFF hides EVERYTHING (control AND the CTA).
await page.evaluate(() => window.__hnlens.prefs.getState().set({ llmEnabled: false, showAiSummaries: false }));
await page.goto(`${BASE}#/item/1000`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => /comments/i.test(document.body.innerText), null, { timeout: 15000 });
await page.waitForTimeout(400);
check('showAiSummaries OFF hides the CTA too (fully opts out)', !(await ctaVisible()) && !(await summaryControlVisible()));
// restore default for later sections
await page.evaluate(() => window.__hnlens.prefs.getState().set({ showAiSummaries: true }));

// ===== [B] "new since last visit" badge on the FEED → DRAWER path =====
console.log('\n[B] "new since last visit" badge works when opening a discussion from a feed card (drawer)');
await page.evaluate(async () => {
  const i = await window.__hnlens.interactions();
  await i.clearAllData();
  window.__hnlens.prefs.getState().set({ llmEnabled: false });
});
// Seed a PRIOR visit: story 1000 was seen 50000s ago (before the two fresh comments).
await page.evaluate(async (t) => {
  const dbMod = await window.__hnlens.db();
  await dbMod.db.seen.put({ id: 1000, ts: (t - 50000) * 1000 });
}, now);

// Open the discussion via the CARD's "Open comments" button (the drawer path).
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.getByRole('button', { name: 'Top', exact: true }).click();
await page.waitForSelector('article[data-id="1000"]', { timeout: 15000 });
await page.waitForTimeout(300);
// Re-seed (in case a prior render marked it) so the prior-visit ts is definitely old.
await page.evaluate(async (t) => {
  const dbMod = await window.__hnlens.db();
  await dbMod.db.seen.put({ id: 1000, ts: (t - 50000) * 1000 });
}, now);
await page.locator('article[data-id="1000"]').getByRole('button', { name: 'Open comments' }).click();
await page.waitForFunction(() => document.querySelector('aside[role="dialog"]')?.innerText?.match(/comment/i), null, { timeout: 15000 });
await page.waitForTimeout(700);
const drawerNew = await page.evaluate(() => {
  const d = document.querySelector('aside[role="dialog"]');
  if (!d) return -1;
  return [...d.querySelectorAll('span')].filter((s) => s.textContent.trim() === 'new').length;
});
check('drawer path: comments newer than last visit show a "new" badge', drawerNew >= 2, `${drawerNew} badge(s) (expected 2)`);
check('drawer path: the OLD comment is NOT flagged new', drawerNew === 2, `${drawerNew} badge(s) — should be exactly the 2 fresh ones`);
await page.keyboard.press('Escape');
await page.waitForTimeout(300);

// Cross-check the /item path still works (guards the fix both ways).
await page.evaluate(async (t) => {
  const dbMod = await window.__hnlens.db();
  await dbMod.db.seen.put({ id: 1001, ts: (t - 50000) * 1000 });
}, now);
await page.goto(`${BASE}#/item/1001`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => /comment/i.test(document.body.innerText), null, { timeout: 15000 });
await page.waitForTimeout(500);
const itemNew = await page.evaluate(() => [...document.querySelectorAll('main span')].filter((s) => s.textContent.trim() === 'new').length);
check('/item path: still shows the "new" badge for fresh comments', itemNew >= 2, `${itemNew} badge(s)`);

// ===== [C] Save from the discussion view header =====
// The reader decides a story is worth keeping WHILE reading its discussion — Save must
// be reachable there (not only on the feed card), and it must persist.
console.log('\n[C] Save toggle in the discussion header');
await page.evaluate(async () => {
  await (await window.__hnlens.interactions()).clearAllData();
});
await page.goto(`${BASE}#/item/1000`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => /comments/i.test(document.body.innerText), null, { timeout: 15000 });
await page.waitForTimeout(400);
const saveBtn = page.getByRole('button', { name: 'Save', exact: true });
check('discussion header shows a Save action', await saveBtn.isVisible().catch(() => false));
await saveBtn.click();
await page.waitForTimeout(300);
check('clicking Save flips the label to Saved', await page.getByRole('button', { name: 'Saved', exact: true }).isVisible().catch(() => false));
const savedInDb = await page.evaluate(async () => {
  const dbMod = await window.__hnlens.db();
  return !!(await dbMod.db.saved.get(1000));
});
check('the story is persisted to db.saved from the discussion view', savedInDb);

await b.close();
console.log(`\n${fails.length === 0 ? 'RESULT: DISCUSSION VIEW (summary gate + drawer new-badge) PASS \u2713' : `RESULT: ${fails.length} FAILED \u2717`}`);
if (fails.length) fails.forEach((f) => console.log('  - ' + f));
process.exit(fails.length ? 1 : 0);
