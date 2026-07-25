// Functional test for the "Read" tab — and the guarantee that For You NEVER
// destructively hides read stories.
//
// History (a real bug): an "auto-hide already-read from For You" feature was
// shipped, then REMOVED. Hiding live yanked a card out from under you mid-read;
// hiding via a load-time snapshot only updated on a manual refresh (looked broken).
// There is no good version of removal, so read state is surfaced by the Read tab
// (and fed to the ranker), never by deleting cards. This test asserts the Read tab
// is correct AND that reading a story leaves it in For You — in-session and after a
// reload (the negative that stops removal from ever creeping back).
//
// Drives the REAL app over a mocked HN API — asserts concrete ids, not "it renders".
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:4173/';
const now = Math.floor(Date.now() / 1000);
const POOL = [11, 12, 13, 14, 15, 16, 17, 18];
const item = (id) => ({ id, type: 'story', by: 'u', title: `Story ${id}`, url: `https://ex${id}.com/x`, score: 100 + id, descendants: 10 + id, time: now - 3600 });
const byId = new Map(POOL.map((id) => [id, item(id)]));

const fails = [];
const check = (name, pass, detail) => {
  console.log(`  ${pass ? '\u2713' : '\u2717'} ${name}${detail ? ` \u2014 ${detail}` : ''}`);
  if (!pass) fails.push(name);
};
const titles = (page) => page.evaluate(() => [...document.querySelectorAll('article h3')].map((h) => h.textContent.trim()));
const idsFrom = (ts) => ts.map((t) => Number(t.replace('Story ', ''))).filter((n) => !Number.isNaN(n)).sort((a, b) => a - b);

const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ viewport: { width: 1280, height: 1000 } });
const page = ctx.pages()[0] || (await ctx.newPage());
await page.route(/hacker-news\.firebaseio\.com/, (r) => {
  const u = r.request().url();
  const j = (x) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(x) });
  if (/topstories|beststories|newstories/.test(u)) return j(POOL);
  const m = u.match(/item\/(\d+)/);
  if (m) return j(byId.get(Number(m[1])) ?? null);
  return j(null);
});
await page.route(/hn\.algolia\.com|google\.com\/s2/, (r) => r.fulfill({ status: 200, body: '{}' }));

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__hnlens && window.__hnlens.prefs, null, { timeout: 20000 });

// ---- seed a known read history ----
// read = {11,12,14}: opened 11,12,13 (13 bounced); opened comments on 14.
// 15 saved and 16 summarized — those must NOT count as read. 17,18 untouched.
const seeded = await page.evaluate(async () => {
  const [{ db }, interactions] = await Promise.all([window.__hnlens.db(), window.__hnlens.interactions()]);
  await interactions.clearAllData();
  window.__hnlens.prefs.getState().set({ useLearnedRanker: false, embeddingsEnabled: false, defaultFeed: 'foryou', minPoints: 0 });
  const ms = Date.now();
  await db.events.bulkAdd([
    { type: 'open_link', itemId: 11, domain: 'ex11.com', ts: ms - 5000 },
    { type: 'open_link', itemId: 12, domain: 'ex12.com', ts: ms - 4000 },
    { type: 'open_link', itemId: 13, domain: 'ex13.com', ts: ms - 3000 },
    { type: 'dwell', itemId: 13, domain: 'ex13.com', value: 2000, ts: ms - 2500 }, // bounce ⇒ 13 not read
    // 14: opened the discussion AND STAYED (dwell ≥ BOUNCE_MS) ⇒ read
    { type: 'open_comments', itemId: 14, domain: 'ex14.com', ts: ms - 2000 },
    { type: 'dwell', itemId: 14, domain: 'ex14.com', value: 12000, ts: ms - 1900, meta: { where: 'comments' } },
    // 19: opened the discussion but GLANCED and left (no stay) ⇒ NOT read
    { type: 'open_comments', itemId: 19, domain: 'ex19.com', ts: ms - 1700 },
    { type: 'save', itemId: 15, domain: 'ex15.com', ts: ms - 1500 }, // saved ≠ read
    { type: 'summarize', itemId: 16, domain: 'ex16.com', ts: ms - 1000 }, // summarized ≠ read
    // Synthetic HN-history import: open_link (your post) + open_comments (a thread you
    // commented on). These are personalization SIGNALS, NOT in-app reads.
    { type: 'open_link', itemId: 17, domain: 'ex17.com', ts: ms - 900, meta: { source: 'hn_import' } },
    { type: 'open_comments', itemId: 18, domain: 'ex18.com', ts: ms - 800, meta: { source: 'hn_import' } },
  ]);
  return interactions.getReadItemIds(500);
});
console.log('\n[read] getReadItemIds:', JSON.stringify(seeded));
const readSorted = [...seeded].sort((a, b) => a - b).join();
check('getReadItemIds = opened-article(non-bounce) + stayed-on-discussion', readSorted === '11,12,14', JSON.stringify(seeded));
check('staying on a discussion marks read (14 included)', seeded.includes(14), JSON.stringify(seeded));
check('GLANCING a discussion does NOT mark read (19 excluded)', !seeded.includes(19), JSON.stringify(seeded));
check('saving does NOT mark read (15 excluded)', !seeded.includes(15), JSON.stringify(seeded));
check('summarizing does NOT mark read (16 excluded)', !seeded.includes(16), JSON.stringify(seeded));
check('a bounce does NOT mark read (13 excluded)', !seeded.includes(13), JSON.stringify(seeded));
check('IMPORTED open_link is NOT read (17 excluded)', !seeded.includes(17), JSON.stringify(seeded));
check('IMPORTED open_comments is NOT read (18 excluded)', !seeded.includes(18), JSON.stringify(seeded));

