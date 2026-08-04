// Card-level teaching test — guards the feature: you can follow/mute a story's
// domain or author straight from the card's "Personalize" menu, and it (a) writes
// the real prefs the ranker/filters use and (b) muting removes the story from the
// feed (global filtering). Drives the REAL app over a mocked HN API.
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:4173/';
const now = Math.floor(Date.now() / 1000);
const STORIES = [
  { id: 901, type: 'story', by: 'alice', title: 'Story A', url: 'https://a.com/x', score: 120, descendants: 5, time: now - 3600 },
  { id: 902, type: 'story', by: 'bob', title: 'Story B', url: 'https://b.com/x', score: 110, descendants: 5, time: now - 3600 },
  { id: 903, type: 'story', by: 'carol', title: 'Story C', url: 'https://c.com/x', score: 100, descendants: 5, time: now - 3600 },
];
// Filler cards on their own domains/authors: the popover-drift check below needs a feed TALLER than
// a phone viewport, and three cards do not scroll at 360x640. They are inert for every other check.
const FILLER = Array.from({ length: 10 }, (_, i) => ({
  id: 910 + i, type: 'story', by: `filler${i}`, title: `Filler ${i}`,
  url: `https://f${i}.example/x`, score: 90 - i, descendants: 2, time: now - 3600,
}));
const ALL = [...STORIES, ...FILLER];
const byId = new Map(ALL.map((s) => [s.id, s]));
const POOL = ALL.map((s) => s.id);

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
  if (/topstories/.test(u)) return j(POOL);
  if (/(best|new|ask|show|job)stories/.test(u)) return j([]);
  const m = u.match(/item\/(\d+)/);
  if (m) return j(byId.get(Number(m[1])) ?? null);
  return j(null);
});
await page.route(/hn\.algolia\.com|google\.com\/s2/, (r) => r.fulfill({ status: 200, body: '{}' }));
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__hnlens && window.__hnlens.prefs, null, { timeout: 20000 });
await page.evaluate(async () => {
  await (await window.__hnlens.interactions()).clearAllData();
  window.__hnlens.prefs.getState().set({ defaultFeed: 'top', useLearnedRanker: false, embeddingsEnabled: false, minPoints: 0, followedDomains: [], mutedDomains: [], followedUsers: [], mutedUsers: [] });
});
await page.getByRole('button', { name: 'Top', exact: true }).click();
await page.waitForSelector('article', { timeout: 15000 });
await page.waitForTimeout(400);

const pref = (k) => page.evaluate((key) => window.__hnlens.prefs.getState()[key], k);
const shows = async (t) => (await page.evaluate(() => [...document.querySelectorAll('article h3')].map((h) => h.textContent.trim()))).some((x) => x.includes(t));
const cardOf = (t) => page.locator('article').filter({ hasText: t });
const openMenu = async (t) => {
  await cardOf(t).getByRole('button', { name: /More actions/ }).click();
  await page.waitForTimeout(150);
};
const clickItem = async (name) => {
  await page.getByRole('menuitem', { name }).click();
  await page.waitForTimeout(300);
};

// M9: the domain shown in the card meta row must be DISPLAY-ONLY, not a borderless one-tap FOLLOW
// control 2px above the title (a mis-tap hazard). Follow/unfollow lives in the Personalize menu.
const domainCtrl = await page.evaluate(() => {
  const meta = document.querySelector('article .sc-meta');
  if (!meta) return { found: false };
  const el = [...meta.querySelectorAll('*')].find((e) => /\.(com|org|net|io)\b/.test(e.textContent ?? '') && e.children.length <= 1);
  return { found: !!el, tag: el?.tagName, inButton: !!el?.closest('button') };
});
check('M9: the meta-row domain is NOT a tap-to-follow button (mis-tap hazard removed)', domainCtrl.found && domainCtrl.inButton === false, JSON.stringify(domainCtrl));

