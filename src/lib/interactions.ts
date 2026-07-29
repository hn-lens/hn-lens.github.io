import { db } from './db';
import { clearReadSweep } from './readSweep';
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
  // Undo of "Not interested" is a training-relevant event too: it changes the item's label AND
  // cancels the hide's affinity, so it must fire the engagement listeners — otherwise `main.tsx`
  // never invalidates ['affinities']/['content'], the For-You feed keeps serving the stale
  // (un-cancelled) −2.5, and the un-hidden story reappears BURIED instead of at its original rank
  // until a manual Refresh/reload. (Also makes the background auto-trainer retrain after an Undo.)
  'unhide',
  // Un-saving is training-relevant for the same reason `unhide` is: it reverses the item's label
  // and cancels the save's affinity. Without it here the listeners never fire, so `main.tsx` never
  // invalidates ['affinities']/['content'] and both the ranking and the sidebar keep showing the
  // pre-unsave value until a reload.
  'unsave',
  'dwell',
]);

const engagementListeners = new Set<() => void>();
/** Subscribe to engagement events (used by the background auto-trainer). */
export function onEngagement(cb: () => void): () => void {
  engagementListeners.add(cb);
  return () => engagementListeners.delete(cb);
}

/**
 * One shared read of the event log per burst.
 *
 * Five separate derivations (affinities, engaged ids, read ids, the hidden set, training labels)
 * each read the WHOLE `events` table independently, and a cold load runs about ten such reads —
 * five of them again ~4s later when the startup retrain fires. Cost is linear in a log the app lets
 * reach 10,000 rows, so time-to-first-card grew from 166ms on a fresh profile to 834ms on a full
 * one, plus a recurring ~660ms of background work. Invisible when you test on an empty profile;
 * it degrades quietly with use, which is the worst shape for this kind of cost.
 *
 * Collapsing them is safe because it changes only HOW MANY TIMES the same rows are read, never which
 * rows or how they are interpreted — every derivation still sees the identical array. Correctness
 * rests on invalidating whenever the table changes, which `invalidateEventsSnapshot()` below does
 * from every write path; the short TTL is only a backstop for anything that writes without saying so.
 */
const SNAPSHOT_TTL_MS = 1000;
let eventsSnap: { at: number; p: Promise<InteractionEvent[]> } | null = null;

export function invalidateEventsSnapshot(): void {
  eventsSnap = null;
}

// Invalidate from DEXIE'S OWN table hooks, not from a hand-maintained list of call sites.
//
// The first version invalidated from `track()` plus the three other write paths I could find. That
// is exactly the kind of guarantee that decays: anything writing to the table without knowing about
// the cache — a future code path, an import routine, or a test seeding fixtures directly — gets
// served up to a second of stale data. It broke the read-history harness immediately, which seeded
// events straight into Dexie and then read back an empty list.
//
// Table hooks fire for every create/update/delete regardless of who issued it, so the invariant
// ("the snapshot is dropped whenever the table changes") holds by construction rather than by
// remembering.
db.events.hook('creating', () => {
  invalidateEventsSnapshot();
});
db.events.hook('updating', () => {
  invalidateEventsSnapshot();
});
db.events.hook('deleting', () => {
  invalidateEventsSnapshot();
});

/** The whole event log, shared across derivations that run in the same burst. */
export async function eventsSnapshot(): Promise<InteractionEvent[]> {
  if (eventsSnap && Date.now() - eventsSnap.at < SNAPSHOT_TTL_MS) return eventsSnap.p;
  const p = db.events.toArray();
  eventsSnap = { at: Date.now(), p };
  // A failed read must not be cached as the answer for the next second.
  p.catch(() => invalidateEventsSnapshot());
  return p;
}

/** Newest-first, derived from the shared snapshot rather than a second indexed scan. */
async function eventsNewestFirst(): Promise<InteractionEvent[]> {
  const all = await eventsSnapshot();
  return [...all].sort((a, b) => b.ts - a.ts);
}

