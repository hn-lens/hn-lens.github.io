import { db } from './db';
import { getItem } from './hn/client';
import { domainOf } from './time';
import { usePrefs } from './prefs';
import { isFiltered } from './ranking/features';
import type { RankContext } from './ranking/features';
import type { HnItem, InteractionEvent, InteractionType } from '../types';

// Event types that represent real engagement (worth (re)training on).
export const ENGAGEMENT_TYPES = new Set<InteractionType>([
  'open_link',
  'open_comments',
  'save',
  'upvote_out',
  'summarize',
  'hide',
  'dwell',
]);

const engagementListeners = new Set<() => void>();
/** Subscribe to engagement events (used by the background auto-trainer). */
export function onEngagement(cb: () => void): () => void {
  engagementListeners.add(cb);
  return () => engagementListeners.delete(cb);
}

export function track(ev: Omit<InteractionEvent, 'id' | 'ts'>): void {
  void db.events.add({ ...ev, ts: Date.now() }).catch(() => undefined);
  if (ENGAGEMENT_TYPES.has(ev.type)) engagementListeners.forEach((cb) => cb());
}

function fieldsFromItem(item: HnItem): Pick<InteractionEvent, 'itemId' | 'domain' | 'author'> {
  return { itemId: item.id, domain: domainOf(item.url), author: item.by };
}

export function trackForItem(type: InteractionType, item: HnItem, extra?: Partial<InteractionEvent>): void {
  track({ type, ...fieldsFromItem(item), ...extra });
}

/**
 * Record time spent ON A DISCUSSION (in-app, drawer or /item). Only a genuine STAY
 * (>= BOUNCE_MS) is recorded — a quick glance/summarize-and-leave records nothing,
 * so it neither marks the item read (getReadItemIds) nor adds affinity. Mirrors the
 * article dwell model for the "opened the post and didn't return immediately" rule.
 */
export function trackDiscussionDwell(itemId: number, ms: number, item?: { url?: string; by?: string }): void {
  if (ms < BOUNCE_MS || ms > 30 * 60_000) return;
  track({ type: 'dwell', itemId, domain: item ? domainOf(item.url) : undefined, author: item?.by, value: ms, meta: { where: 'comments' } });
}

// ---------- Behavioral affinities (learned from events) ----------

const SIGNAL_WEIGHT: Partial<Record<InteractionType, number>> = {
  open_link: 1,
  open_comments: 0.8,
  save: 2,
  unsave: -1,
  upvote_out: 2.5,
  summarize: 0.5,
  follow_domain: 3,
  unfollow_domain: -1.5,
  follow_user: 3,
  unfollow_user: -1.5,
  hide: -2.5,
  impression: -0.02, // very mild fatigue for repeatedly-shown-but-ignored
};

export interface Affinities {
  domains: Record<string, number>;
  authors: Record<string, number>;
  // Distinct POSITIVELY-engaged items per domain/author — lets the "why" reason say
  // "often" only for a genuine habit (≥2 different stories), not one deeply-read story
  // whose dwell alone pushes the affinity score high.
  domainCounts: Record<string, number>;
  authorCounts: Record<string, number>;
}

/** Below this, a return-to-tab counts as a bounce (clicked but didn't read). */
export const BOUNCE_MS = 8_000;
export const isBounce = (ms?: number): boolean => (ms ?? 0) > 0 && (ms ?? 0) < BOUNCE_MS;

/** Turn a dwell (ms on the article) into a signal weight: bounce → negative,
 * longer reads → increasingly positive (capped). */
export function dwellSignal(ms = 0): number {
  if (ms <= 0) return 0;
  if (ms < BOUNCE_MS) return -0.6; // quick bounce back = weak negative
  return Math.min(2.5, (ms / 60_000) * 2); // ~30s → +1, 60s → +2, 75s+ → +2.5
}

