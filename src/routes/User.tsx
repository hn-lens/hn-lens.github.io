import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowUpRight, MessageSquare, Sparkles, User as UserIcon } from 'lucide-react';
import { useUser } from '../hooks/useItem';
import { useSavedIds, useSeenMap } from '../hooks/useLocalData';
import { getItems } from '../lib/hn/client';
import { hasCloudKey, usePrefs } from '../lib/prefs';
import { useModelStore } from '../lib/models/registry';
import { linkifyHtml, sanitize, stripHtml } from '../lib/html';
import { timeAgo } from '../lib/time';
import { Spinner } from '../components/ui/primitives';
import SummaryActions from '../components/SummaryActions';
import StoryCard from '../components/feed/StoryCard';
import type { HnItem } from '../types';
// Type-only (erased at build) so the heavy, lazy llm.ts is NOT pulled into this route bundle.
import type { ChatMessage } from '../lib/models/llm';

// In-app Hacker News user profile (/user/:id). Uses the CORS-enabled Firebase user API
// (karma, member-since, bio, submitted ids) — so it stays fully client-side — and shows the
// user's recent STORY submissions AND COMMENTS (a Stories/Comments toggle). When AI is set
// up, an on-demand "About this user" persona summary describes what they post/comment about,
// built only from that recent activity. Author names across the app link here; this page
// links back OUT to the HN profile ("on HN") for actions HN Lens can't do (CORS blocks
// write/vote), keeping the deep-link-to-HN escape hatch.
export default function User() {
  const { id } = useParams();
  const userQ = useUser(id);
  const user = userQ.data;
  const saved = useSavedIds();
  const seen = useSeenMap();

  // AI availability: a cloud key (no WebGPU needed) OR the on-device model enabled with a
  // usable WebGPU adapter — same gate the summary controls use elsewhere.
  const llmEnabled = usePrefs((s) => s.llmEnabled);
  const llmModel = usePrefs((s) => s.llmModel);
  const llmProvider = usePrefs((s) => s.llmProvider);
  const apiKeys = usePrefs((s) => s.apiKeys);
  const webgpu = useModelStore((s) => s.webgpu);
  const aiAvailable = hasCloudKey({ llmProvider, apiKeys }) || (llmEnabled && webgpu !== 'unavailable');

  // Fetch a slice of the user's submissions (which mix stories + comments) with the
  // bounded-concurrency pool, then split into stories and comments (each capped for a tidy page).
  const subIds = useMemo(() => (user?.submitted ?? []).slice(0, 40), [user?.submitted]);
  const activityQ = useQuery({
    queryKey: ['userActivity', id, subIds],
    enabled: subIds.length > 0,
    staleTime: 120_000,
    queryFn: async () => {
      const items = await getItems(subIds);
      const stories = items.filter((it) => it.type === 'story' && !!it.title).slice(0, 12);
      const comments = items.filter((it) => it.type === 'comment' && !!it.text).slice(0, 12);
      return { stories, comments };
    },
  });
  const stories = activityQ.data?.stories ?? [];
  const comments = activityQ.data?.comments ?? [];

  const [tab, setTab] = useState<'stories' | 'comments'>('stories');
  // Default to whichever the user actually has (comments-first when there are no stories).
  //
  // Seed this ONCE per profile, not on every `activityQ.data` change. The toggle is rendered and
  // clickable while the activity fetch is still in flight, so as an unconditional effect this
  // silently reverted the reader's choice the moment data landed — and again on any later refetch,
  // including the global invalidateQueries that Settings → Data fires. Keyed by profile id so
  // navigating to a different user re-seeds, which is the one case where re-deriving is right.
  const seededFor = useRef<string | null>(null);
  useEffect(() => {
    if (!activityQ.data || seededFor.current === id) return;
    seededFor.current = id ?? null;
    setTab(stories.length === 0 && comments.length > 0 ? 'comments' : 'stories');
  }, [activityQ.data, stories.length, comments.length, id]);

  // On-demand persona summary (never auto-runs — an LLM call per profile view would be
  // surprising + costly). Button-triggered, cached, with the standard transparency row.
  const [summary, setSummary] = useState<string | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryReq, setSummaryReq] = useState<ChatMessage[]>([]);
  const llmState = useModelStore((s) => s.llm);
  const doSummary = async (force = false) => {
    if (summaryLoading || !user) return;
    setSummaryLoading(true);
    setSummary('');
    try {
      const { summarizeUser } = await import('../lib/models/llm');
      const res = await summarizeUser(llmModel, {
        userId: user.id,
        stories: stories.map((s) => stripHtml(s.title ?? '')),
        comments: comments.map((c) => stripHtml(c.text ?? '')),
        force,
        onToken: (full) => setSummary(full),
      });
      setSummary(res.text);
      setSummaryReq(res.request);
    } catch (err) {
      setSummary(`Could not summarize: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSummaryLoading(false);
    }
  };

  return (
    <main className="mx-auto max-w-3xl px-3 py-4 sm:px-4">
      {userQ.isLoading ? (
        <div className="flex items-center gap-2 p-6 text-sm text-muted">
          <Spinner /> Loading profile…
        </div>
      ) : !user ? (
        <div className="rounded-xl border border-border bg-surface p-10 text-center">
          <UserIcon className="mx-auto size-8 text-subtle" />
          <p className="mt-3 text-sm text-muted">User not found.</p>
          <p className="mt-0.5 text-xs text-subtle">There&apos;s no Hacker News user &ldquo;{id}&rdquo;.</p>
          <Link
            to="/"
            className="mt-4 inline-block rounded-lg border border-edge px-3 py-1.5 text-sm hover:bg-surface-2"
          >
            Back to feed
          </Link>
        </div>
      ) : (
        <>
          <div className="mb-4 rounded-xl border border-border bg-surface p-4">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <h1 className="flex min-w-0 items-center gap-2 text-lg font-semibold">
                <UserIcon className="size-5 shrink-0 text-accent" />{' '}
                <span className="[overflow-wrap:anywhere]">{user.id}</span>
              </h1>
              <a
                href={`https://news.ycombinator.com/user?id=${encodeURIComponent(user.id)}`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-0.5 text-xs text-accent hover:underline"
              >
                on HN <ArrowUpRight className="size-3" />
              </a>
            </div>
            <p className="mt-1 text-xs text-subtle">
              <span className="font-medium text-fg">{user.karma.toLocaleString()}</span> karma · member since{' '}
              {new Date(user.created * 1000).toLocaleDateString()}
            </p>
            {user.about && (
              <div
                className="hn-html mt-2 text-sm text-fg/90"
                dangerouslySetInnerHTML={{ __html: sanitize(linkifyHtml(user.about)) }}
              />
            )}
          </div>

          {/* AI persona summary — on-demand, only when AI is set up and there's activity. */}
          {aiAvailable && (stories.length > 0 || comments.length > 0) && (
            <div className="mb-4 rounded-xl border border-border bg-surface p-4">
              <div className="flex items-center justify-between gap-3">
                <h2 className="flex items-center gap-1.5 text-sm font-semibold">
                  <Sparkles className="size-4 text-accent" /> About this user
                </h2>
                {summary === null && (
                  <button
                    type="button"
                    onClick={() => void doSummary()}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg hover:opacity-90"
                  >
                    <Sparkles className="size-3.5" /> Summarize their activity
                  </button>
                )}
              </div>
              {summary !== null && (
                <div className="mt-2 text-sm text-fg/90">
                  {summaryLoading && !summary ? (
                    <div className="flex items-center gap-2 text-xs text-muted">
                      <Spinner />
                      {llmState.status === 'loading' ? llmState.message || 'Loading model…' : 'Summarizing…'}
                    </div>
                  ) : (
                    <p className="whitespace-pre-wrap leading-relaxed">{summary}</p>
                  )}
                  {!summaryLoading && summary && !/^Could not/i.test(summary) && (
                    <>
                      <p className="mt-1.5 text-[11px] text-muted">
                        Based on {stories.length} recent {stories.length === 1 ? 'story' : 'stories'} +{' '}
                        {comments.length} {comments.length === 1 ? 'comment' : 'comments'}
                      </p>
                      <div className="mt-1.5">
                        <SummaryActions request={summaryReq} onRefresh={() => void doSummary(true)} refreshing={summaryLoading} kind="user" />
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          )}

          {/* When AI isn't set up, still make the persona feature discoverable (mirrors the
              discussion page's "Set up AI" CTA) instead of hiding it entirely. */}
          {!aiAvailable && (stories.length > 0 || comments.length > 0) && (
            <div className="mb-4 rounded-xl border border-border bg-surface p-4">
              <div className="flex items-start gap-2 text-sm text-muted">
                <Sparkles className="mt-0.5 size-4 shrink-0 text-accent" />
                <p>
                  <span className="font-medium text-fg">Summarize what {user.id} posts about.</span>{' '}
                  Set up an AI summary in{' '}
                  <Link to="/settings?section=ai-summaries" className="text-accent hover:underline">
                    Settings
                  </Link>{' '}
                  to generate an on-demand overview from their recent activity — on-device, or with your own
                  API key.
                </p>
              </div>
            </div>
          )}

          {/* Stories / Comments toggle (counts so both are discoverable). */}
          <div className="seg mb-1" role="tablist" aria-label="Show stories or comments">
            <button type="button" role="tab" aria-selected={tab === 'stories'} onClick={() => setTab('stories')} className="seg-btn">
              Stories ({stories.length})
            </button>
            <button type="button" role="tab" aria-selected={tab === 'comments'} onClick={() => setTab('comments')} className="seg-btn">
              Comments ({comments.length})
            </button>
          </div>
          {/* The counts are a RECENT sample (capped), not lifetime totals — say so, and point
              at the full HN history, so "Comments (12)" isn't misread as "only 12 ever". */}
          <p className="mb-3 mt-1 text-xs text-subtle">
            Recent activity (up to 12 of each shown) ·{' '}
            <a
              href={`https://news.ycombinator.com/user?id=${encodeURIComponent(user.id)}`}
              target="_blank"
              rel="noreferrer"
              className="text-accent hover:underline"
            >
              full history on Hacker News
            </a>
          </p>

          {activityQ.isLoading ? (
            <div className="flex items-center gap-2 p-4 text-sm text-muted">
              <Spinner /> Loading activity…
            </div>
          ) : tab === 'stories' ? (
            stories.length === 0 ? (
              <p className="rounded-xl border border-border bg-surface p-6 text-center text-sm text-muted">
                No story submissions to show.
              </p>
            ) : (
              <div className="space-y-2.5">
                {stories.map((item) => (
                  <StoryCard
                    key={item.id}
                    item={item}
                    reasons={[]}
                    seen={seen.has(item.id)}
                    saved={saved.has(item.id)}
                    allowHide={false}
                  />
                ))}
              </div>
            )
          ) : comments.length === 0 ? (
            <p className="rounded-xl border border-border bg-surface p-6 text-center text-sm text-muted">
              No comments to show.
            </p>
          ) : (
            <div className="space-y-2.5">
              {comments.map((c) => (
                <ProfileComment key={c.id} comment={c} />
              ))}
            </div>
          )}
        </>
      )}
    </main>
  );
}

// A single comment on the profile: the (sanitized) comment text and links to open the full
// discussion in-app or on HN. NOT wrapped in an outer link — HN comments contain their own
// <a> tags, and nesting anchors is invalid HTML.
function ProfileComment({ comment }: { comment: HnItem }) {
  return (
    <div className="rounded-xl border border-border bg-surface p-3.5">
      <div className="hn-html comment-body text-fg/90" dangerouslySetInnerHTML={{ __html: sanitize(comment.text ?? '') }} />
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-subtle">
        <span>{timeAgo(comment.time ?? 0)}</span>
        <Link to={`/item/${comment.id}`} className="inline-flex items-center gap-1 text-accent hover:underline">
          <MessageSquare className="size-3.5" /> View discussion
        </Link>
        <a
          href={`https://news.ycombinator.com/item?id=${comment.id}`}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-0.5 hover:text-fg"
        >
          on HN <ArrowUpRight className="size-3" />
        </a>
      </div>
    </div>
  );
}
