import { dropSession, readSession, writeSession } from './session';
/**
 * Which already-read stories For You is currently hiding — the "read sweep".
 *
 * HOW THIS ARRIVED HERE. Hiding read stories has had four designs. The first two failed for the same
 * reason — they changed the membership of a list WHILE the reader was mid-use:
 *
 *   1. Hide LIVE. A story vanished the moment it was read, yanking a card out from under the reader.
 *   2. Snapshot per PAGE LOAD, done WRONG. It recomputed silently, AND it captured the snapshot from
 *      a read-history query that had not finished loading (a race), AND a reload also discarded the
 *      pinned order. The reader reported: "I read an item, came back, it was gone, and I opened the
 *      wrong thing" — the read story vanished with everything below pulled up a card, silently.
 *   3. Refresh-only. The sweep changed ONLY when the reader pressed Refresh; a fresh load / reload
 *      never hid anything. Safe, but the read items just sat in For You until you manually Refreshed,
 *      which readers found unintuitive — arriving fresh should show fresh stories.
 *
 * The rule 1 and 2 violated: a list may only change membership as the RESULT OF AN EXPLICIT ACT by
 * the reader, and the change must be visible and reversible.
 *
 *   4. This one. The sweep is recomputed on every FRESH PAGE LOAD (new tab OR reload) via
 *      `seedReadSweepForLoad`, done RIGHT so it does not repeat #2:
 *        - it is computed AFTER the read-history query resolves (seeded inside its `.then`), so there
 *          is no seed-vs-history race;
 *        - the For-You feed waits for the seed before its first paint (main.tsx primes ['readSnapshot']
 *          and useFeed gates on it), so read items are gone from the FIRST frame — no flash, no shift
 *          under a cursor;
 *        - it is ANNOUNCED and REVERSIBLE (the "N already-read hidden · Undo" note), satisfying the
 *          rule #2 broke;
 *        - a reload arrives at the TOP of a re-rendered feed (scroll is not restored), so there is no
 *          mid-scroll yank;
 *        - the pinned order and paging depth are KEPT (this is not a Refresh), so a reload for a flaky
 *          network does not re-rank the feed or lose the reader's depth;
 *        - it runs ONCE per page load, so an in-session read (no reload) is never swept out from under
 *          the reader — that story stays until the next load/reload/Refresh.
 *
 * Persisted in sessionStorage (`hn:readSweep`, one of `SESSION_KEYS`), the right store because it
 * already means what a session means: this tab, surviving reload, gone on a new tab. NOT
 * localStorage, which would outlive the session and keep hiding stories in a tab opened tomorrow.
 */
const KEY = 'hn:readSweep' as const;
const PREV_KEY = 'hn:readSweep:prev' as const;

function read(key: typeof KEY | typeof PREV_KEY): number[] | null {
  const v = readSession<unknown>(key, null);
  return Array.isArray(v) ? v.filter((n): n is number => typeof n === 'number') : null;
}

function write(key: typeof KEY | typeof PREV_KEY, ids: number[]): void {
  writeSession(key, ids);
}

/**
 * The set currently being hidden. Recomputed from reading history on every fresh document load
 * (reload / new tab) via `seedReadSweepForLoad`, and updated by Refresh via `applyReadSweep`; it
 * does NOT change on in-app navigation. See the file header (design #4) and SPEC.md section 4.
 */
export function getReadSweep(): number[] {
  return read(KEY) ?? [];
}

/** Alias kept for call sites that documented "no side effect" explicitly. */
export const peekReadSweep = getReadSweep;

/**
 * Sweep: hide everything read up to now. Returns how many stories this newly removes, so the feed
 * can say so out loud — a silent removal is the thing being fixed.
 */
export function applyReadSweep(currentlyRead: number[]): number {
  const before = new Set(read(KEY) ?? []);
  write(PREV_KEY, [...before]);
  write(KEY, currentlyRead);
  return currentlyRead.filter((id) => !before.has(id)).length;
}

/**
 * Design #4 (see the file header): on a FRESH PAGE LOAD (new tab OR reload), hide everything read so
 * far, so arriving fresh shows fresh stories. Distinct from `applyReadSweep` (Refresh) in ONE way:
 * the Undo target (`PREV_KEY`) is set to EMPTY, so the load-time "N already-read hidden · Undo"
 * restores the full list for the session (the reader's mental model is "un-hide what the load hid"),
 * whereas Refresh's Undo restores the incremental pre-Refresh set. Called once per page load from
 * main.tsx, AFTER the read-history query resolves.
 */
export function seedReadSweepForLoad(currentlyRead: number[]): number {
  const before = new Set(read(KEY) ?? []);
  write(PREV_KEY, []);
  write(KEY, currentlyRead);
  return currentlyRead.filter((id) => !before.has(id)).length;
}

/** Put back exactly the set that was hidden before the last sweep. */
export function undoReadSweep(): void {
  const prev = read(PREV_KEY);
  if (prev) write(KEY, prev);
}

/** Used when reading history is deleted, so the sweep cannot outlive the data it was derived from. */
export function clearReadSweep(): void {
  dropSession(KEY);
  dropSession(PREV_KEY);
}
