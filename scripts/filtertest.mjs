// Global-filter test — guards the Major bug: muted domains / muted users / muted
// keywords / min-points were applied ONLY to For You, so plain feed tabs (Top/New/
// Best/Ask/Show/Jobs), the Read tab, and Search showed muted content anyway — while
// Settings + labels promised global muting. This asserts the hard filters apply on
// EVERY feed + search, AND that min-points does NOT empty the score-less Jobs feed.
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:4173/';
const now = Math.floor(Date.now() / 1000);

// Top feed pool: a normal item, a muted-domain item, a muted-keyword item, a
// below-min-points item, and another normal item.
const TOP = [401, 402, 403, 404, 405];
const story = (id, title, url, score) => ({ id, type: 'story', by: `u${id}`, title, url, score, descendants: 5, time: now - 3600 });
// Jobs feed: real HN job posts carry a CONSTANT score of 1 (not upvotes) → min-points
// must NOT filter them out (a threshold >=2 would otherwise empty the whole Jobs feed),
// but a muted domain still must. (Fixture uses the realistic score:1, not a score-less job.)
const JOBS = [501, 502];
const job = (id, title, url) => ({ id, type: 'job', by: null, title, url, score: 1, time: now - 3600 });

const byId = new Map();
byId.set(401, story(401, 'Rust internals deep dive', 'https://ex401.com/a', 120)); // shown
byId.set(402, story(402, 'A post from a muted site', 'https://muted.com/a', 120)); // muted domain
byId.set(403, story(403, 'Crypto surges to new highs', 'https://ex403.com/a', 120)); // muted keyword
byId.set(404, story(404, 'Barely upvoted note', 'https://ex404.com/a', 10)); // below minPoints (50)
byId.set(405, story(405, 'Another solid article', 'https://ex405.com/a', 220)); // shown
byId.set(501, job(501, 'Backend engineer at Foo', 'https://ex501.com/j')); // job (score:1) exempt from min-points → shown
byId.set(502, job(502, 'Recruiter post at muted site', 'https://muted.com/j')); // muted domain → hidden

const hit601 = { objectID: '601', title: 'Rust internals, the search result', url: 'https://ex601.com/s', author: 'a1', points: 90, num_comments: 3, created_at_i: now - 3600 };
const HITS = [
  hit601, // shown
  { objectID: '602', title: 'Search hit from a muted site', url: 'https://muted.com/s', author: 'a2', points: 90, num_comments: 3, created_at_i: now - 3600 }, // muted domain
  { objectID: '603', title: 'Crypto trading search hit', url: 'https://ex603.com/s', author: 'a3', points: 90, num_comments: 3, created_at_i: now - 3600 }, // muted keyword
  { objectID: '604', title: 'Low points search hit', url: 'https://ex604.com/s', author: 'a4', points: 5, num_comments: 3, created_at_i: now - 3600 }, // below minPoints
  { objectID: '605', title: 'A pre-hidden search hit', url: 'https://ex605.com/s', author: 'a5', points: 90, num_comments: 3, created_at_i: now - 3600 }, // hidden in a feed → must not reappear in search
  hit601, // DUPLICATE (Algolia can repeat a hit) — must be de-duped to one card
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
  if (/topstories/.test(u)) return j(TOP);
  if (/jobstories/.test(u)) return j(JOBS);
  if (/(best|new|ask|show)stories/.test(u)) return j([]);
  const m = u.match(/item\/(\d+)/);
  if (m) return j(byId.get(Number(m[1])) ?? null);
  return j(null);
});
let searchStatus = 200; // flip to 500 to simulate a search-backend outage
await page.route(/hn\.algolia\.com/, (r) => {
  const u = r.request().url();
  if (/\/search/.test(u)) {
    if (searchStatus !== 200) return r.fulfill({ status: searchStatus, body: 'search backend down' });
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ hits: HITS, nbHits: HITS.length, page: 0, nbPages: 1 }) });
  }
  return r.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
});
await page.route(/google\.com\/s2|gstatic/, (r) => r.fulfill({ status: 200, body: '' }));

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__hnlens && window.__hnlens.prefs, null, { timeout: 20000 });
await page.evaluate(async () => {
  const [{ db }, interactions] = await Promise.all([window.__hnlens.db(), window.__hnlens.interactions()]);
  await interactions.clearAllData();
  window.__hnlens.prefs.getState().set({
    defaultFeed: 'top',
    useLearnedRanker: false,
    embeddingsEnabled: false,
    mutedDomains: ['muted.com'],
    mutedUsers: [],
    keywordsMute: ['crypto'],
    minPoints: 50,
  });
  // A story hidden in a feed must not reappear in Search (hidden is global).
  await db.hidden.put({ id: 605, ts: Date.now() });
});

