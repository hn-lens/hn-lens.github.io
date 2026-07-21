import type { FeedKind, HnItem, HnUser } from '../../types';

const BASE = 'https://hacker-news.firebaseio.com/v0';

const LIST_ENDPOINT: Record<Exclude<FeedKind, 'foryou' | 'read'>, string> = {
  top: 'topstories',
  new: 'newstories',
  best: 'beststories',
  ask: 'askstories',
  show: 'showstories',
  job: 'jobstories',
};

export async function fetchItem(id: number): Promise<HnItem | null> {
  const res = await fetch(`${BASE}/item/${id}.json`);
  if (!res.ok) return null;
  return (await res.json()) as HnItem | null;
}

export async function fetchUser(id: string): Promise<HnUser | null> {
  const res = await fetch(`${BASE}/user/${encodeURIComponent(id)}.json`);
  if (!res.ok) return null;
  return (await res.json()) as HnUser | null;
}

export async function fetchList(kind: Exclude<FeedKind, 'foryou' | 'read'>): Promise<number[]> {
  const res = await fetch(`${BASE}/${LIST_ENDPOINT[kind]}.json`);
  // Throw on a real server/network error so callers can distinguish an OUTAGE (→ show
  // an error/Retry state) from a legitimately EMPTY list (→ show the empty state). A
  // null body is a valid empty list, not an error.
  if (!res.ok) throw new Error(`HN list "${kind}" failed: ${res.status}`);
  return ((await res.json()) as number[]) ?? [];
}

export async function fetchMaxItem(): Promise<number> {
  const res = await fetch(`${BASE}/maxitem.json`);
  if (!res.ok) return 0;
  return ((await res.json()) as number) ?? 0;
}
