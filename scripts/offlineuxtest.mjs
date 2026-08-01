// Offline-UX test — guards the four offline-experience behaviours:
//   M1: an ambient offline INDICATOR appears when the browser goes offline and clears on reconnect,
//       and it is position:fixed (never pushes list content down).
//   M2: an errored feed AUTO-RECOVERS when connectivity returns (the browser's `online` event
//       refetches errored active queries) — no manual Retry needed. networkMode:'always' stays.
//   M3: offline OUTAGE states say "You're offline" and point to content available offline
//       (Saved / Read via [data-offline-hint]), instead of a generic "Couldn't load".
//   M4: an "Install for offline reading" affordance appears once the browser offers an install
//       prompt (beforeinstallprompt) and triggers that prompt; it is absent otherwise.
// Hermetic: the HN API is mocked; navigator.onLine is driven by context.setOffline.
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:4173/';
const fails = [];
const check = (name, pass, detail = '') => {
  console.log(`  ${pass ? '\u2713' : '\u2717'} ${name}${detail ? ` \u2014 ${detail}` : ''}`);
  if (!pass) fails.push(name);
};

const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
const page = ctx.pages()[0] || (await ctx.newPage());

let netUp = true; // when false, list endpoints fail (offline)
const IDS_TOP = [9001, 9002, 9003];
const IDS_BEST = [9101, 9102, 9103];
const now = Math.floor(Date.now() / 1000);
await page.route(/hacker-news\.firebaseio\.com/, (r) => {
  const u = r.request().url();
  const j = (x) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(x) });
  if (!netUp && (/(top|best|new|ask|show|job)stories/.test(u) || /\/user\//.test(u))) return r.abort('internetdisconnected');
  if (/\/user\//.test(u)) return j({ id: u.match(/user\/([^.]+)/)?.[1] ?? 'someuser', karma: 10, created: now - 99999 });
  if (/topstories/.test(u)) return j(IDS_TOP);
  if (/beststories/.test(u)) return j(IDS_BEST);
  if (/(new|ask|show|job)stories/.test(u)) return j([]);
  const m = u.match(/item\/(\d+)/);
  if (m) return j({ id: Number(m[1]), type: 'story', by: 'u', title: `Story ${m[1]}`, url: `https://ex.com/${m[1]}`, score: 100, descendants: 3, time: now - 3600 });
  return j(null);
});
await page.route(/hn\.algolia\.com|google\.com\/s2|gstatic\.com/, (r) => {
  if (!netUp) return r.abort('internetdisconnected');
  return r.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
});

const mainText = () => page.evaluate(() => document.querySelector('main')?.innerText ?? '');

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__hnlens && window.__hnlens.prefs, null, { timeout: 20000 });
await page.evaluate(async () => {
  await (await window.__hnlens.interactions()).clearAllData(); // no cached lists
  window.__hnlens.prefs.getState().set({
    defaultFeed: 'top', useLearnedRanker: false, embeddingsEnabled: false,
    minPoints: 0, mutedDomains: [], mutedUsers: [], keywordsMute: [], hideReadInFeed: false,
  });
  location.hash = '#/';
});
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__hnlens, null, { timeout: 20000 });
await page.getByRole('button', { name: 'Top', exact: true }).click();
await page.waitForSelector('article', { timeout: 15000 });

// --- M1: no indicator while online; capture the first card's position to prove no reflow later ---
check('no offline indicator while online', (await page.locator('[data-offline-indicator]').count()) === 0);
const cardTopOnline = await page.locator('article').first().evaluate((el) => Math.round(el.getBoundingClientRect().top)).catch(() => null);

// --- go offline ---
netUp = false;
await ctx.setOffline(true);

// --- M1: indicator appears after the debounce; it lives INSIDE the TopNav chrome (fixed-height nav
// → no page reflow; above the tab strip → no occlusion), says offline, does not move feed content,
// and never intercepts a control (INVARIANT — this was the HIGH). ---
await page.waitForSelector('[data-offline-indicator]', { timeout: 4000 }).catch(() => {});
const indCount = await page.locator('[data-offline-indicator]').count();
check('M1: offline indicator appears when the browser goes offline', indCount === 1, `count=${indCount}`);
if (indCount) {
  const indInfo = await page.evaluate(() => {
    const ind = document.querySelector('[data-offline-indicator]');
    const header = document.querySelector('header');
    const ir = ind.getBoundingClientRect();
    const hr = header?.getBoundingClientRect();
    return {
      inNav: !!header && header.contains(ind) && !!hr && ir.bottom <= hr.bottom + 1,
      text: ((ind.textContent || '') + ' ' + (ind.getAttribute('aria-label') || '')).toLowerCase(),
    };
  });
  check('M1: indicator lives inside the TopNav (no reflow; above the tab strip → no occlusion)', indInfo.inNav, JSON.stringify(indInfo));
  check('M1: indicator says offline', /offline/.test(indInfo.text), indInfo.text.slice(0, 30));
  const cardTopOffline = await page.locator('article').first().evaluate((el) => Math.round(el.getBoundingClientRect().top)).catch(() => null);
  check('M1: showing the indicator does NOT reflow the feed (first card unmoved)',
    cardTopOnline != null && cardTopOffline != null && Math.abs(cardTopOnline - cardTopOffline) <= 1, `online=${cardTopOnline} offline=${cardTopOffline}`);
  const blocked = await page.evaluate(() => {
    const ind = document.querySelector('[data-offline-indicator]');
    const out = [];
    for (const t of document.querySelectorAll('.feed-tabs button')) {
      const r = t.getBoundingClientRect();
      if (r.width === 0) continue;
      const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (ind && (el === ind || ind.contains(el))) out.push(t.textContent?.trim());
    }
    return out;
  });
  check('M1: offline indicator does NOT intercept or overlap feed tabs', blocked.length === 0, `blocked=${JSON.stringify(blocked)}`);
}