// ---- Read tab lists exactly the read stories ----
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__hnlens, null, { timeout: 20000 });
await page.getByRole('button', { name: 'Read', exact: true }).click();
await page.waitForFunction(() => document.querySelector('article') || /Nothing to show/i.test(document.body.innerText), null, { timeout: 15000 });
await page.waitForTimeout(500);
const readIds = idsFrom(await titles(page));
console.log('[read] Read tab shows:', JSON.stringify(readIds));
check('Read tab lists the read stories (11,12,14)', readIds.join() === '11,12,14', JSON.stringify(readIds));
check('Read tab excludes the bounced story (13)', !readIds.includes(13), '');
check('Read tab is NOT just the For-You pool', !readIds.includes(15) && !readIds.includes(16), JSON.stringify(readIds));

// ---- For You HIDES already-read stories (load-time snapshot), but NOT in-session ----
// After a refresh, stories read BEFORE this load (11,12,14) drop out of For You (they
// live in the Read tab). Non-read pool items (13 bounced, 15 saved, 16 summarized,
// 17/18 imported) are NOT read, so they stay. Then we prove in-session STABILITY:
// reading an item mid-session does NOT yank it out; only the next refresh drops it.
await page.getByRole('button', { name: 'For You' }).first().click();
await page.waitForSelector('article', { timeout: 15000 });
await page.waitForTimeout(700);
const fyIds = idsFrom(await titles(page));
console.log('[read] For You shows:', JSON.stringify(fyIds));
check('For You HIDES already-read stories after refresh (11,12,14 gone)', ![11, 12, 14].some((id) => fyIds.includes(id)), JSON.stringify(fyIds));
check('For You still shows NON-read pool items (13,15,16,17,18)', [13, 15, 16, 17, 18].every((id) => fyIds.includes(id)), JSON.stringify(fyIds));
check('read stories are NOT duplicated across For You + Read tab', ![11, 12, 14].some((id) => fyIds.includes(id)) && readIds.join() === '11,12,14', JSON.stringify({ fyIds, readIds }));
// For You must SAY how many already-read stories it's holding back (transparency —
// stories shouldn't appear to silently vanish). 11,12,14 are read + in the pool.
const fyText = await page.evaluate(() => document.querySelector('.app-content')?.innerText ?? document.body.innerText);
const readHidNote = fyText.match(/(\d+)\s+already-read/i);
check('For You notes how many already-read stories are hidden', !!readHidNote && Number(readHidNote[1]) === 3, readHidNote?.[0] ?? 'no note');

