import { useQuery } from '@tanstack/react-query';
import { DEFAULT_WEIGHTS, usePrefs } from '../../lib/prefs';
import { computeAffinities } from '../../lib/interactions';
import { loadModel } from '../../lib/ranking/logistic';
import { rankerTrained } from '../../lib/ranking/strategies';
import { Slider } from '../ui/controls';
import type { RankWeights } from '../../types';

const LABELS: Array<{ key: keyof RankWeights; label: string }> = [
  { key: 'popularity', label: 'Popularity (HN score)' },
  { key: 'recency', label: 'Recency (freshness)' },
  { key: 'discussion', label: 'Discussion (comments)' },
  { key: 'affinity', label: 'Affinity (your follows & habits)' },
  { key: 'relevance', label: 'Relevance (embedding similarity)' },
  { key: 'learned', label: 'Learned reranker' },
];

export default function WeightSliders() {
  const weights = usePrefs((s) => s.weights);
  const setWeights = usePrefs((s) => s.setWeights);
  const embeddingsEnabled = usePrefs((s) => s.embeddingsEnabled);
  const useLearnedRanker = usePrefs((s) => s.useLearnedRanker);
  const followedDomains = usePrefs((s) => s.followedDomains);
  const followedUsers = usePrefs((s) => s.followedUsers);
  const keywordsBoost = usePrefs((s) => s.keywordsBoost);

  const affQ = useQuery({ queryKey: ['affinities'], queryFn: computeAffinities, staleTime: 30000 });
  const modelQ = useQuery({ queryKey: ['ranker'], queryFn: loadModel });

  // The affinity TERM folds in boost keywords too (strategies.ts blend: +1.5 per boostKeyword), so
  // an onboarded user with only interests set has an ACTIVE affinity signal — the hint must not
  // call it inactive (that contradicts the "Why #N?" trace which credits the boost keyword).
  const hasAffinity =
    followedDomains.length > 0 ||
    followedUsers.length > 0 ||
    keywordsBoost.length > 0 ||
    Object.values(affQ.data?.domains ?? {}).some((v) => v !== 0) ||
    Object.values(affQ.data?.authors ?? {}).some((v) => v !== 0);
  // The learned reranker only affects ranking when BOTH the toggle is on AND it's trained
  // enough (rankerTrained) — the exact `activeModel` gate useFeed uses for scoring/the banner,
  // so this slider hint can't say "active" while "Why #N?" and the feed say it's off/learning.
  // Distinguish a deliberate OFF from "still learning" so the hint is honest either way.
  const learnedHint = !useLearnedRanker
    ? 'inactive — turn on the Learned reranker in Settings'
    : rankerTrained(modelQ.data)
      ? undefined
      : 'inactive — retrains in the background (or “Retrain now” in Settings)';

  // A signal that's currently zero makes its weight a no-op — say so.
  const inactive: Partial<Record<keyof RankWeights, string>> = {
    affinity: hasAffinity ? undefined : 'inactive — grows as you follow sites/users or open stories',
    relevance: embeddingsEnabled ? undefined : 'inactive — enable Embeddings in Settings',
    learned: learnedHint,
  };

  return (
    <div className="space-y-3">
      {LABELS.map(({ key, label }) => (
        <Slider
          key={key}
          label={label}
          value={weights[key]}
          min={0}
          max={2.5}
          step={0.1}
          onChange={(v) => setWeights({ [key]: v } as Partial<RankWeights>)}
          hint={inactive[key]}
          inactive={!!inactive[key]}
        />
      ))}
      <button
        type="button"
        onClick={() => setWeights(DEFAULT_WEIGHTS)}
        className="text-sm text-accent hover:underline"
      >
        Reset to defaults
      </button>
    </div>
  );
}
