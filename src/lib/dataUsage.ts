// Per-type breakdown of the LOCAL data the app stores in IndexedDB, so the user can
// delete one kind without nuking everything (e.g. drop fetched article text but keep
// downloaded models, or clear reading history but keep saved stories). Model WEIGHTS
// live in Cache Storage and are managed separately (see lib/models/storage.ts +
// CachedModels) — this covers the IndexedDB side.
import { db } from './db';
import { unhideAll } from '../hooks/useLocalData';
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
  let cacheKvCount = 0; // re-derivable kv caches surfaced under "Cached stories & lists" (topc:/cterms:)
  let cacheKvBytes = 0;
  for (const row of kv) {
    // Count `atext:` as the user-meaningful "articles" figure; the derived `aterms:` memo is deleted
    // WITH the article category (below) but not double-counted here.
    if (row.key.startsWith('atext:')) {
      articleCount++;
      articleBytes += approxBytes(row.value);
    } else if (row.key.startsWith('sum:') || row.key.startsWith('usersum:')) {
      // `usersum:` (per-user persona summaries) are AI summaries too — `'usersum:'.startsWith('sum:')`
      // is false, so they must be matched explicitly or they'd be uncounted AND undeletable.
      sumCount++;
      sumBytes += approxBytes(row.value);
    } else if (row.key === 'model:logistic') {
      modelCount = 1;
      modelBytes += approxBytes(row.value);
    } else if (row.key.startsWith('topc:') || row.key.startsWith('cterms:')) {
      cacheKvCount++;
      cacheKvBytes += approxBytes(row.value);
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
    { id: 'cache', label: 'Cached stories & lists', description: 'Fetched HN items + feed lists + comment previews (re-fetched as needed).', count: items + lists + cacheKvCount, bytes: cacheKvBytes, unit: 'items' },
  ];
}

/** Delete one data category. Returns how many rows were removed. */
export async function clearDataCategory(id: DataCategoryId): Promise<number> {
  let removed = 0;
  switch (id) {
    case 'article':
      // Delete the fetched bodies AND the derived term memo (`aterms:`) — otherwise article-derived
      // terms keep feeding termAffinity after the user believes they purged all article data.
      removed =
        (await db.kv.where('key').startsWith('atext:').delete()) +
        (await db.kv.where('key').startsWith('aterms:').delete());
      break;
    case 'summaries':
      // Include `usersum:` (persona summaries) — not a `sum:`-prefixed key, so it needs its own delete
      // or "Delete AI summaries" would silently leave persona summaries behind.
      removed =
        (await db.kv.where('key').startsWith('sum:').delete()) +
        (await db.kv.where('key').startsWith('usersum:').delete());
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
      // Also drop the re-derivable kv caches (`topc:` inline top-comment previews, `cterms:` comment
      // terms) so they're reachable per-category, not only via "Clear all" / pruneCaches.
      removed =
        (await db.items.count()) +
        (await db.lists.count()) +
        (await db.kv.where('key').startsWith('topc:').delete()) +
        (await db.kv.where('key').startsWith('cterms:').delete());
      await db.items.clear();
      await db.lists.clear();
      break;
    case 'saved':
      removed = await db.saved.count();
      await db.saved.clear();
      break;
    case 'hidden':
      removed = await db.hidden.count();
      // Route through the shared helper so this path also emits the `unhide` events that reverse
      // the hide's affinity downvote + disliked-content entry (see `unhideAll`).
      await unhideAll();
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
