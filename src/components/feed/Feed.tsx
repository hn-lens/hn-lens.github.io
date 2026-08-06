import { useEffect, useRef, useState } from 'react';
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
import { useOnline } from '../../hooks/useOnline';
import OfflineOutageHint from '../ui/OfflineOutageHint';
import type { FeedKind } from '../../types';

/**
 * How long the position hold keeps re-applying after an in-place re-order. The observed
 * compensating scroll eased over ~430ms; this covers it with margin without being long enough to
 * fight a genuine scroll that follows.
 */
const REORDER_SETTLE_MS = 1200;
/** Any of these means the reader has taken over; stop repositioning immediately. */
const USER_SCROLL_EVENTS = ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const;
/** How long an arrival keeps re-asserting the top while the list is still growing under it. */
const ARRIVE_SETTLE_MS = 1500;

export default function Feed({ kind, showRank }: { kind: FeedKind; showRank?: boolean }) {
  const {
    cards, isLoading, isError, hasMore, isFetchingMore, loadMore, refetch, total, autoAdvancing,
    readHiddenCount, explainFor, justSwept, undoSweep, dismissSweptNotice, personalized, updatedAt, isFetching,
  } = useFeed(kind);
  const saved = useSavedIds();
  const seen = useSeenMap();
  const online = useOnline();
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
  const listRef = useRef<HTMLDivElement | null>(null);
  const positionedFor = useRef<FeedKind | null>(null);

  /**
   * AN IN-PLACE RE-ORDER IS NOT THE READER MOVING — detect it, and protect their position through
   * it. This is about staying still WITHIN a visit; nothing here restores a position across one.
   *
   * When an in-place re-rank rebuilds the list under the reader, the browser's compensating scroll
   * can ease the page toward the top (visibly, because `scroll-behavior: smooth` animates it),
   * leaving the reader far from what they were reading. The re-rank itself is wanted; losing the
   * reader's place is not — so the position is captured before the rebuild and restored after.
   * (Follow/Mute from a card's ⋯ menu are deliberately NOT such a re-rank; see useFeed's rankIntent.)
   *
   * The fingerprint covers the first screenful of ids, so appending a page (whose prefix is
   * unchanged) is correctly not treated as a re-order.
   */
  /**
   * The topmost visible card and its viewport offset, kept current as the reader scrolls — the
   * position as of the last frame before a teach rebuilt the list. In memory only; it does not
   * outlive the visit.
   */
  const livePos = useRef<{ id: number; top: number } | null>(null);
  useEffect(() => {
    let queued = false;
    const measure = () => {
      queued = false;
      for (const el of listRef.current?.querySelectorAll<HTMLElement>('.story-card[data-id]') ?? []) {
        const r = el.getBoundingClientRect();
        if (r.bottom > 0) {
          const id = Number(el.dataset.id);
          if (Number.isFinite(id)) livePos.current = { id, top: r.top };
          return;
        }
      }
    };
    const onScroll = () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [kind]);

  /**
   * Pin the reader to WHERE THEY ARE. Capture the live on-screen position at the instant of the
   * teach and hold THAT, so a hold can only ever keep the view still — it can never move the reader
   * somewhere they have not been.
   */
  const armPositionHold = () => {
    // The PRE-change position, captured continuously below. Reading the DOM here instead would be
    // too late: this runs from an effect, after React has already committed the new heights and the
    // browser has already compensated, so it would faithfully pin the reader to where the reflow
    // just put them.
    const live = livePos.current;
    const el = live && listRef.current?.querySelector<HTMLElement>(`.story-card[data-id="${live.id}"]`);
    if (!el || !live) return;
    const hold = { el, top: live.top };
    const apply = () => {
      if (!hold.el.isConnected) return;
      const delta = hold.el.getBoundingClientRect().top - hold.top;
      if (Math.abs(delta) > 2) window.scrollBy({ top: delta, behavior: 'instant' as ScrollBehavior });
    };
    const ro = new ResizeObserver(apply);
    if (listRef.current) ro.observe(listRef.current);
    const stop = () => {
      ro.disconnect();
      clearTimeout(timer);
      for (const ev of USER_SCROLL_EVENTS) window.removeEventListener(ev, stop);
    };
    const timer = setTimeout(stop, REORDER_SETTLE_MS);
    // Never fight the reader: the moment they scroll or touch, the hold is over.
    for (const ev of USER_SCROLL_EVENTS) window.addEventListener(ev, stop, { passive: true });
    requestAnimationFrame(apply);
  };

  const orderFingerprint = cards.slice(0, 25).map((c) => c.item.id).join(',');
  const prevFingerprint = useRef<string>('');
  useEffect(() => {
    const prev = prevFingerprint.current;
    prevFingerprint.current = orderFingerprint;
    if (!prev || !orderFingerprint || prev === orderFingerprint) return;
    armPositionHold();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderFingerprint]);

  // The SECOND way a teach moves the page, and the one that survives a stable order. Following a
  // domain or author changes the "why" chips on every card it matches, so cards ABOVE the reader
  // change height and the document reflows under them — measured at 814px of drift with the order
  // completely unchanged (0 of 25 cards moved). An order fingerprint cannot see that, so arm the
  // hold on the teach itself: whatever the reader was looking at, they should still be looking at
  // it afterwards.
  const teachKey = usePrefs(
    (s) =>
      `${s.followedDomains.join()}|${s.followedUsers.join()}|${s.mutedDomains.join()}|${s.mutedUsers.join()}`
  );
  const prevTeachKey = useRef<string | null>(null);
  useEffect(() => {
    const prev = prevTeachKey.current;
    prevTeachKey.current = teachKey;
    if (prev === null || prev === teachKey) return; // first render is not a change
    armPositionHold();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teachKey]);

  // Arriving at a feed puts the reader at the top of it.
  //
  // Doing NOTHING is not the same thing: on an in-app return React Router leaves the window offset
  // where the previous route had it, so a reader coming back from a discussion they read to the end
  // inherits that offset and lands deep in the list. The scroll therefore has to be explicit.
  // One scroll is not enough. The list mounts short and grows, and the offset inherited from the
  // route just left is applied against whatever height exists at that instant — measured, 7149 was
  // clamped to 35 against an 835px document and stayed there, so a single scrollTo fired before it
  // and lost. Hold the top until the list stops growing, or until the reader takes over.
  useEffect(() => {
    if (positionedFor.current === kind || !cards.length) return;
    positionedFor.current = kind;
    let raf = 0;
    let done = false;
    const stop = () => {
      if (done) return;
      done = true;
      cancelAnimationFrame(raf);
      clearTimeout(timer);
      for (const ev of USER_SCROLL_EVENTS) window.removeEventListener(ev, stop);
    };
    const apply = () => {
      if (done) return;
      // 'instant': `scroll-behavior: smooth` is global, and animating an arrival reads as the page
      // drifting on its own.
      if (window.scrollY !== 0) window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
      raf = requestAnimationFrame(apply);
    };
    const timer = setTimeout(stop, ARRIVE_SETTLE_MS);
    // The reader always wins.
    for (const ev of USER_SCROLL_EVENTS) window.addEventListener(ev, stop, { passive: true });
    apply();
    // Deliberately NOT returned as cleanup: this effect re-runs on every `cards` change, which would
    // tear the hold down on the first one. It ends itself.
  }, [kind, cards.length]);

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
        <p>{online ? "Couldn't load stories." : "You're offline."}</p>
        <OfflineOutageHint />
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

  // Skeletons on the initial load, AND while the hook is actively paging past a fully-filtered
  // leading run — so the reader is never shown a terminal empty state that is not yet true.
  //
  // Gated on `autoAdvancing`, NOT on `hasMore`: when every remaining story is filtered `hasMore`
  // stays true forever, and gating on it left the feed on skeletons that never resolved. Once the
  // advance budget is spent the empty state below is the honest answer.
  //
  // Deliberately NO sentinel here either: on a card-less page a sentinel is permanently in view, so
  // the IntersectionObserver would fire loadMore on every pass and page the whole list at once.
  if (cards.length === 0 && (isLoading || autoAdvancing)) {
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
          <div data-empty-state className="rounded-xl border border-border bg-surface p-10 text-center">
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
        <div data-empty-state className="rounded-xl border border-border bg-surface p-10 text-center">
          <Inbox className="mx-auto size-8 text-subtle" />
          <p className="mt-3 text-sm text-muted">No reading history yet.</p>
          <p className="mt-0.5 text-xs text-subtle">
            Open a story and spend a little time on it — the ones you actually read collect here.
          </p>
        </div>
      );
    }
    // For You emptied only because every candidate is already-read (the read sweep) —
    // that's "all caught up", not a generic empty/refresh state.
    if (kind === 'foryou' && readHiddenCount > 0 && !hasFilters) {
      return (
        <div data-empty-state className="rounded-xl border border-border bg-surface p-10 text-center">
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
      <div data-empty-state className="rounded-xl border border-border bg-surface p-10 text-center">
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
      {/* One row at every width: the status is the flexible filler and ellipsises, the controls keep
          their size. Wrapping instead of shrinking put "Updated just now" alone on a line at 30% fill
          with both controls orphaned beneath it. The control group can shrink now — its label folds
          below 26rem — which is what makes a single row safe; without that it overflowed the PAGE,
          clipping "Refresh" off-screen in the narrowest layout (`compact`, the terminal and cyberpunk
          designs' default). The threshold sets only how much status text survives, not whether the
          row holds: the shrink path carries that at any text size. */}
      <div className="feed-meta mb-2.5 flex flex-nowrap items-center justify-between gap-x-2 px-0.5 text-xs text-subtle">
        <span className="feed-meta-status min-w-0 flex-1 truncate">
          {updatedAt ? `Updated ${timeAgo(Math.floor(updatedAt / 1000))}` : ''}
        </span>
        <div className="flex flex-nowrap items-center gap-1.5">
          <button
            type="button"
            role="switch"
            aria-checked={showTopComments}
            // Disabled where previews are never rendered (the one-line Compact layout): toggling it
            // there changed nothing, so it read as a broken control. The note + title point at the fix.
            disabled={topCommentsUnavailable}
            onClick={() => setPref({ showTopComments: !showTopComments })}
            // Carries the name once the word folds, so the control keeps it at every width.
            aria-label="Top comments"
            title={
              topCommentsUnavailable
                ? 'Not shown in the Compact layout (one line per story) — switch layout in Settings to see previews'
                : 'Show the top comment under each story'
            }
            className="inline-flex shrink-0 items-center gap-1.5 rounded-md px-1.5 py-1 hover:bg-surface-2 hover:text-fg disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent disabled:hover:text-subtle"
          >
            <MessageSquare className="size-3.5" />
            <span className="max-[26rem]:hidden">Top comments</span>
            {/* shared switch visual (see controls.tsx) so the feed + Settings switches match */}
            <SwitchVisual checked={showTopComments} size="sm" />
          </button>

          <button
            type="button"
            onClick={refetch}
            disabled={isFetching}
            className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 hover:bg-surface-2 hover:text-fg disabled:opacity-60"
          >
            <RotateCw className={cn('size-3.5', isFetching && 'animate-spin')} /> Refresh
          </button>
        </div>
      </div>

      {/* Why the switch above reads as on while no previews appear. It sits on its own line rather
          than in the row: it is an explanation, not a control, and competing for width in there
          pushed the page sideways at 320px — while hiding it left the contradiction unexplained on
          exactly the screens that can least afford a mystery. */}
      {topCommentsUnavailable && showTopComments && (
        <p className="mb-2.5 px-0.5 text-[11px] text-subtle">Top comments aren&apos;t shown in the Compact layout.</p>
      )}

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

      {/* What the LAST Refresh just removed — the transient, dismissible notice for the Refresh sweep
          specifically. (The design-#4 load-time sweep is announced by the standing note below.) A
          membership change must be announced and reversible: an earlier design removed read stories
          silently, which is how a reader ended up clicking the wrong story. Shown once, until
          dismissed or undone. */}
      {kind === 'foryou' && justSwept !== null && justSwept > 0 && (
        <div className="mb-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-edge bg-surface-2 px-3 py-2 text-xs">
          <span className="text-fg">
            Hid {justSwept} {justSwept === 1 ? 'story' : 'stories'} you&apos;ve already read
          </span>
          <button type="button" onClick={undoSweep} className="font-medium text-accent hover:underline">
            Undo
          </button>
          <Link to="/?feed=read" className="text-muted hover:underline">
            see the Read tab
          </Link>
          <button type="button" onClick={dismissSweptNotice} className="ml-auto text-muted hover:text-fg">
            Dismiss
          </button>
        </div>
      )}

      {/* The standing count of what is currently hidden, so the feed never looks shorter than it is
          for an unexplained reason. This is the announcement for the design-#4 load-time sweep (a
          fresh load / reload hides already-read stories); the Undo makes that reversible for the
          session, satisfying "membership changes must be visible AND reversible". Undo is omitted
          while the transient post-Refresh notice above shows its own, so there is only ever one. */}
      {kind === 'foryou' && readHiddenCount > 0 && (
        <p className="mb-2.5 px-0.5 text-xs text-subtle">
          {readHiddenCount} already-read {readHiddenCount === 1 ? 'story is' : 'stories are'} hidden here ·{' '}
          {justSwept === null && (
            <>
              <button type="button" onClick={undoSweep} className="text-accent hover:underline">
                Undo
              </button>{' '}
              ·{' '}
            </>
          )}
          <Link to="/?feed=read" className="text-accent hover:underline">
            see the Read tab
          </Link>
        </p>
      )}


      <div className="feed-list" ref={listRef}>
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
          explainable={showRank ? c.explainable : undefined}
          explainFor={explainFor}
          hiddenStub={c.hiddenStub}
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
