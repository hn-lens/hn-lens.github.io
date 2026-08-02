// Control-row WRAP QUALITY.
//
// Every overflow guard in this repo measures `scrollWidth - clientWidth`. That number is 0 for one
// of the ugliest layouts the app can produce: a control row that wraps onto a second line, leaving
// the first line half empty, while the page itself fits perfectly. The discussion toolbar did this
// at ~460-540px whenever the "N new" catch-up button was present — a band the old width sweep
// stepped over, and a wrap the old check EXCUSED below 768px as "genuinely can't fit". The fix is
// to COLLAPSE overflow into the "..." menu (container queries `/tb`): the tools fold first, then the
// sort control, so the toolbar is a SINGLE ROW at every width instead of wrapping raggedly.
//
// So this guard now asserts the collapse, not "wraps well": ONE row at EVERY width (phone included),
// the tools-before-sort fold ORDER, and that nothing folded is lost (every control reachable via the
// menu). A single row with a wide gap between the count and the right-pinned actions is fine — that
// is a toolbar, not a ragged wrap; the defect was the SECOND line, and there is no longer one.
//
// The fixture deliberately turns EVERYTHING on (a prior visit so the "N new" jump renders, and a
// cloud key so the Ask tool renders). Without them the toolbar is two controls lighter than a real
// reader's and the failing band disappears — a fixture easier than reality reports clean.
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:4173/';
const now = Math.floor(Date.now() / 1000);
const STORY = 90210;
// 120 kids so BOTH the comment count and the "N new" catch-up count are 3-digit — the realistic
// max-content width. A 2-digit fixture "just fits" the capped column and hid a >=1280px wrap.
const kids = Array.from({ length: 120 }, (_, i) => ({
  id: STORY * 10 + i,
  author: `commenter${i}`,
  text: `<p>A substantive comment number ${i} with enough text to render as a real row.</p>`,
  created_at_i: now - 600 + i * 5,
  parent_id: STORY,
  story_id: STORY,
  points: null,
  type: 'comment',
  children: [],
}));

const fails = [];
const check = (name, pass, detail = '') => {
  console.log(`  ${pass ? '\u2713' : '\u2717'} ${name}${detail ? ` \u2014 ${detail}` : ''}`);
  if (!pass) fails.push(name);
};

const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ viewport: { width: 1280, height: 800 } });
const page = ctx.pages()[0] || (await ctx.newPage());

// Sweep the "…" overflow menu's placement across short viewports. Judged by HIT TEST, not just the
// bounding box: the sticky TopNav paints above the menu, so a menu flipped up under it is invisible
// AND unhittable (`elementFromPoint` returns the header); and a menu lifted over its own trigger puts
// a menu ITEM under the dismissal tap. Runs under BOTH pointer types because touch sizing makes the
// menu ~120px taller, which is the case that actually runs out of room.
async function sweepMenuPlacement(pg, label) {
  const offenders = [];
  for (const [w, h] of [[390, 500], [320, 568], [568, 320], [360, 640], [640, 360], [844, 390]]) {
    await pg.setViewportSize({ width: w, height: h });
    await pg.waitForTimeout(180);
    await pg.keyboard.press('Escape');
    await pg.waitForTimeout(100);
    const opened = await pg.evaluate(() => {
      const t = document.querySelector('.disc-toolbar button[aria-label="More discussion tools"]');
      if (!t) return false;
      t.click();
      return true;
    });
    if (!opened) continue; // nothing folded at this width — no menu to place
    await pg.waitForTimeout(250);
    const b = await pg.evaluate(() => {
      const m = document.querySelector('.disc-toolbar [role="menu"]');
      const t = document.querySelector('.disc-toolbar button[aria-label="More discussion tools"]');
      if (!m || !t) return null;
      const r = m.getBoundingClientRect();
      const tr = t.getBoundingClientRect();
      const atTrigger = document.elementFromPoint(tr.left + tr.width / 2, tr.top + tr.height / 2);
      const items = [...m.querySelectorAll('[role="menuitem"], button')];
      const unhittable = [];
      for (const it of items) {
        const ir = it.getBoundingClientRect();
        if (ir.width === 0 || ir.height === 0) continue;
        const at = document.elementFromPoint(ir.left + ir.width / 2, ir.top + ir.height / 2);
        if (!at || !m.contains(at)) unhittable.push((it.textContent || '').trim().slice(0, 16) || '?');
      }
      return {
        top: Math.round(r.top), bottom: Math.round(r.bottom),
        left: Math.round(r.left), right: Math.round(r.right),
        vw: window.innerWidth, vh: window.innerHeight,
        coversTrigger: !!atTrigger && m.contains(atTrigger),
        unhittable,
        scrolls: m.scrollHeight > m.clientHeight + 1,
      };
    });
    if (!b) { offenders.push(`${label} ${w}x${h}:no-menu`); continue; }
    const over = Math.max(0, b.bottom - b.vh) + Math.max(0, -b.top);
    const overX = Math.max(0, -b.left) + Math.max(0, b.right - b.vw);
    if (over > 1 || overX > 1) offenders.push(`${label} ${w}x${h}:overY=${over},overX=${overX}`);
    if (b.coversTrigger) offenders.push(`${label} ${w}x${h}:menu covers its own trigger`);
    // A scrolling menu legitimately keeps items outside its scrollport; only judge reachability when
    // the whole list is supposed to be visible at once.
    if (!b.scrolls && b.unhittable.length) offenders.push(`${label} ${w}x${h}:unhittable=${b.unhittable.join(',')}`);
  }
  return offenders;
}

