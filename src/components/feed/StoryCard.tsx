import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useModalBehavior } from '../../hooks/useModalBehavior';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowBigUp,
  ArrowUpRight,
  Ban,
  Bookmark,
  BookmarkCheck,
  EyeOff,
  FileText,
  MessageSquare,
  MoreHorizontal,
  Sparkles,
  Star,
  ThumbsDown,
  X,
} from 'lucide-react';
import RankExplainDialog from '../ranking/RankExplainDialog';
import type { RankExplanation } from '../../lib/ranking/strategies';
import { useImpression } from '../../hooks/useImpression';
import { hasCloudKey, usePrefs } from '../../lib/prefs';
import SummaryActions from '../SummaryActions';
import type { ChatMessage } from '../../lib/models/llm';
import { useModelStore } from '../../lib/models/registry';
import { hideItem, markSeen, toggleSaved, unhideItem } from '../../hooks/useLocalData';
import { clearAllPinnedOrders, hiddenStubHeight, markHiddenInSession, unmarkHiddenInSession } from '../../lib/feedSession';
import { toast } from '../../hooks/useToast';
import { trackForItem } from '../../lib/interactions';
import { markArticleOpen } from '../../lib/dwell';
import { fetchArticleBody, getCachedArticle } from '../../lib/hn/article';
import { getTopComments } from '../../lib/hn/topComment';
import { domainOf, safeUrl, timeAgo } from '../../lib/time';
import { stripHtml } from '../../lib/html';
import { cn } from '../../lib/cn';
import { effectiveLayout } from '../../lib/themes';
import { IconButton, MenuItem, Spinner } from '../ui/primitives';
import { usePopoverClamp } from '../ui/usePopoverClamp';
import Logo from '../ui/Logo';
import Favicon from '../ui/Favicon';
import type { HnItem } from '../../types';

const HN_ITEM = (id: number) => `https://news.ycombinator.com/item?id=${id}`;

