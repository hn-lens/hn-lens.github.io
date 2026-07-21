// Mobile access test — guards the fix: on a phone the personalization/Tune UI lived
// only in the desktop-only sidebar (hidden lg:block), so tuning was unreachable; and
// the Read tab sits at the end of an overflowing tab row. Asserts, at a 375-wide
// viewport, that (a) the desktop sidebar is hidden, (b) a mobile "Tune ranking" panel
// is reachable and reveals the sliders, and (c) the Read tab is reachable + switches.
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:4173/';
const now = Math.floor(Date.now() / 1000);
const POOL = [1, 2, 3];
const item = (id) => ({ id, type: 'story', by: `u${id}`, title: `Story ${id}`, url: `https://ex${id}.com/x`, score: 100 + id, descendants: 5, time: now - 3600 });
const byId = new Map(POOL.map((id) => [id, item(id)]));

const fails = [];
const check = (name, pass, detail = '') => {
  console.log(`  ${pass ? '\u2713' : '\u2717'} ${name}${detail ? ` \u2014 ${detail}` : ''}`);
  if (!pass) fails.push(name);
};

const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ viewport: { width: 375, height: 780 } }); // phone
const page = ctx.pages()[0] || (await ctx.newPage());
await page.route(/hacker-news\.firebaseio\.com/, (r) => {
  const u = r.request().url();
  const j = (x) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(x) });
  if (/(top|best|new)stories/.test(u)) return j(POOL);
  if (/(ask|show|job)stories/.test(u)) return j([]);
  const m = u.match(/item\/(\d+)/);
  if (m) return j(byId.get(Number(m[1])) ?? null);
  return j(null);
});
await page.route(/hn\.algolia\.com|google\.com\/s2/, (r) => r.fulfill({ status: 200, body: '{}' }));
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__hnlens && window.__hnlens.prefs, null, { timeout: 20000 });
await page.evaluate(async () => {
  await (await window.__hnlens.interactions()).clearAllData();
  window.__hnlens.prefs.getState().set({ defaultFeed: 'foryou', useLearnedRanker: false, embeddingsEnabled: false, minPoints: 0 });
});
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__hnlens, null, { timeout: 20000 });
await page.waitForSelector('article', { timeout: 15000 });
await page.waitForTimeout(400);

// (a) the desktop sidebar is not visible on a phone
const sidebarVisible = await page.evaluate(() => {
  const sb = document.querySelector('.app-sidebar');
  if (!sb) return false;
  const r = sb.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
});
check('desktop sidebar is hidden on mobile', !sidebarVisible);

// (b) mobile Tune ranking is reachable and reveals the sliders
const tuneBtn = page.getByRole('button', { name: 'Tune ranking' });
check('mobile "Tune ranking" control is present', await tuneBtn.isVisible());
await tuneBtn.click();
await page.waitForTimeout(300);
const slidersShown = await page.evaluate(() => /Popularity \(HN score\)/i.test(document.body.innerText));
check('tapping Tune reveals the ranking sliders on mobile', slidersShown);

// (c) the Read tab is reachable on mobile (overflowing tab row) and switches feeds
const readTab = page.locator('.feed-tabs button', { hasText: 'Read' });
await readTab.scrollIntoViewIfNeeded();
await readTab.click();
await page.waitForTimeout(500);
const onRead = await page.evaluate(() =>
  document.querySelector('.feed-tabs button[aria-current="page"]')?.textContent?.includes('Read') ?? false
);
check('Read tab is reachable and activates on mobile', onRead);

// (d) DESKTOP + `zen` layout hides the sidebar at all widths, so the in-context Tune
// disclosure must still be reachable on desktop (not lg:hidden away). Regression.
const desk = await b.newContext({ viewport: { width: 1280, height: 900 } });
const dp = await desk.newPage();
await dp.route(/hacker-news\.firebaseio\.com/, (r) => {
  const u = r.request().url();
  const j = (x) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(x) });
  if (/(top|best|new)stories/.test(u)) return j(POOL);
  if (/(ask|show|job)stories/.test(u)) return j([]);
  const m = u.match(/item\/(\d+)/);
  if (m) return j(byId.get(Number(m[1])) ?? null);
  return j(null);
});
await dp.route(/hn\.algolia\.com|google\.com\/s2/, (r) => r.fulfill({ status: 200, body: '{}' }));
await dp.goto(BASE, { waitUntil: 'domcontentloaded' });
await dp.waitForFunction(() => window.__hnlens && window.__hnlens.prefs, null, { timeout: 20000 });
await dp.evaluate(async () => {
  await (await window.__hnlens.interactions()).clearAllData();
  const s = window.__hnlens.prefs.getState();
  s.set({ defaultFeed: 'foryou', useLearnedRanker: false, embeddingsEnabled: false, minPoints: 0 });
  s.setLayout('zen');
});
await dp.reload({ waitUntil: 'domcontentloaded' });
await dp.waitForFunction(() => window.__hnlens, null, { timeout: 20000 });
await dp.waitForSelector('article', { timeout: 15000 });
await dp.waitForTimeout(400);
const sidebarVisibleZen = await dp.evaluate(() => {
  const sb = document.querySelector('.app-sidebar');
  const r = sb?.getBoundingClientRect();
  return !!r && r.width > 0 && r.height > 0;
});
const tuneReachableZen = await dp.getByRole('button', { name: 'Tune ranking' }).isVisible();
check('zen layout hides the sidebar on desktop', !sidebarVisibleZen);
check('desktop + zen: in-context "Tune ranking" is still reachable', tuneReachableZen);
await desk.close();

await b.close();
console.log(`\n${fails.length === 0 ? 'RESULT: MOBILE ACCESS PASS \u2713' : `RESULT: ${fails.length} FAILED`}`);
process.exit(fails.length ? 1 : 0);