try {
  await page.route(/hacker-news\.firebaseio\.com/, (r) => {
    const u = r.request().url();
    const j = (x) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(x) });
    if (u.includes('item/')) {
      return j({ id: STORY, type: 'story', by: 'op', title: 'A discussion with a full toolbar', url: 'https://ex.com/x', score: 394, descendants: kids.length, time: now - 43200 });
    }
    if (/topstories|beststories|newstories|askstories|showstories|jobstories/.test(u)) return j([STORY]);
    return j(null);
  });
  await page.route(/hn\.algolia\.com/, (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ id: STORY, story_id: STORY, title: 'A discussion with a full toolbar', url: 'https://ex.com/x', author: 'op', created_at_i: now - 43200, type: 'story', text: null, points: 394, children: kids }),
    })
  );

  await page.goto(`${BASE}#/item/${STORY}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.disc-toolbar', { timeout: 30000 });
  await page.evaluate(async (id) => {
    const dbMod = await window.__hnlens.db();
    await dbMod.db.seen.put({ id: Number(id), ts: Date.now() - 8000 * 1000 });
    window.__hnlens.prefs.getState().set({ llmProvider: 'gemini', apiKeys: { gemini: 'probe-key' } });
  }, STORY);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.disc-toolbar', { timeout: 30000 });
  await page.waitForTimeout(1200);

  // PRECONDITION: the row really is carrying its full complement of controls. The tools are icon-only
  // (a visible label can't fit the width-capped column), so detect Ask by its aria-label, not text.
  const pre = await page.evaluate(() => {
    const t = document.querySelector('.disc-toolbar')?.textContent ?? '';
    return { hasNew: /\d+\s+new/.test(t), hasAsk: !!document.querySelector('.disc-toolbar [aria-label="Ask"]') };
  });
  check('precondition: the toolbar carries every control (jump + Ask)', pre.hasNew && pre.hasAsk, JSON.stringify(pre));

  // SINGLE ROW AT EVERY WIDTH. The old sweep stepped over the ~460-540 band and excused sub-768
  // wraps as "can't fit" — the exact hole the ragged two-row toolbar shipped through. Sweep in
  // small steps across the WHOLE range, phones included, and require exactly one rendered row with
  // no page overflow. The overflow-into-menu collapse makes this true at every width.
  const rowFn = () => {
    const bar = document.querySelector('.disc-tb-bar');
    if (!bar) return null;
    const items = [...bar.children].filter((k) => k.getBoundingClientRect().width > 0);
    const buckets = [];
    for (const k of items) {
      const rect = k.getBoundingClientRect();
      const cy = rect.top + rect.height / 2;
      const hit = buckets.find((x) => Math.abs(x.cy - cy) < 12);
      if (hit) hit.w += rect.width;
      else buckets.push({ cy, w: rect.width });
    }
    return { rows: buckets.length, pageOver: document.documentElement.scrollWidth - document.documentElement.clientWidth };
  };
  // Swept in BOTH the default and the widest (monospace `terminal`) theme: the toolbar controls are
  // ~10% wider in mono, so a wrap can appear in terminal while default just fits. And the wide widths
  // (>=1024) matter because label/word visibility must be governed by the SAME axis as the fold — a
  // viewport-driven label on a width-capped column inflates content past the column without folding.
  const offenders = [];
  for (const theme of ['reader', 'terminal']) {
    await page.evaluate((id) => { const p = window.__hnlens.prefs; const s = p.getState ? p.getState() : p; if (s.setThemeName) s.setThemeName(id); }, theme);
    for (const w of [1440, 1280, 1152, 1024, 900, 820, 768, 700, 640, 600, 560, 540, 520, 500, 480, 460, 430, 390, 360, 320]) {
      await page.setViewportSize({ width: w, height: 800 });
      await page.waitForTimeout(150);
      const r = await page.evaluate(rowFn);
      if (!r) continue;
      if (r.rows !== 1 || r.pageOver > 0) offenders.push(`${theme}@${w}px: ${r.rows} row(s), pageOver=${r.pageOver}`);
    }
  }
  await page.evaluate(() => { const p = window.__hnlens.prefs; const s = p.getState ? p.getState() : p; if (s.setThemeName) s.setThemeName('reader'); });
  check('the discussion toolbar is a SINGLE row at every width (320-1440) x {default, widest theme}', offenders.length === 0, offenders.join(' | ') || '40 cells swept');

  // DEGRADATION ORDER (monotonic): as the toolbar narrows, Summary/Ask fold into "…" FIRST; the flat
  // Sort control degrades 4 segments → 2 buttons → 1 toggle (never folding fully — its options stay in
  // "…"); the Search box flex-fills then folds into "…" LAST. Measured by the visible sort-button count
  // + whether the inline Search box and the Summary/Ask group are present.
  const stateAt = async (w) => {
    await page.setViewportSize({ width: w, height: 800 });
    await page.waitForTimeout(180);
    return page.evaluate(() => {
      const bar = document.querySelector('.disc-tb-bar');
      const vis = (el) => !!(el && el.getBoundingClientRect().width > 0);
      const sortBtns = [...bar.querySelectorAll('.seg')].filter(vis).flatMap((s) => [...s.querySelectorAll('button')]).filter(vis).length;
      return { sortBtns, search: vis(bar.querySelector('input[type="search"]')), tools: vis(bar.querySelector('.seg-act')) };
    });
  };
  const s720 = await stateAt(720);
  const s660 = await stateAt(660);
  const s560 = await stateAt(560);
  const s440 = await stateAt(440);
  const s380 = await stateAt(380);
  check('wide (720px): full Sort (4 segments) + inline Search + Summary/Ask inline', s720.sortBtns === 4 && s720.search && s720.tools, JSON.stringify(s720));
  check('660px: Summary/Ask folded FIRST; full Sort still inline + Search inline', s660.sortBtns === 4 && s660.search && !s660.tools, JSON.stringify(s660));
  check('560px: Sort degrades to 2 buttons; Search still inline', s560.sortBtns === 2 && s560.search, JSON.stringify(s560));
  check('440px: Sort degrades to 1 toggle; Search still inline', s440.sortBtns === 1 && s440.search, JSON.stringify(s440));
  check('380px: Sort stays a toggle; Search folds into the menu LAST', s380.sortBtns === 1 && !s380.search, JSON.stringify(s380));

  // REACHABILITY: nothing folded is lost — at 360px the "..." menu holds every tool + every sort option.
  await page.setViewportSize({ width: 360, height: 800 });
  await page.waitForTimeout(200);
  let menuText = '';
  try {
    await page.click('.disc-toolbar button[aria-label="More discussion tools"]', { timeout: 4000 });
    await page.waitForTimeout(150);
    menuText = await page.evaluate(() => document.querySelector('.disc-toolbar [role="menu"]')?.textContent ?? '');
  } catch {
    menuText = ''; // no overflow menu at 360px is itself the failure (recorded below)
  }
  const wanted = ['Search', 'Summary', 'Ask', 'Default', 'Newest', 'Oldest', 'Replies'];
  const missing = menuText ? wanted.filter((t) => !menuText.includes(t)) : ['(no "..." menu at 360px)'];
  check('the overflow menu holds every folded control (3 tools + 4 sort options)', missing.length === 0, missing.length ? `missing: ${missing.join(', ')}` : 'all present');

  // M4 — below ~400px CQ the inline Search folds into the "…" menu. The remaining controls must form a
  // LEFT/RIGHT toolbar (right actions pinned), NOT clump at the left leaving a dead TRAILING gap on the
  // right. Assert the rightmost visible control sits at the bar's inner-right edge once Search has folded.
  await page.setViewportSize({ width: 380, height: 800 });
  await page.waitForTimeout(200);
  const narrowGap = await page.evaluate(() => {
    const bar = document.querySelector('.disc-tb-bar');
    const br = bar.getBoundingClientRect();
    const items = [...bar.children].filter((k) => k.getBoundingClientRect().width > 0);
    const rightmost = Math.max(...items.map((k) => k.getBoundingClientRect().right));
    const padRight = parseFloat(getComputedStyle(bar).paddingRight) || 0;
    // VISIBLE, not merely present: the folded search <input> stays in the DOM inside a display:none
    // span, so querySelector alone always finds it — check its rendered box.
    const si = bar.querySelector('input[type="search"]');
    return { searchInline: !!si && si.getBoundingClientRect().width > 0, trailing: Math.round(br.right - padRight - rightmost) };
  });
  check('narrow (<400px): Search has folded and the right actions are pinned — no dead trailing gap', !narrowGap.searchInline && narrowGap.trailing <= 12, JSON.stringify(narrowGap));

  // SR2 regression — the "…" overflow menu must stay fully on-screen at the narrowest width. It is
  // right-anchored (w-56) and the ⋯ trigger is pinned to the column's right edge, so without a viewport
  // clamp the menu spilled off the LEFT edge (measured -21px at 320px). A useLayoutEffect nudges it back.
  await page.setViewportSize({ width: 320, height: 800 });
  await page.waitForTimeout(200);
  await page.keyboard.press('Escape'); // close any menu the reachability check above left open
  await page.waitForTimeout(120);
  await page.evaluate(() => document.querySelector('.disc-toolbar button[aria-label="More discussion tools"]')?.click());
  await page.waitForTimeout(250);
  const menuBounds = await page.evaluate(() => {
    const m = document.querySelector('.disc-toolbar [role="menu"]');
    if (!m) return null;
    const r = m.getBoundingClientRect();
    return { left: Math.round(r.left), right: Math.round(r.right), vw: window.innerWidth };
  });
  check('the "…" overflow menu clamps fully on-screen at 320px (no left/right clip)', !!menuBounds && menuBounds.left >= -1 && menuBounds.right <= menuBounds.vw + 1, JSON.stringify(menuBounds));
  // SR-B regression — the clamp closes the menu on a viewport change (real parity with the story-card
  // menu), so it can't drift off-screen after a resize/rotate WHILE OPEN. Menu is still open from above.
  await page.setViewportSize({ width: 500, height: 800 });
  await page.waitForTimeout(200);
  const menuAfterResize = await page.evaluate(() => !!document.querySelector('.disc-toolbar [role="menu"]'));
  check('the "…" menu closes on a viewport resize while open (no off-screen drift)', !menuAfterResize, `menuStillOpen=${menuAfterResize}`);

  // The menu must stay on-screen VERTICALLY too, at REAL phone heights. The clamp above only ever
  // handled the horizontal axis while its comment claimed parity with the story-card menu, which
  // clamps both and flips above the trigger. The check that was supposed to catch this ran every
  // narrow width at height:800 — a height no phone has — so the whole axis went unmeasured: at
  // 568x320 (landscape phone) the entire menu opened below the fold, and tapping "…" appeared to do
  // nothing. Sweep short viewports and require the menu fully inside on BOTH axes.
  const vOffenders = await sweepMenuPlacement(page, 'mouse');
  check(
    'the "…" overflow menu stays on-screen, off the header and clear of its trigger (fine pointer)',
    vOffenders.length === 0,
    vOffenders.join(' | ') || '6 short-viewport cells swept',
  );
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForTimeout(150);

  // M3 — on a TOUCH device (coarse pointer) the toolbar's OWN controls are >=44px tap targets (the flat
  // Sort segments/toggle, the "…" overflow, the "N new" button), matching every sibling control. The
  // sweep above is a FINE pointer (denser 36/28px by design), so this needs its own touch context —
  // a viewport-only narrow context would test the wrong pointer type and wave the gap through.
  {
    const tctx = await b.newContext({ viewport: { width: 560, height: 900 }, hasTouch: true });
    const tp = await tctx.newPage();
    await tp.route(/hacker-news\.firebaseio\.com/, (r) => {
      const u = r.request().url();
      const j = (x) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(x) });
      if (u.includes('item/')) return j({ id: STORY, type: 'story', by: 'op', title: 'A discussion with a full toolbar', url: 'https://ex.com/x', score: 394, descendants: kids.length, time: now - 43200 });
      if (/topstories|beststories|newstories|askstories|showstories|jobstories/.test(u)) return j([STORY]);
      return j(null);
    });
    await tp.route(/hn\.algolia\.com/, (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: STORY, story_id: STORY, title: 'A discussion with a full toolbar', url: 'https://ex.com/x', author: 'op', created_at_i: now - 43200, type: 'story', text: null, points: 394, children: kids }) })
    );
    await tp.goto(`${BASE}#/item/${STORY}`, { waitUntil: 'domcontentloaded' });
    await tp.waitForSelector('.disc-toolbar', { timeout: 30000 });
    await tp.evaluate(async (id) => {
      const dbMod = await window.__hnlens.db();
      await dbMod.db.seen.put({ id: Number(id), ts: Date.now() - 8000 * 1000 });
      window.__hnlens.prefs.getState().set({ llmProvider: 'gemini', apiKeys: { gemini: 'probe-key' } });
    }, STORY);
    await tp.reload({ waitUntil: 'domcontentloaded' });
    await tp.waitForSelector('.disc-toolbar', { timeout: 30000 });
    await tp.waitForTimeout(800);
    const touch = await tp.evaluate(() => {
      const bar = document.querySelector('.disc-tb-bar');
      const els = [
        ...bar.querySelectorAll('.seg-btn'),
        ...bar.querySelectorAll('button[aria-label="More discussion tools"]'),
        ...bar.querySelectorAll('input[type="search"]'),
        ...[...bar.children].filter((k) => k.tagName === 'BUTTON' && /\d+\s+new/.test(k.textContent || '')),
      ].filter((e) => e.getBoundingClientRect().width > 0);
      const small = els
        .filter((e) => e.getBoundingClientRect().height < 44)
        .map((e) => ({ t: (e.textContent || e.getAttribute('aria-label') || '').trim().slice(0, 10), h: Math.round(e.getBoundingClientRect().height) }));
      return { coarse: matchMedia('(pointer: coarse)').matches, n: els.length, small };
    });
    check('touch: toolbar controls (Sort, Search, "…", "N new") are >=44px tap targets', touch.coarse && touch.n >= 4 && touch.small.length === 0, JSON.stringify(touch));
    const tOffenders = await sweepMenuPlacement(tp, 'touch');
    check(
      'touch: the "…" menu stays on-screen, off the header and clear of its trigger at phone heights',
      tOffenders.length === 0,
      tOffenders.join(' | ') || '6 short-viewport touch cells swept',
    );
    await tctx.close();
  }
} finally {
  await ctx.close().catch(() => {});
  await b.close().catch(() => {});
}

console.log(`\nRESULT: WRAP QUALITY ${fails.length ? `FAIL \u2717 (${fails.join('; ')})` : 'PASS \u2713'}`);
process.exit(fails.length ? 1 : 0);
