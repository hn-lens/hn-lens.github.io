import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { BarChart3, Database, Scale, Sparkles, X } from 'lucide-react';
import { stripHtml } from '../../lib/html';
import { usePrefs } from '../../lib/prefs';
import { MIN_TRAIN_SAMPLES } from '../../lib/ranking/logistic';
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
  learned: "The trained model's overall engage/skip prediction, centered at 0.",
};

/** A signed horizontal bar for one contribution, scaled to `max`. */
function Bar({ term, max, hint }: { term: ScoreTerm; max: number; hint?: string }) {
  const pct = max > 0 ? (Math.abs(term.contribution) / max) * 100 : 0;
  const positive = term.contribution >= 0;
  return (
    <div className="flex items-center gap-2 text-xs">
      <div className="w-44 shrink-0 leading-tight text-muted" title={hint || term.label}>
        {term.label}
        {hint && <span className="ml-1 cursor-help text-subtle">ⓘ</span>}
      </div>
      <div className="relative flex h-4 flex-1 items-center">
        <div className="absolute left-1/2 h-full w-px bg-border" />
        <div
          className={positive ? 'ml-[50%] h-2.5 rounded-r' : 'mr-[50%] ml-auto h-2.5 rounded-l'}
          style={{ width: `${pct / 2}%`, background: positive ? '#3fb950' : '#f85149' }}
        />
      </div>
      <div className="w-24 shrink-0 text-right font-medium tabular-nums">
        {fmt(term.contribution)}
        <span className="ml-1 text-subtle">
          ({fmt(term.weight, 1)}×{term.value.toFixed(2)})
        </span>
      </div>
    </div>
  );
}

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
    .filter((t) => Math.abs(t.contribution) > 1e-6)
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
      aria-label={`Why this story is ranked number ${rank}`}
    >
      <div
        className="max-h-[88vh] w-full max-w-xl overflow-y-auto rounded-t-2xl border border-border bg-surface p-4 shadow-xl sm:rounded-2xl sm:p-5"
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
            biggest factor: <span className="font-medium text-fg">{topTerm.label}</span> {fmt(topTerm.contribution)}
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
            Final score = sum of each signal × its weight. Tune the weights in Settings.
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
                Logistic regression estimates a{' '}
                <span className="font-semibold text-fg">~{engageChancePct(explain.learned.probability)}%</span> chance
                you&apos;ll engage — trained on <span className="font-semibold text-fg">{explain.learned.examples}</span>{' '}
                of your interactions (clicks, saves, hides), leave-one-out. Each bar is a feature × its learned weight:
              </p>
              <div className="mt-2 space-y-1.5">
                {modelTerms.slice(0, 8).map((t) => (
                  <Bar key={t.key} term={t} max={modelMax} />
                ))}
                {modelTerms.length === 0 && (
                  <p className="text-xs text-subtle">All features are neutral for this story.</p>
                )}
              </div>
            </>
          ) : useLearnedRanker ? (
            <p className="mt-0.5 text-xs text-subtle">
              Still learning — the reranker activates once it has {MIN_TRAIN_SAMPLES} of your interactions (you have{' '}
              <span className="font-semibold text-fg">{explain.learned.examples}</span>). It trains itself
              automatically as you read — there&apos;s no manual step. Until then, ranking uses popularity, recency,
              and your affinities — no noisy predictions from too little data.
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
            to="/settings"
            onClick={onClose}
            className="rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-surface-2"
          >
            Tune ranking
          </Link>
        </div>
      </div>
    </div>,
    document.body
  );
}
