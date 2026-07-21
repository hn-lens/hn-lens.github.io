// Effect (not just store) test for the `remoteFavicons` privacy toggle. Proves the
// PRIVACY CLAIM: with the toggle OFF, story favicons render as letter monograms and the
// app makes ZERO requests to Google's favicon service — the domains you view never leave
// the device. With it ON (default) the remote favicon image is used. This guards against
// the "dead toggle" class (a persisted setting that changes the store but not the UI).
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:4173/';
const now = Math.floor(Date.now() / 1000);
const POOL = [11, 12, 13, 14, 15];
const item = (id) => ({ id, type: 'story', by: `u${id}`, title: `Story ${id}`, url: `https://ex${id}.com/x`, score: 100 + id, descendants: 5 + id, time: now - 3600 });
const byId = new Map(POOL.map((id) => [id, item(id)]));

const fails = [];
const check = (name, pass, detail) => {
  console.log(`  ${pass ? '\u2713' : '\u2717'} ${name}${detail ? ` \u2014 ${detail}` : ''}`);
  if (!pass) fails.push(name);
};

const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ viewport: { width: 1280, height: 1000 } });
const page = ctx.pages()[0] || (await ctx.newPage());

// Count (and harmlessly fulfill) every request to the Google favicon service.
let faviconReqs = 0;
await page.route(/google\.com\/s2\/favicons/, (r) => {
  faviconReqs++;
  // 1x1 transparent GIF so the <img> resolves without a real network hit.
  r.fulfill({ status: 200, contentType: 'image/gif', body: Buffer.from('R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==', 'base64') });
});
await page.route(/hacker-news\.firebaseio\.com/, (r) => {
  const u = r.request().url();
  const j = (x) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(x) });
  if (/topstories|beststories|newstories/.test(u)) return j(POOL);
  const m = u.match(/item\/(\d+)/);
  if (m) return j(byId.get(Number(m[1])) ?? null);
  return j(null);
});
const mkTree = (id) => ({
  id, type: 'story', author: `u${id}`, title: `Story ${id}`, url: `https://ex${id}.com/x`,
  points: 100 + id, created_at_i: now - 3600,
  children: [
    { id: id * 10 + 1, author: 'alice', text: '<p>A comment.</p>', created_at_i: now - 1800, children: [] },
    { id: id * 10 + 2, author: 'bob', text: '<p>Another comment.</p>', created_at_i: now - 1700, children: [] },
  ],
});
await page.route(/hn\.algolia\.com\/api\/v1\/search/, (r) =>
  r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ nbHits: 0, page: 0, nbPages: 0, hits: [] }) })
);
await page.route(/hn\.algolia\.com\/api\/v1\/items\/(\d+)/, (r) => {
  const id = Number(r.request().url().match(/items\/(\d+)/)[1]);
  r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(mkTree(id)) });
});

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__hnlens && window.__hnlens.prefs, null, { timeout: 20000 });

const gotoTop = async () => {
  await page.evaluate(() => { location.hash = '#/?feed=top'; });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__hnlens, null, { timeout: 20000 });
  await page.getByRole('button', { name: 'Top', exact: true }).click().catch(() => {});
  await page.waitForSelector('article', { timeout: 15000 });
  await page.waitForTimeout(600); // let lazy favicon <img>s in view resolve
};
const remoteImgCount = () => page.evaluate(() => document.querySelectorAll('img[src*="s2/favicons"]').length);

// --- ON (default): the remote favicon image is used ---
await page.evaluate(() => window.__hnlens.prefs.getState().set({ defaultFeed: 'top', minPoints: 0, remoteFavicons: true }));
await gotoTop();
const onImgs = await remoteImgCount();
check('remoteFavicons ON: story cards render the remote favicon <img>', onImgs > 0, `${onImgs} favicon imgs`);
check('remoteFavicons ON: the Google favicon service is actually contacted', faviconReqs > 0, `${faviconReqs} request(s)`);

// --- OFF: monogram only, ZERO requests to Google ---
faviconReqs = 0;
await page.evaluate(() => window.__hnlens.prefs.getState().set({ remoteFavicons: false }));
await gotoTop();
const offImgs = await remoteImgCount();
check('remoteFavicons OFF: NO remote favicon <img> is rendered (monogram only)', offImgs === 0, `${offImgs} favicon imgs`);
check('remoteFavicons OFF: ZERO requests to the Google favicon service (privacy)', faviconReqs === 0, `${faviconReqs} request(s)`);
const hasMonogram = await page.evaluate(() => {
  // A card whose domain is exNN.com should show its first letter ("E") as a monogram.
  return [...document.querySelectorAll('.story-card, article')].some((c) => /^[A-Z]$/i.test((c.querySelector('.sc-favicon span, [class*="favicon"] span')?.textContent || '').trim()));
});
check('remoteFavicons OFF: a letter monogram is shown instead', hasMonogram, '');

// --- OFF must hold on the DISCUSSION view too, not just feed cards. Opening a discussion
// is one definition of "read"; a leak there defeats the whole toggle. (Regression guard
// for the CommentsView header favicon that ignored the pref.) ---
// Drawer path (feed card → Open comments):
faviconReqs = 0;
await gotoTop();
await page.locator('article[data-id="11"]').getByRole('button', { name: 'Open comments' }).click();
await page.waitForTimeout(900); // let the drawer + discussion header render
check('remoteFavicons OFF: opening a discussion (drawer) makes ZERO favicon requests', faviconReqs === 0, `${faviconReqs} request(s)`);
check('remoteFavicons OFF: the drawer discussion header renders no remote favicon <img>', (await remoteImgCount()) === 0, `${await remoteImgCount()} favicon imgs`);

// /item permalink path:
faviconReqs = 0;
await page.goto(`${BASE}#/item/12`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__hnlens, null, { timeout: 20000 });
await page.waitForSelector('h1', { timeout: 15000 });
await page.waitForTimeout(700);
check('remoteFavicons OFF: the /item discussion page makes ZERO favicon requests', faviconReqs === 0, `${faviconReqs} request(s)`);
check('remoteFavicons OFF: the /item discussion header renders no remote favicon <img>', (await remoteImgCount()) === 0, `${await remoteImgCount()} favicon imgs`);

await b.close();
console.log(`\n${fails.length === 0 ? 'RESULT: FAVICON PRIVACY TOGGLE PASS \u2713' : `RESULT: ${fails.length} FAILED`}`);
process.exit(fails.length ? 1 : 0);
