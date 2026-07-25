/**
 * fetch() with a hard timeout so a hung or unreachable HN endpoint can't stall a caller
 * indefinitely — e.g. the For-You cold-start `Promise.all` over the candidate pool, or a
 * background retrain that enriches the term profile from comment trees. Aborts after `ms`
 * and lets the AbortError propagate; each caller decides whether a failure means
 * "null/empty" (item/tree fetches — the pool tolerates gaps) or "outage" (list/search
 * fetches — surface an error/Retry state). Mirrors the reader proxy's bounded fetch.
 */
export async function fetchWithTimeout(url: string, ms = 10000, init?: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}
