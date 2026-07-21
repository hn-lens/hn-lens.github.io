import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowBigUp, ArrowUpRight, Bookmark, BookmarkCheck, ExternalLink, MessageSquare } from 'lucide-react';
import { useComments, useStory } from '../../hooks/useItem';
import { getSeenTs, markSeen, toggleSaved, useIsSaved } from '../../hooks/useLocalData';
import { hasCloudKey, usePrefs } from '../../lib/prefs';
import { useModelStore } from '../../lib/models/registry';
import { trackDiscussionDwell, trackForItem } from '../../lib/interactions';
import { sanitize } from '../../lib/html';
import { domainOf, faviconUrl, safeUrl, timeAgo } from '../../lib/time';
import { cn } from '../../lib/cn';
import Comment from './Comment';
import ThreadSummary from './ThreadSummary';
import ThreadGist from './ThreadGist';
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

const HN_ITEM = (id: number) => `https://news.ycombinator.com/item?id=${id}`;

export default function CommentsView({ id }: { id: number }) {
  const storyQ = useStory(id);
  const commentsQ = useComments(id);
  const [lastVisit, setLastVisit] = useState(0);
  const [sort, setSort] = useState<Sort>('default');
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

  // Time-on-discussion → "read" only if you STAY (opening to summarize/glance and
  // leaving records nothing). Measured mount→unmount; covers the drawer and /item.
  const storyRef = useRef<{ url?: string; by?: string } | undefined>(undefined);
  storyRef.current = story ? { url: story.url, by: story.by } : undefined;
  useEffect(() => {
    const start = Date.now();
    return () => trackDiscussionDwell(id, Date.now() - start, storyRef.current);
  }, [id]);

  const topLevel = useMemo(() => {
    const arr = [...(tree?.children ?? [])];
    if (sort === 'new') arr.sort((a, b) => b.created_at_i - a.created_at_i);
    else if (sort === 'old') arr.sort((a, b) => a.created_at_i - b.created_at_i);
    else if (sort === 'replies') arr.sort((a, b) => countDescendants(b) - countDescendants(a));
    return arr; // 'default' keeps HN's own returned ordering
  }, [tree, sort]);

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
      ? `Comment by ${story.by ?? 'unknown'}`
      : '(untitled)';
  const parentStoryId = tree?.story_id && tree.story_id !== story.id ? tree.story_id : undefined;

  return (
    <div className="space-y-4">
      <div>
        <div className="mb-1 flex items-center gap-1.5 text-xs text-subtle">
          {domain && remoteFavicons && <img src={faviconUrl(domain, 32)} alt="" className="size-4" loading="lazy" />}
          <span>{domain || (isComment ? 'comment' : 'discussion')}</span>
        </div>
        <h1 className="text-lg font-semibold leading-snug">
          {href ? (
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              onClick={() => trackForItem('open_link', story)}
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
              <a
                href={`https://news.ycombinator.com/user?id=${encodeURIComponent(story.by)}`}
                target="_blank"
                rel="noreferrer"
                className="hover:text-accent hover:underline"
              >
                {story.by}
              </a>
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
            className="hn-html mt-3 rounded-lg border border-border bg-surface p-3 text-sm"
            dangerouslySetInnerHTML={{ __html: sanitize(story.text) }}
          />
        )}
      </div>

      {tree && <ThreadSummary story={story} tree={tree} />}
      {tree && !aiSummaryActive && <ThreadGist tree={tree} />}

      <div className="flex items-center justify-between gap-2 border-b border-border pb-2">
        <span className="text-sm font-medium">{story.descendants ?? topLevel.length} comments</span>
        <div
          className="flex items-center gap-1 text-xs"
          title="Sort top-level comments. HN doesn't publish per-comment scores, so there's no 'top by points' — Default is HN's own ordering."
        >
          <span className="mr-0.5 text-subtle">Sort:</span>
          {SORTS.map(([s, label]) => (
            <button
              key={s}
              type="button"
              aria-pressed={sort === s}
              onClick={() => setSort(s)}
              className={cn(
                'rounded-md px-2 py-1',
                sort === s ? 'bg-surface-2 font-medium text-fg' : 'text-muted hover:text-fg'
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {commentsQ.isLoading && <div className="text-sm text-muted">Loading comments…</div>}
      {!commentsQ.isLoading && topLevel.length === 0 && (
        <div className="text-sm text-muted">No comments yet.</div>
      )}

      <div className="space-y-3">
        {topLevel.map((c) => (
          <Comment key={c.id} node={c} depth={0} lastVisit={lastVisit} op={story.by} />
        ))}
      </div>
    </div>
  );
}
