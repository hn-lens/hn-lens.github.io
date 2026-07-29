// Background auto-trainer: keeps the logistic reranker fresh without the user pressing
// "Retrain now". Training is synchronous main-thread work (up to ~0.7s at the event cap), so it runs
// only when the history has grown by a real increment AND the tab is hidden. Gated on the "Use learned
// reranker" toggle, rate-limited, and best-effort (manual training still works).
import { db } from '../db';
import { ENGAGEMENT_TYPES, onEngagement } from '../interactions';
import { usePrefs } from '../prefs';
import { queryClient } from '../query';
import { loadModel } from './logistic';
import { trainFromHistory } from './train';

const MIN_INTERVAL = 45_000; // at most ~once per 45s
const DEBOUNCE = 12_000; // let a burst of activity settle first

/** Engagement events that must accumulate before an already-fitted model is refitted. */
export const MIN_NEW_EVENTS = 30;

let running = false;
let lastTrainAt = 0;
let timer: ReturnType<typeof setTimeout> | null = null;

/**
 * Engagement events recorded since `since`, stopping as soon as the gate is satisfied.
 *
 * Capping the ROWS read instead (`.limit(n)`) does not work: most of the log is `impression`, which
 * is not engagement, so a fixed row window fills with impressions and the engagement count inside it
 * stays under the floor no matter how much the reader engages — and because `since` is pinned to the
 * model's own training time, that state never clears.
 *
 * `until` only short-circuits ONCE the floor is reached. Below the floor — which is the steady state
 * this gate exists to detect — there is nothing to stop on and the whole `ts > since` range is read.
 * That is bounded in practice by `pruneCaches` capping the event log, not by this function.
 */
async function newEngagementSince(since: number): Promise<number> {
  let n = 0;
  await db.events
    .where('ts')
    .above(since)
    .until(() => n >= MIN_NEW_EVENTS)
    .each((e) => {
      if (ENGAGEMENT_TYPES.has(e.type)) n++;
    });
  return n;
}

async function retrainWarranted(): Promise<boolean> {
  const model = await loadModel();
  const fresh = await newEngagementSince(model.updatedAt ?? 0);
  if (!fresh) return false;
  // A reader with no model yet should not wait for a full increment before their first one; the
  // sample gate inside training decides whether there is enough to fit.
  if (!model.updatedAt) return true;
  return fresh >= MIN_NEW_EVENTS;
}

/** Run a retrain if warranted. Exported (bypassing the debounce) for tests. */
export async function runAutoTrain(): Promise<'trained' | 'skipped'> {
  if (running) return 'skipped';
  if (!usePrefs.getState().useLearnedRanker) return 'skipped';
  // Blocking the main thread (up to ~0.7s at the event cap) is free only when nobody is watching it.
  if (typeof document !== 'undefined' && !document.hidden) return 'skipped';
  if (Date.now() - lastTrainAt < MIN_INTERVAL) return 'skipped';
  running = true;
  try {
    // Inside the try: this reads storage, and an error here used to escape runAutoTrain entirely.
    // Every caller invokes it as `void runAutoTrain()`, so a storage failure surfaced as an
    // unhandled rejection instead of the best-effort skip this function promises.
    if (!(await retrainWarranted())) return 'skipped'; // nothing new — cheap, and free to retry
    // Consume the rate limit for the ATTEMPT, not for a success. Advancing it only after
    // `trainFromHistory()` resolved meant a retrain that THREW left the limiter untouched, so the
    // next tab-hide re-ran the entire scan immediately — measured 230ms then 162ms back to back. A
    // retrain that keeps failing is exactly when the reader's main thread most needs protecting.
    lastTrainAt = Date.now();
    await trainFromHistory();
    await queryClient.invalidateQueries({ queryKey: ['ranker'] });
    return 'trained';
  } catch {
    lastTrainAt = Date.now(); // a failed attempt throttles too, so this cannot become a hot loop
    return 'skipped'; // best-effort — the manual button remains
  } finally {
    running = false;
  }
}

function schedule(): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void runAutoTrain(), DEBOUNCE);
}

/** Clears the module's rate-limit state so a harness can drive attempts independently. */
export function __resetForTest(): void {
  running = false;
  lastTrainAt = 0;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

let started = false;
export function initAutoTrain(): void {
  if (started) return;
  started = true;
  onEngagement(schedule); // engagement arms it; the gates in runAutoTrain decide when it runs
  // The reading loop opens articles in another tab, so this is when a retrain is invisible — and it
  // is also the retry for every attempt the visibility gate turned away.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) void runAutoTrain();
  });
  setTimeout(() => void runAutoTrain(), 4_000); // catch up if the tab starts hidden
}
