import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../lib/db';
import { track } from '../lib/interactions';
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
  return new Set((rows ?? []).map((r) => r.id));
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

export function useHiddenIds(): Set<number> {
  const rows = useLiveQuery(() => db.hidden.toArray(), [], []);
  return new Set((rows ?? []).map((r) => r.id));
}

export async function hideItem(item: HnItem): Promise<void> {
  await db.hidden.put({ id: item.id, ts: Date.now() });
  track({ type: 'hide', itemId: item.id, domain: domainOf(item.url), author: item.by });
}

export async function unhideItem(id: number): Promise<void> {
  await db.hidden.delete(id);
  track({ type: 'unhide', itemId: id });
}

export function useHiddenCount(): number {
  return useLiveQuery(() => db.hidden.count(), [], 0) ?? 0;
}

export async function unhideAll(): Promise<void> {
  await db.hidden.clear();
}

// ---------- Seen (for dimming + "new since last visit") ----------

export function useSeenMap(): Map<number, number> {
  const rows = useLiveQuery(() => db.seen.toArray(), [], []);
  return new Map((rows ?? []).map((r) => [r.id, r.ts]));
}

export async function markSeen(id: number): Promise<void> {
  await db.seen.put({ id, ts: Date.now() });
}

export async function getSeenTs(id: number): Promise<number | undefined> {
  const row = await db.seen.get(id);
  return row?.ts;
}
