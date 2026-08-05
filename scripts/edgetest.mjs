// Edge / security / robustness audit — the "1B users will do weird + hostile
// things" suite. Drives the real app over a mocked HN API whose behaviour is
// flipped per scenario (malicious content, failures, empties, huge lists). Asserts
// concrete safe outcomes. Screenshots to scripts/.artifacts/edge/.
import { chromium, firefox, webkit } from 'playwright';
const engine = { chromium, firefox, webkit }[process.env.BROWSER || 'chromium'] || chromium;
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.BASE || 'http://localhost:4173/';
const OUT = join(dirname(fileURLToPath(import.meta.url)), '.artifacts', 'edge');
mkdirSync(OUT, { recursive: true });
const now = Math.floor(Date.now() / 1000);

// ---- flippable mock state ----
let listIds = [801, 802, 803, 804, 805];
let listMode = 'ok'; // 'ok' | 'abort' | 'empty'
let searchHits = [{ objectID: '901', title: 'A result', url: 'https://r.example', points: 5, num_comments: 1, author: 'a', created_at_i: now }];
let commentChildren = (id) => [
  { id: id * 10 + 1, created_at_i: now - 100, author: 'c1', text: 'A normal, substantive comment worth reading in this thread.', parent_id: id, story_id: id, points: 4, type: 'comment', children: [] },
];
const overrides = new Map(); // id -> partial item
const mkItem = (id) => ({ id, type: 'story', by: `u${id}`, title: `Story ${id}`, url: `https://d${id}.example/x`, score: 50, descendants: 1, time: now - 3600, ...(overrides.get(id) || {}) });

const fails = [];
const check = (name, pass, detail = '') => {
  console.log(`  ${pass ? '\u2713' : '\u2717'} ${name}${detail ? ` \u2014 ${detail}` : ''}`);
  if (!pass) fails.push(name);
};

const b = await engine.launch({ headless: true });
const ctx = await b.newContext({ viewport: { width: 1280, height: 1000 } });
const page = ctx.pages()[0] || (await ctx.newPage());

await page.route(/hacker-news\.firebaseio\.com/, (r) => {
  const u = r.request().url();
  if (/(top|best|new|ask|show|job)stories\.json/.test(u)) {
    if (listMode === 'abort') return r.abort();
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(listMode === 'empty' ? [] : listIds) });
  }
  const m = u.match(/item\/(\d+)/);
  if (m) return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(mkItem(Number(m[1]))) });
  if (u.includes('/user/')) return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'x', karma: 1, created: now }) });
  return r.fulfill({ status: 200, contentType: 'application/json', body: 'null' });
});
await page.route(/hn\.algolia\.com\/api\/v1\/search/, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ nbHits: searchHits.length, hits: searchHits }) }));
await page.route(/hn\.algolia\.com\/api\/v1\/items\/(\d+)/, (r) => {
  const id = Number(r.request().url().match(/items\/(\d+)/)[1]);
  r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id, created_at_i: now - 3600, author: `u${id}`, title: mkItem(id).title, url: mkItem(id).url, text: mkItem(id).text, points: 10, story_id: id, parent_id: null, type: 'story', children: commentChildren(id) }) });
});
await page.route(/google\.com\/s2\/favicons|gstatic\.com\/faviconV2/, (r) => r.fulfill({ status: 200, body: '' }));

const reset = async (patch = {}) => {
  await page.evaluate((p) => {
    const set = window.__hnlens.prefs.getState().set;
    set({ useLearnedRanker: false, embeddingsEnabled: false, defaultFeed: 'top', minPoints: 0, mutedDomains: [], mutedUsers: [], ...p });
  }, patch);
};
// The list cache correctly serves stale ids; clear it so each scenario's mock is honoured.
const clearLists = () => page.evaluate(() => window.__hnlens.db().db.lists.clear());

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__hnlens && window.__hnlens.prefs, null, { timeout: 20000 });
await page.evaluate(async () => (await window.__hnlens.interactions()).clearAllData());

