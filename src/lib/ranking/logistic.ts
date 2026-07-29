import { FEATURE_DIM } from './features';
import { kvGet, kvSet } from '../db';

export interface LogisticModel {
  w: number[];
  b: number;
  n: number; // training examples seen
  pos?: number; // POSITIVE examples (engaged) among them
  /** Held-out AUC of this fit (0.5 = chance). Decides how much authority the blend grants it. */
  auc?: number;
  updatedAt: number;
}

const KV_KEY = 'model:logistic';

// The learned reranker is only APPLIED once it's trained on at least this many of
// your interactions. Below it, a handful of labels produce noisy, contradictory
// weights and a meaningless "% chance" — so the feed falls back to the manual
// weighted blend and the "Why #N?" explainer says the model is still learning.
export const MIN_TRAIN_SAMPLES = 12;
// ...and at least this many POSITIVES: 11 skips + 1 click is 12 samples but carries no real
// preference signal, so gating on total alone could "activate" on ~1 engagement.
export const MIN_TRAIN_POSITIVES = 3;

export function emptyModel(): LogisticModel {
  return { w: new Array(FEATURE_DIM).fill(0), b: 0, n: 0, pos: 0, updatedAt: 0 };
}

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));

export function predictProba(model: LogisticModel, x: number[]): number {
  let z = model.b;
  for (let i = 0; i < model.w.length && i < x.length; i++) z += model.w[i] * x[i];
  return sigmoid(z);
}

export interface Sample {
  x: number[];
  y: number; // 0 or 1
}

/** Batch gradient descent with L2 regularization. Returns a new model. */
export function trainModel(
  base: LogisticModel,
  samples: Sample[],
  opts: { epochs?: number; lr?: number; l2?: number } = {}
): LogisticModel {
  const epochs = opts.epochs ?? 60;
  const lr = opts.lr ?? 0.1;
  const l2 = opts.l2 ?? 0.001;
  if (!samples.length) return base;

  const w = base.w.slice();
  let b = base.b;
  const m = samples.length;

  for (let epoch = 0; epoch < epochs; epoch++) {
    const gw = new Array(FEATURE_DIM).fill(0);
    let gb = 0;
    for (const s of samples) {
      let z = b;
      for (let i = 0; i < FEATURE_DIM; i++) z += w[i] * (s.x[i] ?? 0);
      const err = sigmoid(z) - s.y;
      for (let i = 0; i < FEATURE_DIM; i++) gw[i] += err * (s.x[i] ?? 0);
      gb += err;
    }
    for (let i = 0; i < FEATURE_DIM; i++) w[i] -= lr * (gw[i] / m + l2 * w[i]);
    b -= lr * (gb / m);
  }

  return { w, b, n: base.n + m, pos: (base.pos ?? 0) + samples.filter((s) => s.y === 1).length, updatedAt: Date.now() };
}

/**
 * Pairwise learning-to-rank (RankNet-style): learn weights so engaged items
 * score above skipped ones. Equivalent to logistic regression on the pairwise
 * feature differences (x_pos − x_neg) with label 1 — no bias (it cancels in
 * differences). Optimizes the actual *ranking* task rather than pointwise
 * classification. Returns just the weight vector.
 */
