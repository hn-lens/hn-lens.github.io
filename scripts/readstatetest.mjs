// Exhaustive READ-STATE test — the area that keeps shipping bugs. Two parts:
//  A. Hermetic transition matrix: every way to BECOME read, every way NOT to, and
//     MONOTONICITY (once genuinely read, a later bounce/summarize/save never un-reads).
//  B. Real-flow at the DISPLAY level: the Read tab shows read items, and interacting
//     with an item there (re-click+bounce, summarize) does NOT make it vanish — the
//     exact reported bug.
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:4173/';
const now = Math.floor(Date.now() / 1000);
const fails = [];
const check = (name, pass, detail = '') => {
  console.log(`  ${pass ? '\u2713' : '\u2717'} ${name}${detail ? ` \u2014 ${detail}` : ''}`);
  if (!pass) fails.push(name);
};

const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ viewport: { width: 1280, height: 1000 } });
const page = ctx.pages()[0] || (await ctx.newPage());
const POOL = [201, 202, 203, 204, 205, 206, 207, 208, 209, 210, 211, 212, 213, 214, 215];
const item = (id) => ({ id, type: 'story', by: `u${id}`, title: `Story ${id}`, url: `https://ex${id}.com/x`, score: 100, descendants: 3, time: now - 3600 });
const byId = new Map(POOL.map((id) => [id, item(id)]));
await page.route(/hacker-news\.firebaseio\.com/, (r) => {
  const u = r.request().url();
  const j = (x) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(x) });
  if (/(top|best|new)stories/.test(u)) return j(POOL);
  if (/stories/.test(u)) return j([]);
  const m = u.match(/item\/(\d+)/);
  if (m) return j(byId.get(Number(m[1])) ?? null);
  return j(null);
});
await page.route(/hn\.algolia\.com|google\.com\/s2/, (r) => r.fulfill({ status: 200, body: '{}' }));
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__hnlens && window.__hnlens.prefs, null, { timeout: 20000 });

// ── Part A: hermetic transition matrix ──
const readIds = await page.evaluate(async () => {
  const [{ db }, interactions] = await Promise.all([window.__hnlens.db(), window.__hnlens.interactions()]);
  await interactions.clearAllData();
  const t = Date.now();
  const A = (type, itemId, extra = {}, dt = 0) => ({ type, itemId, ts: t - dt, ...extra });
  await db.events.bulkAdd([
    A('open_link', 201, {}, 9000), A('dwell', 201, { value: 30000 }, 8900), // article + stay → READ
    A('open_link', 202, {}, 8000), // article, no dwell (bg) → READ
    A('open_link', 203, {}, 7000), A('dwell', 203, { value: 2000 }, 6900), // article + bounce → not read
    A('open_comments', 204, {}, 6000), A('dwell', 204, { value: 12000, meta: { where: 'comments' } }, 5900), // discussion stay → READ
    A('open_comments', 205, {}, 5000), // discussion glance → not read
    A('open_comments', 206, {}, 4800), A('dwell', 206, { value: 3000, meta: { where: 'comments' } }, 4700), // short discussion → not read
    A('save', 207, {}, 4000), // save → not read
    A('summarize', 208, {}, 3800), // summarize → not read
    A('upvote_out', 209, {}, 3600), // upvote → not read
    A('open_link', 210, { meta: { source: 'hn_import' } }, 3400), // imported post → not read
    A('open_comments', 211, { meta: { source: 'hn_import' } }, 3200), // imported discussion → not read
    // MONOTONICITY: a genuine read then a later bounce/summarize/save stays read
    A('open_link', 212, {}, 3000), A('dwell', 212, { value: 40000 }, 2900), A('open_link', 212, {}, 200), A('dwell', 212, { value: 1500 }, 100), // good read, later bounce → READ
    A('open_comments', 213, {}, 2600), A('dwell', 213, { value: 20000, meta: { where: 'comments' } }, 2500), A('open_link', 213, {}, 150), A('dwell', 213, { value: 1000 }, 50), // stayed, later article bounce → READ
    A('open_link', 214, {}, 2200), A('dwell', 214, { value: 30000 }, 2100), A('summarize', 214, {}, 90), A('save', 214, {}, 80), // read then summarize+save → READ
    A('open_link', 215, {}, 2000), A('dwell', 215, { value: 1500 }, 1900), A('open_link', 215, {}, 70), A('dwell', 215, { value: 25000 }, 60), // bounce then good read → READ
  ]);
  return interactions.getReadItemIds(500);
});
const R = new Set(readIds);
console.log('[readstate] read ids:', JSON.stringify([...R].sort((a, b) => a - b)));
check('article + stay → read (201)', R.has(201));
check('article, no dwell → read (202)', R.has(202));
check('article + bounce → NOT read (203)', !R.has(203));
check('discussion stay → read (204)', R.has(204));
check('discussion glance → NOT read (205)', !R.has(205));
check('short discussion dwell → NOT read (206)', !R.has(206));
check('save → NOT read (207)', !R.has(207));
check('summarize → NOT read (208)', !R.has(208));
check('upvote → NOT read (209)', !R.has(209));
check('imported post → NOT read (210)', !R.has(210));
check('imported discussion → NOT read (211)', !R.has(211));
check('MONOTONIC: good read then bounce → STILL read (212)', R.has(212));
check('MONOTONIC: discussion stay then article bounce → STILL read (213)', R.has(213));
check('MONOTONIC: read then summarize+save → STILL read (214)', R.has(214));
check('bounce then later good read → read (215)', R.has(215));

// ── Part B: real-flow at the Read tab (the reported bug) ──
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__hnlens, null, { timeout: 20000 });
await page.getByRole('button', { name: 'Read', exact: true }).click();
await page.waitForSelector('article', { timeout: 15000 });
await page.waitForTimeout(500);
const titlesIn = () => page.evaluate((s) => [...document.querySelectorAll(s)].map((h) => h.textContent.trim()), 'article h3');
const shows = async (id) => (await titlesIn()).some((t) => t === `Story ${id}`);
check('Read tab shows a genuinely-read item (201)', await shows(201));
check('Read tab hides a bounced item (203)', !(await shows(203)));

// Re-click a read item from the Read tab and BOUNCE (open + immediate short dwell).
await page.evaluate((id) => {
  const i = window.__hnlens.interactions();
  const it = { id, title: `Story ${id}`, url: `https://ex${id}.com/x`, by: 'u' };
  i.trackForItem('open_link', it);
  i.track({ type: 'dwell', itemId: id, value: 1200 }); // quick bounce back
}, 201);
await page.waitForTimeout(1200);
check('re-clicking a read item + bouncing keeps it in the Read tab (201)', await shows(201), 'the reported bug');

// Summarize a read item from the Read tab — must not remove it.
await page.evaluate((id) => {
  window.__hnlens.interactions().trackForItem('summarize', { id, title: `Story ${id}`, url: `https://ex${id}.com/x`, by: 'u' });
}, 204);
await page.waitForTimeout(1000);
check('summarizing a read item keeps it in the Read tab (204)', await shows(204));

await b.close();
console.log(`\n${fails.length === 0 ? 'RESULT: READ STATE (transitions + monotonic + real-flow) PASS \u2713' : `RESULT: ${fails.length} FAILED`}`);
process.exit(fails.length ? 1 : 0);