// ---- Sidebar "Recently read" panel shows ONLY read stories (not summarized/saved/bounced) ----
// This is the surface that shipped the bug: it used engagement, not the read definition.
// Wait for the panel to actually populate (it fetches read-item titles async) rather
// than a fixed sleep — otherwise this is timing-flaky.
// Wait for the panel to populate. Use innerText (line-separated) + includes — NOT
// textContent + \b: textContent concatenates the title with the following signals
// count ("Story 11" + "199 signals"), so \b never matches and this flakes.
await page.waitForFunction(
  () => (document.querySelector('.app-sidebar')?.innerText ?? '').includes('Story 11'),
  null,
  { timeout: 15000 }
);
const sidebar = await page.evaluate(() => document.querySelector('.app-sidebar')?.innerText ?? '');
const inSidebar = (id) => new RegExp(`Story ${id}\\b`).test(sidebar);
check('sidebar "Recently read" lists read stories (11,12,14)', inSidebar(11) && inSidebar(12) && inSidebar(14), '');
check('sidebar "Recently read" EXCLUDES summarized story (16)', !inSidebar(16), 'summarize ≠ read');
check('sidebar "Recently read" EXCLUDES saved story (15)', !inSidebar(15), 'save ≠ read');
check('sidebar "Recently read" EXCLUDES bounced story (13)', !inSidebar(13), 'bounce ≠ read');
check('sidebar "Recently read" EXCLUDES imported post (17)', !inSidebar(17), 'hn_import ≠ read');
check('sidebar "Recently read" EXCLUDES imported discussion (18)', !inSidebar(18), 'hn_import ≠ read');

// ---- reading a card in-session must NEVER remove it (the exact dead-end failure) ----
// Read a previously-UNREAD story (17) live: it must stay put, not vanish under the reader.
const target = 17;
await page.evaluate((id) => {
  const it = { id, title: `Story ${id}`, url: `https://ex${id}.com/x`, by: 'u' };
  const i = window.__hnlens.interactions();
  i.trackForItem('open_link', it);
  i.trackForItem('open_comments', it);
}, target);
await page.waitForTimeout(1200);
const afterEngage = idsFrom(await titles(page));
console.log(`[read] read story ${target} in-session; For You now:`, JSON.stringify(afterEngage));
check('reading a card in-session does NOT make it vanish', afterEngage.includes(target), `story ${target}`);

// ---- but AFTER a refresh, the now-read story drops out of For You (snapshot recomputed) ----
await page.reload({ waitUntil: 'domcontentloaded' });
await page.getByRole('button', { name: 'For You' }).first().click().catch(() => {});
await page.waitForSelector('article', { timeout: 15000 });
await page.waitForTimeout(700);
const afterReload = idsFrom(await titles(page));
console.log('[read] For You after reading + full reload:', JSON.stringify(afterReload));
check('after refresh, the now-read story drops out of For You (17 gone)', !afterReload.includes(target), `story ${target}`);

// ---- the story we just read IS now in the Read tab (read state still tracked) ----
await page.getByRole('button', { name: 'Read', exact: true }).click();
await page.waitForSelector('article', { timeout: 15000 });
await page.waitForTimeout(500);
const readIds2 = idsFrom(await titles(page));
console.log('[read] Read tab after reading 17:', JSON.stringify(readIds2));
check('now-read story (17) appears in the Read tab', readIds2.includes(target), JSON.stringify(readIds2));

// ---- with hideReadInFeed OFF, read stories are NOT hidden from For You ----
await page.evaluate(() => window.__hnlens.prefs.getState().set({ hideReadInFeed: false }));
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__hnlens, null, { timeout: 20000 });
await page.getByRole('button', { name: 'For You' }).first().click().catch(() => {});
await page.waitForSelector('article', { timeout: 15000 });
await page.waitForTimeout(700);
const fyOff = idsFrom(await titles(page));
check('hideReadInFeed OFF: read stories remain in For You (11 & 17 shown)', fyOff.includes(11) && fyOff.includes(17), JSON.stringify(fyOff));

