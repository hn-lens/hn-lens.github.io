import { memo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, ChevronRight, CornerDownRight, CornerLeftUp } from 'lucide-react';
import { highlightHtml, sanitize } from '../../lib/html';
import { timeAgo } from '../../lib/time';
import { cn } from '../../lib/cn';
import type { AlgoliaComment } from '../../types';

// Cap how deep we keep indenting. Past this, a "continue this thread" link opens
// the sub-branch on its own page (the /item/:id route renders any comment's
// subtree) — the Reddit/HN pattern that stops threads collapsing into a sliver.
const INDENT_CAP = 6;

// A comment's replies auto-collapse behind a "N replies" button when the subtree is large,
// counting ALL descendants (replies-of-replies included), applied recursively at every
// depth. Small threads stay inline. This is the HackerWeb progressive-disclosure pattern:
// a long thread is a scannable list of top comments, and you drill into big subtrees one
// level at a time instead of scrolling a wall of deeply-indented text.
const AUTO_COLLAPSE_DESCENDANTS = 2; // collapse when a comment has MORE than this many total descendants (i.e. 3+)

function countDescendants(c: AlgoliaComment): number {
  return c.children.reduce((n, ch) => n + 1 + countDescendants(ch), 0);
}

/** "4 replies · 39 in thread" — the count a control reveals, then the size of the whole branch.
 * The second half is dropped when they are the same, so a small subtree stays a plain "2 replies". */
function repliesLabel(direct: number, total: number): string {
  const head = `${direct} ${direct === 1 ? 'reply' : 'replies'}`;
  return total > direct ? `${head} · ${total} in thread` : head;
}

// Does the subtree contain a comment newer than the last visit? Used to flag a collapsed
// "N replies" subtree that hides unread replies, so a returning reader knows to open it.
function hasNewDescendant(c: AlgoliaComment, lastVisit: number): boolean {
  if (lastVisit <= 0) return false;
  return c.children.some((ch) => ch.created_at_i > lastVisit || hasNewDescendant(ch, lastVisit));
}

// The comment author, linked to their Hacker News profile (matching the story-card /
// discussion-header convention). A missing author renders as a plain, unlinked label.
// `comment-author` is a stable hook for tests + keyboard nav. Opens in a new tab and
// stops propagation so it never triggers a surrounding collapse/click.
function AuthorLink({ author, isOp }: { author?: string | null; isOp: boolean }) {
  if (!author) return <span className="comment-author font-medium text-subtle">unknown</span>;
  return (
    <Link
      to={`/user/${encodeURIComponent(author)}`}
      onClick={(e) => e.stopPropagation()}
      title={`${author} — view profile`}
      className={cn('comment-author font-medium hover:underline', isOp ? 'text-accent' : 'text-muted hover:text-accent')}
    >
      {author}
    </Link>
  );
}

