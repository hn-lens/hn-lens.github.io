// Offline must read as an OUTAGE, not as "User not found" / "No results". With the default
// networkMode ('online') TanStack PAUSES a query while navigator.onLine is false — it never fetches,
// so isError never fires and User/SearchResults fall through to their empty branches (an outage read
// as "nothing here"). networkMode:'always' (query.ts) makes the query attempt the fetch, which fails
// fast offline and surfaces the error state (+ Retry), matching how a 5xx is already handled.
//
// Drives the REAL app offline via context.setOffline. Two care points:
//  - The /user route is React.lazy, so its JS chunk must be loaded ONLINE first (a chunk fetch can't
//    succeed offline). We pre-warm it with a mocked user, then page.unroute the mock and go offline so
//    a DIFFERENT user's data fetch hits the network and fails. SearchResults is eager (no pre-warm).
//  - Navigation after going offline is client-side (hash change), never page.goto (that reloads
//    index.html, which fails offline).
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:4173/';
const now = Math.floor(Date.now() / 1000);
const FEED = [1, 2, 3];
const story = (id) => ({ id, type: 'story', by: `u${id}`, title: `Story ${id}`, score: 50 + id, descendants: 1, time: now - 3600 });

const fails = [];
const check = (name, pass, detail = '') => {
  console.log(`  ${pass ? '\u2713' : '\u2717'} ${name}${detail ? ` \u2014 ${detail}` : ''}`);
  if (!pass) fails.push(name);
};

const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ viewport: { width: 1000, height: 800 } });
const page = ctx.pages()[0] || (await ctx.newPage());
const json = (r, x) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(x) });
await page.route(/hacker-news\.firebaseio\.com\/v0\/(topstories|newstories|beststories|askstories|showstories|jobstories)\.json/, (r) => json(r, FEED));
await page.route(/hacker-news\.firebaseio\.com\/v0\/item\/(\d+)\.json/, (r) => json(r, story(Number(r.request().url().match(/item\/(\d+)/)[1]))));
await page.route(/google\.com\/s2|gstatic\.com\/faviconV2/, (r) => r.fulfill({ status: 200, body: '' }));
// The /user mock exists only to pre-warm the lazy User chunk online; it is removed before we go offline.
const USER_RE = /hacker-news\.firebaseio\.com\/v0\/user\//;
await page.route(USER_RE, (r) => json(r, { id: 'seeduser', karma: 10, created: now - 9_999_999, submitted: [] }));

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__hnlens && window.__hnlens.prefs, null, { timeout: 20000 });
await page.evaluate(() => window.__hnlens.prefs.getState().set({ defaultFeed: 'top', minPoints: 0 }));
await page.waitForSelector('.story-card', { timeout: 20000 }).catch(() => {});

// Pre-warm the lazy User route chunk ONLINE (renders the seeduser profile).
await page.evaluate(() => { window.location.hash = '#/user/seeduser'; });
await page.waitForFunction(() => /karma/i.test(document.querySelector('main')?.innerText || ''), null, { timeout: 15000 }).catch(() => {});

// Remove the mock, then go offline: a NEW user's data fetch now hits the network and fails.
await page.unroute(USER_RE);
await ctx.setOffline(true);

// --- Profile offline: outage (Retry), not "User not found" ---
await page.evaluate(() => { window.location.hash = '#/user/otheruser'; });
await page.waitForFunction(() => /Retry|not found/i.test(document.querySelector('main')?.innerText || ''), null, { timeout: 12000 }).catch(() => {});
await page.waitForTimeout(300);
const userText = await page.evaluate(() => document.querySelector('main')?.innerText || '');
check(
  'offline profile shows an OUTAGE (Retry), not "User not found"',
  /Retry/i.test(userText) && !/not found/i.test(userText),
  userText.replace(/\s+/g, ' ').slice(0, 120)
);

// --- Search offline: outage (Retry), not "No results" (SearchResults is eager, no chunk fetch) ---
await page.evaluate(() => { window.location.hash = '#/?q=rustlang'; });
await page.waitForFunction(() => /Retry|No results/i.test(document.querySelector('main')?.innerText || ''), null, { timeout: 12000 }).catch(() => {});
await page.waitForTimeout(300);
const searchText = await page.evaluate(() => document.querySelector('main')?.innerText || '');
check(
  'offline search shows an OUTAGE (Retry), not "No results"',
  /Retry/i.test(searchText) && !/No results/i.test(searchText),
  searchText.replace(/\s+/g, ' ').slice(0, 120)
);
// L1: the error state must not carry a misleading "N results for" count (data is undefined ⇒ 0).
check(
  'offline search does NOT show a "0 results" count above the error (L1)',
  !/\d[\d,]* results for/i.test(searchText),
  searchText.replace(/\s+/g, ' ').slice(0, 120)
);

// --- M-A: navigating to an UN-warmed lazy route while offline shows a GRACEFUL message, not the raw
// "Failed to fetch dynamically imported module" jargon. (/settings was not pre-warmed above.) ---
await page.evaluate(() => { window.location.hash = '#/settings'; });
await page.waitForFunction(
  () => /Couldn.t load this part of the app|dynamically imported module|Something went wrong/i.test(document.body.innerText),
  null,
  { timeout: 12000 }
).catch(() => {});
await page.waitForTimeout(400);
const settingsText = await page.evaluate(() => document.body.innerText || '');
check(
  'offline lazy-route chunk failure shows a graceful message, not raw jargon (M-A)',
  /Couldn.t load this part of the app/i.test(settingsText) && !/dynamically imported module/i.test(settingsText),
  settingsText.replace(/\s+/g, ' ').slice(0, 140)
);

await ctx.setOffline(false);
await b.close();
console.log(`\n${fails.length === 0 ? 'RESULT: OFFLINE OUTAGE PASS \u2713' : `RESULT: ${fails.length} FAILED`}`);
process.exit(fails.length ? 1 : 0);
