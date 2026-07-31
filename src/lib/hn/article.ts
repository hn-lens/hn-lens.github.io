import { kvGet, kvSet } from '../db';
import { htmlToText } from '../html';
import { queryClient } from '../query';
import type { HnItem } from '../../types';

// Opt-in linked-article text. Browsers can't read cross-site pages directly
// (CORS), so we route through FREE, no-signup, CORS-enabled proxies — tried in
// order so the feature keeps working if one is rate-limited or down. This is the
// ONE non-local feature: the article URL is sent to whichever proxy answers.
// (Verified free + keyless + `Access-Control-Allow-Origin: *` when added.)
export interface ReaderProxy {
  name: string;
  build: (url: string) => string;
}

export const READER_PROXIES: ReaderProxy[] = [
  { name: 'AllOrigins', build: (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}` },
  { name: 'cors.eu.org', build: (u) => `https://cors.eu.org/${u}` },
  { name: 'codetabs', build: (u) => `https://api.codetabs.com/v1/proxy/?quest=${u}` },
];

const MIN_USABLE = 200; // shorter than this ⇒ almost certainly an error/blank page
const PROXY_TIMEOUT_MS = 8000; // bound each proxy attempt so a hung/unreachable proxy can't stall

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

/**
 * Fetch linked-article body text via the free proxy chain. Returns the cleaned text
 * (bounded) plus the NAME of the proxy that served it, so the UI can show where the
 * text came from. `{text:'',proxy:''}` if every proxy fails. Successful results are
 * cached in kv (with the proxy); failures are NOT cached, so a later attempt can
 * succeed once a service recovers.
 */
export async function fetchArticleBody(item: HnItem, proxies: ReaderProxy[] = READER_PROXIES): Promise<ArticleFetch> {
  if (!item.url) return { text: '', proxy: '' };
  const cached = await getCachedArticle(item.id);
  if (cached && cached.text) return cached;

  for (const proxy of proxies) {
    // Bound each attempt: a free proxy can hang or be unreachable, and without a
    // timeout the whole chain (and anything awaiting it) stalls indefinitely.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), PROXY_TIMEOUT_MS);
    try {
      const res = await fetch(proxy.build(item.url), { headers: { Accept: 'text/html,text/plain' }, signal: ctrl.signal });
      if (!res.ok) continue;
      const text = htmlToText(await res.text()); // preserves paragraph breaks
      if (text.replace(/\s+/g, ' ').trim().length >= MIN_USABLE) {
        const value: CachedArticle = { text: text.slice(0, 5000), proxy: proxy.name };
        await kvSet(cacheKey(item.id), value);
        // Refresh any mounted card query so the "Article text" link appears — whether
        // this fetch came from a click, the speculative prefetch, or a summary.
        queryClient.invalidateQueries({ queryKey: ['articleText', item.id] });
        return value;
      }
    } catch {
      // timed out / network error / aborted — try the next proxy
    } finally {
      clearTimeout(timer);
    }
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
  try {
    for (const it of items) {
      if (fetched >= max) break;
      if (!it.url) continue;
      const cached = await getCachedArticle(it.id);
      if (cached?.text) continue; // already have it — no network, no throttle
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
