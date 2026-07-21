// Article-text LINK on the card — guards the bug the user hit: clicking a story's
// link fetches its full text, but the card showed NO "Article text" link (that link
// was gated on generating a TL;DR). Now the link appears whenever the body is cached
// (click / prefetch / summary), gated on the reader-proxy opt-in. Drives the REAL
// feed card over a mocked HN API + mocked reader proxy.
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:4173/';
const now = Math.floor(Date.now() / 1000);
const story = { id: 301, type: 'story', by: 'u1', title: 'Story 301 about systems', url: 'https://d301.example/x', score: 200, descendants: 10, time: now - 3600 };
const story2 = { id: 302, type: 'story', by: 'u2', title: 'Story 302 about databases', url: 'https://d302.example/y', score: 180, descendants: 8, time: now - 3600 };
const HTML = '<html><body><article><p>' + 'A long real article body about systems programming with enough words to clear the minimum-usable threshold and be treated as content. '.repeat(5) + '</p></article></body></html>';

const fails = [];
const check = (name, pass, detail = '') => {
  console.log(`  ${pass ? '\u2713' : '\u2717'} ${name}${detail ? ` \u2014 ${detail}` : ''}`);
  if (!pass) fails.push(name);
};

const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ viewport: { width: 1280, height: 1000 } });
const page = ctx.pages()[0] || (await ctx.newPage());
ctx.on('page', (p) => p.close().catch(() => {})); // auto-close the target=_blank popup
await page.route(/hacker-news\.firebaseio\.com/, (r) => {
  const u = r.request().url();
  const j = (x) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(x) });
  if (/topstories/.test(u)) return j([301, 302]);
  if (/(best|new|ask|show|job)stories/.test(u)) return j([]);
  if (/item\/301/.test(u)) return j(story);
  if (/item\/302/.test(u)) return j(story2);
  return j(null);
});
await page.route(/hn\.algolia\.com|google\.com\/s2|d301\.example|d302\.example/, (r) => r.fulfill({ status: 200, body: '{}' }));
await page.route(/api\.allorigins\.win/, (r) => r.fulfill({ status: 200, contentType: 'text/html', body: HTML }));

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__hnlens && window.__hnlens.prefs, null, { timeout: 20000 });
await page.evaluate(async () => {
  await (await window.__hnlens.interactions()).clearAllData();
  const dbMod = await window.__hnlens.db();
  await dbMod.db.kv.where('key').startsWith('atext:').delete();
  window.__hnlens.prefs.getState().set({ defaultFeed: 'top', useLearnedRanker: false, embeddingsEnabled: false, minPoints: 0, fetchArticleText: true });
});
await page.getByRole('button', { name: 'Top', exact: true }).click();
await page.waitForSelector('article', { timeout: 15000 });
await page.waitForTimeout(400);

const linkVisible = () => page.getByRole('button', { name: 'Article text' }).isVisible().catch(() => false);

check('before clicking: no "Article text" link (nothing cached yet)', !(await linkVisible()));

// Click the story's title link (fires onOpenArticle → fetch + cache the body).
await page.locator('article').getByRole('link', { name: /Story 301/ }).click();
// wait for the fetch to land + the query to refresh
await page.waitForFunction(
  () => [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Article text'),
  null,
  { timeout: 15000 }
);
check('after clicking the link: an "Article text" link appears on the card', await linkVisible());

// Open the extracted-text overlay and confirm content + proxy attribution.
await page.getByRole('button', { name: 'Article text' }).click();
await page.waitForTimeout(400);
const overlay = await page.evaluate(() => document.body.innerText);
check('overlay shows the extracted article text', /systems programming/.test(overlay));
check('overlay shows which proxy fetched it (via AllOrigins)', /fetched via AllOrigins/.test(overlay), 'proxy attribution');
// The overlay must be a real modal (a11y consistency with the app's other dialogs).
const isDialog = await page.evaluate(() =>
  [...document.querySelectorAll('[role="dialog"][aria-modal="true"]')].some((el) => /Extracted from/i.test(el.textContent || ''))
);
check('extracted-text overlay is a semantic modal dialog', isDialog);
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
const stillOpen = await page.evaluate(() =>
  [...document.querySelectorAll('[role="dialog"]')].some((el) => /Extracted from/i.test(el.textContent || ''))
);
check('Escape closes the extracted-text overlay', !stillOpen);
await page.mouse.click(5, 5).catch(() => {});

// Prefetch path (NOT clicked): caching via prefetchArticles must ALSO surface the
// link without a reload — regression: prefetch cached the body but never invalidated
// the card query, so the link only appeared on reload.
const has302Link = () =>
  page.evaluate(() => {
    const card = [...document.querySelectorAll('article')].find((a) => a.textContent.includes('Story 302'));
    return !!card && [...card.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Article text');
  });
check('story 302 has no Article-text link before prefetch', !(await has302Link()));
await page.evaluate(async () => {
  await window.__hnlens.article().prefetchArticles([{ id: 302, url: 'https://d302.example/y' }], 1, 10);
});
await page.waitForFunction(
  () => {
    const card = [...document.querySelectorAll('article')].find((a) => a.textContent.includes('Story 302'));
    return !!card && [...card.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Article text');
  },
  null,
  { timeout: 15000 }
);
check('prefetched (un-clicked) article surfaces the link WITHOUT a reload', await has302Link());

// OFF case: with the opt-in off, clicking must NOT surface a link (no fetch).
await page.evaluate(async () => {
  await (await window.__hnlens.db()).db.kv.where('key').startsWith('atext:').delete();
  window.__hnlens.prefs.getState().set({ fetchArticleText: false });
});
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__hnlens, null, { timeout: 20000 });
await page.getByRole('button', { name: 'Top', exact: true }).click();
await page.waitForSelector('article', { timeout: 15000 });
await page.locator('article').getByRole('link', { name: /Story 301/ }).click();
await page.waitForTimeout(1200);
check('opt-in OFF: clicking does NOT surface an Article-text link', !(await linkVisible()));

await b.close();
console.log(`\n${fails.length === 0 ? 'RESULT: ARTICLE LINK PASS \u2713' : `RESULT: ${fails.length} FAILED`}`);
process.exit(fails.length ? 1 : 0);