export function track(ev: Omit<InteractionEvent, 'id' | 'ts'>): void {
  invalidateEventsSnapshot();
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
 * Record time spent ON A DISCUSSION (in-app, on the /item page). Only a genuine STAY
 * (>= BOUNCE_MS) is recorded — a quick glance/summarize-and-leave records nothing,
 * so it neither marks the item read (getReadItemIds) nor adds affinity. Mirrors the
 * article dwell model for the "opened the post and didn't return immediately" rule.
 */
/** Returns whether a dwell event was actually recorded, so callers that may fire more than once
 * (an unload flush AND the unmount cleanup) can record exactly one per visit. */
export function trackDiscussionDwell(itemId: number, ms: number, item?: { url?: string; by?: string }): boolean {
  if (ms < BOUNCE_MS || ms > 30 * 60_000) return false;
  track({ type: 'dwell', itemId, domain: item ? domainOf(item.url) : undefined, author: item?.by, value: ms, meta: { where: 'comments' } });
  return true;
}

// ---------- Behavioral affinities (learned from events) ----------

const SIGNAL_WEIGHT: Partial<Record<InteractionType, number>> = {
  open_link: 1,
  open_comments: 0.8,
  save: 2,
  // Must CANCEL the save (net 0), not merely discount it — the same reasoning as unhide/hide below.
  // At −1 an undone save still left a permanent +1 of affinity for that domain and author, so the
  // ranker kept promoting a source the user had explicitly stopped endorsing.
  unsave: -2,
  upvote_out: 2.5,
  summarize: 0.5,
  // No follow_/unfollow_ weights here on purpose. Following is an EXPLICIT preference, applied as a
  // fixed term in the blend; feeding it into the behavioural affinity log too would count the same
  // choice twice. Weights sat here for event types nothing ever emitted.
  hide: -2.5,
  // Undo of "Not interested" must CANCEL the hide's downvote (net 0) so the story returns to its
  // original rank — otherwise Undo un-hides it but the −2.5 affinity survives and buries it. (The
  // unhide event must carry the same domain/author as the hide — see unhideItem.)
  unhide: 2.5,
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
  /**
   * What EACH item contributed, so a caller can compute affinity WITHOUT that item — the
   * leave-one-out the learned ranker needs at TRAINING time. Without it, a positive training row's
   * `domainAffinity`/`authorAffinity` are largely a function of its OWN engagement events, i.e. of
   * its label: measured posMean 0.60 vs negMean −0.00, so the ranker separates the classes on a
   * feature that is ~0 at serve time for any unfamiliar source, weights it 5.5 and starves the
   * transferable content signal (1.2). Serve time must keep using the full totals — there, all your
   * history legitimately counts.
   */
  perItem: Record<number, { domain?: string; author?: string; dw: number; aw: number; counted: boolean }>;
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

/**
 * Is this event the NOISE of re-visiting a story the user already genuinely engaged with?
 *
 * Two shapes, both of which must contribute 0 (see the call site): a repeat OPEN (anything but the
 * earliest open of that type for the item) and a re-visit BOUNCE. Deciding "earliest" from a
 * precomputed per-item timestamp keeps this ORDER-INDEPENDENT, so callers that feed events
 * newest-first and oldest-first agree (the c7 lesson: a shared helper must not depend on input order).
 */
function isRevisitNoise(
  e: InteractionEvent,
  firstOpenTs: Map<string, number>,
  engaged: Set<number>
): boolean {
  if (!e.itemId) return false;
  if (e.type === 'open_link' || e.type === 'open_comments') {
    return firstOpenTs.get(`${e.itemId}:${e.type}`) !== e.ts;
  }
  // A bounce on an item that is already engaged is a re-visit, not a dislike.
  if (e.type === 'dwell' && isBounce(e.value)) return engaged.has(e.itemId);
  return false;
}

export async function computeAffinities(): Promise<Affinities> {
  // Read the WHOLE log, like the three sibling derivations (`getEngagedItemIds`,
  // `buildTrainingSamples`, `getDislikedItemIds`). A `.limit(3000)` here handed the SHARED
  // classifier a different event universe than its siblings — re-introducing, at the slice level,
  // exactly the drift that making the classifier order-independent had closed. With enough history
  // the truncation could drop a story's `hide` while keeping its opens, INVERTING the sign of the
  // affinity for a story the user had explicitly downvoted. The log is already bounded by
  // `pruneCaches` (MAX_EVENTS 10000, oldest-first eviction), so there is nothing to gain by
  // slicing it again here — and any real recency policy would have to be applied identically in
  // all four derivations, not in one.
  const events = await eventsNewestFirst();
  // Affinity is dwell-aware — the THIRD derivation of "did the user engage", unified with the
  // training labels + content profile via the SAME classifier. A weak OPEN (article link or
  // discussion) only credits its domain/author when the item was genuinely engaged (a read/stay);
  // a bounce or a bare discussion glance must NOT accrue positive affinity, or a domain you only
  // bounce off ranks UP and the "why" chip falsely says "You often read X". (A bounce's separate
  // negative `dwell` event still applies; a bare glance nets 0.)
  const { engaged } = classifyEngagement(events);
  // Muted domains/users are hard-filtered from the feed; don't let past
  // engagement with them leak back into learned affinity either.
  const { mutedDomains, mutedUsers } = usePrefs.getState();
  const mutedD = new Set(mutedDomains);
  const mutedU = new Set(mutedUsers);
  const domains: Record<string, number> = {};
  const authors: Record<string, number> = {};
  const perItem: Affinities['perItem'] = {};
  const domainItems = new Map<string, Set<number>>(); // distinct positively-engaged items
  const authorItems = new Map<string, Set<number>>();
  const undone = new Set<number>(); // items whose only positive signal was later withdrawn
  const noteItem = (map: Map<string, Set<number>>, key: string, id?: number) => {
    if (!id) return;
    let s = map.get(key);
    if (!s) map.set(key, (s = new Set()));
    s.add(id);
  };
  // Earliest open per (item, type) — precomputed so "credit the open once" is order-independent.
  const firstOpenTs = new Map<string, number>();
  for (const e of events) {
    if (!e.itemId || (e.type !== 'open_link' && e.type !== 'open_comments')) continue;
    const k = `${e.itemId}:${e.type}`;
    const prev = firstOpenTs.get(k);
    if (prev === undefined || e.ts < prev) firstOpenTs.set(k, e.ts);
  }
  for (const e of events) {
    // A weak OPEN (article link / discussion) only credits affinity if the item is dwell-aware
    // ENGAGED. A bounced article open (open + short dwell) or a bare discussion glance (open_comments
    // with no stay) is skipped here → contributes 0 credit and never counts; the bounce's own
    // negative `dwell` event still lands below. Strong/explicit signals (save/hide/unhide/dwell/…)
    // are unaffected.
    if ((e.type === 'open_link' || e.type === 'open_comments') && !(e.itemId && engaged.has(e.itemId)))
      continue;
    // …but the guard above is per-ITEM while the credit is per-EVENT, so once an item qualified,
    // EVERY later open of it was credited too. Re-opening a story you already read and bailing out
    // (the commonest "I've read this" gesture, straight from the Read tab) then netted POSITIVE
    // affinity (+1 open −0.6 bounce = +0.4 per cycle) — a bounce making a domain look better liked,
    // which is the very inversion the dwell-aware classifier exists to prevent. A REVISIT of an
    // already-engaged item is NEUTRAL: credit the open ONCE (the earliest, chosen by ts so this is
    // order-INDEPENDENT — callers feed events newest- or oldest-first), and ignore a revisit BOUNCE
    // (re-checking something you genuinely read is not evidence you dislike it — mirrors the
    // "read is MONOTONIC" rule). A genuine re-read still counts: its dwell is credited normally.
    if (e.itemId && isRevisitNoise(e, firstOpenTs, engaged)) continue;
    const w = e.type === 'dwell' ? dwellSignal(e.value) : SIGNAL_WEIGHT[e.type] ?? 0;
    if (!w) continue;
    // `unhide` cancels a prior hide in the affinity SUM, but it is an UNDO, not positive engagement,
    // so it must NOT count toward the distinct-engaged-items tally (which gates the "often" reason).
    //
    // `unsave` is the same shape and was missed: its NEGATIVE weight correctly cancels the save in
    // the affinity sum, but the save had already marked the item as a distinct engaged item and
    // nothing took that back. So saving and immediately un-saving left a permanent +1 on the habit
    // count, and at identical affinity the card then claimed "You often read <site>" on the strength
    // of an interaction the reader had explicitly withdrawn. Undone engagement is not engagement.
    const counts = w > 0 && e.type !== 'unhide';
    if (e.type === 'unsave' && e.itemId) undone.add(e.itemId);
    const rec = e.itemId ? (perItem[e.itemId] ??= { dw: 0, aw: 0, counted: false }) : undefined;
    if (e.domain && !mutedD.has(e.domain)) {
      domains[e.domain] = (domains[e.domain] ?? 0) + w;
      if (rec) {
        rec.domain = e.domain;
        rec.dw += w;
      }
      if (counts) noteItem(domainItems, e.domain, e.itemId);
    }
    if (e.author && !mutedU.has(e.author)) {
      authors[e.author] = (authors[e.author] ?? 0) + w;
      if (rec) {
        rec.author = e.author;
        rec.aw += w;
      }
      if (counts) noteItem(authorItems, e.author, e.itemId);
    }
    if (rec && counts) rec.counted = true;
  }
  // Drop items whose engagement was withdrawn AND that have no surviving positive weight. Checking
  // the residual weight matters: a story you saved, READ, then un-saved is still genuinely engaged,
  // so only the ones left with nothing are removed from the habit tally.
  for (const id of undone) {
    const rec = perItem[id];
    if (rec && rec.dw <= 0 && rec.aw <= 0) {
      for (const set of domainItems.values()) set.delete(id);
      for (const set of authorItems.values()) set.delete(id);
      // The item is no longer in the habit tally, so it must no longer count as its own leave-one-out
      // subtraction: `computeFeatures` subtracts `counted` from domainCounts/authorCounts when scoring
      // the item, and leaving it true double-removed the withdrawn item — dropping the card's own
      // "often" chip on a domain it genuinely engages with.
      rec.counted = false;
    }
  }
  const domainCounts: Record<string, number> = {};
  for (const [d, s] of domainItems) domainCounts[d] = s.size;
  const authorCounts: Record<string, number> = {};
  for (const [a, s] of authorItems) authorCounts[a] = s.size;
  return { domains, authors, domainCounts, authorCounts, perItem };
}

// Deliberate positive actions, independent of dwell. `upvote_out`/`summarize` count unconditionally;
// `save` is additionally REVERSIBLE (an unsave cancels it — see `classifyEngagement`).
export const STRONG_ENGAGEMENT: InteractionType[] = ['save', 'upvote_out', 'summarize'];
const STRONG_SET = new Set<string>(STRONG_ENGAGEMENT);

export interface EngagementClasses {
  engaged: Set<number>; // dwell-aware POSITIVES (hidden already removed)
  bounced: Set<number>; // opened an article but returned almost immediately
  impressed: Set<number>;
  hidden: Set<number>; // "Not interested"
  lastTs: Map<number, number>; // most-recent event ts per item (for recency ordering)
}

/**
 * Classify the interaction log into dwell-aware ENGAGEMENT classes — the SINGLE source of truth for
 * "did the user positively engage with this item", shared by the learned-ranker training LABELS
 * (`train.ts`) AND the content profile's LIKED set (`content.ts`). Unifying them prevents the drift
 * where the labels were dwell-aware (a bounce trains AGAINST a story) but the content profile was not
 * (a bounced article's terms leaked into the LIKED profile, ranking that topic UP — contradicting the
 * label). Rules mirror the app's read definition:
  *   • upvote/summarize → engaged, unconditional; save → engaged but REVERSIBLE (latest save vs
  *     latest unsave decides, like hide/unhide) so an undone mis-click doesn't teach the ranker;
  *   • IMPORTED (hn_import) open_link/open_comments → engaged, unconditional (declared engagement);
 *   • in-app open_link → engaged UNLESS it bounced (a genuine read wins — MONOTONIC);
 *   • dwell ≥ BOUNCE_MS → engaged (article read, or a discussion stay); dwell < BOUNCE → bounced;
 *   • a bare in-app open_comments (a glance, no stay) → NOT engaged;
 *   • hidden ("Not interested") → removed from engaged (it's a negative).
 */
export function classifyEngagement(events: InteractionEvent[]): EngagementClasses {
  const strong = new Set<number>();
  const opened = new Set<number>(); // in-app open_link (weak — an article open)
  const stayedComments = new Set<number>();
  const impressed = new Set<number>();
  // hide/unhide is resolved ORDER-INDEPENDENTLY (latest-hide-ts vs latest-unhide-ts, decided after the
  // loop) so every caller agrees no matter how it slices its event list — `computeAffinities` feeds
  // NEWEST-first, `buildTrainingSamples`/`getEngagedItemIds` feed oldest-first. A delete-after-add
  // during iteration flipped under a reversed feed (a read→hid→un-hid story wrongly stayed "hidden" in
  // the affinity pass, so its open-credit was dropped — a partially-reversed Undo).
  const hideTs = new Map<number, number>();
  const unhideTs = new Map<number, number>();
  const saveTs = new Map<number, number>();
  const unsaveTs = new Map<number, number>();
  const readArticle = new Set<number>();
  const bounced = new Set<number>();
  const imported = new Set<number>();
  const lastTs = new Map<number, number>();

  for (const e of events) {
    if (!e.itemId) continue;
    lastTs.set(e.itemId, Math.max(lastTs.get(e.itemId) ?? 0, e.ts));
    // `save` is recorded as a REVERSIBLE strong signal (latest save vs latest unsave decides),
    // exactly like hide/unhide below. Adding it unconditionally to `strong` made un-saving a no-op
    // in every derivation: affinity kept the full +2, the domain stayed in the engaged counts, and
    // the item stayed a training POSITIVE forever — so mis-clicking the small Save icon and
    // immediately undoing it permanently taught the ranker to promote that source.
    if (e.type === 'save') saveTs.set(e.itemId, Math.max(saveTs.get(e.itemId) ?? 0, e.ts));
    else if (e.type === 'unsave') unsaveTs.set(e.itemId, Math.max(unsaveTs.get(e.itemId) ?? 0, e.ts));
    else if (STRONG_SET.has(e.type)) strong.add(e.itemId);
    else if (e.type === 'open_link') {
      if (e.meta?.source === 'hn_import') imported.add(e.itemId);
      else opened.add(e.itemId);
    } else if (e.type === 'open_comments') {
      if (e.meta?.source === 'hn_import') imported.add(e.itemId);
    } else if (e.type === 'impression') impressed.add(e.itemId);
    else if (e.type === 'hide') hideTs.set(e.itemId, Math.max(hideTs.get(e.itemId) ?? 0, e.ts));
    // An Undo of "Not interested" reverses the hide. Recording the latest hide/unhide TIMESTAMP (and
    // deciding after the loop) makes it order-INDEPENDENT: a read→hid→un-hid story is engaged again in
    // EVERY caller regardless of event order. Without this, a read→hid→un-hid story stayed a NEGATIVE.
    else if (e.type === 'unhide') unhideTs.set(e.itemId, Math.max(unhideTs.get(e.itemId) ?? 0, e.ts));
    else if (e.type === 'dwell') {
      const stayed = (e.value ?? 0) >= BOUNCE_MS;
      if (e.meta?.where === 'comments') {
        if (stayed) stayedComments.add(e.itemId);
      } else if (stayed) {
        readArticle.add(e.itemId);
      } else if (isBounce(e.value)) {
        bounced.add(e.itemId);
      }
    }
  }

  // An item is CURRENTLY hidden iff its latest hide is newer than its latest unhide (order-independent).
  const hidden = new Set<number>();
  for (const [id, hts] of hideTs) if (hts > (unhideTs.get(id) ?? 0)) hidden.add(id);
  // Same rule for save/unsave: a save only counts as the deliberate positive it represents while it
  // is still in effect. A save that was undone contributes nothing — but it also does not erase
  // anything else, so a story that was READ and then saved-and-unsaved stays engaged on its read.
  for (const [id, sts] of saveTs) if (sts > (unsaveTs.get(id) ?? 0)) strong.add(id);

  const engaged = new Set<number>();
  for (const id of strong) engaged.add(id);
  for (const id of readArticle) engaged.add(id);
  for (const id of stayedComments) engaged.add(id);
  for (const id of imported) engaged.add(id);
  for (const id of opened) if (!bounced.has(id)) engaged.add(id);
  for (const id of hidden) engaged.delete(id); // hidden is a negative, never a liked/positive

  return { engaged, bounced, impressed, hidden, lastTs };
}

/**
 * Recent items the user positively engaged with — the LIKED set for the content profile. Now
 * dwell-aware (via classifyEngagement) so it matches the training labels: a bounced article / glanced
 * discussion is NOT here, so its terms don't leak into the liked centroid + term profile.
 */
export async function getEngagedItemIds(limit = 200): Promise<number[]> {
  const events = await eventsSnapshot();
  const { engaged, lastTs } = classifyEngagement(events);
  return [...engaged].sort((a, b) => (lastTs.get(b) ?? 0) - (lastTs.get(a) ?? 0)).slice(0, limit);
}

/**
 * Recently READ stories (title + url) for the sidebar "Recently read" panel.
 * "Read" is the SAME strict definition as getReadItemIds — you clicked through
 * and consumed it (opened the article without an immediate bounce, or opened the
 * discussion). Saving, summarizing (just a gist), and upvoting are engagement but
 * NOT reading, so they must NOT appear here. (This panel used to call
 * `getEngagedItemIds`, which wrongly listed summarized/saved items as "read".)
 *
 * This is a reading HISTORY, so a story you genuinely read that you LATER marked "Not
 * interested" (hidden) is kept here — the downvote shapes future ranking, it doesn't erase
 * the record that you read it. This matches the Read tab (useFeed exempts the `read` feed
 * from the hidden filter), so the two "read" surfaces still AGREE. Global mutes/min-points
 * DO still apply to both.
 */
export async function recentRead(limit = 6): Promise<Array<{ id: number; title: string; url?: string }>> {
  // Draw from the FULL read history, not a `limit * 4` window. A reader who reads a lot of one site
  // and then mutes it has a long leading run of filtered reads; a small window is entirely muted and
  // the panel goes empty while older unmuted reads remain — which also made this panel disagree with
  // the Read tab (the two "read" surfaces must AGREE). The loop below still stops at `limit` showable
  // items, so the common case fetches only a handful; the bound just prevents a pathological scan.
  const ids = await getReadItemIds(1000); // already newest-first, read-only
  // Apply the SAME global hard filters the Read tab applies (useFeed uses `isFiltered`),
  // so the two "read" surfaces AGREE: a read story from a muted domain/user, matching a
  // muted keyword, or below min-points must be absent from BOTH the Read tab and this
  // sidebar panel. Reuses the one `isFiltered` source of truth (no duplicated logic);
  // affinities are irrelevant to filtering, so a minimal context is fine.
  const p = usePrefs.getState();
  const ctx: RankContext = {
    weights: p.weights,
    affinities: { domains: {}, authors: {}, domainCounts: {}, authorCounts: {}, perItem: {} },
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
  // Read the WHOLE log, like every sibling derivation (`computeAffinities`, `getEngagedItemIds`,
  // `buildTrainingSamples`). A 5000-event window silently DELETED reading history: impressions
  // dominate the log (every card that scrolls past fires one), so a normal reader passes 5000 in
  // days, and everything older fell outside the window — the Read tab, the sidebar's "Recently
  // read" and For-You's hide-already-read all went empty while the UI claimed you had never read
  // anything. The log is already bounded by `pruneCaches` (MAX_EVENTS 10000, oldest-first), so a
  // second window here buys nothing and only re-creates the derivation drift.
  const events = await eventsNewestFirst();
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

/**
 * Recent items the user explicitly disliked (hid) — the negative content profile. "Disliked" means
 * CURRENTLY hidden: an item's MOST RECENT hide/unhide event is a `hide`. An Undo (unhide) must remove
 * it here too — otherwise a hid-then-un-hid story stays a disliked-content example and its terms keep
 * dragging it down via termAffinity, so the Undo would only half-reverse (the affinity + training
 * label are already reversed; this closes the third derivation).
 */
export async function getDislikedItemIds(limit = 200): Promise<number[]> {
  // Filter the shared snapshot instead of a second indexed scan: this runs alongside the other
  // derivations, so one shared read beats four cheaper-but-separate ones.
  const events = (await eventsSnapshot()).filter((e) => e.type === 'hide' || e.type === 'unhide');
  events.sort((a, b) => b.ts - a.ts); // newest first — the first event seen per item decides its state
  const ids: number[] = [];
  const decided = new Set<number>();
  for (const e of events) {
    if (!e.itemId || decided.has(e.itemId)) continue;
    decided.add(e.itemId);
    if (e.type === 'hide') {
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
  // The For-You read sweep is derived from the event log, so it must not outlive it. Left behind,
  // it goes on hiding stories whose "you already read this" evidence has been deleted — and it
  // lives in sessionStorage, so clearing IndexedDB alone does not touch it.
  clearReadSweep();
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