const titles = () => page.evaluate(() => [...document.querySelectorAll('article h3')].map((h) => h.textContent.trim()));
const shows = async (t) => (await titles()).some((x) => x.includes(t));

const openTab = async (name) => {
  await page.getByRole('button', { name, exact: true }).click();
  await page.waitForSelector('article', { timeout: 15000 });
  await page.waitForTimeout(400);
};

// ---- Top feed ----
await openTab('Top');
check('Top: normal story shown (401)', await shows('Rust internals deep dive'));
check('Top: another normal story shown (405)', await shows('Another solid article'));
check('Top: MUTED DOMAIN story hidden (402)', !(await shows('muted site')), 'muted.com filtered');
check('Top: MUTED KEYWORD story hidden (403)', !(await shows('Crypto surges')), "keyword 'crypto' filtered");
check('Top: BELOW-MIN-POINTS story hidden (404)', !(await shows('Barely upvoted')), 'score 10 < 50');

// ---- Jobs feed (real jobs carry score:1 → exempt from min-points) ----
await openTab('Jobs');
await page.waitForTimeout(300);
check('Jobs: job (score:1) NOT filtered by min-points 50 (501)', await shows('Backend engineer at Foo'), 'jobs are exempt from min-points');
check('Jobs: muted-domain job still hidden (502)', !(await shows('Recruiter post at muted site')), 'mute applies to jobs too');

// ---- Search ----
await page.goto(`${BASE.replace(/\/$/, '')}/#/?q=internals`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('article', { timeout: 15000 });
await page.waitForTimeout(500);
check('Search: normal hit shown (601)', await shows('the search result'));
const dupCount = (await titles()).filter((t) => t.includes('the search result')).length;
check('Search: duplicate hits are de-duped to one card (601)', dupCount === 1, `${dupCount} copies`);
check('Search: MUTED DOMAIN hit hidden (602)', !(await shows('from a muted site')), 'muted.com filtered in search');
check('Search: MUTED KEYWORD hit hidden (603)', !(await shows('Crypto trading')), "keyword 'crypto' filtered in search");
check('Search: BELOW-MIN-POINTS hit hidden (604)', !(await shows('Low points search hit')), 'score 5 < 50');

// ---- Hidden state is GLOBAL — it must apply to Search too (F1) ----
// A story hidden in a feed must not reappear in search results, and hiding a card
// inside Search must remove it live (both were broken: SearchResults never read the
// hidden set). Contrast the feed path, which filters hidden.
check('Search: PRE-HIDDEN story stays hidden in search (605)', !(await shows('A pre-hidden search hit')), 'hidden is global');
const card601 = page.locator('article', { hasText: 'the search result' });
await card601.getByRole('button', { name: 'Not interested', exact: true }).click();
await page.waitForTimeout(500);
check('Search: hiding a card in search removes it LIVE (601)', !(await shows('the search result')), 'live hidden filter re-renders search');

// ---- Search OUTAGE must show an error/Retry, NOT an empty "No results" ----
// (parity with the feed outage fix: a swallowed error erases "nothing found" vs "broken".)
searchStatus = 500;
await page.goto(`${BASE.replace(/\/$/, '')}/#/?q=outagetest`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(
  () => /Couldn.t load results|No results/i.test(document.querySelector('main')?.innerText ?? ''),
  null,
  { timeout: 15000 }
);
await page.waitForTimeout(300);
const searchOutage = await page.evaluate(() => document.querySelector('main')?.innerText ?? '');
check('Search outage shows an error, not an empty "No results"', /Couldn.t load results/i.test(searchOutage) && !/No results/i.test(searchOutage), searchOutage.replace(/\s+/g, ' ').slice(0, 80));
check('Search outage offers a Retry', await page.getByRole('button', { name: /Retry/i }).isVisible().catch(() => false));

await b.close();
console.log(`\n${fails.length === 0 ? 'RESULT: FILTER TEST PASS \u2713' : `RESULT: ${fails.length} FAILED`}`);
process.exit(fails.length ? 1 : 0);