export function trainPairwise(
  posX: number[][],
  negX: number[][],
  opts: { epochs?: number; lr?: number; l2?: number; maxPairs?: number } = {}
): number[] {
  const epochs = opts.epochs ?? 200;
  const lr = opts.lr ?? 0.3;
  const l2 = opts.l2 ?? 0.01;
  const maxPairs = opts.maxPairs ?? 4000;
  const w = new Array(FEATURE_DIM).fill(0);
  if (!posX.length || !negX.length) return w;

  // Evenly subsample pairs to bound cost (deterministic — reproducible proof).
  const total = posX.length * negX.length;
  const stride = Math.max(1, Math.floor(total / maxPairs));
  const diffs: number[][] = [];
  let k = 0;
  for (const p of posX) {
    for (const n of negX) {
      if (k++ % stride === 0) {
        const d = new Array(FEATURE_DIM);
        for (let i = 0; i < FEATURE_DIM; i++) d[i] = (p[i] ?? 0) - (n[i] ?? 0);
        diffs.push(d);
      }
    }
  }
  const m = diffs.length || 1;

  // Standardise each feature's SCALE for the fit. Gradient descent with one shared learning rate
  // and one shared L2 is not scale-invariant: a feature whose differences are numerically large
  // takes big steps and soaks up the available weight, while a small-scale feature is starved and
  // is additionally penalised harder by L2 (which is applied to the raw weight, so a feature
  // needing a large coefficient to matter is taxed for it). That is not a preference the DATA
  // expressed — it is an artefact of the units.
  //
  // It bit the feature that matters most for DISCOVERY. Domain/author affinity is large whenever
  // the source is already in the reader's history, and identically 0 when it is not; the content
  // features (relevance, termAffinity) are the only ones that can transfer to an unfamiliar
  // source, and they live on a much smaller scale. So the fit concentrated weight on features that
  // are structurally 0 for every new source (measured 8.61 vs 0.59) and the learned model had
  // almost nothing to say about a story from a site the reader had never visited.
  //
  // Fit on d/s, then FOLD THE SCALE BACK IN (w = w'/s) so the returned weights still apply to RAW
  // features. That keeps the external contract byte-identical — `scoreItem`, Platt calibration and
  // the "Why #N?" per-feature contributions all keep consuming raw feature values — and changes
  // only the optimisation geometry, which is the whole point. Dividing by a positive scale also
  // preserves sign, so the w >= 0 projection below is unaffected.
  //
  // The scale is measured on the TRAINING-PAIR spread, but the weights are applied to raw
  // SERVE-time features whose range is fixed by the feature definition (about +-1), not by that
  // spread. So a feature that barely varies in training but has full range at serve time gets its
  // weight multiplied by 1/tiny. That is not hypothetical: serve-time leave-one-out makes
  // `domainAffinity` near-CONSTANT across training pairs (most of a reader's history is one item
  // per domain, so removing the item's own contribution zeroes it), giving an RMS around 0.001 and
  // a ~1000x fold-back. Measured on live HN data across 5 engagement rates, 4 of 5 produced a max
  // weight of 553-595 against 0.07-1.5 unstandardised, collapsing the learned signal into a
  // one-feature step function — P(engage) swinging 0.0000 to 1.0000 across a 0.04-wide slice, which
  // is *worse* than the single-feature domination standardisation was added to fix.
  //
  // Floor the scale at a meaningful fraction of that declared range. A feature whose training
  // spread is below the floor carries little information, and amplifying it is precisely wrong —
  // the floor caps inflation at 1/SCALE_FLOOR instead of leaving it unbounded. An exactly-constant
  // feature still contributes nothing (its gradient is 0 either way).
  const SCALE_FLOOR = 0.1; // features are bounded to ~[-1,1], so this caps amplification at 10x
  const scale = new Array(FEATURE_DIM).fill(1);
  for (let i = 0; i < FEATURE_DIM; i++) {
    let sum = 0;
    for (const d of diffs) sum += (d[i] ?? 0) ** 2;
    const rms = Math.sqrt(sum / m);
    scale[i] = Math.max(rms, SCALE_FLOOR);
  }
  for (const d of diffs) for (let i = 0; i < FEATURE_DIM; i++) d[i] = (d[i] ?? 0) / scale[i];

  for (let e = 0; e < epochs; e++) {
    const g = new Array(FEATURE_DIM).fill(0);
    for (const d of diffs) {
      let z = 0;
      for (let i = 0; i < FEATURE_DIM; i++) z += w[i] * d[i];
      const err = sigmoid(z) - 1; // want sigmoid(z) → 1 (pos ranked above neg)
      for (let i = 0; i < FEATURE_DIM; i++) g[i] += err * d[i];
    }
    // Monotonic (non-negative) constraint via projected gradient descent. Every
    // feature in the vector is "higher = more likely a good recommendation"
    // (popularity, recency, discussion, relevance, the affinity/term signals, and
    // their positive crosses). A NEGATIVE learned weight on any of them would demote
    // an item for a GOOD property — e.g. rank a FRESHER story LOWER — which is both
    // wrong and makes the "Why #N?" explainer contradict itself. Clamp w >= 0 so a
    // higher signal never hurts; genuine dislike still demotes via NEGATIVE feature
    // *values* (affinity/termAffinity range -1..1), not via negative weights.
    for (let i = 0; i < FEATURE_DIM; i++) w[i] = Math.max(0, w[i] - lr * (g[i] / m + l2 * w[i]));
  }
  // Back to raw-feature units (see the standardisation note above).
  for (let i = 0; i < FEATURE_DIM; i++) w[i] /= scale[i];
  return w;
}

/**
 * Platt scaling: fit scale `a` and bias `b` so that P(engage) ≈ sigmoid(a·(w·x)+b).
 *
 * Fitted IN-SAMPLE, on the same rows the weights were fitted on (see `trainRanker`). On a separable
 * fit that sharpens the step rather than calibrating it, so the resulting probability can sit far
 * from the reader's actual engagement rate. Treat it as a monotone rescaling of the ranking score,
 * not as a trustworthy probability.
 */
export function calibrate(
  w: number[],
  samples: Sample[],
  opts: { epochs?: number; lr?: number } = {}
): { a: number; b: number } {
  const epochs = opts.epochs ?? 400;
  const lr = opts.lr ?? 0.2;
  let a = 1;
  let b = 0;
  if (!samples.length) return { a, b };
  const scores = samples.map((s) => {
    let z = 0;
    for (let i = 0; i < FEATURE_DIM; i++) z += w[i] * (s.x[i] ?? 0);
    return z;
  });
  const m = samples.length;
  for (let e = 0; e < epochs; e++) {
    let ga = 0;
    let gb = 0;
    for (let j = 0; j < m; j++) {
      const err = sigmoid(a * scores[j] + b) - samples[j].y;
      ga += err * scores[j];
      gb += err;
    }
    a -= (lr * ga) / m;
    b -= (lr * gb) / m;
  }
  return { a, b };
}

