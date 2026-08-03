// Reasons-wording test — a card's "why recommended" chip must not OVERCLAIM.
//
// authorAffinity/domainAffinity = tanh(score/5). A single strong action (a save is
// score 2 → 0.38) used to clear the 0.3 "often" threshold, so a one-off read as a
// HABIT: "You often engage with X". "Often" now needs enough accumulated affinity to
// reflect repeated engagement (author > 0.55, domain > 0.5); a lone engagement gets a
// softer, honest reason ("…whom you've read" / "…which you've read"). Drives the REAL
// strategies module via window.__hnlens so the wording is asserted against live code.
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:4173/';
const fails = [];
const check = (name, pass, detail = '') => {
  console.log(`  ${pass ? '\u2713' : '\u2717'} ${name}${detail ? ` \u2014 ${detail}` : ''}`);
  if (!pass) fails.push(name);
};

const b = await chromium.launch({ headless: true });
const page = (await b.newContext({ viewport: { width: 1000, height: 800 } })).pages()[0] || (await b.newPage());
await page.route(/hacker-news\.firebaseio\.com|hn\.algolia\.com|google\.com\/s2/, (r) =>
  r.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
);
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__hnlens && window.__hnlens.strategies && window.__hnlens.prefs, null, { timeout: 20000 });

const r = await page.evaluate(async () => {
  const strategies = await window.__hnlens.strategies();
  const prefs = window.__hnlens.prefs.getState();
  // No follows / boost keywords so affinity is the ONLY reason source.
  prefs.set({ followedDomains: [], followedUsers: [], keywordsBoost: [], mutedDomains: [], mutedUsers: [], keywordsMute: [] });
  const p = window.__hnlens.prefs.getState();
  // score = affinity magnitude, count = distinct engaged items with that author/domain.
  const mk = (score, count) =>
    strategies.makeContext(p, {
      domains: { 'ex.com': score }, authors: { alice: score },
      domainCounts: { 'ex.com': count }, authorCounts: { alice: count },
    });
  // Old, score-less item so recency/popularity don't dominate — affinity is the top
  // driver, which is exactly when a soft affinity chip is honest to show.
  const oldTime = Math.floor(Date.now() / 1000) - 20 * 86400;
  const item = { id: 1, title: 'A perfectly neutral headline about nothing', url: 'https://ex.com/a', by: 'alice', score: 0, descendants: 0, time: oldTime, type: 'story' };
  const low = strategies.scoreItem(item, mk(2, 1)).reasons; // one engagement (count 1) → affinity 0.38
  const deepOne = strategies.scoreItem(item, mk(6, 1)).reasons; // ONE deeply-read item, high affinity
  const high = strategies.scoreItem(item, mk(6, 3)).reasons; // repeated across 3 items → habit
  return { low, deepOne, high };
});

