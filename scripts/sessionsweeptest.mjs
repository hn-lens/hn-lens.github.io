// SESSION read-SWEEP TRIGGER matrix.
//
// Design #4 (see src/lib/readSweep.ts + src/lib/session.ts): For You hides already-read stories via
// a "read sweep" that is computed once per document load and cached for the session. The sweep must
// change ONLY at these boundaries:
//
//   - a browser RELOAD                (a fresh document load)
//   - opening the app in a NEW TAB    (a fresh document load)
//   - the explicit Refresh BUTTON
//
// and must NEVER change on in-app navigation — the home icon, switching feed tabs, or opening and
// closing a discussion. Those CONTINUE the session; yanking a story the reader is mid-use is the
// exact defect designs #1 and #2 shipped. A reader reported "I was in Settings, clicked the home
// icon, and stories had moved to Read"; this test pins every one of those navigation paths so a
// regression that re-seeds the sweep on navigation is caught.
//
// It also asserts the DESIRED half: a genuine browser reload DOES sweep (arriving fresh shows fresh),
// and a mid-session read is NOT yanked (the story stays until the next load/refresh).
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:4173/';
const now = Math.floor(Date.now() / 1000);
const POOL = [401, 402, 403, 404, 405, 406, 407, 408];
const item = (id) => ({ id, type: 'story', by: `u${id}`, title: `Story ${id}`, url: `https://ex${id}.com/x`, score: 100 + id, descendants: 4, time: now - 3600 });
const byId = new Map(POOL.map((id) => [id, item(id)]));

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
  if (/(top|best|new)stories/.test(u)) return j(POOL);
  if (/stories/.test(u)) return j([]);
  const m = u.match(/item\/(\d+)/);
  if (m) return j(byId.get(Number(m[1])) ?? null);
  return j(null);
});
await page.route(/hn\.algolia\.com|google\.com\/s2/, (r) => r.fulfill({ status: 200, body: '{}' }));

const go = async (hash) => { await page.goto(`${BASE}#/${hash}`, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(300); };
const visible = () => page.evaluate(() => [...document.querySelectorAll('article[data-id]')].map((a) => Number(a.getAttribute('data-id'))));

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__hnlens && window.__hnlens.prefs, null, { timeout: 20000 });
await page.evaluate(async () => {
  await (await window.__hnlens.interactions()).clearAllData();
  window.__hnlens.prefs.getState().set({ defaultFeed: 'foryou', minPoints: 0, embeddingsEnabled: false, hideReadInFeed: true });
});
await go('?feed=foryou');
await page.waitForSelector('article[data-id]', { timeout: 20000 });
await page.waitForTimeout(600);

const base = await visible();
check('For You shows the pool', base.length >= 6, base.join(','));
const S = base[0]; // a story currently visible in For You

// Read S in-session (a genuine article read: open + a dwell past the bounce threshold).
await page.evaluate((s) => {
  const i = window.__hnlens.interactions();
  i.trackForItem('open_link', { id: s, title: 'x', url: 'https://x.com', by: 'u' });
  i.track({ type: 'dwell', itemId: s, value: 12000 });
}, S);
await page.waitForTimeout(700);
check('a mid-session read is NOT yanked (stays visible)', (await visible()).includes(S), `S=${S}`);

// ---- in-app navigation must NEVER sweep ----

// 1. away to Settings, then back via the HOME ICON (the reported path).
await go('settings');
await page.getByRole('link').filter({ has: page.locator('svg[aria-label="Hacker Lens"]') }).first().click();
await page.waitForSelector('article[data-id]', { timeout: 20000 });
await page.waitForTimeout(600);
check('home ICON from Settings does NOT sweep the in-session read', (await visible()).includes(S), `S=${S}`);

// 2. switch feed tabs and back.
await page.getByRole('button', { name: 'Top', exact: true }).click().catch(() => {});
await page.waitForTimeout(400);
await page.getByRole('button', { name: 'For You', exact: true }).click().catch(() => {});
await page.waitForTimeout(600);
check('switching feed tabs does NOT sweep the in-session read', (await visible()).includes(S), `S=${S}`);

// 3. open a discussion and come back.
await go(`item/${base[1]}`);
await page.waitForTimeout(400);
await go('?feed=foryou');
await page.waitForTimeout(600);
check('opening a discussion and returning does NOT sweep the in-session read', (await visible()).includes(S), `S=${S}`);

// ---- a genuine RELOAD DOES sweep (the desired half) ----
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('article[data-id]', { timeout: 20000 });
await page.waitForTimeout(900);
check('a browser RELOAD sweeps the now-read story (arriving fresh shows fresh)', !(await visible()).includes(S), `S=${S} visible=${(await visible()).join(',')}`);

console.log(fails.length ? `\nRESULT: ${fails.length} FAILED` : '\nRESULT: all passed');
await b.close();
process.exit(fails.length ? 1 : 0);