// --- M3: switch to an UNCACHED feed while offline → outage says "offline" + points to Saved/Read ---
await page.getByRole('button', { name: 'Best', exact: true }).click();
// Wait for the OUTAGE to actually render — the offline hint is its definitive marker. A loose text
// match raced keepPreviousData (which briefly shows the PRIOR feed while Best's query errors), so the
// assertion sometimes read the stale loaded feed ("Updated just now …") instead of the outage.
// Waiting for the hint element removes that intermittent flake.
await page.waitForSelector('[data-offline-hint]', { timeout: 15000 }).catch(() => {});
await page.waitForTimeout(300);
const outage = await mainText();
check('M3: offline feed outage says "You\'re offline" (not a bare "Couldn\'t load")',
  /offline/i.test(outage) && !/Couldn.t load stories/i.test(outage), outage.replace(/\s+/g, ' ').slice(0, 90));
const hintCount = await page.locator('[data-offline-hint]').count();
check('M3: outage points to content available offline (Saved / Read hint present)', hintCount >= 1, `hints=${hintCount}`);
if (hintCount) {
  const hintText = await page.locator('[data-offline-hint]').first().innerText();
  check('M3: the offline hint names Saved and Read', /Saved/.test(hintText) && /Read/.test(hintText), hintText.slice(0, 80));
}
const retryVisible = await page.getByRole('button', { name: /Retry/i }).isVisible().catch(() => false);
check('M3: the outage still offers Retry (primary action preserved)', retryVisible);

// --- M2: reconnect → the errored feed recovers WITHOUT a manual Retry ---
netUp = true;
await ctx.setOffline(false); // fires the browser `online` event
await page.waitForSelector('article', { timeout: 12000 }).catch(() => {});
await page.waitForTimeout(400);
const recoveredCards = await page.locator('article h3').count();
check('M2: errored feed auto-recovers on reconnect (no manual Retry)', recoveredCards > 0, `cards=${recoveredCards}`);
const outage2 = await mainText();
check('M2: the offline outage message is gone after reconnect', !/You.?re offline/i.test(outage2));

// --- M1: indicator clears when back online ---
await page.waitForTimeout(200);
check('M1: offline indicator clears when back online', (await page.locator('[data-offline-indicator]').count()) === 0);

// --- STORY-OUTAGE RECOVERY (HIGH): a discussion whose STORY fetch fails offline must show a Retry +
// "offline" copy, and AUTO-RECOVER on reconnect without a manual Retry (parity with the feed +
// comment tree). Pre-fix the story query resolved success(null), so it had no Retry and the
// reconnect refetch (errored-only) skipped it. Use an uncached id (Settings/feed never fetched it). ---
netUp = false;
await ctx.setOffline(true);
await page.goto(`${BASE}#/item/8123`, { waitUntil: 'domcontentloaded' });
// Wait for the outage branch to SETTLE (its Retry button, which only exists in that branch) rather
// than reading a transient Loading state; read <main> so the TopNav theme-select options don't count.
await page.getByRole('button', { name: /Retry/i }).first().waitFor({ timeout: 20000 }).catch(() => {});
await page.waitForTimeout(200);
const itemOut = await page.evaluate(() => document.querySelector('main')?.innerText ?? '');
const itemRetry = await page.getByRole('button', { name: /Retry/i }).count();
check('story-outage (offline) says "offline" and offers Retry', /offline/i.test(itemOut) && itemRetry > 0, `retry=${itemRetry} ${itemOut.replace(/\s+/g, ' ').slice(0, 70)}`);
netUp = true;
await ctx.setOffline(false); // fires `online` — stay on /item/8123 to prove auto-recovery
await page.waitForFunction(() => /Story 8123/.test(document.body.innerText), null, { timeout: 12000 }).catch(() => {});
await page.waitForTimeout(300);
const itemRecovered = await page.evaluate(() => /Story 8123/.test(document.body.innerText));
check('HIGH: discussion story-outage AUTO-RECOVERS on reconnect (no manual Retry)', itemRecovered, `recovered=${itemRecovered}`);

