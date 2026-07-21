import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowBigUp,
  ArrowUpRight,
  Ban,
  BarChart3,
  Bookmark,
  BookmarkCheck,
  EyeOff,
  FileText,
  MessageSquare,
  MoreHorizontal,
  Sparkles,
  Star,
  X,
} from 'lucide-react';
import RankExplainDialog from '../ranking/RankExplainDialog';
import type { RankExplanation } from '../../lib/ranking/strategies';
import { useImpression } from '../../hooks/useImpression';
import { useUi } from '../../hooks/useUi';
import { hasCloudKey, usePrefs } from '../../lib/prefs';
import SummaryActions from '../SummaryActions';
import type { ChatMessage } from '../../lib/models/llm';
import { useModelStore } from '../../lib/models/registry';
import { hideItem, markSeen, toggleSaved, unhideItem } from '../../hooks/useLocalData';
import { toast } from '../../hooks/useToast';
import { trackForItem } from '../../lib/interactions';
import { markArticleOpen } from '../../lib/dwell';
import { fetchArticleBody, getCachedArticle } from '../../lib/hn/article';
import { domainOf, safeUrl, timeAgo } from '../../lib/time';
import { stripHtml } from '../../lib/html';
import { cn } from '../../lib/cn';
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

export default function StoryCard({
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
  const openComments = useUi((s) => s.openComments);
  const llmEnabled = usePrefs((s) => s.llmEnabled);
  const llmModel = usePrefs((s) => s.llmModel);
  const llmProvider = usePrefs((s) => s.llmProvider);
  const apiKeys = usePrefs((s) => s.apiKeys);
  const fetchArticleText = usePrefs((s) => s.fetchArticleText);
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

  const [tldrText, setTldrText] = useState<string | null>(null);
  const [tldrLoading, setTldrLoading] = useState(false);
  const [tldrNote, setTldrNote] = useState('');
  const [tldrArticle, setTldrArticle] = useState('');
  const [tldrProxy, setTldrProxy] = useState('');
  const [tldrRequest, setTldrRequest] = useState<ChatMessage[]>([]);
  const [showTldrArticle, setShowTldrArticle] = useState(false);
  const [showExplain, setShowExplain] = useState(false);

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

  // The extracted-article overlay is a modal — close on Escape like every other dialog.
  useEffect(() => {
    if (!showTldrArticle) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setShowTldrArticle(false);
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [showTldrArticle]);

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
    toast({ message: userFollowed ? `Unfollowed ${item.by}` : `Following ${item.by}` });
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
    // Don't mark seen here: CommentsView marks the discussion seen on mount, AFTER it
    // captures the PREVIOUS seen timestamp for the "new since last visit" comment
    // badge. Pre-marking here would clobber that timestamp (lastVisit ≈ now) and
    // defeat the badge on the drawer path. The card still dims via the live seen map
    // once CommentsView records the visit.
    openComments(item.id);
  };
  const onHide = () => {
    void hideItem(item);
    toast({ message: 'Story hidden', actionLabel: 'Undo', onAction: () => void unhideItem(item.id) });
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
      const { summarizeItem, describeSources } = await import('../../lib/models/llm');
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
        `Based on ${describeSources(res.sources)}${res.sources.articleProxy ? ` · via ${res.sources.articleProxy}` : ''}${res.cached ? ' · cached' : ''}`
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
      ref={ref}
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
          <div className="sc-meta flex items-center gap-1.5 text-xs text-subtle">
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

          <h3 className="sc-title mt-0.5 text-[15px] font-semibold leading-snug">
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
                <span
                  key={r}
                  className="relative z-10 inline-flex items-center gap-1 rounded-full bg-accent/10 px-2 py-0.5 text-xs text-accent"
                >
                  <Sparkles className="size-3" />
                  {r}
                </span>
              ))}
              {explain && typeof rank === 'number' && (
                <button
                  type="button"
                  onClick={() => setShowExplain(true)}
                  aria-label={`Why is this ranked number ${rank}`}
                  className="relative z-10 inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs text-muted hover:bg-surface-2 hover:text-fg"
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
                <p>
                  <span className="mr-1 font-medium text-accent">TL;DR</span>
                  {tldrText}
                </p>
              )}
              {tldrNote && !tldrLoading && <p className="mt-1 text-[11px] text-subtle">{tldrNote}</p>}
              {!tldrLoading && tldrText && !/^Could not/i.test(tldrText) && (
                <div className="mt-1.5">
                  <SummaryActions request={tldrRequest} onRefresh={() => void doTldr(true)} refreshing={tldrLoading} />
                </div>
              )}
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
              aria-label="Open comments"
              className="relative z-10 inline-flex items-center gap-1 rounded px-1 py-0.5 hover:bg-surface-2 hover:text-fg"
            >
              <MessageSquare className="size-3.5" />
              {comments}
            </button>
            {item.by && (
              <>
                <span className="text-subtle">·</span>
                <span className="truncate">
                  by{' '}
                  <a
                    href={`https://news.ycombinator.com/user?id=${encodeURIComponent(item.by)}`}
                    target="_blank"
                    rel="noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    className="relative z-10 text-fg hover:text-accent hover:underline"
                  >
                    {item.by}
                  </a>
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
                <IconButton label="Hide" onClick={onHide}>
                  <EyeOff className="size-4" />
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
        >
          <div
            className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-xl border border-border bg-surface shadow-2xl"
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
              {articleBody.split(/\n{2,}/).map((para, i) => (
                <p key={i} className="mb-3 text-sm leading-relaxed text-fg/90">
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
