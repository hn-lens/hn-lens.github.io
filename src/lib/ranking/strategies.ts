import type { HnItem, Prefs, RankedStory } from '../../types';
import type { Affinities } from '../interactions';
import { computeFeatures, featureVector, FEATURE_LABELS, isFiltered } from './features';
import type { FeatureSet, RankContext } from './features';
import { MIN_TRAIN_POSITIVES, MIN_TRAIN_SAMPLES, predictProba } from './logistic';
import type { LogisticModel } from './logistic';
import { domainOf } from '../time';

/** The learned reranker is APPLIED only when it has enough samples AND enough POSITIVES —
 *  a dozen skips with one click carries no real preference signal. One source of truth so
 *  scoreItem + explainItem + the sidebar progress never disagree. */
/**
 * WHICH clause of the gate a model fails, so every surface that EXPLAINS the reranker's state stays
 * tied to the boolean that DECIDES it.
 *
 * The gate has three parts, but the sidebar, Settings and the "Why #N?" panel each re-derived their
 * message from only the first two. A reader whose model came out degenerate was therefore told to
 * "read a few more stories" — advice they had already followed dozens of times, with no way to
 * escape it, because reading more was not what was wrong. Return the failing clause and let each
 * surface phrase that one rather than guessing.
 */
export type RankerGate = 'trained' | 'no-model' | 'too-few-samples' | 'too-few-positives' | 'degenerate';

export function rankerGate(model?: LogisticModel): RankerGate {
  if (!model) return 'no-model';
  if (model.n < MIN_TRAIN_SAMPLES) return 'too-few-samples';
  if ((model.pos ?? 0) < MIN_TRAIN_POSITIVES) return 'too-few-positives';
  // A model whose weights are ALL zero (or non-finite) is degenerate: it produces the identical
  // probability for every story, so it contributes exactly nothing to the ranking. Counting it as
  // "trained" made the sidebar, the "Why #N?" panel and the gate all report an active
  // personalization that demonstrably could not move a single card.
  if (!model.w.some((x) => Number.isFinite(x) && x !== 0)) return 'degenerate';
  return 'trained';
}

/** The learned reranker is APPLIED only when it has enough samples AND enough POSITIVES —
 *  a dozen skips with one click carries no real preference signal. One source of truth so
 *  scoreItem + explainItem + the sidebar progress never disagree. */
export function rankerTrained(model?: LogisticModel): boolean {
  return rankerGate(model) === 'trained';
}

/**
 * The learned model's BASE ENGAGEMENT RATE — the fraction of training examples that were positive.
 * This is a fact ABOUT THE USER (shown as such in the explainer). The displayed signal is centred on
 * the ranked POOL's median (see `withPoolCenter`); this value is the fallback when there is no pool.
 * Historically the signal was centred here (not at an absolute 0.5) so a "typical" story reads ≈ 0, an
 * above-your-average story positive, a below-average one negative. Since it's a constant per model
 * (fixed for a whole ranking pass), re-centering is RANKING-NEUTRAL — it only makes the DISPLAYED
 * sign meaningful (you engage with a MINORITY of stories, so centering at 50% made almost every
 * story show a confusing negative learned pull even when the model liked it relative to your norm).
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
    // The learned model can promote a card on CONTENT (term overlap, embedding similarity, or their
    // crosses) with no author/domain history at all — and with no branch for that, those cards fell
    // through to the popularity/recency chips or to nothing. So the feed was silent about exactly
    // the stories personalization had picked: 13 of 25 trained cards carried no chip, while a card
    // ranked by raw popularity happily claimed "About topics you read about".
    //
    // Phrase each case from the signal that actually earned it, and only above a floor, so the chip
    // is backed by the same evidence the "Why #N?" panel would show. Below that floor say the honest
    // general thing rather than inventing a specific one.
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
 * positive, below-average negative), so the DISPLAYED sign remains meaningful. Monotone in `p`, so it
 * can never reorder against the model's own opinion.
 */
/** Plain-language description of how often this user engages — so the baseline bar's label and the
 * explainer copy stay TRUE at any base rate, not just a low one. */
export function baseRateWord(baseRate: number): string {
  if (baseRate < 0.35) return 'you rarely engage';
  if (baseRate > 0.65) return 'you engage with most stories';
  return 'your typical story';
}

export function logitOf(v: number): number {
  const c = Math.min(1 - 1e-6, Math.max(1e-6, v));
  return Math.log(c / (1 - c));
}

export function learnedSignal(p: number, baseRate = 0.5): number {
  return Math.tanh((logitOf(p) - logitOf(baseRate)) / 2);
}

/** The weighted blend that produces the final score — the single source of truth
 * for both ranking (`scoreItem`) and the in-app explanation (`explainItem`). */
