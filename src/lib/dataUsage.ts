// Per-type breakdown of the LOCAL data the app stores in IndexedDB, so the user can
// delete one kind without nuking everything (e.g. drop fetched article text but keep
// downloaded models, or clear reading history but keep saved stories). Model WEIGHTS
// live in Cache Storage and are managed separately (see lib/models/storage.ts +
// CachedModels) — this covers the IndexedDB side.
import { db } from './db';
import { queryClient } from './query';

export type DataCategoryId =
  | 'article'
  | 'summaries'
  | 'model'
  | 'events'
  | 'embeddings'
  | 'cache'
  | 'saved'
  | 'hidden'
  | 'seen';

export interface DataCategory {
  id: DataCategoryId;
  label: string;
  description: string;
  count: number;
  bytes: number; // approximate; 0 when unknown/empty
  unit: string; // what `count` counts, e.g. "articles"
}

const approxBytes = (value: unknown): number => {
  try {
    return JSON.stringify(value).length;
  } catch {
    return 0;
  }
};

/** Read counts + approximate sizes for each IndexedDB data category. */
export async function getDataBreakdown(): Promise<DataCategory[]> {
  const kv = await db.kv.toArray();
  let articleCount = 0;
  let articleBytes = 0;
  let sumCount = 0;
  let sumBytes = 0;
  let modelCount = 0;
  let modelBytes = 0;
  for (const row of kv) {
    if (row.key.startsWith('atext:')) {
      articleCount++;
      articleBytes += approxBytes(row.value);
    } else if (row.key.startsWith('sum:')) {
      sumCount++;
      sumBytes += approxBytes(row.value);
    } else if (row.key === 'model:logistic') {
      modelCount = 1;
      modelBytes += approxBytes(row.value);
    }
  }

  const [events, embeddings, items, lists, saved, hidden, seen] = await Promise.all([
    db.events.count(),
    db.embeddings.count(),
    db.items.count(),
    db.lists.count(),
    db.saved.count(),
    db.hidden.count(),
    db.seen.count(),
  ]);

  return [
    { id: 'article', label: 'Fetched article text', description: 'Extracted page bodies from the reader proxies.', count: articleCount, bytes: articleBytes, unit: 'articles' },
    { id: 'summaries', label: 'AI summaries', description: 'Cached TL;DRs and discussion summaries.', count: sumCount, bytes: sumBytes, unit: 'summaries' },
    { id: 'embeddings', label: 'Embeddings', description: 'On-device vectors for content-based ranking.', count: embeddings, bytes: 0, unit: 'vectors' },
    { id: 'events', label: 'Reading history & signals', description: 'Clicks, reads, dwell — what personalizes your feed.', count: events, bytes: 0, unit: 'events' },
    { id: 'model', label: 'Learned ranking model', description: 'The trained reranker weights.', count: modelCount, bytes: modelBytes, unit: 'model' },
    { id: 'saved', label: 'Saved stories', description: 'Stories you bookmarked.', count: saved, bytes: 0, unit: 'saved' },
    { id: 'hidden', label: 'Hidden stories', description: 'Stories you hid from feeds.', count: hidden, bytes: 0, unit: 'hidden' },
    { id: 'seen', label: 'Seen / visited markers', description: 'Which stories/discussions you\u2019ve opened.', count: seen, bytes: 0, unit: 'markers' },
    { id: 'cache', label: 'Cached stories & lists', description: 'Fetched HN items + feed lists (re-fetched as needed).', count: items + lists, bytes: 0, unit: 'items' },
  ];
}

/** Delete one data category. Returns how many rows were removed. */
export async function clearDataCategory(id: DataCategoryId): Promise<number> {
  let removed = 0;
  switch (id) {
    case 'article':
      removed = await db.kv.where('key').startsWith('atext:').delete();
      break;
    case 'summaries':
      removed = await db.kv.where('key').startsWith('sum:').delete();
      break;
    case 'model':
      removed = await db.kv.where('key').equals('model:logistic').delete();
      break;
    case 'events':
      removed = await db.events.count();
      await db.events.clear();
      break;
    case 'embeddings':
      removed = await db.embeddings.count();
      await db.embeddings.clear();
      break;
    case 'cache':
      removed = (await db.items.count()) + (await db.lists.count());
      await db.items.clear();
      await db.lists.clear();
      break;
    case 'saved':
      removed = await db.saved.count();
      await db.saved.clear();
      break;
    case 'hidden':
      removed = await db.hidden.count();
      await db.hidden.clear();
      break;
    case 'seen':
      removed = await db.seen.count();
      await db.seen.clear();
      break;
  }
  // Refresh anything derived from local data so the UI reflects the deletion.
  queryClient.invalidateQueries();
  return removed;
}
