// Article-text-in-ranking test — guards the change: a candidate story's OWN fetched
// article body (not just its title) now influences its termAffinity, so the learned
// reranker takes the full text into account. Drives the REAL content module via
// window.__hnlens.content(), gated by the articleTerms flag.
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:4173/';
const fails = [];
const check = (name, pass, detail = '') => {
  console.log(`  ${pass ? '\u2713' : '\u2717'} ${name}${detail ? ` \u2014 ${detail}` : ''}`);
  if (!pass) fails.push(name);
};

const b = await chromium.launch({ headless: true });
const page = (await b.newContext({ viewport: { width: 1000, height: 800 } })).pages()[0] || (await b.newPage());
await page.route(/hacker-news\.firebaseio\.com|hn\.algolia\.com|google\.com\/s2/, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__hnlens && window.__hnlens.content && window.__hnlens.db, null, { timeout: 20000 });

const r = await page.evaluate(async () => {
  const content = window.__hnlens.content();
  const dbMod = await window.__hnlens.db();
  await dbMod.db.kv.where('key').startsWith('atext:').delete();
  await dbMod.db.kv.where('key').startsWith('aterms:').delete();

  // A profile that "likes" the terms wasm/runtime (as if from engaged history).
  const profile = {
    model: '', hasEmbeddings: false, withComments: false,
    likedDf: new Map([['wasm', 1], ['runtime', 1], ['sandbox', 1]]), dislikedDf: new Map(),
    likedDocN: 1, dislikedDocN: 0,
    likedTermsById: new Map(), dislikedTermsById: new Map(),
    likedVecSum: null, likedN: 0, likedVecById: new Map(),
  };
  // A candidate whose TITLE has none of the liked terms.
  const cand = { id: 42, title: 'a neutral systems overview' };
  const base = content.termAffinity(cand, profile);
  const withArticle = content.termAffinity(cand, profile, undefined, ['wasm', 'runtime', 'sandbox']);

  // cachedArticleTerms reads a seeded body (no network) and tokenizes it.
  await dbMod.kvSet('atext:42', { text: 'A deep dive into the wasm runtime and its sandbox isolation model.', proxy: 'AllOrigins' });
  const at = await content.cachedArticleTerms(42);

  // computeContentSignals: candidate 42 has an article body with the liked terms;
  // candidate 43 has an equally-neutral title and NO article body.
  const c42 = { id: 42, title: 'a neutral systems overview' };
  const c43 = { id: 43, title: 'a neutral systems overview two' };
  const withFlag = await content.computeContentSignals('', [c42, c43], profile, { articleTerms: true });
  const noFlag = await content.computeContentSignals('', [c42, c43], profile, { articleTerms: false });
  return {
    base, withArticle, at,
    withFlag42: +(withFlag.termById.get(42) ?? 0).toFixed(4), withFlag43: +(withFlag.termById.get(43) ?? 0).toFixed(4),
    noFlag42: +(noFlag.termById.get(42) ?? 0).toFixed(4), noFlag43: +(noFlag.termById.get(43) ?? 0).toFixed(4),
  };
});

// Embedding relevance now folds in the article body: the text that gets embedded
// includes it when present (so `relevance`, not just termAffinity, reflects full text).
const emb = await page.evaluate(async () => {
  const e = await window.__hnlens.embeddings();
  const item = { id: 1, title: 'Rust memory model', text: '' };
  const titleOnly = e.embedTextForItem(item, '');
  const withArticle = e.embedTextForItem(item, 'A deep discussion of ownership and borrowing and lifetimes.');
  return { titleOnly, withArticle };
});
check('embed text is title+selftext only without an article', emb.titleOnly.includes('Rust memory model') && !/ownership/.test(emb.titleOnly), emb.titleOnly);
check('embed text folds in the article body when present (relevance uses full text)', /ownership/.test(emb.withArticle) && /borrowing/.test(emb.withArticle), emb.withArticle.slice(0, 80));

check('candidate title alone (no liked terms) → ~0 affinity', Math.abs(r.base) < 0.01, String(r.base));
check("adding the candidate's article-body terms lifts termAffinity", r.withArticle > r.base + 0.05, `${r.withArticle} vs ${r.base}`);
check('cachedArticleTerms tokenizes the cached body (no network)', r.at.includes('wasm') && r.at.includes('runtime'), JSON.stringify(r.at));
check('computeContentSignals(articleTerms:true) ranks the article-matching candidate higher', r.withFlag42 > r.withFlag43 + 0.05, `42=${r.withFlag42} vs 43=${r.withFlag43}`);
check('computeContentSignals(articleTerms:false) ignores article body (titles equally neutral)', Math.abs(r.noFlag42 - r.noFlag43) < 0.01, `42=${r.noFlag42} vs 43=${r.noFlag43}`);

await b.close();
console.log(`\n${fails.length === 0 ? 'RESULT: ARTICLE RANKING PASS \u2713' : `RESULT: ${fails.length} FAILED`}`);
process.exit(fails.length ? 1 : 0);
