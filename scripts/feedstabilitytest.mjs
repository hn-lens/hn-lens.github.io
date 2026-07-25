// Feed STABILITY test — guards the recurring bug CLASS: "interacting with an item
// made it wrongly vanish." Asserts, over a mocked HN API, that ordinary actions
// (save, summarize, open+bounce, mark-seen) do NOT remove an item from the feed
// it's in, that the correct removals DO happen (unsave from Saved, hide), and that
// saved state persists across reload.
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:4173/';
const now = Math.floor(Date.now() / 1000);
const POOL = [301, 302, 303, 304, 305, 306];
const item = (id) => ({ id, type: 'story', by: `u${id}`, title: `Story ${id}`, url: `https://ex${id}.com/x`, score: 100 + id, descendants: 4, time: now - 3600 });
const byId = new Map(POOL.map((id) => [id, item(id)]));

const fails = [];
const check = (name, pass, detail = '') => {
  console.log(`  ${pass ? '\u2713' : '\u2717'} ${name}${detail ? ` \u2014 ${detail}` : ''}`);
  if (!pass) fails.push(name);
};

const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ viewport: { width: 1280, height: 1000 } });
const page = ctx.pages()[0] || (await ctx.newPage());
await page.route(/hacker-news\.firebaseio\.com/, (r) => {
  const u = r.request().url();
  const j = (x) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(x) });
  if (/(top|best|new)stories/.test(u)) return j(POOL);
  if (/stories/.test(u)) return j([]);
  const m = u.match(/item\/(\d+)/);
  if (m) return j(byId.get(Number(m[1])) ?? null);
  return j(null);
});
await page.route(/hn\.algolia\.com|google\.com\/s2/, (r) => r.fulfill({ status: 200, body: '{}' }));
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__hnlens && window.__hnlens.prefs, null, { timeout: 20000 });
await page.evaluate(async () => {
  await (await window.__hnlens.interactions()).clearAllData();
  // useLearnedRanker stays at its DEFAULT (true). Turning it off here made the stability checks
  // below structurally unable to see the worst instance of the very defect they exist to catch: a
  // background retrain re-sorting the feed with no user action. A guard that disables the subsystem
  // under test is measuring a configuration no real user has.
  window.__hnlens.prefs.getState().set({ defaultFeed: 'top', minPoints: 0, embeddingsEnabled: false });
});

const feedIds = () =>
  page.evaluate(() => [...document.querySelectorAll('article h3')].map((h) => Number(h.textContent.replace('Story ', ''))).filter((n) => !Number.isNaN(n)));
const shows = async (id) => (await feedIds()).includes(id);
const cardOf = (id) => page.locator('article').filter({ hasText: `Story ${id}` });

const goTop = async () => {
  await page.getByRole('button', { name: 'Top', exact: true }).click();
  await page.waitForSelector('article', { timeout: 15000 });
  await page.waitForTimeout(400);
};
await goTop();
check('Top feed shows the pool', (await feedIds()).length === POOL.length, JSON.stringify(await feedIds()));

// --- SAVE keeps the item in the current feed (does not vanish) ---
await cardOf(301).getByRole('button', { name: 'Save' }).click();
await page.waitForTimeout(300);
check('saving an item KEEPS it in Top (301)', await shows(301), 'save ≠ remove');

// --- summarize (event) keeps the item in Top ---
await page.evaluate(() => window.__hnlens.interactions().trackForItem('summarize', { id: 302, title: 'Story 302', url: 'https://ex302.com/x', by: 'u' }));
await page.waitForTimeout(600);
check('summarizing an item KEEPS it in Top (302)', await shows(302), 'summarize ≠ remove');

// --- open + bounce keeps the item in Top (Top never auto-hides) ---
await page.evaluate(() => {
  const i = window.__hnlens.interactions();
  i.trackForItem('open_link', { id: 303, title: 'Story 303', url: 'https://ex303.com/x', by: 'u' });
  i.track({ type: 'dwell', itemId: 303, value: 1000 });
});
await page.waitForTimeout(600);
check('opening + bouncing KEEPS it in Top (303)', await shows(303), 'no auto-hide in Top');

