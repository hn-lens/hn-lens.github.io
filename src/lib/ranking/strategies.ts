import type { HnItem, Prefs, RankedStory } from '../../types';
import type { Affinities } from '../interactions';
import { computeFeatures, featureVector, FEATURE_LABELS, isFiltered } from './features';
import type { FeatureSet, RankContext } from './features';
import { MIN_TRAIN_POSITIVES, MIN_TRAIN_SAMPLES, predictProba } from './logistic';
import type { LogisticModel } from './logistic';
import { domainOf } from '../time';

/**
 * WHICH clause of the gate a model fails, so a surface can phrase the actual reason rather than
 * defaulting to "read a few more stories".
 */
export type RankerGate = 'trained' | 'no-model' | 'too-few-samples' | 'too-few-positives' | 'degenerate';

export function rankerGate(model?: LogisticModel): RankerGate {
  if (!model) return 'no-model';
  if (model.n < MIN_TRAIN_SAMPLES) return 'too-few-samples';
  if ((model.pos ?? 0) < MIN_TRAIN_POSITIVES) return 'too-few-positives';
  // A model whose weights are all NEGLIGIBLE is degenerate: it produces a near-identical probability
  // for every story, so it contributes nothing a reader can see. Counting it as "trained" made the
  // sidebar, the "Why #N?" panel and the gate all report an active personalization that could not
  // move a card. The floor is on MAGNITUDE, not `!== 0`: a fit can converge to weights of ~1e-6
  // (numerical noise, not signal), which `!== 0` wrongly accepted. Real trained weights are O(0.1-10)
  // (measured), so 1e-4 cleanly separates dead from real without gating a genuinely weak model.
  if (!model.w.some((x) => Number.isFinite(x) && Math.abs(x) > 1e-4)) return 'degenerate';
  return 'trained';
}

/** The learned reranker is APPLIED only when it has enough samples AND enough POSITIVES —
 *  a dozen skips with one click carries no real preference signal. One source of truth so
 *  scoreItem + explainItem + the sidebar progress never disagree. */
export function rankerTrained(model?: LogisticModel): boolean {
  return rankerGate(model) === 'trained';
}

/**
 * The fraction of training examples that were positive — a fact about the user, shown as such in
 * the explainer. Used as the centring fallback when there is no pool (see `withPoolCenter`).
 */
export function learnedBaseRate(model?: LogisticModel): number {
  if (!model || !model.n) return 0.5;
  return Math.min(0.95, Math.max(0.03, (model.pos ?? 0) / model.n));
}

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
    // The reference the DISPLAYED signal is centered on (the ranked pool's median prediction).
    // This is a CENTRING device, NOT a fact about the user — don't render it as one.
    baseRate: number;
    // The user's ACTUAL engagement rate (positives / samples). This is the only one of the two that
    // may be described to the reader as "how often you engage".
    engagementRate: number;
    examples: number; // how many of your interactions the model was trained on
    gate: RankerGate; // which clause of the activation gate is failing (or 'trained')
    terms: ScoreTerm[]; // per-feature logistic contributions (weight * feature), incl. a 'baseline' bias bar
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
  // `relevance` and `termAffinity` reach the score only through the learned model, so they carry
  // the same personal-drives guard as the soft block below.
  const contentDrivesRank = () => {
    const t = [...terms].sort((a, b) => b.contribution - a.contribution)[0];
    return !!t && t.contribution > 0 && (t.key === 'relevance' || t.key === 'learned');
  };
  if (fs.relevance > 0.6 && contentDrivesRank())
    strong.push({ text: `Similar to what you've been reading`, weight: 2.8 });
  if (fs.termAffinity > 0.35 && contentDrivesRank())
    strong.push({ text: `About topics you read about`, weight: 2.6 });
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
    // Phrase the chip from the signal that actually earned it, and only above a floor; below the
    // floor say the general thing rather than naming a signal the "Why #N?" panel would not show.
    if (top?.key === 'learned') {
      if (fs.termAffinity > 0.15) return ['Matches what you tend to read about'];
      if (fs.relevance > 0.35) return ['Similar to your recent reading'];
      return ['Picked by your learned ranking'];
    }
  }

  // Otherwise a single contextual reason that matches the REAL driver of the rank.
  if (top?.key === 'discussion' && fs.discussion > 0.7) return ['Active discussion'];
  if (fs.popularity > 0.85 && fs.recency > 0.55) return ['Trending now'];
  if (fs.popularity > 0.88) return [`Popular (${item.score ?? 0} pts)`];
  if (fs.recency > 0.92) return ['Fresh'];
  return [];
}

