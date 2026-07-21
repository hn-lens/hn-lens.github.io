// Background auto-trainer: keeps the logistic reranker fresh without the user
// pressing "Train from history". Retrains (debounced) after new engagement and
// once on startup if the model is stale. Gated on the "Use learned reranker"
// toggle, rate-limited, and best-effort (manual training still works).
import { db } from '../db';
import { ENGAGEMENT_TYPES, onEngagement } from '../interactions';
import { usePrefs } from '../prefs';
import { queryClient } from '../query';
import { loadModel } from './logistic';
import { trainFromHistory } from './train';

const MIN_INTERVAL = 45_000; // at most ~once per 45s
const DEBOUNCE = 12_000; // let a burst of activity settle first

let running = false;
let lastTrainAt = 0;
let timer: ReturnType<typeof setTimeout> | null = null;

/** Stale = there's an engagement event newer than the model was last trained. */
async function isStale(): Promise<boolean> {
  const model = await loadModel();
  const recent = await db.events.orderBy('ts').reverse().limit(200).toArray();
  const lastEng = recent.find((e) => ENGAGEMENT_TYPES.has(e.type));
  if (!lastEng) return false;
  return !model.updatedAt || lastEng.ts > model.updatedAt;
}

/** Run a retrain if warranted. Exported (bypassing the debounce) for tests. */
export async function runAutoTrain(): Promise<'trained' | 'skipped'> {
  if (running) return 'skipped';
  if (!usePrefs.getState().useLearnedRanker) return 'skipped';
  if (Date.now() - lastTrainAt < MIN_INTERVAL) return 'skipped';
  if (!(await isStale())) return 'skipped';
  running = true;
  try {
    await trainFromHistory();
    lastTrainAt = Date.now();
    await queryClient.invalidateQueries({ queryKey: ['ranker'] });
    return 'trained';
  } catch {
    return 'skipped'; // best-effort — the manual button remains
  } finally {
    running = false;
  }
}

function schedule(): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void runAutoTrain(), DEBOUNCE);
}

let started = false;
export function initAutoTrain(): void {
  if (started) return;
  started = true;
  onEngagement(schedule); // retrain shortly after real engagement
  setTimeout(() => void runAutoTrain(), 4_000); // catch up on startup if stale
}
