import type { HnItem, RankWeights } from '../../types';
import type { Affinities } from '../interactions';
import { domainOf, hoursSince } from '../time';

export interface RankContext {
  weights: RankWeights;
  affinities: Affinities;
  followedDomains: Set<string>;
  followedUsers: Set<string>;
  mutedDomains: Set<string>;
  mutedUsers: Set<string>;
  keywordsBoost: string[];
  keywordsMute: string[];
  minPoints: number;
  simById?: Map<number, number>; // embedding similarity to liked profile, 0..1
  termById?: Map<number, number>; // contrastive title/comment term affinity, -1..1
  learnedById?: Map<number, number>; // logistic probability, 0..1
  // The reference point the DISPLAYED learned signal is centered on (see `learnedCenter` in
  // strategies.ts). Set per ranking pass from the candidate pool; absent for one-off scoring.
  learnedCenter?: number;
}

export interface FeatureSet {
  domain: string;
  popularity: number; // 0..1
  recency: number; // 0..1
  discussion: number; // 0..1
  domainAffinity: number; // -1..1
  authorAffinity: number; // -1..1
  followedDomain: boolean;
  followedUser: boolean;
  boostKeyword: string | null;
  relevance: number; // 0..1 — embedding similarity to liked profile
  termAffinity: number; // -1..1 — title/comment term overlap (liked vs disliked)
  learned: number; // 0..1
  // Distinct positively-engaged items for this story's author/domain (for honest
  // "often" wording in the why-reason). NOT part of featureVector — display only.
  authorEngagedN: number;
  domainEngagedN: number;
}

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

/** Whole-token, case-insensitive keyword match (so "ai" doesn't match "rain"). */
export function matchesKeyword(text: string, kw: string): boolean {
  const k = kw.trim();
  if (!k) return false;
  const esc = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${esc}([^a-z0-9]|$)`, 'i').test(text);
}

export function computeFeatures(item: HnItem, ctx: RankContext): FeatureSet {
  const domain = domainOf(item.url);
  const score = item.score ?? 0;
  const comments = item.descendants ?? 0;
  const age = hoursSince(item.time);

  const popularity = clamp01(Math.log1p(score) / Math.log1p(1000));
  const recency = clamp01(Math.exp(-age / 24)); // ~1 fresh, decays over a day+
  const discussion = clamp01(Math.log1p(comments) / Math.log1p(500));

  // LEAVE-ONE-OUT AT SERVE TIME: an item must not be scored on the affinity IT ITSELF generated.
  // Reading a story writes engagement events; those events feed domain/author affinity; that affinity
  // then scores the very same story — so interacting with something PROMOTES it. Measured before this:
  // a genuine read moved a story from rank 10 -> 2, and saving one moved it 12 -> 1, i.e. the feed's
  // top slot filled with the things the reader had just finished with. Training already does exactly
  // this subtraction (`looAffinities`); `perItem` was recorded for it and simply never used here.
  // Only the SCORED item's own contribution is removed — other candidates on the same domain keep the
  // full totals, so "I read three things from this site, show me more" still works. Applying it inside
  // computeFeatures means the scorer and the "Why #N?" explainer share it and cannot disagree.
  const own = ctx.affinities.perItem?.[item.id];
  const ownDom = own && own.domain === domain ? own.dw : 0;
  const ownAuth = own && own.author === item.by ? own.aw : 0;
  const ownCounted = own?.counted ? 1 : 0;
  const domScore = domain ? (ctx.affinities.domains[domain] ?? 0) - ownDom : 0;
  const authScore = item.by ? (ctx.affinities.authors[item.by] ?? 0) - ownAuth : 0;
  const domainAffinity = Math.tanh(domScore / 5);
  const authorAffinity = Math.tanh(authScore / 5);

  const title = item.title ?? '';
  let boostKeyword: string | null = null;
  for (const kw of ctx.keywordsBoost) {
    if (matchesKeyword(title, kw)) {
      boostKeyword = kw;
      break;
    }
  }

  return {
    domain,
    popularity,
    recency,
    discussion,
    domainAffinity,
    authorAffinity,
    followedDomain: !!domain && ctx.followedDomains.has(domain),
    followedUser: !!item.by && ctx.followedUsers.has(item.by),
    boostKeyword,
    relevance: ctx.simById?.get(item.id) ?? 0,
    termAffinity: ctx.termById?.get(item.id) ?? 0,
    learned: ctx.learnedById?.get(item.id) ?? 0.5,
    // Same leave-one-out: "you often read this author" must not be justified by THIS story alone.
    authorEngagedN: item.by ? Math.max(0, (ctx.affinities.authorCounts?.[item.by] ?? 0) - (own?.author === item.by ? ownCounted : 0)) : 0,
    domainEngagedN: domain ? Math.max(0, (ctx.affinities.domainCounts?.[domain] ?? 0) - (own?.domain === domain ? ownCounted : 0)) : 0,
  };
}

/** Fixed-order numeric vector for the logistic ranker. */
// NOTE: the EXPLICIT-preference signals (followedDomain / followedUser / boostKeyword)
// are deliberately NOT learned features. They are user declarations, already applied
// deterministically (with fixed positive weights) in the manual blend's `affinity` term
// (see strategies.ts). Feeding them to the logistic model let it learn a NEGATIVE weight
// for them — because a followed domain's stories show up as impression-negatives when you
// don't click every one — which both double-counts the explicit signal and makes the
// "Why #N?" explainer contradict itself ("you follow this domain, so the model thinks
// you'll skip it"). The learned model should learn from BEHAVIOUR + CONTENT only.
export function featureVector(fs: FeatureSet): number[] {
  return [
    fs.popularity,
    fs.recency,
    fs.discussion,
    fs.domainAffinity,
    fs.authorAffinity,
    fs.relevance,
    fs.termAffinity,
    // Interaction (cross) features — capture non-linear effects while staying linear
    // in the parameters, so the model + explainer remain interpretable.
    fs.popularity * fs.recency, // trending: popular AND fresh
    fs.domainAffinity * fs.discussion, // a domain you like AND that's being discussed
    fs.relevance * fs.termAffinity, // content agreement across embedding + terms
  ];
}

export const FEATURE_DIM = 10;

/** Human-readable labels for the logistic model features, in `featureVector` order. */
export const FEATURE_LABELS: string[] = [
  'Popularity (points)',
  'Recency',
  'Discussion size',
  'Domain affinity',
  'Author affinity',
  'Similar to your reading (embedding)',
  'Title + comment terms',
  'Popular × fresh',
  'Domain affinity × discussion',
  'Embedding × term match',
];

/** Hard filters: returns true if the item should be excluded from the feed. */
export function isFiltered(item: HnItem, ctx: RankContext): boolean {
  if (item.deleted || item.dead) return true;
  const domain = domainOf(item.url);
  if (domain && ctx.mutedDomains.has(domain)) return true;
  if (item.by && ctx.mutedUsers.has(item.by)) return true;
  // Min-points only applies to items whose score is a real points count. HN JOB posts
  // carry a constant score of 1 (not upvotes), so a min-points threshold >=2 would
  // silently empty the entire Jobs feed — exempt them (and any genuinely score-less item).
  // Default minPoints is 0 → never filters here anyway.
  if (ctx.minPoints > 0 && item.type !== 'job' && typeof item.score === 'number' && item.score < ctx.minPoints) return true;
  if (ctx.keywordsMute.length) {
    const title = item.title ?? '';
    if (ctx.keywordsMute.some((kw) => matchesKeyword(title, kw))) return true;
  }
  return false;
}
