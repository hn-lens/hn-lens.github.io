// Refresh test — guards the fix: the per-feed "Refresh" button must actually hit the
// network (bypass the IndexedDB cache TTL), not be a silent no-op within the ~3-min
// list window. Counts list requests and asserts Refresh triggers a fresh one.
import { chromium } from 'playwright';

const now = Math.floor(Date.now() / 1000);
const BASE = process.env.BASE || 'http://localhost:4173/';
const IDS = [601, 602, 603];
const item = (id) => ({ id, type: 'story', by: `u${id}`, title: `Story ${id}`, url: `https://ex${id}.com/x`, score: 100 + id, descendants: 4, time: now - 3600 });
const byId = new Map(IDS.map((id) => [id, item(id)]));

const fails = [];
const check = (name, pass, detail = '') => {
  console.log(`  ${pass ? '\u2713' : '\u2717'} ${name}${detail ? ` \u2014 ${detail}` : ''}`);
  if (!pass) fails.push(name);
};

const b = await chromium.launch({ headless: true });
const page = (await b.newContext({ viewport: { width: 1280, height: 900 } })).pages()[0] || (await b.newPage());
let listFetches = 0;
page.on('request', (r) => {
  if (/firebaseio\.com\/v0\/topstories/.test(r.url())) listFetches++;
});
await page.route(/hacker-news\.firebaseio\.com/, (r) => {
  const u = r.request().url();
  const j = (x) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(x) });
  if (/topstories/.test(u)) return j(IDS);
  if (/(best|new|ask|show|job)stories/.test(u)) return j([]);
  const m = u.match(/item\/(\d+)/);
  if (m) return j(byId.get(Number(m[1])) ?? null);
  return j(null);
});
await page.route(/hn\.algolia\.com|google\.com\/s2/, (r) => r.fulfill({ status: 200, body: '{}' }));
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__hnlens && window.__hnlens.prefs, null, { timeout: 20000 });
await page.evaluate(() => window.__hnlens.prefs.getState().set({ defaultFeed: 'top', useLearnedRanker: false, embeddingsEnabled: false, minPoints: 0 }));
await page.getByRole('button', { name: 'Top', exact: true }).click();
await page.waitForSelector('article', { timeout: 15000 });
await page.waitForTimeout(500);

const afterLoad = listFetches;
check('feed load fetched the list at least once', afterLoad >= 1, `${afterLoad} fetch(es)`);

// Click Refresh — within the cache TTL. Before the fix this did 0 network fetches.
await page.getByRole('button', { name: /refresh/i }).first().click();
await page.waitForTimeout(1200);
check('Refresh forces a fresh network list fetch (not a no-op within the TTL)', listFetches > afterLoad, `${afterLoad} -> ${listFetches}`);

await b.close();
console.log(`\n${fails.length === 0 ? 'RESULT: REFRESH PASS \u2713' : `RESULT: ${fails.length} FAILED`}`);
process.exit(fails.length ? 1 : 0);
