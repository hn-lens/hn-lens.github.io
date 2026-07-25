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
  // A model needs enough samples AND enough POSITIVES; default pos=n for the "healthy" cases.
  const mk = (n, pos = n) => ({ w: new Array(DIM).fill(0.4), b: 0.3, n, pos, updatedAt: 0 });
  const min = H.logistic().MIN_TRAIN_SAMPLES;
  const minPos = H.logistic().MIN_TRAIN_POSITIVES;
  const exLow = strat.explainItem(item, ctx, mk(min - 1));
  const exHigh = strat.explainItem(item, ctx, mk(min + 8));
  const exFewPos = strat.explainItem(item, ctx, mk(min + 8, minPos - 1)); // enough samples, too few positives
  const sNone = strat.scoreItem(item, ctx, undefined).score;
  const sLow = strat.scoreItem(item, ctx, mk(min - 1)).score;
  const sHigh = strat.scoreItem(item, ctx, mk(min + 8)).score;
  return {
    min, minPos, lowUsed: exLow.learned.used, lowEx: exLow.learned.examples, highUsed: exHigh.learned.used,
    fewPosUsed: exFewPos.learned.used, sNone, sLow, sHigh,
    dim: H.features().FEATURE_DIM,
    modelLabels: exHigh.learned.terms.map((t) => t.label),
  };
});

check('a sensible minimum-sample gate exists (>= 8)', res.min >= 8, `MIN_TRAIN_SAMPLES=${res.min}`);
check('learned model NOT applied below the gate', res.lowUsed === false, `n=${res.min - 1}`);
check('explainer still reports the true trained example count', res.lowEx === res.min - 1, `examples=${res.lowEx}`);
check('learned model IS applied at/above the gate', res.highUsed === true, `n=${res.min + 8}`);
// A model can reach the sample count from mostly SKIPS (11 impressions + 1 click) with no real
// preference signal — so it must ALSO have enough positives before it's applied.
check('a sensible minimum-positives gate exists (>= 2)', res.minPos >= 2, `MIN_TRAIN_POSITIVES=${res.minPos}`);
check('learned model NOT applied with enough samples but too few positives', res.fewPosUsed === false, `pos=${res.minPos - 1}`);
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

// --- The learned signal must PRESERVE the model's ranking margin (log-odds, not raw probability) ---
// Regression for: the blend consumed the Platt-CALIBRATED PROBABILITY as if it were a symmetric ±1
// signal. Platt anchors P at the user's base rate, and a normal reader engages with a small minority,
// so a genuinely-good story and a mediocre one both land deep in the sigmoid's flat tail: a model that
// separated them 7:1 in ODDS (P .129 vs .019) produced a learned-term differential of only 0.22, while
// popularity/discussion each swing a full 0..1. The learned term then could not move the feed —
// measured, the user's demonstrated taste could NOT be surfaced at ANY slider setting (even the 2.5
// max), so For You opened with stories on a topic they had never once clicked. Log-odds keeps the
// margin; tanh keeps it bounded to ±1 so the sliders stay commensurate.
const margin = await page.evaluate(() => {
  const s = window.__hnlens.strategies();
  // Degrade to a clean FAILURE (not a crash) if the margin-preserving signal is absent, so this
  // guard reports meaningfully against a build that predates it.
  if (typeof s.learnedSignal !== 'function') return { missing: true };
  const f = (p, br) => +s.learnedSignal(p, br).toFixed(4);
  const baseRate = 0.2;
  return {
    atBase: f(baseRate, baseRate),
    good: f(0.129, baseRate),
    meh: f(0.019, baseRate),
    bounded: [f(0.999999, baseRate), f(0.000001, baseRate)],
    monotone: [f(0.02, baseRate), f(0.1, baseRate), f(0.5, baseRate), f(0.9, baseRate)],
  };
});
check('a margin-preserving learned signal is exposed', !margin.missing, margin.missing ? 'strategies.learnedSignal is absent' : '');
check('a TYPICAL story (P == your base rate) reads exactly 0 (sign is meaningful)',
  !margin.missing && Math.abs(margin.atBase) < 1e-9, `atBase=${margin.atBase}`);
check('a 7:1 odds margin survives calibration (differential >= 0.5; raw probability gave 0.22)',
  !margin.missing && margin.good - margin.meh >= 0.5,
  margin.missing ? 'n/a' : `good=${margin.good} meh=${margin.meh} diff=${(margin.good - margin.meh).toFixed(4)}`);
check('the learned signal stays bounded to ±1 (commensurate with the other signals)',
  !margin.missing && margin.bounded[0] <= 1 && margin.bounded[1] >= -1, JSON.stringify(margin.bounded ?? null));
check('the learned signal is MONOTONE in P (can never reorder against the model)',
  !margin.missing && margin.monotone.every((v, k, a) => k === 0 || v > a[k - 1]), JSON.stringify(margin.monotone ?? null));