// ============================================================================
// F2 — the Read tab is a HISTORY: a story you genuinely READ and LATER marked "Not
// interested" (hidden) is KEPT on BOTH read surfaces (the downvote shapes future ranking,
// it doesn't erase the record that you read it). The two surfaces still AGREE — both keep
// it. (Global mutes/min-points still exclude — see F2b.)
// ============================================================================
await page.evaluate(async () => {
  const [{ db }, interactions] = await Promise.all([window.__hnlens.db(), window.__hnlens.interactions()]);
  await interactions.clearAllData();
  window.__hnlens.prefs.getState().set({ useLearnedRanker: false, embeddingsEnabled: false, defaultFeed: 'top', minPoints: 0, hideReadInFeed: false });
  const ms = Date.now();
  await db.events.bulkAdd([
    { type: 'open_link', itemId: 11, domain: 'ex11.com', ts: ms - 5000 },
    { type: 'dwell', itemId: 11, domain: 'ex11.com', value: 12000, ts: ms - 4900 }, // 11 genuinely read
    { type: 'open_link', itemId: 12, domain: 'ex12.com', ts: ms - 4000 },
    { type: 'dwell', itemId: 12, domain: 'ex12.com', value: 12000, ts: ms - 3900 }, // 12 genuinely read
  ]);
  await db.hidden.put({ id: 11, ts: ms }); // 11 is READ *and* HIDDEN
  location.hash = '#/'; // drop any stale ?feed= param so reload lands on defaultFeed
});
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__hnlens, null, { timeout: 20000 });
await page.getByRole('button', { name: 'Read', exact: true }).click();
await page.waitForFunction(() => document.querySelector('article') || /No reading history|Nothing to show/i.test(document.body.innerText), null, { timeout: 15000 });
await page.waitForTimeout(400);
const f2ReadIds = idsFrom(await titles(page));
check('F2: Read tab KEEPS a read story even after it is marked Not interested (11)', f2ReadIds.includes(11), JSON.stringify(f2ReadIds));
check('F2: Read tab shows the other read story (12)', f2ReadIds.includes(12), JSON.stringify(f2ReadIds));
await page.waitForFunction(
  () => (document.querySelector('.app-sidebar')?.innerText ?? '').includes('Story 12'),
  null,
  { timeout: 15000 }
);
const f2Sidebar = await page.evaluate(() => document.querySelector('.app-sidebar')?.innerText ?? '');
check('F2: sidebar "Recently read" KEEPS the read+hidden story (11) — agrees with Read tab', /Story 11\b/.test(f2Sidebar), '');
check('F2: sidebar "Recently read" shows the other read story (12)', /Story 12\b/.test(f2Sidebar), '');

// ============================================================================
// F2b — the two read surfaces must also AGREE under a global MUTE / min-points filter,
// not just under Hide. Global filters (muted domain/user/keyword, min-points) apply to
// the Read tab (useFeed's isFiltered); the sidebar "Recently read" (recentRead) must
// apply them too, or a read story from a muted domain shows in the sidebar but not the
// Read tab. (F2 only covered Hide; recentRead used to skip only db.hidden.)
// ============================================================================
await page.evaluate(async () => {
  const [{ db }, interactions] = await Promise.all([window.__hnlens.db(), window.__hnlens.interactions()]);
  await interactions.clearAllData();
  // ex11.com is MUTED; both 11 and 12 are genuinely read.
  window.__hnlens.prefs.getState().set({ useLearnedRanker: false, embeddingsEnabled: false, defaultFeed: 'top', minPoints: 0, hideReadInFeed: false, mutedDomains: ['ex11.com'], mutedUsers: [], keywordsMute: [] });
  const ms = Date.now();
  await db.events.bulkAdd([
    { type: 'open_link', itemId: 11, domain: 'ex11.com', ts: ms - 5000 },
    { type: 'dwell', itemId: 11, domain: 'ex11.com', value: 12000, ts: ms - 4900 }, // 11 read (muted domain)
    { type: 'open_link', itemId: 12, domain: 'ex12.com', ts: ms - 4000 },
    { type: 'dwell', itemId: 12, domain: 'ex12.com', value: 12000, ts: ms - 3900 }, // 12 read (not muted)
  ]);
  location.hash = '#/';
});
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__hnlens, null, { timeout: 20000 });
await page.getByRole('button', { name: 'Read', exact: true }).click();
await page.waitForFunction(() => document.querySelector('article') || /No reading history|Nothing to show|filters are hiding/i.test(document.body.innerText), null, { timeout: 15000 });
await page.waitForTimeout(400);
const f2bReadIds = idsFrom(await titles(page));
check('F2b: Read tab EXCLUDES a read story from a MUTED domain (11)', !f2bReadIds.includes(11), JSON.stringify(f2bReadIds));
check('F2b: Read tab still shows the read, non-muted story (12)', f2bReadIds.includes(12), JSON.stringify(f2bReadIds));
await page.waitForFunction(
  () => (document.querySelector('.app-sidebar')?.innerText ?? '').includes('Story 12'),
  null,
  { timeout: 15000 }
);
const f2bSidebar = await page.evaluate(() => document.querySelector('.app-sidebar')?.innerText ?? '');
check('F2b: sidebar "Recently read" EXCLUDES the muted-domain read (11) — agrees with Read tab', !/Story 11\b/.test(f2bSidebar), '');
check('F2b: sidebar "Recently read" shows the non-muted read (12)', /Story 12\b/.test(f2bSidebar), '');