export async function computeAffinities(): Promise<Affinities> {
  const events = await db.events.orderBy('ts').reverse().limit(3000).toArray();
  // Muted domains/users are hard-filtered from the feed; don't let past
  // engagement with them leak back into learned affinity either.
  const { mutedDomains, mutedUsers } = usePrefs.getState();
  const mutedD = new Set(mutedDomains);
  const mutedU = new Set(mutedUsers);
  const domains: Record<string, number> = {};
  const authors: Record<string, number> = {};
  const domainItems = new Map<string, Set<number>>(); // distinct positively-engaged items
  const authorItems = new Map<string, Set<number>>();
  const noteItem = (map: Map<string, Set<number>>, key: string, id?: number) => {
    if (!id) return;
    let s = map.get(key);
    if (!s) map.set(key, (s = new Set()));
    s.add(id);
  };
  for (const e of events) {
    const w = e.type === 'dwell' ? dwellSignal(e.value) : SIGNAL_WEIGHT[e.type] ?? 0;
    if (!w) continue;
    if (e.domain && !mutedD.has(e.domain)) {
      domains[e.domain] = (domains[e.domain] ?? 0) + w;
      if (w > 0) noteItem(domainItems, e.domain, e.itemId);
    }
    if (e.author && !mutedU.has(e.author)) {
      authors[e.author] = (authors[e.author] ?? 0) + w;
      if (w > 0) noteItem(authorItems, e.author, e.itemId);
    }
  }
  const domainCounts: Record<string, number> = {};
  for (const [d, s] of domainItems) domainCounts[d] = s.size;
  const authorCounts: Record<string, number> = {};
  for (const [a, s] of authorItems) authorCounts[a] = s.size;
  return { domains, authors, domainCounts, authorCounts };
}

const ENGAGED_TYPES: InteractionType[] = [
  'open_link',
  'open_comments',
  'save',
  'upvote_out',
  'summarize',
];

/** Recent items the user positively engaged with — used to build the embedding profile. */
export async function getEngagedItemIds(limit = 200): Promise<number[]> {
  const events = await db.events
    .where('type')
    .anyOf(ENGAGED_TYPES as string[])
    .toArray();
  events.sort((a, b) => b.ts - a.ts);
  const ids: number[] = [];
  const seen = new Set<number>();
  for (const e of events) {
    if (e.itemId && !seen.has(e.itemId)) {
      seen.add(e.itemId);
      ids.push(e.itemId);
      if (ids.length >= limit) break;
    }
  }
  return ids;
}

/**
 * Recently READ stories (title + url) for the sidebar "Recently read" panel.
 * "Read" is the SAME strict definition as getReadItemIds — you clicked through
 * and consumed it (opened the article without an immediate bounce, or opened the
 * discussion). Saving, summarizing (just a gist), and upvoting are engagement but
 * NOT reading, so they must NOT appear here. (This panel used to call
 * `getEngagedItemIds`, which wrongly listed summarized/saved items as "read".)
 *
 * Hidden stories are excluded so this panel AGREES with the Read tab, which drops
 * hidden items (useFeed's non-For-You filter). Otherwise a read+hidden story shows
 * in the sidebar but not the Read tab — two "read" surfaces disagreeing.
 */
export async function recentRead(limit = 6): Promise<Array<{ id: number; title: string; url?: string }>> {
  const ids = await getReadItemIds(limit * 4); // already newest-first, read-only
  const hidden = new Set((await db.hidden.toArray()).map((r) => r.id));
  // Apply the SAME global hard filters the Read tab applies (useFeed uses `isFiltered`),
  // so the two "read" surfaces AGREE: a read story from a muted domain/user, matching a
  // muted keyword, or below min-points must be absent from BOTH the Read tab and this
  // sidebar panel. Reuses the one `isFiltered` source of truth (no duplicated logic);
  // affinities are irrelevant to filtering, so a minimal context is fine.
  const p = usePrefs.getState();
  const ctx: RankContext = {
    weights: p.weights,
    affinities: { domains: {}, authors: {}, domainCounts: {}, authorCounts: {} },
    followedDomains: new Set(p.followedDomains),
    followedUsers: new Set(p.followedUsers),
    mutedDomains: new Set(p.mutedDomains),
    mutedUsers: new Set(p.mutedUsers),
    keywordsBoost: p.keywordsBoost,
    keywordsMute: p.keywordsMute,
    minPoints: p.minPoints,
  };
  const out: Array<{ id: number; title: string; url?: string }> = [];
  for (const id of ids) {
    if (out.length >= limit) break;
    if (hidden.has(id)) continue; // hidden wins on both read surfaces
    // Fetch-if-missing (getItem checks the cache first) rather than reading db.items
    // directly — otherwise the panel is empty whenever a read item hasn't been
    // pre-cached by a feed load yet (a race after navigating tabs).
    const it = await getItem(id);
    if (!it?.title) continue;
    if (isFiltered(it, ctx)) continue; // muted domain/user/keyword or below min-points
    out.push({ id, title: it.title, url: it.url });
  }
  return out;
}