// SIBLING PARITY (separate offline excursion): the User-profile outage must also be offline-aware
// (offline copy + Saved/Read hint), like the feed / search / discussion outages.
netUp = false;
await ctx.setOffline(true);
await page.goto(`${BASE}#/user/someuser`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => /offline|Couldn.t load this profile/i.test(document.querySelector('main')?.innerText ?? ''), null, { timeout: 12000 }).catch(() => {});
await page.waitForTimeout(200);
const userOut = await page.evaluate(() => document.querySelector('main')?.innerText ?? '');
const userHint = await page.locator('[data-offline-hint]').count();
check('User-profile offline outage is offline-aware (offline copy + Saved/Read hint)',
  /offline/i.test(userOut) && userHint >= 1, `hint=${userHint} ${userOut.replace(/\s+/g, ' ').slice(0, 60)}`);
netUp = true;
await ctx.setOffline(false);

// FEED ERROR ISOLATION (HIGH): a non-For-You feed with its OWN local data must not inherit the
// For-You POOL's offline error. Land on Home (For You) online, then CLEAR the cached feed lists (so
// the pool genuinely errors offline rather than serving a stale list), go offline and RELOAD Home (a
// fresh document → fresh in-memory query cache → the pool's first run is offline → it errors), then
// switch to Read — Read must render its own cached card, not inherit the pool's outage.
await page.goto(`${BASE}`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__hnlens, null, { timeout: 20000 });
await page.evaluate(async (nowMs) => {
  const { db } = await window.__hnlens.db();
  await db.lists.clear(); // AFTER the online load, so it isn't re-cached
  await db.items.put({ id: 7777, item: { id: 7777, type: 'story', by: 'ra', title: 'A story I already read', url: 'https://ex.com/read', score: 50, descendants: 2, time: Math.floor(nowMs / 1000) - 3600 }, cachedAt: nowMs });
  await db.events.bulkAdd([{ type: 'dwell', itemId: 7777, domain: 'ex.com', value: 12000, ts: nowMs - 5000, meta: { where: 'comments' } }]);
  window.__hnlens.prefs.getState().set({ defaultFeed: 'foryou', hideReadInFeed: false });
}, Date.now());
netUp = false;
await ctx.setOffline(true);
await page.reload({ waitUntil: 'domcontentloaded' }); // fresh offline load on Home → For-You pool errors
await page.getByRole('button', { name: /Retry/i }).first().waitFor({ timeout: 15000 }).catch(() => {});
const fyErrored = await page.evaluate(() => /You.?re offline|Couldn.t load stories/i.test(document.querySelector('main')?.innerText ?? ''));
check('(precondition) For-You pool errors on a fresh offline load', fyErrored, `fyErrored=${fyErrored}`);
await page.getByRole('button', { name: 'Read', exact: true }).click();
await page.waitForTimeout(1000);
const readIso = await page.evaluate(() => {
  const main = document.querySelector('main')?.innerText ?? '';
  return { card: /A story I already read/.test(main), outage: /You.?re offline|Couldn.t load stories/i.test(main) };
});
check('HIGH: Read (local data) does NOT inherit the For-You pool offline error', readIso.card && !readIso.outage, JSON.stringify(readIso));
netUp = true;
await ctx.setOffline(false);

// --- M4: install affordance + EARLY listener registration (Settings has NOT been opened yet this
// session, so the beforeinstallprompt listener must already exist at startup to catch an event that
// fires before the user ever opens Settings). Pre-fix the listener lived only in the lazy Settings
// route, so an event fired on Home was missed. ---
await page.goto(`${BASE}`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__hnlens, null, { timeout: 20000 });
await page.evaluate(() => {
  const e = new Event('beforeinstallprompt');
  e.prompt = () => { window.__installPromptCalled = true; return Promise.resolve(); };
  e.userChoice = Promise.resolve({ outcome: 'accepted', platform: 'web' });
  window.dispatchEvent(e); // fires on HOME, before Settings is ever mounted
});
await page.goto(`${BASE}#/settings`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__hnlens, null, { timeout: 20000 });
await page.waitForSelector('[data-install-app]', { timeout: 5000 }).catch(() => {});
check('M4: an install prompt fired before Settings was opened is still captured (listener at startup)',
  (await page.locator('[data-install-app]').count()) === 1);
await page.locator('[data-install-app]').click().catch(() => {});
await page.waitForTimeout(300);
check('M4: clicking Install triggers the browser install prompt', await page.evaluate(() => window.__installPromptCalled === true));

await b.close();
console.log(`\n${fails.length === 0 ? 'RESULT: OFFLINE UX PASS \u2713' : `RESULT: ${fails.length} FAILED`}`);
process.exit(fails.length ? 1 : 0);
