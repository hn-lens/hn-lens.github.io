import { db } from '../db';
import { getItem } from '../hn/client';
import { computeAffinities, isBounce } from '../interactions';
import { usePrefs } from '../prefs';
import { computeFeatures, featureVector } from './features';
import { makeContext } from './strategies';
import { buildContentProfile, computeContentSignals } from './content';
import { saveModel, trainRanker } from './logistic';
import type { LogisticModel, Sample } from './logistic';
import type { HnItem } from '../../types';

// "Strong" engagement — deliberate actions that always count as a positive,
// regardless of read time. A bare link-open is "weak" and can be demoted to a
// negative if the user bounced straight back (see below).
const STRONG = new Set(['open_comments', 'save', 'upvote_out', 'summarize']);

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
  const events = await db.events.toArray();
  const strong = new Set<number>(); // save / open_comments / upvote_out / summarize
  const opened = new Set<number>(); // open_link (weak)
  const impressed = new Set<number>();
  const hidden = new Set<number>();
  const bounced = new Set<number>(); // opened but returned almost immediately

  for (const e of events) {
    if (!e.itemId) continue;
    if (STRONG.has(e.type)) strong.add(e.itemId);
    else if (e.type === 'open_link') opened.add(e.itemId);
    else if (e.type === 'impression') impressed.add(e.itemId);
    else if (e.type === 'hide') hidden.add(e.itemId);
    else if (e.type === 'dwell' && isBounce(e.value)) bounced.add(e.itemId);
  }

  // Positive = any strong action, or a link-open the user actually read (not a
  // bounce). A bounce with no deeper engagement flips to a negative — so
  // "clicked and came straight back" trains the model *against* that story.
  const engaged = new Set<number>();
  for (const id of strong) engaged.add(id);
  for (const id of opened) if (!bounced.has(id)) engaged.add(id);

  const negatives = new Set<number>();
  for (const id of impressed) if (!engaged.has(id)) negatives.add(id);
  for (const id of bounced) if (!engaged.has(id)) negatives.add(id);
  for (const id of hidden) {
    engaged.delete(id);
    negatives.add(id);
  }

  // Resolve the actual items first so content signals can be computed for the
  // whole training set at once (needed for leave-one-out).
  const prefs = usePrefs.getState();
  const engagedItems: HnItem[] = [];
  const negativeItems: HnItem[] = [];
  for (const id of engaged) {
    const it = await getItem(id);
    if (it) engagedItems.push(it);
  }
  for (const id of negatives) {
    const it = await getItem(id);
    if (it) negativeItems.push(it);
  }
  const allItems = [...engagedItems, ...negativeItems];

  // Content signals (embedding relevance + title/comment term affinity) with
  // leave-one-out: each training item is removed from its own profile so its
  // label doesn't leak into its features.
  const profile = await buildContentProfile(prefs.embeddingModel, {
    withComments: prefs.embeddingsEnabled,
    embeddings: prefs.embeddingsEnabled,
    fetchArticle: prefs.fetchArticleText,
  });
  const { simById, termById } = await computeContentSignals(prefs.embeddingModel, allItems, profile, {
    loo: true,
  });

  const ctx = makeContext(prefs, await computeAffinities(), { simById, termById });
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
