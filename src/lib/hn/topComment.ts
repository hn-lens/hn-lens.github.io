import { kvGet, kvSet } from '../db';
import { commentToText, isLinkDump } from '../html';
import { getItems } from './client';
import type { HnItem } from '../../types';

export interface TopComment {
  by: string;
  text: string;
}

const cacheKey = (id: number) => `topc:${id}`;
const MAX_CANDIDATES = 3;
const MAX_LEN = 320; // the card clamps to ~2 lines; bound the stored text to keep the cache small
const MAX_KIDS = 5; // only fetch the first few top-level comments — enough to pick a standout.
// (5, not 8: this feature is default-ON and fetches per card, so it's the biggest default-on
// network cost.) NOTE on ORDER: firebase item.kids (Top/Best/discussion) is HN-RANKED (best-first),
// so the standout is in the first few. For-You cards come from Algolia, whose `children` is
// CHRONOLOGICAL (oldest-first, mapped to kids in algolia.ts) — so on For-You this picks the standout
// among the OLDEST few, not the top-ranked few. Accepted preview-quality tradeoff: fetching the
// ranked order would need a per-card firebase story fetch (the N+1 the Algolia pool removed). The
// discussion view itself always shows comments in the chosen sort order, unaffected.

// Substance heuristic for a TOP-LEVEL comment. A one-line preview should surface the comment
// others actually ENGAGED with, not merely the longest wall of text — so length is capped low
// and DIRECT replies dominate. A bare link-dump (2+ URLs with little prose) is demoted: it
// reads as a reference list, not a "standout take". (An earlier length-dominated score let a
// 600-char zero-reply comment beat a short, insightful, multiply-replied one.)
export const LEN_CAP = 200;
export const REPLY_WEIGHT = 70;
export const LINKDUMP_PENALTY = 300;
/** Minimum VISIBLE characters for a comment to be worth surfacing. Without a floor a 3-char joke
 * ("lol") that attracts replies wins on reply weight alone and takes the card's single preview
 * slot — and the same floor is what the summary selector uses, so they agree. */
export const MIN_SUBSTANCE_CHARS = 40;

/** The ONE substance heuristic — shared with the summary selector so the two cannot drift. Length is
 * capped LOW and direct replies dominate: we want the comment others actually ENGAGED with, not the
 * longest wall of text. A length-dominated variant of this lived on in the summary path long after
 * this one was hardened, and fed the model 91% filler on a large thread. */
export function commentSubstanceScore(text: string, replies: number): number {
  return (
    Math.min(text.length, LEN_CAP) +
    replies * REPLY_WEIGHT -
    (isLinkDump(text) ? LINKDUMP_PENALTY : 0)
  );
}
const score = commentSubstanceScore;

function usable(c: HnItem): boolean {
  return !!c && !c.deleted && !c.dead && typeof c.text === 'string' && !!c.text.trim() && !!c.by;
}

/**
 * Pick the best top-level comments as {by,text}, cleaned + bounded. Pure (no I/O) so the
 * harness can drive the exact selection the UI uses. Input is the story's DIRECT-child
 * comment items (from `item.kids`); a child's own `kids.length` is its direct-reply count.
 */
export function pickTopComments(
  comments: HnItem[] | null | undefined,
  max = MAX_CANDIDATES
): TopComment[] {
  const roots = (comments ?? [])
    .filter(usable)
    .map((c) => ({
      by: c.by as string,
      clean: commentToText(c.text as string),
      replies: c.kids?.length ?? 0,
    }))
    // Require real SUBSTANCE, not merely non-empty. `usable` only checks the RAW html is non-empty,
    // and a formatting-only body (`<p></p>`) strips to ''. A `> 0` gate also let a 3-character joke
    // with 6 replies win the single preview slot — while this very comment claimed parity with the
    // summary selector's gate, which is 40 chars. Now it actually is that gate.
    .filter((c) => c.clean.trim().length >= MIN_SUBSTANCE_CHARS);
  roots.sort((a, b) => score(b.clean, b.replies) - score(a.clean, a.replies));
  return roots.slice(0, max).map((c) => ({ by: c.by, text: c.clean.slice(0, MAX_LEN) }));
}

/**
 * Top comments for a story: the best few top-level comments as {by,text}. Checks the kv
 * cache first (no network on a hit). On a miss, fetches only the story's FIRST few top-level
 * comment items (`item.kids`) through the firebase item pool — bounded concurrency,
 * IndexedDB-cached, dead/deleted-filtered, and SHARED with the rest of the app's item cache.
 * It deliberately does NOT pull the whole nested Algolia comment tree, which downloaded tens
 * to hundreds of KB per card (megabytes across a feed page) just to render one preview line.
 * The CALLER gates this on the showTopComments pref + card visibility so the feed costs
 * nothing when off / off-screen.
 */
// CROSS-CARD bound. Many cards enter view at once (a fling / a tall layout on a big monitor), and
// each fetches its own preview. With only the per-card getItems(kids, 3) limit they collectively
// flooded the shared 6-connection firebase origin — queue depth 85, p95 dispatch wait 1.2s, some
// requests aborting on their own timeout while still queued, and starving the For-You item fetches.
// This module-level gate caps how many cards fetch a preview AT ONCE across the whole feed, so the
// preview traffic can never monopolise the origin. Cache hits and childless stories never enter it.
const PREVIEW_CARD_CONCURRENCY = 2; // 2 cards × getItems-bound(3) = 6 concurrent ≈ the origin's 6-connection budget
let previewActive = 0;
const previewWaiters: Array<() => void> = [];
async function acquirePreviewSlot(): Promise<void> {
  if (previewActive < PREVIEW_CARD_CONCURRENCY) {
    previewActive++;
    return;
  }
  await new Promise<void>((resolve) => previewWaiters.push(resolve));
  previewActive++;
}
function releasePreviewSlot(): void {
  previewActive--;
  previewWaiters.shift()?.();
}

export async function getTopComments(item: HnItem): Promise<TopComment[]> {
  const cached = await kvGet<TopComment[]>(cacheKey(item.id));
  if (cached) return cached;
  const kids = (item.kids ?? []).slice(0, MAX_KIDS);
  if (!kids.length) return []; // genuinely childless — nothing to show
  // 3 per card, not the default 8 — AND gated by a cross-card slot (see above) so a fling of visible
  // cards can't put dozens of requests on the 6-connection origin at once.
  await acquirePreviewSlot();
  let comments;
  try {
    comments = await getItems(kids, 3);
  } finally {
    releasePreviewSlot();
  }
  const picked = pickTopComments(comments);
  // An empty pick has two causes: a transient fetch failure, or comments that are genuinely all too
  // short/muted to preview. Only the first is worth retrying, so a genuine empty is cached.
  //
  // This test errs toward NOT caching: `getItems` also drops dead/deleted comments, so a story with
  // a deleted top-level kid looks like a failed fetch and is re-fetched. Measured on live data, ~11%
  // of front-page stories have such a kid; the re-fetch only bites when EVERY surviving comment is
  // also below the substance floor. Erring the other way would cache a transient failure forever.
  const fetchFailed = comments.length < kids.length;
  if (picked.length || !fetchFailed) await kvSet(cacheKey(item.id), picked);
  return picked;
}
