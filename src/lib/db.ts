import Dexie from 'dexie';
import type { Table } from 'dexie';
import type { HnItem, InteractionEvent } from '../types';

export interface CachedItem {
  id: number;
  item: HnItem;
  cachedAt: number;
}
export interface CachedList {
  key: string;
  ids: number[];
  cachedAt: number;
}
export interface StoredEmbedding {
  id: number;
  vec: number[];
  model: string;
  withArticle?: boolean; // whether the embedded text included the linked article body
}
export interface KV {
  key: string;
  value: unknown;
}
export interface SeenRow {
  id: number;
  ts: number;
}
export interface SavedRow {
  id: number;
  item: HnItem;
  ts: number;
}
export interface HiddenRow {
  id: number;
  ts: number;
}

class HnDB extends Dexie {
  events!: Table<InteractionEvent, number>;
  items!: Table<CachedItem, number>;
  lists!: Table<CachedList, string>;
  embeddings!: Table<StoredEmbedding, number>;
  kv!: Table<KV, string>;
  seen!: Table<SeenRow, number>;
  saved!: Table<SavedRow, number>;
  hidden!: Table<HiddenRow, number>;

  constructor() {
    super('hnlens');
    this.version(1).stores({
      events: '++id, ts, type, itemId, domain, author',
      items: 'id, cachedAt',
      lists: 'key, cachedAt',
      embeddings: 'id, model',
      kv: 'key',
      seen: 'id, ts',
      saved: 'id, ts',
      hidden: 'id, ts',
    });
  }
}

export const db = new HnDB();

/** Cap the size of the item/embedding caches so IndexedDB doesn't grow forever. */
export async function pruneCaches(): Promise<void> {
  const MAX_ITEMS = 2500;
  const MAX_EMB = 4000;
  const MAX_EVENTS = 10000; // generous — years of use for a personal reader; bounds storage
  try {
    // Cap the append-only interaction log (drops the OLDEST events; recent history +
    // affinities are what matter). Ordered by ts so we evict oldest first.
    const evCount = await db.events.count();
    if (evCount > MAX_EVENTS) {
      const stale = await db.events.orderBy('ts').limit(evCount - MAX_EVENTS).primaryKeys();
      await db.events.bulkDelete(stale);
    }
    const itemCount = await db.items.count();
    if (itemCount > MAX_ITEMS) {
      const stale = await db.items.orderBy('cachedAt').limit(itemCount - MAX_ITEMS).primaryKeys();
      await db.items.bulkDelete(stale);
    }
    const embCount = await db.embeddings.count();
    if (embCount > MAX_EMB) {
      const excess = await db.embeddings.limit(embCount - MAX_EMB).primaryKeys();
      await db.embeddings.bulkDelete(excess);
    }
    // Cap the kv table too — it holds fetched article bodies (atext:*, ~5KB each), inline
    // top-comment previews (topc:*), AI summaries (sum:*/usersum:*), and external context
    // (wiki:*/news:*), which would otherwise grow forever. Evict the LEAST-valuable entries
    // first by prefix: atext:/news: are bulky and trivially re-fetched; topc:/wiki: are cheap
    // to rebuild (a few HN item fetches / one API call); AI summaries (sum:/usersum:) are the
    // most expensive to regenerate (a model run — cloud costs API quota), so keep them longest.
    // No per-row timestamp exists, so within a tier key order is a stable tiebreak (V8's sort
    // is stable). (A plain alphabetical evict dropped sum: before topc:/wiki: — an inversion.)
    const MAX_KV = 4000;
    const kvCount = await db.kv.count();
    if (kvCount > MAX_KV) {
      const need = kvCount - MAX_KV;
      const allKeys = (await db.kv.orderBy('key').primaryKeys()) as string[];
      const tier = (k: string) =>
        k.startsWith('atext:') || k.startsWith('news:')
          ? 0 // bulky, cheap to refetch → drop first
          : k.startsWith('topc:') || k.startsWith('wiki:')
            ? 1 // cheap to rebuild
            : 2; // sum:/usersum: and anything else — expensive/important, evict last
      const victims = allKeys
        .map((k, i) => ({ k, t: tier(k), i }))
        .sort((a, b) => a.t - b.t || a.i - b.i)
        .slice(0, need)
        .map((x) => x.k);
      await db.kv.bulkDelete(victims);
    }
  } catch {
    // best-effort cleanup
  }
}

export async function kvGet<T>(key: string): Promise<T | undefined> {
  const row = await db.kv.get(key);
  return row?.value as T | undefined;
}

export async function kvSet(key: string, value: unknown): Promise<void> {
  await db.kv.put({ key, value });
}
