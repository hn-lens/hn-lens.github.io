// Mobile access test — guards the fix: on a phone the personalization/Tune UI lived
// only in the desktop-only sidebar (hidden lg:block), so tuning was unreachable; and
// the Read tab sits at the end of an overflowing tab row. Asserts, at a 375-wide
// viewport, that (a) the desktop sidebar is hidden, (b) a mobile "Tune ranking" panel
// is reachable and reveals the sliders, and (c) the Read tab is reachable + switches.
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:4173/';
const now = Math.floor(Date.now() / 1000);
const POOL = [1, 2, 3];
const item = (id) => ({ id, type: 'story', by: `u${id}`, title: `Story ${id}`, url: `https://ex${id}.com/x`, score: 100 + id, descendants: 5, time: now - 3600 });
const byId = new Map(POOL.map((id) => [id, item(id)]));

const fails = [];
const check = (name, pass, detail = '') => {
  console.log(`  ${pass ? '\u2713' : '\u2717'} ${name}${detail ? ` \u2014 ${detail}` : ''}`);
  if (!pass) fails.push(name);
};

const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ viewport: { width: 375, height: 780 } }); // phone
const page = ctx.pages()[0] || (await ctx.newPage());
await page.route(/hacker-news\.firebaseio\.com/, (r) => {
  const u = r.request().url();
  const j = (x) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(x) });
  if (/(top|best|new)stories/.test(u)) return j(POOL);
  if (/(ask|show|job)stories/.test(u)) return j([]);
  const m = u.match(/item\/(\d+)/);
  if (m) return j(byId.get(Number(m[1])) ?? null);
  return j(null);
});
await page.route(/hn\.algolia\.com|google\.com\/s2/, (r) => r.fulfill({ status: 200, body: '{}' }));
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__hnlens && window.__hnlens.prefs, null, { timeout: 20000 });
await page.evaluate(async () => {
  await (await window.__hnlens.interactions()).clearAllData();
  window.__hnlens.prefs.getState().set({ defaultFeed: 'foryou', useLearnedRanker: false, embeddingsEnabled: false, minPoints: 0 });
});
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__hnlens, null, { timeout: 20000 });
await page.waitForSelector('article', { timeout: 15000 });
await page.waitForTimeout(400);

// (a) the desktop sidebar is not visible on a phone
const sidebarVisible = await page.evaluate(() => {
  const sb = document.querySelector('.app-sidebar');
  if (!sb) return false;
  const r = sb.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
});
check('desktop sidebar is hidden on mobile', !sidebarVisible);

// (a2) touch targets: EVERY story-card action control — buttons AND the "Open on HN" <a>
// AND the comments-count control (the only way into the discussion on a link story) — is
// >=44px on a phone (desktop keeps its denser 36px sizing). Measuring all control types
// (not just <button>) is deliberate: an earlier version scoped the bump to `button` and
// silently left the <a> + comments control at 36/20px.
const targets = await page.evaluate(() =>
  // VISIBLE inline controls only: the narrow-width overflow moves some actions into the "..." menu
  // (display:none in the row), and a hidden 0x0 element is not an inline touch target — the menu
  // items have their own hit area when opened. Measure what the reader can actually tap in the row.
  [...document.querySelectorAll('.sc-actions button, .sc-actions a, .sc-comments')]
    .filter((el) => el.offsetParent !== null && !el.closest('[role="menu"]'))
    .map((el) => {
      const r = el.getBoundingClientRect();
      return { label: (el.getAttribute('aria-label') || el.getAttribute('title') || '').slice(0, 20), min: Math.round(Math.min(r.width, r.height)) };
    })
);
const tooSmall = targets.filter((t) => t.min < 44);
check(
  'all story-card action + comments controls are >=44px touch targets on mobile',
  targets.length > 0 && tooSmall.length === 0,
  tooSmall.length ? `too small: ${JSON.stringify(tooSmall)}` : `${targets.length} controls, all >=44px`
);