// --- the DISPLAYED learned signal must be TWO-SIDED on the candidates actually being ranked ---
// Regression for: it was centered on the TRAINING positive-rate, but the trained weights are
// dominated by domain/author affinity (~0 for any source the user hasn't engaged with), so the
// candidate distribution systematically undershoots that rate — measured 0/20 candidates positive,
// a story the model knew nothing about printing -0.675 of a nominal -1, while the tooltip promised
// "a typical story reads ~0". Centering on THIS POOL's median restores the promise; being one
// constant per pass, it must leave the ORDER untouched.
const pooled = await page.evaluate(async () => {
  const strat = window.__hnlens.strategies();
  const logistic = window.__hnlens.logistic();
  const i = await window.__hnlens.interactions();
  const now = Math.floor(Date.now() / 1000);
  const m = await logistic.loadModel();
  m.w = [0.5, 0.3, 0.4, 4.07, 3.73, 0.6, 1.93, 0, 0, 0]; // affinity-dominated, as trained
  m.b = -2.6; m.n = 100; m.pos = 15; m.updatedAt = Date.now();
  await logistic.saveModel(m);
  const ctx = strat.makeContext(window.__hnlens.prefs.getState(), await i.computeAffinities(), {});
  const items = [...Array(20)].map((_, k) => ({
    id: 9000 + k, type: 'story', by: `new${k}`, title: `fresh story ${k}`,
    url: `https://fresh${k}.dev/x`, score: 20 + k * 7, descendants: 2 + k, time: now - 1800 - k * 60,
  }));
  const val = (c) => items.map((it) => strat.explainItem(it, c, m).terms.find((t) => t.key === 'learned').value);
  const ord = (c) => [...items].map((it) => ({ id: it.id, s: strat.scoreItem(it, c, m).score }))
    .sort((a, z) => z.s - a.s).map((r) => r.id).join(',');
  const centeredCtx = strat.withPoolCenter(items, ctx, m);
  const c = val(centeredCtx);
  return { positives: c.filter((v) => v > 0).length, total: c.length, orderSame: ord(ctx) === ord(centeredCtx) };
});
check('the learned signal is TWO-SIDED across the ranked pool (not one-way negative)',
  pooled.positives > 0 && pooled.positives < pooled.total, `${pooled.positives}/${pooled.total} positive`);
check('re-centering leaves the ranking ORDER unchanged', pooled.orderSame === true, `orderSame=${pooled.orderSame}`);

// --- a DEGENERATE (all-zero-weight) model must not be reported as an active personalization ---
// It yields the identical probability for every story, so it cannot move a single card; counting it
// as "trained" made the sidebar, the explainer and the gate all claim a personalization that
// demonstrably did nothing.
const degenerate = await page.evaluate(async () => {
  const strat = window.__hnlens.strategies();
  const base = { n: 40, pos: 10, b: -1.2, updatedAt: Date.now() };
  return {
    allZero: strat.rankerTrained({ ...base, w: new Array(10).fill(0) }),
    oneNonZero: strat.rankerTrained({ ...base, w: [0, 0, 0, 0, 0, 0, 1.4, 0, 0, 0] }),
  };
});
check('an all-zero-weight model is NOT reported as trained', degenerate.allZero === false, `allZero=${degenerate.allZero}`);
check('a model with any non-zero weight still counts as trained', degenerate.oneNonZero === true, `oneNonZero=${degenerate.oneNonZero}`);