function blend(
  fs: FeatureSet,
  w: RankContext['weights'],
  learned: number,
  baseRate = 0.5
): { score: number; terms: ScoreTerm[] } {
  const affinityRaw =
    fs.domainAffinity +
    fs.authorAffinity +
    (fs.followedDomain ? 2 : 0) +
    (fs.followedUser ? 2 : 0) +
    (fs.boostKeyword ? 1.5 : 0);
  const affinity = Math.tanh(affinityRaw / 4); // -1..1
  const learnedPull = learnedSignal(learned, baseRate);

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
  const { score, terms } = blend(fs, ctx.weights, learned, baseRate);
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
  const { score, terms } = blend(fs, ctx.weights, probability, baseRate);

  // Express every bar in the SAME UNITS as the "Learned model" term shown in the score breakdown, so
  // a reader can literally ADD THEM UP and land on that number.
  //
  // The model is additive in LOG-ODDS: z = (bias - poolCentre) + Σ wᵢxᵢ, and the displayed pull is
  // tanh(z/2). Showing the raw log-odds bars meant the panel had THREE representations of one
  // quantity — the bars' sum, the % they convert to, and the signed pull the other section
  // attributes to the same model — while stating only the first link. Adding the bars up gave a
  // number that appeared nowhere. Sigmoid/tanh are non-linear, so no per-feature decomposition sums
  // to the pull directly; instead scale every additive term by (pull / z), the standard proportional
  // attribution. That is exact (Σ scaled = pull), preserves each term's sign and relative size, and
  // is numerically safe: pull/z → 0.5 as z → 0 and shrinks as tanh saturates, so it never blows up.
  // Display-only — ranking is untouched.
  const centreLogit = logitOf(baseRate);
  const zBase = used ? model!.b - centreLogit : 0;
  const zSum = zBase + x.reduce((acc, v, i) => acc + (model?.w[i] ?? 0) * v, 0);
  const pull = Math.tanh(zSum / 2);
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

  // The bars are displayed to 2dp, and the promise is that a reader can ADD THEM UP and get the
  // score-table figure. Rounding each independently breaks that by a cent or two (four bars, each
  // ±0.005), which for a small pull is a large relative error and re-opens the very mismatch this
  // display exists to close. Apportion the rounding residual onto the largest bar (largest-remainder
  // style) so the numbers a user actually sees reconcile EXACTLY.
  const roundedModelTerms = used ? reconcileTo2dp(modelTerms, attrTarget) : modelTerms;

  return {
    score,
    // Reconcile the OUTER score table to 2dp too, exactly as the model bars already are.
    // The panel invites the reader to add these up ("Final score = sum of each signal x its
    // weight"), but each row and the total were rounded to 2dp INDEPENDENTLY, so on ~28% of cards
    // the displayed rows summed to 0.01 away from the displayed score. Anyone who does the
    // arithmetic the copy asks for gets a number that appears nowhere on screen — the same defect
    // already fixed one section lower, left unfixed in the section above it.
    terms: reconcileTo2dp(terms, score),
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
function poolCenter(items: HnItem[], ctx: RankContext, model?: LogisticModel): number | undefined {
  if (!rankerTrained(model)) return undefined;
  const ps: number[] = [];
  for (const item of items) {
    if (isFiltered(item, ctx)) continue;
    ps.push(predictProba(model!, featureVector(computeFeatures(item, ctx))));
  }
  if (ps.length === 0) return undefined;
  ps.sort((a, b) => a - b);
  const mid = ps.length >> 1;
  return ps.length % 2 ? ps[mid] : (ps[mid - 1] + ps[mid]) / 2;
}

/**
 * Augment a context with the pool-derived `learnedCenter`. Callers that ALSO explain items (the feed
 * builds a "Why #N?" trace per visible card) must pass this SAME context to `explainItem`, or the
 * explanation would be centered differently from the score that produced the rank — the exact
 * parts-don't-reconcile failure this whole surface exists to avoid.
 */
export function withPoolCenter(items: HnItem[], ctx: RankContext, model?: LogisticModel): RankContext {
  if (ctx.learnedCenter !== undefined) return ctx;
  const c = poolCenter(items, ctx, model);
  return c === undefined ? ctx : { ...ctx, learnedCenter: c };
}

export function computeForYou(
  items: HnItem[],
  ctx: RankContext,
  model?: LogisticModel
): RankedStory[] {
  // Center the DISPLAYED learned signal on THIS POOL's median prediction, not on the training base
  // rate. The trained weights are dominated by domain/author affinity, which is ~0 for any source
  // the user hasn't engaged with — so the candidate distribution systematically undershoots the
  // training positive-rate, and centering there made EVERY unfamiliar candidate print a negative
  // red bar (measured: 0/20 positive, a story the model knew nothing about read -0.675 of a nominal
  // -1) while the tooltip promised "a typical story reads ~0". The pool median restores that
  // promise. It is one constant for the whole pass, so ranking is UNCHANGED — only the sign the
  // reader sees becomes meaningful.
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
