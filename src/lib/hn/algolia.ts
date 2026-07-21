import type { AlgoliaItem, AlgoliaSearchResult } from '../../types';

const BASE = 'https://hn.algolia.com/api/v1';

/** Full nested comment tree for a story in a single request. */
export async function fetchItemTree(id: number): Promise<AlgoliaItem | null> {
  const res = await fetch(`${BASE}/items/${id}`);
  if (!res.ok) return null;
  return (await res.json()) as AlgoliaItem;
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

  const res = await fetch(`${BASE}/${endpoint}?${qs.toString()}`);
  // Throw on a real error so the search UI can show an error/Retry state instead of an
  // empty "No results" — a swallowed error erases the difference between "nothing found"
  // and "search is broken" (the same fix `fetchList` got for feeds).
  if (!res.ok) throw new Error(`Search failed: ${res.status}`);
  return (await res.json()) as AlgoliaSearchResult;
}
