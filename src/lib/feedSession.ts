import type { FeedKind } from '../types';

/**
 * Per-feed paging DEPTH, remembered for the lifetime of the page (module scope, NOT persisted).
 *
 * Depth only — scroll offset is deliberately not tracked here; see the note in `Feed.tsx`.
 *
 * The core reading loop is skim the feed → open a discussion → come back and carry on. Both halves
 * of "where I was" used to be destroyed by that round trip: paging depth lived in a `useState`
 * inside `useFeed`, which React Router unmounts on navigation, and nothing ever recorded the scroll
 * offset. A reader 90 cards deep at scrollY 17404 came back to 25 cards at scrollY 0 — every page
 * they had loaded thrown away, and their place with it. Browser Back was worse than useless: it
 * restored the raw offset onto a list four times shorter, landing them at an unrelated story with
 * no indication anything had been lost.
 *
 * Keyed by feed kind so each tab keeps its own place (switching Top → Best → Top returns you to
 * where you were in Top, which is the same expectation). Deliberately NOT persisted to storage:
 * this is "where I am right now", and a full page reload is the user asking for a fresh start —
 * that is also what keeps it consistent with the load-time read-hidden snapshot, which likewise
 * recomputes on reload.
 */
const depth = new Map<FeedKind, number>();

export function getFeedDepth(kind: FeedKind, fallback: number): number {
  return depth.get(kind) ?? fallback;
}

export function setFeedDepth(kind: FeedKind, value: number): void {
  depth.set(kind, value);
}

/**
 * Forget a feed's position. Used by an explicit Refresh: the user asked for a new list, so keeping
 * them 90 cards deep in stories that may no longer be there would be the wrong kind of stable.
 */
export function resetFeedPosition(kind: FeedKind): void {
  depth.delete(kind);
}

/**
 * The pinned DISPLAY ORDER of a personalized feed, and the ranking INTENT it was computed for.
 *
 * Lives here rather than in a `useRef` for the same reason paging depth does: `useFeed` unmounts
 * every time the reader opens a discussion, so a ref-based pin was silently discarded by the core
 * reading loop (feed → story → back) — the exact trip it was meant to survive.
 *
 * `intent` is a fingerprint of everything the reader can deliberately change about the ordering
 * (weights, filters, which model is applied). Incidental activity — reading, saving, a background
 * retrain — does NOT change it, so the order holds. Dragging a weight slider or editing a filter
 * DOES, so the feed re-ranks immediately, which is what those controls promise.
 */
const order = new Map<FeedKind, { intent: string; ids: number[] }>();

export function getPinnedOrder(kind: FeedKind, intent: string): number[] | null {
  const e = order.get(kind);
  return e && e.intent === intent ? e.ids : null;
}

export function setPinnedOrder(kind: FeedKind, intent: string, ids: number[]): void {
  order.set(kind, { intent, ids });
}

export function clearPinnedOrder(kind: FeedKind): void {
  order.delete(kind);
}
