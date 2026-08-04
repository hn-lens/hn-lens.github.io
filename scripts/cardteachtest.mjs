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

// --- an open menu must not ride up over the pinned header when the reader scrolls ---
// When the anchor sits low in the viewport the clamp flips the menu FULLY ABOVE it, so the menu
// extends upward; a placement computed only at open time then walks off the top of the screen on
// the next downward scroll, several times faster than the anchor leaves it, and the menu's items
// land on top of the top-nav controls while still being hittable.
await page.keyboard.press('Escape');
await page.evaluate(() => window.__hnlens.prefs.getState().set({ mutedDomains: [], mutedUsers: [] }));
await page.setViewportSize({ width: 360, height: 640 });
await page.evaluate(() => window.scrollTo(0, 0));
await page.waitForTimeout(600);

// Open the ⋯ of whichever card currently sits LOW in the viewport — that is the anchor position
// that makes the clamp flip the menu upward, which is the state that drifts.
const flipped = await page.evaluate(async () => {
  const btns = [...document.querySelectorAll('button')].filter((b) => /More actions/.test(b.getAttribute('aria-label') || ''));
  // Deep enough in the viewport that a full menu cannot fit BELOW the anchor, which is what makes
  // the clamp flip it upward. A mid-page anchor still fits and never enters the drifting state.
  const target = btns.find((b) => b.getBoundingClientRect().top > window.innerHeight - 190);
  if (!target) return { noTarget: true, tops: btns.map((b) => Math.round(b.getBoundingClientRect().top)), vh: window.innerHeight };
  target.click();
  await new Promise((r) => setTimeout(r, 300));
  const menu = document.querySelector('[role="menu"]');
  if (!menu) return { noMenu: true };
  const m = menu.getBoundingClientRect();
  const a = target.getBoundingClientRect();
  return { menuTop: Math.round(m.top), anchorTop: Math.round(a.top), above: m.top < a.top, vh: window.innerHeight };
});
check(
  'PRECONDITION: the anchor is low enough that the clamp flips the menu ABOVE it (the state that drifts)',
  flipped !== null && flipped.above === true,
  JSON.stringify(flipped),
);

// Every top-nav control's centre, hit-tested. The lens measured the defect this way because a
// bounding-box overlap does not prove the menu actually STEALS the control's clicks.
const headerTheft = async () =>
  await page.evaluate(() => {
    const header = document.querySelector('header.sticky');
    if (!header) return null;
    const controls = [...header.querySelectorAll('button, a, input')];
    const menu = document.querySelector('[role="menu"]');
    if (!menu) return { menuGone: true, stolen: [] };
    const stolen = [];
    for (const c of controls) {
      const r = c.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const hit = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
      if (hit && menu.contains(hit)) {
        stolen.push({ control: c.getAttribute('aria-label') || c.textContent?.trim()?.slice(0, 20) || c.tagName, hits: hit.textContent?.trim()?.slice(0, 24) || hit.tagName });
      }
    }
    const m = menu.getBoundingClientRect();
    const h = header.getBoundingClientRect();
    return {
      menuGone: false, stolen, controls: controls.length,
      menuTop: Math.round(m.top),
      overHeader: Math.round(Math.min(m.bottom, h.bottom) - Math.max(m.top, h.top)),
    };
  });
const theftBefore = await headerTheft();
check(
  'PRECONDITION: with the menu open and the page unscrolled, no top-nav control is covered',
  theftBefore !== null && theftBefore.stolen.length === 0,
  JSON.stringify(theftBefore),
);
const scrolledBy = await page.evaluate(async () => {
  const before = window.scrollY;
  window.scrollBy(0, 350);
  await new Promise((r) => setTimeout(r, 350));
  return window.scrollY - before;
});
await page.waitForTimeout(300);
const theftAfter = await headerTheft();
check(
  'PRECONDITION: the page actually scrolled (else nothing below is measured)',
  scrolledBy > 300,
  `dy=${scrolledBy}`,
);
// Two measures of one invariant. The hit test is what the reader actually experiences (a stolen
// click), but it only fires once an item's centre lands on a control's centre, so it under-reports
// a menu that has intruded partway. The geometric overlap catches that earlier.
check(
  'scrolling with the menu open never lets it overlap the pinned header',
  theftAfter !== null && (theftAfter.menuGone || theftAfter.overHeader <= 0),
  JSON.stringify(theftAfter),
);
check(
  'scrolling with the menu open never lets it cover a top-nav control',
  theftAfter !== null && (theftAfter.menuGone || theftAfter.stolen.length === 0),
  JSON.stringify(theftAfter),
);
await page.keyboard.press('Escape');
await page.setViewportSize({ width: 1280, height: 1000 });
await page.waitForTimeout(200);

await b.close();
console.log(`\n${fails.length === 0 ? 'RESULT: CARD TEACHING PASS \u2713' : `RESULT: ${fails.length} FAILED`}`);
process.exit(fails.length ? 1 : 0);
