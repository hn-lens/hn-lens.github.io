import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { getFeedIds, getForYouCandidateIds, getItems } from '../lib/hn/client';
import { computeAffinities, getReadItemIds } from '../lib/interactions';
import type { Affinities } from '../lib/interactions';
import { computeForYou, diversifyByAuthor, diversifyByDomain, explainItem, makeContext } from '../lib/ranking/strategies';
import { isFiltered } from '../lib/ranking/features';
import type { RankExplanation } from '../lib/ranking/strategies';
import { loadModel, MIN_TRAIN_SAMPLES } from '../lib/ranking/logistic';
import { buildContentProfile, computeContentSignals } from '../lib/ranking/content';
import { prefetchArticles } from '../lib/hn/article';
import { usePrefs } from '../lib/prefs';
import { useHiddenIds } from './useLocalData';
import type { FeedKind, HnItem } from '../types';

const PAGE = 25;
const EMPTY_AFF: Affinities = { domains: {}, authors: {}, domainCounts: {}, authorCounts: {} };

export interface FeedCard {
  item: HnItem;
  reasons: string[];
  rank?: number; // 1-based position in the For You ranking
  explain?: RankExplanation; // traceable "why ranked here" (For You only)
}

export function useFeed(kind: FeedKind) {
  const prefs = usePrefs();
  const hidden = useHiddenIds();
  const [visible, setVisible] = useState(PAGE);

  useEffect(() => {
    setVisible(PAGE);
  }, [kind]);

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
  const itemsQ = useQuery({
    queryKey: ['items', kind, sliceCount],
    enabled: !isForYou && sliceCount > 0,
    queryFn: () => getItems(ids.slice(0, sliceCount), 10, forceRef.current ? 0 : undefined),
    placeholderData: keepPreviousData, // keep showing current items while more load
  });

  // ----- For You (re-ranked) -----
  const poolQ = useQuery({
    queryKey: ['pool', 'foryou'],
    enabled: isForYou,
    queryFn: async () =>
      getItems(await getForYouCandidateIds(150, forceRef.current ? 0 : undefined), 12, forceRef.current ? 0 : undefined),
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
  const contentQ = useQuery({
    queryKey: ['content', prefs.embeddingsEnabled, prefs.embeddingModel, prefs.fetchArticleText, pool.length],
    enabled: isForYou && pool.length > 0,
    queryFn: async () => {
      const profile = await buildContentProfile(prefs.embeddingModel, {
        withComments: prefs.embeddingsEnabled,
        embeddings: prefs.embeddingsEnabled,
        fetchArticle: prefs.fetchArticleText,
      });
      // When the reader proxy is on, fold each candidate's cached article-body terms
      // into termAffinity so the ranker weighs the full text, not just the title.
      return computeContentSignals(prefs.embeddingModel, pool, profile, {
        loo: false,
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
    const modelUsed = !!activeModel && activeModel.n >= MIN_TRAIN_SAMPLES;
    return hasAff || hasFollows || modelUsed;
  }, [isForYou, affQ.data, prefs.followedDomains, prefs.followedUsers, prefs.keywordsBoost, activeModel]);

  const ranked = useMemo(() => {
    if (!isForYou) return [];
    // Diversify so no single domain OR author can flood the top of For You.
    return diversifyByAuthor(diversifyByDomain(computeForYou(pool, ctx, activeModel)));
  }, [isForYou, pool, ctx, activeModel]);

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
        reasons: personalized ? r.reasons : [],
        rank: i + 1,
        explain: explainItem(r.item, ctx, activeModel),
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
    return (itemsQ.data ?? [])
      .filter((it) => !hidden.has(it.id) && !isFiltered(it, ctx))
      .map((it) => ({ item: it, reasons: [] as string[] }));
  }, [isForYou, ranked, ctx, activeModel, itemsQ.data, ids, hidden, visible, prefs.hideReadInFeed, readSnapshot, personalized]);

  // How many already-read stories the load-time snapshot is holding out of For You,
  // so the feed can note "N already-read hidden · see Read tab" (transparency — the
  // user shouldn't wonder where stories went). Excludes ones already Hidden.
  const readHiddenCount = useMemo(() => {
    if (!isForYou || !prefs.hideReadInFeed) return 0;
    return ranked.filter((r) => !hidden.has(r.item.id) && readSnapshot.has(r.item.id)).length;
  }, [isForYou, prefs.hideReadInFeed, ranked, hidden, readSnapshot]);

  const total = isForYou ? ranked.length : ids.length;
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
    const reset = () => {
      forceRef.current = false;
    };
    // For You Refresh also re-pulls the event-derived signals (affinities + content),
    // not just the candidate pool — so an explicit Refresh incorporates reading you did
    // this session, matching the on-engagement invalidation.
    if (isForYou) void Promise.all([poolQ.refetch(), affQ.refetch(), contentQ.refetch()]).finally(reset);
    else if (isRead) void readIdsQ.refetch().finally(reset);
    else void Promise.all([idsQ.refetch(), itemsQ.refetch()]).finally(reset);
  }, [isForYou, isRead, poolQ, idsQ, readIdsQ, itemsQ, affQ, contentQ]);

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