// (b) mobile Tune ranking is reachable and reveals the sliders
const tuneBtn = page.getByRole('button', { name: 'Tune ranking' });
check('mobile "Tune ranking" control is present', await tuneBtn.isVisible());
await tuneBtn.click();
await page.waitForTimeout(300);
const slidersShown = await page.evaluate(() => /Popularity \(HN score\)/i.test(document.body.innerText));
check('tapping Tune reveals the ranking sliders on mobile', slidersShown);

// (c) the Read tab is reachable on mobile (overflowing tab row) and switches feeds
const readTab = page.locator('.feed-tabs button', { hasText: 'Read' });
await readTab.scrollIntoViewIfNeeded();
await readTab.click();
await page.waitForTimeout(500);
const onRead = await page.evaluate(() =>
  document.querySelector('.feed-tabs button[aria-current="page"]')?.textContent?.includes('Read') ?? false
);
check('Read tab is reachable and activates on mobile', onRead);

// (c2) The overflowing feed-tabs strip HIDES its scrollbar on mobile (the mobile-scrollbar
// bug): it genuinely overflows (so a scrollbar would otherwise show), and its computed
// scrollbar-width is 'none' (headless overlay scrollbars have 0 thickness, so we inspect the
// computed style, not a measured width).
const tabScroll = await page.evaluate(() => {
  const el = document.querySelector('.feed-tabs');
  if (!el) return null;
  return { overflows: el.scrollWidth > el.clientWidth + 2, sbw: getComputedStyle(el).scrollbarWidth };
});
check('feed-tabs strip actually overflows on mobile (a scrollbar would show)', !!tabScroll && tabScroll.overflows, JSON.stringify(tabScroll));
check('feed-tabs hides its scrollbar (scrollbar-width:none)', !!tabScroll && tabScroll.sbw === 'none', JSON.stringify(tabScroll));

// (c2b) The `newspaper` multi-column layout must NOT cause horizontal PAGE overflow on a
// narrow phone. Its columns are ~150px; the story-card action row is a flex of shrink-0 44px
// touch targets whose min-content width exceeds the column, so it must WRAP within the column
// rather than push the page wider (measured +18px page overflow at 360 pre-fix).
await page.goto(`${BASE}#/?feed=top`, { waitUntil: 'domcontentloaded' }); // populated feed (Read tab is empty)
await page.waitForSelector('article', { timeout: 15000 });
await page.setViewportSize({ width: 360, height: 780 });
await page.evaluate(() => window.__hnlens.prefs.getState().setLayout('newspaper'));
await page.waitForTimeout(400);
const npOverflow = await page.evaluate(() => {
  const fl = document.querySelector('.feed-list');
  return {
    layout: document.documentElement.getAttribute('data-layout'),
    cols: fl ? getComputedStyle(fl).columnCount : 'none',
    over: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  };
});
check('newspaper layout multi-columns on a phone', npOverflow.layout === 'newspaper' && parseInt(npOverflow.cols, 10) >= 2, JSON.stringify(npOverflow));
check('newspaper layout: no horizontal PAGE overflow on a 360px phone', npOverflow.over <= 2, JSON.stringify(npOverflow));
// The story-card Personalize (⋯) menu must clamp fully on-screen even in the narrow newspaper
// left column (it's right-anchored, so without a viewport clamp it spills off the LEFT edge).
const npMenuBtn = page.getByRole('button', { name: /More actions/i }).first();
await npMenuBtn.click();
await page.waitForTimeout(200);
const npMenu = await page.evaluate(() => {
  const m = document.querySelector('[role="menu"]');
  if (!m) return null;
  const r = m.getBoundingClientRect();
  return { left: Math.round(r.left), right: Math.round(r.right), vw: window.innerWidth };
});
check('newspaper: Personalize menu clamps fully on-screen (not off the left edge)', !!npMenu && npMenu.left >= -1 && npMenu.right <= npMenu.vw + 1, JSON.stringify(npMenu));
await page.keyboard.press('Escape');
await page.evaluate(() => window.__hnlens.prefs.getState().setLayout('cards'));
await page.setViewportSize({ width: 375, height: 780 });

