import { useMemo, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { search } from '../../lib/hn/algolia';
import { useHiddenIds, useSavedIds, useSeenMap } from '../../hooks/useLocalData';
import { usePrefs } from '../../lib/prefs';
import { makeContext } from '../../lib/ranking/strategies';
import { isFiltered } from '../../lib/ranking/features';
import { cn } from '../../lib/cn';
import StoryCard from './StoryCard';
import StorySkeleton from './StorySkeleton';
import type { AlgoliaHit, HnItem } from '../../types';

function hitToItem(h: AlgoliaHit): HnItem {
  return {
    id: Number(h.objectID),
    title: h.title,
    url: h.url,
    by: h.author,
    score: h.points,
    descendants: h.num_comments,
    time: h.created_at_i,
    type: 'story',
  };
}

export default function SearchResults({ query }: { query: string }) {
  const saved = useSavedIds();
  const seen = useSeenMap();
  const hidden = useHiddenIds();
  const prefs = usePrefs();
  const [sort, setSort] = useState<'relevance' | 'new'>('relevance');

  // Muted domains/users/keywords + min-points apply to search too, not just For You.
  const filterCtx = useMemo(
    () => makeContext(prefs, { domains: {}, authors: {}, domainCounts: {}, authorCounts: {} }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [prefs.mutedDomains, prefs.mutedUsers, prefs.keywordsMute, prefs.minPoints]
  );

  const q = useInfiniteQuery({
    queryKey: ['search', query, sort],
    queryFn: ({ pageParam }) =>
      search({ query, tags: 'story', page: pageParam, hitsPerPage: 25, byDate: sort === 'new' }),
    initialPageParam: 0,
    getNextPageParam: (last) => (last.page + 1 < last.nbPages ? last.page + 1 : undefined),
  });

  const seenIds = new Set<number>();
  const items = (q.data?.pages.flatMap((p) => p.hits.map(hitToItem)) ?? []).filter((it) => {
    if (hidden.has(it.id)) return false; // hidden is global — filter search too (mirrors useFeed)
    if (isFiltered(it, filterCtx)) return false;
    if (seenIds.has(it.id)) return false; // Algolia can repeat a hit across pages — de-dupe
    seenIds.add(it.id);
    return true;
  });
  const total = q.data?.pages[0]?.nbHits ?? 0;

  return (
    <div className="space-y-2.5">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted">
          {total.toLocaleString()} results for{' '}
          <span className="font-medium text-fg">“{query}”</span>
        </p>
        <div className="flex items-center gap-1 text-xs">
          {(['relevance', 'new'] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setSort(s)}
              className={cn(
                'rounded-md px-2 py-1 capitalize',
                sort === s ? 'bg-surface-2 text-fg' : 'text-muted hover:text-fg'
              )}
            >
              {s === 'new' ? 'newest' : 'relevance'}
            </button>
          ))}
        </div>
      </div>

      {q.isLoading &&
        Array.from({ length: 6 }, (_, i) => <StorySkeleton key={i} />)}
      {/* An outage must look different from "nothing found" — show an error + Retry, not
          an empty "No results" (parity with the feed's outage state). */}
      {q.isError && !q.isLoading && (
        <div className="rounded-xl border border-border bg-surface p-6 text-center">
          <p className="text-sm text-muted">Couldn&apos;t load results.</p>
          <button
            type="button"
            onClick={() => void q.refetch()}
            className="mt-2 rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-surface-2"
          >
            Retry
          </button>
        </div>
      )}
      {items.map((item) => (
        <StoryCard
          key={item.id}
          item={item}
          reasons={[]}
          seen={seen.has(item.id)}
          saved={saved.has(item.id)}
        />
      ))}
      {!q.isLoading && !q.isError && items.length === 0 && (
        <div className="text-sm text-muted">No results.</div>
      )}
      {q.hasNextPage && (
        <button
          type="button"
          onClick={() => void q.fetchNextPage()}
          disabled={q.isFetchingNextPage}
          className="w-full rounded-xl border border-border bg-surface py-3 text-sm text-muted hover:bg-surface-2"
        >
          {q.isFetchingNextPage ? 'Loading…' : 'Load more'}
        </button>
      )}
    </div>
  );
}