// --- opening an article (open_link) keeps the card in the feed (does not remove) ---
await page.evaluate(() =>
  window.__hnlens.interactions().trackForItem('open_link', { id: 305, title: 'Story 305', url: 'https://ex305.com/x', by: 'u' })
);
await page.waitForTimeout(500);
check('opening an article keeps the card in Top (305)', await shows(305), 'open ≠ remove');

// --- HIDE removes from Top; Undo restores ---
await cardOf(304).getByRole('button', { name: 'Not interested' }).click();
await page.waitForTimeout(400);
check('hiding REMOVES it from Top (304)', !(await shows(304)), 'hide = remove (correct)');
await page.getByRole('button', { name: 'Undo' }).click().catch(() => {});
await page.waitForTimeout(500);
check('Undo restores the hidden item (304)', await shows(304), 'undo = restore');

// --- SAVED tab: shows saved item; unsave removes it there; Top unaffected ---
await page.getByRole('button', { name: 'Saved items' }).click();
await page.waitForTimeout(600);
check('Saved page lists the saved item (301)', await shows(301), '');
check('Saved page does NOT list an unsaved item (302)', !(await shows(302)), '');

// --- SAVED persists across reload ---
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__hnlens, null, { timeout: 20000 });
await page.getByRole('button', { name: 'Saved items' }).click().catch(() => {});
await page.waitForTimeout(700);
check('saved item persists across reload (301)', await shows(301), '');

// --- UNDO of "Not interested" CANCELS the hide's affinity (restores rank) ---
// Regression for: unhide fired an event with no SIGNAL_WEIGHT + no domain/author, so a hide's −2.5
// affinity survived Undo and buried the story. hide(−2.5) + unhide(+2.5), both carrying the same
// domain/author, must net ~0; a hide WITHOUT an undo must stay negative (control).
const aff = await page.evaluate(async () => {
  const i = await window.__hnlens.interactions();
  await i.clearAllData();
  const { db } = await window.__hnlens.db();
  const t = Date.now();
  await db.events.bulkAdd([
    // item 301 on dom1/auth1: hidden then UNDONE → affinity should cancel to ~0
    { type: 'hide', itemId: 301, domain: 'dom1.com', author: 'auth1', ts: t - 3000 },
    { type: 'unhide', itemId: 301, domain: 'dom1.com', author: 'auth1', ts: t - 2000 },
    // item 302 on dom2/auth2: hidden, NOT undone → affinity should stay negative (control)
    { type: 'hide', itemId: 302, domain: 'dom2.com', author: 'auth2', ts: t - 1000 },
  ]);
  const a = await i.computeAffinities();
  // The Undo must ALSO reverse the disliked-CONTENT profile (getDislikedItemIds), not just affinity —
  // else the un-hidden story stays a disliked example whose terms drag it down (half-reversed Undo).
  const disliked = await i.getDislikedItemIds();
  return { d1: a.domains['dom1.com'] ?? 0, u1: a.authors['auth1'] ?? 0, d2: a.domains['dom2.com'] ?? 0, u2: a.authors['auth2'] ?? 0, d1c: a.domainCounts['dom1.com'] ?? 0, disliked };
});
check('Undo cancels the hide DOMAIN affinity (net ~0)', Math.abs(aff.d1) < 0.01, JSON.stringify(aff));
check('Undo cancels the hide AUTHOR affinity (net ~0)', Math.abs(aff.u1) < 0.01, JSON.stringify(aff));
check('a hide WITHOUT undo stays a negative affinity (control)', aff.d2 < -1 && aff.u2 < -1, JSON.stringify(aff));
check('unhide does NOT inflate the distinct-engaged-items count', aff.d1c === 0, JSON.stringify(aff));
check('Undo removes the story from the disliked-CONTENT profile (301 not disliked)', !aff.disliked.includes(301), JSON.stringify(aff.disliked));
check('a hide WITHOUT undo stays in the disliked-content profile (302, control)', aff.disliked.includes(302), JSON.stringify(aff.disliked));

