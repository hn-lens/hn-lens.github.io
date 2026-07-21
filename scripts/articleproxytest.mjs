// Article reader-proxy attribution test — guards the feature: fetchArticleBody
// records WHICH proxy served the text (primary, or a fallback when the first is
// down), caches {text, proxy}, and getCachedArticle reads it back. Drives the REAL
// article module via window.__hnlens.article() with the proxy hosts mocked.
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:4173/';
const HTML =
  '<html><body><article><p>' +
  'This is a genuinely long article body with plenty of real words so it clears the minimum-usable threshold and is treated as content rather than an error page. '.repeat(5) +
  '</p></article></body></html>';

const fails = [];
const check = (name, pass, detail = '') => {
  console.log(`  ${pass ? '\u2713' : '\u2717'} ${name}${detail ? ` \u2014 ${detail}` : ''}`);
  if (!pass) fails.push(name);
};

const b = await chromium.launch({ headless: true });
const page = (await b.newContext({ viewport: { width: 1000, height: 800 } })).pages()[0] || (await b.newPage());
await page.route(/hacker-news\.firebaseio\.com|hn\.algolia\.com|google\.com\/s2/, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
// AllOrigins (primary): serves article1, but FAILS for article2 (forces a fallback).
await page.route(/api\.allorigins\.win/, (r) =>
  r.request().url().includes('article1')
    ? r.fulfill({ status: 200, contentType: 'text/html', body: HTML })
    : r.fulfill({ status: 500, body: 'rate limited' })
);
// cors.eu.org (fallback): serves whatever reaches it.
await page.route(/cors\.eu\.org/, (r) => r.fulfill({ status: 200, contentType: 'text/html', body: HTML }));
await page.route(/api\.codetabs\.com/, (r) => r.fulfill({ status: 500, body: 'down' }));

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__hnlens && window.__hnlens.article && window.__hnlens.db, null, { timeout: 20000 });

const r = await page.evaluate(async () => {
  const art = window.__hnlens.article();
  const dbMod = await window.__hnlens.db();
  await dbMod.db.kv.where('key').startsWith('atext:').delete();
  const a1 = await art.fetchArticleBody({ id: 111, url: 'https://example.com/article1' });
  const a2 = await art.fetchArticleBody({ id: 222, url: 'https://example.com/article2' });
  const cached1 = await art.getCachedArticle(111);
  const noUrl = await art.fetchArticleBody({ id: 333 });
  const proxyNames = art.READER_PROXIES.map((p) => p.name);
  return { a1, a2, cached1, noUrl, proxyNames };
});

check('primary proxy (AllOrigins) is recorded when it succeeds', r.a1.proxy === 'AllOrigins', r.a1.proxy);
check('article text is actually extracted', r.a1.text.length > 100, `${r.a1.text.length} chars`);
check('falls back to the next proxy when the first is down', r.a2.proxy === 'cors.eu.org', r.a2.proxy);
check('the cached entry records which proxy served it', !!r.cached1 && r.cached1.proxy === 'AllOrigins', JSON.stringify(r.cached1));
check('cached entry keeps the text', !!r.cached1 && r.cached1.text.length > 100);
check('no-URL item returns empty {text,proxy}', r.noUrl.text === '' && r.noUrl.proxy === '', JSON.stringify(r.noUrl));
check('the proxy chain is exposed (AllOrigins first)', r.proxyNames[0] === 'AllOrigins' && r.proxyNames.length >= 2, JSON.stringify(r.proxyNames));

