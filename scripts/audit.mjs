// Behavioural UI audit — asserts what things DO, not just that they render.
// Drives the real app over a fully mocked HN API (deterministic) so every check
// verifies a concrete outcome (which feed loaded, save/hide/undo actually work,
// comments/search show the right content). Screenshots go to scripts/.artifacts/.
// This is the suite that catches "tab silently falls back" / "card vanishes" bugs.
import { chromium, firefox, webkit } from 'playwright';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.BASE || 'http://localhost:4173/';
const engine = { chromium, firefox, webkit }[process.env.BROWSER || 'chromium'] || chromium;
const OUT = join(dirname(fileURLToPath(import.meta.url)), '.artifacts', 'audit');
mkdirSync(OUT, { recursive: true });

const now = Math.floor(Date.now() / 1000);
// Distinct id range per feed so we can PROVE which feed actually loaded.
const RANGES = {
  top: [101, 102, 103, 104, 105, 106, 107, 108],
  best: [201, 202, 203, 204, 205, 206, 207, 208],
  new: [301, 302, 303, 304, 305, 306, 307, 308],
  ask: [401, 402, 403, 404],
  show: [501, 502, 503, 504],
  job: [601, 602, 603, 604],
};
const ALL = Object.values(RANGES).flat();
const mkItem = (id) => ({ id, type: 'story', by: `user${id}`, title: `Story ${id}`, url: `https://d${id}.example/x`, score: 100 + (id % 100), descendants: 5, time: now - 3600 });
const byId = new Map(ALL.map((id) => [id, mkItem(id)]));

const fails = [];
const check = (name, pass, detail = '') => {
  console.log(`  ${pass ? '\u2713' : '\u2717'} ${name}${detail ? ` \u2014 ${detail}` : ''}`);
  if (!pass) fails.push(name);
};
const titleIds = (page) =>
  page.evaluate(() => [...document.querySelectorAll('article h3')].map((h) => Number((h.textContent.match(/Story (\d+)/) || [])[1])).filter(Boolean));

const b = await engine.launch({ headless: true });
const ctx = await b.newContext({ viewport: { width: 1280, height: 1000 } });
const page = ctx.pages()[0] || (await ctx.newPage());

await page.route(/hacker-news\.firebaseio\.com/, (r) => {
  const u = r.request().url();
  const j = (x) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(x) });
  for (const [kind, ep] of [['top', 'topstories'], ['best', 'beststories'], ['new', 'newstories'], ['ask', 'askstories'], ['show', 'showstories'], ['job', 'jobstories']]) {
    if (u.includes(`/${ep}.json`)) return j(RANGES[kind]);
  }
  const m = u.match(/item\/(\d+)/);
  if (m) return j(byId.get(Number(m[1])) ?? null);
  if (u.includes('/user/')) return j({ id: 'x', karma: 1, created: now });
  if (u.includes('maxitem')) return j(9999);
  return j(null);
});
await page.route(/hn\.algolia\.com\/api\/v1\/search/, (r) => {
  const u = r.request().url();
  // Only a real user SEARCH carries a `query=` param; the For-You candidate pool query does not
  // (it's tags=story + a recency filter). Return the two search hits for an actual query, and EMPTY
  // for the For-You pool so For You falls back to the firebase blended pool this test asserts on.
  if (/[?&]query=/.test(u)) {
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ nbHits: 2, hits: [
      { objectID: '701', title: 'Search Result Alpha', url: 'https://s701.example', points: 55, num_comments: 9, author: 'sa', created_at_i: now - 100 },
      { objectID: '702', title: 'Search Result Beta', url: 'https://s702.example', points: 33, num_comments: 4, author: 'sb', created_at_i: now - 200 },
    ] }) });
  }
  return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ nbHits: 0, hits: [] }) });
});
await page.route(/hn\.algolia\.com\/api\/v1\/items\/(\d+)/, (r) => {
  const id = Number(r.request().url().match(/items\/(\d+)/)[1]);
  r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
    id, created_at_i: now - 3600, author: `user${id}`, title: `Story ${id}`, url: `https://d${id}.example/x`, points: 100, story_id: id, parent_id: null, type: 'story',
    children: [
      { id: id * 10 + 1, created_at_i: now - 1800, author: 'commenterX', text: 'This is a substantive first comment about the topic with real detail.', parent_id: id, story_id: id, points: 8, type: 'comment', children: [] },
      { id: id * 10 + 2, created_at_i: now - 1700, author: 'commenterY', text: 'A second opinion that adds nuance and a counterpoint worth reading.', parent_id: id, story_id: id, points: 5, type: 'comment', children: [] },
    ],
  }) });
});
await page.route(/google\.com\/s2\/favicons|gstatic\.com\/faviconV2/, (r) => r.fulfill({ status: 200, body: '' }));

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__hnlens && window.__hnlens.prefs, null, { timeout: 20000 });
await page.evaluate(async () => {
  const interactions = await window.__hnlens.interactions();
  await interactions.clearAllData();
  window.__hnlens.prefs.getState().set({ useLearnedRanker: false, embeddingsEnabled: false, defaultFeed: 'foryou', minPoints: 0, mutedDomains: [], mutedUsers: [], hideReadInFeed: false });
  // seed one genuine read (opened article 102) for the Read-tab check
  interactions.trackForItem('open_link', { id: 102, title: 'Story 102', url: 'https://d102.example/x', by: 'user102' });
});

