import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { getFeedIds, getForYouCandidateIds, getItems } from '../lib/hn/client';
import { computeAffinities, getReadItemIds } from '../lib/interactions';
import type { Affinities } from '../lib/interactions';
import { computeForYou, diversifyByAuthor, diversifyByDomain, explainItem, makeContext, withPoolCenter } from '../lib/ranking/strategies';
import { isFiltered } from '../lib/ranking/features';
import type { RankExplanation } from '../lib/ranking/strategies';
import { rankerTrained } from '../lib/ranking/strategies';
import { loadModel } from '../lib/ranking/logistic';
import { buildContentProfile, computeContentSignals } from '../lib/ranking/content';
import { prefetchArticles } from '../lib/hn/article';
import { clearPinnedOrder, getFeedDepth, getPinnedOrder, resetFeedPosition, setFeedDepth, setPinnedOrder } from '../lib/feedSession';
import { usePrefs } from '../lib/prefs';
import { useHiddenIds } from './useLocalData';
import type { FeedKind, HnItem } from '../types';

const PAGE = 25;
const EMPTY_AFF: Affinities = { domains: {}, authors: {}, domainCounts: {}, authorCounts: {}, perItem: {} };

export interface FeedCard {
  item: HnItem;
  reasons: string[];
  rank?: number; // 1-based position in the For You ranking
  explain?: RankExplanation; // traceable "why ranked here" (For You only)
}

/** Stable empty-reasons array — see the note at its use site. */
const NO_REASONS: string[] = [];