// ============================================================================
// F3 — the read-hide snapshot is a true LOAD-TIME snapshot (primed once at startup
// in main.tsx), NOT captured lazily on the first For-You mount / first toggle. So a
// story read MID-SESSION is never yanked out of For You, regardless of the landing
// feed or when the pref flips. Old lazy capture failed both cases below.
// ============================================================================
// (a) Toggling hideReadInFeed ON mid-session must NOT yank a story read this session
//     (the load-time snapshot was captured — empty — before the read happened).
await page.evaluate(async () => {
  await (await window.__hnlens.interactions()).clearAllData(); // NO read history at load
  // Clear any mutes left over from F2b (Zustand set() merges) so story 11 isn't filtered.
  window.__hnlens.prefs.getState().set({ useLearnedRanker: false, embeddingsEnabled: false, defaultFeed: 'foryou', minPoints: 0, hideReadInFeed: false, mutedDomains: [], mutedUsers: [], keywordsMute: [] });
  location.hash = '#/'; // land on defaultFeed (For You), not a stale ?feed= param
});
await page.reload({ waitUntil: 'domcontentloaded' }); // ['readSnapshot'] primed EMPTY at load
await page.waitForFunction(() => window.__hnlens, null, { timeout: 20000 });
await page.waitForSelector('article', { timeout: 15000 });
await page.evaluate(() => window.__hnlens.interactions().trackForItem('open_link', { id: 12, title: 'Story 12', url: 'https://ex12.com/x', by: 'u' }));
await page.waitForTimeout(400);
check('F3(a): story read mid-session is visible before toggling (12)', idsFrom(await titles(page)).includes(12), '');
await page.evaluate(() => window.__hnlens.prefs.getState().set({ hideReadInFeed: true })); // flip ON, NO reload
await page.waitForTimeout(700);
const f3aIds = idsFrom(await titles(page));
check('F3(a): toggling hideReadInFeed ON does NOT yank a mid-session read (12 stays)', f3aIds.includes(12), JSON.stringify(f3aIds));

// (b) When For You is NOT the default feed, a story read this session (before opening
//     For You) must still be visible the first time For You is opened this session.
await page.evaluate(async () => {
  await (await window.__hnlens.interactions()).clearAllData(); // NO read history at load
  window.__hnlens.prefs.getState().set({ useLearnedRanker: false, embeddingsEnabled: false, defaultFeed: 'top', minPoints: 0, hideReadInFeed: true });
  location.hash = '#/'; // land on defaultFeed (Top), not a stale ?feed= param
});
await page.reload({ waitUntil: 'domcontentloaded' }); // ['readSnapshot'] primed EMPTY at load
await page.waitForFunction(() => window.__hnlens, null, { timeout: 20000 });
await page.waitForSelector('article', { timeout: 15000 }); // lands on Top
await page.evaluate(() => window.__hnlens.interactions().trackForItem('open_link', { id: 11, title: 'Story 11', url: 'https://ex11.com/x', by: 'u' }));
await page.waitForTimeout(400);
await page.getByRole('button', { name: 'For You' }).first().click(); // open For You for the FIRST time
await page.waitForSelector('article', { timeout: 15000 });
await page.waitForTimeout(700);
const f3bIds = idsFrom(await titles(page));
check('F3(b): mid-session read is NOT hidden when For You is opened late (11 present)', f3bIds.includes(11), JSON.stringify(f3bIds));

