// Learned-ranker min-sample gate test — guards the trust fix: with only a handful
// of interactions the logistic model produces noisy, contradictory weights and a
// meaningless "% chance". The reranker must NOT be applied (and the "Why #N?"
// explainer must say so) until it's trained on >= MIN_TRAIN_SAMPLES interactions.
// Drives the REAL ranking modules via window.__hnlens.
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:4173/';

const fails = [];
const check = (name, pass, detail = '') => {
  console.log(`  ${pass ? '\u2713' : '\u2717'} ${name}${detail ? ` \u2014 ${detail}` : ''}`);
  if (!pass) fails.push(name);
};

const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
const page = ctx.pages()[0] || (await ctx.newPage());
await page.route(/hacker-news\.firebaseio\.com/, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
await page.route(/hn\.algolia\.com|google\.com\/s2/, (r) => r.fulfill({ status: 200, body: '{}' }));
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__hnlens && window.__hnlens.strategies && window.__hnlens.logistic, null, { timeout: 20000 });

const res = await page.evaluate(() => {
  const H = window.__hnlens;
  const strat = H.strategies();
  // Ensure the learned signal has a non-zero blend weight so "applied" is visible.
  const cur = H.prefs.getState();
  cur.set({ weights: { ...cur.weights, learned: 1 } });
  const prefs = H.prefs.getState();
  const ctx = strat.makeContext(prefs, { domains: {}, authors: {} });
  const item = { id: 1, type: 'story', by: 'alice', title: 'A story about rust systems', url: 'https://ex.com/x', score: 120, descendants: 20, time: Math.floor(Date.now() / 1000) - 3600 };
  const DIM = H.features().FEATURE_DIM; // model weight vector length (kept in sync with featureVector)
  const mk = (n) => ({ w: new Array(DIM).fill(0.4), b: 0.3, n, updatedAt: 0 });
  const min = H.logistic().MIN_TRAIN_SAMPLES;
  const exLow = strat.explainItem(item, ctx, mk(min - 1));
  const exHigh = strat.explainItem(item, ctx, mk(min + 8));
  const sNone = strat.scoreItem(item, ctx, undefined).score;
  const sLow = strat.scoreItem(item, ctx, mk(min - 1)).score;
  const sHigh = strat.scoreItem(item, ctx, mk(min + 8)).score;
  return {
    min, lowUsed: exLow.learned.used, lowEx: exLow.learned.examples, highUsed: exHigh.learned.used, sNone, sLow, sHigh,
    dim: H.features().FEATURE_DIM,
    modelLabels: exHigh.learned.terms.map((t) => t.label),
  };
});

check('a sensible minimum-sample gate exists (>= 8)', res.min >= 8, `MIN_TRAIN_SAMPLES=${res.min}`);
check('learned model NOT applied below the gate', res.lowUsed === false, `n=${res.min - 1}`);
check('explainer still reports the true trained example count', res.lowEx === res.min - 1, `examples=${res.lowEx}`);
check('learned model IS applied at/above the gate', res.highUsed === true, `n=${res.min + 8}`);
// Tolerance, not exact equality: below the gate the learned term is OFF, so the ONLY
// difference between these two scoreItem calls is `recency`, which reads wall-clock now —
// under load the two calls land a few ms apart and drift ~1e-8. 1e-6 is ~5 orders of
// magnitude below the ~0.6 the learned term moves the score when it IS applied (asserted
// next), so this still catches a real gating leak while tolerating recency drift.
check('below-gate score == no-model score (learned contributes nothing)', Math.abs(res.sLow - res.sNone) < 1e-6, `${res.sLow} vs ${res.sNone}`);
check('at/above-gate score differs (learned actually applied)', Math.abs(res.sHigh - res.sNone) > 1e-9, `${res.sHigh} vs ${res.sNone}`);
// EXPLICIT-preference signals (followed domain/user, boost keyword) must NOT be learned
// features — they're deterministic blend inputs, and learning a (negative) weight for them
// made the "Why #N?" explainer contradict itself on a followed-domain #1 card. Guard that
// the learned-model breakdown never surfaces them again.
check('learned model has no explicit-preference features (no contradictory bars)',
  !res.modelLabels.some((l) => /followed|boost keyword/i.test(l)),
  JSON.stringify(res.modelLabels));

await b.close();
console.log(`\n${fails.length === 0 ? 'RESULT: RANKER GATE PASS \u2713' : `RESULT: ${fails.length} FAILED`}`);
process.exit(fails.length ? 1 : 0);
