import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Inbox, MessageSquare, RotateCw } from 'lucide-react';
import { useFeed } from '../../hooks/useFeed';
import { useSavedIds, useSeenMap } from '../../hooks/useLocalData';
import { timeAgo } from '../../lib/time';
import { cn } from '../../lib/cn';
import StoryCard from './StoryCard';
import StorySkeleton from './StorySkeleton';
import { Spinner } from '../ui/primitives';
import { SwitchVisual } from '../ui/controls';
import { usePrefs } from '../../lib/prefs';
import { effectiveLayout } from '../../lib/themes';
import { getFeedScroll, setFeedScroll } from '../../lib/feedSession';
import type { FeedKind } from '../../types';

export default function Feed({ kind, showRank }: { kind: FeedKind; showRank?: boolean }) {
  const { cards, isLoading, isError, hasMore, isFetchingMore, loadMore, refetch, total, readHiddenCount, personalized, updatedAt, isFetching } =
    useFeed(kind);
  const saved = useSavedIds();
  const seen = useSeenMap();
  const hasFilters = usePrefs(
    (s) => s.minPoints > 0 || s.mutedDomains.length > 0 || s.mutedUsers.length > 0 || s.keywordsMute.length > 0
  );
  const showTopComments = usePrefs((s) => s.showTopComments);
  const setPref = usePrefs((s) => s.set);
  // The one-line `compact` layout deliberately doesn't render the inline preview (it would crush the
  // headline). A switch that is visible, enabled and ON while doing nothing is a trust break — and
  // users land here without asking for it, since some DESIGNS default to this layout. Say so on the
  // control itself rather than leaving it silently inert.
  const themeName = usePrefs((s) => s.themeName);
  const layoutPref = usePrefs((s) => s.layout);
  const topCommentsUnavailable = effectiveLayout(themeName, layoutPref) === 'compact';
  const sentinel = useRef<HTMLDivElement | null>(null);

  // Restore the reader's scroll position for this feed (see lib/feedSession).
  //
  // The paging half of that module was wired; this half never was, so depth restored (50 cards came
  // back) while scrollY snapped to 0 — leaving the reader at the top of a long list they had already
  // walked, which is arguably worse than a short one. It looked fixed if you only tested browser
  // Back, because the browser restores scroll natively there; the in-app path had nothing.
  //
  // Restore in a LAYOUT effect and only once the page is actually tall enough: the restored cards
  // render after this component mounts, and scrolling to 3860 on a page that is still 800px tall
  // silently clamps to the bottom. Retry across a few frames, then give up rather than fight the
  // user if they have already started scrolling themselves.
  const restoredFor = useRef<string | null>(null);
  useLayoutEffect(() => {
    const want = getFeedScroll(kind);
    if (restoredFor.current === kind) return;
    restoredFor.current = kind;
    if (want <= 0) return;
    let frames = 0;
    let cancelled = false;
    const tryRestore = () => {
      if (cancelled) return;
      if (document.documentElement.scrollHeight - window.innerHeight >= want) {
        window.scrollTo(0, want);
        return;
      }
      if (frames++ < 40) requestAnimationFrame(tryRestore);
    };
    requestAnimationFrame(tryRestore);
    return () => {
      cancelled = true;
    };
  }, [kind]);

  // Record it continuously, throttled through rAF so a scroll never does layout work per event.
  useEffect(() => {
    let queued = false;
    const onScroll = () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        setFeedScroll(kind, window.scrollY);
      });
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      // Capture the final position on unmount too — navigating into a discussion does not
      // necessarily fire a scroll event first.
      setFeedScroll(kind, window.scrollY);
    };
  }, [kind]);

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
          className="mt-3 inline-flex items-center gap-2 rounded-lg border border-edge px-3 py-1.5 text-sm hover:bg-surface-2"
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
              className="mt-4 inline-block rounded-lg border border-edge px-3 py-1.5 text-sm hover:bg-surface-2"
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
            className="mt-4 inline-flex items-center gap-2 rounded-lg border border-edge px-3 py-1.5 text-sm hover:bg-surface-2"
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
              className="mt-4 inline-block rounded-lg border border-edge px-3 py-1.5 text-sm hover:bg-surface-2"
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
              className="mt-4 inline-flex items-center gap-2 rounded-lg border border-edge px-3 py-1.5 text-sm hover:bg-surface-2"
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
      {/* Wraps, like .sc-actions. This row is a nowrap flex whose control group cannot shrink, so it
          overflowed the PAGE with "Refresh" clipped off-screen — reachable with NO non-default
          setting, because the terminal and cyberpunk DESIGNS default to the `compact` layout, which
          is the narrowest. Wrappability is a property of a control row, not of one layout. */}
      <div className="mb-2.5 flex flex-wrap items-center justify-between gap-x-2 gap-y-1 px-0.5 text-xs text-subtle">
        <span className="min-w-0 truncate">{updatedAt ? `Updated ${timeAgo(Math.floor(updatedAt / 1000))}` : ''}</span>
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            role="switch"
            aria-checked={showTopComments}
            onClick={() => setPref({ showTopComments: !showTopComments })}
            title={
              topCommentsUnavailable
                ? 'Not shown in the Compact layout (one line per story) — switch layout in Settings to see previews'
                : 'Show the top comment under each story'
            }
            className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 hover:bg-surface-2 hover:text-fg"
          >
            <MessageSquare className="size-3.5" />
            <span>Top comments</span>
            {/* shared switch visual (see controls.tsx) so the feed + Settings switches match */}
            <SwitchVisual checked={showTopComments} size="sm" />
          </button>
          {topCommentsUnavailable && showTopComments && (
            <span className="text-[11px] text-subtle">not shown in Compact layout</span>
          )}
          <button
            type="button"
            onClick={refetch}
            disabled={isFetching}
            className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 hover:bg-surface-2 hover:text-fg disabled:opacity-60"
          >
            <RotateCw className={cn('size-3.5', isFetching && 'animate-spin')} /> Refresh
          </button>
        </div>
      </div>

      {/* For You is popularity-only until it has something to learn from — say so
          instead of showing a hollow "why" on every card. */}
      {kind === 'foryou' && !personalized && (
        <div className="mb-2.5 rounded-xl border border-border bg-surface-2 p-3 text-xs text-muted">
          <span className="font-medium text-fg">For You is warming up.</span> Until it learns your taste,
          it&apos;s ranked by popularity. Read a few stories, or{' '}
          <Link to="/settings?section=filters" className="text-accent hover:underline">
            follow domains &amp; keywords
          </Link>{' '}
          and{' '}
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
          className="flex w-full items-center justify-center gap-2 rounded-xl border border-edge bg-surface py-3 text-sm text-muted hover:bg-surface-2 disabled:opacity-70"
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
