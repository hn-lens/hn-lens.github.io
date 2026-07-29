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
  // Lower than the event cap on purpose: unlike `events`, the entire `seen` table is read into a
  // Map on the feed's critical path, so its size is a per-load cost and not just storage.
  const MAX_SEEN = 5000;
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
    // `seen` is capped here because it is not merely stored — the WHOLE of it is read
    // into a Map on the feed's critical path (`useSeenMap`, a live query over `db.seen.toArray()`),
    // so it is loaded and rebuilt on every change for the life of the app. One row per story ever
    // scrolled past grows without bound for a daily reader, and it pays that cost on every load.
    // Capped like the event log, oldest-first: `seen` only dims a card the reader has already
    // encountered, so forgetting the oldest entries costs a re-dim of stories from long ago.
    const seenCount = await db.seen.count();
    if (seenCount > MAX_SEEN) {
      const stale = await db.seen.orderBy('ts').limit(seenCount - MAX_SEEN).primaryKeys();
      await db.seen.bulkDelete(stale);
    }
    // Cap the kv table too — it holds fetched article bodies (atext:*, ~5KB each), the term memos
    // derived from those bodies and from comments (aterms:*/cterms:*), inline top-comment previews
    // (topc:*) and AI summaries (sum:*/usersum:*), which would otherwise grow forever. Evict the
    // LEAST-valuable entries first by prefix: atext: is bulky and trivially re-fetched; topc: and
    // the term memos are cheap to rebuild; AI summaries (sum:/usersum:) are the most expensive to
    // regenerate (a model run — cloud costs API quota), so keep them longest. No per-row timestamp
    // exists, so within a tier key order is a stable tiebreak (V8's sort is stable). (A plain
    // alphabetical evict dropped sum: before topc: — an inversion.)
    //
    // `aterms:`/`cterms:` are tiered explicitly rather than falling through to the catch-all. Left
    // unlisted they landed in tier 2, "expensive, evict last", alongside AI summaries — while the
    // `atext:` bodies they are DERIVED FROM sit in tier 0 and go first, so eviction could leave a
    // term memo feeding `termAffinity` for an article body that no longer exists. They are cheap to
    // recompute from a re-fetch, so they belong beside `topc:`.
    //
    // The `wiki:`/`news:` prefixes this list used to name no longer exist: the At-a-glance context
    // panel that wrote them was deleted, so the comment was describing tiers for keys nothing
    // produces.
    const MAX_KV = 4000;
    const kvCount = await db.kv.count();
    if (kvCount > MAX_KV) {
      const need = kvCount - MAX_KV;
      const allKeys = (await db.kv.orderBy('key').primaryKeys()) as string[];
      const tier = (k: string) =>
        k.startsWith('atext:')
          ? 0 // bulky, cheap to refetch → drop first
          : k.startsWith('topc:') || k.startsWith('aterms:') || k.startsWith('cterms:')
            ? 1 // cheap to rebuild (and aterms: must not outlive the atext: it came from)
            : k.startsWith('model:')
              ? 3 // the LEARNED MODEL — genuinely last; see below
              : 2; // sum:/usersum: and anything else — expensive, evicted after the cheap tiers
      // `model:` needs its OWN tier, because "evict last" is not what tier 2 delivered. Within a
      // tier the tiebreak is position in the KEY-SORTED list, and 'model:logistic' sorts before
      // 'sum:' and 'usersum:' — so the single row the learned reranker depends on, the one thing
      // here that costs a full retrain to rebuild, was the FIRST victim of the supposedly-protected
      // tier, ahead of every AI summary. It is one small row; there is no space argument for it.
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
