import { useQuery } from '@tanstack/react-query';
import { DEFAULT_WEIGHTS, usePrefs } from '../../lib/prefs';
import { computeAffinities } from '../../lib/interactions';
import { loadModel } from '../../lib/ranking/logistic';
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
  const followedDomains = usePrefs((s) => s.followedDomains);
  const followedUsers = usePrefs((s) => s.followedUsers);

  const affQ = useQuery({ queryKey: ['affinities'], queryFn: computeAffinities, staleTime: 30000 });
  const modelQ = useQuery({ queryKey: ['ranker'], queryFn: loadModel });

  const hasAffinity =
    followedDomains.length > 0 ||
    followedUsers.length > 0 ||
    Object.values(affQ.data?.domains ?? {}).some((v) => v !== 0) ||
    Object.values(affQ.data?.authors ?? {}).some((v) => v !== 0);
  const hasModel = (modelQ.data?.n ?? 0) > 0;

  // A signal that's currently zero makes its weight a no-op — say so.
  const inactive: Partial<Record<keyof RankWeights, string>> = {
    affinity: hasAffinity ? undefined : 'inactive — grows as you follow sites/users or open stories',
    relevance: embeddingsEnabled ? undefined : 'inactive — enable Embeddings in Settings',
    learned: hasModel ? undefined : 'inactive — “Train from history” in Settings',
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
