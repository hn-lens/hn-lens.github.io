import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useModalBehavior } from '../../hooks/useModalBehavior';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowBigUp,
  ArrowUpRight,
  Ban,
  BarChart3,
  Bookmark,
  BookmarkCheck,
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
import { toast } from '../../hooks/useToast';
import { trackForItem } from '../../lib/interactions';
import { markArticleOpen } from '../../lib/dwell';
import { fetchArticleBody, getCachedArticle } from '../../lib/hn/article';
import { getTopComments } from '../../lib/hn/topComment';
import { domainOf, safeUrl, timeAgo } from '../../lib/time';
import { stripHtml } from '../../lib/html';
import { cn } from '../../lib/cn';
import { effectiveLayout } from '../../lib/themes';
import { IconButton, Spinner } from '../ui/primitives';
import Favicon from '../ui/Favicon';
import type { HnItem } from '../../types';

const HN_ITEM = (id: number) => `https://news.ycombinator.com/item?id=${id}`;

function MenuItem({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-muted hover:bg-surface-2 hover:text-fg"
    >
      {children}
    </button>
  );
}

function StoryCard({
  item,
  reasons,
  seen,
  saved,
  rank,
  index,
  total,
  explain,
  allowHide = true,
}: {
  item: HnItem;
  reasons: string[];
  seen: boolean;
  saved: boolean;
  rank?: number;
  index?: number; // 1-based position in the feed; shown only by list/compact layouts (CSS)
  total?: number;
  explain?: RankExplanation;
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
    queryFn: () => getTopComments(item),
    enabled: showTopComments && !previewHiddenByLayout && comments > 0 && inView,
    staleTime: 5 * 60_000,
    gcTime: 30 * 60_000,
  });
  const topComment = showTopComments
    ? (topCommentsQ.data ?? []).find((c) => !mutedUsers.includes(c.by)) ?? null
    : null;
  // Will a preview probably appear here? Known at FIRST PAINT from the story's own comment count,
  // which is why the space can be reserved before the fetch resolves. Once the query has settled
  // with nothing usable (every candidate from a muted author, or no readable comment), stop
  // reserving — holding empty space forever would be its own defect.
  const expectsTopComment =
    showTopComments && !previewHiddenByLayout && comments > 0 && !topCommentsQ.isFetched;
  // One node feeds both the impression observer (useImpression) and the in-view lazy-load
  // observer below.
  const setCardRef = useCallback(
    (el: HTMLElement | null) => {
      ref.current = el;
      inViewRef.current = el;
    },
    [ref]
  );

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

  // Keep the Personalize (⋯) menu inside the viewport horizontally: in narrow multi-column
  // layouts (e.g. newspaper, the default for the royal/swiss designs) the card sits in a slim
  // column, so the right-anchored menu would spill off the LEFT screen edge and clip its
  // labels on phones. Nudge it back on-screen after it opens.
  useLayoutEffect(() => {
    const el = menuContentRef.current;
    if (!menuOpen || !el) return;
    el.style.transform = 'none';
    const r = el.getBoundingClientRect();
    const pad = 6;
    let dx = 0;
    if (r.left < pad) dx = pad - r.left;
    else if (r.right > window.innerWidth - pad) dx = window.innerWidth - pad - r.right;
    // Vertical is the exact same problem and was never handled: the menu is absolutely positioned
    // BELOW its trigger, so opening one on a card near the bottom of the viewport left only 22px of
    // a 186px menu on screen (12% on phones, 25% at 1280x800) — in all 39 layout x viewport cells.
    // Flip it above the trigger when it would overflow the bottom and there is more room above,
    // otherwise just nudge it up; the card is already raised to z-30 while open, so the upward case
    // paints over the preceding card the same way the downward case paints over the next one.
    let dy = 0;
    const overflowBottom = r.bottom - (window.innerHeight - pad);
    if (overflowBottom > 0) {
      // Lift by however much hangs below the fold, but never past the top edge.
      dy = -Math.min(overflowBottom, Math.max(0, r.top - pad));
    }
    if (dx || dy) el.style.transform = `translate(${dx}px, ${dy}px)`;
  }, [menuOpen]);

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
    toggleMuteDomain(domain);
    toast(
      domMuted
        ? { message: `Unmuted ${domain}` }
        : { message: `Muted ${domain}`, actionLabel: 'Undo', onAction: () => toggleMuteDomain(domain) }
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
    toggleMuteUser(item.by);
    toast(
      userMuted
        ? { message: `Unmuted ${item.by}` }
        : { message: `Muted ${item.by}`, actionLabel: 'Undo', onAction: () => item.by && toggleMuteUser(item.by) }
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
    toast({
      message: "Not interested — you'll see fewer like this",
      actionLabel: 'Undo',
      onAction: () => void unhideItem(item.id, item), // pass item so Undo cancels the hide's affinity (restores rank)
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

        <div className="sc-body min-w-0 flex-1">
          <div className="sc-meta flex items-center gap-1.5 text-xs text-muted">
            {domain ? (
              <button
                type="button"
                onClick={followDomain}
                title={domFollowed ? `Unfollow ${domain}` : `Follow ${domain}`}
                className="relative z-10 inline-flex max-w-[60%] items-center gap-1 truncate hover:text-accent hover:underline"
              >
                {domFollowed && <Star className="size-3 shrink-0 fill-accent text-accent" />}
                <span className="truncate">{domain}</span>
              </button>
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

          {(reasons.length > 0 || (explain && typeof rank === 'number')) && (
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
              {explain && typeof rank === 'number' && (
                <button
                  type="button"
                  onClick={() => setShowExplain(true)}
                  aria-label={`Why is this ranked number ${rank}`}
                  className="relative z-10 inline-flex items-center gap-1 rounded-full border border-edge px-2 py-0.5 text-xs text-muted hover:bg-surface-2 hover:text-fg"
                >
                  <BarChart3 className="size-3" /> Why #{rank}?
                </button>
              )}
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
              {tldrNote && !tldrLoading && <p className="mt-1 text-[11px] text-muted">{tldrNote}</p>}
              {!tldrLoading && tldrText && !/^Could not/i.test(tldrText) && (
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
                  Read {comments} comments →
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
              {(cloudLlm || (llmEnabled && webgpu !== 'unavailable')) && (
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
              )}
              <IconButton label={saved ? 'Saved' : 'Save'} active={saved} onClick={onSave}>
                {saved ? <BookmarkCheck className="size-4" /> : <Bookmark className="size-4" />}
              </IconButton>
              {allowHide && (
                <IconButton label="Not interested" onClick={onHide}>
                  <ThumbsDown className="size-4" />
                </IconButton>
              )}
              {(domain || item.by) && (
                <span ref={menuRef} className="relative">
                  <IconButton
                    label="Personalize (follow / mute)"
                    active={menuOpen}
                    onClick={() => setMenuOpen((v) => !v)}
                  >
                    <MoreHorizontal className="size-4" />
                  </IconButton>
                  {menuOpen && (
                    <div
                      ref={menuContentRef}
                      role="menu"
                      className="absolute right-0 top-full z-20 mt-1 w-56 overflow-hidden rounded-lg border border-border bg-surface py-1 shadow-xl"
                    >
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
              )}
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
          </div>
        </div>
      </div>

      {showExplain && explain && typeof rank === 'number' && (
        <RankExplainDialog
          rank={rank}
          total={total ?? rank}
          title={item.title ?? ''}
          explain={explain}
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

// Memoized: the feed re-renders on a 30s "updated Xm ago" tick and on unrelated store
// changes; StoryCard takes no function props (it uses internal hooks), so a shallow-props
// memo skips those parent-driven re-renders while its own live-query subscriptions still
// update it. `item`/`reasons`/`explain` refs are stable across the tick (useFeed memoizes them).
export default memo(StoryCard);