// --- the Personalize menu paints ABOVE the next card (no z-index/overlap artifact) ---
// The dropdown drops down over the card below it; a later sibling card would otherwise
// paint on top of it (its chips/Why-button bleeding through). Assert the menu is topmost.
await openMenu('Story A');
const overlap = await page.evaluate(() => {
  const menu = document.querySelector('[role="menu"]');
  if (!menu) return { ok: false, reason: 'no menu' };
  const items = [...menu.querySelectorAll('[role="menuitem"]')];
  const last = items[items.length - 1]; // lowest item — most likely to overlap the next card
  const r = last.getBoundingClientRect();
  const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return { ok: !!el && menu.contains(el), hit: el?.textContent?.trim()?.slice(0, 40) };
});
check('Personalize menu is topmost (not overlapped by the next card)', overlap.ok, JSON.stringify(overlap));
await page.keyboard.press('Escape');
await page.waitForTimeout(150);

// --- follow domain ---
await openMenu('Story A');
await clickItem('Follow a.com');
check('Follow domain writes followedDomains', (await pref('followedDomains')).includes('a.com'), JSON.stringify(await pref('followedDomains')));

// --- follow author ---
await openMenu('Story A');
await clickItem('Follow alice');
check('Follow author writes followedUsers', (await pref('followedUsers')).includes('alice'), JSON.stringify(await pref('followedUsers')));
// Follow-author must offer an Undo like the other 3 Personalize actions (follow-domain/mute-*) — it
// was the lone exception (bare toast, no Undo). Assert the toast now has an Undo control.
check('Follow author toast offers Undo (consistent with the other Personalize actions)', await page.getByRole('button', { name: 'Undo' }).first().isVisible().catch(() => false));

// --- mute domain removes the story from the feed ---
await openMenu('Story B');
await clickItem('Mute b.com');
check('Mute domain writes mutedDomains', (await pref('mutedDomains')).includes('b.com'), JSON.stringify(await pref('mutedDomains')));
check('Mute domain removes the story from the feed (global filter)', !(await shows('Story B')), 'Story B should be gone');

// --- mute author removes the story from the feed ---
await openMenu('Story C');
await clickItem('Mute carol');
check('Mute author writes mutedUsers', (await pref('mutedUsers')).includes('carol'), JSON.stringify(await pref('mutedUsers')));
check('Mute author removes the story from the feed', !(await shows('Story C')), 'Story C should be gone');

// --- the menu toggles labels: re-open A shows Unfollow ---
await openMenu('Story A');
check('follow state reflected in the menu (Unfollow a.com shown)', await page.getByRole('menuitem', { name: 'Unfollow a.com' }).isVisible());

// --- an open menu must stay usable and stay off the pinned header ---
// Two halves of one invariant, because fixing either alone re-creates the other:
//   (a) while the menu is open and the page scrolls, it must never overlap or steal clicks from
//       the pinned header. Closing is an acceptable outcome; drifting on top of the nav is not.
//   (b) when the menu is taller than the room available it is capped and scrolls internally, and
//       that internal scrolling must actually work — every item has to be reachable.
await page.keyboard.press('Escape');
await page.evaluate(() => window.__hnlens.prefs.getState().set({ mutedDomains: [], mutedUsers: [] }));
await page.waitForTimeout(400);

const openLowMenu = async () =>
  await page.evaluate(async () => {
    const btns = [...document.querySelectorAll('button')].filter((b) => /More actions/.test(b.getAttribute('aria-label') || ''));
    // Low in the viewport: that is the anchor position where the menu flips upward, which is the
    // state that drifts and the state that gets capped.
    const t = btns.find((b) => b.getBoundingClientRect().top > window.innerHeight * 0.5) || btns[btns.length - 1];
    if (!t) return null;
    t.click();
    await new Promise((r) => setTimeout(r, 350));
    const m = document.querySelector('[role="menu"]');
    return m ? { menuTop: Math.round(m.getBoundingClientRect().top) } : null;
  });

