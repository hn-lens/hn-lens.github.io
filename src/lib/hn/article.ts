import { kvGet, kvSet } from '../db';
import { htmlToText } from '../html';
import { queryClient } from '../query';
import { PROXIES, proxiedFetch, scoreContent } from './proxy';
import type { HnItem } from '../../types';
import type { ReaderProxy } from './proxy';

// Opt-in linked-article text via the reader-proxy layer (./proxy): this module extracts, grades, and caches the body.
export { PROXIES as READER_PROXIES };
export type { ReaderProxy };

const MIN_USABLE = 200; // shorter ⇒ almost certainly an error/blank page

export interface ArticleFetch {
  text: string; // cleaned, bounded article body ('' if unavailable)
  proxy: string; // NAME of the proxy that served it ('' if none / not fetched)
}

// Cache value shape (was a bare string pre-2026-07). `getCachedArticle` reads both.
interface CachedArticle {
  text: string;
  proxy: string;
}

const cacheKey = (id: number) => `atext:${id}`;

/** Read the cached article text + which proxy fetched it, if present (no network). */
export async function getCachedArticle(id: number): Promise<ArticleFetch | null> {
  const cached = await kvGet<CachedArticle | string>(cacheKey(id));
  if (!cached) return null;
  if (typeof cached === 'string') return { text: cached, proxy: '' }; // legacy entry
  return { text: cached.text ?? '', proxy: cached.proxy ?? '' };
}

/** Fetch linked-article body via the health-ranked proxy chain: returns the cleaned (bounded) text +
 *  the proxy that served it (`{text:'',proxy:''}` if all fail). Successes are cached; failures are not. */
export async function fetchArticleBody(item: HnItem, proxies: ReaderProxy[] = PROXIES): Promise<ArticleFetch> {
  if (!item.url) return { text: '', proxy: '' };
  const cached = await getCachedArticle(item.id);
  if (cached && cached.text) return cached;

  const r = await proxiedFetch<string>(item.url, {
    proxies,
    validate: (html) => {
      const text = htmlToText(html);
      const score = scoreContent(html, text, { title: item.title });
      const ok = text.replace(/\s+/g, ' ').trim().length >= MIN_USABLE && score.ok;
      return { ok, value: text.slice(0, 5000), quality: score.quality, attribution: score.attribution };
    },
  });
  if (r.ok && r.value) {
    const value: CachedArticle = { text: r.value, proxy: r.proxy };
    await kvSet(cacheKey(item.id), value);
    queryClient.invalidateQueries({ queryKey: ['articleText', item.id] });
    return value;
  }
  return { text: '', proxy: '' };
}

/**
 * Fire-and-forget: fetch + cache an article's body when the reader proxy is enabled.
 * Safe to call on a link click — never throws, never blocks the click. A no-op when
 * the feature is off or the text is already cached.
 */
export function prefetchArticleText(item: HnItem, enabled: boolean): void {
  if (!enabled || !item.url) return;
  void fetchArticleBody(item).catch(() => {});
}

let speculativeInFlight = false;

/**
 * Speculatively fetch article bodies for up to `max` items that don't have one
 * cached yet — so the ranker/training have real page content even for stories you
 * haven't clicked. Throttled (one request per `gapMs`) to stay gentle on the free
 * proxies, and single-flight so overlapping feed renders don't pile on. The CALLER
 * must gate this on the `fetchArticleText` opt-in. Returns how many were fetched.
 */
export async function prefetchArticles(items: HnItem[], max = 6, gapMs = 1500): Promise<number> {
  if (speculativeInFlight) return 0;
  speculativeInFlight = true;
  let fetched = 0;
  let attempts = 0;
  try {
    for (const it of items) {
      if (fetched >= max || attempts >= max) break; // bound network ATTEMPTS, not just successes
      if (!it.url) continue;
      const cached = await getCachedArticle(it.id);
      if (cached?.text) continue; // already have it — no network, no throttle
      attempts++;
      const r = await fetchArticleBody(it);
      if (r.text) fetched++;
      await new Promise((res) => setTimeout(res, gapMs)); // be gentle on free proxies
    }
   } finally {
    speculativeInFlight = false;
  }
  return fetched;
}

/** Does the extracted body plausibly belong to the linked story, or is it a cookie-wall / paywall /
 *  unrelated page the proxy returned? Cheap title↔body term-overlap heuristic, shared by every path
 *  that consumes cached article text (summaries, Ask, ranking term-affinity) so an off-topic body is
 *  never fed to the model nor to the ranker. Lives here (not in the lazy llm module) so the ranking
 *  path can import it without pulling in WebLLM. */
export function articleLooksRelevant(title: string, article: string): boolean {
  const STOP = new Set(
    'the a an and or but of to in on for with from by is are was were be been it its this that as at how why what when new show ask hn using use used your you our we they i'.split(' ')
  );
  const words = (t: string) => (t.toLowerCase().match(/[a-z][a-z0-9'-]{2,}/g) ?? []).filter((w) => !STOP.has(w));
  const titleWords = [...new Set(words(title))];
  // Nothing distinctive in the title (very short or all stopwords) ⇒ nothing to check against, so do
  // not reject: a false negative here silently discards a perfectly good article.
  if (titleWords.length < 3) return true;
  const body = new Set(words(article).slice(0, 4000));
  const hits = titleWords.filter((w) => body.has(w)).length;
  return hits / titleWords.length >= 0.25;
}
