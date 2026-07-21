import type { HnItem, Prefs, RankedStory } from '../../types';
import type { Affinities } from '../interactions';
import { computeFeatures, featureVector, FEATURE_LABELS, isFiltered } from './features';
import type { FeatureSet, RankContext } from './features';
import { MIN_TRAIN_SAMPLES, predictProba } from './logistic';
import type { LogisticModel } from './logistic';
import { domainOf } from '../time';

export interface ScoreTerm {
  key: string;
  label: string;
  weight: number;
  value: number; // the (feature) value multiplied by the weight
  contribution: number; // weight * value — the additive amount in the final score
}

export interface RankExplanation {
  score: number;
  terms: ScoreTerm[]; // the weighted blend that sums to `score`
  learned: {
    used: boolean; // was a trained model actually applied?
    probability: number; // P(engage) from the logistic model (0.5 if none)
    bias: number;
    examples: number; // how many of your interactions the model was trained on
    terms: ScoreTerm[]; // per-feature logistic contributions (weight * feature)
  };
  signals: {
    domain: string;
    domainAffinity: number;
    author: string;
    authorAffinity: number;
    relevance: number;
    termAffinity: number;
    boostKeyword: string | null;
    followedDomain: boolean;
    followedUser: boolean;
  };
}

export function makeContext(
  prefs: Prefs,
  affinities: Affinities,
  extra?: {
    simById?: Map<number, number>;
    termById?: Map<number, number>;
    learnedById?: Map<number, number>;
  }
): RankContext {
  return {
    weights: prefs.weights,
    affinities,
    followedDomains: new Set(prefs.followedDomains),
    followedUsers: new Set(prefs.followedUsers),
    mutedDomains: new Set(prefs.mutedDomains),
    mutedUsers: new Set(prefs.mutedUsers),
    keywordsBoost: prefs.keywordsBoost,
    keywordsMute: prefs.keywordsMute,
    minPoints: prefs.minPoints,
    simById: extra?.simById,
    termById: extra?.termById,
    learnedById: extra?.learnedById,
  };
}

function reasonsFor(fs: FeatureSet, item: HnItem, terms: ScoreTerm[]): string[] {
  // STRONG, always-honest personal signals: explicit follows/boosts, or affinity that
  // reflects a real HABIT (high affinity AND ≥2 distinct engaged items — so one deeply-
  // read story, whose dwell alone can spike the affinity score, never reads as "often").
  const strong: Array<{ text: string; weight: number }> = [];
  if (fs.followedUser) strong.push({ text: `By ${item.by}, who you follow`, weight: 5 });
  if (fs.followedDomain) strong.push({ text: `From ${fs.domain}, which you follow`, weight: 4.5 });
  if (fs.boostKeyword) strong.push({ text: `Matches your interest: “${fs.boostKeyword}”`, weight: 4 });
  if (fs.authorAffinity > 0.55 && fs.authorEngagedN >= 2 && item.by)
    strong.push({ text: `You often engage with ${item.by}`, weight: 3.5 });
  if (fs.domainAffinity > 0.5 && fs.domainEngagedN >= 2 && fs.domain)
    strong.push({ text: `You often read ${fs.domain}`, weight: 3 });
  if (fs.relevance > 0.6) strong.push({ text: `Similar to what you've been reading`, weight: 2.8 });
  if (fs.termAffinity > 0.35) strong.push({ text: `About topics you read about`, weight: 2.6 });
  if (strong.length) {
    strong.sort((a, b) => b.weight - a.weight);
    return strong.slice(0, 2).map((r) => r.text);
  }

  // SOFT affinity (a little history with this author/domain, or a single deep read).
  // Show it ONLY when personalization is actually the top driver of THIS card's rank —
  // otherwise the chip would falsely credit "engaged with X" for a story really ranked
  // by recency/popularity (the reason must agree with the "Why #N?" trace).
  const top = [...terms].sort((a, b) => b.contribution - a.contribution)[0];
  const personalTop =
    !!top && top.contribution > 0 && (top.key === 'affinity' || top.key === 'relevance' || top.key === 'learned');
  if (personalTop) {
    if (fs.authorAffinity > 0.3 && item.by) return [`By ${item.by}, whom you've engaged with`];
    if (fs.domainAffinity > 0.3 && fs.domain) return [`From ${fs.domain}, which you've engaged with`];
  }

  // Otherwise a single contextual reason that matches the REAL driver of the rank.
  if (top?.key === 'discussion' && fs.discussion > 0.7) return ['Active discussion'];
  if (fs.popularity > 0.85 && fs.recency > 0.55) return ['Trending now'];
  if (fs.popularity > 0.88) return [`Popular (${item.score ?? 0} pts)`];
  if (fs.recency > 0.92) return ['Fresh'];
  return [];
}

/** The weighted blend that produces the final score — the single source of truth
 * for both ranking (`scoreItem`) and the in-app explanation (`explainItem`). */
