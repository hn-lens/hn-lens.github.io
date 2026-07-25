import { useEffect, useRef} from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { BarChart3, Database, Scale, Sparkles, X } from 'lucide-react';
import { stripHtml } from '../../lib/html';
import { usePrefs } from '../../lib/prefs';
import type { RankExplanation, ScoreTerm } from '../../lib/ranking/strategies';

function fmt(n: number, digits = 2): string {
  const s = n.toFixed(digits);
  return n > 0 ? `+${s}` : s;
}

// The logistic saturates to 0/1 on small, separable local data, so a raw
// "100% chance you'll engage" is false confidence. Show it as an approximate,
// bounded band instead — never claim certainty from a few dozen interactions.
function engageChancePct(p: number): number {
  return Math.min(95, Math.max(5, Math.round(p * 100)));
}

// Plain-language definitions of what each blend signal compares against.
const HINTS: Record<string, string> = {
  popularity: 'Hacker News points, normalized.',
  recency: 'How recently it was posted.',
  discussion: 'Number of comments, normalized.',
  affinity: "Your learned taste for this story's domain, author, and any boost keywords you set.",
  relevance:
    "Cosine similarity of this story's embedding (its title + HN self-text) to the average embedding of the stories you've engaged with — i.e. how close it is to what you usually read.",
  learned:
    // Name the reference the bar is ACTUALLY centred on. It is the median prediction across the
    // stories being ranked right now — NOT the user's own engagement rate, which is a different
    // number and lives in the panel below as a fact about them. Saying "your base engagement rate"
    // here made a story the model rates above that rate still display a large negative bar.
    "How this story compares with a TYPICAL story in this feed — the model's calibrated prediction, centered on the median across the stories being ranked right now (typical reads ~0, better positive, worse negative).",
};

/** A signed horizontal bar for one contribution, scaled to `max`. */
// `showFormula`: only the SCORE breakdown's bars literally equal weight×value. The learned-model
// bars are each feature's proportional SHARE of the learned pull (so they sum to it), so printing
// "(w×v)" beside them would restate the very mismatch this panel exists to remove.
function Bar({ term, max, hint, showFormula = true }: { term: ScoreTerm; max: number; hint?: string; showFormula?: boolean }) {
  const pct = max > 0 ? (Math.abs(term.contribution) / max) * 100 : 0;
  const positive = term.contribution >= 0;
  return (
    // Columns are shrinkable so Large reading text on a narrow phone can't starve the bar to 0px or
    // clip the value past the modal edge: the label truncates (`min-w-0 shrink truncate`), the bar
    // keeps a `min-w-8` floor while still filling on desktop (`flex-1`), the value sizes to content,
    // and the supplementary (weight×value) formula is hidden below `sm` (it's redundant with the
    // signed number and is what overflowed at 320px+Large). Fixed rem widths (w-44/w-24) inflate under
    // Large text and overflowed the modal — see RankExplain a11y fix.
    <div className="flex items-center gap-2 text-xs">
      <div className="w-28 min-w-0 shrink truncate leading-tight text-muted sm:w-44" title={hint || term.label}>
        {term.label}
        {hint && <span className="ml-1 cursor-help text-subtle">ⓘ</span>}
      </div>
      <div className="relative flex h-4 min-w-8 flex-1 items-center">
        <div className="absolute left-1/2 h-full w-px bg-border" />
        <div
          className={positive ? 'ml-[50%] h-2.5 rounded-r' : 'mr-[50%] ml-auto h-2.5 rounded-l'}
          style={{ width: `${pct / 2}%`, background: positive ? '#3fb950' : '#f85149' }}
        />
      </div>
      <div className="shrink-0 text-right font-medium tabular-nums sm:w-24">
        {fmt(term.contribution)}
        {showFormula && term.key !== 'baseline' && (
          <span className="ml-1 hidden text-subtle sm:inline">
            ({fmt(term.weight, 1)}×{term.value.toFixed(2)})
          </span>
        )}
      </div>
    </div>
  );
}