function CommentImpl({
  node,
  revealIds,
  depth,
  lastVisit,
  op,
  parentId,
  flat,
  onJump,
  highlight,
}: {
  node: AlgoliaComment;
  /** Ids whose replies must be force-expanded so a jump target deep in the thread is actually in the
   * DOM. Auto-collapse removes ~73% of a real thread's comments from the document, and all three
   * "jump to this comment" features resolve their target with getElementById — so without this they
   * silently do nothing or bounce the reader out to a separate page. */
  revealIds?: Set<number>;
  depth: number;
  lastVisit: number; // unix seconds; 0 => no prior visit
  op?: string; // the story author, for the OP badge
  parentId?: number; // parent comment id, for "jump to parent"
  flat?: boolean; // render as a standalone row (no children / no collapse) — used by
  // in-thread search results and the flat "thread view"
  onJump?: () => void; // flat mode: jump into the full nested thread at this comment
  highlight?: string; // flat mode: query to <mark>-highlight within the comment text
}) {
  const [collapsed, setCollapsed] = useState(false);
  // Replies start collapsed for large subtrees (progressive disclosure); the comment's own
  // body always stays visible. `collapsed` (the header chevron) still hides the WHOLE comment.
  const [repliesOpen, setRepliesOpen] = useState(false);
  const isNew = lastVisit > 0 && node.created_at_i > lastVisit;
  const removed = !node.text;
  const replies = countDescendants(node);
  // What expanding ACTUALLY mounts: only the direct children. Each of those re-collapses if its own
  // subtree is large, so labelling the control with the descendant total promised up to 10x what it
  // delivered — "Show 39 replies" revealed 4, "Show 24" revealed 15, "Show 40" revealed 8. Lead with
  // the number the reader is about to see and keep the branch total as secondary context.
  const directReplies = node.children.length;
  const forceOpen = !!revealIds?.has(node.id);
  const autoCollapse = replies > AUTO_COLLAPSE_DESCENDANTS && !forceOpen;
  const repliers = [...new Set(node.children.map((c) => c.author).filter(Boolean))].slice(0, 3).join(', ');
  const newInside = autoCollapse && hasNewDescendant(node, lastVisit);
  const isOp = !!op && node.author === op;

  // FLAT mode: a self-contained card (no recursion, no collapse) used by in-thread
  // search results and the flat thread view. `data-depth={0}` so keyboard nav treats
  // each match as a top-level target.
  if (flat) {
    return (
      <div
        id={`comment-${node.id}`}
        data-depth={0}
        className="rounded-lg border border-border bg-surface p-3 text-sm"
      >
        <div className="comment-actions flex items-center gap-2 pb-1 text-xs">
          <AuthorLink author={node.author} isOp={isOp} />
          {isOp && (
            <span className="rounded bg-accent/15 px-1 py-px text-[10px] font-semibold uppercase text-fg">
              OP
            </span>
          )}
          <span className="text-subtle">{timeAgo(node.created_at_i)}</span>
          {isNew && (
            <span className="rounded-full bg-accent/15 px-1.5 py-px text-[10px] font-medium text-fg">new</span>
          )}
          {onJump && (
            <button
              type="button"
              onClick={onJump}
              className="ml-auto inline-flex shrink-0 items-center gap-1 text-subtle hover:text-accent"
            >
              <CornerDownRight className="size-3.5" /> In thread
            </button>
          )}
        </div>
        {removed ? (
          <p className="italic text-subtle">[comment removed]</p>
        ) : (
          <div
            className="hn-html comment-body text-fg/90"
            dangerouslySetInnerHTML={{
              __html: highlight ? highlightHtml(sanitize(node.text), highlight) : sanitize(node.text),
            }}
          />
        )}
      </div>
    );
  }

  return (
    <div
      id={`comment-${node.id}`}
      data-depth={depth}
      className={cn(
        'text-sm',
        // A subtle thread line connects a reply to its parent; new replies glow.
        depth > 0 && 'border-l-2 border-border pl-3.5',
        depth > 0 && isNew && 'border-l-accent'
      )}
    >
      <div className="comment-actions flex items-center gap-2 py-1 text-xs">
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          aria-expanded={!collapsed}
          aria-label={collapsed ? 'Expand comment' : 'Collapse comment'}
          className="-ml-0.5 shrink-0 rounded p-0.5 text-subtle hover:bg-surface-2 hover:text-fg"
        >
          {collapsed ? <ChevronRight className="size-3.5" /> : <ChevronDown className="size-3.5" />}
        </button>
        <AuthorLink author={node.author} isOp={isOp} />
        {isOp && (
          <span className="rounded bg-accent/15 px-1 py-px text-[10px] font-semibold uppercase text-fg">
            OP
          </span>
        )}
        <span className="text-subtle">{timeAgo(node.created_at_i)}</span>
        {isNew && (
          <span className="rounded-full bg-accent/15 px-1.5 py-px text-[10px] font-medium text-fg">new</span>
        )}
        {collapsed && replies > 0 && (
          <button
            type="button"
            onClick={() => setCollapsed(false)}
            className="text-subtle hover:text-fg"
          >
            +{repliesLabel(directReplies, replies)}
          </button>
        )}
        {parentId != null && !collapsed && (
          <button
            type="button"
            aria-label="Jump to parent comment"
            title="Jump to parent"
            onClick={() =>
              document
                .getElementById(`comment-${parentId}`)
                ?.scrollIntoView({ block: 'center', behavior: 'smooth' })
            }
            className="ml-auto shrink-0 text-subtle hover:text-fg"
          >
            <CornerLeftUp className="size-3.5" />
          </button>
        )}
      </div>

      {!collapsed && (
        <>
          {removed ? (
            <p className="italic text-subtle">[comment removed]</p>
          ) : (
            <div className="hn-html comment-body text-fg/90" dangerouslySetInnerHTML={{ __html: sanitize(node.text) }} />
          )}
          {node.children.length > 0 &&
            (depth + 1 > INDENT_CAP ? (
              // Extreme depth: open the sub-branch on its own page instead of indenting further.
              <Link
                to={`/item/${node.id}`}
                className="mt-2 inline-block border-l-2 border-accent/40 pl-3 text-xs font-medium text-accent hover:underline"
              >
                Continue this thread ({repliesLabel(directReplies, replies)}) →
              </Link>
            ) : autoCollapse && !repliesOpen ? (
              // Large subtree, collapsed by default: a "N replies" button (with a repliers
              // preview, and a "new" flag when it hides unread replies). Expands in place.
              <button
                type="button"
                onClick={() => setRepliesOpen(true)}
                aria-expanded={false}
                aria-label={`Show ${repliesLabel(directReplies, replies)}`}
                className={cn(
                  'replies-toggle mt-2 inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium',
                  // Label in --fg for AA (text-accent on the accent/10→/20 tint failed AA, worst
                  // ~3.66 at hover); the "has unread" cue is carried by the accent border, tint,
                  // icon, and the "new" badge — not by the small text color.
                  newInside
                    ? 'border-accent bg-accent/10 text-fg hover:bg-accent/20'
                    : 'border-edge bg-surface-2 text-muted hover:text-fg'
                )}
              >
                <ChevronRight className={cn('size-3.5 shrink-0', newInside && 'text-accent')} />
                {repliesLabel(directReplies, replies)}
                {repliers && <span className="font-normal text-muted">· {repliers}</span>}
                {newInside && (
                  <span className="rounded-full bg-accent/20 px-1.5 py-px text-[10px] font-semibold">new</span>
                )}
              </button>
            ) : (
              <div className="mt-3">
                {autoCollapse && (
                  <button
                    type="button"
                    onClick={() => setRepliesOpen(false)}
                    aria-expanded={true}
                    aria-label={`Hide ${repliesLabel(directReplies, replies)}`}
                    className="replies-toggle mb-2 inline-flex items-center gap-1 text-xs font-medium text-muted hover:text-fg"
                  >
                    <ChevronDown className="size-3.5 shrink-0" /> Hide {repliesLabel(directReplies, replies)}
                  </button>
                )}
                <div className="space-y-3">
                  {node.children.map((ch) => (
                    <Comment
                      revealIds={revealIds}
                      key={ch.id}
                      node={ch}
                      depth={depth + 1}
                      lastVisit={lastVisit}
                      op={op}
                      parentId={node.id}
                    />
                  ))}
                </div>
              </div>
            ))}
        </>
      )}
    </div>
  );
}

// Memoized because a thread mounts hundreds of these and CommentsView owns state they don't read.
// Changing the comment Sort on a 967-comment thread re-rendered all 251 mounted nodes for ~400ms
// in a single ~450ms long task (~1.9s at 4x CPU throttle) even though every prop was referentially
// stable — the sort itself is a useMemo, so the cost was purely the re-render. Any other
// CommentsView state change paid the same.
//
// Safe for the recursion: the nested call below passes only `node`, `revealIds` (a stable useState
// Set) and primitives, so an untouched subtree bails out while `collapsed`/`repliesOpen` stay
// local component state (memo does not reset state) and a `revealIds` change still propagates
// because that prop's identity changes when it is updated.
const Comment = memo(CommentImpl);
export default Comment;
