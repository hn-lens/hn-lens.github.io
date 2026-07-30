import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getFeedIds, getForYouCandidates, getItems } from '../lib/hn/client';
import { computeAffinities, getReadItemIds } from '../lib/interactions';
import type { Affinities } from '../lib/interactions';
import { computeForYou, diversifyByAuthor, diversifyByDomain, explainItem, makeContext, withPoolCenter } from '../lib/ranking/strategies';
import { isFiltered } from '../lib/ranking/features';
import type { RankExplanation } from '../lib/ranking/strategies';
import { rankerTrained } from '../lib/ranking/strategies';
import { loadModel } from '../lib/ranking/logistic';
import { buildContentProfile, computeContentSignals } from '../lib/ranking/content';
import { prefetchArticles } from '../lib/hn/article';
import { clearPinnedOrder, getFeedDepth, getPinnedOrder, hiddenStubsSnapshot, subscribeHiddenStubs, resetFeedPosition, setFeedDepth, setPinnedOrder } from '../lib/feedSession';
import { applyReadSweep, peekReadSweep, undoReadSweep } from '../lib/readSweep';
import { usePrefs } from '../lib/prefs';
import { useHiddenIds } from './useLocalData';
import type { FeedKind, HnItem } from '../types';

const PAGE = 25;
// How many extra pages the feed may materialise on its own to get past a fully-filtered leading run.
// 3 pages (~75 further stories) clears any realistic filtered head; past that the filters really are
// hiding everything and the reader should be told so rather than watching skeletons.
const MAX_AUTO_ADVANCE = 3;
const EMPTY_AFF: Affinities = { domains: {}, authors: {}, domainCounts: {}, authorCounts: {}, perItem: {} };

/**
 * Hold a list in the order the reader last saw it.
 *
 * Survivors keep their relative order and genuine newcomers are appended rather than interleaved,
 * so nothing already on screen moves. Anything that has left the source is dropped.
 *
 * Shared by the personalized and the plain feeds deliberately. The plain feeds were left unpinned
 * on the theory that Top should simply be "HN's order" — but the list TTL is three minutes, so a
 * reader who spent that long in a discussion came back to a re-sorted page: measured on live Top,
 * 10 of 25 cards changed position with nothing added or removed, the aimed-at story slid two rows,
 * and the click opened something else. Refresh still clears the pin and shows the true current
 * order, which is where "give me HN's order" belongs.
 */
function holdOrder<T>(
  kind: FeedKind,
  intent: string,
  fresh: T[],
  idOf: (x: T) => number
): T[] {
  // NOTHING TO PIN YET. On the first render of every load `fresh` is empty (the pool/items query
  // has not resolved), and writing that empty list DESTROYED the persisted pin before rebuilding it
  // from a newly-computed ranking. Measured: `{foryou:0},{foryou:0},{foryou:40},{foryou:40}` on
  // every reload, after which 25 of 25 cards had moved and 5 had dropped out of view — the exact
  // mis-click this pin exists to prevent, reintroduced by the pin's own bookkeeping.
  if (fresh.length === 0) return fresh;
  const pinned = getPinnedOrder(kind, intent);
  if (!pinned || pinned.length === 0) {
    setPinnedOrder(kind, intent, fresh.map(idOf));
    return fresh;
  }
  const byId = new Map(fresh.map((x) => [idOf(x), x] as const));
  const held = pinned.map((id) => byId.get(id)).filter((x): x is T => x !== undefined);
  const heldIds = new Set(held.map(idOf));
  const list = [...held, ...fresh.filter((x) => !heldIds.has(idOf(x)))];
  setPinnedOrder(kind, intent, list.map(idOf));
  return list;
}

export interface FeedCard {
  item: HnItem;
  reasons: string[];
  rank?: number; // 1-based position in the For You ranking
  /**
   * Whether this card HAS a traceable "why ranked here" (For You only). The explanation itself is
   * fetched on demand through the hook's stable `explainFor(id)`, never handed down as an object:
   * a fresh object per card per ranking recompute is what defeated `memo(StoryCard)` for the whole
   * list on every save/hide/read.
   */
  explainable?: boolean;
  /** Hidden during THIS session: render a placeholder so the list does not shift under the reader. */
  hiddenStub?: boolean;
}

