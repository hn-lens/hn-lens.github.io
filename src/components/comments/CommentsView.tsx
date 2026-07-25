import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  ArrowBigUp,
  ArrowDown,
  ArrowUpRight,
  Bookmark,
  BookmarkCheck,
  ExternalLink,
  MessageSquare,
  Search,
  X,
} from 'lucide-react';
import { useComments, useStory } from '../../hooks/useItem';
import { getSeenTs, markSeen, toggleSaved, useIsSaved } from '../../hooks/useLocalData';
import { hasCloudKey, usePrefs } from '../../lib/prefs';
import { useModelStore } from '../../lib/models/registry';
import { trackDiscussionDwell, trackForItem } from '../../lib/interactions';
import { markArticleOpen } from '../../lib/dwell';
import { sanitize, stripHtml } from '../../lib/html';
import { domainOf, faviconUrl, safeUrl, timeAgo } from '../../lib/time';
import { cn } from '../../lib/cn';
import Comment from './Comment';
import ThreadSummary from './ThreadSummary';
import AskThread from './AskThread';
import ThreadGist from './ThreadGist';
import ArticleReader from './ArticleReader';
import type { AlgoliaComment } from '../../types';

type Sort = 'default' | 'new' | 'old' | 'replies';

// HN's public API does NOT expose per-comment scores, so we can't offer a "top by
// points" sort. What we can offer: HN's own returned order, time, and reply count.
const SORTS: Array<[Sort, string]> = [
  ['default', 'Default'],
  ['new', 'Newest'],
  ['old', 'Oldest'],
  ['replies', 'Most replies'],
];

function countDescendants(c: AlgoliaComment): number {
  return c.children.reduce((n, ch) => n + 1 + countDescendants(ch), 0);
}

/** Ancestor ids of `id`, root-first. Empty when the id isn't in this tree. */
function pathTo(nodes: AlgoliaComment[], id: number, acc: number[] = []): number[] | null {
  for (const n of nodes) {
    if (n.id === id) return acc;
    const deeper = pathTo(n.children, id, [...acc, n.id]);
    if (deeper) return deeper;
  }
  return null;
}

