// Hermetic test for summary SOURCE TRANSPARENCY (#8) and CACHING (#9) — no WebGPU
// needed. Seeds the IndexedDB cache at the exact key the app computes, then drives
// the REAL summarizeItem / describeSources via window.__hnlens.llm() and asserts:
//   - a cache hit returns the cached text + sources with cached=true (no model call)
//   - a cache hit does NOT fetch the comment tree (the "cached but still slow" bug:
//     the tree fetch used to run before the cache check on every click)
//   - the sources descriptor reports what the summary is based on
//   - the "enable article text" hint fires when a URL exists but the proxy is off
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:4173/';
const fails = [];
const check = (name, pass, detail = '') => {
  console.log(`  ${pass ? '\u2713' : '\u2717'} ${name}${detail ? ` \u2014 ${detail}` : ''}`);
  if (!pass) fails.push(name);
};

const b = await chromium.launch({ headless: true });
const page = (await b.newContext({ viewport: { width: 1000, height: 800 } })).pages()[0] || (await b.newPage());
// Count comment-tree fetches so we can prove a cache hit makes none.
let treeFetches = 0;
page.on('request', (r) => {
  if (/hn\.algolia\.com\/api\/v1\/items\//.test(r.url())) treeFetches++;
});
await page.route(/hacker-news\.firebaseio\.com|hn\.algolia\.com|google\.com\/s2/, (r) =>
  r.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
);
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__hnlens && window.__hnlens.llm && window.__hnlens.db, null, { timeout: 20000 });

const seededSources = { articleWords: 0, comments: 8, selftext: true, articleAvailable: true, articleProxy: '' };
const res = await page.evaluate(async (sources) => {
  const llm = await window.__hnlens.llm();
  const dbMod = await window.__hnlens.db();
  const model = 'test-model';

  // (a) cache HIT: seed the exact key summarizeItem computes (tldr, article intent off).
  // The cached VALUE is the full object {text, sources, articleText}.
  const item = { id: 987654, title: 'A cached story', url: 'https://example.com/x', text: 'The HN post body.' };
  // The cache key now includes a fingerprint of the effective SYSTEM instruction — seed
  // with the same one the app uses (systemFor) so this is a hit, not a miss.
  const key = llm.summaryCacheKey('tldr', item.id, model, false, llm.systemFor('tldr'));
  await dbMod.kvSet(key, { text: 'This is the cached one-line summary.', sources, articleText: '', request: [] });
  const hit = await llm.summarizeItem(model, 'tldr', item, { fetchArticle: false });

  const line = llm.describeSources(hit.sources);

  // (b) no-URL item ⇒ articleAvailable false (seed so it's a hit, not a model run).
  const noUrlItem = { id: 987655, title: 'no url', text: 'x' };
  await dbMod.kvSet(llm.summaryCacheKey('tldr', noUrlItem.id, model, false, llm.systemFor('tldr')), {
    text: 'c',
    sources: { articleWords: 0, comments: 0, selftext: true, articleAvailable: false },
    articleText: '',
    request: [],
  });
  const noUrl = await llm.summarizeItem(model, 'tldr', noUrlItem, { fetchArticle: false });

  // (c) a summary whose article text came via a proxy — the proxy NAME must survive
  // the cache round-trip so the UI can show "via <proxy>".
  const proxItem = { id: 987656, title: 'proxied', url: 'https://example.com/p', text: '' };
  await dbMod.kvSet(llm.summaryCacheKey('thread', proxItem.id, model, true, llm.systemFor('thread')), {
    text: 'summary from article text',
    sources: { articleWords: 900, comments: 5, selftext: false, articleAvailable: false, articleProxy: 'codetabs' },
    articleText: 'the extracted body',
    request: [],
  });
  const prox = await llm.summarizeItem(model, 'thread', proxItem, { fetchArticle: true });

  return { hit, line, noUrlAvailable: noUrl.sources.articleAvailable, proxProxy: prox.sources.articleProxy, proxText: prox.articleText };
}, seededSources);

check('cache hit returns cached=true', res.hit.cached === true, String(res.hit.cached));
check('cache hit returns the stored text', res.hit.text === 'This is the cached one-line summary.', res.hit.text);
check('cache hit returns the stored sources (comments=8)', res.hit.sources.comments === 8, String(res.hit.sources.comments));
check('cache hit does NOT fetch the comment tree (fast)', treeFetches === 0, `${treeFetches} tree fetch(es)`);
check('sources: HN post text recorded', res.hit.sources.selftext === true, String(res.hit.sources.selftext));
check('sources: article hint on (has URL, proxy off)', res.hit.sources.articleAvailable === true, String(res.hit.sources.articleAvailable));
check('describeSources reflects the cached sources', /post text/i.test(res.line), res.line);
check('no-URL item does not show the article hint', res.noUrlAvailable === false, String(res.noUrlAvailable));
check('article proxy name survives the cache (via <proxy>)', res.proxProxy === 'codetabs', String(res.proxProxy));
check('extracted article text is returned for the sources view', res.proxText === 'the extracted body', res.proxText);

await b.close();
console.log(`\n${fails.length === 0 ? 'RESULT: SUMMARY SOURCES + CACHE PASS \u2713' : `RESULT: ${fails.length} FAILED`}`);
process.exit(fails.length ? 1 : 0);