// ===== A. every feed tab loads ITS OWN feed (not a silent fallback) =====
console.log('\n[A] feed tabs load the correct feed');
const tabExpect = {
  Top: RANGES.top, New: RANGES.new, Best: RANGES.best, Ask: RANGES.ask, Show: RANGES.show, Jobs: RANGES.job,
};
for (const [label, expect] of Object.entries(tabExpect)) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('article, [role="button"]', { timeout: 15000 }).catch(() => {});
  await page.getByRole('button', { name: label, exact: true }).click();
  await page.waitForSelector('article', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(500);
  const ids = await titleIds(page);
  const ok = ids.length > 0 && ids.every((id) => expect.includes(id));
  check(`"${label}" tab shows its own stories (${expect[0]}xx)`, ok, `got ${JSON.stringify(ids.slice(0, 4))}`);
}
// For You = blended top/best/new
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.getByRole('button', { name: 'For You' }).first().click().catch(() => {});
await page.waitForSelector('article', { timeout: 15000 }).catch(() => {});
await page.waitForTimeout(500);
const fyIds = await titleIds(page);
check('"For You" shows blended top/best/new', fyIds.length > 0 && fyIds.every((id) => [...RANGES.top, ...RANGES.best, ...RANGES.new].includes(id)), `got ${JSON.stringify(fyIds.slice(0, 4))}`);
// Read tab = the one story we opened (102)
await page.getByRole('button', { name: 'Read', exact: true }).click();
// Wait for the SEEDED read item (102) to actually render — NOT a transient "Nothing to show" (the Read
// feed derives from an async Dexie read query, which in the slow CI runner briefly shows the empty
// state before the read ids resolve) and NOT a stale keepPreviousData article from the prior feed.
await page.waitForFunction(() => !!document.querySelector('article[data-id="102"]'), null, { timeout: 15000 }).catch(() => {});
await page.waitForTimeout(300);
const readIds = await titleIds(page);
check('"Read" tab shows only what was read (102)', readIds.length === 1 && readIds[0] === 102, `got ${JSON.stringify(readIds)}`);
await page.screenshot({ path: join(OUT, 'tabs-read.png') });

// ===== A2. per-feed freshness indicator (#4) — each tab has its OWN updatedAt =====
console.log('\n[A2] feed freshness (every tab, independent query)');
for (const label of ['Top', 'For You', 'Read']) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: label, exact: true }).first().click();
  await page.waitForSelector('article', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(400);
  const freshText = await page.evaluate(() => document.body.innerText);
  check(`"${label}" shows an "Updated … ago" label`, /Updated .*(ago|just now)/i.test(freshText), '');
  check(`"${label}" shows a Refresh control`, (await page.getByRole('button', { name: 'Refresh' }).count()) > 0, '');
}