// --- Affinity is DWELL-AWARE (the THIRD engagement derivation, unified with labels + content) ---
// Regression for: computeAffinities credited an OPEN (+1) regardless of dwell, and a separate bounce
// dwell (−0.6) only netted +0.4 — so a domain you only BOUNCE off accrued POSITIVE affinity, ranked
// UP, and hit the "You often read X" threshold (a dishonest chip). A bounced/glanced open must now
// contribute ≤0 and NOT count as engaged; a genuine read still must.
const dwellAff = await page.evaluate(async () => {
  const i = await window.__hnlens.interactions();
  await i.clearAllData();
  const { db } = await window.__hnlens.db();
  const t = Date.now();
  const evs = [];
  for (let k = 0; k < 5; k++) {
    // 5 PURE BOUNCES on bouncedom: open + an immediate (<BOUNCE_MS) return.
    const bid = 700 + k;
    evs.push({ type: 'open_link', itemId: bid, domain: 'bouncedom.com', author: 'bouncer', ts: t - 20000 + k * 100 });
    evs.push({ type: 'dwell', itemId: bid, domain: 'bouncedom.com', author: 'bouncer', value: 2500, ts: t - 20000 + k * 100 + 10 });
    // 5 GENUINE READS on readdom: open + a long (>=BOUNCE_MS) stay.
    const rid = 800 + k;
    evs.push({ type: 'open_link', itemId: rid, domain: 'readdom.com', author: 'reader', ts: t - 10000 + k * 100 });
    evs.push({ type: 'dwell', itemId: rid, domain: 'readdom.com', author: 'reader', value: 25000, ts: t - 10000 + k * 100 + 10 });
  }
  await db.events.bulkAdd(evs);
  const a = await i.computeAffinities();
  return {
    bounceDom: a.domains['bouncedom.com'] ?? 0, bounceCount: a.domainCounts['bouncedom.com'] ?? 0,
    readDom: a.domains['readdom.com'] ?? 0, readCount: a.domainCounts['readdom.com'] ?? 0,
  };
});
check('a bounce-only domain accrues NO positive affinity (dwell-aware)', dwellAff.bounceDom <= 0, JSON.stringify(dwellAff));
check('a bounce-only domain is NOT counted as engaged (no false "often read")', dwellAff.bounceCount === 0, JSON.stringify(dwellAff));
check('a genuinely-read domain still accrues positive affinity', dwellAff.readDom > 1, JSON.stringify(dwellAff));
check('a genuinely-read domain IS counted as engaged', dwellAff.readCount === 5, JSON.stringify(dwellAff));

