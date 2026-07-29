import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, CornerDownRight, ListTree } from 'lucide-react';
import { commentToText } from '../../lib/html';
import { commentSubstanceScore } from '../../lib/hn/topComment';
import type { AlgoliaComment, AlgoliaItem } from '../../types';

// A fast, no-download heuristic digest of a long thread for readers who won't enable
// the local LLM: surface the few most-substantive / most-replied comments so you can
// get the gist and jump straight to them. Instant, on-device, no model.
const GIST_MIN_COMMENTS = 15; // only worth showing on longer threads
const GIST_COUNT = 5;

function countDescendants(c: AlgoliaComment): number {
  return c.children.reduce((n, ch) => n + 1 + countDescendants(ch), 0);
}

interface Pick {
  id: number;
  author: string;
  text: string;
  /** Whole-subtree size — what the reader is shown ("N replies"). */
  replies: number;
  /** DIRECT replies only — what the score uses. A long chain hanging off one answer is not twenty
   *  people engaging with this comment, and scoring it that way let one thread take every slot. */
  directReplies: number;
}

function topComments(children: AlgoliaComment[], count: number): Pick[] {
  const acc: Array<Pick & { depth: number }> = [];
  const walk = (nodes: AlgoliaComment[], depth: number) => {
    for (const n of nodes) {
      const text = commentToText(n.text);
      if (text.length >= 40) acc.push({ id: n.id, author: n.author ?? 'anon', text, replies: countDescendants(n), directReplies: n.children.length, depth });
      if (n.children.length) walk(n.children, depth + 1);
    }
  };
  walk(children, 0);
  // Same signal the summarizer uses: substance (length) + replies, penalising depth.
  // THE shared heuristic, not a local variant. This claimed to use "the same signal the summarizer
  // uses" while actually capping length at 700 (so a 650-char zero-reply wall outscored a short
  // comment five people answered) and weighting WHOLE-SUBTREE descendants (so a shallow comment
  // with one direct reply carrying a 20-deep chain scored as if twenty people had engaged with IT).
  // On a realistic tree one off-topic chain took every slot. `commentSubstanceScore` is the version
  // that was hardened for exactly this, and the drift is the failure its own comment warns about.
  const score = (c: Pick & { depth: number }) =>
    commentSubstanceScore(c.text, c.directReplies) - c.depth * 18;
  acc.sort((a, b) => score(b) - score(a));
  return acc.slice(0, count);
}

export default function ThreadGist({ tree, onJump }: { tree: AlgoliaItem; onJump?: (id: number) => void }) {
  const [open, setOpen] = useState(false);
  // MEMOISED on the tree, not recomputed in the render body.
  //
  // `topComments` walks the whole tree and strips HTML from every comment to score it, and this ran
  // on EVERY render of this component — including its own disclosure toggle, which changes no data
  // at all. Isolated measurement (only this component re-rendering): 402 / 949 / 2,450 / 4,382 full
  // HTML parses at 409 / 967 / 2,530 / 4,383 comments. Clicking "show" on a big thread did thousands
  // of parses to reveal text that was already computed.
  //
  // Tolerates a malformed/empty tree (a 200 without a children array) — every other tree consumer
  // guards this; an unguarded .reduce here would white-screen the whole /item page.
  const { total, picks } = useMemo((): { total: number; picks: Pick[] } => {
    const children = tree?.children ?? [];
    const n = children.reduce((acc, c) => acc + 1 + countDescendants(c), 0);
    return { total: n, picks: n < GIST_MIN_COMMENTS ? [] : topComments(children, GIST_COUNT) };
  }, [tree]);
  if (total < GIST_MIN_COMMENTS) return null;
  if (!picks.length) return null;

  // Delegate to the thread's own jumper, which expands the target's collapsed ancestors first.
  // Resolving `getElementById` here instead was a silent no-op for any pick behind an auto-collapse
  // pill — measured dead on 5 of 15 real picks, with no scroll, no fallback and no feedback — even
  // though `CommentsView`'s jumper calls itself "THE single way to jump to a comment inside this
  // thread". The local fallback remains only for the standalone case where no jumper is supplied.
  const jump = (id: number) => {
    if (onJump) return onJump(id);
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
