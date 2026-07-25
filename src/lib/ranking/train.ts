import { getCachedItems } from '../hn/client';
import { classifyEngagement, computeAffinities, eventsSnapshot } from '../interactions';
import { usePrefs } from '../prefs';
import { computeFeatures, featureVector } from './features';
import { makeContext } from './strategies';
import { buildContentProfile, computeContentSignals } from './content';
import { saveModel, trainRanker } from './logistic';
import type { LogisticModel, Sample } from './logistic';
import type { HnItem } from '../../types';

export interface TrainResult {
  model: LogisticModel;
  positives: number;
  negatives: number;
}

export interface TrainingData {
  samples: Sample[];
  sampleIds: number[]; // item id for each sample (same order) — for inspection/proof
  positives: number;
  negatives: number;
}

/**
 * Turn locally-recorded interaction history into labelled logistic-regression
 * samples: engaged items → 1, impressed-but-ignored and hidden items → 0.
 * Exposed (and used by `trainFromHistory`) so the proof harness can inspect and
 * evaluate the exact same samples the trainer fits on (loss curve / AUC).
 */
export async function buildTrainingSamples(): Promise<TrainingData> {
  // Shared with the other derivations (see interactions.eventsSnapshot) — same rows, one read.
  const events = await eventsSnapshot();
  // Dwell-aware engagement classes — the SAME `classifyEngagement` (interactions.ts) the content
  // profile's LIKED set uses, so labels and content features can't drift (a bounce is a negative in
  // BOTH). `engaged` is the positive set (strong actions + genuine reads + discussion stays +
  // imported declared engagement + non-bounced opens, with hidden removed — MONOTONIC).
  const { engaged, bounced, impressed, hidden } = classifyEngagement(events);

  const negatives = new Set<number>();
  for (const id of impressed) if (!engaged.has(id)) negatives.add(id);
  for (const id of bounced) if (!engaged.has(id)) negatives.add(id);
  for (const id of hidden) negatives.add(id); // hidden already removed from `engaged` by the classifier

  // Resolve the actual items first so content signals can be computed for the
  // whole training set at once (needed for leave-one-out).
  const prefs = usePrefs.getState();
  // CACHE-ONLY (see `getCachedItems`). Training runs in the background after every engagement and
  // must do NO network I/O — the article path already honoured that, but this item loop fell through
  // to a fetch for anything older than ITEM_TTL, i.e. all of yesterday's history, hundreds of
  // requests SEQUENTIALLY. These are items the user already opened, so they are already cached.
  const engagedItems: HnItem[] = await getCachedItems([...engaged]);
  const negativeItems: HnItem[] = await getCachedItems([...negatives]);
  const allItems = [...engagedItems, ...negativeItems];

  // Content signals (embedding relevance + title/comment term affinity) with
  // leave-one-out: each training item is removed from its own profile so its
  // label doesn't leak into its features.
  const profile = await buildContentProfile(prefs.embeddingModel, {
    withComments: prefs.embeddingsEnabled,
    embeddings: prefs.embeddingsEnabled,
    fetchArticle: prefs.fetchArticleText,
  });
  // `articleTerms` MUST mirror the SERVING path (`useFeed`), or the model learns a weight for a
  // title-only termAffinity/relevance distribution and then applies it to a title+article one at
  // serve time — a train-serve skew that silently mis-scales the feature (and the calibrated
  // P(engage) the explainer shows) for exactly the stories the reader proxy fetched. Reads the
  // article CACHE only (`cachedArticleTerms`), so training still performs no network I/O.
  const { simById, termById } = await computeContentSignals(prefs.embeddingModel, allItems, profile, {
    loo: true,
    articleTerms: prefs.fetchArticleText,
  });

  const affinities = await computeAffinities();
  const ctx = makeContext(prefs, affinities, { simById, termById });

  // NOTE: leave-one-out for the behavioural features now lives in `computeFeatures` (features.ts),
  // so it applies to the SERVE path as well as this one — a story must not be scored on the affinity
  // it generated itself, whether we are fitting on it or ranking it. The training-only copy that used
  // to live here was removed; keeping both subtracted twice.
  const samples: Sample[] = [];
  const sampleIds: number[] = [];
  const push = (items: HnItem[], y: number) => {
    for (const it of items) {
      samples.push({ x: featureVector(computeFeatures(it, ctx)), y });
      sampleIds.push(it.id);
    }
  };
  push(engagedItems, 1);
  push(negativeItems, 0);

  return { samples, sampleIds, positives: engagedItems.length, negatives: negativeItems.length };
}

/** Train the logistic reranker from locally-recorded interaction history, using a
 * pairwise learning-to-rank objective + probability calibration. Retrains from
 * scratch each time so the example count reflects the data you actually have. */
export async function trainFromHistory(): Promise<TrainResult> {
  const { samples, positives, negatives } = await buildTrainingSamples();
  const posX = samples.filter((s) => s.y === 1).map((s) => s.x);
  const negX = samples.filter((s) => s.y === 0).map((s) => s.x);
  const model = trainRanker(posX, negX, { epochs: 200, lr: 0.3, l2: 0.01 });
  await saveModel(model);
  return { model, positives, negatives };
}
