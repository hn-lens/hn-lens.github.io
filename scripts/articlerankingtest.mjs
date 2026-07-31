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

// --- L3: the article-relevance guard used by the summary + Ask paths (dropping a cookie-wall /
// paywall / unrelated page the proxy returned so it isn't fed to the model nor labelled "+ article
// text") now lives in hn/article, shared by every consumer. Unit-check it here via window.__hnlens.
// The RANKING path deliberately does NOT gate cachedArticleTerms on it: an off-topic page's terms
// rarely match the liked profile anyway, and gating there would false-drop a legit vague-title
// article (the train/serve fixture below is exactly such a case — neutral title, on-topic body).
const guard = await page.evaluate(async () => {
  const art = await window.__hnlens.article();
  const title = 'quokka telemetry sharding pipeline internals';
  return {
    relevantFn: art.articleLooksRelevant(title, 'quokka telemetry sharding pipeline internals and ingest details, discussed at length.'),
    irrelevantFn: art.articleLooksRelevant(title, 'Please enable cookies to continue. Subscribe now for celebrity gossip and sports scores.'),
    shortTitlePermissive: art.articleLooksRelevant('Ask HN', 'literally any body text at all goes here'),
  };
});
check(
  'articleLooksRelevant (shared in hn/article): true on-topic, false off-topic, permissive on a too-short title',
  guard.relevantFn === true && guard.irrelevantFn === false && guard.shortTitlePermissive === true,
  JSON.stringify(guard)
);

// --- TRAIN/SERVE PARITY: training must see the SAME termAffinity distribution as serving ---
// Regression for a silent train-serve skew: the SERVING path (useFeed) folded each candidate's cached
// article body into termAffinity, but the TRAINING path omitted `articleTerms` — so the model fitted a
// weight against a near-zero title-only signal and then applied it to a much larger serve-time one,
// mis-scaling that feature (and the calibrated P(engage) the explainer prints) for exactly the stories
// the reader proxy had fetched. Drives the REAL buildTrainingSamples() and asserts the training feature
// vector actually carries the article-derived termAffinity (feature index 6).
const TERM_AFFINITY_IX = 6;
const parity = await page.evaluate(async (ix) => {
  const i = await window.__hnlens.interactions();
  const dbMod = await window.__hnlens.db();
  const train = window.__hnlens.train();
  const t = Date.now();
  const mk = (id, title) => ({ id, type: 'story', by: `a${id}`, title, url: `https://p${id}.example.com/x`, score: 50, descendants: 3, time: Math.floor(t / 1000) - 3600 });
  const run = async (fetchArticleText) => {
    await i.clearAllData();
    await dbMod.db.kv.where('key').startsWith('atext:').delete();
    await dbMod.db.kv.where('key').startsWith('aterms:').delete();
    window.__hnlens.prefs.getState().set({ fetchArticleText, embeddingsEnabled: false, useLearnedRanker: true });
    // 5001: NEUTRAL title, but a cached article body full of the distinctive terms.
    // 5002/5003: engaged peers whose TITLES carry those terms → with leave-one-out they (not 5001)
    // supply the liked-term profile, so 5001 can only score if its ARTICLE body is read.
    // 5009: an impressed-but-ignored negative, so training has both classes.
    const items = [
      mk(5001, 'an unremarkable weekend note'),
      mk(5002, 'quokka telemetry ingest pipeline'),
      mk(5003, 'quokka telemetry sharding notes'),
      mk(5009, 'completely unrelated gardening post'),
    ];
    await dbMod.db.items.bulkPut(items.map((it) => ({ id: it.id, item: it, cachedAt: t })));
    await dbMod.kvSet('atext:5001', { text: 'quokka telemetry ingest sharding pipeline internals '.repeat(6), proxy: 'AllOrigins' });
    const evs = [];
    for (const id of [5001, 5002, 5003]) {
      evs.push({ type: 'open_link', itemId: id, domain: `p${id}.example.com`, author: `a${id}`, ts: t - 50000 });
      evs.push({ type: 'dwell', itemId: id, domain: `p${id}.example.com`, author: `a${id}`, value: 70000, ts: t - 49000 });
    }
    evs.push({ type: 'impression', itemId: 5009, domain: 'p5009.example.com', author: 'a5009', ts: t - 48000 });
    await dbMod.db.events.bulkAdd(evs);
    const { samples, sampleIds } = await train.buildTrainingSamples();
    const k = sampleIds.indexOf(5001);
    return k < 0 ? null : +(samples[k].x[ix] ?? 0).toFixed(4);
  };
  return { on: await run(true), off: await run(false) };
}, TERM_AFFINITY_IX);
check(
  'TRAINING folds the article body into termAffinity when the reader proxy is ON (no train/serve skew)',
  parity.on !== null && parity.on > 0.05,
  `trainingTermAffinity(on)=${parity.on}`
);
check(
  'TRAINING still ignores the article body when the reader proxy is OFF (flag respected)',
  parity.off !== null && Math.abs(parity.off) < 0.01,
  `trainingTermAffinity(off)=${parity.off}`
);

await b.close();
console.log(`\n${fails.length === 0 ? 'RESULT: ARTICLE RANKING PASS \u2713' : `RESULT: ${fails.length} FAILED`}`);
process.exit(fails.length ? 1 : 0);