/**
 * Train the reranker: pairwise ranking for the weights, then Platt calibration
 * for probabilities. The stored weights fold in the calibration scale, so both
 * ranking (w·x) and P(engage) = sigmoid(w·x+b) come from one weight vector — and
 * the "Why #N?" explainer stays exact.
 */
export function trainRanker(
  posX: number[][],
  negX: number[][],
  opts: { epochs?: number; lr?: number; l2?: number; maxPairs?: number } = {}
): LogisticModel {
  const wRank = trainPairwise(posX, negX, opts);
  const samples: Sample[] = [
    ...posX.map((x) => ({ x, y: 1 })),
    ...negX.map((x) => ({ x, y: 0 })),
  ];
  const { a, b } = calibrate(wRank, samples);
  // The calibration scale must stay non-negative, so it can't flip the (already non-negative)
  // ranking weights to negative. But clamping to 0 — which is what `Math.max(a, 0)` did — multiplies
  // EVERY weight by zero and throws the whole model away: `rankerTrained` requires at least one
  // non-zero weight, so the reranker then reports "still learning" forever, with no diagnostic and
  // no way for the reader to escape by using the app more.
  //
  // A degenerate `a` only means the probability CALIBRATION could not be fitted. `wRank` is still a
  // perfectly good ranking direction — it is sign-constrained and was fitted on the pairwise
  // objective that actually drives the feed. So fall back to the uncalibrated ranking weights
  // instead of discarding them; ordering is preserved and only the absolute probability is less
  // meaningful.
  const aPos = a > 0 ? a : 1;
  const w = wRank.map((v) => v * aPos);
  return { w, b, n: samples.length, pos: posX.length, auc: heldOutAuc(posX, negX, opts), updatedAt: Date.now() };
}

/**
 * How well this fit separates engaged from skipped on data it did NOT train on.
 *
 * Recorded because the ranking blend has to decide how much authority to give the model, and
 * "how confident does it sound" is not the same question as "is it right". Normalising a model's
 * output so it always occupies a fair share of the blend is correct for a model that discriminates
 * and actively harmful for one that does not — it would promote rounding noise to full authority —
 * so the blend needs an honest measure of which it is holding. 0.5 is chance.
 *
 * Deterministic (strided) rather than random: this runs in the browser on every retrain, and the
 * number scales the learned term's authority, not reports a precise score. See `heldOutAuc` for the
 * 3-fold averaging.
 */
function heldOutAuc(posX: number[][], negX: number[][], opts: Parameters<typeof trainPairwise>[2]): number {
  // STRIDED, not contiguous. Samples arrive in time order, so slicing off the tail hands the test
  // set a different period of the reader's history than the fit saw — measured on a realistic
  // history that reported 0.514 (chance) for a model scoring 0.603 on the pool, which would have
  // denied a working model the authority this number exists to grant it. Every third sample is
  // held out instead, so both halves span the whole history. Deterministic either way.
  // ALL THREE strided folds, averaged. One fold on a small history leaves ~6 held-out positives,
  // and a single estimate off that many points swung 0.298-0.816 across seeded histories with
  // NOTHING to learn — far too noisy to hand authority to. Averaging the folds costs two more fits
  // of a tiny model and makes the number worth leaning on.
  const aucs: number[] = [];
  for (let fold = 0; fold < 3; fold++) {
    const isTest = (i: number) => i % 3 === fold;
    const a = foldAuc(
      posX.filter((_, i) => !isTest(i)), negX.filter((_, i) => !isTest(i)),
      posX.filter((_, i) => isTest(i)), negX.filter((_, i) => isTest(i)), opts
    );
    if (a !== null) aucs.push(a);
  }
  return aucs.length ? aucs.reduce((x, y) => x + y, 0) / aucs.length : 0.5;
}

function foldAuc(
  pTrain: number[][], nTrain: number[][], pTest: number[][], nTest: number[][],
  opts: Parameters<typeof trainPairwise>[2]
): number | null {
  // Too little held out to say anything.
  if (pTrain.length < 3 || nTrain.length < 3 || pTest.length === 0 || nTest.length === 0) return null;
  const w = trainPairwise(pTrain, nTrain, opts);
  const score = (x: number[]) => x.reduce((acc, v, i) => acc + v * (w[i] ?? 0), 0);
  const ps = pTest.map(score);
  const ns = nTest.map(score);
  let wins = 0;
  for (const a2 of ps) for (const b2 of ns) wins += a2 > b2 ? 1 : a2 === b2 ? 0.5 : 0;
  return wins / (ps.length * ns.length);
}

export async function loadModel(): Promise<LogisticModel> {
  const stored = await kvGet<LogisticModel>(KV_KEY);
  if (stored && Array.isArray(stored.w) && stored.w.length === FEATURE_DIM) return stored;
  return emptyModel();
}

export async function saveModel(model: LogisticModel): Promise<void> {
  await kvSet(KV_KEY, model);
}
