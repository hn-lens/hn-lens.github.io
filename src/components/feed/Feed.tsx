import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Inbox, RotateCw } from 'lucide-react';
import { useFeed } from '../../hooks/useFeed';
import { useSavedIds, useSeenMap } from '../../hooks/useLocalData';
import { timeAgo } from '../../lib/time';
import { cn } from '../../lib/cn';
import StoryCard from './StoryCard';
import StorySkeleton from './StorySkeleton';
import { Spinner } from '../ui/primitives';
import { usePrefs } from '../../lib/prefs';
import type { FeedKind } from '../../types';

export default function Feed({ kind, showRank }: { kind: FeedKind; showRank?: boolean }) {
  const { cards, isLoading, isError, hasMore, isFetchingMore, loadMore, refetch, total, readHiddenCount, personalized, updatedAt, isFetching } =
    useFeed(kind);
  const saved = useSavedIds();
  const seen = useSeenMap();
  const hasFilters = usePrefs(
    (s) => s.minPoints > 0 || s.mutedDomains.length > 0 || s.mutedUsers.length > 0 || s.keywordsMute.length > 0
  );
  const sentinel = useRef<HTMLDivElement | null>(null);
  // Re-render every 30s so the "updated Xm ago" label stays current.
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 30000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasMore || isFetchingMore) return; // don't pile up loads while fetching
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) loadMore();
      },
      { rootMargin: '600px' }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [hasMore, isFetchingMore, loadMore, cards.length]);

  if (isError) {
    return (
      <div className="rounded-xl border border-border bg-surface p-6 text-center text-muted">
        <p>Couldn&apos;t load stories.</p>
        <button
          type="button"
          onClick={refetch}
          className="mt-3 inline-flex items-center gap-2 rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-surface-2"
        >
          <RotateCw className="size-4" /> Retry
        </button>
      </div>
    );
  }

  if (isLoading && cards.length === 0) {
    return (
      <div className="space-y-2.5">
        {Array.from({ length: 8 }, (_, i) => (
          <StorySkeleton key={i} />
        ))}
      </div>
    );
  }

  if (cards.length === 0) {
    // Read tab. Distinguish genuinely-no-history from "history exists but the global
    // filters (muted sites/keywords, min-points) hid all of it" — the same empty-vs-
    // filtered distinction the network feeds make. `total` is the pre-filter read count.
    if (kind === 'read') {
      if (total > 0 && hasFilters) {
        return (
          <div className="rounded-xl border border-border bg-surface p-10 text-center">
            <Inbox className="mx-auto size-8 text-subtle" />
            <p className="mt-3 text-sm text-muted">Your filters are hiding your read stories.</p>
            <p className="mt-0.5 text-xs text-subtle">
              Muted sites/keywords or a min-points threshold are hiding everything you&apos;ve read.
            </p>
            <Link
              to="/settings"
              className="mt-4 inline-block rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-surface-2"
            >
              Check filters
            </Link>
          </div>
        );
      }
      return (
        <div className="rounded-xl border border-border bg-surface p-10 text-center">
          <Inbox className="mx-auto size-8 text-subtle" />
          <p className="mt-3 text-sm text-muted">No reading history yet.</p>
          <p className="mt-0.5 text-xs text-subtle">
            Open a story and spend a little time on it — the ones you actually read collect here.
          </p>
        </div>
      );
    }
    // For You emptied only because every candidate is already-read (load-time hide) —
    // that's "all caught up", not a generic empty/refresh state.
    if (kind === 'foryou' && readHiddenCount > 0 && !hasFilters) {
      return (
        <div className="rounded-xl border border-border bg-surface p-10 text-center">
          <Inbox className="mx-auto size-8 text-subtle" />
          <p className="mt-3 text-sm text-muted">You&apos;re all caught up.</p>
          <p className="mt-0.5 text-xs text-subtle">
            Every story in For You is one you&apos;ve already read.{' '}
            <Link to="/?feed=read" className="text-accent hover:underline">
              See the Read tab
            </Link>{' '}
            or refresh for new stories.
          </p>
          <button
            type="button"
            onClick={refetch}
            className="mt-4 inline-flex items-center gap-2 rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-surface-2"
          >
            <RotateCw className="size-4" /> Refresh
          </button>
        </div>
      );
    }
    return (
      <div className="rounded-xl border border-border bg-surface p-10 text-center">
        <Inbox className="mx-auto size-8 text-subtle" />
        <p className="mt-3 text-sm text-muted">Nothing to show here.</p>
        {hasFilters ? (
          <>
            <p className="mt-0.5 text-xs text-subtle">
              Your filters (min points, muted sites/keywords) may be hiding everything.
            </p>
            <Link
              to="/settings"
              className="mt-4 inline-block rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-surface-2"
            >
              Check filters
            </Link>
          </>
        ) : (
          <>
            <p className="mt-0.5 text-xs text-subtle">Nothing here right now — try refreshing or check back soon.</p>
            <button
              type="button"
              onClick={refetch}
              className="mt-4 inline-flex items-center gap-2 rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-surface-2"
            >
              <RotateCw className="size-4" /> Refresh
            </button>
          </>
        )}
      </div>
    );
  }

  return (
    <>
      <div className="mb-2.5 flex items-center justify-between px-0.5 text-xs text-subtle">
        <span>{updatedAt ? `Updated ${timeAgo(Math.floor(updatedAt / 1000))}` : ''}</span>
        <button
          type="button"
          onClick={refetch}
          disabled={isFetching}
          className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 hover:bg-surface-2 hover:text-fg disabled:opacity-60"
        >
          <RotateCw className={cn('size-3.5', isFetching && 'animate-spin')} /> Refresh
        </button>
      </div>

      {/* For You is popularity-only until it has something to learn from — say so
          instead of showing a hollow "why" on every card. */}
      {kind === 'foryou' && !personalized && (
        <div className="mb-2.5 rounded-xl border border-border bg-surface-2 p-3 text-xs text-muted">
          <span className="font-medium text-fg">For You is warming up.</span> Until it learns your taste,
          it&apos;s ranked by popularity. Read a few stories, follow a domain from a card&apos;s ⋯ menu, or{' '}
          <Link to="/settings?section=ranking" className="text-accent hover:underline">
            tune ranking
          </Link>{' '}
          to personalize it.
        </div>
      )}

      {/* Read stories are hidden from For You on load (hideReadInFeed) — tell the user
          where they went so it doesn't look like stories silently vanished. */}
      {kind === 'foryou' && readHiddenCount > 0 && (
        <p className="mb-2.5 px-0.5 text-xs text-subtle">
          {readHiddenCount} already-read {readHiddenCount === 1 ? 'story is' : 'stories are'} hidden here ·{' '}
          <Link to="/?feed=read" className="text-accent hover:underline">
            see the Read tab
          </Link>
        </p>
      )}
      <div className="feed-list">
        {cards.map((c, i) => (
        <StoryCard
          key={c.item.id}
          item={c.item}
          reasons={c.reasons}
          seen={seen.has(c.item.id)}
          saved={saved.has(c.item.id)}
          rank={showRank ? i + 1 : undefined}
          index={i + 1}
          total={showRank ? total : undefined}
          explain={showRank ? c.explain : undefined}
        />
      ))}

      <div ref={sentinel} />

      {hasMore && (
        <button
          type="button"
          onClick={loadMore}
          disabled={isFetchingMore}
          className="flex w-full items-center justify-center gap-2 rounded-xl border border-border bg-surface py-3 text-sm text-muted hover:bg-surface-2 disabled:opacity-70"
        >
          {isFetchingMore ? (
            <>
              <Spinner /> Loading…
            </>
          ) : (
            'Load more'
          )}
        </button>
      )}
      </div>
    </>
  );
}
