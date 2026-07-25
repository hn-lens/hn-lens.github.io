import { useState } from 'react';
import { ChevronDown, ChevronRight, CornerDownRight, ListTree } from 'lucide-react';
import { htmlToText } from '../../lib/html';
import type { AlgoliaComment, AlgoliaItem } from '../../types';

// A fast, no-download heuristic digest of a long thread for readers who won't enable
// the local LLM: surface the few most-substantive / most-replied comments so you can
// get the gist and jump straight to them. Instant, on-device, no model.
const GIST_MIN_COMMENTS = 15; // only worth showing on longer threads
const GIST_COUNT = 5;

function countDescendants(c: AlgoliaComment): number {
  return c.children.reduce((n, ch) => n + 1 + countDescendants(ch), 0);
}

function clean(html: string | null): string {
  // htmlToText (NOT stripHtml) preserves paragraph line breaks, so the per-line quote filter works:
  // stripHtml collapses newlines to spaces, making split('\n') a no-op — a comment whose flattened
  // text STARTED with a quote marker ("&gt; …", the common HN quote-then-respond reply) was dropped
  // ENTIRELY (its filtered text became '' and failed the length gate), so the "most-discussed" gist
  // silently omitted the most-replied comment. Now only the quoted LINES are dropped and the
  // substantive rebuttal survives.
  return htmlToText(html)
    .split('\n')
    .filter((l) => !/^\s*>/.test(l)) // drop quoted lines (HN quotes render as "> …")
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

interface Pick {
  id: number;
  author: string;
  text: string;
  replies: number;
}

function topComments(children: AlgoliaComment[], count: number): Pick[] {
  const acc: Array<Pick & { depth: number }> = [];
  const walk = (nodes: AlgoliaComment[], depth: number) => {
    for (const n of nodes) {
      const text = clean(n.text);
      if (text.length >= 40) acc.push({ id: n.id, author: n.author ?? 'anon', text, replies: countDescendants(n), depth });
      if (n.children.length) walk(n.children, depth + 1);
    }
  };
  walk(children, 0);
  // Same signal the summarizer uses: substance (length) + replies, penalising depth.
  const score = (c: Pick & { depth: number }) => Math.min(c.text.length, 700) + c.replies * 45 - c.depth * 18;
  acc.sort((a, b) => score(b) - score(a));
  return acc.slice(0, count);
}

export default function ThreadGist({ tree }: { tree: AlgoliaItem }) {
  const [open, setOpen] = useState(false);
  // Tolerate a malformed/empty tree (a 200 without a children array) — every other tree
  // consumer guards this; an unguarded .reduce here would white-screen the whole /item page.
  const children = tree?.children ?? [];
  const total = children.reduce((n, c) => n + 1 + countDescendants(c), 0);
  if (total < GIST_MIN_COMMENTS) return null;
  const picks = topComments(children, GIST_COUNT);
  if (!picks.length) return null;

  const jump = (id: number) => {
    document.getElementById(`comment-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  return (
    <div data-testid="thread-gist" className="rounded-xl border border-border bg-surface-2 p-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 text-sm font-medium"
      >
        <ListTree className="size-4 text-accent" /> Quick gist — {picks.length} most-discussed comments
        <span className="rounded bg-surface px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted">no AI</span>
        {open ? (
          <ChevronDown className="ml-auto size-4 text-muted" />
        ) : (
          <ChevronRight className="ml-auto size-4 text-muted" />
        )}
      </button>
      {open && (
        <ul className="mt-2 space-y-2">
          {picks.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                onClick={() => jump(p.id)}
                title="Jump to this comment"
                className="group block w-full rounded-lg px-1 py-0.5 text-left text-xs hover:bg-surface"
              >
                <span className="inline-flex items-center gap-1 font-medium text-fg">
                  <CornerDownRight className="size-3 text-accent" /> {p.author}
                </span>
                {p.replies > 0 && (
                  <span className="text-muted">
                    {' '}
                    · {p.replies} {p.replies === 1 ? 'reply' : 'replies'}
                  </span>
                )}
                <span className="text-accent opacity-0 transition-opacity group-hover:opacity-100"> · jump →</span>
                <span className="mt-0.5 line-clamp-2 text-muted"> {p.text.slice(0, 240)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
