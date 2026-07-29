// Comments OUTAGE vs EMPTY: a failed comment-tree fetch must show an outage + Retry, NOT the
// misleading "No comments yet." (the outage-vs-empty rule, SPEC section 6 — already enforced for
// feeds + search; this guards the discussion view). A genuinely childless story still says "No
// comments yet." `useComments` fetches the tree with { strict: true } so a network failure surfaces
// as isError instead of a swallowed null.
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:4173/';
const now = Math.floor(Date.now() / 1000);
const STORY = 7000; // a story that CLAIMS comments (descendants > 0)
const EMPTY_STORY = 7001; // a story with genuinely no comments

let treeMode = 'fail'; // 'fail' => tree fetch 500s (outage); 'empty' => 200 with no children

const fails = [];
const check = (name, pass, detail = '') => { console.log(`  ${pass ? '\u2713' : '\u2717'} ${name}${detail ? ` \u2014 ${detail}` : ''}`); if (!pass) fails.push(name); };

const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
const page = ctx.pages()[0] || (await ctx.newPage());
await page.route(/hacker-news\.firebaseio\.com/, (r) => {
  const u = r.request().url();
  const j = (x) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(x) });
  const m = u.match(/item\/(\d+)/);
  if (m) {
    const id = Number(m[1]);
    const descendants = id === EMPTY_STORY ? 0 : 5;
    return j({ id, type: 'story', by: 'op', title: `Story ${id}`, url: `https://ex${id}.com/x`, score: 200, descendants, time: now - 3600 });
  }
  if (/stories/.test(u)) return j([]);
  return j(null);
});
// Broad stub FIRST, specific tree route LAST (Playwright runs matching routes last-registered-first).
await page.route(/hn\.algolia\.com|google\.com\/s2|gstatic\.com/, (r) => r.fulfill({ status: 200, body: '{}' }));
await page.route(/hn\.algolia\.com\/api\/v1\/items\/(\d+)/, (r) => {
  const id = Number(r.request().url().match(/items\/(\d+)/)[1]);
  if (id === EMPTY_STORY) return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id, type: 'story', title: `Story ${id}`, author: 'op', created_at_i: now - 3600, children: [] }) });
  if (treeMode === 'fail') return r.fulfill({ status: 500, body: 'err' });
  return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id, type: 'story', title: `Story ${id}`, author: 'op', created_at_i: now - 3600, children: [] }) });
});

const bodyText = () => page.evaluate(() => document.body.textContent || '');

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__hnlens && window.__hnlens.prefs, null, { timeout: 20000 });

// 1) OUTAGE: story claims 5 comments but the tree fetch 500s -> outage + Retry, not "No comments yet".
treeMode = 'fail';
await page.goto(`${BASE}#/item/${STORY}`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);
const t1 = await bodyText();
check('a failed comment-tree fetch shows an outage message (not "No comments yet.")', /Couldn.?t load the discussion/i.test(t1) && !/No comments yet/i.test(t1), JSON.stringify({ outage: /Couldn.?t load the discussion/i.test(t1), saysEmpty: /No comments yet/i.test(t1) }));
const hasRetry = await page.getByRole('button', { name: 'Retry' }).count();
check('the outage offers a Retry control', hasRetry > 0, `retryButtons=${hasRetry}`);

// 2) Retry after recovery loads the (still-empty here) tree without the outage message.
treeMode = 'empty';
await page.getByRole('button', { name: 'Retry' }).first().click().catch(() => {});
await page.waitForTimeout(1200);
const t2 = await bodyText();
check('Retry after recovery clears the outage message', !/Couldn.?t load the discussion/i.test(t2), JSON.stringify({ stillOutage: /Couldn.?t load the discussion/i.test(t2) }));

// 3) A GENUINELY childless story says "No comments yet." (not an outage).
await page.goto(`${BASE}#/item/${EMPTY_STORY}`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1200);
const t3 = await bodyText();
check('a genuinely childless story shows "No comments yet." (not an outage)', /No comments yet/i.test(t3) && !/Couldn.?t load the discussion/i.test(t3), JSON.stringify({ empty: /No comments yet/i.test(t3), outage: /Couldn.?t load the discussion/i.test(t3) }));

console.log(fails.length ? `\nRESULT: ${fails.length} FAILED` : '\nRESULT: all passed');
await b.close();
process.exit(fails.length ? 1 : 0);