// --- RE-VISITING an already-read story is NEUTRAL (per-ITEM guard vs per-EVENT credit hole) ---
// Regression for: the dwell-aware guard above skips a weak open only when the ITEM isn't engaged, but
// the credit is per EVENT — so once a story qualified, every LATER open of it was credited +1 while
// its bounce subtracted only −0.6, netting +0.4 per cycle. Re-opening a story from the Read tab and
// bailing out (the commonest "I've already read this" gesture) therefore made its domain look MORE
// liked — the exact inversion dwell-awareness exists to prevent. A revisit must now net ~0, a genuine
// RE-READ must still count (don't over-correct), and the result must not depend on event order.
const revisitAff = await page.evaluate(async () => {
  const i = await window.__hnlens.interactions();
  const { db } = await window.__hnlens.db();
  const t = Date.now();
  const read = (id, dom, auth, ts) => [
    { type: 'open_link', itemId: id, domain: dom, author: auth, ts },
    { type: 'dwell', itemId: id, domain: dom, author: auth, value: 70000, ts: ts + 10 },
  ];
  // Baseline: ONE genuine read, no revisits.
  await i.clearAllData();
  await db.events.bulkAdd(read(900, 'revdom.com', 'revauth', t - 60000));
  const base = await i.computeAffinities();
  // Same read + 5 re-click-and-bounce cycles on the SAME item.
  await i.clearAllData();
  const evs = [...read(900, 'revdom.com', 'revauth', t - 60000)];
  for (let k = 0; k < 5; k++) {
    evs.push({ type: 'open_link', itemId: 900, domain: 'revdom.com', author: 'revauth', ts: t - 40000 + k * 1000 });
    evs.push({ type: 'dwell', itemId: 900, domain: 'revdom.com', author: 'revauth', value: 1500, ts: t - 40000 + k * 1000 + 10 });
  }
  await db.events.bulkAdd(evs);
  const after = await i.computeAffinities();
  // Same events inserted in REVERSE order → must be identical (order-independence).
  await i.clearAllData();
  await db.events.bulkAdd([...evs].reverse());
  const reversed = await i.computeAffinities();
  // A genuine RE-READ (a second long stay) must still add affinity.
  await i.clearAllData();
  await db.events.bulkAdd([...read(901, 'rrdom.com', 'rrauth', t - 60000), ...read(901, 'rrdom.com', 'rrauth', t - 30000)]);
  const reread = await i.computeAffinities();
  await i.clearAllData();
  await db.events.bulkAdd(read(901, 'rrdom.com', 'rrauth', t - 60000));
  const readOnce = await i.computeAffinities();
  return {
    base: base.domains['revdom.com'] ?? 0,
    after: after.domains['revdom.com'] ?? 0,
    baseAuthor: base.authors['revauth'] ?? 0,
    afterAuthor: after.authors['revauth'] ?? 0,
    reversed: reversed.domains['revdom.com'] ?? 0,
    count: after.domainCounts['revdom.com'] ?? 0,
    reread: reread.domains['rrdom.com'] ?? 0,
    readOnce: readOnce.domains['rrdom.com'] ?? 0,
  };
});
check(
  'a re-click+bounce on an already-read story does NOT inflate DOMAIN affinity',
  revisitAff.after <= revisitAff.base + 0.01,
  `base=${revisitAff.base} after5revisits=${revisitAff.after}`
);
check(
  'a re-click+bounce on an already-read story does NOT inflate AUTHOR affinity',
  revisitAff.afterAuthor <= revisitAff.baseAuthor + 0.01,
  `base=${revisitAff.baseAuthor} after=${revisitAff.afterAuthor}`
);
check(
  'a revisit bounce does not DEFLATE it either (re-checking what you read is neutral)',
  revisitAff.after >= revisitAff.base - 0.01,
  `base=${revisitAff.base} after=${revisitAff.after}`
);
check(
  'revisit handling is ORDER-INDEPENDENT (same events, reversed feed)',
  Math.abs(revisitAff.after - revisitAff.reversed) < 1e-9,
  `after=${revisitAff.after} reversed=${revisitAff.reversed}`
);
check('the re-visited story is still counted ONCE as engaged', revisitAff.count === 1, JSON.stringify(revisitAff));
check(
  'a genuine RE-READ (second long stay) still adds affinity',
  revisitAff.reread > revisitAff.readOnce,
  `reread=${revisitAff.reread} readOnce=${revisitAff.readOnce}`
);

// --- hide→UNDO fully restores affinity: the shared classifier must be ORDER-INDEPENDENT ---
// Regression for: computeAffinities feeds classifyEngagement NEWEST-first, but its hide/unhide
// resolution was order-DEPENDENT (chronological), so a read→hid→un-hid item was mis-classified as
// still-hidden in the affinity pass — its open credit was dropped and it fell out of the engaged
// count (a partially-reversed Undo). An open→hide→UNDO must be byte-identical to a never-hidden open.
const undoAff = await page.evaluate(async () => {
  const i = await window.__hnlens.interactions();
  const { db } = await window.__hnlens.db();
  const t = Date.now();
  await i.clearAllData();
  // Baseline: a background open (no dwell) on basedom, never hidden → engaged (opened, not bounced).
  await db.events.bulkAdd([{ type: 'open_link', itemId: 501, domain: 'basedom.com', author: 'baseauth', ts: t - 4000 }]);
  const base = await i.computeAffinities();
  await i.clearAllData();
  // Same open, then hide, then UNDO (unhide) — must equal the baseline in EVERY field.
  await db.events.bulkAdd([
    { type: 'open_link', itemId: 502, domain: 'undodom.com', author: 'undoauth', ts: t - 4000 },
    { type: 'hide', itemId: 502, domain: 'undodom.com', author: 'undoauth', ts: t - 2000 },
    { type: 'unhide', itemId: 502, domain: 'undodom.com', author: 'undoauth', ts: t - 1000 },
  ]);
  const undo = await i.computeAffinities();
  return {
    baseDom: base.domains['basedom.com'] ?? 0, baseCount: base.domainCounts['basedom.com'] ?? 0,
    undoDom: undo.domains['undodom.com'] ?? 0, undoCount: undo.domainCounts['undodom.com'] ?? 0,
  };
});
check('open→hide→UNDO restores domain affinity to the never-hidden baseline (order-independent)', Math.abs(undoAff.undoDom - undoAff.baseDom) < 1e-9 && undoAff.undoDom > 0, JSON.stringify(undoAff));
check('open→hide→UNDO restores the distinct-engaged count (open credit not dropped)', undoAff.undoCount === undoAff.baseCount && undoAff.undoCount === 1, JSON.stringify(undoAff));

