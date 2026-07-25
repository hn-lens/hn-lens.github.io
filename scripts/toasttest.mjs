// Toast test — guards the usability fix: action-less toasts (e.g. "Saved") no
// longer STACK when you act on several stories in a row (they de-dupe), and the
// number of concurrent toasts is capped so they never pile up and linger.
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:4173/';
const now = Math.floor(Date.now() / 1000);
const IDS = [701, 702, 703, 704, 705, 706, 707, 708];
const item = (id) => ({ id, type: 'story', by: `u${id}`, title: `Story ${id}`, url: `https://ex${id}.com/x`, score: 100 + id, descendants: 4, time: now - 3600 });
const byId = new Map(IDS.map((id) => [id, item(id)]));

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
  if (/(top|best|new)stories/.test(u)) return j(IDS);
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
  window.__hnlens.prefs.getState().set({ defaultFeed: 'top', minPoints: 0, useLearnedRanker: false, embeddingsEnabled: false });
});
await page.getByRole('button', { name: 'Top', exact: true }).click();
await page.waitForSelector('article', { timeout: 15000 });
await page.waitForTimeout(300);

const toastCount = () => page.locator('[data-testid="toast"]').count();
const cardOf = (id) => page.locator('article').filter({ hasText: `Story ${id}` });

// ---- de-dupe: saving several stories shows ONE "Saved" toast, not a stack ----
for (const id of [701, 702, 703]) {
  await cardOf(id).getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForTimeout(120);
}
const afterSaves = await toastCount();
check('3 saves collapse to a single "Saved" toast (de-duped)', afterSaves === 1, `${afterSaves} toasts`);

// ---- cap: many toasts at once never exceed the cap (3) ----
for (const id of [704, 705, 706, 707]) {
  await cardOf(id).getByRole('button', { name: 'Not interested', exact: true }).click();
  await page.waitForTimeout(120);
}
const afterHides = await toastCount();
check('concurrent toasts are capped at 3', afterHides === 3, `${afterHides} toasts`);

// ---- toasts auto-dismiss (don't linger forever) ----
await page.waitForTimeout(4600);
const afterWait = await toastCount();
check('toasts auto-dismiss after their timeout', afterWait === 0, `${afterWait} toasts remain`);

await b.close();
console.log(`\n${fails.length === 0 ? 'RESULT: TOAST TEST PASS \u2713' : `RESULT: ${fails.length} FAILED`}`);
process.exit(fails.length ? 1 : 0);