export function useFeed(kind: FeedKind) {
  const prefs = usePrefs();
  const hidden = useHiddenIds();
  // Paging depth is remembered per feed for the life of the page (see lib/feedSession): this hook
  // is unmounted whenever the reader opens a discussion, so component-local state silently threw
  // away every page they had loaded on the way back.
  const [visible, setVisible] = useState(() => getFeedDepth(kind, PAGE));

  useEffect(() => {
    setVisible(getFeedDepth(kind, PAGE));
  }, [kind]);

  useEffect(() => {
    setFeedDepth(kind, visible);
  }, [kind, visible]);

  const isForYou = kind === 'foryou';
  const isRead = kind === 'read';
  const isHnList = !isForYou && !isRead;

  // Set for one fetch by an explicit Refresh so the queries bypass the IndexedDB
  // cache TTLs (ttl=0) and actually hit the network — otherwise Refresh is a no-op
  // within the ~3-min list / 15-min item cache window.
  const forceRef = useRef(false);

  // ----- Original HN feeds (top/new/best/ask/show/job) -----
  const idsQ = useQuery({
    queryKey: ['ids', kind],
    enabled: isHnList,
    queryFn: () => getFeedIds(kind as Exclude<FeedKind, 'foryou' | 'read'>, forceRef.current ? 0 : undefined),
    staleTime: 120000,
  });

  // ----- Read history (local) -----
  // Read tab: live list of what you've read (refreshes on engagement).
  const readIdsQ = useQuery({
    queryKey: ['readIds'],
    enabled: isRead,
    queryFn: () => getReadItemIds(500),
    staleTime: 10000,
  });
  // For You hides already-read stories via a LOAD-TIME SNAPSHOT (see readSnapshotQ
  // below), gated on `hideReadInFeed` (default on). The snapshot is captured once per
  // page load and fixed for the session, so a story read MID-SESSION is never yanked
  // out from under you (the old "live hide" problem); a browser refresh recomputes it,
  // so newly-read stories drop out then. This is the deliberate resolution of the
  // earlier auto-hide dead-end: keep the feed stable in-session, de-dupe on refresh.

  // Memoized so it's referentially stable (only changes when the query data changes),
  // which lets the cards memo depend on it without re-running every render.
  const ids = useMemo(
    () => (isRead ? (readIdsQ.data ?? []) : (idsQ.data ?? [])),
    [isRead, readIdsQ.data, idsQ.data]
  );
  const sliceCount = Math.min(visible, ids.length);
  // The cache key must be CONTENT-addressed, not keyed on the count alone. `['items', kind,
  // sliceCount]` ignored any change to the ids themselves, so whenever the id list changed CONTENT
  // without changing its length-after-slicing, React Query served the stale cached array: re-reading
  // a story reordered `readIds` but not the rendered list, and with >=25 items of history a
  // brand-new read pushed 30->31 while the slice stayed 25, so the story just read was missing
  // entirely. The Read tab then contradicted the sidebar's "Recently read" beside it (which keys off
  // `['recentRead']` and IS invalidated) — with no in-place recovery, since `refetchOnWindowFocus` is
  // off, so it healed only after the staleTime expired AND the user navigated away and back. Keying
  // on the ids fixes every such case at the root, and removes the same latent hazard on the HN list
  // feeds (a refetched id list of equal length would have been ignored there too).
  const slicedIds = useMemo(() => ids.slice(0, sliceCount), [ids, sliceCount]);
  const itemsQ = useQuery({
    queryKey: ['items', kind, slicedIds],
    enabled: !isForYou && sliceCount > 0,
    queryFn: () => getItems(slicedIds, 10, forceRef.current ? 0 : undefined),
    placeholderData: keepPreviousData, // keep showing current items while more load
  });

  // ----- For You (re-ranked) -----
  const poolQ = useQuery({
    queryKey: ['pool', 'foryou'],
    enabled: isForYou,
    queryFn: async () =>
      // Candidate pool: 90 (was 150) — the For-You cold start materializes each candidate
      // via a firebase N+1 (ids-only API), so the pool size dominates time-to-first-card on
      // the default landing feed. 90 keeps ample headroom for the diversity caps (domain 3 /
      // author 2) + Load-more while cutting ~40% of the cold-start item fetches.
      // Concurrency 32, not 12. These are ~1KB JSON reads against a CDN-backed endpoint, so the
      // pool spends nearly all its time waiting on round trips rather than on bandwidth or CPU; at
      // 12 the 90 candidates serialise into 8 waves and cost about a second of time-to-first-card
      // on a mobile-latency link. Browsers cap same-host HTTP/1.1 connections at 6 and multiplex
      // freely over HTTP/2, so the ceiling here is the protocol's, not ours — a higher number simply
      // stops us adding a queue on top of it. Every fetch is individually deadline-bounded, so a
      // wider pool cannot turn one slow response into a longer stall.
      getItems(await getForYouCandidateIds(90, forceRef.current ? 0 : undefined), 32, forceRef.current ? 0 : undefined),
    staleTime: 120000,
  });
  const pool = useMemo(() => poolQ.data ?? [], [poolQ.data]);

  // LOAD-TIME SNAPSHOT of already-read ids for hiding read stories from For You.
  // The snapshot is PRIMED ONCE at app startup in main.tsx (prefetchQuery), so it
  // reflects what was read at page load — NOT lazily when For You first mounts or the
  // pref flips. This query just READS that primed cache (staleTime/gcTime Infinity ⇒
  // never refetched/evicted), so it's identical regardless of the landing feed, and a
  // story read mid-session is not in it (no yank). The queryFn is a fallback for the
  // rare case the query mounts before the startup prefetch resolves (still ~load time).
  // Applied only when hideReadInFeed is on (see the cards memo).
  const readSnapshotQ = useQuery({
    queryKey: ['readSnapshot'],
    queryFn: () => getReadItemIds(1000),
    staleTime: Infinity,
    gcTime: Infinity,
  });
  const readSnapshot = useMemo(() => new Set(readSnapshotQ.data ?? []), [readSnapshotQ.data]);

  const affQ = useQuery({
    queryKey: ['affinities'],
    queryFn: computeAffinities,
    staleTime: 30000,
  });

  const modelQ = useQuery({
    queryKey: ['ranker'],
    enabled: prefs.useLearnedRanker,
    queryFn: loadModel,
    staleTime: Infinity,
  });

  // Content signals — embedding relevance + title/comment term affinity — for the
  // candidate pool. termAffinity is lexical (works without embeddings); relevance
  // needs embeddings enabled. Comment enrichment is bundled with embeddings.
  const poolIds = useMemo(() => pool.map((p) => p.id), [pool]);
  const contentQ = useQuery({
    // CONTENT-addressed, like `itemsQ` above — `pool.length` is the same
    // content-blind-key trap: Refresh swaps the pool for DIFFERENT ids of the same
    // length, the key doesn't change, and the cached signal maps (built for the OLD
    // pool) are reused. The new items aren't in those maps, so `relevance` and
    // `termAffinity` silently read 0 for every card and personalization quietly
    // degrades to popularity until an unrelated engagement invalidates ['content'].
    queryKey: ['content', prefs.embeddingsEnabled, prefs.embeddingModel, prefs.fetchArticleText, poolIds],
    enabled: isForYou && pool.length > 0,
    queryFn: async () => {
      const profile = await buildContentProfile(prefs.embeddingModel, {
        withComments: prefs.embeddingsEnabled,
        embeddings: prefs.embeddingsEnabled,
        fetchArticle: prefs.fetchArticleText,
      });
      // When the reader proxy is on, fold each candidate's cached article-body terms
      // into termAffinity so the ranker weighs the full text, not just the title.
      // Leave-one-out at SERVE time as well as at training time.
      //
      // An item you have engaged with contributes its own terms and embedding to the profile it is
      // then scored against, so it scores highly for resembling itself: measured lifting a saved
      // story from rank 5 to rank 1, and 5→1 vs a 5→3 control end-to-end. The same defect was fixed
      // for behavioural affinity by moving LOO into serve-time feature computation; the content
      // profile was simply left behind. Excluding the candidate is a no-op for anything not already
      // in the profile, so this only removes self-credit.
      return computeContentSignals(prefs.embeddingModel, pool, profile, {
        loo: true,
        articleTerms: prefs.fetchArticleText,
      });
    },
    staleTime: 120000,
  });

  // The exact context used to rank — reused by the per-item explanation so the
  // trace always matches the real score.
  const ctx = useMemo(
    () =>
      makeContext(prefs, affQ.data ?? EMPTY_AFF, {
        simById: prefs.embeddingsEnabled ? contentQ.data?.simById : undefined,
        termById: contentQ.data?.termById,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      affQ.data,
      contentQ.data,
      prefs.weights,
      prefs.followedDomains,
      prefs.followedUsers,
      prefs.mutedDomains,
      prefs.mutedUsers,
      prefs.keywordsBoost,
      prefs.keywordsMute,
      prefs.minPoints,
      prefs.embeddingsEnabled,
    ]
  );

  const activeModel = prefs.useLearnedRanker ? modelQ.data : undefined;

  // Whether For You has anything to personalize on yet. A brand-new user (no follows,
  // no boost keywords, no trained model, no real engagement affinity) gets popularity-
  // only ranking — surface that (a "warming up" banner) instead of showing a hollow
  // "why" chip on every card. (Impressions contribute tiny negative affinity, so
  // require a real engagement magnitude, not mere feed views, to count as personalized.)
  const personalized = useMemo(() => {
    if (!isForYou) return true;
    const aff = affQ.data;
    const hasAff =
      !!aff &&
      (Object.values(aff.domains).some((v) => v >= 1) || Object.values(aff.authors).some((v) => v >= 1));
    const hasFollows =
      prefs.followedDomains.length > 0 || prefs.followedUsers.length > 0 || prefs.keywordsBoost.length > 0;
    // Use the SAME gate as scoring / the sidebar / "Why #N?" (enough samples AND enough
    // positives) so the "warming up" banner never hides while the model isn't actually applied.
    const modelUsed = rankerTrained(activeModel);
    return hasAff || hasFollows || modelUsed;
  }, [isForYou, affQ.data, prefs.followedDomains, prefs.followedUsers, prefs.keywordsBoost, activeModel]);

  // ONE context for scoring AND explaining. `withPoolCenter` derives the reference the learned
  // signal is displayed against from THIS candidate pool; if the explainer were handed the plain
  // `ctx` it would center differently from the score that produced the rank, so the "Why #N?" trace
  // would not reconcile with the number it is explaining.
  const rankCtx = useMemo(
    () => (isForYou ? withPoolCenter(pool, ctx, activeModel) : ctx),
    [isForYou, pool, ctx, activeModel]
  );
  const rankedFresh = useMemo(() => {
    if (!isForYou) return [];
    // Diversify so no single domain OR author can flood the top of For You.
    return diversifyByAuthor(diversifyByDomain(computeForYou(pool, rankCtx, activeModel)));
  }, [isForYou, pool, rankCtx, activeModel]);

  // HOLD THE ORDER STILL for the rest of the session.
  //
  // Scores are deliberately live: every engagement invalidates ['affinities'] and ['content'], and a
  // background retrain invalidates ['ranker'], so the "warming up" banner clears, the sidebar counts
  // move and "Why #N?" reflects what you just did — all of which must stay. What must NOT happen is
  // the consequence that came with it: the visible list RE-SORTING underneath someone who is reading
  // it. Saving a story, or a retrain landing ~45s in, silently reshuffled the feed, so the story
  // being scrolled toward moved somewhere else. This is the same principle the read-hide snapshot
  // already applies (hide read stories at LOAD, never yank one mid-session) — it just was not
  // applied to ordering.
  //
  // So: freshly-computed ranking is kept for its SCORES, but items already on screen keep the
  // position they were given. Genuinely new items (a Load-more page, a refreshed pool) are appended
  // in their ranked order, and an explicit Refresh or a tab switch clears the pin — the order is
  // stable within a session and recomputed at a boundary the reader caused.
  // What the reader has DELIBERATELY set about the ordering. Anything in here changing means they
  // asked for a different ranking, so the pin is dropped and the feed re-sorts immediately; nothing
  // else does. Without this the pin also swallowed the "Tune ranking" sliders and the filters —
  // moving a slider changed the score and moved zero cards, while two strings in the UI promised the
  // feed "re-ranks live". A stability mechanism must not silence the controls whose entire job is to
  // restructure the thing being stabilised.
  const rankIntent = useMemo(
    () =>
      JSON.stringify([
        prefs.weights,
        prefs.minPoints,
        prefs.mutedDomains,
        prefs.mutedUsers,
        prefs.keywordsMute,
        prefs.keywordsBoost,
        prefs.followedDomains,
        prefs.followedUsers,
        prefs.useLearnedRanker,
        activeModel?.updatedAt ?? 0,
      ]),
    [
      prefs.weights,
      prefs.minPoints,
      prefs.mutedDomains,
      prefs.mutedUsers,
      prefs.keywordsMute,
      prefs.keywordsBoost,
      prefs.followedDomains,
      prefs.followedUsers,
      prefs.useLearnedRanker,
      activeModel,
    ]
  );

  const ranked = useMemo(() => {
    if (!isForYou) return rankedFresh;
    const pinned = getPinnedOrder(kind, rankIntent);
    if (!pinned || pinned.length === 0) {
      setPinnedOrder(kind, rankIntent, rankedFresh.map((r) => r.item.id));
      return rankedFresh;
    }
    const byId = new Map(rankedFresh.map((r) => [r.item.id, r]));
    const held = pinned.map((id) => byId.get(id)).filter((r): r is (typeof rankedFresh)[number] => !!r);
    const heldIds = new Set(held.map((r) => r.item.id));
    const added = rankedFresh.filter((r) => !heldIds.has(r.item.id));
    const next = [...held, ...added];
    setPinnedOrder(kind, rankIntent, next.map((r) => r.item.id));
    return next;
  }, [isForYou, rankedFresh, kind, rankIntent]);

  // Speculatively fetch article bodies for the top-ranked candidates the user hasn't
  // clicked, so the ranker/training have real page content beyond titles+comments.
  // Gated on the opt-in; bounded + throttled + single-flight inside prefetchArticles.
  const prefetchKey = isForYou && prefs.fetchArticleText ? ranked.slice(0, 8).map((r) => r.item.id).join(',') : '';
  useEffect(() => {
    if (!prefetchKey) return;
    const top = ranked.slice(0, 8).map((r) => r.item);
    void prefetchArticles(top);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefetchKey]);

  // `explainItem` builds a FRESH object on every call, so computing it inline while building
  // `cards` gave every card a new `explain` prop identity on every recompute — and `cards`
  // recomputes on any engagement (a save/hide invalidates ['affinities'] → new ctx). That defeated
  // `memo(StoryCard)` for the whole list: saving one story cost ~272ms render / ~281ms blocked
  // across two full-list commits on For You, versus ~17ms and 0ms blocked on Top — whose branch
  // already reuses a module-level NO_REASONS constant for exactly this reason. Same defect class,
  // different prop.
  //
  // Key this on the inputs the explanation actually depends on (`ranked` is itself memoized on
  // pool/rankCtx/activeModel) and NOT on the visibility inputs, so hidden/visible/readSnapshot
  // changes hand back the identical objects and untouched cards can bail out of re-rendering.
  const explains = useMemo(() => {
    if (!isForYou) return null;
    const m = new Map<number, RankExplanation>();
    for (const r of ranked) m.set(r.item.id, explainItem(r.item, rankCtx, activeModel));
    return m;
  }, [isForYou, ranked, rankCtx, activeModel]);

  const cards: FeedCard[] = useMemo(() => {
    if (isForYou) {
      // Hide already-read stories (load-time snapshot) so they don't sit in For You
      // AND the Read tab after a refresh — but only ones read BEFORE this page load,
      // so in-session reads aren't yanked out mid-session.
      const hideRead = prefs.hideReadInFeed;
      const visibleRanked = ranked
        .filter((r) => !hidden.has(r.item.id) && !(hideRead && readSnapshot.has(r.item.id)))
        .slice(0, visible);
      return visibleRanked.map((r, i) => ({
        item: r.item,
        // On a cold start the only reasons are generic ("Trending now"/"Popular") and
        // the "warming up" banner already says the feed is popularity-ranked — showing
        // an identical chip on every card is just noise, so suppress until personalized.
        reasons: personalized ? r.reasons : NO_REASONS,
        rank: i + 1,
        explain: explains?.get(r.item.id),
      }));
    }
    // A feed with NO ids has nothing to show. itemsQ uses keepPreviousData and, when the
    // target feed is empty, its query is disabled (sliceCount===0) — so React Query keeps
    // returning the PREVIOUS feed's items as a placeholder that never clears. Guard on
    // that here so switching to an empty feed (Read with no history, an empty Jobs) shows
    // the empty state, not the prior feed's stale, interactive cards. (For a populated
    // target, keepPreviousData's brief cross-feed flash during load is fine + intentional.)
    if (ids.length === 0) return [];
    // Apply the same hard filters (muted domains/users/keywords, min-points) that
    // For You uses, so muting works on EVERY feed and search — not just For You.
    // EXCEPTION: the Read tab is your reading HISTORY, not a browsing feed — marking a
    // story you genuinely read "Not interested" (hidden) should shape future ranking, not
    // erase the record that you read it. So the `read` feed keeps hidden items (global
    // mutes/min-points still apply, matching "Recently read").
    return (itemsQ.data ?? [])
      .filter((it) => (isRead || !hidden.has(it.id)) && !isFiltered(it, ctx))
      // NO_REASONS is a module-level constant, not a fresh `[]` per card: a new array identity on
      // every recompute changes StoryCard's props and defeats its `memo`, so any engagement (which
      // invalidates ['affinities'] → new ctx → this memo re-runs) re-rendered the ENTIRE loaded feed.
      .map((it) => ({ item: it, reasons: NO_REASONS }));
    // `explains` replaces the former rankCtx/activeModel deps: it is derived from both (plus
    // `ranked`) and is what this memo now reads, so listing it keeps the dependency honest while
    // letting a visibility-only change reuse the same explanation objects.
  }, [isForYou, isRead, ranked, ctx, explains, itemsQ.data, ids, hidden, visible, prefs.hideReadInFeed, readSnapshot, personalized]);

  // How many already-read stories the load-time snapshot is holding out of For You,
  // so the feed can note "N already-read hidden · see Read tab" (transparency — the
  // user shouldn't wonder where stories went). Excludes ones already Hidden.
  const readHiddenCount = useMemo(() => {
    if (!isForYou || !prefs.hideReadInFeed) return 0;
    return ranked.filter((r) => !hidden.has(r.item.id) && readSnapshot.has(r.item.id)).length;
  }, [isForYou, prefs.hideReadInFeed, ranked, hidden, readSnapshot]);

  // Count only what CAN be shown. `ranked.length` includes candidates that the hidden set and the
  // read-hide snapshot filter out a few lines below, so "of 60" appeared beside 20 cards, and once
  // every remaining candidate was filtered "Load more" was still offered and did nothing when
  // pressed. Apply the same predicate the card list uses, so the count and the button describe the
  // list the reader is actually looking at.
  const forYouShowable = useMemo(() => {
    if (!isForYou) return 0;
    const hideRead = prefs.hideReadInFeed;
    return ranked.filter((r) => !hidden.has(r.item.id) && !(hideRead && readSnapshot.has(r.item.id))).length;
  }, [isForYou, ranked, hidden, prefs.hideReadInFeed, readSnapshot]);
  const total = isForYou ? forYouShowable : ids.length;
  const hasMore = visible < total;
  const isFetchingMore = !isForYou && itemsQ.isFetching && cards.length > 0;
  const loadMore = useCallback(() => setVisible((v) => (v >= total ? v : v + PAGE)), [total]);

  const isLoading = isForYou
    ? poolQ.isLoading || affQ.isLoading
    : isRead
      ? readIdsQ.isLoading || (itemsQ.isLoading && sliceCount > 0)
      : idsQ.isLoading || (itemsQ.isLoading && sliceCount > 0);
  const isError = poolQ.isError || idsQ.isError || itemsQ.isError;

  const refetch = useCallback(() => {
    // Explicit Refresh = force a real network fetch (bypass the cache TTLs), then reset.
    forceRef.current = true;
    // Refresh is the user asking for a NEW list, so drop the remembered position: staying 90 cards
    // deep (and scrolled there) in a list that has since changed is the wrong kind of stability.
    // Everything else — opening a discussion, switching tabs — deliberately keeps it.
    resetFeedPosition(kind);
    // Refresh is the explicit boundary at which re-ordering IS wanted — drop the pinned order so the
    // new list is presented in its true ranked sequence.
    clearPinnedOrder(kind);
    setVisible(PAGE);
    const reset = () => {
      forceRef.current = false;
    };
    // For You Refresh also re-pulls the event-derived signals (affinities + content),
    // not just the candidate pool — so an explicit Refresh incorporates reading you did
    // this session, matching the on-engagement invalidation.
    if (isForYou) void Promise.all([poolQ.refetch(), affQ.refetch(), contentQ.refetch()]).finally(reset);
    else if (isRead) void readIdsQ.refetch().finally(reset);
    else void Promise.all([idsQ.refetch(), itemsQ.refetch()]).finally(reset);
  }, [kind, isForYou, isRead, poolQ, idsQ, readIdsQ, itemsQ, affQ, contentQ]);

  // When THIS feed's source data was last fetched (each tab is cached & refreshed
  // independently — they do NOT update together). Drives the "updated Xm ago" hint.
  const updatedAt = isForYou ? poolQ.dataUpdatedAt : isRead ? readIdsQ.dataUpdatedAt : idsQ.dataUpdatedAt;
  const isFetching = isForYou ? poolQ.isFetching : isRead ? readIdsQ.isFetching : idsQ.isFetching;

  return {
    cards,
    isLoading,
    isError,
    hasMore,
    isFetchingMore,
    loadMore,
    refetch,
    total,
    readHiddenCount,
    personalized,
    updatedAt,
    isFetching,
  };
}