/** Stable empty-reasons array — see the note at its use site. */
const NO_REASONS: string[] = [];

/**
 * Hand back the PREVIOUS array whenever the new one has the same contents.
 *
 * `computeForYou` builds a fresh `reasons` array for every candidate on every re-rank, so a card
 * whose reasons were identical still received a new prop identity and re-rendered — the same defect
 * as the per-card explanation OBJECT, in the prop right next to it. Ranking recomputes on every
 * save, hide and read (they invalidate ['affinities'] and ['content']), so on the personalized feed
 * that was the whole list, every time: measured ~200ms of blocked frames at 90 cards against 0ms
 * for the same action on Top, whose cards share one constant empty array.
 *
 * Identity is the only thing being preserved here; the contents are compared, so a reason that
 * genuinely changes still propagates.
 */
function stableReasons(cache: Map<number, string[]>, id: number, next: string[]): string[] {
  const prev = cache.get(id);
  if (prev && prev.length === next.length && prev.every((v, i) => v === next[i])) return prev;
  cache.set(id, next);
  return next;
}

export function useFeed(kind: FeedKind) {
  const prefs = usePrefs();
  const hidden = useHiddenIds();
  // Paging depth is remembered per feed for the life of the page (see lib/feedSession): this hook
  // is unmounted whenever the reader opens a discussion, so component-local state silently threw
  // away every page they had loaded on the way back.
  const [visible, setVisible] = useState(() => getFeedDepth(kind, PAGE));
  const qc = useQueryClient();
  // How many stories the LAST explicit Refresh swept out of view, so the feed can say so and offer
  // an Undo. Null means "nothing to report" — a silent removal is the defect being fixed.
  const [justSwept, setJustSwept] = useState<number | null>(null);
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

  // A Refresh's force-network flag belongs ONLY to the tab that pressed Refresh. This hook is NOT
  // remounted on a tab switch (Home renders one <Feed> whose `kind` prop changes), so `forceRef`
  // would otherwise survive into the next feed: switch tabs while a Refresh is still in flight and
  // the tab you land on inherits force=true, bypassing its cache and re-fetching it from the
  // network — a Refresh silently refreshing another tab. Clear it synchronously on any kind change,
  // before this render wires up the new tab's queries. (A Refresh does not change `kind`, so it is
  // unaffected.)
  const kindRef = useRef(kind);
  if (kindRef.current !== kind) {
    kindRef.current = kind;
    forceRef.current = false;
  }

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
  // For You hides already-read stories using the read SWEEP (lib/readSweep), gated on
  // `hideReadInFeed` (default on). The set is recomputed on every fresh document load (reload /
  // new tab, seeded in main.tsx) and by Refresh — NEVER on in-app navigation — and is fixed for
  // the life of a page load, so a story read this session is not yanked. See SPEC.md section 4.

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
    // 6, matching the browser's per-origin HTTP/1.1 cap — see the note on the For-You pool below.
    queryFn: () => getItems(slicedIds, 6, forceRef.current ? 0 : undefined),
    // Keep the previous items ONLY within the SAME feed (load-more / refetch), so paging stays smooth.
    // Across a TAB SWITCH (kind changes) return undefined instead: showing the OTHER tab's cards for
    // ~1s until the new feed loads is worse than a brief skeleton — you clicked "Best" and were still
    // looking at "Top". A revisited tab still shows instantly from its own cache; only a first,
    // uncached visit shows a skeleton, and it is the NEW tab's skeleton, never the wrong tab's list.
    placeholderData: (prev, prevQuery) => (prevQuery?.queryKey?.[1] === kind ? prev : undefined),
  });

  // ----- For You (re-ranked) -----
  // ONE request for the whole candidate pool. Algolia's recent-stories search (tags=story + a recency
  // filter, see getForYouCandidates) returns fully-materialised stories (title/url/points/comments/
  // author/time), so For You needs neither the three-list firebase merge nor the per-item N+1 — the
  // two dominant cold-start costs. 90 keeps ample headroom for the diversity caps (domain 3 /
  // author 2) + Load-more. On an Algolia failure
  // `getForYouCandidates` falls back to the firebase path (see client.ts), so this stays resilient.
  const poolQ = useQuery({
    queryKey: ['pool', 'foryou'],
    enabled: isForYou,
    queryFn: () => getForYouCandidates(90, forceRef.current ? 0 : undefined),
    staleTime: 120000,
  });
  const pool = useMemo(() => poolQ.data ?? [], [poolQ.data]);

  // The read SWEEP: ids hidden from For You. Seeded once per document load (reload / new tab) in
  // main.tsx, updated by Refresh, and read here; the queryFn is the same pure read, so a cache
  // invalidation cannot change the set. Applied only when hideReadInFeed is on (see the cards memo).
  const readSnapshotQ = useQuery({
    queryKey: ['readSnapshot'],
    queryFn: () => peekReadSweep(),
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
  // Subscribed, not derived from `hidden`: the stub set lives in sessionStorage, and Refresh clears
  // it WITHOUT touching db.hidden, so a memo keyed on the Dexie query rendered a cleared stub until
  // some unrelated dismissal recomputed it and the row vanished mid-list.
  const stubIds = useSyncExternalStore(subscribeHiddenStubs, hiddenStubsSnapshot, hiddenStubsSnapshot);
  const stubs = useMemo(() => new Set(stubIds), [stubIds]);

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
  // in their ranked order, and an explicit Refresh clears the pin — the order is stable within a
  // session and recomputed at the boundary the reader caused. NOT a tab switch: switching Top -> New
  // -> Top leaves Top's pin intact, which is the intended behaviour (only Refresh re-sorts). An
  // earlier version of this sentence also listed a tab switch, was reported as false, and survived
  // into another round — so it is spelled out here rather than left to be re-derived.
  // What the reader has DELIBERATELY set about the ordering. Anything in here changing means they
  // asked for a different ranking, so the pin is dropped and the feed re-sorts immediately; nothing
  // else does. Without this the pin also swallowed the "Tune ranking" sliders and the filters —
  // moving a slider changed the score and moved zero cards, while two strings in the UI promised the
  // feed "re-ranks live". A stability mechanism must not silence the controls whose entire job is to
  // restructure the thing being stabilised.
  //
  // FOLLOW/MUTE ARE DELIBERATELY ABSENT, for the same reason the retrained model is (see below).
  // They are reachable from a story card's ⋯ menu (Follow/Mute), where the reader is mid-article,
  // not asking for a new list. Treating a teach as a re-rank request would re-order the visible
  // cards under the reader and let the browser's compensating scroll carry them away from what they
  // were reading, announced only as "Following <domain>". A teach is not a re-sort request: the
  // preference is recorded immediately and shapes the ranking, it just lands at the next boundary
  // the reader causes.
  //
  // This costs nothing in responsiveness where it matters, because MEMBERSHIP is filtered
  // separately and still applies at once: a muted domain's stories leave the list immediately via
  // `isFiltered`, they simply do not drag every other card around with them.
  const rankIntent = useMemo(
    () =>
      JSON.stringify([
        prefs.weights,
        prefs.minPoints,
        prefs.keywordsMute,
        prefs.keywordsBoost,
        prefs.useLearnedRanker,
        // NOT the model's updatedAt. Including it made a BACKGROUND retrain count as a deliberate
        // change of intent, so the feed re-sorted itself ~15s after the reader engaged with
        // anything — with no user action at all, which is precisely the defect the pin exists to
        // prevent, and it shipped disabled-by-its-own-fix. The retrained model still takes effect;
        // it just does so at the next Refresh, which is what clears the pin (a tab switch keeps the
        // pin, and a reload continues the session), exactly like every other input here.
      ]),
    [prefs.weights, prefs.minPoints, prefs.keywordsMute, prefs.keywordsBoost, prefs.useLearnedRanker]
  );

  const ranked = useMemo(() => {
    // The pin applies to EVERY browsing feed, not just the personalized one.
    //
    // It used to be For-You-only, on the reasoning that Top is "HN's order" and should just show
    // it. But HN's order genuinely churns, and the list TTL is three minutes — so a reader who
    // spent that long in a discussion came back to a silently re-sorted page. Measured on live Top:
    // 10 of 25 cards changed position with nothing added or removed, the aimed-at story slid from
    // 11 to 13, and the click landed on an unrelated article. Nothing on screen said anything had
    // moved.
    //
    // Pinning does not make Top stale: the intent fingerprint still re-ranks on any deliberate
    // change, new arrivals are appended rather than dropped, and Refresh clears the pin and shows
    // the true current order. What it removes is the feed re-sorting itself while nobody asked.
    // Ranking itself is a For-You concept — the plain feeds arrive already ordered by HN and are
    // pinned in the `cards` memo instead. Without this guard they also wrote a pin under their own
    // key derived from an empty ranking, which emptied the Read tab.
    if (!isForYou) return rankedFresh;
    return holdOrder(kind, rankIntent, rankedFresh, (r) => r.item.id);
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
  // Narrowing the memo key was not enough, because the inputs it is keyed on are exactly what an
  // engagement changes: saving, hiding or reading invalidates ['affinities'] and ['content'], which
  // moves ctx -> rankCtx -> ranked, which rebuilt every explanation object, which handed every card
  // a new prop identity anyway. Measured on a throttled phone, one Save cost 60ms blocked at 25
  // cards, 111ms at 50 and 197ms at 90 — linear at ~2.2ms/card, so it is the list re-render and not
  // the ranking maths (computeForYou 4.3ms, explainItem x90 3.6ms). The same action on Top with 75
  // cards costs 0ms, because those cards have no explain prop to invalidate.
  //
  // So do not hand out objects at all. `explainFor` has a PERMANENTLY stable identity (empty dep
  // list, latest inputs read through a ref), so a card's props no longer change when the ranking is
  // recomputed, and the explanation is built on demand — which is the only time it is needed, since
  // it exists to populate a dialog the reader opens. This also stops computing 90 explanations to
  // display at most one.
  // Preserves `reasons` array identity across re-ranks (see `stableReasons`).
  const reasonCache = useRef(new Map<number, string[]>());
  const explainInputs = useRef({ isForYou, ranked, rankCtx, activeModel });
  explainInputs.current = { isForYou, ranked, rankCtx, activeModel };
  const explainFor = useCallback((id: number): RankExplanation | undefined => {
    const cur = explainInputs.current;
    if (!cur.isForYou) return undefined;
    const r = cur.ranked.find((x) => x.item.id === id);
    return r ? explainItem(r.item, cur.rankCtx, cur.activeModel) : undefined;
  }, []);



  const cards: FeedCard[] = useMemo(() => {
    if (isForYou) {
      // Hide already-read stories so they don't sit in For You AND the Read tab. The set is owned
      // by lib/readSweep, recomputed per document load (reload / new tab) and by Refresh, and fixed
      // within a page load — so a story read this session is never yanked out from under the reader.
      const hideRead = prefs.hideReadInFeed;
      const visibleRanked = ranked
        // A story hidden THIS session keeps its slot as a stub (see feedSession.hiddenInSession):
        // removing the row instantly pulled everything below up a card and sent the reader's next
        // click to the wrong story. Hides from an earlier session are simply gone.
        .filter((r) => (!hidden.has(r.item.id) || stubs.has(r.item.id)) && !(hideRead && readSnapshot.has(r.item.id)))
        .slice(0, visible);
      return visibleRanked.map((r, i) => ({
        item: r.item,
        hiddenStub: hidden.has(r.item.id) || stubs.has(r.item.id),
        // On a cold start the only reasons are generic ("Trending now"/"Popular") and
        // the "warming up" banner already says the feed is popularity-ranked — showing
        // an identical chip on every card is just noise, so suppress until personalized.
        reasons: personalized ? stableReasons(reasonCache.current, r.item.id, r.reasons) : NO_REASONS,
        rank: i + 1,
        explainable: true,
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
    const fresh = (itemsQ.data ?? []).filter(
      (it) => (isRead || !hidden.has(it.id) || stubs.has(it.id)) && !isFiltered(it, ctx)
    );
    // Hold HN's churn still, exactly as the personalized feed does. The Read tab is a history, not
    // a live list, so it is left alone.
    const ordered = isRead ? fresh : holdOrder(kind, rankIntent, fresh, (it) => it.id);
    // NO_REASONS is a module-level constant, not a fresh `[]` per card: a new array identity on
    // every recompute changes StoryCard's props and defeats its `memo`, so any engagement (which
    // invalidates ['affinities'] → new ctx → this memo re-runs) re-rendered the ENTIRE loaded feed.
    // NEVER stub on the Read tab: that is reading HISTORY, where a hidden story is shown normally
    // (hiding is a downvote, not a history eraser). Stubbing there replaced the row with a
    // title-less placeholder and the story appeared to drop out of your own history.
    return ordered.map((it) => ({ item: it, reasons: NO_REASONS, hiddenStub: !isRead && (hidden.has(it.id) || stubs.has(it.id)) }));
    // No explanation input is listed because no explanation is BUILT here any more: a card carries
    // only the boolean `explainable`, and the explanation itself is pulled on demand through the
    // stable `explainFor`. That is what lets a card whose item and reasons are unchanged keep
    // identical props across a re-rank, and bail out of re-rendering.
  }, [isForYou, isRead, ranked, ctx, itemsQ.data, ids, hidden, visible, prefs.hideReadInFeed, readSnapshot, personalized, kind, rankIntent, stubs]);


  // How many already-read stories the read sweep is holding out of For You, so the feed can note
  // "N already-read hidden · see Read tab" (transparency — the user shouldn't wonder where stories
  // went). Excludes ones already Hidden.
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
  // The page RESOLVED and every item on it was filtered out — as distinct from "no cards yet" during
  // a load or a tab switch, which is transient. Inferring it from `cards.length === 0` alone paged
  // the entire list on every tab switch.
  const filteredOutAll = useMemo(
    () => !isForYou && (itemsQ.data?.length ?? 0) > 0 && cards.length === 0,
    [isForYou, itemsQ.data, cards.length]
  );
  const total = isForYou ? forYouShowable : ids.length;
  const hasMore = visible < total;
  const isFetchingMore = !isForYou && itemsQ.isFetching && cards.length > 0;
  const loadMore = useCallback(() => setVisible((v) => (v >= total ? v : v + PAGE)), [total]);

  const isLoading = isForYou
    // Gate first paint on the pool query AND the read-sweep seed (main.tsx primes ['readSnapshot']
    // once per page load): For You must not paint before the sweep is applied, or already-read
    // stories flash in and then vanish. The pool is one Algolia request (with a firebase fallback),
    // so there is no progressive-batch gate any more.
    ? poolQ.isLoading || affQ.isLoading || readSnapshotQ.isLoading
    : isRead
      ? readIdsQ.isLoading || (itemsQ.isLoading && sliceCount > 0)
      : idsQ.isLoading || (itemsQ.isLoading && sliceCount > 0);
  // Error state is scoped to the queries THIS feed actually uses (mirror isLoading above). poolQ is
  // For-You-only, and a disabled query keeps its last error — so an unscoped `poolQ.isError` leaked a
  // For-You pool failure (e.g. offline) into every other feed's outage, breaking Read/Top/etc. even
  // though their own data was available.
  const isError = isForYou
    ? poolQ.isError
    : isRead
      ? readIdsQ.isError || itemsQ.isError
      : idsQ.isError || itemsQ.isError;

  // PAGE PAST A FULLY-FILTERED LEADING RUN.
  //
  // The id list is sliced to a page BEFORE the items are fetched and filtered, so a feed whose first
  // page is entirely filtered (mute a site you read a lot; a min-points threshold on `new`) shows
  // nothing while qualifying stories sit deeper in the list.
  //
  // It lives HERE, not in the component, because it must depend on `visible` — the very thing it
  // changes. Driven from the component it advanced exactly ONCE and then stalled forever: every
  // other input (`filteredOutAll`, `hasMore`, `isFetching`) settled back to the identical tuple after
  // an advance, so the effect never re-ran, and the feed sat on skeletons permanently with
  // `hasMore` still true.
  //
  // BOUNDED, for two reasons. Termination: when EVERY story is filtered no advance can ever succeed,
  // so an unbounded loop walks the whole list and leaves the reader on skeletons that never resolve.
  // Cost: each page is a firebase N+1, and an unbounded walk was measured at 410 requests from one
  // click. After the cap the feed stops and shows the honest "your filters are hiding these" state.
  const autoAdvances = useRef(0);
  useEffect(() => {
    autoAdvances.current = 0; // a different feed, or a Refresh, gets its own budget
  }, [kind, rankIntent]);
  const autoAdvancing = filteredOutAll && hasMore && autoAdvances.current < MAX_AUTO_ADVANCE;
  useEffect(() => {
    if (!filteredOutAll || !hasMore || itemsQ.isFetching) return;
    if (autoAdvances.current >= MAX_AUTO_ADVANCE) return;
    autoAdvances.current += 1;
    loadMore();
  }, [filteredOutAll, hasMore, itemsQ.isFetching, loadMore, visible]);

  const refetch = useCallback(() => {
    // Explicit Refresh = force a real network fetch (bypass the cache TTLs), then reset.
    forceRef.current = true;
    // Refresh is the user asking for a NEW list, so drop the remembered paging depth: staying 90
    // cards deep in a list that has since changed is the wrong kind of stability. Opening a
    // discussion or switching tabs deliberately keeps it.
    resetFeedPosition(kind);
    // Refresh is the explicit boundary at which re-ordering IS wanted — drop the pinned order so the
    // new list is presented in its true ranked sequence.
    clearPinnedOrder(kind);
    // Refresh ALSO sweeps already-read stories out of For You, in addition to the design-#4
    // fresh-load sweep (main.tsx). Both are explicit acts (a Refresh / a fresh load), both announce
    // the removal and offer Undo — the earlier per-load snapshot was a defect only because it was
    // SILENT and mid-scroll; see lib/readSweep.ts. `applyReadSweep` (not the load seed) tracks the
    // incremental prev set so this Refresh's Undo restores exactly what it removed.
    if (isForYou && prefs.hideReadInFeed) {
      void getReadItemIds(1000).then((ids) => {
        const removed = applyReadSweep(ids);
        qc.setQueryData(['readSnapshot'], ids);
        setJustSwept(removed);
      });
    }
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
  }, [kind, isForYou, isRead, poolQ, idsQ, readIdsQ, itemsQ, affQ, contentQ, qc, prefs.hideReadInFeed]);

  // Put back exactly what the last sweep removed, and re-show it immediately.
  const undoSweep = useCallback(() => {
    undoReadSweep();
    qc.setQueryData(['readSnapshot'], peekReadSweep());
    setJustSwept(null);
  }, [qc]);
  const dismissSweptNotice = useCallback(() => setJustSwept(null), []);

  // When THIS feed's source data was last fetched (each tab is cached & refreshed
  // independently — they do NOT update together). Drives the "updated Xm ago" hint.
  const updatedAt = isForYou
    ? poolQ.dataUpdatedAt
    : isRead
      ? readIdsQ.dataUpdatedAt
      : idsQ.dataUpdatedAt;
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
    autoAdvancing,
    // Stable for the lifetime of the hook — see the note where it is defined.
    explainFor,
    readHiddenCount,
    // What the last explicit Refresh removed, and how to put it back. Both exist so that a change
    // of membership is announced and reversible instead of silent.
    justSwept,
    undoSweep,
    dismissSweptNotice,
    personalized,
    updatedAt,
    isFetching,
  };
}