console.log('  low (count 1):      ', JSON.stringify(r.low));
console.log('  deepOne (count 1):  ', JSON.stringify(r.deepOne));
console.log('  high (count 3):     ', JSON.stringify(r.high));
check('a lone engagement is NOT described as "often"', !r.low.some((t) => /often/i.test(t)), JSON.stringify(r.low));
check('a lone engagement is NOT mislabeled as "read" (it may be a save)', !r.low.some((t) => /you've read|you read/i.test(t)), JSON.stringify(r.low));
check('a lone engagement yields a soft "engaged with" reason', r.low.some((t) => /engaged with/i.test(t)), JSON.stringify(r.low));
check('a SINGLE deeply-read item is NOT "often" even at high affinity', !r.deepOne.some((t) => /often/i.test(t)), JSON.stringify(r.deepOne));
check('repeated engagement across ≥2 items DOES earn an "often" reason', r.high.some((t) => /often/i.test(t)), JSON.stringify(r.high));

// ---- per-author diversity cap: one author can't flood the top ----
const authorCap = await page.evaluate(async () => {
  const s = await window.__hnlens.strategies();
  const mk = (id, by) => ({ item: { id, by, url: `https://d${id}.com/x` }, score: 100 - id, reasons: [] });
  const ranked = [mk(1, 'x'), mk(2, 'x'), mk(3, 'x'), mk(4, 'y'), mk(5, 'x')];
  return s.diversifyByAuthor(ranked, 2).map((r) => `${r.item.id}:${r.item.by}`);
});
const frontX = authorCap.slice(0, 3).filter((s) => s.endsWith(':x')).length;
check('per-author cap keeps ≤2 of one author near the top', frontX <= 2, JSON.stringify(authorCap));
check('per-author cap removes nothing (all 5 still present)', authorCap.length === 5, JSON.stringify(authorCap));

// ---- save→unsave must NOT degrade the card's own habit chip (drives the REAL computeAffinities) ----
// Two genuine saves on ex.com (items 1,2) establish a habit; a save-then-unsave on item 3 is an
// undone mis-click. Scoring item 3 must still see the domain as one you engage with ≥2 items on —
// the leave-one-out must not subtract for an item the undone-cleanup already removed from the tally.
const m4 = await page.evaluate(async () => {
  const I = window.__hnlens.interactions();
  const F = window.__hnlens.features();
  const S = window.__hnlens.strategies();
  await I.clearAllData();
  const t = (type, itemId) => I.track({ type, itemId, domain: 'ex.com', author: 'alice' });
  await t('save', 1);
  await t('save', 2);
  await t('save', 3);
  await t('unsave', 3);
  const aff = await I.computeAffinities();
  const p = window.__hnlens.prefs.getState();
  p.set({ followedDomains: [], followedUsers: [], keywordsBoost: [], mutedDomains: [], mutedUsers: [], keywordsMute: [] });
  const ctx = S.makeContext(window.__hnlens.prefs.getState(), aff);
  const item3 = { id: 3, by: 'alice', url: 'https://ex.com/c', title: 'A neutral headline', score: 0, descendants: 0, time: Math.floor(Date.now() / 1000) - 20 * 86400, type: 'story' };
  const fs = F.computeFeatures(item3, ctx);
  return { domainEngagedN: fs.domainEngagedN, domainAffinity: Number(fs.domainAffinity.toFixed(3)), reasons: S.scoreItem(item3, ctx).reasons };
});
check('save→unsave leaves the domain habit count intact for that card (≥2)', m4.domainEngagedN >= 2, `domainEngagedN=${m4.domainEngagedN} affinity=${m4.domainAffinity}`);
check('save→unsave does not collapse the card\u2019s "often" chip', m4.reasons.some((t) => /often/i.test(t)), JSON.stringify(m4.reasons));

// ---- a story marked "Not interested" is NOT positive engagement (drives the REAL computeAffinities) ----
// `hide` is the same shape as `unsave`: the negative weight correctly cancels the read in the
// affinity SUM, but the read had already marked the item as a distinct engaged item and nothing took
// that back. One genuine read plus one read-then-hidden story on the same domain therefore claimed a
// two-item habit — "You often read X" — on the strength of a story the reader explicitly rejected.
const m5 = await page.evaluate(async () => {
  const I = window.__hnlens.interactions();
  const F = window.__hnlens.features();
  const S = window.__hnlens.strategies();
  const p = window.__hnlens.prefs.getState();
  p.set({ followedDomains: [], followedUsers: [], keywordsBoost: [], mutedDomains: [], mutedUsers: [], keywordsMute: [] });
  const probe = { id: 9, by: 'alice', url: 'https://ex.com/probe', title: 'A neutral headline', score: 0, descendants: 0, time: Math.floor(Date.now() / 1000) - 20 * 86400, type: 'story' };
  const run = async (hideSecond) => {
    await I.clearAllData();
    // A genuine READ is an open plus a real dwell: dwellSignal(0) is 0, so a value-less dwell
    // contributes nothing and the story would never enter the tally in the first place.
    const t = (type, itemId, value) => I.track({ type, itemId, value, domain: 'ex.com', author: 'alice' });
    await t('open_link', 1);
    await t('dwell', 1, 80_000);
    await t('open_link', 2);
    await t('dwell', 2, 80_000);
    if (hideSecond) await t('hide', 2);
    const aff = await I.computeAffinities();
    const ctx = S.makeContext(window.__hnlens.prefs.getState(), aff);
    const fs = F.computeFeatures(probe, ctx);
    return { n: fs.domainEngagedN, reasons: S.scoreItem(probe, ctx).reasons };
  };
  return { kept: await run(false), hidden: await run(true) };
});
check(
  'a story marked "Not interested" drops out of the domain habit tally',
  m5.hidden.n < m5.kept.n,
  JSON.stringify({ keptN: m5.kept.n, hiddenN: m5.hidden.n }),
);
check(
  'one read + one rejected story does NOT earn an "often" habit chip',
  !m5.hidden.reasons.some((t) => /often/i.test(t)),
  JSON.stringify(m5.hidden.reasons),
);

// ---- a rejected story leaves NO POSITIVE AFFINITY behind (the SUM, not just the tally) ----
// The habit tally drops a hidden item, but the affinity SUM only ever OFFSET it: a `hide` adds its
// negative weight next to whatever the item already accrued. A story read twice, or saved and read,
// therefore still pushed its domain and author up after the reader explicitly rejected it — and a
// DIFFERENT story from that domain is scored on those totals. Drives the REAL computeAffinities,
// and checks the sibling's ranking FEATURE, which is what the reader actually feels.
const m6 = await page.evaluate(async () => {
  const I = window.__hnlens.interactions();
  const F = window.__hnlens.features();
  const S = window.__hnlens.strategies();
  const { db } = await window.__hnlens.db();
  window.__hnlens.prefs.getState().set({ followedDomains: [], followedUsers: [], keywordsBoost: [], mutedDomains: [], mutedUsers: [], keywordsMute: [] });
  const at = { domain: 'rej.com', author: 'bob' };
  const t0 = Date.now() - 100_000;
  const ev = (type, off, extra) => ({ type, itemId: 11, ...at, ts: t0 + off, ...extra });
  const READ_TWICE = [ev('open_link', 1), ev('dwell', 2, { value: 80_000 }), ev('open_link', 3), ev('dwell', 4, { value: 80_000 })];
  const SAVED_READ = [ev('save', 1), ev('open_link', 2), ev('dwell', 3, { value: 80_000 })];
  const HIDE = ev('hide', 50);
  // Five bounces: clicked through and came straight back each time. Accrues -3.0, already worse than
  // a single rejection, and the story stays in the feed because a bounce is not a read.
  const BOUNCED = [1, 2, 3, 4, 5].flatMap((n) => [ev('open_link', n * 2), ev('dwell', n * 2 + 1, { value: 3000 })]);
  const UNHIDE = ev('unhide', 60);
  // A DIFFERENT story on the same domain and author — the one the rejection is meant to stop lifting.
  const sibling = { id: 12, by: 'bob', url: 'https://rej.com/other', title: 'A neutral headline', score: 0, descendants: 0, time: Math.floor(Date.now() / 1000) - 20 * 86400, type: 'story' };
  const run = async (evs, newestFirst) => {
    await I.clearAllData();
    const rows = [...evs].sort((a, c) => (newestFirst ? c.ts - a.ts : a.ts - c.ts));
    await db.events.bulkAdd(rows);
    const a = await I.computeAffinities();
    const fs = F.computeFeatures(sibling, S.makeContext(window.__hnlens.prefs.getState(), a));
    return {
      d: Math.round((a.domains['rej.com'] ?? 0) * 1e6) / 1e6,
      au: Math.round((a.authors.bob ?? 0) * 1e6) / 1e6,
      sibDom: Math.round(fs.domainAffinity * 1e6) / 1e6,
      sibAuth: Math.round(fs.authorAffinity * 1e6) / 1e6,
    };
  };
  // The classifier decides which items are rejected; it must agree in BOTH feed orders.
  const hiddenBoth = (evs) => {
    const ids = (arr) => [...I.classifyEngagement(arr).hidden].sort().join(',');
    const asc = [...evs].sort((a, c) => a.ts - c.ts);
    return { oldestFirst: ids(asc), newestFirst: ids([...asc].reverse()) };
  };
  return {
    readTwice: await run(READ_TWICE, true),
    readTwiceHidden: await run([...READ_TWICE, HIDE], true),
    readTwiceHiddenOldestFirst: await run([...READ_TWICE, HIDE], false),
    savedReadHidden: await run([...SAVED_READ, HIDE], true),
    hideOnly: await run([HIDE], true),
    bounced: await run(BOUNCED, true),
    bouncedHidden: await run([...BOUNCED, HIDE], true),
    undone: await run([...SAVED_READ, HIDE, UNHIDE], true),
    neverHidden: await run(SAVED_READ, true),
    undoneOldestFirst: await run([...SAVED_READ, HIDE, UNHIDE], false),
    classes: hiddenBoth([...READ_TWICE, HIDE]),
    classesUndone: hiddenBoth([...SAVED_READ, HIDE, UNHIDE]),
  };
});
console.log('  m6:', JSON.stringify(m6));
check(
  'PRECONDITION: without a rejection the same history IS positive (the fixture reaches the code)',
  m6.readTwice.d > 1 && m6.readTwice.sibDom > 0.1,
  JSON.stringify(m6.readTwice),
);
check(
  'a story read twice then rejected leaves NO positive domain affinity',
  m6.readTwiceHidden.d <= 0,
  JSON.stringify(m6.readTwiceHidden),
);
check(
  'a story read twice then rejected leaves NO positive author affinity',
  m6.readTwiceHidden.au <= 0,
  JSON.stringify(m6.readTwiceHidden),
);
check(
  'a story saved AND read then rejected leaves NO positive domain affinity',
  m6.savedReadHidden.d <= 0,
  JSON.stringify(m6.savedReadHidden),
);
// Rejecting a story must never make its domain look BETTER liked. Pinning a rejected item's
// contribution at exactly one rejection does that whenever the item had already accrued worse than
// one rejection: five bounces sit at -3.0, and "Not interested" would lift them to -2.5. That is the
// inversion the dwell-aware classifier exists to prevent, arriving from the opposite direction.
check(
  'rejecting an already-disliked story does not RAISE its domain affinity',
  m6.bouncedHidden.d <= m6.bounced.d,
  JSON.stringify({ before: m6.bounced.d, afterHide: m6.bouncedHidden.d }),
);
check(
  'rejecting an already-disliked story does not RAISE its author affinity',
  m6.bouncedHidden.au <= m6.bounced.au,
  JSON.stringify({ before: m6.bounced.au, afterHide: m6.bouncedHidden.au }),
);
check(
  'rejecting an already-disliked story does not lift a SIBLING story from it',
  m6.bouncedHidden.sibDom <= m6.bounced.sibDom,
  JSON.stringify({ before: m6.bounced.sibDom, afterHide: m6.bouncedHidden.sibDom }),
);
check(
  'a rejected story contributes the SAME as a bare rejection, whatever it accrued first',
  Math.abs(m6.readTwiceHidden.d - m6.hideOnly.d) < 1e-6 && Math.abs(m6.savedReadHidden.d - m6.hideOnly.d) < 1e-6,
  JSON.stringify({ readTwiceHidden: m6.readTwiceHidden.d, savedReadHidden: m6.savedReadHidden.d, hideOnly: m6.hideOnly.d }),
);
check(
  'a DIFFERENT story on the rejected domain is not ranked up by the rejected one',
  m6.readTwiceHidden.sibDom <= 0 && m6.readTwiceHidden.sibAuth <= 0,
  JSON.stringify(m6.readTwiceHidden),
);
// OPPOSITE CASE — the mirror-image failure this fix must not trade for: an Undo must restore the
// full history, not a clamped remnant.
check(
  'OPPOSITE: read+saved → hide → UNDO restores the never-hidden affinity exactly',
  Math.abs(m6.undone.d - m6.neverHidden.d) < 1e-9 && Math.abs(m6.undone.au - m6.neverHidden.au) < 1e-9 && m6.undone.d > 1,
  JSON.stringify({ undone: m6.undone, neverHidden: m6.neverHidden }),
);
// ORDER INDEPENDENCE — the log is fed newest-first here and oldest-first in train.ts.
check(
  'ORDER: a rejected story scores identically fed newest-first and oldest-first',
  JSON.stringify(m6.readTwiceHidden) === JSON.stringify(m6.readTwiceHiddenOldestFirst),
  JSON.stringify({ newestFirst: m6.readTwiceHidden, oldestFirst: m6.readTwiceHiddenOldestFirst }),
);
check(
  'ORDER: an UNDONE rejection scores identically in both orders',
  JSON.stringify(m6.undone) === JSON.stringify(m6.undoneOldestFirst),
  JSON.stringify({ newestFirst: m6.undone, oldestFirst: m6.undoneOldestFirst }),
);
check(
  'ORDER: the classifier reports the same rejected set in both orders',
  m6.classes.oldestFirst === m6.classes.newestFirst && m6.classes.oldestFirst === '11' &&
    m6.classesUndone.oldestFirst === m6.classesUndone.newestFirst && m6.classesUndone.oldestFirst === '',
  JSON.stringify({ hidden: m6.classes, undone: m6.classesUndone }),
);

await b.close();
console.log(`\n${fails.length === 0 ? 'RESULT: REASONS TEST PASS \u2713' : `RESULT: ${fails.length} FAILED`}`);
process.exit(fails.length ? 1 : 0);
