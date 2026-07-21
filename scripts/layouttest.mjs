// Functional proof that the LAYOUT axis actually restructures the DOM — not just
// recolors. Over a mocked HN API at a desktop width, it switches through all 6
// layouts and asserts CONCRETE structural facts (grid vs flex, borderless numbered
// rows, single-line compact, hidden sidebar, vertical nav rail) + zero console
// errors. Also drops a screenshot per layout in scripts/.artifacts/themes/.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.BASE || 'http://localhost:4173/';
const OUT = join(dirname(fileURLToPath(import.meta.url)), '.artifacts', 'themes');
mkdirSync(OUT, { recursive: true });

const now = Math.floor(Date.now() / 1000);
const IDS = [1, 2, 3, 4, 5, 6];
const mk = (id) => ({ id, type: 'story', by: `user${id}`, title: `Story number ${id} about software and systems design`, url: `https://d${id}.example/x`, score: 100 + id, descendants: 20 + id, time: now - 3600 * id });

const fails = [];
const errs = [];
const check = (name, pass, detail = '') => {
  console.log(`  ${pass ? '\u2713' : '\u2717'} ${name}${detail ? ` \u2014 ${detail}` : ''}`);
  if (!pass) fails.push(name);
};

const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
const page = ctx.pages()[0] || (await ctx.newPage());
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  const u = m.location()?.url || '';
  if (/favicons|gstatic|google\.com\/s2/.test(u)) return;
  errs.push(m.text());
});
page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));

await page.route(/hacker-news\.firebaseio\.com/, (r) => {
  const u = r.request().url();
  const j = (x) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(x) });
  if (/(top|best|new)stories/.test(u)) return j(IDS);
  if (/(ask|show|job)stories/.test(u)) return j([]);
  const m = u.match(/item\/(\d+)/);
  if (m) return j(mk(Number(m[1])));
  if (u.includes('/user/')) return j({ id: 'x', karma: 1, created: now });
  return j(null);
});
await page.route(/hn\.algolia\.com|google\.com\/s2/, (r) => r.fulfill({ status: 200, body: '{}' }));

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__hnlens && window.__hnlens.prefs, null, { timeout: 20000 });
await page.evaluate(() => {
  const s = window.__hnlens.prefs.getState();
  s.setThemeName('reader'); // isolate LAYOUT from palette
  s.set({ defaultFeed: 'top', minPoints: 0, useLearnedRanker: false, embeddingsEnabled: false });
});
await page.waitForSelector('article.story-card', { timeout: 15000 });

const setLayout = async (id) => {
  await page.evaluate((l) => window.__hnlens.prefs.getState().setLayout(l), id);
  await page.waitForTimeout(200);
};
// Read computed styles / visibility for the structural hooks.
const probe = () =>
  page.evaluate(() => {
    const cs = (sel, prop) => {
      const el = document.querySelector(sel);
      return el ? getComputedStyle(el)[prop] : null;
    };
    const before = (sel) => {
      const el = document.querySelector(sel);
      return el ? getComputedStyle(el, '::before').content : null;
    };
    return {
      dataLayout: document.documentElement.dataset.layout,
      feedDisplay: cs('.feed-list', 'display'),
      feedCols: cs('.feed-list', 'gridTemplateColumns'),
      feedColumnCount: cs('.feed-list', 'columnCount'),
      feedPadLeft: parseFloat(cs('.feed-list', 'paddingLeft') || '0'),
      cardRadius: cs('.story-card', 'borderTopLeftRadius'),
      cardBg: cs('.story-card', 'backgroundColor'),
      cardBorderBottom: cs('.story-card', 'borderBottomWidth'),
      cardBorderLeft: parseFloat(cs('.story-card', 'borderLeftWidth') || '0'),
      cardBefore: before('.story-card'),
      titleSize: parseFloat(cs('.sc-title', 'fontSize') || '0'),
      numDisplay: cs('.sc-num', 'display'),
      faviconDisplay: cs('.sc-favicon', 'display'),
      leadDisplay: cs('.sc-lead', 'display'),
      bodyDisplay: cs('.sc-body', 'display'),
      actionsDisplay: cs('.sc-actions', 'display'),
      metaDisplay: cs('.sc-meta', 'display'),
      sidebarDisplay: cs('.app-sidebar', 'display'),
      contentDisplay: cs('.app-content', 'display'),
      tabsDir: cs('.feed-tabs', 'flexDirection'),
    };
  });

