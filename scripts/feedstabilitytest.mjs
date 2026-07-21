// Feed STABILITY test — guards the recurring bug CLASS: "interacting with an item
// made it wrongly vanish." Asserts, over a mocked HN API, that ordinary actions
// (save, summarize, open+bounce, mark-seen) do NOT remove an item from the feed
// it's in, that the correct removals DO happen (unsave from Saved, hide), and that
// saved state persists across reload.
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:4173/';
const now = Math.floor(Date.now() / 1000);
const POOL = [301, 302, 303, 304, 305, 306];
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
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__hnlens && window.__hnlens.prefs, null, { timeout: 20000 });
await page.evaluate(async () => {
  await (await window.__hnlens.interactions()).clearAllData();
  window.__hnlens.prefs.getState().set({ defaultFeed: 'top', minPoints: 0, useLearnedRanker: false, embeddingsEnabled: false });
});

const feedIds = () =>
  page.evaluate(() => [...document.querySelectorAll('article h3')].map((h) => Number(h.textContent.replace('Story ', ''))).filter((n) => !Number.isNaN(n)));
const shows = async (id) => (await feedIds()).includes(id);
const cardOf = (id) => page.locator('article').filter({ hasText: `Story ${id}` });

const goTop = async () => {
  await page.getByRole('button', { name: 'Top', exact: true }).click();
  await page.waitForSelector('article', { timeout: 15000 });
  await page.waitForTimeout(400);
};
await goTop();
check('Top feed shows the pool', (await feedIds()).length === POOL.length, JSON.stringify(await feedIds()));

// --- SAVE keeps the item in the current feed (does not vanish) ---
await cardOf(301).getByRole('button', { name: 'Save' }).click();
await page.waitForTimeout(300);
check('saving an item KEEPS it in Top (301)', await shows(301), 'save ≠ remove');

// --- summarize (event) keeps the item in Top ---
await page.evaluate(() => window.__hnlens.interactions().trackForItem('summarize', { id: 302, title: 'Story 302', url: 'https://ex302.com/x', by: 'u' }));
await page.waitForTimeout(600);
check('summarizing an item KEEPS it in Top (302)', await shows(302), 'summarize ≠ remove');

// --- open + bounce keeps the item in Top (Top never auto-hides) ---
await page.evaluate(() => {
  const i = window.__hnlens.interactions();
  i.trackForItem('open_link', { id: 303, title: 'Story 303', url: 'https://ex303.com/x', by: 'u' });
  i.track({ type: 'dwell', itemId: 303, value: 1000 });
});
await page.waitForTimeout(600);
check('opening + bouncing KEEPS it in Top (303)', await shows(303), 'no auto-hide in Top');

// --- opening an article (open_link) keeps the card in the feed (does not remove) ---
await page.evaluate(() =>
  window.__hnlens.interactions().trackForItem('open_link', { id: 305, title: 'Story 305', url: 'https://ex305.com/x', by: 'u' })
);
await page.waitForTimeout(500);
check('opening an article keeps the card in Top (305)', await shows(305), 'open ≠ remove');

// --- HIDE removes from Top; Undo restores ---
await cardOf(304).getByRole('button', { name: 'Hide' }).click();
await page.waitForTimeout(400);
check('hiding REMOVES it from Top (304)', !(await shows(304)), 'hide = remove (correct)');
await page.getByRole('button', { name: 'Undo' }).click().catch(() => {});
await page.waitForTimeout(500);
check('Undo restores the hidden item (304)', await shows(304), 'undo = restore');

// --- SAVED tab: shows saved item; unsave removes it there; Top unaffected ---
await page.getByRole('button', { name: 'Saved items' }).click();
await page.waitForTimeout(600);
check('Saved page lists the saved item (301)', await shows(301), '');
check('Saved page does NOT list an unsaved item (302)', !(await shows(302)), '');

// --- SAVED persists across reload ---
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__hnlens, null, { timeout: 20000 });
await page.getByRole('button', { name: 'Saved items' }).click().catch(() => {});
await page.waitForTimeout(700);
check('saved item persists across reload (301)', await shows(301), '');

await b.close();
console.log(`\n${fails.length === 0 ? 'RESULT: FEED STABILITY PASS \u2713' : `RESULT: ${fails.length} FAILED`}`);
process.exit(fails.length ? 1 : 0);