/**
 * Turn the learned model's calibrated probability into the bounded ±1 RANKING signal the blend
 * consumes — via LOG-ODDS, deliberately NOT the raw probability difference.
 *
 * Why: Platt calibration anchors P(engage) at your true base rate, and you engage with a small
 * MINORITY of what you see. So for a minority engager both a genuinely-good story and a mediocre one
 * land deep in the sigmoid's flat tail, and their PROBABILITY gap collapses even when the model
 * separated them cleanly — measured: a story the model rated 7x more likely to be engaged (P .129 vs
 * .019) yielded a learned-term differential of only 0.22, while popularity+discussion move a full
 * 0..1 each. The blend then physically cannot express the model's opinion: For You opened with five
 * sports stories the user had never once clicked, above every story on the only topic they read, and
 * NO slider setting could fix it (the learned weight maxes at 2.5, and popularity+discussion both had
 * to be zeroed before taste won). Personalization looked broken precisely in the DISCOVERY case — a
 * new source on a topic you read — which is the whole point of the feature.
 *
 * Log-odds is linear in the model's `w·x`, so the ranking MARGIN survives calibration; `tanh` bounds
 * it back to ±1 so the term stays commensurate with the other signals and the sliders keep their
 * meaning; centering on the base rate keeps a typical story at ~0 (an above-average story reads
 * positive, below-average negative), so the DISPLAYED sign remains meaningful.
 */
export function logitOf(v: number): number {
  const c = Math.min(1 - 1e-6, Math.max(1e-6, v));
  return Math.log(c / (1 - c));
}

/** The learned model's pull on -1..1, centred on `baseRate`. See SPEC.md §2.2. */
export function learnedSignal(p: number, baseRate = 0.5, scale = 2, amplitude = 1): number {
  return amplitude * Math.tanh((logitOf(p) - logitOf(baseRate)) / Math.max(0.05, scale));
}

/**
 * How the "Why #N?" panel should present the model's odds for a story vs a typical one, so the prose
 * reconciles with the Learned-model bar (SPEC §2.5). Both odds are clamped to [5,95] — we don't claim
 * a certainty a few dozen interactions can't support — so for a very selective or very avid reader
 * BOTH can round to the SAME number while the model still rates the story above/below typical. In
 * that case the panel must show the DIRECTION (whose sign matches the bar), not a phantom "gap"
 * between two identical percentages.
 */
export function oddsComparison(
  probability: number,
  baseRate: number
): { pctThis: number; pctTypical: number; collapsed: boolean; direction: 'higher' | 'lower' | 'same' } {
  const clamp = (p: number) => Math.min(95, Math.max(5, Math.round(p * 100)));
  const pctThis = clamp(probability);
  const pctTypical = clamp(baseRate);
  const d = probability - baseRate; // logit is monotonic, so this sign == the learned pull's sign
  const direction = Math.abs(d) < 1e-4 ? 'same' : d > 0 ? 'higher' : 'lower';
  return { pctThis, pctTypical, collapsed: pctThis === pctTypical, direction };
}

/** The weighted blend that produces the final score — the single source of truth
 * for both ranking (`scoreItem`) and the in-app explanation (`explainItem`). */
function blend(
  fs: FeatureSet,
  w: RankContext['weights'],
  learned: number,
  baseRate = 0.5,
  learnedScale = 2,
  learnedAmplitude = 1
): { score: number; terms: ScoreTerm[] } {
  const affinityRaw =
    fs.domainAffinity +
    fs.authorAffinity +
    (fs.followedDomain ? 2 : 0) +
    (fs.followedUser ? 2 : 0) +
    (fs.boostKeyword ? 1.5 : 0);
  const affinity = Math.tanh(affinityRaw / 4); // -1..1
  const learnedPull = learnedSignal(learned, baseRate, learnedScale, learnedAmplitude);

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
  const used = rankerTrained(model);
  const learned = used ? predictProba(model!, featureVector(fs)) : fs.learned;
  const baseRate = used ? (ctx.learnedCenter ?? learnedBaseRate(model)) : 0.5;
  const { score, terms } = blend(fs, ctx.weights, learned, baseRate, ctx.learnedScale, ctx.learnedAmplitude);
  return { score, reasons: reasonsFor(fs, item, terms), fs };
}