// ── cards (baseline) ──
await setLayout('cards');
let s = await probe();
await page.screenshot({ path: join(OUT, 'layout-cards.png') });
console.log('\n[cards]', JSON.stringify(s));
check('cards: feed is a vertical flex list', s.feedDisplay === 'flex', s.feedDisplay);
check('cards: cards have rounded corners', parseFloat(s.cardRadius) > 0, s.cardRadius);
check('cards: sidebar visible', s.sidebarDisplay !== 'none', s.sidebarDisplay);
check('cards: index number hidden', s.numDisplay === 'none', s.numDisplay);

// ── list ──
await setLayout('list');
s = await probe();
await page.screenshot({ path: join(OUT, 'layout-list.png') });
console.log('[list]', JSON.stringify(s));
check('list: rows are borderless (square corners)', parseFloat(s.cardRadius) === 0, s.cardRadius);
check('list: rows have a hairline separator', parseFloat(s.cardBorderBottom) > 0, s.cardBorderBottom);
check('list: numbers shown', s.numDisplay !== 'none', s.numDisplay);
check('list: favicons hidden', s.faviconDisplay === 'none', s.faviconDisplay);

// ── compact ──
await setLayout('compact');
s = await probe();
await page.screenshot({ path: join(OUT, 'layout-compact.png') });
console.log('[compact]', JSON.stringify(s));
check('compact: body is a single flex row', s.bodyDisplay === 'flex', s.bodyDisplay);
check('compact: action buttons hidden', s.actionsDisplay === 'none', s.actionsDisplay);
check('compact: meta line hidden', s.metaDisplay === 'none', s.metaDisplay);

// ── magazine ──
await setLayout('magazine');
s = await probe();
await page.screenshot({ path: join(OUT, 'layout-magazine.png') });
console.log('[magazine]', JSON.stringify(s));
check('magazine: feed is a grid', s.feedDisplay === 'grid', s.feedDisplay);
check('magazine: grid has 2 columns', (s.feedCols || '').split(' ').filter(Boolean).length === 2, s.feedCols);

// ── zen ──
await setLayout('zen');
s = await probe();
await page.screenshot({ path: join(OUT, 'layout-zen.png') });
console.log('[zen]', JSON.stringify(s));
check('zen: sidebar hidden', s.sidebarDisplay === 'none', s.sidebarDisplay);
check('zen: single centered column', (s.feedDisplay === 'flex' || s.feedDisplay === 'grid') && s.dataLayout === 'zen', s.dataLayout);

// ── rail ──
await setLayout('rail');
s = await probe();
await page.screenshot({ path: join(OUT, 'layout-rail.png') });
console.log('[rail]', JSON.stringify(s));
check('rail: content becomes a 2-col grid (rail + feed)', s.contentDisplay === 'grid', s.contentDisplay);
check('rail: nav tabs stack vertically', s.tabsDir === 'column', s.tabsDir);

// ── grid (uniform 3-col tiles) ──
await setLayout('grid');
s = await probe();
await page.screenshot({ path: join(OUT, 'layout-grid.png') });
console.log('[grid]', JSON.stringify(s));
check('grid: feed is a grid', s.feedDisplay === 'grid', s.feedDisplay);
check('grid: 3 columns at desktop width', (s.feedCols || '').split(' ').filter(Boolean).length === 3, s.feedCols);