// (c3) The Settings section-nav WRAPS on mobile (no horizontal-scroll strip with hidden
// off-screen sections + no scrollbar cue) — it must not horizontally overflow.
await page.goto(`${BASE}#/settings`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('nav[aria-label="Settings sections"] ul', { timeout: 15000 });
await page.waitForTimeout(300);
const navOverflow = await page.evaluate(() => {
  const el = document.querySelector('nav[aria-label="Settings sections"] ul');
  return el ? { over: el.scrollWidth > el.clientWidth + 2 } : null;
});
check('Settings section-nav wraps on mobile (no horizontal overflow)', !!navOverflow && !navOverflow.over, JSON.stringify(navOverflow));

// (c4) SMALLEST phone (320px) + the "Large" reading-text size — the highest-stress overflow
// combination. Two c2r4 fixes are guarded here: the Settings TagEditor input rows (needed
// `min-w-0`, else the "Add" buttons pushed the page +36px) and the compact layout (needed
// `.sc-sub` shrink, else the max-content meta overflowed +7–27px, worst on monospace designs).
await page.setViewportSize({ width: 320, height: 720 });
// Seed a LONG mute keyword so a TagEditor tag CHIP is present (a long domain/keyword tag chip
// overflowed the page pre-fix; the chip now caps + breaks the token).
// setTextSize(), NOT set({textSize}): the plain setter writes the store but never applies the
// `data-textsize` attribute, so both checks named "at 320px + Large text" actually ran at the
// DEFAULT size and could not fail. Line ~225 of this file already does it correctly and says so.
await page.evaluate(() => {
  window.__hnlens.prefs.getState().set({ keywordsMute: ['some-really-long-mute-keyword-token-that-would-overflow-the-page'] });
  window.__hnlens.prefs.getState().setTextSize('lg');
});
// Assert the precondition instead of assuming it — a guard that silently tests the wrong state is
// worse than no guard.
{
  const applied = await page.evaluate(() => document.documentElement.getAttribute('data-textsize'));
  if (applied !== 'lg') {
    console.log(`  \u2717 PRECONDITION: Large text did not apply (data-textsize=${applied})`);
    process.exitCode = 1;
  }
}
await page.goto(`${BASE}#/settings`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('nav[aria-label="Settings sections"] ul', { timeout: 15000 });
await page.waitForTimeout(300);
const settingsOver = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
check('Settings: no horizontal overflow at 320px + Large text (TagEditor min-w-0 + long-tag chip)', settingsOver <= 2, `over=${settingsOver}`);
await page.evaluate(() => window.__hnlens.prefs.getState().set({ keywordsMute: [] }));
await page.goto(`${BASE}#/?feed=top`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('article', { timeout: 15000 });
await page.evaluate(() => window.__hnlens.prefs.getState().setLayout('compact'));
await page.waitForTimeout(300);
const compactOver = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
check('compact layout: no horizontal PAGE overflow at 320px + Large text', compactOver <= 2, `over=${compactOver}`);
await page.evaluate(() => {
  window.__hnlens.prefs.getState().set({ textSize: 'md' });
  window.__hnlens.prefs.getState().setLayout('cards');
});
await page.setViewportSize({ width: 375, height: 780 });

// (c5) A discussion page <h1> with a long UNBREAKABLE token (a snake_case identifier title) must
// WRAP, not overflow the page — the feed card already wraps the same title. Regression for the
// CommentsView <h1> long-token class (the .sc-title/.hn-html guard that the h1 was missing).
await page.route(/hacker-news\.firebaseio\.com\/v0\/item\/777/, (r) =>
  r.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ id: 777, type: 'story', by: 'u', title: 'some_very_long_snake_case_identifier_name_that_will_not_break_v2', url: 'https://ex.com/x', score: 100, descendants: 0, time: now - 3600 }),
  })
);
await page.setViewportSize({ width: 320, height: 720 });
await page.goto(`${BASE}#/item/777`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('h1', { timeout: 15000 });
await page.waitForTimeout(300);
const discOver = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
check('discussion <h1> long-token title does not overflow the page at 320px', discOver <= 2, `over=${discOver}`);
await page.setViewportSize({ width: 375, height: 780 });

// (c6) The scroll-to-top FAB (fixed, appears at scrollY>800) must NOT sit on top of the
// right-aligned form buttons ("Add" / "Load models") on mobile Settings — on a phone it's
// anchored bottom-LEFT (no right-aligned actions there); bottom-right only on sm+. Regression for
// the FAB-occludes-submit-button wrong-action bug (tap "Add" → scrolled to top instead of adding).
await page.goto(`${BASE}#/settings`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('nav[aria-label="Settings sections"] ul', { timeout: 15000 });
await page.waitForTimeout(300);
const lastAdd = page.getByRole('button', { name: 'Add', exact: true }).last();
await lastAdd.scrollIntoViewIfNeeded();
await page.waitForTimeout(400); // let the scroll handler reveal the FAB
const fabCheck = await page.evaluate(() => {
  const fab = document.querySelector('button[aria-label="Scroll to top"]');
  const adds = [...document.querySelectorAll('button')].filter((b) => b.textContent?.trim() === 'Add');
  let anyBlocked = false;
  let inView = 0;
  for (const btn of adds) {
    const r = btn.getBoundingClientRect();
    if (r.top < 0 || r.bottom > window.innerHeight) continue; // only ones actually on screen
    inView++;
    const hit = document.elementFromPoint(Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2));
    if (fab && (hit === fab || fab.contains(hit))) anyBlocked = true;
  }
  return { fabShown: !!fab, scrollY: Math.round(window.scrollY), inView, anyBlocked };
});
check('scroll-to-top FAB shows on the long Settings page (scrollY>800)', fabCheck.fabShown && fabCheck.scrollY > 800, JSON.stringify(fabCheck));
check('FAB does not occlude any right-aligned "Add" button on mobile Settings', fabCheck.inView > 0 && !fabCheck.anyBlocked, JSON.stringify(fabCheck));

// (c7) The "Why #N?" rank-explainer dialog must stay legible at the SMALLEST phone (320px) + the
// "Large" reading-text a11y setting: its per-signal contribution bars must NOT collapse to 0px, and
// no row may overflow the modal. Regression for the fixed-rem Bar columns (w-44/w-24) that inflated
// under Large text and starved the flex-1 bar to 0px + pushed the value past the modal edge.
await page.setViewportSize({ width: 320, height: 720 });
// Apply Large via the setTextSize ACTION (the plain `set({textSize})` updates state but does NOT
// write data-textsize on <html> — the same gotcha as setTheme — so a `.set` here would silently test
// at md and miss the bug).
await page.evaluate(() => {
  const s = window.__hnlens.prefs.getState();
  s.set({ defaultFeed: 'foryou' });
  s.setTextSize('lg');
});
await page.goto(`${BASE}#/?feed=foryou`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('article', { timeout: 15000 });
await page.waitForTimeout(300);
// At 320px the "Why #N?" action overflows into the "..." menu (only the menu trigger stays inline at
// this width). Click the inline icon if it's shown, else open the menu and use the menu item.
{
  const inlineWhy = page.locator('.sc-actions button[aria-label^="Why #"]').first();
  if (await inlineWhy.isVisible().catch(() => false)) {
    await inlineWhy.click();
  } else {
    await page.locator('.sc-actions button[aria-label="More actions"]').first().click();
    await page.waitForTimeout(200);
    await page.getByRole('menuitem', { name: /Why #/ }).first().click();
  }
}
await page.waitForSelector('[role="dialog"][aria-label^="Why this story is ranked"]', { timeout: 8000 });
await page.waitForTimeout(200);
const whyDlg = await page.evaluate(() => {
  const dlg = document.querySelector('[role="dialog"][aria-label^="Why this story is ranked"]');
  if (!dlg) return null;
  // The signed contribution bar FILLS, selected by their stable structural classes (a distinctive
  // 0.625rem height + a one-sided rounded corner + a width style), NOT by colour — the fill colour is
  // a theme token (var(--bar-pos)/var(--bar-neg)), so a fixed rgb match found zero bars.
  const bars = [...dlg.querySelectorAll('div')].filter((d) => {
    const c = typeof d.className === 'string' ? d.className : '';
    return c.includes('h-2.5') && (c.includes('rounded-r') || c.includes('rounded-l'));
  });
  const maxBar = Math.max(0, ...bars.map((d) => d.getBoundingClientRect().width));
  // Measure the SCROLL CONTAINER's horizontal overflow — the real defect (uiux) was the modal CARD
  // needing horizontal scroll (the value formula spilling past it). Do NOT measure every descendant:
  // a `truncate`d label legitimately clips its OWN content (overflow:hidden), which would false-
  // positive here even though nothing is visibly cut off past the modal edge.
  const card = dlg.querySelector('[class*="overflow-y-auto"]') || dlg;
  const over = card.scrollWidth - card.clientWidth;
  const textsize = document.documentElement.getAttribute('data-textsize');
  return { bars: bars.length, maxBar: Math.round(maxBar), over, textsize };
});
check('Why #N? renders at Large text (data-textsize applied)', !!whyDlg && whyDlg.textsize === 'lg', JSON.stringify(whyDlg));
check('Why #N? bars do not collapse to 0px at 320px + Large text', !!whyDlg && whyDlg.bars > 0 && whyDlg.maxBar > 0, JSON.stringify(whyDlg));
check('Why #N? modal card has no horizontal overflow at 320px + Large text', !!whyDlg && whyDlg.over <= 2, JSON.stringify(whyDlg));
await page.keyboard.press('Escape');
await page.evaluate(() => window.__hnlens.prefs.getState().setTextSize('md'));
await page.setViewportSize({ width: 375, height: 780 });

// (d) DESKTOP + `zen` layout hides the sidebar at all widths, so the in-context Tune
// disclosure must still be reachable on desktop (not lg:hidden away). Regression.
const desk = await b.newContext({ viewport: { width: 1280, height: 900 } });
const dp = await desk.newPage();
await dp.route(/hacker-news\.firebaseio\.com/, (r) => {
  const u = r.request().url();
  const j = (x) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(x) });
  if (/(top|best|new)stories/.test(u)) return j(POOL);
  if (/(ask|show|job)stories/.test(u)) return j([]);
  const m = u.match(/item\/(\d+)/);
  if (m) return j(byId.get(Number(m[1])) ?? null);
  return j(null);
});
await dp.route(/hn\.algolia\.com|google\.com\/s2/, (r) => r.fulfill({ status: 200, body: '{}' }));
await dp.goto(BASE, { waitUntil: 'domcontentloaded' });
await dp.waitForFunction(() => window.__hnlens && window.__hnlens.prefs, null, { timeout: 20000 });
await dp.evaluate(async () => {
  await (await window.__hnlens.interactions()).clearAllData();
  const s = window.__hnlens.prefs.getState();
  s.set({ defaultFeed: 'foryou', useLearnedRanker: false, embeddingsEnabled: false, minPoints: 0 });
  s.setLayout('zen');
});
await dp.reload({ waitUntil: 'domcontentloaded' });
await dp.waitForFunction(() => window.__hnlens, null, { timeout: 20000 });
await dp.waitForSelector('article', { timeout: 15000 });
await dp.waitForTimeout(400);
const sidebarVisibleZen = await dp.evaluate(() => {
  const sb = document.querySelector('.app-sidebar');
  const r = sb?.getBoundingClientRect();
  return !!r && r.width > 0 && r.height > 0;
});
const tuneReachableZen = await dp.getByRole('button', { name: 'Tune ranking' }).isVisible();
check('zen layout hides the sidebar on desktop', !sidebarVisibleZen);
check('desktop + zen: in-context "Tune ranking" is still reachable', tuneReachableZen);
await desk.close();

await b.close();
console.log(`\n${fails.length === 0 ? 'RESULT: MOBILE ACCESS PASS \u2713' : `RESULT: ${fails.length} FAILED`}`);
process.exit(fails.length ? 1 : 0);