/**
 * Items the user has actually READ, newest first. "Read" = you consumed the
 * content: opened the article and stayed (didn't quickly bounce), or opened the
 * discussion and stayed. Saving, summarizing, upvoting, and imported history do
 * NOT count. Powers the "Read" tab.
 *
 * READ IS MONOTONIC — once you've genuinely read something it STAYS read. A later
 * quick bounce (e.g. re-clicking a story from the Read tab and closing the tab)
 * must never un-read it (that made items vanish from the Read tab). A bounce only
 * keeps an item OUT if it was never actually read (opened → bounced, nothing else).
 *
 * "Newest first" means newest-READ first — ordered by each item's most recent
 * READ-qualifying event (an article open, or a ≥BOUNCE_MS article/discussion stay),
 * NOT by any event. Merely SEEING a card fires an `impression`, and saving/summarizing
 * fire their own events; sorting by "last event of any type" let a re-seen old story
 * jump to the top of the Read tab, which is wrong. Only reads set the read-order time.
 */
export async function getReadItemIds(limit = 500): Promise<number[]> {
  const events = await db.events.orderBy('ts').reverse().limit(5000).toArray();
  const opened = new Set<number>(); // opened the article link
  const articleBounced = new Set<number>(); // an article open with an immediate bounce back
  const goodArticleRead = new Set<number>(); // opened the article AND stayed (dwell >= BOUNCE_MS)
  const stayedOnDiscussion = new Set<number>(); // opened the discussion AND stayed
  // Read-ORDER timestamps, split so a later bounce RE-open can't reorder a genuine read:
  //   goodReadTs = ts of a GENUINE read (a >= BOUNCE_MS article/discussion stay)
  //   openTs     = ts of a bare open_link (used for order only when there's no good read)
  // Events are newest-first, so the FIRST ts recorded per item is the newest.
  const goodReadTs = new Map<number, number>();
  const openTs = new Map<number, number>();
  const note = (m: Map<number, number>, id: number, ts: number) => {
    if (!m.has(id)) m.set(id, ts);
  };
  for (const e of events) {
    if (!e.itemId) continue;
    const meta = e.meta as { source?: string; where?: string } | undefined;
    // Synthetic events from the HN-history import are personalization SIGNALS, not
    // in-app reads — they must NOT show up as "read" (you didn't read your own posts
    // here, nor every thread you once commented on). Excluded from read state.
    if (meta?.source === 'hn_import') continue;
    if (e.type === 'open_link') {
      opened.add(e.itemId);
      note(openTs, e.itemId, e.ts);
    } else if (e.type === 'dwell') {
      // Article read-time (tab blur→return) vs discussion time-on-page. A STAY
      // (>= BOUNCE_MS) is a genuine read; a shorter article dwell is a bounce.
      if (meta?.where === 'comments') {
        if ((e.value ?? 0) >= BOUNCE_MS) {
          stayedOnDiscussion.add(e.itemId);
          note(goodReadTs, e.itemId, e.ts);
        }
      } else if ((e.value ?? 0) >= BOUNCE_MS) {
        goodArticleRead.add(e.itemId);
        note(goodReadTs, e.itemId, e.ts);
      } else if (isBounce(e.value)) {
        articleBounced.add(e.itemId);
      }
    }
  }
  // A genuine read (stayed on the article OR the discussion) wins over any bounce.
  const read = new Set<number>([...stayedOnDiscussion, ...goodArticleRead]);
  // An open with no bounce recorded (background open / not-yet-measured) also counts.
  for (const id of opened) if (!articleBounced.has(id)) read.add(id);
  // Order by newest GENUINE-read time; a bare open only orders when there's no good read
  // (background open). A bounce RE-open never sets goodReadTs, so re-clicking a read story
  // and bouncing can't float it to the top of the Read tab.
  const orderTs = (id: number) => goodReadTs.get(id) ?? openTs.get(id) ?? 0;
  return [...read].sort((a, b) => orderTs(b) - orderTs(a)).slice(0, limit);
}

/** Recent items the user explicitly disliked (hid) — the negative content profile. */
export async function getDislikedItemIds(limit = 200): Promise<number[]> {
  const events = await db.events.where('type').equals('hide').toArray();
  events.sort((a, b) => b.ts - a.ts);
  const ids: number[] = [];
  const seen = new Set<number>();
  for (const e of events) {
    if (e.itemId && !seen.has(e.itemId)) {
      seen.add(e.itemId);
      ids.push(e.itemId);
      if (ids.length >= limit) break;
    }
  }
  return ids;
}

export async function eventCount(): Promise<number> {
  return db.events.count();
}

export async function clearAllData(): Promise<void> {
  await Promise.all([
    db.events.clear(),
    db.items.clear(),
    db.lists.clear(),
    db.embeddings.clear(),
    db.kv.clear(),
    db.seen.clear(),
    db.saved.clear(),
    db.hidden.clear(),
  ]);
}
