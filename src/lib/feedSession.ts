import { readSession, writeSession } from './session';
import type { FeedKind } from '../types';

/**
 * Per-feed paging DEPTH, remembered for the lifetime of the SESSION (sessionStorage, `hn:depth`).
 *
 * Depth only. Scroll position is deliberately NOT remembered anywhere: returning to a feed puts the
 * reader at the top of it (see `Feed.tsx`).
 *
 * Depth is worth keeping even so. It lived in a `useState` inside `useFeed`, which React Router
 * unmounts on navigation, so a reader 90 cards deep came back to 25 — every page they had loaded
 * thrown away, and Load more to press again.
 *
 * Keyed by feed kind so each tab keeps its own depth.
 *
 * Stored in `sessionStorage`, not module scope, because a RELOAD continues the session — it is not
 * the reader asking for a fresh start. Module scope meant a reload silently threw the reader's
 * depth away, which is the same defect the pinned order had, and `sessionStorage` is precisely the
 * primitive that already means "this tab, surviving reload". A new tab, or an explicit Refresh,
 * starts a new session and clears it. (An earlier version of this comment claimed the opposite on
 * both counts — "module scope, NOT persisted" and a reload being a deliberate fresh start — while
 * sitting directly above the code that reads and writes the key.)
 */
const DEPTH_KEY = 'hn:depth' as const;

export function getFeedDepth(kind: FeedKind, fallback: number): number {
  return readSession<Record<string, number>>(DEPTH_KEY, {})[kind] ?? fallback;
}

export function setFeedDepth(kind: FeedKind, value: number): void {
  const all = readSession<Record<string, number>>(DEPTH_KEY, {});
  all[kind] = value;
  writeSession(DEPTH_KEY, all);
}

export function resetFeedPosition(kind: FeedKind): void {
  // Scoped to the feed the reader actually refreshed: `void kind; startNewSession()` discarded the
  // argument and reset every tab, so pressing Refresh on Top silently threw away the paging depth
  // and pinned order in For You as well (measured: 50 cards -> 25, and the aimed-at story lost).
  clearPinnedOrder(kind);
  // Dismissal placeholders go too. They are held for the SESSION so the list does not shift under
  // the reader mid-read, and Refresh is the boundary at which membership changes are supposed to
  // land — but nothing cleared them, so a dismissed row kept its slot for the life of the tab no
  // matter how many times the reader refreshed. (`startNewSession` did clear them and had zero
  // callers, so its doc comment claiming Refresh called it was false.) They are global rather than
  // per-feed: a dismissal applies everywhere, so it is released everywhere at once.
  clearHiddenStubs();
  const all = readSession<Record<string, number>>(DEPTH_KEY, {});
  delete all[kind];
  writeSession(DEPTH_KEY, all);
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
// Persisted in sessionStorage, not module scope. Module scope meant a RELOAD silently re-ranked the
// feed and dropped items: an established reader coming back after a reload found the list re-ordered
// (measured: 2 stories gone, the target moved 11 -> 12) and their next click opened the wrong story.
// A reload is not the reader asking for a new list — Refresh is, and Refresh clears this.
const ORDER_KEY = 'hn:pinnedOrder' as const;
type OrderMap = Record<string, { intent: string; ids: number[] }>;

function readOrders(): OrderMap {
  return readSession<OrderMap>(ORDER_KEY, {});
}

function writeOrders(all: OrderMap): void {
  writeSession(ORDER_KEY, all);
}

export function getPinnedOrder(kind: FeedKind, intent: string): number[] | null {
  const e = readOrders()[kind];
  return e && e.intent === intent ? e.ids : null;
}

export function setPinnedOrder(kind: FeedKind, intent: string, ids: number[]): void {
  const all = readOrders();
  all[kind] = { intent, ids };
  writeOrders(all);
}

export function clearPinnedOrder(kind: FeedKind): void {
  const all = readOrders();
  delete all[kind];
  writeOrders(all);
}

/**
 * Stories hidden DURING this session, kept as placeholders rather than removed.
 *
 * "Not interested" used to delete the row instantly, so everything below jumped up a full card
 * height with no placeholder and no animation — and the reader's very next click, on the story they
 * had already picked out, hit the wrong one. It is the same defect as a story vanishing on reload,
 * just triggered by a button: the list changed membership under someone who was mid-reach.
 *
 * The hide itself is immediate and real (it is recorded, it trains the ranker, it applies to every
 * other surface). Only the ROW lingers, as a "Hidden - Undo" stub holding its place, and it is gone
 * at the next session boundary like every other membership change.
 */
const HIDDEN_STUBS_KEY = 'hn:hiddenStubs' as const;
/** A bare id is the pre-height form; both are read, so an in-flight session is not disturbed. */
type StubEntry = number | { id: number; h?: number };

export function markHiddenInSession(id: number, height?: number): void {
  const all = readSession<StubEntry[]>(HIDDEN_STUBS_KEY, []);
  const has = all.some((e) => (typeof e === 'number' ? e : e.id) === id);
  if (!has) {
    writeSession(HIDDEN_STUBS_KEY, [...all, height ? { id, h: height } : { id }]);
    notifyStubs();
  }
}

export function unmarkHiddenInSession(id: number): void {
  writeSession(
    HIDDEN_STUBS_KEY,
    readSession<StubEntry[]>(HIDDEN_STUBS_KEY, []).filter((e) => (typeof e === 'number' ? e : e.id) !== id)
  );
  notifyStubs();
}

const stubListeners = new Set<() => void>();
let stubSnapshot: number[] = [];
let stubSnapshotRaw = '';

/** Subscribe to stub-set changes. The set lives in sessionStorage, which React cannot observe. */
export function subscribeHiddenStubs(fn: () => void): () => void {
  stubListeners.add(fn);
  return () => stubListeners.delete(fn);
}

/** Stable-identity snapshot for `useSyncExternalStore`. */
export function hiddenStubsSnapshot(): number[] {
  const raw = JSON.stringify(readSession<StubEntry[]>(HIDDEN_STUBS_KEY, []));
  if (raw !== stubSnapshotRaw) {
    stubSnapshotRaw = raw;
    stubSnapshot = hiddenInSession();
  }
  return stubSnapshot;
}

function notifyStubs(): void {
  for (const fn of stubListeners) fn();
}

export function hiddenInSession(): number[] {
  return readSession<StubEntry[]>(HIDDEN_STUBS_KEY, []).map((e) => (typeof e === 'number' ? e : e.id));
}

/**
 * The height the dismissed card occupied, so the placeholder can hold the slot at the same size
 * ACROSS A RELOAD. Measured in the component and kept here because a reload continues the session
 * but destroys every ref: without it the placeholder fell back to its natural single-line height on
 * reload and the list jumped 86-103px — the exact shift the placeholder exists to prevent, on the
 * one navigation the session model promises changes nothing.
 */

export function hiddenStubHeight(id: number): number | undefined {
  for (const e of readSession<StubEntry[]>(HIDDEN_STUBS_KEY, [])) {
    if (typeof e !== 'number' && e.id === id) return e.h;
  }
  return undefined;
}

/** Drop every feed's pinned order, so the next render rebuilds from the current candidate set. */
export function clearAllPinnedOrders(): void {
  writeSession(ORDER_KEY, {});
}

export function clearHiddenStubs(): void {
  writeSession(HIDDEN_STUBS_KEY, []);
  notifyStubs();
}
