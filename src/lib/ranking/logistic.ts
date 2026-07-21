import { FEATURE_DIM } from './features';
import { kvGet, kvSet } from '../db';

export interface LogisticModel {
  w: number[];
  b: number;
  n: number; // training examples seen
  updatedAt: number;
}

const KV_KEY = 'model:logistic';

// The learned reranker is only APPLIED once it's trained on at least this many of
// your interactions. Below it, a handful of labels produce noisy, contradictory
// weights and a meaningless "% chance" — so the feed falls back to the manual
// weighted blend and the "Why #N?" explainer says the model is still learning.
export const MIN_TRAIN_SAMPLES = 12;

export function emptyModel(): LogisticModel {
  return { w: new Array(FEATURE_DIM).fill(0), b: 0, n: 0, updatedAt: 0 };
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

  return { w, b, n: base.n + m, updatedAt: Date.now() };
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
  for (let e = 0; e < epochs; e++) {
    const g = new Array(FEATURE_DIM).fill(0);
    for (const d of diffs) {
      let z = 0;
      for (let i = 0; i < FEATURE_DIM; i++) z += w[i] * d[i];
      const err = sigmoid(z) - 1; // want sigmoid(z) → 1 (pos ranked above neg)
      for (let i = 0; i < FEATURE_DIM; i++) g[i] += err * d[i];
    }
    for (let i = 0; i < FEATURE_DIM; i++) w[i] -= lr * (g[i] / m + l2 * w[i]);
  }
  return w;
}

/**
 * Platt scaling: fit scale `a` and bias `b` so that P(engage) ≈ sigmoid(a·(w·x)+b)
 * on the real class distribution — turns raw ranking scores into *calibrated*
 * probabilities (so the "% chance you'll engage" in the explainer is meaningful).
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
  const w = wRank.map((v) => v * a);
  return { w, b, n: samples.length, updatedAt: Date.now() };
}

export async function loadModel(): Promise<LogisticModel> {
  const stored = await kvGet<LogisticModel>(KV_KEY);
  if (stored && Array.isArray(stored.w) && stored.w.length === FEATURE_DIM) return stored;
  return emptyModel();
}

export async function saveModel(model: LogisticModel): Promise<void> {
  await kvSet(KV_KEY, model);
}