// ---- Read tab empty state must NOT misdiagnose "no history" as a filter problem ----
// (self-contained: clears history + reloads, so it doesn't perturb the checks above)
await page.evaluate(async () => {
  await (await window.__hnlens.interactions()).clearAllData();
  window.__hnlens.prefs.getState().set({ minPoints: 0, mutedDomains: [], mutedUsers: [], keywordsMute: [] });
});
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__hnlens, null, { timeout: 20000 });
await page.getByRole('button', { name: 'Read', exact: true }).click();
await page.waitForFunction(() => /No reading history|Nothing to show/i.test(document.body.innerText), null, { timeout: 15000 });
await page.waitForTimeout(300);
const emptyText = await page.evaluate(() => document.querySelector('main')?.innerText ?? '');
check('Read empty state says "no reading history" (not a filter problem)', /No reading history/i.test(emptyText), emptyText.replace(/\s+/g, ' ').slice(0, 120));
check('Read empty state does NOT blame filters / "Check filters"', !/Check filters/i.test(emptyText) && !/filters.*hiding/i.test(emptyText), emptyText.replace(/\s+/g, ' ').slice(0, 120));

// ---- Cold-start: a brand-new For You (no history/follows/model) SAYS it's warming up
// instead of showing a hollow "why" on every popularity-ranked card. ----
await page.evaluate(async () => {
  await (await window.__hnlens.interactions()).clearAllData();
  window.__hnlens.prefs.getState().set({ defaultFeed: 'foryou', useLearnedRanker: false, followedDomains: [], followedUsers: [], keywordsBoost: [], minPoints: 0, hideReadInFeed: true });
  location.hash = '#/';
});
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__hnlens, null, { timeout: 20000 });
await page.waitForSelector('article', { timeout: 15000 });
await page.waitForTimeout(500);
const coldText = await page.evaluate(() => document.querySelector('.app-content')?.innerText ?? document.body.innerText);
check('cold-start For You shows a "warming up" banner (not a hollow why on every card)', /warming up/i.test(coldText), coldText.slice(0, 90));
// After a real engagement (a save → domain affinity), For You is personalized → banner gone.
await page.evaluate(() => window.__hnlens.interactions().trackForItem('save', { id: 11, title: 'Story 11', url: 'https://ex11.com/x', by: 'u' }));
await page.reload({ waitUntil: 'domcontentloaded' }); // affinities query is cached ~30s; remount recomputes
await page.waitForFunction(() => window.__hnlens, null, { timeout: 20000 });
await page.waitForSelector('article', { timeout: 15000 });
await page.waitForTimeout(500);
const warmText = await page.evaluate(() => document.querySelector('.app-content')?.innerText ?? document.body.innerText);
check('after a real engagement, the "warming up" banner is gone (personalized)', !/warming up/i.test(warmText), warmText.slice(0, 90));

// ---- Switching FROM a populated feed TO an EMPTY one must NOT show the previous
// feed's stale cards. itemsQ uses keepPreviousData; an empty target feed disables the
// query (sliceCount 0), so React Query kept returning the PRIOR feed's items forever,
// masking the empty state and leaving stale, interactive cards. ----
await page.evaluate(async () => {
  await (await window.__hnlens.interactions()).clearAllData(); // NO read history
  window.__hnlens.prefs.getState().set({ defaultFeed: 'top', minPoints: 0, mutedDomains: [], mutedUsers: [], keywordsMute: [] });
  location.hash = '#/';
});
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__hnlens, null, { timeout: 20000 });
await page.getByRole('button', { name: 'Top', exact: true }).click();
await page.waitForSelector('article', { timeout: 15000 }); // Top is populated (POOL)
await page.waitForTimeout(300);
const topBefore = idsFrom(await titles(page));
await page.getByRole('button', { name: 'Read', exact: true }).click();
await page.waitForFunction(
  () => /No reading history|Nothing to show/i.test(document.body.innerText) || document.querySelector('article'),
  null,
  { timeout: 15000 }
);
await page.waitForTimeout(400);
const readAfter = idsFrom(await titles(page));
console.log('[read] Top before:', JSON.stringify(topBefore), '→ empty Read shows:', JSON.stringify(readAfter));
check('empty Read (opened from a populated Top) shows NO stale Top cards', readAfter.length === 0, JSON.stringify(readAfter));
check('empty Read shows the "no reading history" empty state', /No reading history/i.test(await page.evaluate(() => document.querySelector('main')?.innerText ?? '')), '');

