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
} finally {
  await ctx.close().catch(() => {});
  await b.close().catch(() => {});
}

console.log(`\nRESULT: WRAP QUALITY ${fails.length ? `FAIL \u2717 (${fails.join('; ')})` : 'PASS \u2713'}`);
process.exit(fails.length ? 1 : 0);