function blend(fs: FeatureSet, w: RankContext['weights'], learned: number): { score: number; terms: ScoreTerm[] } {
  const affinityRaw =
    fs.domainAffinity +
    fs.authorAffinity +
    (fs.followedDomain ? 2 : 0) +
    (fs.followedUser ? 2 : 0) +
    (fs.boostKeyword ? 1.5 : 0);
  const affinity = Math.tanh(affinityRaw / 4); // -1..1
  const learnedPull = (learned - 0.5) * 2; // -1..1

  const terms: ScoreTerm[] = [
    { key: 'popularity', label: 'Popularity', weight: w.popularity, value: fs.popularity, contribution: w.popularity * fs.popularity },
    { key: 'recency', label: 'Recency', weight: w.recency, value: fs.recency, contribution: w.recency * fs.recency },
    { key: 'discussion', label: 'Discussion', weight: w.discussion, value: fs.discussion, contribution: w.discussion * fs.discussion },
    { key: 'affinity', label: 'Your affinities', weight: w.affinity, value: affinity, contribution: w.affinity * affinity },
    { key: 'relevance', label: 'Similar to your reading', weight: w.relevance, value: fs.relevance, contribution: w.relevance * fs.relevance },
    { key: 'learned', label: 'Learned model', weight: w.learned, value: learnedPull, contribution: w.learned * learnedPull },
  ];
  const score = terms.reduce((s, t) => s + t.contribution, 0);
  return { score, terms };
}

export function scoreItem(
  item: HnItem,
  ctx: RankContext,
  model?: LogisticModel
): { score: number; reasons: string[]; fs: FeatureSet } {
  const fs = computeFeatures(item, ctx);
  const learned =
    model && model.n >= MIN_TRAIN_SAMPLES ? predictProba(model, featureVector(fs)) : fs.learned;
  const { score, terms } = blend(fs, ctx.weights, learned);
  return { score, reasons: reasonsFor(fs, item, terms), fs };
}

/** Full traceable explanation of an item's rank: final score → weighted terms →
 * the learned model's per-feature contributions → the data signals behind them. */
export function explainItem(item: HnItem, ctx: RankContext, model?: LogisticModel): RankExplanation {
  const fs = computeFeatures(item, ctx);
  const x = featureVector(fs);
  const used = !!(model && model.n >= MIN_TRAIN_SAMPLES);
  const probability = used ? predictProba(model!, x) : fs.learned;
  const { score, terms } = blend(fs, ctx.weights, probability);

  const modelTerms: ScoreTerm[] = x.map((value, i) => {
    const weight = model?.w[i] ?? 0;
    return { key: String(i), label: FEATURE_LABELS[i] ?? `f${i}`, weight, value, contribution: weight * value };
  });

  return {
    score,
    terms,
    learned: {
      used,
      probability,
      bias: model?.b ?? 0,
      examples: model?.n ?? 0,
      terms: modelTerms,
    },
    signals: {
      domain: fs.domain,
      domainAffinity: fs.domainAffinity,
      author: item.by ?? '',
      authorAffinity: fs.authorAffinity,
      relevance: fs.relevance,
      termAffinity: fs.termAffinity,
      boostKeyword: fs.boostKeyword,
      followedDomain: fs.followedDomain,
      followedUser: fs.followedUser,
    },
  };
}

export function computeForYou(
  items: HnItem[],
  ctx: RankContext,
  model?: LogisticModel
): RankedStory[] {
  const ranked: RankedStory[] = [];
  for (const item of items) {
    if (isFiltered(item, ctx)) continue;
    const { score, reasons } = scoreItem(item, ctx, model);
    ranked.push({ item, score, reasons });
  }
  ranked.sort((a, b) => b.score - a.score);
  return ranked;
}

export const DOMAIN_DIVERSITY_CAP = 3;

/**
 * Stop one domain from flooding the top of For You: after ranking by score, keep at
 * most `cap` stories per domain in the front and push the rest to the end (nothing is
 * removed — it just can't dominate the top). Improves discovery when you follow or
 * heavily engage a high-volume domain (e.g. github.com).
 */
export function diversifyByDomain(ranked: RankedStory[], cap = DOMAIN_DIVERSITY_CAP): RankedStory[] {
  const counts = new Map<string, number>();
  const front: RankedStory[] = [];
  const rest: RankedStory[] = [];
  for (const r of ranked) {
    const d = domainOf(r.item.url);
    if (!d) {
      front.push(r);
      continue;
    }
    const c = counts.get(d) ?? 0;
    if (c < cap) {
      front.push(r);
      counts.set(d, c + 1);
    } else {
      rest.push(r);
    }
  }
  return rest.length ? [...front, ...rest] : ranked;
}

export const AUTHOR_DIVERSITY_CAP = 2;

/**
 * Stop one AUTHOR from flooding the top of For You. A single deeply-read author can
 * spike their affinity high enough to rank several of their *unrelated* stories near
 * the top; this keeps at most `cap` per author in the front and pushes the rest down
 * (nothing removed). Complements `diversifyByDomain`; apply after it.
 */
export function diversifyByAuthor(ranked: RankedStory[], cap = AUTHOR_DIVERSITY_CAP): RankedStory[] {
  const counts = new Map<string, number>();
  const front: RankedStory[] = [];
  const rest: RankedStory[] = [];
  for (const r of ranked) {
    const a = r.item.by;
    if (!a) {
      front.push(r);
      continue;
    }
    const c = counts.get(a) ?? 0;
    if (c < cap) {
      front.push(r);
      counts.set(a, c + 1);
    } else {
      rest.push(r);
    }
  }
  return rest.length ? [...front, ...rest] : ranked;
}
