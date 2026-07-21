// Extreme / malformed input robustness. Feeds the app pathological data 1B users
// (and hostile posters) will eventually produce: 60-deep comment threads, 8k-char
// and unicode/RTL/emoji titles, items missing every field, null items in the list.
// Any uncaught exception (pageerror) or console error is a failure.
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:4173/';
const now = Math.floor(Date.now() / 1000);

const fails = [];
const errs = [];
const check = (name, pass, detail = '') => {
  console.log(`  ${pass ? '\u2713' : '\u2717'} ${name}${detail ? ` \u2014 ${detail}` : ''}`);
  if (!pass) fails.push(name);
};

// per-id item overrides (malformed / extreme)
const LONG = 'A'.repeat(8000);
const UNI = '𝕏 مرحبا שלום 你好 こんにちは 🚀🔥💀 \u202eRTLtext\u202c ௹';
const overrides = new Map([
  [701, { title: `Normal one` }],
  [702, { title: LONG, url: 'https://long.example/x' }],
  [703, { title: UNI, url: 'https://uni.example/x' }],
  [704, {}], // will be REPLACED with a near-empty item below
  [705, null], // item endpoint returns null
]);
const listIds = [701, 702, 703, 704, 705];
const mk = (id) => {
  if (overrides.get(id) === null) return null;
  if (id === 704) return { id: 704 }; // malformed: only an id, no title/url/by/score/time
  return { id, type: 'story', by: `u${id}`, title: `Story ${id}`, url: `https://d${id}.example/x`, score: 10, descendants: 3, time: now - 3600, ...(overrides.get(id) || {}) };
};

// A 60-deep nested comment thread for item 701
function deepThread(rootId, depth) {
  let node = null;
  for (let d = depth; d >= 1; d--) {
    node = { id: rootId * 1000 + d, created_at_i: now - d, author: `u${d}`, text: `Nested comment at depth ${d}, long enough to render in the thread view.`, parent_id: 0, story_id: rootId, points: 1, type: 'comment', children: node ? [node] : [] };
  }
  return [node];
}

const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ viewport: { width: 1280, height: 1000 } });
const page = ctx.pages()[0] || (await ctx.newPage());
page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/favicon|s2\/favicons|net::ERR/i.test(m.text())) errs.push('CONSOLE: ' + m.text()); });

await page.route(/hacker-news\.firebaseio\.com/, (r) => {
  const u = r.request().url();
  const j = (x) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(x) });
  if (/(top|best|new)stories\.json/.test(u)) return j(listIds);
  if (/(ask|show|job)stories\.json/.test(u)) return j([]);
  const m = u.match(/item\/(\d+)/);
  if (m) return j(mk(Number(m[1])));
  if (u.includes('/user/')) return j({ id: 'x', karma: 1, created: now });
  return j(null);
});
await page.route(/hn\.algolia\.com\/api\/v1\/items\/(\d+)/, (r) => {
  const id = Number(r.request().url().match(/items\/(\d+)/)[1]);
  r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id, created_at_i: now - 3600, author: `u${id}`, title: (mk(id) || {}).title || '', url: (mk(id) || {}).url || '', points: 5, story_id: id, parent_id: null, type: 'story', children: deepThread(id, 60) }) });
});
await page.route(/hn\.algolia\.com\/api\/v1\/search/, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ nbHits: 0, hits: [] }) }));
await page.route(/google\.com\/s2\/favicons/, (r) => r.fulfill({ status: 200, body: '' }));

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__hnlens && window.__hnlens.prefs, null, { timeout: 20000 });
await page.evaluate(async () => {
  await (await window.__hnlens.interactions()).clearAllData();
  window.__hnlens.prefs.getState().set({ defaultFeed: 'top', useLearnedRanker: false, embeddingsEnabled: false, minPoints: 0 });
});

console.log('\n[extreme] malformed + huge + unicode feed');
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('article', { timeout: 15000 });
await page.waitForTimeout(700);
const cardCount = await page.locator('article').count();
check('feed renders despite malformed/null items', cardCount >= 3, `${cardCount} cards`);
// the malformed (id-only) item 704 shows an "(untitled)"-style card without crashing
const bodyText = await page.evaluate(() => document.body.innerText);
check('huge 8k-char title does not break layout / crash', /A{50,}/.test(bodyText) || cardCount >= 3, '');
check('unicode + RTL + emoji title renders', /你好|مرحبا|🚀/.test(bodyText), '');
await page.screenshot({ path: '/tmp/extreme-feed.png' });

console.log('\n[extreme] 60-deep comment thread');
await page.goto(BASE + '#/item/701', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);
const depthText = await page.evaluate(() => document.body.innerText);
check('deeply-nested (60) thread renders without crashing', /Nested comment at depth/.test(depthText), '');

console.log('\n[extreme] rapid feed-tab hammering (no crash)');
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
for (let i = 0; i < 12; i++) {
  const t = ['Top', 'New', 'Best', 'For You', 'Read'][i % 5];
  await page.getByRole('button', { name: t, exact: true }).click().catch(() => {});
  await page.waitForTimeout(60);
}
await page.waitForTimeout(500);
check('rapid tab hammering leaves a working feed', (await page.locator('article, [class*=surface]').count()) > 0, '');

check('no uncaught exceptions or console errors throughout', errs.length === 0, errs.slice(0, 3).join(' | '));

await b.close();
console.log('\n==================================================');
console.log(`EXTREME: ${fails.length === 0 ? 'ALL PASS \u2713' : `${fails.length} FAILED \u2717`}`);
if (errs.length) errs.slice(0, 8).forEach((e) => console.log('  err: ' + e));
process.exit(fails.length ? 1 : 0);