function StoryCard({
  item,
  reasons,
  seen,
  saved,
  rank,
  index,
  total,
  explainable,
  explainFor,
  allowHide = true,
  hiddenStub = false,
}: {
  item: HnItem;
  reasons: string[];
  seen: boolean;
  saved: boolean;
  rank?: number;
  hiddenStub?: boolean; // hidden this session: hold the slot instead of collapsing the list
  index?: number; // 1-based position in the feed; shown only by list/compact layouts (CSS)
  total?: number;
  /** Whether a rank traceback exists for this card (For You only). */
  explainable?: boolean;
  /**
   * Pulls the explanation on demand. A STABLE function, never a fresh object per card: handing each
   * card a new `RankExplanation` on every re-rank defeated this component's `memo` for the entire
   * list, so one save cost ~197ms of blocked frames at 90 cards. Called only when the dialog opens.
   */
  explainFor?: (id: number) => RankExplanation | undefined;
  allowHide?: boolean;
}) {
  const ref = useImpression<HTMLElement>(item);
  const navigate = useNavigate();
  const llmEnabled = usePrefs((s) => s.llmEnabled);
  const llmModel = usePrefs((s) => s.llmModel);
  const llmProvider = usePrefs((s) => s.llmProvider);
  const apiKeys = usePrefs((s) => s.apiKeys);
  const fetchArticleText = usePrefs((s) => s.fetchArticleText);
  const showTopComments = usePrefs((s) => s.showTopComments);
  const themeName = usePrefs((s) => s.themeName);
  const layoutPref = usePrefs((s) => s.layout);
  const llmState = useModelStore((s) => s.llm);
  const webgpu = useModelStore((s) => s.webgpu);
  const cloudLlm = hasCloudKey({ llmProvider, apiKeys }); // cloud key set → no WebGPU needed
  const aiAvailable = cloudLlm || (llmEnabled && webgpu !== 'unavailable'); // TL;DR reachable at all

  // Card-level teaching: follow/mute this story's domain + author without leaving the feed.
  const followedDomains = usePrefs((s) => s.followedDomains);
  const mutedDomains = usePrefs((s) => s.mutedDomains);
  const followedUsers = usePrefs((s) => s.followedUsers);
  const mutedUsers = usePrefs((s) => s.mutedUsers);
  const toggleFollowDomain = usePrefs((s) => s.toggleFollowDomain);
  const toggleMuteDomain = usePrefs((s) => s.toggleMuteDomain);
  const toggleFollowUser = usePrefs((s) => s.toggleFollowUser);
  const toggleMuteUser = usePrefs((s) => s.toggleMuteUser);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLSpanElement | null>(null);
  const menuContentRef = useRef<HTMLDivElement | null>(null);

  const [tldrText, setTldrText] = useState<string | null>(null);
  const [tldrLoading, setTldrLoading] = useState(false);
  const [tldrNote, setTldrNote] = useState('');
  const [tldrArticle, setTldrArticle] = useState('');
  const [tldrProxy, setTldrProxy] = useState('');
  const [tldrRequest, setTldrRequest] = useState<ChatMessage[]>([]);
  const [showTldrArticle, setShowTldrArticle] = useState(false);
  // The extracted-article overlay is an aria-modal surface too — gate the shared behaviour on the
  // same condition that renders it, so a card that merely EXISTS never locks the page.
  const articleDialogRef = useRef<HTMLDivElement>(null);
  useModalBehavior(articleDialogRef, showTldrArticle);
  const [showExplain, setShowExplain] = useState(false);
  // Built only while the dialog is open, from the latest ranking. Deliberately NOT memoized: it
  // runs once per open, and memoizing it would put the ranking inputs back into this component's
  // dependencies — the exact coupling that made every card re-render on every save.
  const explainDetail = showExplain ? explainFor?.(item.id) : undefined;
  // Lazy-load the inline top comment only once the card scrolls near the viewport, so the
  // feed doesn't fetch a comment tree per card on load.
  const [inView, setInView] = useState(false);
  const inViewRef = useRef<HTMLElement | null>(null);

  // The article body is cached whenever it's been fetched — by a click, the
  // speculative prefetch, or a summary. Surface a "Article text" link whenever it
  // exists, not only after generating a TL;DR. (Gated on the reader-proxy opt-in.)
  const qc = useQueryClient();
  const cachedArticleQ = useQuery({
    queryKey: ['articleText', item.id],
    queryFn: () => getCachedArticle(item.id),
    enabled: fetchArticleText,
    staleTime: 60000,
  });
  // Gate on the live pref so toggling the reader proxy OFF hides the "Article text"
  // link immediately (a disabled query keeps its last data, so don't read it when off).
  const articleBody = fetchArticleText ? tldrArticle || cachedArticleQ.data?.text || '' : '';
  const articleFrom = fetchArticleText ? tldrProxy || cachedArticleQ.data?.proxy || '' : '';

  const domain = domainOf(item.url);
  const title = stripHtml(item.title) || '(untitled)';
  const href = safeUrl(item.url);
  const isText = !href;
  const score = item.score ?? 0;
  const comments = item.descendants ?? 0;

  const domFollowed = !!domain && followedDomains.includes(domain);
  const domMuted = !!domain && mutedDomains.includes(domain);
  const userFollowed = !!item.by && followedUsers.includes(item.by);
  const userMuted = !!item.by && mutedUsers.includes(item.by);

  // Inline top comment (feed-header "Top comments" toggle): lazy + cached; shows the best
  // top-level comment whose author you haven't muted, so you can read the standout take
  // without opening the thread.
  // The one-line `compact` layout does not RENDER the preview, but hiding it in CSS did not stop
  // the fetch: the element was still mounted and `display:none`, so every card paid up to
  // MAX_KIDS=5 firebase requests for a comment nobody could see (~125 wasted requests per 25-card
  // page, again on every Load-more). `compact` is the default layout of the terminal and cyberpunk
  // DESIGNS, so a user who only picked a colour scheme silently paid it — while the feed header
  // correctly told them the feature was unavailable here. Fold the same check the header already
  // makes into the query's `enabled`, so the gate is the real condition rather than a paint rule.
  // Read from prefs (not CSS) so it stays reactive to a runtime layout change.
  const previewHiddenByLayout = effectiveLayout(themeName, layoutPref) === 'compact';
  const topCommentsQ = useQuery({
    queryKey: ['topComments', item.id],
    queryFn: ({ signal }) => getTopComments(item, signal),
    enabled: showTopComments && !previewHiddenByLayout && comments > 0 && inView,
    staleTime: 5 * 60_000,
    gcTime: 30 * 60_000,
  });
  const topComment = showTopComments
    ? (topCommentsQ.data ?? []).find((c) => !mutedUsers.includes(c.by)) ?? null
    : null;
  // Known at FIRST PAINT from the story's own comment count, so the space is reserved before the
  // fetch resolves and HELD whatever it returns.
  const mayHaveTopComment =
    showTopComments && !previewHiddenByLayout && comments > 0 && (item.kids?.length ?? 0) > 0;
  const expectsTopComment = mayHaveTopComment && !topCommentsQ.isFetched;
  // Once space has been reserved it is HELD, even if the fetch settles with nothing usable. See
  // review/README.md (c3r20 batch 2).
  const settledEmpty = mayHaveTopComment && topCommentsQ.isFetched && !topComment;
  // One node feeds both the impression observer (useImpression) and the in-view lazy-load
  // observer below.
  const setCardRef = useCallback(
    (el: HTMLElement | null) => {
      ref.current = el;
      inViewRef.current = el;
    },
    [ref]
  );

  // The card's rendered height, kept current while it IS a card, so the dismissal placeholder can
  // stand in at the same size instead of collapsing the row (see the `hiddenStub` branch below).
  // Recorded into the SESSION, not just a ref. A ref is destroyed by a reload, and a reload
  // continues the session — so the placeholder fell back to its natural single-line height and the
  // list jumped 86-103px on the one navigation the session model promises changes nothing.
  const lastCardHeight = useRef(0);
  useLayoutEffect(() => {
    if (hiddenStub) return;
    const h = ref.current?.offsetHeight ?? 0;
    if (h > 0) lastCardHeight.current = h;
  });
  const stubHeight = hiddenStub ? lastCardHeight.current || hiddenStubHeight(item.id) : undefined;

  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMenuOpen(false);
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  const closeMenu = useCallback(() => setMenuOpen(false), []);
  usePopoverClamp(menuOpen, menuContentRef, menuRef, closeMenu);

  // The extracted-article overlay is a modal — close on Escape like every other dialog.
  useEffect(() => {
    if (!showTldrArticle) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setShowTldrArticle(false);
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [showTldrArticle]);

  // Fire the lazy top-comment load a bit before the card enters view.
  useEffect(() => {
    const el = inViewRef.current;
    if (!el || inView) return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setInView(true);
          obs.disconnect();
        }
      },
      { rootMargin: '250px' }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [inView]);

  const followDomain = () => {
    toggleFollowDomain(domain);
    toast(
      domFollowed
        ? { message: `Unfollowed ${domain}` }
        : { message: `Following ${domain}`, actionLabel: 'Undo', onAction: () => toggleFollowDomain(domain) }
    );
    setMenuOpen(false);
  };
  const muteDomain = () => {
    const wasMuted = domMuted;
    toggleMuteDomain(domain);
    toast(
      wasMuted
        ? { message: `Unmuted ${domain}` }
        : {
            message: `Muted ${domain}`,
            actionLabel: 'Undo',
            onAction: () => {
              toggleMuteDomain(domain);
              unmarkHiddenInSession(item.id);
              // The pin drops a filtered-out story, so un-muting alone could not bring the other
              // rows back — the Undo reverted the pref and nothing visible changed.
              clearAllPinnedOrders();
            },
          }
    );
    setMenuOpen(false);
  };
  const followUser = () => {
    if (!item.by) return;
    toggleFollowUser(item.by);
    toast(
      userFollowed
        ? { message: `Unfollowed ${item.by}` }
        : { message: `Following ${item.by}`, actionLabel: 'Undo', onAction: () => item.by && toggleFollowUser(item.by) }
    );
    setMenuOpen(false);
  };
  const muteUser = () => {
    if (!item.by) return;
    const wasMuted = userMuted;
    toggleMuteUser(item.by);
    toast(
      wasMuted
        ? { message: `Unmuted ${item.by}` }
        : {
            message: `Muted ${item.by}`,
            actionLabel: 'Undo',
            onAction: () => {
              if (item.by) toggleMuteUser(item.by);
              unmarkHiddenInSession(item.id);
              clearAllPinnedOrders();
            },
          }
    );
    setMenuOpen(false);
  };

  const onOpenArticle = () => {
    trackForItem('open_link', item);
    markArticleOpen(item); // start the read-time (dwell) timer
    void markSeen(item.id);
    // Opening a link fetches its full text (when the reader proxy is on) so it's
    // cached for ranking + summaries — not only when you ask for an AI summary — then
    // the "Article text" link appears on this card once the fetch lands.
    if (fetchArticleText && item.url) {
      void fetchArticleBody(item)
        .then((r) => {
          if (r.text) qc.invalidateQueries({ queryKey: ['articleText', item.id] });
        })
        .catch(() => {});
    }
  };
  const onOpenComments = () => {
    trackForItem('open_comments', item);
    // Open the full discussion PAGE (the clean, readable HackerWeb-style view) — the cramped
    // side drawer this replaced was removed. Don't mark seen here: CommentsView marks the discussion
    // seen on mount, AFTER it captures the PREVIOUS seen timestamp for the "new since last
    // visit" comment badge. Pre-marking here would clobber that timestamp (lastVisit ≈ now)
    // and defeat the badge. The card still dims via the live seen map once CommentsView
    // records the visit.
    navigate(`/item/${item.id}`);
  };
  // "Not interested" = a downvote. It removes the story AND is a strong NEGATIVE training
  // signal (the `hide` event feeds the disliked content profile, a -2.5 affinity hit, and a
  // negative example for the learned reranker — see interactions.ts / train.ts). The toast
  // says so, so the effect is clear (unlike the old opaque "Hide"). Event stays `hide` to
  // keep the training pipeline unchanged.
  const onHide = () => {
    void hideItem(item);
    // Keep the ROW as a placeholder for the rest of the session so the list does not shift under
    // the reader's next click. The hide itself is immediate everywhere else.
    // Carry the measured height across a reload alongside the id (see `hiddenStubHeight`).
    markHiddenInSession(item.id, lastCardHeight.current || undefined);
    toast({
      message: "Not interested — you'll see fewer like this",
      actionLabel: 'Undo',
      onAction: () => {
        // Clear the DB record first, then the placeholder. Dropping the placeholder while
        // `db.hidden` still holds the id leaves the row failing both tests for one render, which
        // drops it from the pinned order — it then returns as a newcomer at the end of the list
        // instead of in the slot it was dismissed from.
        void unhideItem(item.id, item) // pass item so Undo cancels the hide's affinity
          .finally(() => unmarkHiddenInSession(item.id));
      },
    });
  };
  const onSave = () => {
    void toggleSaved(item);
    toast({ message: saved ? 'Removed from saved' : 'Saved' });
  };

  const doTldr = async (force = false) => {
    if (tldrLoading) return;
    if (tldrText !== null && !force) {
      setTldrText(null); // toggle off if already shown (not when refreshing)
      return;
    }
    setTldrLoading(true);
    setTldrText('');
    setTldrNote('');
    setTldrArticle('');
    setTldrRequest([]); // no model has run yet this attempt — so an error/refusal shows no stale request
    try {
      const { summarizeItem, describeSources, describeProvenance } = await import('../../lib/models/llm');
      trackForItem('summarize', item);
      // No tree pre-fetch: summarizeItem checks the cache first and only fetches the
      // comment tree on a miss (a cache hit is instant).
      const res = await summarizeItem(llmModel, 'tldr', item, {
        fetchArticle: fetchArticleText,
        force,
        // Strip any "…TL;DR … :" preamble small models sometimes echo.
        onToken: (full) => setTldrText(full.replace(/^.*?\btl;?dr\b[^:]*:\s*/i, '')),
      });
      setTldrText(res.text.replace(/^.*?\btl;?dr\b[^:]*:\s*/i, ''));
      setTldrNote(
        // describeProvenance replaces the hand-rolled "· via <proxy>" suffix: it names the AI
        // backend too, and being one shared function it cannot drift from the thread surface.
        `Based on ${describeSources(res.sources)}${describeProvenance(res.sources) ? ` · ${describeProvenance(res.sources)}` : ''}${res.cached ? ' · cached' : ''}`
      );
      setTldrArticle(res.articleText);
      setTldrProxy(res.sources.articleProxy || '');
      setTldrRequest(res.request);
    } catch (err) {
      setTldrText(`Could not generate summary: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setTldrLoading(false);
    }
  };

  // Hidden THIS session: keep the slot, so nothing below jumps up under the reader's next click.
  // The hide is already real everywhere else — this is only about not moving the page.
  //
  // The slot keeps the REPLACED CARD'S HEIGHT, not the placeholder's natural one. A single-line row
  // is ~75px shorter than the card it stands in for, so the list still moved most of a card upward
  // — more than half the jump this placeholder exists to prevent, and enough to change what sits
  // under a moving cursor or thumb. `lastCardHeight` is captured on every non-stub layout and
  // survives the flip because this is the same component instance (same key).
  if (hiddenStub) {
    return (
      <article
        data-id={item.id}
        data-hidden-stub="true"
        style={stubHeight ? { minHeight: stubHeight } : undefined}
        className="story-card flex items-center rounded-xl border border-dashed border-edge bg-surface/40 px-3.5 py-2.5"
      >
        <div className="flex w-full items-center gap-2 text-xs text-muted">
          <EyeOff className="size-3.5 shrink-0" />
          <span className="min-w-0 truncate">Hidden — {item.title}</span>
          <button
            type="button"
            onClick={() => {
              // DB record first, THEN the placeholder — the same order the toast Undo uses. Clearing
              // the placeholder while `db.hidden` still holds the id leaves the row failing both arms
              // of useFeed's keep-test for one render, which drops it from the pinned order; it then
              // returns as a newcomer at the END of the list instead of its own slot.
              void unhideItem(item.id, item).finally(() => unmarkHiddenInSession(item.id));
            }}
            className="ml-auto shrink-0 font-medium text-accent hover:underline"
          >
            {/* "Restore", not "Undo": the toast that appears at the same moment already has an Undo,
                and two controls sharing one accessible name is ambiguous for a screen reader and
                for automation. The toast is the transient affordance; this is the durable one. */}
            Restore
          </button>
        </div>
      </article>
    );
  }

  return (
    <article
      ref={setCardRef}
      data-id={item.id}
      className={cn(
        'story-card group relative rounded-xl border border-border bg-surface p-3.5 transition-colors hover:border-subtle/60',
        // When the Personalize menu is open, raise this card's stacking context so its
        // (opaque) dropdown paints ABOVE the next card's chips/Why-button instead of
        // being overlapped by them (a later sibling would otherwise paint on top).
        menuOpen && 'z-30'
      )}
    >
      <div className="sc-row flex gap-3">
        <div className="sc-lead flex flex-col items-center gap-1 pt-0.5">
          {typeof rank === 'number' && (
            <span className="sc-rank text-xs font-semibold text-subtle">{rank}</span>
          )}
          {typeof index === 'number' && (
            <span className="sc-num text-xs font-semibold tabular-nums text-subtle">{index}.</span>
          )}
          <span className="sc-favicon">
            <Favicon domain={domain} isText={isText} dim={seen} />
          </span>
        </div>

        <div className="sc-body @container/sc min-w-0 flex-1">
          <div className="sc-meta flex items-center gap-1.5 text-xs text-muted">
            {domain ? (
              // Display only — NOT a tap target. It sits 2px above the title and had no rest
              // affordance (looked like plain muted text), so a borderless one-tap FOLLOW here was a
              // mis-tap hazard: a thumb aimed at the headline followed the site. Follow/unfollow lives
              // in the ⋯ Personalize menu (and the Star below still shows the followed state).
              <span className="inline-flex max-w-[60%] items-center gap-1 truncate" title={domain}>
                {domFollowed && <Star className="size-3 shrink-0 fill-accent text-accent" />}
                <span className="truncate">{domain}</span>
              </span>
            ) : (
              <span>discussion</span>
            )}
            <span>·</span>
            <time>{timeAgo(item.time)}</time>
            {item.type && item.type !== 'story' && (
              <>
                <span>·</span>
                <span className="uppercase tracking-wide">{item.type}</span>
              </>
            )}
            {articleBody && (
              <>
                <span>·</span>
                <button
                  type="button"
                  onClick={() => setShowTldrArticle(true)}
                  className="relative z-10 inline-flex items-center gap-0.5 text-accent hover:underline"
                >
                  <FileText className="size-3" /> Article text
                </button>
              </>
            )}
          </div>

          {/* rem, not px. The reading-text-size axis scales the ROOT font-size, so every rem-based
              surface follows it — but a hardcoded px headline does not. The feed title was the one
              reading surface pinned to px, so choosing "Large" grew the body text, the top-comment
              preview and the summary while the headline stayed at 15px: at Large the grey preview
              (18px) rendered LARGER than the story title above it, inverting the card's hierarchy
              for the reader who explicitly asked for bigger text. 0.9375rem === 15px at the md
              default, so the default rendering is byte-identical. */}
          <h3 className="sc-title mt-0.5 text-[0.9375rem] font-semibold leading-snug">
            {isText ? (
              <button
                type="button"
                onClick={onOpenComments}
                className={cn(
                  'text-left after:absolute after:inset-0 hover:text-accent',
                  seen && 'text-muted'
                )}
              >
                {title}
              </button>
            ) : (
              <a
                href={href}
                target="_blank"
                rel="noreferrer"
                onClick={onOpenArticle}
                className={cn(
                  'after:absolute after:inset-0 hover:text-accent',
                  seen && 'text-muted'
                )}
              >
                {title}
              </a>
            )}
          </h3>

          {/* Reasons chips only. The "Why #N?" explainer moved to the action row as an icon (below),
              so this row no longer renders for the explainer alone — saving a line on the many cards
              that have no reason chips. */}
          {reasons.length > 0 && (
            <div className="sc-reasons mt-1.5 flex flex-wrap items-center gap-1.5">
              {reasons.map((r) => (
                // Label in --fg for AA: text-accent on the accent/10 tint is a different (lower)
                // contrast pair than accent-on-surface (which the theme guard covers) and can dip
                // below AA. The accent Sparkles icon + tint keep the "reason" character.
                <span
                  key={r}
                  className="relative z-10 inline-flex items-center gap-1 rounded-full bg-accent/10 px-2 py-0.5 text-xs text-fg"
                >
                  <Sparkles className="size-3 text-accent" />
                  {r}
                </span>
              ))}
            </div>
          )}

          {tldrText !== null && (
            <div className="sc-tldr relative z-10 mt-2 rounded-lg border border-border bg-surface-2 p-2 text-sm text-muted">
              {tldrLoading && !tldrText ? (
                <div>
                  <div className="flex items-center gap-2 text-xs text-muted">
                    <Spinner />
                    {llmState.status === 'loading'
                      ? llmState.message || 'Loading model…'
                      : 'Summarizing…'}
                  </div>
                  {llmState.status === 'loading' && (
                    <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-surface">
                      <div
                        className="h-full bg-accent transition-all"
                        style={{ width: `${Math.round(llmState.progress * 100)}%` }}
                      />
                    </div>
                  )}
                </div>
              ) : (
                <p className="break-words">
                  <span className="mr-1 font-medium text-accent">TL;DR</span>
                  {tldrText}
                </p>
              )}
              {tldrNote && !tldrLoading && tldrRequest.length > 0 && <p className="mt-1 text-[11px] text-muted">{tldrNote}</p>}
              {/* Three states, one row. SUCCESS (request sent) → full controls + attribution. ERROR
                  ("Could not…") → keep a retry (Refresh); request is empty so View-request/caveat/Llama
                  stay off. REFUSAL (thin input, no request, not an error) → hide the row entirely
                  (Refresh would re-refuse, "Edit prompt" is inoperative). Matches thread + ask. */}
              {!tldrLoading && tldrText && (tldrRequest.length > 0 || /^Could not/i.test(tldrText)) && (
                <div className="mt-1.5">
                  <SummaryActions request={tldrRequest} onRefresh={() => void doTldr(true)} refreshing={tldrLoading} kind="tldr" />
                </div>
              )}
            </div>
          )}

          {/* RESERVE the slot while the preview is still loading, instead of letting it appear and
              push everything below it down.
              The preview is fetched lazily per card, so on a slow link the feed kept re-flowing for
              ~2s after first paint — measured as five staged jumps totalling +478px for card 8. The
              reader starts moving toward a story and it slides away; this is the same defect class
              as a hover that changes a row's height, just triggered by the network instead.
              `expectsTopComment` is knowable at first paint (the story's own comment count), so the
              space can be held from the start and the arriving text simply fills it. */}
          {!topComment && expectsTopComment && (
            <div className="sc-topcomment-skeleton mt-2 border-l-2 border-edge/40 pl-3" aria-hidden="true">
              <div className="h-[1.05rem] rounded bg-surface-2" />
              <div className="mt-1 h-[0.95rem] w-2/3 rounded bg-surface-2" />
            </div>
          )}
          {settledEmpty && (
            <div className="sc-topcomment-skeleton mt-2 pl-3" aria-hidden="true">
              <div className="h-[1.05rem]" />
              <div className="mt-1 h-[0.95rem]" />
            </div>
          )}
          {topComment && (
            <div className="sc-topcomment relative z-10 mt-2 border-l-2 border-edge pl-3">
              {/* rem for the same reason as .sc-title above: this preview is reading text, so it
                  must follow the reading-text-size axis. 0.8125rem === 13px at the md default. */}
              <p className="line-clamp-2 break-words text-[0.8125rem] leading-normal text-muted">{topComment.text}</p>
              <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11.5px] text-muted">
                <span>
                  —{' '}
                  <Link
                    to={`/user/${encodeURIComponent(topComment.by)}`}
                    onClick={(e) => e.stopPropagation()}
                    className="break-all font-medium text-muted hover:text-accent hover:underline"
                  >
                    {topComment.by}
                  </Link>
                </span>
                <span aria-hidden>·</span>
                <button
                  type="button"
                  onClick={onOpenComments}
                  className="font-semibold text-accent hover:underline"
                >
                  Read {comments} {comments === 1 ? 'comment' : 'comments'} →
                </button>
              </div>
            </div>
          )}

          <div className="sc-sub mt-2 flex flex-wrap items-center gap-x-1 gap-y-1 text-xs text-muted">
            <span className="inline-flex items-center gap-1 font-medium text-fg">
              <ArrowBigUp className="size-3.5 text-accent" />
              {score}
            </span>
            <span className="text-subtle">·</span>
            <button
              type="button"
              onClick={onOpenComments}
              aria-label={`Open comments (${comments})`}
              className="sc-comments relative z-10 inline-flex items-center gap-1 rounded px-1 py-0.5 hover:bg-surface-2 hover:text-fg"
            >
              <MessageSquare className="size-3.5" />
              {comments}
            </button>
            {item.by && (
              <>
                <span className="text-subtle">·</span>
                <span className="truncate">
                  by{' '}
                  <Link
                    to={`/user/${encodeURIComponent(item.by)}`}
                    onClick={(e) => e.stopPropagation()}
                    className="relative z-10 text-fg hover:text-accent hover:underline"
                  >
                    {item.by}
                  </Link>
                </span>
              </>
            )}

            <span className="sc-actions relative z-10 ml-auto flex items-center gap-0.5">
              {/* RESPONSIVE OVERFLOW (container queries on .sc-body). Each action is an inline icon
                  ABOVE its card-width threshold and moves into the "..." menu below it, so a narrow
                  card never wraps the row onto its own line. Drop order as the card narrows:
                  open-on-HN (@xl) → AI summary (@lg) → save (@md) → thumbs-down (@sm) → Why #N? (@xs);
                  only "..." is always inline. Each wrapper is `hidden` then `contents` at its
                  breakpoint, so the button flexes directly (no extra box) when shown. */}
              {explainable && typeof rank === 'number' && (
                <span className="hidden @3xs/sc:contents">
                  {/* Icon-only, so WCAG 2.5.3 (label-in-name) does not apply; the accessible name +
                      tooltip carry the number. The app's ranked-list mark reads as "why ranked here". */}
                  <IconButton label={`Why #${rank}? See how this story was ranked`} onClick={() => setShowExplain(true)}>
                    <Logo className="size-4" />
                  </IconButton>
                </span>
              )}
              {aiAvailable && (
                <span className="hidden @md/sc:contents">
                  <IconButton
                    label={
                      // With article text off, an article story's TL;DR is built from the HN
                      // discussion (CORS blocks reading the article body) — say so up front.
                      (!fetchArticleText && href ? 'TL;DR (discussion)' : 'TL;DR') + (cloudLlm ? '' : ' · local LLM')
                    }
                    active={tldrText !== null}
                    onClick={() => doTldr()}
                  >
                    <Sparkles className={cn('size-4', tldrLoading && 'animate-pulse text-accent')} />
                  </IconButton>
                </span>
              )}
              <span className="hidden @sm/sc:contents">
                <IconButton label={saved ? 'Saved' : 'Save'} active={saved} onClick={onSave}>
                  {saved ? <BookmarkCheck className="size-4" /> : <Bookmark className="size-4" />}
                </IconButton>
              </span>
              {allowHide && (
                <span className="hidden @xs/sc:contents">
                  <IconButton label="Not interested" onClick={onHide}>
                    <ThumbsDown className="size-4" />
                  </IconButton>
                </span>
              )}
              <span className="hidden @lg/sc:contents">
                <a
                  href={HN_ITEM(item.id)}
                  target="_blank"
                  rel="noreferrer"
                  title="Open on Hacker News"
                  onClick={() => trackForItem('upvote_out', item)}
                  className="inline-flex min-h-9 min-w-9 items-center justify-center rounded-lg px-2 py-1.5 text-muted hover:bg-surface-2 hover:text-fg"
                >
                  <ArrowUpRight className="size-4" />
                </a>
              </span>
              {/* Always-present "..." — the overflow menu (actions that dropped) + follow/mute. Hidden
                  only when it would be EMPTY: no follow/mute AND wide enough that every action is inline. */}
              <span ref={menuRef} className={cn('relative', !(domain || item.by) && '@lg/sc:hidden')}>
                <IconButton label="More actions" active={menuOpen} onClick={() => setMenuOpen((v) => !v)}>
                  <MoreHorizontal className="size-4" />
                </IconButton>
                {menuOpen && (
                  <div
                    ref={menuContentRef}
                    role="menu"
                    className="absolute right-0 top-full z-20 mt-1 w-56 overflow-hidden rounded-lg border border-border bg-surface py-1 shadow-xl"
                  >
                    {/* Overflowed actions — each shown ONLY below the width where its inline icon appears. */}
                    <div className="@lg/sc:hidden">
                      <MenuItem
                        onClick={() => {
                          trackForItem('upvote_out', item);
                          window.open(HN_ITEM(item.id), '_blank', 'noopener,noreferrer');
                          setMenuOpen(false);
                        }}
                      >
                        <ArrowUpRight className="size-3.5" /> Open on Hacker News
                      </MenuItem>
                    </div>
                    {aiAvailable && (
                      <div className="@md/sc:hidden">
                        <MenuItem onClick={() => { void doTldr(); setMenuOpen(false); }}>
                          <Sparkles className="size-3.5" /> {tldrText !== null ? 'Hide TL;DR' : 'AI summary (TL;DR)'}
                        </MenuItem>
                      </div>
                    )}
                    <div className="@sm/sc:hidden">
                      <MenuItem onClick={() => { onSave(); setMenuOpen(false); }}>
                        {saved ? <BookmarkCheck className="size-3.5" /> : <Bookmark className="size-3.5" />} {saved ? 'Saved' : 'Save'}
                      </MenuItem>
                    </div>
                    {allowHide && (
                      <div className="@xs/sc:hidden">
                        <MenuItem onClick={() => { onHide(); setMenuOpen(false); }}>
                          <ThumbsDown className="size-3.5" /> Not interested
                        </MenuItem>
                      </div>
                    )}
                    {explainable && typeof rank === 'number' && (
                      <div className="@3xs/sc:hidden">
                        <MenuItem onClick={() => { setShowExplain(true); setMenuOpen(false); }}>
                          <Logo className="size-3.5" /> Why #{rank}?
                        </MenuItem>
                      </div>
                    )}
                    {/* Divider before follow/mute — only below @xl (there is always at least the
                        "Open on Hacker News" overflow item there) AND when follow/mute exists. */}
                    {(domain || item.by) && <div className="@lg/sc:hidden my-1 border-t border-border" />}
                    {domain && (
                      <>
                        <MenuItem onClick={followDomain}>
                          <Star className={cn('size-3.5', domFollowed && 'fill-accent text-accent')} />
                          {domFollowed ? `Unfollow ${domain}` : `Follow ${domain}`}
                        </MenuItem>
                        <MenuItem onClick={muteDomain}>
                          <Ban className="size-3.5" />
                          {domMuted ? `Unmute ${domain}` : `Mute ${domain}`}
                        </MenuItem>
                      </>
                    )}
                    {item.by && (
                      <>
                        <MenuItem onClick={followUser}>
                          <Star className={cn('size-3.5', userFollowed && 'fill-accent text-accent')} />
                          {userFollowed ? `Unfollow ${item.by}` : `Follow ${item.by}`}
                        </MenuItem>
                        <MenuItem onClick={muteUser}>
                          <Ban className="size-3.5" />
                          {userMuted ? `Unmute ${item.by}` : `Mute ${item.by}`}
                        </MenuItem>
                      </>
                    )}
                  </div>
                )}
              </span>
            </span>
          </div>
        </div>
      </div>

      {/* Built HERE, when the dialog is actually open — the only moment it is needed. */}
      {showExplain && typeof rank === 'number' && explainDetail && (
        <RankExplainDialog
          rank={rank}
          total={total ?? rank}
          title={item.title ?? ''}
          explain={explainDetail}
          onClose={() => setShowExplain(false)}
        />
      )}

      {showTldrArticle && articleBody && (
        <div
          className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4"
          onClick={() => setShowTldrArticle(false)}
          role="dialog"
          aria-modal="true"
          aria-label="Extracted article text"
          ref={articleDialogRef}
          tabIndex={-1}
        >
          <div
            className="flex max-h-[85vh] w-full min-w-0 max-w-2xl flex-col rounded-xl border border-border bg-surface shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3 border-b border-border p-4">
              <div className="min-w-0">
                <h2 className="truncate text-sm font-semibold">{title}</h2>
                <p className="mt-0.5 truncate text-xs text-subtle">
                  Extracted from{' '}
                  {href ? (
                    <a href={href} target="_blank" rel="noreferrer" className="text-accent hover:underline">
                      {domain || item.url}
                    </a>
                  ) : (
                    (domain ?? 'the article')
                  )}
                  {articleFrom && ` · fetched via ${articleFrom}`}
                </p>
              </div>
              <button
                type="button"
                aria-label="Close"
                onClick={() => setShowTldrArticle(false)}
                className="shrink-0 rounded-lg p-1 text-muted hover:bg-surface-2 hover:text-fg"
              >
                <X className="size-4" />
              </button>
            </div>
            <div className="overflow-y-auto p-4">
              {/* Same long-token guard as ArticleReader: this is extracted text from an arbitrary
                  page, and without it an unbroken token ran off the fixed-width overlay with no
                  wrap, no ellipsis and no horizontal scroll — hundreds of px of body text were
                  simply unreadable, at every viewport including desktop. */}
              {articleBody.split(/\n{2,}/).map((para, i) => (
                <p key={i} className="mb-3 text-sm leading-relaxed text-fg/90 [overflow-wrap:anywhere]">
                  {para}
                </p>
              ))}
            </div>
          </div>
        </div>
      )}
    </article>
  );
}

// Memoized: the feed re-renders on a 30s "updated Xm ago" tick and on unrelated store changes, so a
// shallow-props memo skips those parent-driven re-renders while this component's own live-query
// subscriptions still update it.
//
// The memo only pays off while EVERY prop identity is stable across such a render. `item` and
// `reasons` are memoized by `useFeed` (and plain feeds share one `NO_REASONS` constant). The one
// function prop, `explainFor`, has an empty-dependency `useCallback` and so never changes — it is a
// function precisely so that this stays true: it replaced a per-card `RankExplanation` OBJECT, which
// was rebuilt on every re-rank and therefore broke this memo for the whole list on every save, hide
// or read (measured ~197ms of blocked frames at 90 cards).
export default memo(StoryCard);