// ---- Read order = newest-READ first, NOT last-seen: merely SEEING a card (an
// `impression`, which fires on any visible card, incl. on the Read tab and Top/New)
// must not re-sort a previously-read story to the top. ----
const order = await page.evaluate(async () => {
  const [{ db }, interactions] = await Promise.all([window.__hnlens.db(), window.__hnlens.interactions()]);
  await interactions.clearAllData();
  const base = Date.now();
  const hr = 3600_000;
  await db.events.bulkAdd([
    { type: 'open_link', itemId: 101, ts: base - 3 * hr }, // read 3h ago
    { type: 'open_link', itemId: 102, ts: base - 2 * hr }, // read 2h ago
    { type: 'open_link', itemId: 103, ts: base - 1 * hr }, // read 1h ago (newest read)
  ]);
  const before = await interactions.getReadItemIds(10);
  await db.events.add({ type: 'impression', itemId: 101, ts: base }); // just SAW the oldest-read now
  const after = await interactions.getReadItemIds(10);
  return { before, after };
});
check('Read order is newest-READ first (103,102,101)', order.before.join() === '103,102,101', JSON.stringify(order.before));
check('an impression (merely seeing) does NOT reorder read history', order.after.join() === '103,102,101', JSON.stringify(order.after));

// A bounced RE-VISIT of a genuinely-read story must NOT reorder it to the top: order is
// by GENUINE read time (a >=BOUNCE stay), and a bounce (open + short dwell) is not a read.
const orderF1 = await page.evaluate(async () => {
  const [{ db }, interactions] = await Promise.all([window.__hnlens.db(), window.__hnlens.interactions()]);
  await interactions.clearAllData();
  const base = Date.now();
  const hr = 3600_000;
  await db.events.bulkAdd([
    { type: 'open_link', itemId: 203, ts: base - 3 * hr }, { type: 'dwell', itemId: 203, value: 12000, ts: base - 3 * hr + 9000 },
    { type: 'open_link', itemId: 204, ts: base - 2 * hr }, { type: 'dwell', itemId: 204, value: 12000, ts: base - 2 * hr + 9000 },
    { type: 'open_link', itemId: 205, ts: base - 1 * hr }, { type: 'dwell', itemId: 205, value: 12000, ts: base - 1 * hr + 9000 },
  ]);
  const before = await interactions.getReadItemIds(10); // genuine reads → [205,204,203]
  await db.events.bulkAdd([
    { type: 'open_link', itemId: 203, ts: base }, // re-visit the OLDEST-read now …
    { type: 'dwell', itemId: 203, value: 2000, ts: base + 2000 }, // … and BOUNCE (dwell < 8s)
  ]);
  const after = await interactions.getReadItemIds(10);
  return { before, after };
});
check('read-order uses genuine READ time (good dwells) — [205,204,203]', orderF1.before.join() === '205,204,203', JSON.stringify(orderF1.before));
check('a bounced re-visit does NOT reorder a read story to the top (stays [205,204,203])', orderF1.after.join() === '205,204,203', JSON.stringify(orderF1.after));
check('the bounced-revisited story stays READ (monotonic)', orderF1.after.includes(203), JSON.stringify(orderF1.after));

