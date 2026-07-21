import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Brain, ChevronDown, ChevronRight, Cpu, Settings2, SlidersHorizontal, Sparkles, X } from 'lucide-react';
import { eventCount, recentRead } from '../../lib/interactions';
import { useModelStore } from '../../lib/models/registry';
import type { ProviderState } from '../../lib/models/registry';
import { loadModel, MIN_TRAIN_SAMPLES } from '../../lib/ranking/logistic';
import { usePrefs } from '../../lib/prefs';
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
  const useLearnedRanker = usePrefs((s) => s.useLearnedRanker);
  const followedDomains = usePrefs((s) => s.followedDomains);
  const followedUsers = usePrefs((s) => s.followedUsers);
  const toggleFollowDomain = usePrefs((s) => s.toggleFollowDomain);
  const toggleFollowUser = usePrefs((s) => s.toggleFollowUser);

  const countQ = useQuery({ queryKey: ['eventCount'], queryFn: eventCount, staleTime: 10000 });
  const readQ = useQuery({ queryKey: ['recentRead'], queryFn: () => recentRead(6), staleTime: 15000 });
  // Learned-reranker progress so the user can SEE personalization getting closer to
  // (or having reached) the activation gate — otherwise the 12-interaction threshold is
  // invisible unless you open a per-card "Why #N?" dialog. Uses model.n (the same count
  // the explainer shows) and is invalidated by the auto-trainer.
  const rankerQ = useQuery({ queryKey: ['ranker'], enabled: useLearnedRanker, queryFn: loadModel, staleTime: Infinity });
  const trainedN = rankerQ.data?.n ?? 0;
  const rankerActive = trainedN >= MIN_TRAIN_SAMPLES;
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
                {/* "story interactions" (the stories the reranker has trained on) is
                    deliberately distinct wording from the raw "signals recorded locally"
                    log below — different counts (training examples vs every event), so the
                    same word for both doesn't read as a contradiction. */}
                {rankerActive
                  ? `Learned reranker on — tuned to ${trainedN} of your story interactions.`
                  : `Learning your taste — ${trainedN}/${MIN_TRAIN_SAMPLES} story interactions until the learned reranker switches on. It trains itself as you read.`}
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
              <span className="ml-auto text-subtle">
                {embeddingsEnabled ? embeddings.status : 'off →'}
              </span>
            </Link>
            <Link
              to="/settings"
              className="-mx-1 flex items-center gap-2 rounded-md px-1 py-1 hover:bg-surface-2 hover:text-fg"
            >
              <span className={cn('size-2 rounded-full', statusColor(llm.status))} />
              <span className="text-muted">LLM</span>
              <span className="ml-auto text-subtle">{llmEnabled ? llm.status : 'off →'}</span>
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
                    className="group inline-flex items-center gap-1 rounded-full bg-accent/10 px-2 py-0.5 text-xs text-accent hover:bg-accent/20"
                  >
                    {d} <X className="size-3 opacity-50 group-hover:opacity-100" />
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
                      className="group inline-flex items-center gap-1 rounded-full bg-accent/10 px-2 py-0.5 text-xs text-accent hover:bg-accent/20"
                    >
                      @{u} <X className="size-3 opacity-50 group-hover:opacity-100" />
                    </button>
                  ))}
                </div>
              </>
            )}
          </section>
        )}

        <button type="button" onClick={() => setShowSignals(true)} className="px-1 text-left text-xs text-subtle hover:text-accent hover:underline">
          {(countQ.data ?? 0).toLocaleString()} signals recorded locally
        </button>
        {showSignals && <SignalsDialog onClose={() => setShowSignals(false)} />}
        <p className="px-1 text-xs text-subtle">
          Press <kbd className="rounded border border-border bg-surface-2 px-1">?</kbd> for keyboard
          shortcuts
        </p>
      </div>
    </aside>
  );
}
