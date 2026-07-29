// Content-based personalization signals for the learned ranker.
//
// Two signals, both derived from your history and fed into the logistic model:
//   • relevance  — cosine similarity of a story's (title + HN self-text) embedding
//                  to the centroid of stories you engaged with.
//   • termAffinity — contrastive lexical overlap of a story's title terms against a
//                  term profile built from the TITLES + top COMMENTS of threads you
//                  engaged with, minus a term profile from stories you hid.
//
// Both support **leave-one-out**: when scoring a training example, that item is
// removed from the profile it belongs to, so a story is never compared against a
// profile that already contains it (which would leak the label).
//
// "content" here is titles, HN self-text, and HN comments (all CORS-fetchable), PLUS linked
// article text when the opt-in reader proxy is enabled — the one path past the article-body CORS
// wall. Article terms are read from cache only (see `enrichmentTermsFor`).
import { db, kvGet, kvSet } from '../db';
import { getCachedItems } from '../hn/client';
import { getEngagedItemIds, getDislikedItemIds } from '../interactions';
import { fetchItemTree } from '../hn/algolia';
import { getCachedArticle } from '../hn/article';
import { ensureItemEmbeddings, dot, normalize } from '../models/embeddings';
import { stripHtml } from '../html';
import type { AlgoliaComment, HnItem } from '../../types';

const STOP = new Set(
  ('the a an and or but if then else of to in on for with from by at as is are was were be been being ' +
    'this that these those it its you your we our they their he she his her my his has have had will would ' +
    'can could should may might must not no yes do does did done about into over under out up down more most ' +
    'less than so such very just also how why what when where who which whom new use used using vs via i me ' +
    'they them our your his her show ask tell hn get got make made one two how-to who’s')
    .split(/\s+/)
);

