// Read-time (dwell) tracking. Article links open in a new tab, so we can't watch
// the article directly — but when the user leaves this tab and comes back, the
// time it was hidden ≈ time spent reading. A quick bounce back therefore becomes
// a weak/negative signal, a long read a strong positive (see interactions.ts).
import { track } from './interactions';
import { domainOf } from './time';
import type { HnItem } from '../types';

let pending: { id: number; domain?: string; author?: string; at: number } | null = null;

/** Call when the user opens an article in a new tab — starts the read timer. */
export function markArticleOpen(item: HnItem): void {
  pending = { id: item.id, domain: domainOf(item.url), author: item.by, at: Date.now() };
}

function recordReturn(): void {
  if (!pending) return;
  const ms = Date.now() - pending.at;
  const p = pending;
  pending = null;
  // Ignore implausible durations: an instant refocus (noise) or an overnight tab.
  if (ms < 800 || ms > 30 * 60_000) return;
  track({ type: 'dwell', itemId: p.id, domain: p.domain, author: p.author, value: ms });
}

let started = false;
/** Wire up tab blur→return detection once, at app startup. */
export function initDwellTracking(): void {
  if (started || typeof document === 'undefined') return;
  started = true;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') recordReturn();
  });
  window.addEventListener('focus', recordReturn);
}