/** Round every contribution to 2dp and push the leftover onto the largest-magnitude term, so the
 * DISPLAYED values sum exactly to the displayed total. */
function reconcileTo2dp(terms: ScoreTerm[], target: number): ScoreTerm[] {
  if (terms.length === 0) return terms;
  const r2 = (v: number) => Math.round(v * 100) / 100;
  const out = terms.map((t) => ({ ...t, contribution: r2(t.contribution) }));
  const residual = r2(r2(target) - out.reduce((a, t) => a + t.contribution, 0));
  if (residual !== 0) {
    let bigI = 0;
    for (let i = 1; i < out.length; i++) {
      if (Math.abs(out[i].contribution) > Math.abs(out[bigI].contribution)) bigI = i;
    }
    out[bigI] = { ...out[bigI], contribution: r2(out[bigI].contribution + residual) };
  }
  return out;
}

/** Full traceable explanation of an item's rank: final score → weighted terms →
 * the learned model's per-feature contributions → the data signals behind them. */
export function explainItem(item: HnItem, ctx: RankContext, model?: LogisticModel): RankExplanation {
  const fs = computeFeatures(item, ctx);
  const x = featureVector(fs);
  const used = rankerTrained(model);
  const probability = used ? predictProba(model!, x) : fs.learned;
  const baseRate = used ? (ctx.learnedCenter ?? learnedBaseRate(model)) : 0.5;
  const engagementRate = used ? learnedBaseRate(model) : 0.5;
  const { score, terms } = blend(fs, ctx.weights, probability, baseRate, ctx.learnedScale, ctx.learnedAmplitude);

  // Display-only. The model is additive in log-odds but the displayed pull is tanh(z/scale), so
  // scale each additive term by (pull / z) — proportional attribution, exact: Σ scaled = pull.
  // The divisor MUST be `ctx.learnedScale`, the same constant the score used, or the bars stop
  // summing to the figure beside them.
  const centreLogit = logitOf(baseRate);
  const zBase = used ? model!.b - centreLogit : 0;
  const zSum = zBase + x.reduce((acc, v, i) => acc + (model?.w[i] ?? 0) * v, 0);
  const pullScale = Math.max(0.05, ctx.learnedScale ?? 2);
  const pull = (ctx.learnedAmplitude ?? 1) * Math.tanh(zSum / pullScale);
  // Scale to the SCORE-TABLE figure (weight × pull), not the bare pull — the table shows the
  // weighted contribution, so summing to the pull alone would only match at the default weight of
  // 1.0 and drift by exactly the weight anywhere else.
  const learnedWeight = ctx.weights.learned;
  const attrTarget = learnedWeight * pull;
  const attrScale = Math.abs(zSum) < 1e-9 ? learnedWeight * 0.5 : attrTarget / zSum;

  const featureTerms: ScoreTerm[] = x.map((value, i) => {
    const weight = model?.w[i] ?? 0;
    return {
      key: String(i),
      label: FEATURE_LABELS[i] ?? `f${i}`,
      weight,
      value,
      contribution: used ? weight * value * attrScale : weight * value,
    };
  });
  // Prepend the model BIAS as an explicit "baseline" bar. predictProba = sigmoid(bias + Σ w·x), so
  // the feature bars + this baseline sum to the logit that yields P(engage) — without it, the
  // (mostly positive) feature bars look like they contradict a low % / a negative learned pull. The
  // bias is strongly negative because you engage with only a small share of stories (the base rate).
  const modelTerms: ScoreTerm[] = used
    ? [
        // The label must MATCH the user's actual rate. Hardcoding "you rarely engage" produced
        // "Baseline (you rarely engage)" beside "you engage with only ~90% of stories" for an avid
        // reader — the panel contradicting itself in the one place that exists to build trust.
        {
          key: 'baseline',
          // Measured against a TYPICAL story in this feed (the pool centre the pull is centred on),
          // not against absolute zero — that is what makes the bars sum to the displayed pull.
          label: 'Baseline (a typical story here)',
          weight: 1,
          value: zBase,
          contribution: zBase * attrScale,
        },
        ...featureTerms,
      ]
    : featureTerms;

  // ORDER MATTERS: reconcile the OUTER score table FIRST, then reconcile these bars against the
  // figure it actually displays. The outer table pays its residual to its largest row, which may be
  // the learned row itself, so bars reconciled against the pre-nudge figure sum to a stale number.
  const outerTerms = reconcileTo2dp(terms, score);
  const displayedLearned = outerTerms.find((t) => t.key === 'learned')?.contribution ?? attrTarget;
  const roundedModelTerms = used ? reconcileTo2dp(modelTerms, displayedLearned) : modelTerms;

  return {
    score,
    // Reconcile the outer score table to 2dp, so the displayed rows sum to the displayed score.
    terms: outerTerms,
    learned: {
      used,
      probability,
      bias: model?.b ?? 0,
      baseRate,
      engagementRate,
      examples: model?.n ?? 0,
      // WHICH gate clause the model fails, so the panel explains the real reason rather than
      // always attributing it to too little reading (see `rankerGate`).
      gate: rankerGate(model),
      terms: roundedModelTerms,
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

/** Median P(engage) across the candidates actually being ranked — the reference a reader means by
 * "a typical story". Undefined when there's no trained model to predict with. */
function poolCenter(items: HnItem[], ctx: RankContext, model?: LogisticModel): { center: number; scale: number; amplitude: number } | undefined {
  if (!rankerTrained(model)) return undefined;
  const ps: number[] = [];
  for (const item of items) {
    if (isFiltered(item, ctx)) continue;
    ps.push(predictProba(model!, featureVector(computeFeatures(item, ctx))));
  }
  if (ps.length === 0) return undefined;
  ps.sort((a, b) => a - b);
  const mid = ps.length >> 1;
  const center = ps.length % 2 ? ps[mid] : (ps[mid - 1] + ps[mid]) / 2;

  const d = ps.map((p) => Math.abs(logitOf(p) - logitOf(center))).sort((a, b) => a - b);
  const p90 = d[Math.min(d.length - 1, Math.floor(d.length * 0.9))];
  const TARGET_PULL = 0.8; // what the 90th-percentile story should read as, on -1..1
  const raw = p90 / Math.atanh(TARGET_PULL);
  // Authority scales with held-out AUC, discounted by its own standard error. See SPEC.md §2.2.
  const CHANCE = 0.5;
  const CONFIDENT = 0.6;
  const heldOutPositives = Math.max(1, Math.round((model!.pos ?? 0) / 3));
  const se = Math.sqrt(0.25 / heldOutPositives);
  const edge = (model!.auc ?? CHANCE) - CHANCE - se;
  const skill = Math.min(1, Math.max(0, edge / (CONFIDENT - CHANCE)));
  const floor = 0.35 - skill * 0.3;
  const scale = Math.min(8, Math.max(floor, raw));
  const amplitude = 0.2 + 0.8 * skill;
  return { center, scale, amplitude };
}

/**
 * Augment a context with the pool-derived `learnedCenter`. Callers that also explain items must pass
 * this SAME context to `explainItem`, or the explanation is centred differently from the score.
 */
export function withPoolCenter(items: HnItem[], ctx: RankContext, model?: LogisticModel): RankContext {
  if (ctx.learnedCenter !== undefined) return ctx;
  const c = poolCenter(items, ctx, model);
  return c === undefined ? ctx : { ...ctx, learnedCenter: c.center, learnedScale: c.scale, learnedAmplitude: c.amplitude };
}

export function computeForYou(
  items: HnItem[],
  ctx: RankContext,
  model?: LogisticModel
): RankedStory[] {
  // Centre the displayed learned signal on this pool's median prediction, not the training base
  // rate, so "a typical story reads ~0" holds for the candidates actually being ranked.
  const poolCtx = withPoolCenter(items, ctx, model);
  const ranked: RankedStory[] = [];
  for (const item of items) {
    if (isFiltered(item, poolCtx)) continue;
    const { score, reasons } = scoreItem(item, poolCtx, model);
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