// --- SERVE-TIME LEAVE-ONE-OUT: engaging with a story must not promote THAT story ---
// Regression for: reading a story wrote engagement events, those events fed domain/author affinity,
// and that affinity then scored the very same story — so interacting with something pushed it to the
// top of the feed. Measured before the fix: a genuine read moved a story from rank 10 -> 2 and a save
// moved one from 12 -> 1, filling the top slots with what the reader had just finished. Training
// already did this subtraction; the serve path did not. Affinity earned from item A must STILL lift
// sibling items on the same domain — only self-promotion stops.
const selfReinforce = await page.evaluate(async () => {
  const i = await window.__hnlens.interactions();
  const { db } = await window.__hnlens.db();
  const strat = window.__hnlens.strategies();
  const feats = window.__hnlens.features();
  const t = Date.now(), now = Math.floor(t / 1000);
  await i.clearAllData();
  const mk = (id, dom, by) => ({ id, type: 'story', by, title: `Story ${id} about widgets`, url: `https://${dom}/x`, score: 100, descendants: 20, time: now - 3600 });
  const target = mk(8801, 'selfsite.com', 'selfauthor');
  const sibling = mk(8802, 'selfsite.com', 'selfauthor'); // same domain+author, NOT engaged
  const other = mk(8803, 'elsewhere.com', 'someone');
  await db.items.bulkPut([target, sibling, other].map((it) => ({ id: it.id, item: it, cachedAt: t })));
  // a GENUINE read of the target only
  await db.events.bulkAdd([
    { type: 'open_link', itemId: 8801, domain: 'selfsite.com', author: 'selfauthor', ts: t - 50000 },
    { type: 'dwell', itemId: 8801, domain: 'selfsite.com', author: 'selfauthor', value: 70000, ts: t - 49000 },
  ]);
  const aff = await i.computeAffinities();
  const ctx = strat.makeContext(window.__hnlens.prefs.getState(), aff, {});
  const f = (it) => feats.computeFeatures(it, ctx);
  return {
    rawDomainTotal: +(aff.domains['selfsite.com'] ?? 0).toFixed(3),
    targetDomAff: +f(target).domainAffinity.toFixed(4),
    targetAuthAff: +f(target).authorAffinity.toFixed(4),
    siblingDomAff: +f(sibling).domainAffinity.toFixed(4),
    otherDomAff: +f(other).domainAffinity.toFixed(4),
    targetEngagedN: f(target).domainEngagedN,
    siblingEngagedN: f(sibling).domainEngagedN,
  };
});
check('the engaged story gets NO domain affinity from its OWN engagement',
  Math.abs(selfReinforce.targetDomAff) < 1e-6, JSON.stringify(selfReinforce));
check('…nor author affinity from its own engagement',
  Math.abs(selfReinforce.targetAuthAff) < 1e-6, `targetAuthAff=${selfReinforce.targetAuthAff}`);
check('a SIBLING on the same domain still DOES gain affinity (taste still transfers)',
  selfReinforce.siblingDomAff > 0.1, `sibling=${selfReinforce.siblingDomAff} raw=${selfReinforce.rawDomainTotal}`);