// ===== B. save → Saved route → unsave =====
console.log('\n[B] save flow');
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.getByRole('button', { name: 'Top', exact: true }).click();
await page.waitForSelector('article h3', { timeout: 15000 });
await page.waitForTimeout(400);
const saveCard = page.locator('article').first();
const firstTop = Number(((await saveCard.locator('h3').innerText()).match(/Story (\d+)/) || [])[1]);
await saveCard.getByRole('button', { name: 'Save', exact: true }).click();
await page.waitForTimeout(300);
await page.goto(BASE + '#/saved', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(600);
const savedIds = await titleIds(page);
check('saved story appears on the Saved page', savedIds.includes(firstTop), `saved ${firstTop}, page has ${JSON.stringify(savedIds)}`);
await page.screenshot({ path: join(OUT, 'saved.png') });
// unsave from the Saved page
const unsaveBtn = page.locator('article').first().getByRole('button', { name: /Saved|Save/ });
if (await unsaveBtn.count()) await unsaveBtn.first().click();
await page.waitForTimeout(400);
const savedAfter = await titleIds(page);
check('unsaving removes it from Saved', !savedAfter.includes(firstTop), JSON.stringify(savedAfter));

// ===== C. hide → removed → undo restores =====
console.log('\n[C] hide + undo');
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.getByRole('button', { name: 'Top', exact: true }).click();
await page.waitForSelector('article h3', { timeout: 15000 });
await page.waitForTimeout(400);
const hideCard = page.locator('article').first();
const hideTarget = Number(((await hideCard.locator('h3').innerText()).match(/Story (\d+)/) || [])[1]);
await hideCard.getByRole('button', { name: 'Not interested', exact: true }).click();
await page.waitForTimeout(400);
const afterHide = await titleIds(page);
check('hiding removes the story from the feed', !afterHide.includes(hideTarget), `hid ${hideTarget}`);
// "Not interested" is a NEGATIVE TRAINING signal, not just a visual hide: it logs a `hide`
// event that the learned reranker turns into a negative training example (train.ts).
const trainedNeg = await page.evaluate(async (tid) => {
  const dbMod = await window.__hnlens.db();
  const evs = await dbMod.db.events.where('type').equals('hide').toArray();
  return evs.some((e) => e.itemId === tid);
}, hideTarget);
check('"Not interested" logs a negative-training signal (hide event)', trainedNeg, `item ${hideTarget}`);
const undo = page.getByRole('button', { name: /Undo/i });
check('an Undo toast appears', await undo.count() > 0);
if (await undo.count()) {
  await undo.first().click();
  await page.waitForTimeout(500);
  const afterUndo = await titleIds(page);
  check('Undo restores the hidden story', afterUndo.includes(hideTarget), `restored ${hideTarget}? ${JSON.stringify(afterUndo.slice(0, 4))}`);
}

// ===== D. comments open the full discussion page and show the story's comments =====
console.log('\n[D] comments (full discussion page)');
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.getByRole('button', { name: 'Top', exact: true }).click();
await page.waitForSelector('article', { timeout: 15000 });
await page.locator('article').first().getByRole('button', { name: 'Open comments' }).click();
await page.waitForTimeout(1000);
const discussionText = await page.evaluate(() => document.body.innerText);
check('discussion page shows fetched comments', /substantive first comment|second opinion/.test(discussionText), '');
await page.screenshot({ path: join(OUT, 'comments.png') });

// ===== E. search returns results, and empty state is graceful =====
console.log('\n[E] search');
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('article', { timeout: 15000 }).catch(() => {});
const box = page.getByPlaceholder(/Search Hacker News/i);
await box.fill('rust');
await box.press('Enter');
await page.waitForTimeout(900);
const searchText = await page.evaluate(() => document.body.innerText);
check('search shows matching results', /Search Result Alpha|Search Result Beta/.test(searchText), '');
await page.screenshot({ path: join(OUT, 'search.png') });

await b.close();
console.log(`\n==================================================`);
console.log(`AUDIT: ${fails.length === 0 ? 'ALL BEHAVIOURAL CHECKS PASS \u2713' : `${fails.length} FAILED \u2717`}`);
if (fails.length) fails.forEach((f) => console.log('  - ' + f));
process.exit(fails.length ? 1 : 0);