import { useModalBehavior } from '../../hooks/useModalBehavior';

export default function RankExplainDialog({
  rank,
  total,
  title,
  explain,
  onClose,
}: {
  rank: number;
  total: number;
  title: string;
  explain: RankExplanation;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalBehavior(dialogRef);
  // When the reader proxy is on, linked article TEXT is fetched and folded into the
  // relevance + term signals — so the "content" wording must reflect that (not claim
  // article bodies are unreadable).
  const fetchArticleText = usePrefs((st) => st.fetchArticleText);
  // The learned reranker defaults ON, so an "enabled but not yet trained" state must
  // NOT tell the user to turn it on — split the guidance by the real toggle state.
  const useLearnedRanker = usePrefs((st) => st.useLearnedRanker);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const cleanTitle = stripHtml(title) || '(untitled)';
  const blendMax = Math.max(...explain.terms.map((t) => Math.abs(t.contribution)), 0.0001);
  const topTerm = [...explain.terms].sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution))[0];

  const modelTerms = [...explain.learned.terms]
    // Keep the Baseline even when it rounds to ~0: the copy points at it by name, so filtering it
    // out leaves the paragraph describing a bar that isn't on screen — and a baseline of ~0 is
    // itself the meaningful statement "this story starts about where a typical one does".
    .filter((t) => t.key === 'baseline' || Math.abs(t.contribution) > 1e-6)
    .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));
  const modelMax = Math.max(...modelTerms.map((t) => Math.abs(t.contribution)), 0.0001);

  // Plain-language data signals for this specific item (only the ones that fired).
  const s = explain.signals;
  const dataPoints: Array<{ text: string; val: string }> = [];
  if (s.followedUser) dataPoints.push({ text: `You follow ${s.author}`, val: 'followed' });
  if (s.followedDomain) dataPoints.push({ text: `You follow ${s.domain}`, val: 'followed' });
  if (s.boostKeyword) dataPoints.push({ text: `Title matches your boost keyword “${s.boostKeyword}”`, val: 'match' });
  if (Math.abs(s.domainAffinity) > 0.01 && s.domain)
    dataPoints.push({ text: `${s.domainAffinity > 0 ? 'You engage with' : 'You skip'} ${s.domain}`, val: fmt(s.domainAffinity) });
  if (Math.abs(s.authorAffinity) > 0.01 && s.author)
    dataPoints.push({ text: `${s.authorAffinity > 0 ? 'You engage with' : 'You skip'} ${s.author}`, val: fmt(s.authorAffinity) });
  const contentSuffix = fetchArticleText ? ' + article text' : '';
  if (s.relevance > 0.01) dataPoints.push({ text: `Embedding is similar to stories you read (title + HN text${contentSuffix})`, val: s.relevance.toFixed(2) });
  if (Math.abs(s.termAffinity) > 0.01)
    dataPoints.push({ text: `Title${contentSuffix ? ' + article' : ''} words overlap terms from titles + comments you engaged with`, val: fmt(s.termAffinity) });

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      ref={dialogRef}
      tabIndex={-1}
      aria-label={`Why this story is ranked number ${rank}`}
    >
      <div
        className="max-h-[88vh] w-full min-w-0 max-w-xl overflow-y-auto rounded-t-2xl border border-border bg-surface p-4 shadow-xl sm:rounded-2xl sm:p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-base font-semibold">Why is this ranked #{rank}?</h2>
            <p className="mt-0.5 line-clamp-2 text-sm text-muted">{cleanTitle}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-lg p-1.5 text-muted hover:bg-surface-2 hover:text-fg"
          >
            <X className="size-5" />
          </button>
        </div>

        {/* trace chain */}
        <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg bg-surface-2 px-3 py-2 text-xs text-muted">
          <span className="font-semibold text-fg">#{rank}</span>
          <span>of {total}</span>
          <span className="text-subtle">←</span>
          <span>
            score <span className="font-semibold text-fg tabular-nums">{explain.score.toFixed(2)}</span>
          </span>
          <span className="text-subtle">←</span>
          <span>
            {topTerm.contribution >= 0 ? 'biggest boost' : 'biggest drag'}:{' '}
            <span className="font-medium text-fg">{topTerm.label}</span> {fmt(topTerm.contribution)}
          </span>
          {explain.learned.used && (
            <>
              <span className="text-subtle">←</span>
              <span>model trained on {explain.learned.examples} of your interactions</span>
            </>
          )}
        </div>

        {/* 1. score decomposition */}
        <section className="mt-4">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold">
            <Scale className="size-4 text-accent" /> How the score adds up
          </h3>
          <p className="mt-0.5 text-xs text-subtle">
            Final score = sum of each signal × its weight. Tune the weights in Settings. The feed
            then applies per-site/author diversity caps, so a card&apos;s position can differ
            slightly from its raw score.
          </p>
          <div className="mt-2 space-y-1.5">
            {explain.terms.map((t) => (
              <Bar
                key={t.key}
                term={t}
                max={blendMax}
                hint={
                  t.key === 'relevance' && fetchArticleText
                    ? "Cosine similarity of this story's embedding (its title + HN self-text + linked article text) to the average embedding of the stories you've engaged with — i.e. how close it is to what you usually read."
                    : HINTS[t.key]
                }
              />
            ))}
          </div>
        </section>

        {/* 2. inside the learned model */}
        <section className="mt-4">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold">
            <BarChart3 className="size-4 text-accent" /> Inside the learned model
          </h3>
          {explain.learned.used ? (
            <>
              <p className="mt-0.5 text-xs text-subtle">
                {/* "examples from your activity", not "interactions (clicks, saves, hides)". Naming
                    three deliberate actions misdescribes the data: most training rows are passive
                    impressions labelled as skips (measured 34 of 42, 81%). The sidebar already
                    rejected this wording for exactly that reason; the fix landed on one of three
                    siblings, so the same claim stayed live here and in Settings. */}
                Trained on <span className="font-semibold text-fg">{explain.learned.examples}</span> examples from
                your activity — the stories you engaged with and the ones you skipped — leave-one-out. You engage
                with about{' '}
                <span className="font-semibold text-fg">{Math.round(explain.learned.engagementRate * 100)}%</span> of
                the stories you see overall. For this one it predicts{' '}
                {/* BOTH sides go through the same display transform. One was clamped to [5,95] and
                    the other rendered raw, so for a selective reader every below-median story
                    printed "~5%, against ~3%" — an apparently POSITIVE gap — directly above a
                    negative red "Learned model" bar (12 of 24 candidates). The clamp must stay: it
                    exists so the panel never claims a certainty a few dozen interactions cannot
                    support. Applying it to only one of two compared numbers is what made them
                    disagree. */}
                <span className="font-semibold text-fg">~{engageChancePct(explain.learned.probability)}%</span>,
                against <span className="font-semibold text-fg">~{engageChancePct(explain.learned.baseRate)}%</span>{' '}
                for a typical story in this feed; that gap — not the absolute number — is what moves the rank.
                {/* Only promise bars when bars are actually rendered. The sentence used to be
                    unconditional, so a story whose features are all neutral got "each bar below …
                    they add up to it" immediately above the words "All features are neutral". */}
                {modelTerms.length > 0 && (
                  <>
                    {' '}
                    Each bar below is that feature&apos;s share of the{' '}
                    <span className="font-semibold text-fg">Learned model</span> figure in the table above —{' '}
                    <span className="font-semibold text-fg">they add up to it</span>. The Baseline is where a{' '}
                    <em>typical</em> story in this feed starts; the features push this one above or below that.
                  </>
                )}
                {/* Gate this on the thing it actually explains — the DISPLAYED estimate landing below
                    half while the features are mostly positive. It used to key off the user's own
                    overall engagement rate, so a balanced or avid reader saw a ~95% estimate sitting
                    beside no explanation at all, while the clause fired next to numbers it did not
                    describe. */}
                {modelTerms.length > 0 && engageChancePct(explain.learned.probability) < 50
                  ? ' Because a typical story in this feed starts low, mostly-positive features can still land below 50%:'
                  : ''}
              </p>
              <div className="mt-2 space-y-1.5">
                {/* Render EVERY bar (at most the baseline + 10 features). Slicing to the top 8 while
                    the sentence above promises "the baseline + the feature bars below sum to that
                    estimate" broke that promise — the visible bars did not add up. */}
                {modelTerms.map((t) => (
                  <Bar key={t.key} term={t} max={modelMax} showFormula={false} />
                ))}
                {modelTerms.length === 0 && (
                  <p className="text-xs text-subtle">All features are neutral for this story.</p>
                )}
              </div>
            </>
          ) : useLearnedRanker ? (
            <p className="mt-0.5 text-xs text-subtle">
              {/* Name the clause that actually failed. "Read more" is the wrong instruction for a
                  degenerate fit, and it is the one a reader with plenty of history would see. */}
              {explain.learned.gate === 'degenerate' ? (
                <>
                  Still learning — you have{' '}
                  <span className="font-semibold text-fg">{explain.learned.examples}</span> examples, but they
                  don&apos;t yet separate the stories you engage with from the ones you skip, so there&apos;s no
                  pattern for the reranker to fit. Reading a wider mix of stories will give it something to work
                  with. Until then, ranking uses popularity, recency, and your affinities.
                </>
              ) : (
                <>
                  Still learning — the reranker activates once it has enough of your interactions, including a few
                  stories you&apos;ve actually read (you have{' '}
                  <span className="font-semibold text-fg">{explain.learned.examples}</span> so far). It trains
                  itself automatically as you read — there&apos;s no manual step. Until then, ranking uses
                  popularity, recency, and your affinities — no noisy predictions from too little data.
                </>
              )}
            </p>
          ) : (
            <p className="mt-0.5 text-xs text-subtle">
              The learned reranker is turned off. Turn on “Use learned reranker” in{' '}
              <Link to="/settings" className="text-accent hover:underline" onClick={onClose}>
                Settings
              </Link>{' '}
              and it&apos;ll train itself automatically from your reading history.
            </p>
          )}
        </section>

        {/* 3. the data behind it */}
        <section className="mt-4">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold">
            <Database className="size-4 text-accent" /> The data behind it
          </h3>
          {dataPoints.length ? (
            <ul className="mt-2 space-y-1 text-xs">
              {dataPoints.map((d, i) => (
                <li key={i} className="flex items-center justify-between gap-3 border-b border-border/60 pb-1">
                  <span className="text-muted">{d.text}</span>
                  <span className="shrink-0 font-medium tabular-nums text-fg">{d.val}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-0.5 text-xs text-subtle">
              No personal signals for this story yet — it&apos;s ranked on popularity/recency. Engage with more
              stories to personalize it.
            </p>
          )}
          <p className="mt-2 flex items-center gap-1 text-[11px] text-subtle">
            <Sparkles className="size-3" />{' '}
            {fetchArticleText
              ? 'Content = titles, HN self-text, comments, and linked article text (fetched via the reader proxy).'
              : 'Content = titles, HN self-text, and comments (linked article bodies aren’t readable in-browser without the reader proxy).'}
          </p>
        </section>

        <div className="mt-4 flex justify-end gap-2">
          <Link
            to="/settings?section=ranking"
            onClick={onClose}
            className="rounded-lg border border-edge px-3 py-1.5 text-sm hover:bg-surface-2"
          >
            Tune ranking
          </Link>
        </div>
      </div>
    </div>,
    document.body
  );
}