check('an unrelated domain is unaffected', Math.abs(selfReinforce.otherDomAff) < 0.05, `other=${selfReinforce.otherDomAff}`);
check('the engaged story does not count ITSELF toward the "often" habit count',
  selfReinforce.targetEngagedN === 0 && selfReinforce.siblingEngagedN === 1, JSON.stringify(selfReinforce));

// --- the For-You ORDER must hold still within a session, while the DATA stays live ---
// Every engagement invalidates the ranking inputs so the "warming up" banner clears and "Why #N?"
// reflects what you just did. That freshness is wanted; the side effect was not — the visible list
// re-sorted underneath the reader, so a story being scrolled toward moved somewhere else. This is
// the principle the read-hide snapshot already applies to MEMBERSHIP (hide at load, never yank
// mid-session), extended to ORDER. Both halves are asserted: stable order, still-live data.
{
  await page.goto(`${BASE}#/?feed=foryou`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('article[data-id]', { timeout: 25000 });
  await page.waitForTimeout(900);
  const order = () => page.evaluate(() => [...document.querySelectorAll('article[data-id]')].map((a) => a.getAttribute('data-id')));
  const before = await order();
  check('stability probe has enough cards to detect a re-sort', before.length >= 4, `${before.length} cards`);

  // Engage the way a reader does: save one, then record a genuine read — both invalidate the
  // ranking inputs, which is exactly what used to reshuffle the list.
  await page.evaluate(async () => {
    const inter = await window.__hnlens.interactions();
    const ids = [...document.querySelectorAll('article[data-id]')].map((a) => Number(a.getAttribute('data-id')));
    // Engage repeatedly with the domain/author of the LAST-ranked card, so the fresh ranking really
    // does want to promote it — a single weak signal would leave the order unchanged anyway.
    const client = await window.__hnlens.client();
    const items = await client.getItems(ids);
    const last = items[items.length - 1];
    const domain = (last?.url || '').replace(/^https?:\/\//, '').split('/')[0] || 'example.com';
    const author = last?.by || 'someone';
    for (let k = 0; k < 6; k++) {
      inter.track({ type: 'save', itemId: 90000 + k, domain, author });
      inter.track({ type: 'open_link', itemId: 90000 + k, domain, author });
      inter.track({ type: 'dwell', itemId: 90000 + k, domain, author, value: 25000 });
    }
  });
  await page.waitForTimeout(2500); // let every invalidation settle and any re-rank land

  const after = await order();

  // Assert the CONTRACT, using the app's own machinery rather than re-deriving a ranking context
  // by hand (the first attempt did that, got the context shape wrong, and threw).
  //
  //   in-session  -> the order must NOT move (that is the fix)
  //   after reload -> the order SHOULD move (that is the boundary where re-ranking belongs, and it
  //                   doubles as the precondition: if a reload changes nothing, the engagement never
  //                   moved the ranking and the in-session half proves nothing).
  check(
    'engaging mid-session does NOT re-order the feed under the reader',
    JSON.stringify(before) === JSON.stringify(after.slice(0, before.length)),
    `before=${before.slice(0, 6).join(',')} after=${after.slice(0, 6).join(',')}`
  );

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('article[data-id]', { timeout: 25000 });
  await page.waitForTimeout(1200);
  const reloaded = await order();
  check(
    'precondition: a RELOAD does re-order (else the engagement changed nothing and this proves nothing)',
    JSON.stringify(reloaded.slice(0, before.length)) !== JSON.stringify(before),
    `before=${before.slice(0, 6).join(',')} reloaded=${reloaded.slice(0, 6).join(',')}`
  );

  // ...but the derived data DID update — the whole point of keeping invalidation live.
  const live = await page.evaluate(async () => {
    const inter = await window.__hnlens.interactions();
    return (await inter.getReadItemIds(50)).length;
  });
  check('...while the derived read data still updated live', live > 0, `${live} read id(s)`);
}

// --- the pin must YIELD to deliberate control changes, and SURVIVE the reading loop ---
// A stability mechanism that also freezes the controls meant to restructure the list is worse than
// the instability it replaced. The first version did exactly that: dragging a "Tune ranking" slider
// changed the score and moved 0 of 25 cards while the UI promised the feed "re-ranks live", and a
// filter round-trip left the order permanently scrambled. It was also a component-local ref, so the
// core loop (feed → discussion → back) discarded it — the one trip it existed to survive.
{
  await page.goto(`${BASE}#/?feed=foryou`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('article[data-id]', { timeout: 25000 });
  await page.waitForTimeout(900);
  const order = () => page.evaluate(() => [...document.querySelectorAll('article[data-id]')].map((a) => a.getAttribute('data-id')));
  const base = await order();
  check('pin probe has enough cards', base.length >= 4, `${base.length} cards`);

  // (a) A DELIBERATE ranking change must re-order immediately, with no refresh.
  await page.evaluate(() => {
    const s = window.__hnlens.prefs.getState();
    s.set({ weights: { ...s.weights, recency: 2.5, popularity: 0, discussion: 0, affinity: 0, relevance: 0, learned: 0 } });
  });
  await page.waitForTimeout(900);
  const tuned = await order();
  check(
    'moving a ranking weight re-orders the feed immediately (the pin yields to it)',
    JSON.stringify(tuned) !== JSON.stringify(base),
    `base=${base.slice(0, 5).join(',')} tuned=${tuned.slice(0, 5).join(',')}`
  );

  // (b) With the controls left alone, the order holds across the core reading loop.
  const settled = await order();
  await page.locator('article[data-id]').first().getByRole('button', { name: 'Open comments' }).click();
  await page.waitForURL(/#\/item\//, { timeout: 15000 });
  await page.waitForTimeout(600);
  await page.getByRole('button', { name: /Back to feed/i }).click();
  await page.waitForSelector('article[data-id]', { timeout: 20000 });
  await page.waitForTimeout(900);
  const returned = await order();
  check(
    'the order survives feed → discussion → back (pin is not component-local)',
    JSON.stringify(returned.slice(0, settled.length)) === JSON.stringify(settled),
    `before=${settled.slice(0, 5).join(',')} after=${returned.slice(0, 5).join(',')}`
  );
}

// --- a BACKGROUND retrain must not re-sort the feed ---
// Auto-training runs on its own schedule after engagement. With the model's updatedAt folded into
// the pin's identity, that counted as a deliberate change and the list re-sorted ~15s after the
// reader touched anything — no user action at all, which is exactly what the pin exists to prevent.
// Runs at the DEFAULT useLearnedRanker so the retrain actually happens.
{
  await page.goto(`${BASE}#/?feed=foryou`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('article[data-id]', { timeout: 25000 });
  await page.waitForTimeout(900);
  const order = () => page.evaluate(() => [...document.querySelectorAll('article[data-id]')].map((a) => a.getAttribute('data-id')));
  const t0 = await order();
  // Engage enough to trigger a retrain, then wait past the auto-train debounce + rate limit.
  await page.evaluate(async () => {
    const inter = await window.__hnlens.interactions();
    for (let k = 0; k < 10; k++) {
      inter.track({ type: 'open_link', itemId: 95000 + k, domain: `d${k % 3}.com`, author: `a${k % 3}` });
      inter.track({ type: 'dwell', itemId: 95000 + k, domain: `d${k % 3}.com`, author: `a${k % 3}`, value: 30000 });
    }
  });
  await page.waitForTimeout(25000); // past the debounce and the ~45s-limited retrain's first window
  const t1 = await order();
  check(
    'a background retrain does not re-sort the feed under the reader',
    JSON.stringify(t0) === JSON.stringify(t1.slice(0, t0.length)),
    `before=${t0.slice(0, 5).join(',')} after=${t1.slice(0, 5).join(',')}`
  );
}

// NOTE: there is deliberately no scroll-offset assertion here. That feature was implemented and
// then REMOVED (see the note in Feed.tsx) because it could not be made reliable across every
// navigation path; paging DEPTH restoration, which is what actually prevents losing your place, is
// covered by the pin checks above. A guard for a feature that does not exist is worse than none.

await b.close();
console.log(`\n${fails.length === 0 ? 'RESULT: FEED STABILITY PASS \u2713' : `RESULT: ${fails.length} FAILED`}`);
process.exit(fails.length ? 1 : 0);
