import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Brain, ChevronDown, ChevronRight, Cpu, Settings2, SlidersHorizontal, Sparkles, X } from 'lucide-react';
import { recentRead } from '../../lib/interactions';
import { useEventCount } from '../../hooks/useLocalData';
import { useModelStore } from '../../lib/models/registry';
import type { ProviderState } from '../../lib/models/registry';
import { loadModel, MIN_TRAIN_SAMPLES } from '../../lib/ranking/logistic';
import { rankerGate } from '../../lib/ranking/strategies';
import { hasCloudKey, usePrefs } from '../../lib/prefs';
import { safeUrl } from '../../lib/time';
import { cn } from '../../lib/cn';
import HnAccount from './HnAccount';
import WeightSliders from '../ranking/WeightSliders';
import SignalsDialog from '../SignalsDialog';
import type { FeedKind } from '../../types';

const FEED_LABEL: Record<FeedKind, string> = {
  foryou: 'For You',
  top: 'Top',
  new: 'New',
  best: 'Best',
  ask: 'Ask HN',
  show: 'Show HN',
  job: 'Jobs',
  read: 'Read',
};

const PROVIDER_LABEL: Record<string, string> = { gemini: 'Gemini', openai: 'OpenAI', anthropic: 'Anthropic' };

function statusColor(s: ProviderState['status']): string {
  if (s === 'ready') return 'bg-up';
  if (s === 'loading') return 'bg-accent';
  if (s === 'error' || s === 'unsupported') return 'bg-red-500';
  return 'bg-subtle';
}