// ===== SECURITY =====
console.log('\n[SEC] hostile content');
// 1. javascript: URL must never become a clickable href
overrides.set(801, { url: 'javascript:window.__pwned=1//', title: 'Totally normal title' });
await reset({ defaultFeed: 'top' });
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('article', { timeout: 15000 });
await page.waitForTimeout(400);
const jsHrefs = await page.evaluate(() => [...document.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')).filter((h) => /^javascript:/i.test(h)));
check('javascript: URL never becomes a link href', jsHrefs.length === 0, JSON.stringify(jsHrefs));

// 2. XSS payloads in title + self-text + comment are neutralised (no script runs)
overrides.set(802, {
  title: 'Pwn <img src=x onerror="window.__xss=1"> <script>window.__xss=1</script>',
  text: '<script>window.__xss=1</script><img src=y onerror="window.__xss=1">',
  url: '',
});
commentChildren = (id) => [{ id: id * 10 + 1, created_at_i: now, author: 'evil', text: '<img src=z onerror="window.__xss=1"><a href="javascript:window.__xss=1">click</a>', parent_id: id, story_id: id, points: 1, type: 'comment', children: [] }];
await page.goto(BASE + '#/item/802', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1200);
const xss = await page.evaluate(() => window.__xss);
check('XSS in title/self-text/comment does not execute', xss === undefined, `window.__xss=${xss}`);
const jsHrefs2 = await page.evaluate(() => [...document.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')).filter((h) => /^javascript:/i.test(h)));
check('javascript: link inside a comment is stripped', jsHrefs2.length === 0, JSON.stringify(jsHrefs2));
await page.screenshot({ path: join(OUT, 'xss-item.png') });
overrides.clear();
commentChildren = (id) => [{ id: id * 10 + 1, created_at_i: now - 100, author: 'c1', text: 'A normal, substantive comment worth reading in this thread.', parent_id: id, story_id: id, points: 4, type: 'comment', children: [] }];

// ===== EMPTY + ERROR STATES =====
console.log('\n[STATE] empty + error + no-results');
listMode = 'empty';
await clearLists();
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => /Nothing to show/i.test(document.body.innerText) || document.querySelector('article'), null, { timeout: 15000 }).catch(() => {});
check('empty feed shows the empty state', /Nothing to show/i.test(await page.evaluate(() => document.body.innerText)), '');
await page.screenshot({ path: join(OUT, 'empty.png') });

listMode = 'abort';
await clearLists();
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => /Couldn.?t load|Retry/i.test(document.body.innerText), null, { timeout: 15000 }).catch(() => {});
const errText = await page.evaluate(() => document.body.innerText);
check('feed fetch failure shows an error + Retry', /Couldn.?t load/i.test(errText) && /Retry/i.test(errText), '');
listMode = 'ok';
await clearLists();
await page.getByRole('button', { name: /Retry/i }).click().catch(() => {});
await page.waitForSelector('article', { timeout: 15000 }).catch(() => {});
check('Retry recovers after the error', (await page.locator('article').count()) > 0, '');

searchHits = [];
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(400);
const sbox = page.getByRole('searchbox', { name: 'Search Hacker News' });
await sbox.fill('zzxxqq');
await sbox.press('Enter');
await page.waitForTimeout(800);
check('no-results search shows "No results."', /No results/i.test(await page.evaluate(() => document.body.innerText)), '');
searchHits = [{ objectID: '901', title: 'A result', url: 'https://r.example', points: 5, num_comments: 1, author: 'a', created_at_i: now }];

// ===== PAGINATION =====
console.log('\n[PAGE] pagination / load more');
listIds = Array.from({ length: 60 }, (_, i) => 1000 + i);
await clearLists();
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('article', { timeout: 15000 });
await page.waitForTimeout(600);
const firstPage = await page.locator('article').count();
const more = page.getByRole('button', { name: /Load more/i });
check('long feed paginates (first page < 60)', firstPage > 0 && firstPage < 60, `${firstPage}`);
if (await more.count()) {
  // This button sits thousands of pixels below the fold and the app scrolls smoothly, so the
  // driver's own scroll-then-click races the animation: on firefox it computes a click point, the
  // page settles, and the click lands on whatever card now occupies those coordinates. The button
  // itself is not obscured -- so assert THAT directly, which is the property worth having, and then
  // activate it in-page rather than through a coordinate the engine has already invalidated.
  const topmost = await more.first().evaluate((el) => {
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
    return !!hit && (hit === el || el.contains(hit));
  });
  check('Load more is not covered by anything', topmost, `topmost=${topmost}`);
  await more.first().evaluate((el) => el.click());
  await page.waitForTimeout(800);
  check('Load more shows additional stories', (await page.locator('article').count()) > firstPage, `${firstPage} -> ${await page.locator('article').count()}`);
} else {
  check('Load more shows additional stories', false, 'no Load more button');
}
listIds = [801, 802, 803, 804, 805];

// ===== KEYBOARD SHORTCUTS =====
console.log('\n[KEY] keyboard shortcuts');
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('article', { timeout: 15000 });
await page.keyboard.press('Shift+Slash'); // "?"
await page.waitForTimeout(300);
check('pressing "?" opens the shortcuts overlay', /Keyboard shortcuts/i.test(await page.evaluate(() => document.body.innerText)), '');
await page.keyboard.press('Escape');

// h / l switch feed tabs (works regardless of tab orientation)
const activeTab = () =>
  page.evaluate(() => document.querySelector('.feed-tabs button[aria-current="page"]')?.textContent?.trim() || '');
const t0 = await activeTab();
await page.keyboard.press('l');
await page.waitForTimeout(300);
const t1 = await activeTab();
check('pressing "l" moves to the next feed tab', !!t1 && t1 !== t0, `${t0} → ${t1}`);
await page.keyboard.press('h');
await page.waitForTimeout(300);
const t2 = await activeTab();
check('pressing "h" moves back to the previous tab', t2 === t0, `${t1} → ${t2}`);

// ===== RESPONSIVE (mobile) =====
console.log('\n[RESP] mobile layout');
await page.setViewportSize({ width: 375, height: 780 });
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('article', { timeout: 15000 });
await page.waitForTimeout(400);
const asideVisible = await page.evaluate(() => {
  const a = document.querySelector('aside');
  if (!a) return false;
  const r = a.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
});
check('sidebar is hidden on mobile widths', !asideVisible, `asideVisible=${asideVisible}`);
check('feed still renders on mobile', (await page.locator('article').count()) > 0, '');
await page.screenshot({ path: join(OUT, 'mobile.png') });
await page.setViewportSize({ width: 1280, height: 1000 });

// ===== WHOLE-CARD CLICK opens the article =====
console.log('\n[CARD] whole-card click opens the article');
listIds = [801, 802, 803, 804, 805];
await clearLists();
await page.evaluate(() => window.__hnlens.db().db.events.clear());
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('article h3', { timeout: 15000 });
await page.waitForTimeout(400);
// Clicking the title (stretched over the whole card) opens the article in a new
// tab AND records an article-open. Assert via the recorded event (robust in headless).
await page.locator('article h3 a').first().click({ noWaitAfter: true }).catch(() => {});
await page.waitForTimeout(500);
const openCount = await page.evaluate(async () => {
  const { db } = window.__hnlens.db();
  return (await db.events.where('type').equals('open_link').toArray()).length;
});
check('clicking the card opens the article (records open_link)', openCount > 0, `${openCount} open_link event(s)`);

await b.close();
console.log('\n==================================================');
console.log(`EDGE: ${fails.length === 0 ? 'ALL EDGE/SECURITY CHECKS PASS \u2713' : `${fails.length} FAILED \u2717`}`);
if (fails.length) fails.forEach((f) => console.log('  - ' + f));
process.exit(fails.length ? 1 : 0);
