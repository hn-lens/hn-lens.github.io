import { fetchWithTimeout } from './http';
import type { FeedKind, HnItem, HnUser } from '../../types';

const BASE = 'https://hacker-news.firebaseio.com/v0';

const LIST_ENDPOINT: Record<Exclude<FeedKind, 'foryou' | 'read'>, string> = {
  top: 'topstories',
  new: 'newstories',
  best: 'beststories',
  ask: 'askstories',
  show: 'showstories',
  job: 'jobstories',
};

/**
 * A story item is a ~1KB JSON document, so a request still outstanding after this long is a
 * straggler rather than a slow success — and waiting on it is disproportionately expensive.
 *
 * The feed materialises a whole page of items as a bounded-concurrency pool and paints when the
 * pool settles, so time-to-first-card is set by the SLOWEST item, not the average: one straggler
 * against the generic 10s network deadline multiplied first paint ~5x (measured 10.4s worst case
 * against a ~1.4s cold baseline). A timed-out item is a tolerated gap — `getItems` filters nulls
 * and the card is simply absent — so a tighter deadline trades at most one missing card out of 25
 * for a bounded first paint, which is the right way round for a reader staring at a blank feed.
 *
 * Deliberately scoped to ITEMS: list and tree fetches have no equivalent fallback (losing them
 * means an empty feed or an empty discussion), so they keep the generous default.
 */
const ITEM_TIMEOUT_MS = 4000;

export async function fetchItem(id: number): Promise<HnItem | null> {
  // A missing/errored/timed-out item is a tolerated gap (the item pool skips nulls) — never
  // let one hung request stall a cold-start Promise.all or a background retrain.
  try {
    const res = await fetchWithTimeout(`${BASE}/item/${id}.json`, ITEM_TIMEOUT_MS);
    if (!res.ok) return null;
    return (await res.json()) as HnItem | null;
  } catch {
    return null;
  }
}

export async function fetchUser(id: string): Promise<HnUser | null> {
  try {
    const res = await fetchWithTimeout(`${BASE}/user/${encodeURIComponent(id)}.json`);
    if (!res.ok) return null;
    return (await res.json()) as HnUser | null;
  } catch {
    return null;
  }
}

export async function fetchList(kind: Exclude<FeedKind, 'foryou' | 'read'>): Promise<number[]> {
  const res = await fetchWithTimeout(`${BASE}/${LIST_ENDPOINT[kind]}.json`);
  // Throw on a real server/network error (or a timeout abort) so callers can distinguish an
  // OUTAGE (→ show an error/Retry state) from a legitimately EMPTY list (→ show the empty
  // state). A null body is a valid empty list, not an error.
  if (!res.ok) throw new Error(`HN list "${kind}" failed: ${res.status}`);
  return ((await res.json()) as number[]) ?? [];
}

export async function fetchMaxItem(): Promise<number> {
  try {
    const res = await fetchWithTimeout(`${BASE}/maxitem.json`);
    if (!res.ok) return 0;
    return ((await res.json()) as number) ?? 0;
  } catch {
    return 0;
  }
}