// --- the trained model must stay in a SANE WEIGHT BAND, and calibration must never zero it ---
// Feature standardisation divides pairwise differences by their RMS and folds 1/scale back into raw
// units. That scale is measured on the TRAINING-PAIR spread while the weights are applied to raw
// SERVE-time features whose range is fixed (~[-1,1]), so a feature that barely varies in training
// but has full range at serve time gets an unbounded multiplier. Serve-time leave-one-out makes
// `domainAffinity` near-constant across training pairs, which produced weights of 553-595 (vs
// 0.07-1.5 unstandardised) and collapsed the learned signal into a one-feature step function —
// P(engage) snapping between 0 and 1. Assert the BAND, not a specific value.
const band = await page.evaluate(async () => {
  const logistic = window.__hnlens.logistic();
  const FD = 10;
  // A realistic-shaped set: one feature nearly constant across pairs (the LOO case), the rest
  // varying normally, with a genuine but not separable preference direction.
  const rnd = (seed) => { let x = seed; return () => ((x = (x * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff); };
  const r = rnd(7);
  const mk = (liked) =>
    Array.from({ length: FD }, (_, i) => {
      // Feature 3 models the leave-one-out case that actually caused this: near-constant across
      // TRAINING pairs (spread ~0.002) yet perfectly aligned with the label, so the standardised
      // fit happily loads weight onto it and the 1/scale fold-back then multiplies that weight by
      // ~500. A merely near-constant feature with NO signal does not reproduce the bug, because the
      // fit gives it ~0 weight and 0 x 500 is still 0 — the fixture must have both properties.
      // ~20% label noise: real reading history is never perfectly separable, so a healthy model
      // should NOT be certain here. Without the noise the fixture is linearly separable and even a
      // well-behaved fit saturates legitimately, which would force the threshold below to be
      // loosened until it could no longer fail.
      if (i === 3) { const flip = r() < 0.2; const up = flip ? !liked : liked; return 0.5 + (up ? 0.001 : -0.001) + (r() - 0.5) * 0.0002; }
      return Math.min(1, Math.max(0, (liked ? 0.6 : 0.4) + (r() - 0.5) * 0.5));
    });
  const posX = Array.from({ length: 14 }, () => mk(true));
  const negX = Array.from({ length: 36 }, () => mk(false));
  const m = logistic.trainRanker(posX, negX);
  const probs = [...posX, ...negX].map((x) => logistic.predictProba(m, x));
  return {
    maxW: Math.max(...m.w.map(Math.abs)),
    allZero: m.w.every((v) => v === 0),
    finite: m.w.every((v) => Number.isFinite(v)),
    // A healthy model spreads probabilities; a step function piles them at 0 and 1.
    extreme: probs.filter((p) => p < 0.01 || p > 0.99).length,
    n: probs.length,
  };
});
check('trained weights stay in a sane band (no unbounded 1/scale fold-back)',
  band.maxW < 100, `maxW=${band.maxW?.toFixed?.(2)}`);
check('trained weights are finite and not all zero', band.finite === true && band.allZero === false,
  `finite=${band.finite} allZero=${band.allZero}`);
// A healthy calibrated model spreads probabilities; a saturated step function pins them at 0/1.
// Bar set at HALF the pool: this fixture is genuinely well-separated by its other nine features, so
// a healthy fit legitimately sits around 28% extreme — but pinning MORE than half means the score
// has stopped being a ranking and become a binary switch. Measured 14/50 healthy vs 50/50 with the
// unbounded fold-back, so the bar discriminates with margin in both directions. (The original
// `< n` could not fail at all, which is how 20-of-50 passed.)
check('P(engage) is not a step function across the training pool',
  band.extreme <= band.n * 0.5, `${band.extreme}/${band.n} saturated`);

// Platt calibration failing must DEGRADE to the uncalibrated ranking, never erase the model:
// multiplying every weight by a clamped-to-zero `a` left `rankerTrained` false forever, so the
// reranker reported "still learning" with no diagnostic and no way for the reader to escape.
// Assert the INVARIANT rather than trying to hand-craft a Platt failure: whenever the pairwise fit
// produced a usable ranking direction, calibration must not destroy it. (`w >= 0` legitimately
// zeroing a model whose only signal is "prefer LOWER popularity" is a different, correct case — so
// only compare where trainPairwise itself came back non-zero.)
const plattFallback = await page.evaluate(async () => {
  const logistic = window.__hnlens.logistic();
  const FD = 10;
  const rnd = (seed) => { let x = seed; return () => ((x = (x * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff); };
  const out = [];
  for (const seed of [3, 11, 29, 57, 101]) {
    const r = rnd(seed);
    const mk = (liked) => Array.from({ length: FD }, () => Math.min(1, Math.max(0, (liked ? 0.55 : 0.45) + (r() - 0.5) * 0.6)));
    const posX = Array.from({ length: 12 + (seed % 7) }, () => mk(true));
    const negX = Array.from({ length: 30 + (seed % 11) }, () => mk(false));
    const wRank = logistic.trainPairwise(posX, negX);
    const m = logistic.trainRanker(posX, negX);
    out.push({
      seed,
      rankUsable: wRank.some((v) => v !== 0),
      modelUsable: m.w.some((v) => v !== 0),
    });
  }
  return out;
});
const destroyed = plattFallback.filter((c) => c.rankUsable && !c.modelUsable);
check('calibration never turns a usable ranking into an all-zero model',
  destroyed.length === 0, `${destroyed.length} destroyed of ${plattFallback.length}: ${JSON.stringify(plattFallback)}`);

// The gate must report WHICH clause failed, so the surfaces that explain it cannot drift from it.
const gates = await page.evaluate(async () => {
  const strat = window.__hnlens.strategies();
  const w0 = new Array(10).fill(0);
  const wOk = [0, 0, 1.1, 0, 0, 0, 0, 0, 0, 0];
  return {
    none: strat.rankerGate(undefined),
    few: strat.rankerGate({ n: 3, pos: 1, b: 0, w: wOk, updatedAt: 1 }),
    fewPos: strat.rankerGate({ n: 40, pos: 1, b: 0, w: wOk, updatedAt: 1 }),
    degen: strat.rankerGate({ n: 40, pos: 10, b: 0, w: w0, updatedAt: 1 }),
    ok: strat.rankerGate({ n: 40, pos: 10, b: 0, w: wOk, updatedAt: 1 }),
  };
});
check('rankerGate names the failing clause (not just true/false)',
  gates.none === 'no-model' && gates.few === 'too-few-samples' && gates.fewPos === 'too-few-positives' &&
    gates.degen === 'degenerate' && gates.ok === 'trained',
  JSON.stringify(gates));

await b.close();
console.log(`\n${fails.length === 0 ? 'RESULT: RANKER GATE PASS \u2713' : `RESULT: ${fails.length} FAILED`}`);
process.exit(fails.length ? 1 : 0);
