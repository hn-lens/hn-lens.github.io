import { fetchWithTimeout } from './http';
import type { AlgoliaHit, AlgoliaItem, AlgoliaSearchResult, HnItem } from '../../types';

const BASE = 'https://hn.algolia.com/api/v1';

/**
 * Map an Algolia hit to the app's HnItem shape. Shared by search results AND the For-You candidate
 * pool. Maps EVERY field the feed uses: `children` → `kids` (so the top-comment preview, which keys
 * off `kids`, works on the Algolia-sourced feed) and `story_text` → `text` (so an Ask/text post keeps
 * its body). `type` is derived from `_tags` rather than hardcoded — a job hit typed 'story' with a
 * null score slips past the min-points filter, so mistyping matters.
 */
export function hitToItem(h: AlgoliaHit): HnItem {
  const type = h._tags?.includes('job') ? 'job' : h._tags?.includes('poll') ? 'poll' : 'story';
  return {
    id: Number(h.objectID),
    title: h.title,
    url: h.url,
    by: h.author,
    score: h.points,
    descendants: h.num_comments,
    time: h.created_at_i,
    kids: h.children,
    text: h.story_text,
    type,
  };
}

/**
 * Full nested comment tree for a story in a single request.
 *
 * By default a hung/failed fetch returns null so BACKGROUND callers (a retrain's term-profile
 * enrichment) tolerate a missing tree and never stall. Pass `{ strict: true }` from the DISCUSSION
 * view so a network failure THROWS instead — otherwise the view can't tell "fetch failed" from "no
 * comments" and shows a misleading "No comments yet." over an outage (the outage-vs-empty rule).
 */
export async function fetchItemTree(id: number, opts?: { strict?: boolean }): Promise<AlgoliaItem | null> {
  try {
    const res = await fetchWithTimeout(`${BASE}/items/${id}`);
    if (!res.ok) {
      if (opts?.strict) throw new Error(`Comment tree failed: ${res.status}`);
      return null;
    }
    return (await res.json()) as AlgoliaItem;
  } catch (err) {
    if (opts?.strict) throw err;
    return null;
  }
}

export interface SearchParams {
  query?: string;
  tags?: string; // e.g. "story", "front_page", "comment,author_pg", "(story,poll)"
  numericFilters?: string; // e.g. "points>100,created_at_i>1700000000"
  page?: number;
  hitsPerPage?: number;
  byDate?: boolean; // search_by_date (newest-first) vs search (relevance)
}

export async function search(params: SearchParams): Promise<AlgoliaSearchResult> {
  const endpoint = params.byDate ? 'search_by_date' : 'search';
  const qs = new URLSearchParams();
  // Algolia rejects overly long queries (HTTP 400); cap defensively.
  if (params.query) qs.set('query', params.query.slice(0, 400));
  if (params.tags) qs.set('tags', params.tags);
  if (params.numericFilters) qs.set('numericFilters', params.numericFilters);
  qs.set('page', String(params.page ?? 0));
  qs.set('hitsPerPage', String(params.hitsPerPage ?? 30));

  const res = await fetchWithTimeout(`${BASE}/${endpoint}?${qs.toString()}`);
  // Throw on a real error (or a timeout abort) so the search UI can show an error/Retry
  // state instead of an empty "No results" — a swallowed error erases the difference between
  // "nothing found" and "search is broken" (the same fix `fetchList` got for feeds).
  if (!res.ok) throw new Error(`Search failed: ${res.status}`);
  return (await res.json()) as AlgoliaSearchResult;
}