// ---- prefetch: fetch-on-click helper is gated on the opt-in ----
const pf = await page.evaluate(async () => {
  const art = window.__hnlens.article();
  const dbMod = await window.__hnlens.db();
  await dbMod.db.kv.where('key').startsWith('atext:').delete();
  // gated OFF → no fetch, nothing cached
  art.prefetchArticleText({ id: 501, url: 'https://example.com/article1' }, false);
  await new Promise((r) => setTimeout(r, 200));
  const offCached = await art.getCachedArticle(501);
  // gated ON → fetches + caches
  art.prefetchArticleText({ id: 501, url: 'https://example.com/article1' }, true);
  await new Promise((r) => setTimeout(r, 400));
  const onCached = await art.getCachedArticle(501);
  // speculative prefetch: bounded to `max`, skips already-cached, caches new ones
  const items = [
    { id: 501, url: 'https://example.com/article1' }, // already cached (skipped)
    { id: 601, url: 'https://example.com/article1?a=1' },
    { id: 602, url: 'https://example.com/article1?a=2' },
    { id: 603, url: 'https://example.com/article1?a=3' },
  ];
  const fetched = await art.prefetchArticles(items, 2, 50);
  const c601 = await art.getCachedArticle(601);
  const c603 = await art.getCachedArticle(603);
  return { offCached, onCached, fetched, has601: !!c601?.text, has603: !!c603?.text };
});
check('fetch-on-click does NOTHING when the opt-in is OFF', pf.offCached === null, JSON.stringify(pf.offCached));
check('fetch-on-click caches the article when the opt-in is ON', !!pf.onCached && pf.onCached.text.length > 100);
check('speculative prefetch is bounded to max (2)', pf.fetched === 2, `fetched=${pf.fetched}`);
check('speculative prefetch caches an uncached candidate', pf.has601 === true);
check('speculative prefetch stops at the cap (3rd new item not fetched)', pf.has603 === false);

// ---- profile-building is CACHE-ONLY: training/auto-train must never do a live
// article fetch (a hung proxy would stall the background retrain + ['ranker']). An
// uncached engaged item contributes only its title terms; no proxy request is made. ----
let profileProxyReqs = 0;
const countProxy = (req) => {
  if (/allorigins\.win|cors\.eu\.org|codetabs\.com/.test(req.url())) profileProxyReqs++;
};
page.on('request', countProxy);
const co = await page.evaluate(async () => {
  const content = await window.__hnlens.content();
  const dbMod = await window.__hnlens.db();
  await dbMod.db.kv.where('key').startsWith('atext:').delete();
  await dbMod.db.kv.where('key').startsWith('aterms:').delete();
  await dbMod.db.events.clear();
  // an engaged (opened) item with a URL but NO cached article body
  const it = { id: 909, title: 'uniqueprofileterm quokka story', url: 'https://example.com/uncached', by: 'u', score: 50, descendants: 3, time: Math.floor(Date.now() / 1000), type: 'story' };
  await dbMod.db.items.put({ id: 909, item: it, cachedAt: Date.now() }); // getItem cache shape

  await dbMod.db.events.add({ type: 'open_link', itemId: 909, ts: Date.now() });
  const p = await content.buildContentProfile('', { withComments: false, embeddings: false, fetchArticle: true });
  return { terms909: p.likedTermsById.get(909) || [] };
});
await new Promise((r) => setTimeout(r, 300)); // let any (unwanted) request register
page.off('request', countProxy);
check('profile-building makes NO proxy request (cache-only training)', profileProxyReqs === 0, `proxyReqs=${profileProxyReqs}`);
check('uncached engaged item contributes its title terms only (no live body fetch)', co.terms909.includes('uniqueprofileterm') && co.terms909.includes('quokka'), JSON.stringify(co.terms909));

// ---- a hung / unreachable proxy is BOUNDED by a timeout (never stalls forever) ----
// Make the primary proxy hang past the timeout; fetchArticleBody must abort it and
// fall through to the next working proxy in ~the bound, not hang indefinitely.
await page.unroute(/api\.allorigins\.win/);
await page.route(/api\.allorigins\.win/, async (r) => {
  try {
    await new Promise((res) => setTimeout(res, 11000)); // > PROXY_TIMEOUT_MS (8s)
    await r.fulfill({ status: 200, contentType: 'text/html', body: HTML });
  } catch {
    /* request already aborted by the timeout — expected */
  }
});
const to = await page.evaluate(async () => {
  const art = window.__hnlens.article();
  const dbMod = await window.__hnlens.db();
  await dbMod.db.kv.where('key').startsWith('atext:').delete();
  const t0 = Date.now();
  const res = await art.fetchArticleBody({ id: 888, url: 'https://example.com/timeout-test' });
  return { proxy: res.proxy, ms: Date.now() - t0 };
});
check('a hung primary proxy is abandoned via timeout; the chain continues', to.proxy === 'cors.eu.org', `served by ${to.proxy}`);
check('the timeout fired (bounded wait, not forever)', to.ms >= 7000 && to.ms < 20000, `${to.ms}ms`);

await b.close();
console.log(`\n${fails.length === 0 ? 'RESULT: ARTICLE PROXY PASS \u2713' : `RESULT: ${fails.length} FAILED`}`);
process.exit(fails.length ? 1 : 0);
