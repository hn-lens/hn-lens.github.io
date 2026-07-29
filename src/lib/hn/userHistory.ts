import { db } from '../db';
import { search } from './algolia';
import { fetchUser } from './firebase';
import { domainOf } from '../time';
import type { HnItem, InteractionEvent } from '../../types';

export interface HnActivity {
  karma: number;
  created?: number;
  storyCount: number;
  commentCount: number;
  topDomains: string[];
  recentStories: Array<{ id: number; title: string; url?: string }>;
}

/** Public profile + activity summary for display / tracking. */
export async function fetchHnActivity(username: string): Promise<HnActivity | null> {
  // allSettled, not all: these are three INDEPENDENT sources, so one failing endpoint should cost
  // its own slice and nothing else. Under Promise.all a single rejection discarded the two that had
  // already succeeded and the whole profile came back null — a worse outcome than a partial one, for
  // data that is purely additive. (`getItems` already uses allSettled for the same reason.)
  const [profileR, storiesR, commentsR] = await Promise.allSettled([
    fetchUser(username),
    search({ tags: `story,author_${username}`, hitsPerPage: 50, byDate: true }),
    search({ tags: `comment,author_${username}`, hitsPerPage: 1 }),
  ]);
  const EMPTY_HITS = { hits: [], nbHits: 0 };
  const profile = profileR.status === 'fulfilled' ? profileR.value : null;
  const stories = storiesR.status === 'fulfilled' ? storiesR.value : EMPTY_HITS;
  const comments = commentsR.status === 'fulfilled' ? commentsR.value : EMPTY_HITS;
  if (!profile && stories.nbHits === 0 && comments.nbHits === 0) return null;

  const domains: Record<string, number> = {};
  for (const h of stories.hits) {
    const d = domainOf(h.url);
    if (d) domains[d] = (domains[d] ?? 0) + 1;
  }

  return {
    karma: profile?.karma ?? 0,
    created: profile?.created,
    storyCount: stories.nbHits,
    commentCount: comments.nbHits,
    topDomains: Object.entries(domains)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([d]) => d),
    recentStories: stories.hits.slice(0, 5).map((h) => ({
      id: Number(h.objectID),
      title: h.title || '(untitled)',
      url: h.url,
    })),
  };
}

function importSource(e: InteractionEvent): string | undefined {
  return (e.meta as { source?: string } | undefined)?.source;
}

/**
 * Import the user's submitted stories and commented-on stories as positive
 * engagement signals (feeds affinities, the embedding profile, and the learned
 * reranker). Idempotent: re-importing replaces the previous import.
 */
export async function importHnHistory(
  username: string
): Promise<{ stories: number; commentedStories: number }> {
  const all = await db.events.toArray();
  const priorIds = all
    .filter((e) => importSource(e) === 'hn_import' && e.id != null)
    .map((e) => e.id as number);
  if (priorIds.length) await db.events.bulkDelete(priorIds);

  // Same reasoning as fetchHnActivity: importing only the stories is strictly better than importing
  // nothing because the comment search happened to fail.
  const [storiesR, commentsR] = await Promise.allSettled([
    search({ tags: `story,author_${username}`, hitsPerPage: 100, byDate: true }),
    search({ tags: `comment,author_${username}`, hitsPerPage: 100, byDate: true }),
  ]);
  const stories = storiesR.status === 'fulfilled' ? storiesR.value : { hits: [], nbHits: 0 };
  const comments = commentsR.status === 'fulfilled' ? commentsR.value : { hits: [], nbHits: 0 };

  const items: HnItem[] = [];
  const events: InteractionEvent[] = [];
  const now = Date.now();
  const seen = new Set<number>();

  for (const h of stories.hits) {
    const id = Number(h.objectID);
    if (seen.has(id)) continue;
    seen.add(id);
    items.push({
      id,
      type: 'story',
      title: h.title,
      url: h.url,
      by: h.author,
      score: h.points,
      descendants: h.num_comments,
      time: h.created_at_i,
    });
    events.push({
      ts: now,
      type: 'open_link',
      itemId: id,
      domain: domainOf(h.url),
      author: h.author,
      meta: { source: 'hn_import' },
    });
  }

  let commentedStories = 0;
  for (const h of comments.hits) {
    const sid = h.story_id;
    if (!sid || seen.has(sid)) continue;
    seen.add(sid);
    commentedStories++;
    items.push({
      id: sid,
      type: 'story',
      title: h.story_title,
      url: h.story_url,
      time: h.created_at_i,
    });
    events.push({
      ts: now,
      type: 'open_comments',
      itemId: sid,
      domain: domainOf(h.story_url),
      meta: { source: 'hn_import' },
    });
  }

  await db.items.bulkPut(items.map((item) => ({ id: item.id, item, cachedAt: now })));
  await db.events.bulkAdd(events);

  return { stories: stories.hits.length, commentedStories };
}

/** How many signals came from a prior HN history import (0 = never imported). */
export async function countHnImport(): Promise<number> {
  const all = await db.events.toArray();
  return all.filter((e) => importSource(e) === 'hn_import').length;
}

export async function clearHnImport(): Promise<void> {
  const all = await db.events.toArray();
  const ids = all
    .filter((e) => importSource(e) === 'hn_import' && e.id != null)
    .map((e) => e.id as number);
  if (ids.length) await db.events.bulkDelete(ids);
}