export default function Sidebar({ feed, searching }: { feed: FeedKind; searching?: boolean }) {
  const embeddings = useModelStore((s) => s.embeddings);
  const llm = useModelStore((s) => s.llm);
  const embeddingsEnabled = usePrefs((s) => s.embeddingsEnabled);
  const llmEnabled = usePrefs((s) => s.llmEnabled);
  const llmProvider = usePrefs((s) => s.llmProvider);
  const apiKeys = usePrefs((s) => s.apiKeys);
  // A BYO cloud provider serves AI over HTTP with no local model — so "LLM off" would be
  // misleading here; show the active cloud provider instead.
  const cloud = hasCloudKey({ llmProvider, apiKeys });
  const useLearnedRanker = usePrefs((s) => s.useLearnedRanker);
  const followedDomains = usePrefs((s) => s.followedDomains);
  const followedUsers = usePrefs((s) => s.followedUsers);
  const toggleFollowDomain = usePrefs((s) => s.toggleFollowDomain);
  const toggleFollowUser = usePrefs((s) => s.toggleFollowUser);

  const signalCount = useEventCount();
  const readQ = useQuery({ queryKey: ['recentRead'], queryFn: () => recentRead(6), staleTime: 15000 });
  // Learned-reranker progress so the user can SEE personalization getting closer to
  // (or having reached) the activation gate — otherwise the 12-interaction threshold is
  // invisible unless you open a per-card "Why #N?" dialog. Uses model.n (the same count
  // the explainer shows) and is invalidated by the auto-trainer.
  const rankerQ = useQuery({ queryKey: ['ranker'], enabled: useLearnedRanker, queryFn: loadModel, staleTime: Infinity });
  const trainedN = rankerQ.data?.n ?? 0;
  // Use the SAME gate as scoring/the explainer (rankerTrained) — enough samples AND enough
  // positives — so the sidebar never claims "on" while the model isn't actually applied.
  const rankerState = rankerGate(rankerQ.data);
  const [tuneOpen, setTuneOpen] = useState(false);
  const [showSignals, setShowSignals] = useState(false);

  const recent = readQ.data ?? [];

  return (
    <aside className="app-sidebar hidden lg:block">
      {/* Scroll within the viewport so tall content (e.g. expanded Tune ranking)
          stays fully reachable instead of being clipped by the sticky pin. */}
      <div className="sticky top-[4.5rem] max-h-[calc(100dvh-5.5rem)] space-y-4 overflow-y-auto overflow-x-hidden pb-4 pr-1">
        <HnAccount />

        {!searching && (
          <section className="rounded-xl border border-border bg-surface p-4">
            <h2 className="flex items-center gap-2 text-sm font-semibold">
              {feed === 'foryou' ? (
                <Sparkles className="size-4 text-accent" />
              ) : (
                <Cpu className="size-4 text-subtle" />
              )}
              {FEED_LABEL[feed]}
            </h2>
            <p className="mt-1 text-xs leading-relaxed text-muted">
              {feed === 'foryou'
                ? 'Re-ranked from your reading activity, follows, and (optionally) local AI models — ranking runs entirely on your device.'
                : feed === 'read'
                  ? "Stories you've opened and actually read (a quick bounce doesn't count), newest first."
                  : 'Original Hacker News ordering, untouched.'}
            </p>
            {feed === 'foryou' && useLearnedRanker && (
              <p className="mt-2 text-xs text-subtle">
                {/* The count is the number of TRAINING EXAMPLES the model fit on — positives
                    (stories you read/saved/clicked) AND negatives (ones you skipped or marked
                    not-interested) — so we say "examples from your activity", not "your
                    interactions", to avoid overstating deliberate engagement (most are passive
                    skips). It's a distinct count from the raw "signals recorded" log below. */}
                {/* Phrase the clause that ACTUALLY failed (see `rankerGate`). Collapsing every
                    not-yet-on state into "read a few stories" told a reader who had read 40 to
                    read more — the problem was a degenerate fit, which reading cannot fix. */}
                {rankerState === 'trained'
                  ? `Learned reranker on — tuned to ${trainedN} examples from your activity.`
                  : rankerState === 'too-few-samples'
                    ? `Learning your taste — ${trainedN}/${MIN_TRAIN_SAMPLES} examples from your activity until the reranker switches on. It retrains in the background while this tab is inactive, or use “Retrain now” in Settings. (Examples are built when it retrains, so this lags the raw signal count below.)`
                    : rankerState === 'degenerate'
                      ? `Learning your taste — your activity so far doesn't separate the stories you engage with from the ones you skip, so the reranker has nothing to learn from yet. Reading a wider mix will give it something to work with.`
                      : `Learning your taste — read a few stories (not just scroll past them) so the reranker has enough signal to switch on. It retrains in the background while this tab is inactive, or use “Retrain now” in Settings.`}
              </p>
            )}
            <Link
              to="/settings"
              className="mt-2 inline-flex items-center gap-1.5 text-xs font-medium text-accent hover:underline"
            >
              <Settings2 className="size-3.5" /> All settings & models
            </Link>
          </section>
        )}

        {!searching && feed === 'foryou' && (
          <section className="rounded-xl border border-border bg-surface p-4">
            <button
              type="button"
              onClick={() => setTuneOpen((v) => !v)}
              aria-expanded={tuneOpen}
              className="flex w-full items-center gap-2 text-sm font-semibold"
            >
              <SlidersHorizontal className="size-4 text-accent" />
              Tune ranking
              {tuneOpen ? (
                <ChevronDown className="ml-auto size-4 text-subtle" />
              ) : (
                <ChevronRight className="ml-auto size-4 text-subtle" />
              )}
            </button>
            {tuneOpen ? (
              <div className="mt-3">
                <WeightSliders />
              </div>
            ) : (
              <p className="mt-1 text-xs text-muted">Adjust the signals — the feed re-ranks live.</p>
            )}
          </section>
        )}

        <section className="rounded-xl border border-border bg-surface p-4">
          <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold">
            <Brain className="size-4 text-subtle" /> Local models
          </h2>
          <div className="space-y-1 text-xs">
            {/* Each row links to Settings so "off" is an actionable path to enable it,
                not a dead-end status label. */}
            <Link
              to="/settings"
              className="-mx-1 flex items-center gap-2 rounded-md px-1 py-1 hover:bg-surface-2 hover:text-fg"
            >
              <span className={cn('size-2 rounded-full', statusColor(embeddings.status))} />
              <span className="text-muted">Embeddings</span>
              {/* The STATUS VALUE, drawn fainter than its own label and failing AA on the hover
                  surface — it is the informative half of the row, so it takes `muted` like the label. */}
              <span className="ml-auto text-muted">
                {embeddingsEnabled ? embeddings.status : 'off →'}
              </span>
            </Link>
            <Link
              to="/settings"
              className="-mx-1 flex items-center gap-2 rounded-md px-1 py-1 hover:bg-surface-2 hover:text-fg"
            >
              <span className={cn('size-2 rounded-full', cloud ? 'bg-up' : statusColor(llm.status))} />
              <span className="text-muted">LLM</span>
              {/* The STATUS VALUE, drawn fainter than its own label and failing AA on the hover
                  surface — it is the informative half of the row, so it takes `muted` like the label. */}
              <span className="ml-auto text-muted">
                {cloud ? `via ${PROVIDER_LABEL[llmProvider] ?? 'cloud'}` : llmEnabled ? llm.status : 'off →'}
              </span>
            </Link>
          </div>
        </section>

        {!searching && (recent.length > 0 || followedDomains.length > 0 || followedUsers.length > 0) && (
          <section className="rounded-xl border border-border bg-surface p-4">
            <h2 className="mb-2 text-sm font-semibold">Your interests</h2>
            {recent.length > 0 && (
              <>
                <p className="mb-1 text-xs text-subtle">Recently read</p>
                <ul className="mb-2 space-y-1.5">
                  {recent.map((r) => {
                    const href = safeUrl(r.url);
                    const cls = 'line-clamp-2 text-xs leading-snug text-muted hover:text-accent';
                    return (
                      <li key={r.id}>
                        {href ? (
                          <a href={href} target="_blank" rel="noreferrer" className={cls} title={r.title}>
                            {r.title}
                          </a>
                        ) : (
                          <Link to={`/item/${r.id}`} className={cls} title={r.title}>
                            {r.title}
                          </Link>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
            {followedDomains.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {followedDomains.slice(0, 8).map((d) => (
                  <button
                    key={d}
                    type="button"
                    onClick={() => toggleFollowDomain(d)}
                    title={`Unfollow ${d}`}
                    // `border-edge`, not bare `bg-accent/10`: a 10%-alpha tint is 1.09-1.30:1 against
                    // the sidebar surface in 58 of 62 design x mode cells, so the chip was clickable
                    // but not perceivable AS a control (WCAG 1.4.11 wants >=3:1). `--edge` is the
                    // token that is contrast-normalised for exactly this.
                    className="group inline-flex min-w-0 max-w-full items-center gap-1 rounded-full border border-edge bg-accent/10 px-2 py-0.5 text-xs text-fg [overflow-wrap:anywhere] hover:bg-accent/20"
                  >
                    <span className="min-w-0 truncate">{d}</span> <X className="size-3 shrink-0 opacity-50 group-hover:opacity-100" />
                  </button>
                ))}
              </div>
            )}
            {followedUsers.length > 0 && (
              <>
                <p className="mt-2 mb-1 text-xs text-subtle">Following</p>
                <div className="flex flex-wrap gap-1.5">
                  {followedUsers.slice(0, 8).map((u) => (
                    <button
                      key={u}
                      type="button"
                      onClick={() => toggleFollowUser(u)}
                      title={`Unfollow ${u}`}
                      className="group inline-flex min-w-0 max-w-full items-center gap-1 rounded-full border border-edge bg-accent/10 px-2 py-0.5 text-xs text-fg [overflow-wrap:anywhere] hover:bg-accent/20"
                    >
                      <span className="min-w-0 truncate">@{u}</span> <X className="size-3 shrink-0 opacity-50 group-hover:opacity-100" />
                    </button>
                  ))}
                </div>
              </>
            )}
          </section>
        )}

        {/* This number climbs with every impression while the reranker's example count sits still,
            which reads as one of them being broken. They measure different things; say so where both
            are visible, not only in a source comment. */}
        <button
          type="button"
          onClick={() => setShowSignals(true)}
          title="Everything recorded locally: impressions, clicks, saves, hides. The reranker trains on a subset of these, and only when it retrains — which is why the two counts differ."
          className="px-1 text-left text-xs text-subtle hover:text-accent hover:underline"
        >
          {signalCount.toLocaleString()} signals recorded locally
        </button>
        {showSignals && <SignalsDialog onClose={() => setShowSignals(false)} />}
        <p className="px-1 text-xs text-muted">
          Press <kbd className="rounded border border-border bg-surface-2 px-1">?</kbd> for keyboard
          shortcuts
        </p>
      </div>
    </aside>
  );
}
