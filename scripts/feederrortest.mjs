// Feed error-state test — guards the bug: a backend OUTAGE (a list endpoint returning
// 5xx) with no cached list used to be swallowed (`fetchList` returned []), so the feed
// showed the EMPTY state ("Nothing to show") — and, with a filter set, the misleading
// "Your filters may be hiding everything · Check filters", blaming the user for a network
// failure. Now `fetchList` throws on !res.ok and `getFeedIds` re-throws when there's no
// stale cache, so the feed query enters isError → the "Couldn't load / Retry" state.
// (A legitimately EMPTY list still returns [] and shows the empty state.)
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:4173/';
const fails = [];
const check = (name, pass, detail = '') => {
  console.log(`  ${pass ? '\u2713' : '\u2717'} ${name}${detail ? ` \u2014 ${detail}` : ''}`);
  if (!pass) fails.push(name);
};

const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
const page = ctx.pages()[0] || (await ctx.newPage());

let topStatus = 500; // flip to 200 for the recovery check
await page.route(/hacker-news\.firebaseio\.com/, (r) => {
  const u = r.request().url();
  const j = (x) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(x) });
  if (/topstories/.test(u)) {
    return topStatus === 200 ? j([9001, 9002]) : r.fulfill({ status: 500, body: 'backend down' });
  }
  if (/(best|new|ask|show|job)stories/.test(u)) return j([]); // legitimately empty
  const m = u.match(/item\/(\d+)/);
  if (m) return j({ id: Number(m[1]), type: 'story', by: 'u', title: `Story ${m[1]}`, url: `https://ex.com/${m[1]}`, score: 100, descendants: 3, time: Math.floor(Date.now() / 1000) - 3600 });
  return j(null);
});
await page.route(/hn\.algolia\.com|google\.com\/s2/, (r) => r.fulfill({ status: 200, body: '{}' }));

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__hnlens && window.__hnlens.prefs, null, { timeout: 20000 });
await page.evaluate(async () => {
  await (await window.__hnlens.interactions()).clearAllData(); // no cached lists
  window.__hnlens.prefs.getState().set({ defaultFeed: 'top', useLearnedRanker: false, embeddingsEnabled: false, minPoints: 0, mutedDomains: [], mutedUsers: [], keywordsMute: [] });
  location.hash = '#/';
});
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__hnlens, null, { timeout: 20000 });

const mainText = () => page.evaluate(() => document.querySelector('main')?.innerText ?? '');

// ---- outage, no filters → error/Retry state (NOT the empty state) ----
await page.getByRole('button', { name: 'Top', exact: true }).click();
await page.waitForFunction(() => /Couldn.t load|Nothing to show|No reading history/i.test(document.querySelector('main')?.innerText ?? ''), null, { timeout: 15000 });
await page.waitForTimeout(400);
const outage = await mainText();
check('backend outage shows the "Couldn\'t load" error state', /Couldn.t load/i.test(outage), outage.replace(/\s+/g, ' ').slice(0, 90));
check('outage offers a Retry action', await page.getByRole('button', { name: /Retry/i }).isVisible().catch(() => false));
check('outage does NOT show the "Nothing to show" empty state', !/Nothing to show/i.test(outage), outage.replace(/\s+/g, ' ').slice(0, 90));

// ---- outage WITH a filter set → still the error state, NOT "Check filters" (don't blame the user) ----
await page.evaluate(() => window.__hnlens.prefs.getState().set({ minPoints: 50 }));
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__hnlens, null, { timeout: 20000 });
await page.getByRole('button', { name: 'Top', exact: true }).click();
await page.waitForFunction(() => /Couldn.t load|Nothing to show|Check filters/i.test(document.querySelector('main')?.innerText ?? ''), null, { timeout: 15000 });
await page.waitForTimeout(400);
const outageFiltered = await mainText();
check('outage with a filter set still shows the error state, not "Check filters"', /Couldn.t load/i.test(outageFiltered) && !/Check filters/i.test(outageFiltered), outageFiltered.replace(/\s+/g, ' ').slice(0, 90));

// ---- a legitimately EMPTY list (200 + []) shows the empty state, NOT an error ----
await page.evaluate(() => window.__hnlens.prefs.getState().set({ minPoints: 0 }));
await page.getByRole('button', { name: 'Best', exact: true }).click(); // beststories → 200 []
await page.waitForFunction(() => /Nothing to show|Couldn.t load/i.test(document.querySelector('main')?.innerText ?? ''), null, { timeout: 15000 });
await page.waitForTimeout(300);
const emptyLegit = await mainText();
check('a legitimately empty feed (200 + []) shows the empty state, not an error', /Nothing to show/i.test(emptyLegit) && !/Couldn.t load/i.test(emptyLegit), emptyLegit.replace(/\s+/g, ' ').slice(0, 90));

// ---- recovery: backend comes back → Retry loads the feed ----
topStatus = 200;
await page.getByRole('button', { name: 'Top', exact: true }).click();
await page.getByRole('button', { name: /Retry/i }).click().catch(() => {});
await page.waitForSelector('article', { timeout: 15000 }).catch(() => {});
await page.waitForTimeout(400);
const recovered = await page.evaluate(() => [...document.querySelectorAll('article h3')].map((h) => h.textContent.trim()));
check('Retry after recovery loads the feed', recovered.some((t) => /Story 900/.test(t)), JSON.stringify(recovered).slice(0, 90));

await b.close();
console.log(`\n${fails.length === 0 ? 'RESULT: FEED ERROR-STATE PASS \u2713' : `RESULT: ${fails.length} FAILED`}`);
process.exit(fails.length ? 1 : 0);
