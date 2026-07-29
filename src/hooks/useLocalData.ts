import { useMemo } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../lib/db';
import { track } from '../lib/interactions';
import { unmarkHiddenInSession, clearHiddenStubs } from '../lib/feedSession';
import { domainOf } from '../lib/time';
import type { HnItem } from '../types';

// ---------- Saved ----------

export function useSavedItems(): HnItem[] {
  const rows = useLiveQuery(() => db.saved.orderBy('ts').reverse().toArray(), [], []);
  return (rows ?? []).map((r) => r.item);
}

export function useIsSaved(id: number): boolean {
  const row = useLiveQuery(() => db.saved.get(id), [id]);
  return !!row;
}

export function useSavedIds(): Set<number> {
  const rows = useLiveQuery(() => db.saved.toArray(), [], []);
  return useMemo(() => new Set((rows ?? []).map((r) => r.id)), [rows]);
}

export async function toggleSaved(item: HnItem): Promise<void> {
  const existing = await db.saved.get(item.id);
  if (existing) {
    await db.saved.delete(item.id);
    track({ type: 'unsave', itemId: item.id, domain: domainOf(item.url), author: item.by });
  } else {
    await db.saved.put({ id: item.id, item, ts: Date.now() });
    track({ type: 'save', itemId: item.id, domain: domainOf(item.url), author: item.by });
  }
}

// ---------- Hidden ----------

/**
 * NOTE the `useMemo`: these derived collections MUST be referentially stable. Returning a fresh
 * `Set`/`Map` on every render silently defeats every downstream memo — `useFeed`'s `cards` memo
 * depends on `hidden`, so a new identity each render re-derived every card object (and fresh
 * `reasons: []` literals), which changed StoryCard's props and made `memo(StoryCard)` never bail
 * out. The feed's 30s "updated Xm ago" tick then re-rendered EVERY card: measured at 4x CPU
 * throttle with an auto-loaded 75-card list, a 1.5-4.6s main-thread lockup every 30 seconds while
 * the user was doing nothing. `useLiveQuery` only returns a new array when the data actually
 * changes, so `[rows]` is the correct dependency.
 */
export function useHiddenIds(): Set<number> {
  const rows = useLiveQuery(() => db.hidden.toArray(), [], []);
  return useMemo(() => new Set((rows ?? []).map((r) => r.id)), [rows]);
}

export async function hideItem(item: HnItem): Promise<void> {
  await db.hidden.put({ id: item.id, ts: Date.now() });
  track({ type: 'hide', itemId: item.id, domain: domainOf(item.url), author: item.by });
}

// Pass the item (when the caller has it) so the `unhide` event carries the SAME domain/author as the
// `hide` it reverses — that's what lets its +2.5 weight cancel the hide's −2.5 in computeAffinities
// and restore the story's original rank. Every caller passes it today, including HiddenDialog (an
// earlier version of this note cited that as the exception; it is not one). The residual case is a
// story missing from `db.items`, where the item cannot be recovered to pass: it still un-hides, and
// only the affinity cancellation is lost.
export async function unhideItem(id: number, item?: { url?: string; by?: string }): Promise<void> {
  await db.hidden.delete(id);
  // Clear the in-session "Hidden — Restore" placeholder too, so EVERY un-hide path (feed Restore,
  // the Hidden dialog, Settings bulk) agrees. Without this, un-hiding from the dialog left the feed
  // still rendering the stub while search showed the story normally.
  unmarkHiddenInSession(id);
  track({ type: 'unhide', itemId: id, domain: item ? domainOf(item.url) : undefined, author: item?.by });
}

export function useHiddenCount(): number {
  return useLiveQuery(() => db.hidden.count(), [], 0) ?? 0;
}

/**
 * Bulk un-hide. Must emit the same `unhide` EVENTS as `unhideItem`, not just empty the table:
 * "hidden" is derived from hide/unhide event timestamps, and the hide also wrote a -2.5 affinity
 * plus a disliked-content entry. Clearing the table alone un-hid the stories while leaving the
 * learned downvote in place, so they came back BURIED and kept poisoning the content profile — the
 * reversal was only half-applied. The single-item path was fixed earlier; these bulk paths are its
 * siblings and were missed. Domain/author are recovered from the item cache where possible so the
 * +2.5 actually cancels the -2.5 it reverses.
 */
/** Clear every saved story, emitting the `unsave` events that reverse each save's affinity. */
export async function unsaveAll(): Promise<void> {
  const rows = await db.saved.toArray();
  await db.saved.clear();
  // ONE bulk read, not one round-trip per row (same reason as getCachedItems).
  const cached = await db.items.bulkGet(rows.map((r) => r.id));
  rows.forEach((r, i) => {
    const item = cached[i]?.item;
    track({ type: 'unsave', itemId: r.id, domain: domainOf(item?.url), author: item?.by });
  });
}

export async function unhideAll(): Promise<void> {
  const rows = await db.hidden.toArray();
  await db.hidden.clear();
  clearHiddenStubs(); // un-hiding everything leaves no placeholders on any feed
  const cached = await db.items.bulkGet(rows.map((r) => r.id));
  rows.forEach((r, i) => {
    const item = cached[i]?.item;
    track({ type: 'unhide', itemId: r.id, domain: domainOf(item?.url), author: item?.by });
  });
}

// ---------- Interaction signals count ----------

/** Live total count of recorded interaction signals (db.events). A live query so it stays
 *  fresh as you scroll/read (impressions, dwell, etc. write events) — not a staleTime'd
 *  snapshot that reads 0 while signals accrue. */
export function useEventCount(): number {
  return useLiveQuery(() => db.events.count(), [], 0) ?? 0;
}

// ---------- Seen (for dimming + "new since last visit") ----------

export function useSeenMap(): Map<number, number> {
  const rows = useLiveQuery(() => db.seen.toArray(), [], []);
  return useMemo(() => new Map((rows ?? []).map((r) => [r.id, r.ts] as const)), [rows]);
}

export async function markSeen(id: number): Promise<void> {
  await db.seen.put({ id, ts: Date.now() });
}

export async function getSeenTs(id: number): Promise<number | undefined> {
  const row = await db.seen.get(id);
  return row?.ts;
}
