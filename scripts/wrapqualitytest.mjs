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

// One fixture bootstrap for every context (fine pointer, coarse pointer, and the max-content
// 4-digit-count case), so the three can never drift into testing different toolbars.
const STORY_META = (n) => ({ id: STORY, type: 'story', by: 'op', title: 'A discussion with a full toolbar', url: 'https://ex.com/x', score: 394, descendants: n, time: now - 43200 });
async function bootstrap(pg, kidList) {
  await pg.route(/hacker-news\.firebaseio\.com/, (r) => {
    const u = r.request().url();
    const j = (x) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(x) });
    if (u.includes('item/')) return j(STORY_META(kidList.length));
    if (/topstories|beststories|newstories|askstories|showstories|jobstories/.test(u)) return j([STORY]);
    return j(null);
  });
  await pg.route(/hn\.algolia\.com/, (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ id: STORY, story_id: STORY, title: 'A discussion with a full toolbar', url: 'https://ex.com/x', author: 'op', created_at_i: now - 43200, type: 'story', text: null, points: 394, children: kidList }),
    }),
  );
  await pg.goto(`${BASE}#/item/${STORY}`, { waitUntil: 'domcontentloaded' });
  await pg.waitForSelector('.disc-toolbar', { timeout: 30000 });
  // A prior visit makes every comment "new" so the catch-up button renders; a cloud key makes Ask
  // render. Without both, the row is two controls lighter than a real reader's.
  await pg.evaluate(async (id) => {
    const dbMod = await window.__hnlens.db();
    await dbMod.db.seen.put({ id: Number(id), ts: Date.now() - 8000 * 1000 });
    window.__hnlens.prefs.getState().set({ llmProvider: 'gemini', apiKeys: { gemini: 'probe-key' } });
  }, STORY);
  await pg.reload({ waitUntil: 'domcontentloaded' });
  await pg.waitForSelector('.disc-toolbar', { timeout: 30000 });
  await pg.waitForTimeout(1000);
}

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
  await bootstrap(page, kids);

  // PRECONDITION: the row really is carrying its full complement of controls. The tools are icon-only
  // (a visible label can't fit the width-capped column), so detect Ask by its aria-label, not text.
  const pre = await page.evaluate(() => ({
    hasNew: !!document.querySelector('.disc-tb-bar .disc-catchup'),
    hasAsk: !!document.querySelector('.disc-toolbar [aria-label="Ask"]'),
    hasToggle: !!document.querySelector('.disc-tb-bar .seg[aria-label="Read the discussion or the extracted article"]'),
  }));
  check('precondition: the band carries every control (view toggle + jump + Ask)', pre.hasNew && pre.hasAsk && pre.hasToggle, JSON.stringify(pre));

  // THE CONTROL BAND IS ONE ROW (SPEC 7.1). The unit of measurement is the chrome between the story
  // header and the first comment AS A WHOLE — the Discussion/Article view toggle, the count, sort,
  // the in-thread search, the "…" menu and the catch-up button. Two clusters that are each
  // individually a tidy single row still cost the reader two rows of a small screen, so the toggle
  // is counted in the SAME row budget as the toolbar, wherever in the DOM it is rendered.
  const bandFn = () => {
    const bar = document.querySelector('.disc-tb-bar');
    if (!bar) return null;
    const vis = (el) => {
      const r = el && el.getBoundingClientRect();
      return !!r && r.width > 0 && r.height > 0;
    };
    const toggle = document.querySelector('.seg[aria-label="Read the discussion or the extracted article"]');
    // A `display: contents` wrapper generates NO box: its own rect is 0x0 and its CHILD is the real
    // flex item. Measuring `bar.children` alone therefore silently skips every control that is
    // shown through one (the sort control and the Summary/Ask group), so both the row bucketing and
    // the fill are computed from a fraction of the row.
    const flat = [];
    for (const k of bar.children) {
      if (getComputedStyle(k).display === 'contents') flat.push(...[...k.children].filter(vis));
      else if (vis(k)) flat.push(k);
    }
    const parts = flat;
    if (vis(toggle) && !bar.contains(toggle)) parts.push(toggle);
    const cs = getComputedStyle(bar);
    const inner = bar.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
    // The container query resolves against the `@container/tb` element's inline size — the bar's
    // BORDER box — which is `inner` plus this row's padding and border. Reporting the content box
    // as "cq" makes every measured fold point look ~18px lower than the threshold that caused it.
    const cqEl = bar.parentElement;
    // The flex GAPS are occupied width too. Summing only the boxes reports a full row as ~94%
    // full and understates every row by (items-1) x gap, which is the difference between "the
    // filler did its job" and "there is dead space here".
    const gap = parseFloat(cs.columnGap || cs.gap) || 0;
    const buckets = [];
    for (const k of parts) {
      const r = k.getBoundingClientRect();
      const cy = r.top + r.height / 2;
      const hit = buckets.find((x) => Math.abs(x.cy - cy) < 12);
      if (hit) {
        hit.w += r.width + gap;
      } else buckets.push({ cy, w: r.width });
    }
    buckets.sort((a, b) => a.cy - b.cy);
    return {
      rows: buckets.length,
      fills: buckets.map((x) => Math.round((x.w / inner) * 100)),
      pageOver: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      searchInline: vis(bar.querySelector('input[type="search"]')),
      cq: Math.round(cqEl ? cqEl.getBoundingClientRect().width : inner),
      // HEADROOM: how many px the non-elastic controls could grow before this row must wrap. The
      // search is the flex filler, so the slack is whatever it holds ABOVE its own minimum; when it
      // is folded there is no filler and the slack is the row's unused width.
      headroom: (() => {
        const inp = bar.querySelector('input[type="search"]');
        const box = inp && inp.offsetParent !== null ? inp.closest('span,div') || inp : null;
        if (box) {
          const minPx = parseFloat(getComputedStyle(box).minWidth) || 0;
          return Math.round(box.getBoundingClientRect().width - minPx);
        }
        // No filler left, so the slack is the row's unused width. Measured from the SPAN the
        // controls actually occupy: summing bar.children counts a display:contents wrapper as zero
        // and silently omits every button inside it, which over-states the slack in precisely the
        // folded state this branch exists to measure.
        const leaves = [...bar.querySelectorAll('*')].filter((e) => {
          const r = e.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && ![...e.children].some((c) => c.getBoundingClientRect().width > 0);
        });
        if (!leaves.length) return Number.NaN;
        const l = Math.min(...leaves.map((e) => e.getBoundingClientRect().left));
        const r = Math.max(...leaves.map((e) => e.getBoundingClientRect().right));
        return Math.round(inner - (r - l));
      })(),
    };
  };

  // Four axes, because each one independently moves the fold points and each has hidden a defect:
  // WIDTH (320-1440 in 40px steps — a coarser sweep stepped over the band where the row broke),
  // THEME (mono `terminal` controls are ~10% wider than `reader`), READING TEXT SIZE (the axis
  // scales the ROOT font-size, so every rem-sized control grows while the viewport stays put), and
  // POINTER (a coarse pointer gets 44px targets, which is taller AND wider).
  // Absorbs the font-metric spread between machines; the observed spread was 8px.
  const MIN_HEADROOM = 12;
  const WIDTHS = [];
  for (let w = 1440; w >= 320; w -= 40) WIDTHS.push(w);
  const setAxes = (pg, theme, ts) =>
    pg.evaluate(
      ([t, s]) => {
        const st = window.__hnlens.prefs.getState();
        st.setThemeName(t);
        st.setTextSize(s);
      },
      [theme, ts],
    );
  async function sweepBand(pg, label, requireHeadroom = true) {
    const bad = [];
    for (const theme of ['reader', 'terminal']) {
      for (const ts of ['md', 'lg']) {
        await setAxes(pg, theme, ts);
        for (const w of WIDTHS) {
          await pg.setViewportSize({ width: w, height: 900 });
          await pg.waitForTimeout(110);
          const r = await pg.evaluate(bandFn);
          if (!r) continue;
          const cell = `${label}/${theme}/${ts}@${w}`;
          if (r.rows !== 1) bad.push(`${cell}: ${r.rows} rows fill=${r.fills.join('/')}%`);
          else if (r.pageOver > 0) bad.push(`${cell}: pageOver=${r.pageOver}`);
          // OPPOSITE CASE — nothing may fold while another control still has slack. The Search box
          // is the flex FILLER, so whenever it is inline it has by construction absorbed the row's
          // spare width: a low fill there means something folded early and left a dead gap.
          else if (r.searchInline && r.fills[0] < 96) bad.push(`${cell}: inline Search but row only ${r.fills[0]}% full (cq=${r.cq})`);
          // A cell that merely FITS is not safe: the same content measures wider on another machine
          // (a hosted runner rendered "999+ new" 8px wider than here, flipping a passing cell to two
          // rows and blocking a publish). Require slack so a metric difference cannot flip it.
          // Headroom is required on the REALISTIC sweeps. The max-content sweep stacks a 4-digit
          // comment count, a 4-digit unread count and the widest theme at once; it must still fit,
          // but demanding slack there too would need the tools to fold by theme, which a container
          // query cannot express (it measures the container, and the theme changes the CONTENT).
          // That remainder is recorded in review/REGISTER.md rather than silently dropped.
          // NaN fails every comparison, so `NaN < MIN` is false and an unmeasurable cell would slip
          // through as a pass. An unmeasurable cell is a failed measurement, not a good result.
          else if (requireHeadroom && !Number.isFinite(r.headroom)) bad.push(`${cell}: headroom could not be measured`);
          else if (requireHeadroom && r.headroom < MIN_HEADROOM) bad.push(`${cell}: only ${r.headroom}px headroom before it wraps (need ${MIN_HEADROOM})`);
        }
      }
    }
    await setAxes(pg, 'reader', 'md');
    return bad;
  }
  const bandBad = await sweepBand(page, 'mouse');
  check(
    'SPEC 7.1: the control band (view toggle + toolbar) is ONE full row at every width x {reader, terminal} x {default, large text}',
    bandBad.length === 0,
    bandBad.length ? `${bandBad.length} bad cells: ${bandBad.slice(0, 5).join(' | ')}${bandBad.length > 5 ? ` | +${bandBad.length - 5} more` : ''}` : `${WIDTHS.length * 4} cells swept`,
  );

  // DEGRADATION ORDER (monotonic): as the toolbar narrows, Summary/Ask fold into "…" FIRST; the flat
  // Sort control sheds ONE segment at a time, 4 → 3 → 2 → 1 (never folding fully — its options stay in
  // "…"); the Search box flex-fills then folds into "…" LAST. Measured by the visible sort-button count
  // + whether the inline Search box and the Summary/Ask group are present.
  const stateAt = async (w) => {
    await page.setViewportSize({ width: w, height: 800 });
    await page.waitForTimeout(180);
    return page.evaluate(() => {
      const bar = document.querySelector('.disc-tb-bar');
      const vis = (el) => !!(el && el.getBoundingClientRect().width > 0);
      // Scoped to the SORT control by name: the view toggle is a `.seg` too, so a bare `.seg`
      // query counts its segments as sort buttons and reports a degradation that never happened.
      const sortBtns = [...bar.querySelectorAll('.seg[aria-label="Sort comments"]')].filter(vis).flatMap((s) => [...s.querySelectorAll('button')]).filter(vis).length;
      const toggle = document.querySelector('.seg[aria-label="Read the discussion or the extracted article"]');
      return {
        sortBtns,
        search: vis(bar.querySelector('input[type="search"]')),
        tools: vis(bar.querySelector('.seg-act')),
        toggleSegs: toggle ? [...toggle.querySelectorAll('button')].filter(vis).length : 0,
        toggleNames: toggle ? [...toggle.querySelectorAll('button')].filter(vis).map((x) => x.getAttribute('aria-label') || (x.textContent || '').trim()) : [],
        // innerText, NOT textContent: a `display: none` label still contributes to textContent, so
        // a text match reports the word as present at every width and the fold is never observed.
        // Gated on the button being rendered, because innerText falls back to textContent for an
        // element that is not — which reports the word as present after the whole control folds.
        catchupWord: (() => {
          const el = document.querySelector('.disc-tb-bar .disc-catchup');
          return vis(el) && /new/i.test(el.innerText || '');
        })(),
        catchup: vis(document.querySelector('.disc-tb-bar .disc-catchup')),
        // True while ANY sort variant shows words: the 4- and 2-segment variants carry their text
        // as direct nodes, the single toggle carries it in a span that folds. Matching only spans
        // reports the labelled 4-segment state as unlabelled and the sequence reads non-monotone.
        sortLabelled: (() => {
          const seg = [...bar.querySelectorAll('.seg[aria-label="Sort comments"]')].find(vis);
          if (!seg) return false;
          return [...seg.querySelectorAll('button')].filter(vis).some(
            (btn) =>
              [...btn.childNodes].some((n) => n.nodeType === 3 && (n.textContent || '').trim()) ||
              [...btn.querySelectorAll('span')].some((x) => vis(x) && (x.textContent || '').trim()),
          );
        })(),
        inBar: !!toggle && !!bar && bar.contains(toggle),
      };
    });
  };

  // The band's controls degrade in a PRIORITY ORDER, and the order is the assertion — not a table of
  // pixel thresholds, which shifts every time a control joins the row. Swept descending, each
  // control's state must be monotone (never un-fold as the row gets narrower) and the widths at
  // which each degradation first appears must respect the order.
  const seq = [];
  for (const w of WIDTHS) {
    seq.push({ w, ...(await stateAt(w)) });
  }
  const firstAt = (pred) => {
    const hit = seq.find(pred);
    return hit ? hit.w : 0;
  };
  const nonMono = [];
  for (let i = 1; i < seq.length; i++) {
    const a = seq[i - 1];
    const c = seq[i]; // narrower
    if (c.sortBtns > a.sortBtns) nonMono.push(`sort ${a.w}->${c.w}: ${a.sortBtns}->${c.sortBtns}`);
    if (c.tools && !a.tools) nonMono.push(`tools unfolded ${a.w}->${c.w}`);
    if (c.search && !a.search) nonMono.push(`search unfolded ${a.w}->${c.w}`);
    if (c.catchupWord && !a.catchupWord) nonMono.push(`catch-up word returned ${a.w}->${c.w}`);
    if (c.sortLabelled && !a.sortLabelled) nonMono.push(`sort re-labelled ${a.w}->${c.w}`);
    if (c.catchup && !a.catchup) nonMono.push(`catch-up unfolded ${a.w}->${c.w}`);
  }
  check('degradation is MONOTONE in width (nothing un-folds as the band narrows)', nonMono.length === 0, nonMono.slice(0, 5).join(' | ') || `${seq.length} widths`);

  // Every intermediate sort state must actually OCCUR. A monotone count alone would be satisfied by
  // a control that jumped 4 -> 1, which is the collapse this ladder exists to avoid.
  const sortStates = [...new Set(seq.map((s) => s.sortBtns))].sort((a, b) => b - a);
  check(
    'the sort sheds ONE segment at a time: 4, 3, 2 and 1 segments all occur',
    [4, 3, 2, 1].every((n) => sortStates.includes(n)),
    `observed segment counts: ${sortStates.join(', ')}`,
  );

  const wTools = firstAt((s) => !s.tools);
  const wSort2 = firstAt((s) => s.sortBtns < 4);
  const wSort1 = firstAt((s) => s.sortBtns < 2);
  const wSearch = firstAt((s) => !s.search);
  const wCatchWord = firstAt((s) => !s.catchupWord);
  const wSortLabel = firstAt((s) => !s.sortLabelled);
  const wCatchup = firstAt((s) => !s.catchup);
  // SORT HAS PRIORITY over everything else in this band: a reader must be able to see, and change,
  // the order the thread is in. So Sort is the LAST control to give anything up -- Summary/Ask go
  // first, then the Search filler, and only then does Sort drop from four segments to two to one.
  // Search shrinks to a sliver before it folds, and when it does fold the Sort segments take the
  // freed width, so its departure leaves no hole. A zero means the control never folds at any swept
  // width, which for the sort label is the best outcome, so it is excluded from the ordering.
  const orderOk =
    wTools >= wSort2 && wSort2 >= wSearch && wSearch >= wSort1 && wSearch > 0;
  check(
    'fold ORDER: Summary/Ask first, then the Search filler — and Sort degrades LAST',
    orderOk,
    `tools@${wTools} sort4->2@${wSort2} search@${wSearch} sort2->1@${wSort1} catchupWord@${wCatchWord} catchup@${wCatchup} sortLabel@${wSortLabel}`,
  );
  // The view toggle is the surface's MODE switch: both segments stay visible at every width —
  // folding it into "…" would hide the Article view entirely, and in article view it is the only
  // control the band has. Drawn as icons, so its ACCESSIBLE NAMES carry the meaning.
  const toggleGone = seq.filter((s) => s.toggleSegs !== 2).map((s) => `${s.w}:${s.toggleSegs}`);
  check('the Discussion/Article toggle keeps BOTH segments visible at every width', toggleGone.length === 0, toggleGone.slice(0, 6).join(' | ') || `${seq.length} widths`);
  const badNames = seq.filter((s) => s.toggleNames.join('|') !== 'Discussion|Extracted article').map((s) => `${s.w}:${s.toggleNames.join('|')}`);
  check('the view toggle keeps the accessible names "Discussion" and "Extracted article" at every width', badNames.length === 0, badNames.slice(0, 4).join(' | ') || `${seq.length} widths`);
  check('the Discussion/Article toggle shares the toolbar row (it is inside the bar)', seq.every((s) => s.inBar), `inBar at ${seq.filter((s) => s.inBar).length}/${seq.length} widths`);
  // Two concrete anchors so the order check above can't be satisfied by a band that degraded
  // everything (or nothing) everywhere.
  const sWide = await stateAt(1440);
  const sNarrow = await stateAt(320);
  check(
    'widest (1440px): nothing is degraded — full Sort, inline Search, Summary/Ask inline, catch-up worded',
    sWide.sortBtns === 4 && sWide.search && sWide.tools && sWide.catchupWord,
    JSON.stringify(sWide),
  );
  check(
    'narrowest (320px): fully degraded — Sort is one toggle, Search folded, catch-up wordless, both view segments still there',
    sNarrow.sortBtns === 1 && !sNarrow.search && !sNarrow.catchupWord && sNarrow.toggleSegs === 2,
    JSON.stringify(sNarrow),
  );

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
  // Measured at EVERY width, not just the narrowest. A single-width probe passed while 75-115px of
  // dead space sat at the end of the row across a whole band of widths, because the width it
  // happened to sample was not one of them.
  const gapWidths = [320, 340, 360, 375, 390, 400, 420, 440, 470, 520, 600, 680, 760];
  const gaps = [];
  for (const gw of gapWidths) {
    await page.setViewportSize({ width: gw, height: 800 });
    await page.waitForTimeout(180);
    const g = await page.evaluate(() => {
      const bar = document.querySelector('.disc-tb-bar');
      const br = bar.getBoundingClientRect();
      // Deepest VISIBLE leaves: the sort and tools wrappers are display:contents, so their buttons
      // are grandchildren and a children-only scan reports the wrong rightmost edge.
      const leaves = [...bar.querySelectorAll('*')].filter((e) => {
        const r = e.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && ![...e.children].some((c) => c.getBoundingClientRect().width > 0);
      });
      if (!leaves.length) return null;
      const rightmost = Math.max(...leaves.map((e) => e.getBoundingClientRect().right));
      const padRight = parseFloat(getComputedStyle(bar).paddingRight) || 0;
      const si = bar.querySelector('input[type="search"]');
      return { searchInline: !!si && si.getBoundingClientRect().width > 0, trailing: Math.round(br.right - padRight - rightmost) };
    });
    gaps.push({ w: gw, ...(g || { trailing: null }) });
  }
  // Two classes the width-by-width sweep above cannot see, both of which shipped:
  //  - a control that folds out of the row must be reachable from the "..." menu at EVERY width.
  //    The inline box and its menu fallback are governed by SEPARATE thresholds, and when they
  //    disagreed there was a band of widths where the search existed in neither place.
  //  - growing a control to absorb the space a folded one left behind stretches its BOX; if its
  //    contents stay at their natural width the freed space becomes a blank tail inside the
  //    control, which is the same dead space measured a level deeper.
  const reach = [];
  for (const rw of [320, 360, 375, 390, 430, 470, 512, 560, 640, 760]) {
    await page.setViewportSize({ width: rw, height: 800 });
    await page.waitForTimeout(180);
    const r = await page.evaluate(async () => {
      const bar = document.querySelector('.disc-tb-bar');
      if (!bar) return null;
      const inp = bar.querySelector('input[type="search"]');
      const inline = !!inp && inp.getBoundingClientRect().width > 0;
      // The SORT control specifically. `.seg` also matches the Discussion/Article toggle, which
      // never grows, so a first-match lookup measures a control that cannot exhibit this defect.
      // Anchor on the sort BUTTON and measure the space left inside whatever container was
      // stretched around it. Targeting a container by selector picks the wrong element as the
      // ladder changes shape -- `.seg` also matches the view toggle, and the single-button form
      // has no group at all -- and each wrong target reports a comfortable zero.
      // ASYMMETRY, not the right gap alone. A stretched control whose label is centred has slack on
      // both sides and looks deliberate; the defect is slack that piles up on ONE side, which is
      // what a left-aligned label in a stretched box produces. Measuring only the right gap
      // condemns the centred case and would push the fix in the wrong direction.
      const inkTail = (el) => {
        if (!el || el.getBoundingClientRect().width === 0) return 0;
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        const rng = document.createRange();
        rng.selectNodeContents(el);
        const t = rng.getBoundingClientRect();
        if (!t || t.width === 0) return 0;
        const left = t.left - (r.left + parseFloat(cs.paddingLeft || '0'));
        const right = r.right - parseFloat(cs.paddingRight || '0') - t.right;
        return Math.round(Math.abs(right - left));
      };
      const sortBtns = [...bar.querySelectorAll('button')].filter(
        (x) => /newest|oldest|replies|default/i.test(x.textContent || '') && x.getBoundingClientRect().width > 0,
      );
      let tail = 0;
      for (const btn of sortBtns) {
        tail = Math.max(tail, inkTail(btn));
        const par = btn.parentElement;
        if (par && par.getBoundingClientRect().width > 0) {
          const pr = par.getBoundingClientRect();
          const padR = parseFloat(getComputedStyle(par).paddingRight || '0');
          const rightmost = Math.max(...[...par.children].filter((c) => c.getBoundingClientRect().width > 0).map((c) => c.getBoundingClientRect().right));
          tail = Math.max(tail, Math.round(pr.right - padR - rightmost));
        }
      }
      document.querySelector('.disc-toolbar button[aria-label="More discussion tools"]')?.click();
      await new Promise((res) => setTimeout(res, 320));
      const menu = document.querySelector('[role="menu"]');
      // VISIBLE, not merely present: a container-query-hidden entry is still in the DOM and still
      // matches by text, so a presence test reports it reachable when nothing is drawn.
      const inMenu = menu
        ? [...menu.querySelectorAll('[role="menuitem"]')].some((i) => /search/i.test(i.textContent || '') && i.getBoundingClientRect().width > 0)
        : false;
      document.querySelector('.disc-toolbar button[aria-label="More discussion tools"]')?.click();
      return { inline, inMenu, tail };
    });
    reach.push({ w: rw, ...(r || { inline: null }) });
  }
  // Whatever shape the sort control has been reduced to, it must still show which order the thread
  // is in. The reduced forms carried a FIXED subset, so an order outside that subset left every
  // segment unpressed and the control announced nothing.
  const sortState = [];
  for (const sw of [320, 360, 390, 430, 520, 640, 700, 760]) {
    await page.setViewportSize({ width: sw, height: 800 });
    await page.waitForTimeout(180);
    const st = await page.evaluate(() => {
      const bar = document.querySelector('.disc-tb-bar');
      if (!bar) return null;
      const btns = [...bar.querySelectorAll('button')].filter(
        (x) => /newest|oldest|replies|default/i.test(x.textContent || '') && x.getBoundingClientRect().width > 0,
      );
      if (!btns.length) return { none: true };
      const pressed = btns.filter((x) => x.getAttribute('aria-pressed') === 'true').map((x) => x.textContent.trim());
      // The single-toggle form is one button that NAMES the current order rather than pressing one
      // of several, so it states the order even with nothing pressed.
      const names = btns.length === 1 && /newest|oldest|replies|default/i.test(btns[0].textContent || '');
      return { count: btns.length, pressed, states: names || pressed.length === 1 };
    });
    sortState.push({ w: sw, ...(st || { none: true }) });
  }
  check('PRECONDITION: a sort control was found at every width', sortState.every((x) => !x.none), JSON.stringify(sortState.filter((x) => x.none)));
  const stateless = sortState.filter((x) => !x.none && !x.states);
  check(
    'the sort control shows which order the thread is in, at every width',
    stateless.length === 0,
    stateless.length ? stateless.map((x) => `${x.w}px: ${x.count} segments, ${x.pressed.length} pressed`).join(' | ') : `${sortState.length} widths`,
  );

  check('PRECONDITION: the toolbar was present at every width in the reachability sweep', reach.every((r) => r.inline !== null), JSON.stringify(reach.filter((r) => r.inline === null)));
  const unreachable = reach.filter((r) => r.inline === false && r.inMenu === false);
  check(
    'the in-thread search is reachable at every width, inline or from the "…" menu',
    unreachable.length === 0,
    unreachable.length ? unreachable.map((r) => `${r.w}px: in neither`).join(' | ') : `${reach.length} widths`,
  );
  const tails = reach.filter((r) => r.tail > 16);
  check(
    'no blank tail inside the sort control when it absorbs freed width',
    tails.length === 0,
    tails.length ? tails.map((r) => `${r.w}:${r.tail}px`).join(' | ') : `max ${Math.max(...reach.map((r) => r.tail))}px`,
  );

  check('PRECONDITION: the toolbar was measurable at every width in the gap sweep', gaps.every((g) => g.trailing !== null), JSON.stringify(gaps.filter((g) => g.trailing === null)));
  const badGaps = gaps.filter((g) => g.trailing !== null && g.trailing > 16);
  check(
    'no dead space at the end of the control row, at ANY width',
    badGaps.length === 0,
    badGaps.length ? badGaps.map((g) => `${g.w}:${g.trailing}px`).join(' | ') : `max ${Math.max(...gaps.map((g) => g.trailing))}px across ${gaps.length} widths`,
  );
  // Where the Search filler has folded there is no elastic control left, so a gap in the centre is
  // accepted. That licence is bounded by the sort control still being LABELLED there: the band may
  // look sparse, but it must not be sparse AND unreadable at the same width.
  const emptyCentreFrom = firstAt((s) => !s.search);
  const sortLabelledThere = seq.filter((s) => s.w <= emptyCentreFrom && !s.sortLabelled).map((s) => s.w);
  check(
    'wherever the Search filler has folded, the sort control still says which order it is in',
    emptyCentreFrom > 0 && sortLabelledThere.length === 0,
    `Search folds at ${emptyCentreFrom}px; unlabelled sort at ${sortLabelledThere.slice(0, 4).join(',') || 'none'}`,
  );

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
    await bootstrap(tp, kids);
    const touch = await tp.evaluate(() => {
      const bar = document.querySelector('.disc-tb-bar');
      const els = [
        ...bar.querySelectorAll('.seg-btn'),
        ...bar.querySelectorAll('button[aria-label="More discussion tools"]'),
        ...bar.querySelectorAll('input[type="search"]'),
        ...bar.querySelectorAll('.disc-catchup'),
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
    // The whole width x theme x text-size matrix again under a COARSE pointer, where every control
    // is both taller and wider.
    const tBand = await sweepBand(tp, 'touch');
    check(
      'touch: the control band is ONE full row across the same width x theme x text-size matrix',
      tBand.length === 0,
      tBand.length ? `${tBand.length} bad cells: ${tBand.slice(0, 5).join(' | ')}${tBand.length > 5 ? ` | +${tBand.length - 5} more` : ''}` : `${WIDTHS.length * 4} touch cells swept`,
    );
    await tctx.close();
  }

  // MAX CONTENT — a long-running thread revisited days later gives BOTH the comment count and the
  // catch-up count four digits. The count is data, so the band cannot rely on it being short: the
  // rendered catch-up label has to be bounded no matter how large the number gets.
  {
    const bigKids = Array.from({ length: 1400 }, (_, i) => ({
      id: STORY * 10 + i,
      author: `commenter${i}`,
      text: `<p>Comment ${i}.</p>`,
      created_at_i: now - 600 + i,
      parent_id: STORY,
      story_id: STORY,
      points: null,
      type: 'comment',
      children: [],
    }));
    const bctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
    const bp = await bctx.newPage();
    await bootstrap(bp, bigKids);
    const label = await bp.evaluate(() => {
      const el = document.querySelector('.disc-tb-bar .disc-catchup') || [...document.querySelectorAll('.disc-tb-bar button')].find((k) => /\d/.test(k.textContent || '') && /new/.test(k.textContent || ''));
      return el ? { text: (el.innerText || '').trim(), w: Math.round(el.getBoundingClientRect().width) } : null;
    });
    check('a 4-digit catch-up count renders a BOUNDED label (the number is capped, not laid out in full)', !!label && label.text.replace(/\D/g, '').length <= 3, JSON.stringify(label));
    const bBand = await sweepBand(bp, 'bigcount', false);
    check(
      'max-content (4-digit count + 4-digit catch-up): the band is ONE full row across the same matrix',
      bBand.length === 0,
      bBand.length ? `${bBand.length} bad cells: ${bBand.slice(0, 5).join(' | ')}${bBand.length > 5 ? ` | +${bBand.length - 5} more` : ''}` : `${WIDTHS.length * 4} max-content cells swept`,
    );
    await bctx.close();
  }
} finally {
  await ctx.close().catch(() => {});
  await b.close().catch(() => {});
}

console.log(`\nRESULT: WRAP QUALITY ${fails.length ? `FAIL \u2717 (${fails.join('; ')})` : 'PASS \u2713'}`);
process.exit(fails.length ? 1 : 0);