/** Distinct, lowercased, stop-word-filtered content terms from text. */
export function terms(text?: string): string[] {
  const t = stripHtml(text || '').toLowerCase();
  const out = new Set<string>();
  for (const raw of t.split(/[^a-z0-9+#]+/)) {
    const w = raw.replace(/^[+#]+|[+#]+$/g, '');
    if (w.length >= 3 && w.length <= 24 && !STOP.has(w) && !/^\d+$/.test(w)) out.add(w);
  }
  return [...out];
}

export interface ContentProfile {
  model: string;
  hasEmbeddings: boolean;
  // lexical (document-frequency)
  likedDf: Map<string, number>;
  dislikedDf: Map<string, number>;
  likedDocN: number;
  dislikedDocN: number;
  likedTermsById: Map<number, string[]>; // for leave-one-out
  dislikedTermsById: Map<number, string[]>;
  // embedding centroid (unit vecs; keep the sum + per-item vec for leave-one-out)
  likedVecSum: number[] | null;
  likedN: number;
  likedVecById: Map<number, number[]>;
  withComments: boolean;
}

// CACHE-ONLY: this runs on every engagement (the ['content'] query is invalidated there), so it
// must not fetch. See `getCachedItems`.
async function itemsFor(ids: number[]): Promise<HnItem[]> {
  return getCachedItems(ids);
}

/** Flatten a comment tree into cleaned text snippets (>= 40 chars). */
function commentTexts(children: AlgoliaComment[], out: string[] = []): string[] {
  for (const c of children) {
    const t = stripHtml(c.text);
    if (t && t.length >= 40) out.push(t);
    if (c.children?.length) commentTexts(c.children, out);
  }
  return out;
}

/** Top comment terms per engaged item (bounded + cached), for the term profile. */
async function commentTermsFor(items: HnItem[], maxItems = 20, maxComments = 6): Promise<Map<number, string[]>> {
  const map = new Map<number, string[]>();
  for (const it of items.slice(0, maxItems)) {
    const cacheKey = `cterms:${it.id}`;
    try {
      const cached = await kvGet<string[]>(cacheKey);
      if (cached) {
        map.set(it.id, cached);
        continue;
      }
      const tree = await fetchItemTree(it.id);
      if (!tree) continue;
      const top = commentTexts(tree.children)
        .sort((a, b) => b.length - a.length)
        .slice(0, maxComments);
      const ct = [...new Set(top.flatMap((t) => terms(t)))];
      map.set(it.id, ct);
      await kvSet(cacheKey, ct);
    } catch {
      // best-effort — comments are optional enrichment
    }
  }
  return map;
}

/** Extra content terms per engaged item: top comments, and (opt-in) linked-article text.
 *
 *  ARTICLE terms are cache-only — never fetched here, because a hung reader proxy would stall the
 *  background retrain. COMMENT terms are NOT cache-only: with `withComments`, `commentTermsFor`
 *  fetches up to 20 comment trees sequentially on a cache miss, each bounded by `fetchWithTimeout`. */
async function enrichmentTermsFor(
  items: HnItem[],
  opts: { withComments?: boolean; fetchArticle?: boolean }
): Promise<Map<number, string[]>> {
  const comments = opts.withComments ? await commentTermsFor(items) : new Map<number, string[]>();
  const map = new Map<number, string[]>();
  for (const it of items) {
    const set = new Set<string>(comments.get(it.id) ?? []);
    if (opts.fetchArticle) {
      for (const t of await cachedArticleTerms(it.id)) set.add(t); // cache only — no network
    }
    if (set.size) map.set(it.id, [...set]);
  }
  return map;
}

/** Build the content profile from your engaged (liked) and hidden (disliked) history. */
export async function buildContentProfile(
  model: string,
  opts: { withComments?: boolean; embeddings?: boolean; fetchArticle?: boolean } = {}
): Promise<ContentProfile> {
  const [likedIds, dislikedIds] = await Promise.all([getEngagedItemIds(80), getDislikedItemIds(80)]);
  const [likedItems, dislikedItems] = await Promise.all([itemsFor(likedIds), itemsFor(dislikedIds)]);

  const likedDf = new Map<string, number>();
  const dislikedDf = new Map<string, number>();
  const likedTermsById = new Map<number, string[]>();
  const dislikedTermsById = new Map<number, string[]>();
  const extraTerms = await enrichmentTermsFor(likedItems, {
    withComments: opts.withComments,
    fetchArticle: opts.fetchArticle,
  });

  for (const it of likedItems) {
    const arr = [...new Set([...terms(it.title), ...terms(it.text), ...(extraTerms.get(it.id) ?? [])])];
    likedTermsById.set(it.id, arr);
    for (const t of arr) likedDf.set(t, (likedDf.get(t) ?? 0) + 1);
  }
  for (const it of dislikedItems) {
    const arr = [...new Set([...terms(it.title), ...terms(it.text)])];
    dislikedTermsById.set(it.id, arr);
    for (const t of arr) dislikedDf.set(t, (dislikedDf.get(t) ?? 0) + 1);
  }

  let likedVecSum: number[] | null = null;
  let likedN = 0;
  const likedVecById = new Map<number, number[]>();
  let hasEmbeddings = false;
  if (opts.embeddings && model && likedItems.length) {
    try {
      await ensureItemEmbeddings(model, likedItems, { withArticle: opts.fetchArticle });
      for (const it of likedItems) {
        const row = await db.embeddings.get(it.id);
        if (!row || row.model !== model) continue;
        likedVecById.set(it.id, row.vec);
        if (!likedVecSum) likedVecSum = new Array(row.vec.length).fill(0);
        for (let i = 0; i < row.vec.length; i++) likedVecSum[i] += row.vec[i];
        likedN++;
      }
      hasEmbeddings = likedN > 0;
    } catch {
      hasEmbeddings = false;
    }
  }

  return {
    model, hasEmbeddings,
    likedDf, dislikedDf, likedDocN: likedItems.length, dislikedDocN: dislikedItems.length,
    likedTermsById, dislikedTermsById,
    likedVecSum, likedN, likedVecById,
    withComments: !!opts.withComments,
  };
}

/** Cached article-body terms for an item (NO network — only reads what's already
 *  been fetched). Tokenized terms are memoized under `aterms:<id>`. */
export async function cachedArticleTerms(id: number): Promise<string[]> {
  const memo = await kvGet<string[]>(`aterms:${id}`);
  if (memo) return memo;
  const art = await getCachedArticle(id);
  if (!art?.text) return [];
  const t = terms(art.text);
  await kvSet(`aterms:${id}`, t);
  return t;
}

/** Contrastive lexical affinity of a story's title (+ optional article-body terms) to
 *  the liked vs disliked term profile (−1..1). Passing `extra` (the candidate's own
 *  fetched article-body terms) makes the story's FULL TEXT — not just its title —
 *  influence the score. */
export function termAffinity(item: HnItem, p: ContentProfile, excludeId?: number, extra?: string[]): number {
  const ts = extra && extra.length ? [...new Set([...terms(item.title), ...extra])] : terms(item.title);
  if (!ts.length) return 0;
  const exLiked = excludeId != null ? p.likedTermsById.get(excludeId) : undefined;
  const exDis = excludeId != null ? p.dislikedTermsById.get(excludeId) : undefined;
  const exLikedSet = exLiked ? new Set(exLiked) : null;
  const exDisSet = exDis ? new Set(exDis) : null;
  const likedN = p.likedDocN - (exLiked ? 1 : 0);
  const disN = p.dislikedDocN - (exDis ? 1 : 0);
  let liked = 0;
  let disliked = 0;
  for (const t of ts) {
    let ldf = p.likedDf.get(t) ?? 0;
    if (exLikedSet?.has(t)) ldf -= 1;
    let ddf = p.dislikedDf.get(t) ?? 0;
    if (exDisSet?.has(t)) ddf -= 1;
    if (likedN > 0 && ldf > 0) liked += ldf / likedN;
    if (disN > 0 && ddf > 0) disliked += ddf / disN;
  }
  return Math.tanh(((liked - disliked) / ts.length) * 3);
}

/** Cosine similarity of an item vector to the liked centroid, with optional leave-one-out (0..1). */
export function simLiked(vec: number[] | undefined, p: ContentProfile, excludeId?: number): number {
  if (!vec || !p.likedVecSum || p.likedN === 0) return 0;
  let sum = p.likedVecSum;
  let n = p.likedN;
  if (excludeId != null && p.likedVecById.has(excludeId)) {
    const ev = p.likedVecById.get(excludeId)!;
    sum = p.likedVecSum.map((x, i) => x - ev[i]);
    n -= 1;
  }
  if (n <= 0) return 0;
  return Math.max(0, dot(normalize(vec), normalize(sum)));
}

/**
 * Content signals (relevance + termAffinity) for a set of items.
 *
 * Pass `loo: true` whenever an item might be IN the profile it is being scored against — which is
 * both training AND serving. Without it an engaged item scores highly for resembling itself, which
 * is self-reinforcement rather than taste: it measurably lifted a saved story from rank 5 to rank 1.
 * Excluding the candidate is a no-op for anything not already in the profile.
 */
export async function computeContentSignals(
  model: string,
  items: HnItem[],
  profile: ContentProfile,
  opts: { loo?: boolean; articleTerms?: boolean } = {}
): Promise<{ simById: Map<number, number>; termById: Map<number, number> }> {
  const simById = new Map<number, number>();
  const termById = new Map<number, number>();
  const vecById = new Map<number, number[]>();
  if (profile.hasEmbeddings && model) {
    try {
      await ensureItemEmbeddings(model, items, { withArticle: opts.articleTerms });
      for (const it of items) {
        const row = await db.embeddings.get(it.id);
        if (row && row.model === model) vecById.set(it.id, row.vec);
      }
    } catch {
      // embeddings optional
    }
  }
  // Fold each candidate's OWN cached article-body terms into its affinity so the
  // ranker considers the full text, not just the title (reads cache only — no fetch).
  const artTermsById = new Map<number, string[]>();
  if (opts.articleTerms) {
    for (const it of items) {
      const at = await cachedArticleTerms(it.id);
      if (at.length) artTermsById.set(it.id, at);
    }
  }
  for (const it of items) {
    const ex = opts.loo ? it.id : undefined;
    termById.set(it.id, termAffinity(it, profile, ex, artTermsById.get(it.id)));
    if (profile.hasEmbeddings) simById.set(it.id, simLiked(vecById.get(it.id), profile, ex));
  }
  return { simById, termById };
}