// (a) scroll sweep across phone geometries
for (const [w, h] of [[360, 640], [390, 844]]) {
  for (const y of [350, 500, 650, 800]) {
    await page.setViewportSize({ width: w, height: h });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(450);
    const opened = await openLowMenu();
    check(`PRECONDITION: a menu is open low in the viewport at ${w}x${h} before scrolling to ${y}`, opened !== null, JSON.stringify(opened));
    if (!opened) continue;
    const r = await page.evaluate(async (sy) => {
      const y0 = window.scrollY;
      window.scrollTo(0, sy);
      await new Promise((res) => setTimeout(res, 450));
      const moved = window.scrollY - y0;
      const m = document.querySelector('[role="menu"]');
      if (!m) return { moved, closed: true, over: 0, stolen: 0 };
      const hdr = document.querySelector('header');
      const mr = m.getBoundingClientRect();
      const hr = hdr.getBoundingClientRect();
      let stolen = 0;
      for (const c of hdr.querySelectorAll('button, a, input')) {
        const rr = c.getBoundingClientRect();
        if (!rr.width || !rr.height) continue;
        const e = document.elementFromPoint(Math.round(rr.left + rr.width / 2), Math.round(rr.top + rr.height / 2));
        if (e && m.contains(e)) stolen += 1;
      }
      return { moved, closed: false, menuTop: Math.round(mr.top), over: Math.round(Math.min(mr.bottom, hr.bottom) - Math.max(mr.top, hr.top)), stolen };
    }, y);
    check(`PRECONDITION: the page really scrolled to ${y} at ${w}x${h}`, r.moved > y - 60, JSON.stringify(r));
    check(
      `an open menu never covers the pinned header after scrolling ${y} at ${w}x${h}`,
      r.closed || (r.over <= 0 && r.stolen === 0),
      JSON.stringify(r),
    );
    await page.keyboard.press('Escape');
  }
}

// (b) a capped menu must scroll to its last item; an uncapped one must show every item outright.
// 360x430 is here to force the CAPPED branch: at the taller geometries this fixture's menu fits
// outright, so without a short viewport the capped half of the check never executes.
let sawCapped = false;
for (const [w, h] of [[360, 430], [360, 640], [390, 844]]) {
  await page.setViewportSize({ width: w, height: h });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(450);
  const opened = await openLowMenu();
  check(`PRECONDITION: a menu is open for the reachability check at ${w}x${h}`, opened !== null);
  if (!opened) continue;
  const r = await page.evaluate(async () => {
    const m = document.querySelector('[role="menu"]');
    const items = [...m.querySelectorAll('[role="menuitem"]')];
    const capped = m.scrollHeight > m.clientHeight + 1;
    m.scrollTop = 9999;
    m.dispatchEvent(new Event('scroll', { bubbles: true }));
    await new Promise((res) => setTimeout(res, 300));
    const last = items[items.length - 1];
    const lr = last.getBoundingClientRect();
    const hit = document.elementFromPoint(Math.round(lr.left + lr.width / 2), Math.round(lr.top + lr.height / 2));
    return {
      items: items.length, capped, scrollTop: Math.round(m.scrollTop),
      scrollH: Math.round(m.scrollHeight), clientH: Math.round(m.clientHeight),
      lastLabel: last.textContent.trim().slice(0, 24),
      lastInViewport: lr.top >= 0 && lr.bottom <= window.innerHeight,
      lastHitsOwnItem: hit ? last === hit || last.contains(hit) : false,
    };
  });
  check(`PRECONDITION: the menu has items to reach at ${w}x${h}`, r.items >= 5, JSON.stringify(r));
  // The capped and uncapped cases are the two halves: a fix that only caps, or only un-caps,
  // fails one of them.
  if (r.capped) {
    sawCapped = true;
    check(`a capped menu scrolls, so its last item is reachable at ${w}x${h}`, r.scrollTop > 0 && r.lastInViewport && r.lastHitsOwnItem, JSON.stringify(r));
  } else {
    check(`an uncapped menu shows its last item without scrolling at ${w}x${h}`, r.lastInViewport && r.lastHitsOwnItem, JSON.stringify(r));
  }
  await page.keyboard.press('Escape');
}
// Without this the loop can silently take the uncapped branch every time and report a pass while
// the capped case — the one that regressed — is never executed.
check('PRECONDITION: at least one geometry actually capped the menu', sawCapped);
await page.setViewportSize({ width: 1280, height: 1000 });
await page.waitForTimeout(200);

await b.close();
console.log(`\n${fails.length === 0 ? 'RESULT: CARD TEACHING PASS \u2713' : `RESULT: ${fails.length} FAILED`}`);
process.exit(fails.length ? 1 : 0);
