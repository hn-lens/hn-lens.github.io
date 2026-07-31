import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  ArrowBigUp,
  ArrowDown,
  ArrowUpDown,
  ArrowUpRight,
  Bookmark,
  BookmarkCheck,
  Check,
  ExternalLink,
  ListTree,
  MessageCircleQuestion,
  MessageSquare,
  MoreHorizontal,
  Search,
  Sparkles,
  X,
} from 'lucide-react';
import { useComments, useStory } from '../../hooks/useItem';
import { getSeenTs, markSeen, toggleSaved, useIsSaved } from '../../hooks/useLocalData';
import { hasCloudKey, usePrefs } from '../../lib/prefs';
import { useModelStore } from '../../lib/models/registry';
import { trackDiscussionDwell, trackForItem } from '../../lib/interactions';
import { markArticleOpen } from '../../lib/dwell';
import { sanitize, searchText } from '../../lib/html';
import { domainOf, safeUrl, timeAgo } from '../../lib/time';
import { cn } from '../../lib/cn';
import Comment from './Comment';
import ThreadSummary from './ThreadSummary';
import AskThread from './AskThread';
import ThreadGist from './ThreadGist';
import ArticleReader from './ArticleReader';
import Favicon from '../ui/Favicon';
import OfflineOutageHint from '../ui/OfflineOutageHint';
import { IconButton, MenuItem } from '../ui/primitives';
import { useOnline } from '../../hooks/useOnline';
import type { AlgoliaComment } from '../../types';

type Sort = 'default' | 'new' | 'old' | 'replies';