// ---- [G] the Read tab must update LIVE, and must AGREE with the sidebar on the same screen ----
// Regression for: `itemsQ`'s cache key was `['items', kind, sliceCount]` — the COUNT, never the ids.
// `main.tsx` invalidates ['readIds'] so the id list updated, but whenever the ids changed CONTENT
// without changing the sliced length, React Query served the stale cached array. So an in-session
// re-read reordered nothing, and (with >=25 items of history) a brand-new read was MISSING entirely
// while the sidebar's "Recently read" beside it listed it correctly. `refetchOnWindowFocus` is off,
// so there was no in-place recovery. The prior version of this test only asserted across a RELOAD,
// which is exactly why it never saw the surface the user actually looks at.
await page.evaluate(async () => {
  const [{ db }, interactions] = await Promise.all([window.__hnlens.db(), window.__hnlens.interactions()]);
  await interactions.clearAllData();
  window.__hnlens.prefs.getState().set({ defaultFeed: 'read', hideReadInFeed: false, minPoints: 0, showTopComments: false });
  const t = Date.now();
  // 30 genuine reads → history is longer than the 25-item first slice.
  const evs = [];
  for (let k = 0; k < 30; k++) {
    const id = 1200 + k;
    await db.items.put({ id, item: { id, type: 'story', by: `a${id}`, title: `Story ${id}`, url: `https://d${id}.com/x`, score: 30, descendants: 2, time: Math.floor(t / 1000) - 3600 }, cachedAt: t });
    evs.push({ type: 'open_link', itemId: id, domain: `d${id}.com`, author: `a${id}`, ts: t - 500000 + k * 1000 });
    evs.push({ type: 'dwell', itemId: id, domain: `d${id}.com`, author: `a${id}`, value: 70000, ts: t - 499000 + k * 1000 });
  }
  await db.events.bulkAdd(evs);
  location.hash = '#/?feed=read';
});
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('article', { timeout: 15000 });
// Now read a BRAND-NEW story in-session (no reload afterwards).
await page.evaluate(async () => {
  const [{ db }, interactions] = await Promise.all([window.__hnlens.db(), window.__hnlens.interactions()]);
  const t = Date.now();
  const id = 1299;
  await db.items.put({ id, item: { id, type: 'story', by: 'anew', title: `Story ${id}`, url: 'https://dnew.com/x', score: 40, descendants: 3, time: Math.floor(t / 1000) - 600 }, cachedAt: t });
  interactions.track({ type: 'open_link', itemId: id, domain: 'dnew.com', author: 'anew', ts: t - 20000 });
  interactions.track({ type: 'dwell', itemId: id, domain: 'dnew.com', author: 'anew', value: 70000, ts: t - 10000 });
});
await page.waitForTimeout(1200);
const liveTitles = await titles(page);
const liveIds = liveTitles.map((x) => Number(x.replace('Story ', '')));
const fnIds = await page.evaluate(async () => (await window.__hnlens.interactions()).getReadItemIds());
check('an in-session read appears in the Read tab WITHOUT a reload', liveIds.includes(1299), `first5=${JSON.stringify(liveIds.slice(0, 5))}`);
check('the Read tab agrees with getReadItemIds (newest-read first)', liveIds[0] === fnIds[0], `dom=${liveIds[0]} fn=${fnIds[0]}`);
const sidebarHas = await page.evaluate(() => /Story 1299/.test(document.querySelector('.app-sidebar')?.innerText ?? ''));
check('the Read tab does not contradict the sidebar beside it', !sidebarHas || liveIds.includes(1299), `sidebarHas=${sidebarHas}`);

// ---- [H] read history must survive a LARGE event log (no second, tighter window) ----
// Regression for: `getReadItemIds` read only the newest 5000 events while every sibling derivation
// read the whole log. Impressions dominate the log (every card scrolled past fires one), so a normal
// reader passes 5000 in days and everything older silently vanished — the Read tab and the sidebar
// both went empty and the UI claimed no reading history at all. The log is already capped by
// pruneCaches; a second window here only re-creates derivation drift.
const bigLog = await page.evaluate(async () => {
  const [{ db }, interactions] = await Promise.all([window.__hnlens.db(), window.__hnlens.interactions()]);
  await interactions.clearAllData();
  const t = Date.now();
  // One genuine read, far in the past…
  const OLD = 77001;
  await db.events.bulkAdd([
    { type: 'open_link', itemId: OLD, domain: 'old.com', author: 'olduser', ts: t - 9_000_000 },
    { type: 'dwell', itemId: OLD, domain: 'old.com', author: 'olduser', value: 70000, ts: t - 8_999_000 },
  ]);
  // …then 6000 NEWER impressions, pushing that read outside any 5000-event window.
  const filler = [];
  for (let k = 0; k < 6000; k++) filler.push({ type: 'impression', itemId: 78000 + k, domain: 'f.com', ts: t - 100000 + k });
  await db.events.bulkAdd(filler);
  const ids = await interactions.getReadItemIds();
  return { total: await db.events.count(), stillRead: ids.includes(OLD) };
});
check('a genuine read survives a >5000-event log (no second window)', bigLog.stillRead === true, `events=${bigLog.total} stillRead=${bigLog.stillRead}`);

await b.close();
console.log(`\n${fails.length === 0 ? 'RESULT: READ TAB + For-You read-hide (snapshot) PASS \u2713' : `RESULT: ${fails.length} FAILED`}`);
process.exit(fails.length ? 1 : 0);
