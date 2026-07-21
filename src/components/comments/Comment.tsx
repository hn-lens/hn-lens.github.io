import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, ChevronRight, CornerLeftUp } from 'lucide-react';
import { sanitize } from '../../lib/html';
import { timeAgo } from '../../lib/time';
import { cn } from '../../lib/cn';
import type { AlgoliaComment } from '../../types';

// Cap how deep we keep indenting. Past this, a "continue this thread" link opens
// the sub-branch on its own page (the /item/:id route renders any comment's
// subtree) — the Reddit/HN pattern that stops threads collapsing into a sliver.
const INDENT_CAP = 6;

function countDescendants(c: AlgoliaComment): number {
  return c.children.reduce((n, ch) => n + 1 + countDescendants(ch), 0);
}

export default function Comment({
  node,
  depth,
  lastVisit,
  op,
  parentId,
}: {
  node: AlgoliaComment;
  depth: number;
  lastVisit: number; // unix seconds; 0 => no prior visit
  op?: string; // the story author, for the OP badge
  parentId?: number; // parent comment id, for "jump to parent"
}) {
  const [collapsed, setCollapsed] = useState(false);
  const isNew = lastVisit > 0 && node.created_at_i > lastVisit;
  const removed = !node.text;
  const replies = countDescendants(node);
  const isOp = !!op && node.author === op;

  return (
    <div
      id={`comment-${node.id}`}
      className={cn(
        'text-sm',
        // A subtle thread line connects a reply to its parent; new replies glow.
        depth > 0 && 'border-l-2 border-border pl-3',
        depth > 0 && isNew && 'border-l-accent'
      )}
    >
      <div className="flex items-center gap-2 py-1 text-xs">
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          aria-expanded={!collapsed}
          aria-label={collapsed ? 'Expand comment' : 'Collapse comment'}
          className="flex min-w-0 flex-1 items-center gap-2 text-left text-subtle hover:text-fg"
        >
          {collapsed ? <ChevronRight className="size-3.5 shrink-0" /> : <ChevronDown className="size-3.5 shrink-0" />}
          <span className={cn('font-medium', isOp ? 'text-accent' : 'text-muted')}>
            {node.author ?? 'unknown'}
          </span>
          {isOp && (
            <span className="rounded bg-accent/15 px-1 py-px text-[10px] font-semibold uppercase text-accent">
              OP
            </span>
          )}
          <span>{timeAgo(node.created_at_i)}</span>
          {isNew && (
            <span className="rounded-full bg-accent/15 px-1.5 py-px text-[10px] font-medium text-accent">new</span>
          )}
          {collapsed && replies > 0 && (
            <span className="text-subtle">
              +{replies} {replies === 1 ? 'reply' : 'replies'}
            </span>
          )}
        </button>
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
            className="shrink-0 text-subtle hover:text-fg"
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
            <div className="hn-html text-fg/90" dangerouslySetInnerHTML={{ __html: sanitize(node.text) }} />
          )}
          {node.children.length > 0 &&
            (depth + 1 > INDENT_CAP ? (
              <Link
                to={`/item/${node.id}`}
                className="mt-2 inline-block border-l-2 border-accent/40 pl-3 text-xs font-medium text-accent hover:underline"
              >
                Continue this thread ({replies} {replies === 1 ? 'reply' : 'replies'}) →
              </Link>
            ) : (
              <div className="mt-2 space-y-2.5">
                {node.children.map((ch) => (
                  <Comment
                    key={ch.id}
                    node={ch}
                    depth={depth + 1}
                    lastVisit={lastVisit}
                    op={op}
                    parentId={node.id}
                  />
                ))}
              </div>
            ))}
        </>
      )}
    </div>
  );
}