// Depth-first flatten of the whole comment tree — used by in-thread search and the
// catch-up ("new since last visit") jumper.
function flatten(nodes: AlgoliaComment[]): AlgoliaComment[] {
  const out: AlgoliaComment[] = [];
  const walk = (list: AlgoliaComment[]) => {
    for (const n of list) {
      out.push(n);
      if (n.children.length) walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

const HN_ITEM = (id: number) => `https://news.ycombinator.com/item?id=${id}`;

export default function CommentsView({ id }: { id: number }) {
  const storyQ = useStory(id);
  const commentsQ = useComments(id);
  const [lastVisit, setLastVisit] = useState(0);
  const [sort, setSort] = useState<Sort>('default');
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const [newIdx, setNewIdx] = useState(-1);
  // A pending "jump to this comment in the thread" request from a search result. We can't scroll
  // immediately after clearing the query: the search view is gated on `deferredQuery` (deferred), so
  // the search-result cards — which render the SAME `id="comment-N"` as the thread comments — are
  // still mounted for a commit or two. Scroll only AFTER `searching` goes false (thread remounted),
  // via the effect below, so getElementById resolves the THREAD comment, not the stale search card.
  const [pendingJump, setPendingJump] = useState<number | null>(null);
  // HackerWeb-style dual-view: read the linked Article inline vs. the Discussion.
  const [view, setView] = useState<'discussion' | 'article'>('discussion');
  const navigate = useNavigate();
  // The non-AI "Quick gist" is a FALLBACK for when the AI summary isn't available.
  // When the AI summary block is actively shown (AI on + summaries on + WebGPU OK),
  // hide the gist so the discussion doesn't stack two competing summary blocks.
  const llmEnabled = usePrefs((s) => s.llmEnabled);
  const showAiSummaries = usePrefs((s) => s.showAiSummaries);
  const llmProvider = usePrefs((s) => s.llmProvider);
  const apiKeys = usePrefs((s) => s.apiKeys);
  // Honor the favicon privacy toggle on the discussion header too — not just feed cards.
  const remoteFavicons = usePrefs((s) => s.remoteFavicons);
  const webgpu = useModelStore((s) => s.webgpu);
  // The AI summary block is active if a cloud provider+key is set (no WebGPU needed) OR
  // the local model is enabled and WebGPU is available. When active, the non-AI gist hides.
  const aiSummaryActive =
    showAiSummaries && (hasCloudKey({ llmProvider, apiKeys }) || (llmEnabled && webgpu !== 'unavailable'));
  const saved = useIsSaved(id); // for the Save toggle in the header (stories only)

  useEffect(() => {
    let mounted = true;
    (async () => {
      const ts = await getSeenTs(id);
      if (mounted) setLastVisit(ts ? Math.floor(ts / 1000) : 0);
      await markSeen(id);
    })();
    return () => {
      mounted = false;
    };
  }, [id]);

  const story = storyQ.data;
  const tree = commentsQ.data;
  // Force-expanded ancestors for jump targets (see `jumpToComment`).
  const [revealIds, setRevealIds] = useState<Set<number>>(() => new Set());
  /**
   * THE single way to jump to a comment inside this thread. Auto-collapse leaves ~73% of a real
   * thread out of the DOM (measured 191 of 695 mounted behind 28 pills), so resolving a target with
   * `getElementById` alone silently did nothing, or bounced the reader out to a separate page. Expand
   * the target's ancestor chain FIRST, let React paint, then scroll. Only fall back to navigating
   * away when the id genuinely isn't in this tree.
   */
  const jumpToComment = (cid: number) => {
    const scroll = () => {
      const el = document.getElementById(`comment-${cid}`);
      if (!el) return false;
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      el.classList.add('kbd-selected');
      window.setTimeout(() => el.classList.remove('kbd-selected'), 1200);
      return true;
    };
    if (scroll()) return;
    const chain = pathTo(tree?.children ?? [], cid);
    if (!chain) {
      navigate(`/item/${cid}`);
      return;
    }
    setRevealIds((prev) => {
      const next = new Set(prev);
      for (const id of chain) next.add(id);
      return next;
    });
    // Two frames: one for the state commit, one for the expanded subtree to lay out.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (!scroll()) navigate(`/item/${cid}`);
    }));
  };

  // Time-on-discussion → "read" only if you STAY (opening to summarize/glance and
  // leaving records nothing). Measured mount→unmount on the /item discussion page.
  const storyRef = useRef<{ url?: string; by?: string } | undefined>(undefined);
  storyRef.current = story ? { url: story.url, by: story.by } : undefined;
  useEffect(() => {
    const start = Date.now();
    // Record at most ONE dwell per visit, and do it on unload as well as unmount.
    //
    // React does not run effect cleanups when the tab is closed, so recording only in the cleanup
    // meant that genuinely reading a discussion and then ENDING THE SESSION recorded nothing: a 12s
    // read followed by closing the tab produced {read:0, dwell:0}, while the identical read followed
    // by an in-app "Back to feed" produced {read:1, dwell:1}. That inverts the app's own rule, under
    // which a bare article click with no dwell at all still counts as read.
    //
    // `visibilitychange`→hidden is the only event that fires reliably on mobile; `pagehide` covers
    // desktop close/navigate-away. Guarding on whether a dwell was actually RECORDED (rather than
    // just "did we flush") means a short glance that fell under BOUNCE_MS does not consume the one
    // chance — the reader can come back, keep reading, and still have the real read counted.
    let recorded = false;
    const flush = () => {
      if (recorded) return;
      recorded = trackDiscussionDwell(id, Date.now() - start, storyRef.current);
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', flush);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', flush);
      flush();
    };
  }, [id]);

  const topLevel = useMemo(() => {
    const arr = [...(tree?.children ?? [])];
    if (sort === 'new') arr.sort((a, b) => b.created_at_i - a.created_at_i);
    else if (sort === 'old') arr.sort((a, b) => a.created_at_i - b.created_at_i);
    else if (sort === 'replies') arr.sort((a, b) => countDescendants(b) - countDescendants(a));
    return arr; // 'default' keeps HN's own returned ordering
  }, [tree, sort]);

  // Flatten once per tree; drive search + the "new since last visit" jumper off it.
  const allComments = useMemo(() => flatten(tree?.children ?? []), [tree]);
  const haystacks = useMemo(
    () => new Map(allComments.map((c) => [c.id, `${c.author ?? ''} ${stripHtml(c.text)}`.toLowerCase()])),
    [allComments]
  );
  const q = deferredQuery.trim();
  // A 1-character query matches almost every comment in a large thread, and each match is rendered
  // as a full <Comment>. Measured on a 967-comment thread, typing one word mounted 869 comments and
  // blocked the main thread for ~2.9s across the keystrokes — the UI froze while the user typed.
  // `useDeferredValue` does not help: it reorders the work, it does not remove it. Require 2
  // characters before searching at all, and CAP how many matches are rendered (the overflow is
  // reported, so nothing is silently hidden). Matching itself stays over the whole thread.
  const MIN_QUERY = 2;
  const MAX_RENDERED_MATCHES = 50;
  const searching = q.length >= MIN_QUERY;
  const allMatches = useMemo(() => {
    if (!searching) return [];
    const needle = q.toLowerCase();
    return allComments.filter((c) => haystacks.get(c.id)?.includes(needle));
  }, [allComments, haystacks, q, searching]);
  const matches = useMemo(() => allMatches.slice(0, MAX_RENDERED_MATCHES), [allMatches]);
  const matchOverflow = allMatches.length - matches.length;
  const newIds = useMemo(
    () => (lastVisit > 0 ? allComments.filter((c) => c.created_at_i > lastVisit).map((c) => c.id) : []),
    [allComments, lastVisit]
  );

  const jumpNextNew = () => {
    // Cycle through ALL new comments so the "N new" count and the reachable set agree.
    // A new comment that isn't mounted here (deeper than the indent cap, behind a
    // "Continue this thread" link) opens its own subtree page instead of being silently
    // unreachable — same fallback as the in-thread search jump.
    if (!newIds.length) return;
    const next = (newIdx + 1) % newIds.length;
    setNewIdx(next);
    jumpToComment(newIds[next]);
  };

  // Record the request + exit search; the effect below performs the scroll once the thread has
  // actually re-rendered (see the pendingJump note above).
  const jumpToInThread = (cid: number) => {
    setPendingJump(cid);
    setQuery('');
  };

  useEffect(() => {
    // Wait until the search view has genuinely cleared (searching false ⇒ the thread, not the
    // search results, is mounted) before resolving `comment-${cid}` — otherwise getElementById
    // returns the stale search-result card that shares the id.
    if (pendingJump == null || searching) return;
    const cid = pendingJump;
    setPendingJump(null);
    // Route through the shared handler so a target behind an auto-collapse pill is EXPANDED and
    // landed on, rather than treated as "not in the nested view" and opened as a separate page.
    requestAnimationFrame(() => requestAnimationFrame(() => jumpToComment(cid)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingJump, searching, navigate]);

  if (!story && storyQ.isLoading) {
    return <div className="p-4 text-sm text-muted">Loading…</div>;
  }
  if (!story) {
    return (
      <div className="p-4 text-sm text-muted">
        Couldn&apos;t load this item.{' '}
        <Link to="/" className="text-accent hover:underline">
          Back to feed
        </Link>
      </div>
    );
  }

  const domain = domainOf(story.url);
  const href = safeUrl(story.url);
  const isComment = story.type === 'comment' || (!story.title && !!story.text);
  const title = story.title
      ? sanitize(story.title)
    : isComment
      ? sanitize(`Comment by ${story.by ?? 'unknown'}`)
      : '(untitled)';
  const parentStoryId = tree?.story_id && tree.story_id !== story.id ? tree.story_id : undefined;
  // The Article dual-view only applies to link stories (nothing to read inline for a
  // self/Ask post or a comment permalink).
  const canReadArticle = !!href && !isComment;
  const showArticle = view === 'article' && canReadArticle;

  return (
    <div className="space-y-4">
      <div>
        <div className="mb-1 flex min-w-0 items-center gap-1.5 text-xs text-subtle">
          {domain && remoteFavicons && (
            <img src={faviconUrl(domain, 32)} alt="" className="size-4 shrink-0" loading="lazy" />
          )}
          {/* min-w-0 + overflow-wrap so a long unbroken domain wraps instead of overflowing the
              page horizontally on narrow phones (the sibling <h1> already guards the same way). */}
          <span className="min-w-0 [overflow-wrap:anywhere]">
            {domain || (isComment ? 'comment' : 'discussion')}
          </span>
        </div>
        <h1 className="text-xl font-semibold leading-snug [overflow-wrap:anywhere]">
          {href ? (
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              onClick={() => {
                trackForItem('open_link', story);
                markArticleOpen(story); // start the read-time (dwell) timer, matching the feed card path
              }}
              className="hover:text-accent"
              dangerouslySetInnerHTML={{ __html: title }}
            />
          ) : (
            <span dangerouslySetInnerHTML={{ __html: title }} />
          )}
        </h1>
        {parentStoryId && (
          <Link
            to={`/item/${parentStoryId}`}
            className="mt-1 inline-block text-xs font-medium text-accent hover:underline"
          >
            View the full discussion →
          </Link>
        )}

        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
          <span className="inline-flex items-center gap-1 font-medium text-fg">
            <ArrowBigUp className="size-3.5 text-accent" /> {story.score ?? 0}
          </span>
          <span className="inline-flex items-center gap-1">
            <MessageSquare className="size-3.5" /> {story.descendants ?? 0}
          </span>
          {story.by && (
            <span>
              by{' '}
              <Link to={`/user/${encodeURIComponent(story.by)}`} className="hover:text-accent hover:underline">
                {story.by}
              </Link>
            </span>
          )}
          <span>{timeAgo(story.time)}</span>
          {href && (
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 hover:text-fg"
            >
              <ExternalLink className="size-3.5" /> Article
            </a>
          )}
          <a
            href={HN_ITEM(story.id)}
            target="_blank"
            rel="noreferrer"
            onClick={() => trackForItem('upvote_out', story)}
            className="inline-flex items-center gap-1 hover:text-fg"
          >
            <ArrowUpRight className="size-3.5" /> HN
          </a>
          {!isComment && (
            <button
              type="button"
              onClick={() => void toggleSaved(story)}
              aria-pressed={saved}
              className={cn('inline-flex items-center gap-1 hover:text-fg', saved && 'text-accent')}
            >
              {saved ? <BookmarkCheck className="size-3.5" /> : <Bookmark className="size-3.5" />}
              {saved ? 'Saved' : 'Save'}
            </button>
          )}
        </div>

        {story.text && (
          <div
            className="hn-html comment-body mt-3 rounded-lg border border-border bg-surface p-3.5"
            dangerouslySetInnerHTML={{ __html: sanitize(story.text) }}
          />
        )}
      </div>

      {/* HackerWeb-style Discussion | Article segmented toggle (link stories only). */}
      {canReadArticle && (
        <div className="seg" role="tablist" aria-label="Read the discussion or the article">
          <button type="button" role="tab" aria-selected={view === 'discussion'} onClick={() => setView('discussion')} className="seg-btn">
            Discussion
          </button>
          <button type="button" role="tab" aria-selected={view === 'article'} onClick={() => setView('article')} className="seg-btn">
            Article
          </button>
        </div>
      )}

      {showArticle ? (
        <ArticleReader item={story} />
      ) : (
        <>
          {/* The summary / ask / gist panels are context for reading the whole thread; hide
              them while searching so the matches sit right under the search box (they were
              otherwise pushed below these panels, especially cramped on mobile). */}
          {tree && !searching && <ThreadSummary story={story} tree={tree} />}
          {tree && !searching && aiSummaryActive && <AskThread story={story} tree={tree} />}
          {tree && !searching && !aiSummaryActive && <ThreadGist tree={tree} />}

          {/* In-thread search + catch-up on new comments */}
          {tree && (topLevel.length > 0 || searching) && (
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative min-w-0 flex-1">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-subtle" />
                <input
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search this discussion…"
                  aria-label="Search comments in this discussion"
                  className="w-full rounded-lg border border-edge bg-surface py-1.5 pl-8 pr-8 text-sm outline-none focus-visible:ring-2 focus-visible:ring-accent"
                />
                {query && (
                  <button
                    type="button"
                    aria-label="Clear search"
                    onClick={() => setQuery('')}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-subtle hover:text-fg"
                  >
                    <X className="size-4" />
                  </button>
                )}
              </div>
              {!searching && newIds.length > 0 && (
                <button
                  type="button"
                  onClick={jumpNextNew}
                  // Border is the control-grade --edge token (≥3:1 in every theme, WCAG 1.4.11);
                  // the accent cue is carried by the tinted bg + the accent icon, and the label is
                  // --fg (AA on the tint). (A tinted `border-accent/40` composited <3:1 vs surface.)
                  className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-edge bg-accent/10 px-2.5 py-1.5 text-xs font-medium text-fg hover:bg-accent/15"
                >
                  <ArrowDown className="size-3.5 text-accent" /> {newIds.length} new since last visit
                </button>
              )}
            </div>
          )}

          {commentsQ.isLoading && <div className="text-sm text-muted">Loading comments…</div>}

          {searching ? (
            <div className="space-y-2.5">
              <p className="text-xs text-muted [overflow-wrap:anywhere]">
                {allMatches.length} {allMatches.length === 1 ? 'match' : 'matches'} for &ldquo;{q}&rdquo;
                {matchOverflow > 0 && (
                  <span className="text-subtle"> · showing the first {matches.length}, keep typing to narrow</span>
                )}
              </p>
              {matches.length === 0 ? (
                <p className="text-sm text-muted">No comments match your search.</p>
              ) : (
                matches.map((c) => (
                  <Comment
                    revealIds={revealIds}
                    key={c.id}
                    node={c}
                    depth={0}
                    lastVisit={lastVisit}
                    op={story.by}
                    flat
                    highlight={q}
                    onJump={() => jumpToInThread(c.id)}
                  />
                ))
              )}
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1.5 border-b border-border pb-2">
                <span className="text-sm font-medium">{story.descendants ?? topLevel.length} comments</span>
                <div
                  className="flex items-center gap-1.5 text-xs"
                  title="Sort top-level comments. HN doesn't publish per-comment scores, so there's no 'top by points' — Default is HN's own ordering."
                >
                  <span className="text-subtle">Sort:</span>
                  <div className="seg" role="group" aria-label="Sort comments">
                    {SORTS.map(([s, label]) => (
                      <button key={s} type="button" aria-pressed={sort === s} onClick={() => setSort(s)} className="seg-btn">
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {!commentsQ.isLoading && topLevel.length === 0 && (
                <div className="text-sm text-muted">No comments yet.</div>
              )}

              {/* thread-root: stable hook for tests / tooling (decoupled from the
                  cosmetic spacing class, which is a readability knob). */}
              <div className="thread-root space-y-4">
                {topLevel.map((c) => (
                  <Comment key={c.id} node={c} depth={0} lastVisit={lastVisit} op={story.by} revealIds={revealIds} />
                ))}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
