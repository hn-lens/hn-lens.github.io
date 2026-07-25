import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useInfiniteQuery } from '@tanstack/react-query';
import { search } from '../../lib/hn/algolia';
import { useHiddenIds, useSavedIds, useSeenMap } from '../../hooks/useLocalData';
import { usePrefs } from '../../lib/prefs';
import { makeContext } from '../../lib/ranking/strategies';
import { isFiltered } from '../../lib/ranking/features';
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
    () => makeContext(prefs, { domains: {}, authors: {}, domainCounts: {}, authorCounts: {}, perItem: {} }),
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
  // Algolia's `nbHits` counts the UNFILTERED match set, but `items` has had the user's own hard
  // filters (muted domains/users/keywords, minimum points, hidden) applied locally. Reporting the
  // raw total alone let the header say "87 results" directly above "No results." — blaming the
  // backend for the user's own filter, with no route out. Report what is actually shown, and make
  // the empty state name the real cause (parity with the feed's filter-aware empty state).
  const total = q.data?.pages[0]?.nbHits ?? 0;
  const shown = items.length;

  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="min-w-0 break-words text-sm text-muted">
          {shown < total && items.length > 0
            ? `${shown.toLocaleString()} of ${total.toLocaleString()} results for `
            : `${total.toLocaleString()} results for `}
          <span className="font-medium text-fg">“{query}”</span>
        </p>
        <div className="seg shrink-0" role="group" aria-label="Sort results">
          {(['relevance', 'new'] as const).map((s) => (
            <button key={s} type="button" aria-pressed={sort === s} onClick={() => setSort(s)} className="seg-btn capitalize">
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
            className="mt-2 rounded-lg border border-edge px-3 py-1.5 text-sm hover:bg-surface-2"
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
        total > 0 ? (
          <div className="rounded-xl border border-border bg-surface p-8 text-center">
            <p className="text-sm text-muted">
              Your filters are hiding all {total.toLocaleString()} results for{' '}
              <span className="font-medium text-fg">“{query}”</span>.
            </p>
            <p className="mt-1 text-xs text-subtle">
              Muted domains, users or keywords — or the minimum-points setting — removed every match.
            </p>
            <Link
              to="/settings"
              className="mt-4 inline-block rounded-lg border border-edge px-3 py-1.5 text-sm hover:bg-surface-2"
            >
              Check filters
            </Link>
          </div>
        ) : (
          <div className="text-sm text-muted">No results.</div>
        )
      )}
      {q.hasNextPage && (
        <button
          type="button"
          onClick={() => void q.fetchNextPage()}
          disabled={q.isFetchingNextPage}
          className="w-full rounded-xl border border-edge bg-surface py-3 text-sm text-muted hover:bg-surface-2"
        >
          {q.isFetchingNextPage ? 'Loading…' : 'Load more'}
        </button>
      )}
    </div>
  );
}
