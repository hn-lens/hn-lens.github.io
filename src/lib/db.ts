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
  try {
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