// HN's public API does NOT expose per-comment scores, so we can't offer a "top by
// points" sort. What we can offer: HN's own returned order, time, and reply count.
const SORTS: Array<[Sort, string]> = [
  ['default', 'Default'],
  ['new', 'Newest'],
  ['old', 'Oldest'],
  // "Replies", not "Most replies": with the sort, the three tools and the new-comment jump all on
  // one row, the longer label was ~50px of the ~100px that pushed the row into wrapping.
  ['replies', 'Replies'],
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
  const online = useOnline();
  const [lastVisit, setLastVisit] = useState(0);
  const [sort, setSort] = useState<Sort>('default');
  const [query, setQuery] = useState('');
  // Which tool the reader has open, if any. Exactly one at a time: opening one closes the others,
  // so the tray can never stack and reintroduce the wall of chrome this replaced.
  const [tool, setTool] = useState<null | 'search' | 'summary' | 'ask'>(null);
  const [toolMenuOpen, setToolMenuOpen] = useState(false);
  const toolMenuRef = useRef<HTMLSpanElement>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const lastToolBtn = useRef<HTMLElement | null>(null);
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
  // Scroll-load: a huge thread (400+ comments) rendered all at once is ~4s to first comment. Render a
  // WINDOW of the top-level threads and grow it as the reader nears the bottom (IntersectionObserver
  // sentinel); a jump / "new" / search target expands the window to reach a comment past it. Nested
  // replies keep the existing auto-collapse — this bounds only the TOP-LEVEL count on first paint.
  const INITIAL_TOP = 30;
  const TOP_BATCH = 30;
  const [visibleTop, setVisibleTop] = useState(INITIAL_TOP);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  // The non-AI "Quick gist" is a FALLBACK for when the AI summary isn't available.
  // When the AI summary block is actively shown (AI on + summaries on + WebGPU OK),
  // hide the gist so the discussion doesn't stack two competing summary blocks.
  const llmEnabled = usePrefs((s) => s.llmEnabled);
  const showAiSummaries = usePrefs((s) => s.showAiSummaries);
  const llmProvider = usePrefs((s) => s.llmProvider);
  const apiKeys = usePrefs((s) => s.apiKeys);
  // Honor the favicon privacy toggle on the discussion header too — not just feed cards.
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
    // Scroll-load: the target's TOP-LEVEL ancestor may be past the rendered window — grow the window
    // to include it so it (and the revealed reply chain below) can mount and be scrolled to.
    const topAncestor = chain[0] ?? cid;
    const topIdx = topLevel.findIndex((c) => c.id === topAncestor);
    if (topIdx >= 0 && topIdx >= visibleTop) setVisibleTop(topIdx + 1);
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

  // Reset the window on a new discussion or a re-sort (a re-sort should start at the top of the new
  // order, not keep a deep window from the previous ordering).
  useEffect(() => {
    setVisibleTop(INITIAL_TOP);
  }, [id, sort]);

  // Grow the window as the sentinel (below the rendered comments) nears the viewport. rootMargin
  // pre-loads the next batch just before it's reached, so scrolling feels continuous; capped at the
  // real count so it stops once everything is shown.
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisibleTop((v) => (v < topLevel.length ? Math.min(topLevel.length, v + TOP_BATCH) : v));
        }
      },
      { rootMargin: '800px 0px' }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [topLevel.length, visibleTop]);

  // Flatten once per tree; drive search + the "new since last visit" jumper off it. The flatten
  // itself is a cheap pointer walk with no parsing, so it stays eager.
  const allComments = useMemo(() => flatten(tree?.children ?? []), [tree]);

  // BUILT ON FIRST SEARCH, NOT ON OPEN. Every entry costs a `stripHtml` — a DOMPurify sanitize plus
  // a full DOM build and walk — per comment. As an eager memo that ran while the reader was waiting
  // for the comments to appear, on every discussion open, whether or not they ever searched: the
  // whole index was paid for by everyone and used by almost nobody, and on a large thread it
  // dominated time-to-first-comment.
  //
  // A ref rather than a memo gated on `searching`, because that memo would DISCARD the index every
  // time the query fell below the minimum length and rebuild it on the next keystroke — turning one
  // cost into one per search. This keeps exactly one index per tree, built at most once and only if
  // somebody actually searches.
  const haystackRef = useRef<{ key: AlgoliaComment[]; map: Map<number, string> } | null>(null);
  const getHaystacks = () => {
    if (haystackRef.current?.key !== allComments) {
      haystackRef.current = {
        key: allComments,
        map: new Map(allComments.map((c) => [c.id, `${c.author ?? ''} ${searchText(c.text)}`.toLowerCase()])),
      };
    }
    return haystackRef.current.map;
  };
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
    const haystacks = getHaystacks(); // materialised here, on the first search only
    return allComments.filter((c) => haystacks.get(c.id)?.includes(needle));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allComments, q, searching]);
  const matches = useMemo(() => allMatches.slice(0, MAX_RENDERED_MATCHES), [allMatches]);
  const matchOverflow = allMatches.length - matches.length;
  // Label for the compact single-button sort toggle (narrowest widths); the full option set stays in the ⋯ menu.
  const sortLabel = SORTS.find(([k]) => k === sort)?.[1] ?? 'Sort';
  const newIds = useMemo(
    () => (lastVisit > 0 ? allComments.filter((c) => c.created_at_i > lastVisit).map((c) => c.id) : []),
    [allComments, lastVisit]
  );

  // Opening a tool focuses its input immediately — the point of invoking Search is to type, and
  // making the reader click the box afterwards wastes the interaction. Closing returns focus to the
  // button that opened it, so keyboard users are not dumped at the top of the document.
  //
  // ONE dismissal path. `toggleTool` used to close WITHOUT clearing the query, so closing Search
  // from its own toolbar button left the discussion filtered with no input on screen: the results
  // still owned the page, the Search button reported `aria-expanded="false"` while controlling
  // everything visible, and Escape was inert because its guard requires a non-null `tool`. Escape
  // while the tray was open cleared correctly — two ways to dismiss one panel disagreed. Closing
  // now always goes through `closeTool`, so state a tool owns cannot outlive it.
  const closeTool = () => {
    setTool(null);
    setQuery('');
    lastToolBtn.current?.focus?.();
  };
  const toggleTool = (t: 'search' | 'summary' | 'ask') => {
    if (tool === t) {
      closeTool();
      return;
    }
    lastToolBtn.current = document.activeElement as HTMLElement | null;
    setTool(t);
  };
  // Close the overflow menu on outside-click / Escape (mirrors the story-card ⋯ menu).
  useEffect(() => {
    if (!toolMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (toolMenuRef.current && !toolMenuRef.current.contains(e.target as Node)) setToolMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setToolMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [toolMenuOpen]);
  // Focus whatever the open tray's primary input is — not only Search's.
  //
  // Ask has an input and never received focus, so with focus left on BODY every letter went to the
  // shortcut handler instead: typing "are there objections" hit `a` (re-closing Ask) and then `s`
  // (opening Summary), and the question, along with the box holding it, was gone. Keyed on `tool`
  // so "a tool opens focused" is one rule rather than a per-tool special case.
  useEffect(() => {
    if (tool === 'search') searchRef.current?.focus();
    // The Ask panel mounts in this same commit, so wait a frame for its input to exist.
    else if (tool === 'ask') requestAnimationFrame(() => document.getElementById('ask-thread')?.focus());
  }, [tool]);

  // Keys are scoped to the discussion page, which is why `s`, `a` and `l` are free here: `s` (save)
  // is guarded to story cards and this page navigates comments, and `l` (next feed tab) returns
  // immediately when there are no feed tabs in the DOM. Both are already no-ops here.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = document.activeElement;
      const typing = el instanceof HTMLElement && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
      // The dialog guard comes FIRST. It used to sit below the Escape branch, so one Escape inside
      // any modal closed the dialog AND the tray behind it — discarding a typed in-thread search
      // query the reader never asked to lose.
      if (document.querySelector('[aria-modal="true"]')) return;
      if (e.key === 'Escape' && tool) {
        e.preventDefault();
        closeTool();
        return;
      }
      if (typing) return;
      if (e.key === 'l') {
        e.preventDefault();
        toggleTool('search');
      } else if (e.key === 's') {
        e.preventDefault();
        toggleTool('summary');
      } else if (e.key === 'a' && aiSummaryActive) {
        // Gated on the SAME condition as the Ask button. Ungated, `a` opened a tray titled "Ask
        // this discussion" with an empty body whenever AI was not configured — the button is
        // correctly hidden in that case but the key was not, so the shortcut could open a tool into
        // a state with nothing in it. (Summary is deliberately always available: it has a non-AI
        // fallback to show. Ask has none.)
        e.preventDefault();
        toggleTool('ask');
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool, aiSummaryActive]);

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
        {online ? "Couldn't load this item." : "You're offline — this item isn't cached."}{' '}
        <button type="button" onClick={() => void storyQ.refetch()} className="font-medium text-accent hover:underline">
          Retry
        </button>{' '}
        <Link to="/" className="text-accent hover:underline">
          Back to feed
        </Link>
        <OfflineOutageHint />
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
    <div className="space-y-2">
      <div>
        <div className="mb-1 flex min-w-0 items-center gap-1.5 text-xs text-subtle">
          {/* Through the shared component, not a hand-rolled <img>. The bare tag inherited none of
              its behaviour — no letter monogram, so a favicon that 404s or is slow left a
              broken-image glyph or a blank gap — and it kept a SECOND copy of the privacy gate,
              one edit away from disagreeing with the first about whether a request goes out. */}
          {domain && <Favicon domain={domain} isText={false} compact />}
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

        <div className="discussion-header mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
          <span className="inline-flex items-center gap-1 font-medium text-fg">
            <ArrowBigUp className="size-3.5 text-accent" /> {story.score ?? 0}
          </span>
          <span className="inline-flex items-center gap-1">
            <MessageSquare className="size-3.5" /> {story.descendants ?? 0}
          </span>
          {story.by && (
            <span className="[overflow-wrap:anywhere]">
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

        {/* Discussion | Article toggle (link stories only). Inside the header block so its top gap is a
            direct margin, not the outer space-y (a child mt can't override space-y's `> * + *` rule). */}
        {canReadArticle && (
          <div className="seg mt-2" role="tablist" aria-label="Read the discussion or the article">
            <button type="button" role="tab" aria-selected={view === 'discussion'} onClick={() => setView('discussion')} className="seg-btn">
              Discussion
            </button>
            <button type="button" role="tab" aria-selected={view === 'article'} onClick={() => setView('article')} className="seg-btn">
              Article
            </button>
          </div>
        )}
      </div>

      {showArticle ? (
        <ArticleReader item={story} />
      ) : (
        <>
          {/* ONE compact sticky toolbar + an on-demand tray, replacing four stacked blocks.
              The tray lives INSIDE the sticky region so a tool invoked from the bottom of a long
              thread opens where the reader already is, with its input focused. */}
          {tree && (topLevel.length > 0 || searching || newIds.length > 0) && (
            <div className="disc-toolbar">
              {/* Container-query context (`/tb`): the bar is FULL-WIDTH and its controls DEGRADE as the
                  column narrows so the row is always ONE line with no dead gap. Priority (widest→narrowest):
                  Summary/Ask fold into "…" first; the flat SORT degrades 4 segments → 2 buttons
                  (Newest|Replies) → a single ⇅ toggle (the full option set stays in "…" the whole time);
                  the SEARCH box flex-fills the leftover space, then moves into "…" at the very narrowest.
                  count + "N new" never fold. */}
              <div className="@container/tb">
                <div className="disc-tb-bar flex w-full flex-wrap items-center gap-2 rounded-xl border border-border bg-surface-2 px-2 py-1.5">
                  <span className="shrink-0 text-sm font-semibold">
                    {story.descendants ?? topLevel.length}
                    {/* Word is screen-reader-only (kept inside the count so it adds no visual width). */}
                    <span className="sr-only"> {(story.descendants ?? topLevel.length) === 1 ? 'comment' : 'comments'}</span>
                  </span>

                  {/* SORT — flat, degrades with width; the full option set is always reachable (here or in "…"). */}
                  {/* full 4-segment (>=560) */}
                  <span className="hidden shrink-0 @min-[600px]/tb:contents">
                    <div
                      className="seg"
                      role="group"
                      aria-label="Sort comments"
                      title="Sort top-level comments. HN doesn't publish per-comment scores, so there's no 'top by points' — Default is HN's own ordering."
                    >
                      {SORTS.map(([sk, label]) => (
                        <button key={sk} type="button" aria-pressed={sort === sk} onClick={() => setSort(sk)} className="seg-btn">
                          {label}
                        </button>
                      ))}
                    </div>
                  </span>
                  {/* 2 buttons Newest|Replies (460-559); Default/Oldest remain in the "…" menu */}
                  <span className="hidden shrink-0 @min-[460px]/tb:contents @min-[600px]/tb:hidden">
                    <div className="seg" role="group" aria-label="Sort comments">
                      <button type="button" aria-pressed={sort === 'new'} onClick={() => setSort('new')} className="seg-btn">Newest</button>
                      <button type="button" aria-pressed={sort === 'replies'} onClick={() => setSort('replies')} className="seg-btn">Replies</button>
                    </div>
                  </span>
                  {/* single ⇅ toggle (<460); flips Newest/Replies, full options in "…" */}
                  <span className="hidden shrink-0 @max-[459.98px]/tb:contents">
                    <div className="seg" role="group" aria-label="Sort comments">
                      <button
                        type="button"
                        onClick={() => setSort(sort === 'replies' ? 'new' : 'replies')}
                        className="seg-btn inline-flex items-center gap-1"
                        title="Toggle sort (Newest / Replies) — more options in the ⋯ menu"
                        aria-label={`Sort: ${sortLabel}. Tap to toggle Newest and Replies; more in the more-actions menu.`}
                      >
                        <ArrowUpDown className="size-3.5" /> {sortLabel}
                      </button>
                    </div>
                  </span>

                  {/* SEARCH — flex filler; typing filters the thread inline. Moves into "…" below ~360. */}
                  <span className="relative hidden min-w-[6rem] flex-1 items-center @min-[400px]/tb:flex">
                    <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-subtle" />
                    <input
                      type="search"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="Search this discussion…"
                      aria-label="Search comments in this discussion"
                      className="w-full rounded-lg border border-edge bg-surface-2 py-1.5 pl-8 pr-8 text-sm outline-none focus-visible:ring-2 focus-visible:ring-accent"
                    />
                    {query && (
                      <button type="button" aria-label="Clear search" onClick={() => setQuery('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-subtle hover:text-fg">
                        <X className="size-4" />
                      </button>
                    )}
                  </span>

                  {/* SUMMARY / ASK — icon buttons; fold into "…" FIRST, below ~640. */}
                  <span className="hidden shrink-0 @min-[660px]/tb:contents">
                    <div className="seg-act" role="group" aria-label="Discussion tools">
                      {/* "Summary" (the panel), not "Summarize" (the act, inside the tray): two controls
                          sharing one accessible name on one page is ambiguous for screen readers. */}
                      <button type="button" aria-label="Summary" aria-expanded={tool === 'summary'} onClick={() => toggleTool('summary')} title="Summary of this discussion (s)">
                        {aiSummaryActive ? <Sparkles className="size-3.5" /> : <ListTree className="size-3.5" />}
                      </button>
                      {aiSummaryActive && (
                        <button type="button" aria-label="Ask" aria-expanded={tool === 'ask'} onClick={() => toggleTool('ask')} title="Ask this discussion (a)">
                          <MessageCircleQuestion className="size-3.5" />
                        </button>
                      )}
                    </div>
                  </span>

                  {/* Overflow menu — shown once anything has folded (below ~640). Holds Summary/Ask, then
                      Search (only when its inline box has dropped, <360), then the full Sort options (<560). */}
                  <span ref={toolMenuRef} className="relative shrink-0 @min-[660px]/tb:hidden">
                    <IconButton label="More discussion tools" active={toolMenuOpen} onClick={() => setToolMenuOpen((v) => !v)}>
                      <MoreHorizontal className="size-4" />
                    </IconButton>
                    {toolMenuOpen && (
                      <div role="menu" className="absolute right-0 top-full z-20 mt-1 w-56 overflow-hidden rounded-lg border border-border bg-surface py-1 shadow-xl">
                        <MenuItem onClick={() => { toggleTool('summary'); setToolMenuOpen(false); }}>
                          {aiSummaryActive ? <Sparkles className="size-3.5" /> : <ListTree className="size-3.5" />} Summary
                        </MenuItem>
                        {aiSummaryActive && (
                          <MenuItem onClick={() => { toggleTool('ask'); setToolMenuOpen(false); }}>
                            <MessageCircleQuestion className="size-3.5" /> Ask
                          </MenuItem>
                        )}
                        {/* Search — only when the inline box has dropped (below ~360). */}
                        <div className="@min-[400px]/tb:hidden">
                          <MenuItem onClick={() => { toggleTool('search'); setToolMenuOpen(false); }}>
                            <Search className="size-3.5" /> Search this discussion
                          </MenuItem>
                        </div>
                        {/* Full Sort options — whenever the inline Sort is degraded (below ~560). */}
                        <div className="@min-[600px]/tb:hidden">
                          <div className="my-1 border-t border-border" />
                          <div className="px-3 py-1 text-[11px] font-medium uppercase tracking-wide text-subtle">Sort</div>
                          {SORTS.map(([sk, label]) => (
                            <MenuItem key={sk} onClick={() => { setSort(sk); setToolMenuOpen(false); }}>
                              <Check className={cn('size-3.5', sort === sk ? 'text-accent' : 'invisible')} /> {label}
                            </MenuItem>
                          ))}
                        </div>
                      </div>
                    )}
                  </span>

                  {newIds.length > 0 && (
                    <button
                      type="button"
                      onClick={jumpNextNew}
                      className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-edge bg-accent/10 px-2.5 py-1.5 text-xs font-medium text-fg hover:bg-accent/15"
                    >
                      <ArrowDown className="size-3.5 text-accent" /> {newIds.length} new
                    </button>
                  )}
                </div>
              </div>

              {tool && (
                <div className="disc-tray mt-1.5" role="region" aria-label={`${tool} panel`}>
                  <div className="disc-tray-head sticky top-0 z-10 flex items-center gap-2 border-b border-border px-3 py-2">
                    <strong className="text-xs font-semibold text-accent">
                      {tool === 'search' ? 'Search this discussion' : tool === 'ask' ? 'Ask this discussion' : 'Summary'}
                    </strong>
                    {tool === 'search' && q && (
                      <span className="text-xs text-muted">
                        {allMatches.length} {allMatches.length === 1 ? 'match' : 'matches'}
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={() => closeTool()}
                      className="ml-auto rounded-md border border-edge px-2 py-0.5 text-[11px] text-muted hover:text-fg"
                    >
                      Esc
                    </button>
                  </div>
                  <div className="p-3">
                    {tool === 'search' && (
                      <div className="relative">
                        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-subtle" />
                        <input
                          ref={searchRef}
                          type="search"
                          value={query}
                          onChange={(e) => setQuery(e.target.value)}
                          placeholder="Find in this discussion…"
                          aria-label="Search comments in this discussion"
                          className="w-full rounded-lg border border-edge bg-surface-2 py-1.5 pl-8 pr-8 text-sm outline-none focus-visible:ring-2 focus-visible:ring-accent"
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
                    )}
                    {tool === 'summary' && aiSummaryActive && <ThreadSummary story={story} tree={tree} />}
                    {tool === 'summary' && !aiSummaryActive && (
                      <div className="space-y-2.5">
                        <ThreadGist tree={tree} onJump={jumpToComment} />
                        {/* Mounted precisely so the "set up AI" CTA is reachable with AI off. */}
                        <ThreadSummary story={story} tree={tree} />
                      </div>
                    )}
                    {tool === 'ask' && aiSummaryActive && <AskThread story={story} tree={tree} />}
                  </div>
                </div>
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
              {!commentsQ.isLoading &&
                topLevel.length === 0 &&
                (commentsQ.isError ? (
                  // Outage, not emptiness: the tree fetch failed (offline / server error). Don't
                  // claim "No comments yet." over an outage (the outage-vs-empty rule, SPEC §6).
                  <div className="text-sm text-muted">
                    {online ? "Couldn't load the discussion." : "You're offline — this discussion isn't cached."}{' '}
                    <button type="button" onClick={() => commentsQ.refetch()} className="font-medium text-accent hover:underline">
                      Retry
                    </button>
                    <OfflineOutageHint />
                  </div>
                ) : (
                  <div className="text-sm text-muted">No comments yet.</div>
                ))}

              {/* thread-root: stable hook for tests / tooling (decoupled from the
                  cosmetic spacing class, which is a readability knob). */}
              <div className="thread-root space-y-4">
                {topLevel.slice(0, visibleTop).map((c) => (
                  <Comment key={c.id} node={c} depth={0} lastVisit={lastVisit} op={story.by} revealIds={revealIds} />
                ))}
              </div>
              {/* Sentinel: when it nears the viewport the window grows (scroll-load). Also a manual
                  fallback for no-IntersectionObserver / keyboard-only readers, and an honest count. */}
              {visibleTop < topLevel.length && (
                <div ref={sentinelRef} className="pt-3">
                  <button
                    type="button"
                    onClick={() => setVisibleTop((v) => Math.min(topLevel.length, v + TOP_BATCH))}
                    className="mx-auto block rounded-lg border border-edge px-3 py-1.5 text-xs text-muted hover:bg-surface-2 hover:text-fg"
                  >
                    Show more comments ({topLevel.length - visibleTop} more)
                  </button>
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
