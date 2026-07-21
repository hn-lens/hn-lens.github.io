import { db } from '../db';
import type { CachedItem } from '../db';
import { fetchItem, fetchList } from './firebase';
import type { FeedKind, HnItem } from '../../types';

const ITEM_TTL = 15 * 60 * 1000;
const LIST_TTL = 3 * 60 * 1000;

interface MemEntry {
  item: HnItem;
  cachedAt: number;
}
const memItems = new Map<number, MemEntry>();
const inflight = new Map<number, Promise<HnItem | null>>();

/** Run an async fn over items with bounded concurrency, preserving order. */
export async function mapPool<T, R>(
  items: T[],
  fn: (t: T, i: number) => Promise<R>,
  concurrency = 8
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let idx = 0;
  const n = Math.min(concurrency, items.length);
  const workers = Array.from({ length: n }, async () => {
    while (idx < items.length) {
      const cur = idx++;
      results[cur] = await fn(items[cur], cur);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function getItem(id: number, ttl = ITEM_TTL): Promise<HnItem | null> {
  const mem = memItems.get(id);
  if (mem && Date.now() - mem.cachedAt < ttl) return mem.item;

  const existing = inflight.get(id);
  if (existing) return existing;

  const p = (async () => {
    const cached = await db.items.get(id);
    if (cached && Date.now() - cached.cachedAt < ttl) {
      memItems.set(id, { item: cached.item, cachedAt: cached.cachedAt });
      return cached.item;
    }
    const item = await fetchItem(id);
    if (item) {
      const now = Date.now();
      memItems.set(id, { item, cachedAt: now });
      const row: CachedItem = { id, item, cachedAt: now };
      void db.items.put(row).catch(() => undefined);
    } else if (cached) {
      return cached.item; // fall back to stale on network failure
    }
    return item;
  })();

  inflight.set(id, p);
  try {
    return await p;
  } finally {
    inflight.delete(id);
  }
}

export async function getItems(ids: number[], concurrency = 8, ttl?: number): Promise<HnItem[]> {
  const arr = await mapPool(ids, (id) => getItem(id, ttl), concurrency);
  return arr.filter((x): x is HnItem => !!x && !x.deleted && !x.dead);
}

export async function getFeedIds(
  kind: Exclude<FeedKind, 'foryou' | 'read'>,
  ttl = LIST_TTL
): Promise<number[]> {
  const key = `list:${kind}`;
  const cached = await db.lists.get(key);
  if (cached && Date.now() - cached.cachedAt < ttl) return cached.ids;
  let ids: number[];
  try {
    ids = await fetchList(kind);
  } catch (err) {
    // Network/server error: fall back to stale cache if we have one (better than
    // erroring); with NO cache, re-throw so the feed shows an error/Retry state
    // instead of a misleading "nothing here / check filters" empty state.
    if (cached) return cached.ids;
    throw err;
  }
  if (ids.length) {
    void db.lists.put({ key, ids, cachedAt: Date.now() }).catch(() => undefined);
    return ids;
  }
  // A successful but EMPTY list is a legitimately empty feed — return [] (empty state),
  // preferring a stale non-empty cache if we happen to have one.
  return cached?.ids ?? ids;
}

/** Blended candidate pool for the "For You" re-ranker (top + best + fresh). */
export async function getForYouCandidateIds(limit = 170, ttl?: number): Promise<number[]> {
  const [top, best, fresh] = await Promise.all([
    getFeedIds('top', ttl),
    getFeedIds('best', ttl),
    getFeedIds('new', ttl),
  ]);
  const seen = new Set<number>();
  const merged: number[] = [];
  // Include fresh stories so a high recency weight can actually surface them.
  for (const id of [...top.slice(0, 110), ...best.slice(0, 60), ...fresh.slice(0, 45)]) {
    if (!seen.has(id)) {
      seen.add(id);
      merged.push(id);
    }
  }
  return merged.slice(0, limit);
}
