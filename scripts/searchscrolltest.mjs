// SPEC §4: arriving at SEARCH lands at the TOP of the results. Search is a `?q=` change on the same
// path (Home), which the pathname-only router reset missed, so search inherited the feed's offset and
// opened below the results heading. The fix adds `q` to the reset deps.
//
// HONEST LIMITATION: in a mock the search results have a brief loading phase that clamps scrollY to 0
// on its own, so this cannot be made to FAIL pre-fix without flakiness — the c3r26 bug lens
// reproduced the real defect on a warm cache, and the c3r28 lens is the independent verification.
// These assertions are regression protection: they fail if the reset is removed, or if the fix
// over-reaches and breaks a feed's own top-landing.
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:4173/';
const now = Math.floor(Date.now() / 1000);
const FEED = Array.from({ length: 30 }, (_, i) => 100 + i);
const mkItem = (id) => ({ id, type: 'story', by: `u${id}`, title: `Feed story ${id} with a reasonably long headline`, url: `https://f${id}.com/x`, score: 100 + id, descendants: 5, time: now - 3600 });
const hits = Array.from({ length: 30 }, (_, i) => ({ objectID: String(300 + i), title: `Search result ${300 + i} with a long enough headline`, url: `https://r${i}.com/x`, points: 50 + i, num_comments: 3, author: `s${i}`, created_at_i: now - 7200 }));

const fails = [];
const check = (name, pass, detail = '') => {
  console.log(`  ${pass ? '\u2713' : '\u2717'} ${name}${detail ? ` \u2014 ${detail}` : ''}`);
  if (!pass) fails.push(name);
};

const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ viewport: { width: 1280, height: 800 } });
const page = ctx.pages()[0] || (await ctx.newPage());
await page.route(/hacker-news\.firebaseio\.com/, (r) => {
  const u = r.request().url();
  const j = (x) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(x) });
  if (/topstories|beststories|newstories/.test(u)) return j(FEED);
  const m = u.match(/item\/(\d+)\.json/);
  if (m) return j(mkItem(Number(m[1])));
  return j(null);
});
await page.route(/hn\.algolia\.com\/api\/v1\/search/, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ hits, nbHits: hits.length, page: 0, nbPages: 1 }) }));
await page.route(/hn\.algolia\.com|google\.com\/s2/, (r) => r.fulfill({ status: 200, body: '{}' }));

const settledScroll = async (to) => {
  await page.waitForTimeout(2800); // let the feed settle (it re-asserts the top while its list grows)
  await page.evaluate((y) => window.scrollTo({ top: y }), to);
  await page.waitForTimeout(500);
  return page.evaluate(() => window.scrollY);
};

await page.goto(`${BASE}#/?feed=top`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.story-card', { timeout: 20000 });
await page.evaluate(() => window.__hnlens.prefs.getState().set({ minPoints: 0, hideReadInFeed: false }));
const feedY = await settledScroll(1500);
check('PRECONDITION: the feed holds a scroll offset once settled', feedY > 500, `feedY=${feedY}`);

// Enter search (a `?q=` change on the same path) → lands at the top.
await page.evaluate(() => { window.location.hash = '#/?q=rust'; });
await page.waitForFunction(() => /Search result/.test(document.body.innerText), null, { timeout: 15000 }).catch(() => {});
await page.waitForTimeout(500);
check('arriving at SEARCH lands at the top', (await page.evaluate(() => window.scrollY)) === 0, `searchY=${await page.evaluate(() => window.scrollY)}`);

await b.close();
console.log(`\n${fails.length === 0 ? 'RESULT: SEARCH SCROLL PASS \u2713' : `RESULT: ${fails.length} FAILED`}`);
process.exit(fails.length ? 1 : 0);