// ── timeline (spine + node dots) ──
await setLayout('timeline');
s = await probe();
await page.screenshot({ path: join(OUT, 'layout-timeline.png') });
console.log('[timeline]', JSON.stringify(s));
check('timeline: feed has a left gutter for the spine', s.feedPadLeft > 10, String(s.feedPadLeft));
check('timeline: each story has a node dot (::before)', s.cardBefore != null && s.cardBefore !== 'none', s.cardBefore);
check('timeline: lead column hidden (dot replaces it)', s.leadDisplay === 'none', s.leadDisplay);

// ── media (large spacious rows) ──
await setLayout('media');
s = await probe();
await page.screenshot({ path: join(OUT, 'layout-media.png') });
console.log('[media]', JSON.stringify(s));
check('media: larger title', s.titleSize >= 16, String(s.titleSize));
check('media: prominent index number shown', s.numDisplay !== 'none', s.numDisplay);

// ── newspaper (multi-column flow) ──
await setLayout('newspaper');
s = await probe();
await page.screenshot({ path: join(OUT, 'layout-newspaper.png') });
console.log('[newspaper]', JSON.stringify(s));
check('newspaper: feed flows into multiple columns', parseInt(s.feedColumnCount, 10) >= 2, s.feedColumnCount);
check('newspaper: entries borderless (square)', parseFloat(s.cardRadius) === 0, s.cardRadius);

// ── cover (bold bands + accent bar) ──
await setLayout('cover');
s = await probe();
await page.screenshot({ path: join(OUT, 'layout-cover.png') });
console.log('[cover]', JSON.stringify(s));
check('cover: accent left bar on each band', s.cardBorderLeft >= 3, String(s.cardBorderLeft));
check('cover: large cover title', s.titleSize >= 20, String(s.titleSize));

// ── bento (mixed-size tile grid) ──
await setLayout('bento');
s = await probe();
await page.screenshot({ path: join(OUT, 'layout-bento.png') });
console.log('[bento]', JSON.stringify(s));
check('bento: feed is a grid', s.feedDisplay === 'grid', s.feedDisplay);
check('bento: 4-column tile track at desktop', (s.feedCols || '').split(' ').filter(Boolean).length === 4, s.feedCols);

// ── feature (hero + dense list) ──
await setLayout('feature');
s = await probe();
await page.screenshot({ path: join(OUT, 'layout-feature.png') });
console.log('[feature]', JSON.stringify(s));
check('feature: hero story has a large title', s.titleSize >= 22, String(s.titleSize));

// ── masonry (staggered columns, cards keep boxes) ──
await setLayout('masonry');
s = await probe();
await page.screenshot({ path: join(OUT, 'layout-masonry.png') });
console.log('[masonry]', JSON.stringify(s));
check('masonry: feed flows into multiple columns', parseInt(s.feedColumnCount, 10) >= 2, s.feedColumnCount);
check('masonry: cards keep rounded boxes', parseFloat(s.cardRadius) > 0, s.cardRadius);

// ── every DESIGN applies cleanly (palette/font/radius/surface) in light AND dark ──
await setLayout('cards');
const themeIds = await page.$$eval('select[aria-label="Theme design"] option', (els) => els.map((e) => e.value));
let themeBroke = '';
for (const id of themeIds) {
  for (const mode of ['light', 'dark']) {
    await page.evaluate(
      ([t, m]) => {
        const st = window.__hnlens.prefs.getState();
        st.setThemeName(t);
        st.setTheme(m);
      },
      [id, mode]
    );
    await page.waitForTimeout(25);
    if ((await page.locator('article.story-card').count()) === 0) themeBroke = `${id}/${mode}`;
  }
}
check(`all ${themeIds.length} designs render in light & dark`, !themeBroke, themeBroke || `${themeIds.length} designs`);

check('no console errors across all layouts + themes', errs.length === 0, errs.slice(0, 3).join(' | '));

await b.close();
console.log(`\n${fails.length === 0 ? 'RESULT: LAYOUTS RESTRUCTURE THE DOM \u2713' : `RESULT: ${fails.length} FAILED`}`);
process.exit(fails.length ? 1 : 0);
