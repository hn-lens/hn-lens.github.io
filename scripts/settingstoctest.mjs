// Settings table-of-contents test — guards the SettingsToc rail added to the Settings
// page: a sticky vertical rail (lg+) / wrapping pill bar (mobile) that jumps to
// each section and highlights the one in view. The correctness properties that matter:
//   1. every one of the 13 sections is listed (no missing entry);
//   2. every TOC entry points at a REAL element id on the page (no dead anchors — the bug
//      class where a section loses/renames its id and the link silently scrolls nowhere);
//   3. clicking a mid-page entry scrolls that section into view, CLEAR of the sticky top
//      nav (not hidden under it — that's what scroll-mt-20 buys), and marks it active;
//   4. the ?section=<id> deep-link (used by "Edit system instruction" etc.) still resolves
//      to each section now that every section carries an id.
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:4173/';

// Mirror of SETTINGS_SECTIONS in src/routes/Settings.tsx (id + visible label).
const EXPECTED = [
  ['account', 'Account'],
  ['appearance', 'Appearance & feed'],
  ['offline', 'Offline & install'],
  ['ranking', 'Ranking weights'],
  ['reranker', 'Learned reranker'],
  ['embeddings', 'Embeddings'],
  ['article-text', 'Article text'],
  ['privacy', 'Privacy'],
  ['ai-summaries', 'AI summaries'],
  ['ai-prompts', 'AI prompts'],
  ['models', 'Cached models'],
  ['filters', 'Filters'],
  ['data', 'Data'],
];

const fails = [];
const check = (name, pass, detail = '') => {
  console.log(`  ${pass ? '\u2713' : '\u2717'} ${name}${detail ? ` \u2014 ${detail}` : ''}`);
  if (!pass) fails.push(name);
};

const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ viewport: { width: 1280, height: 820 } });
const page = ctx.pages()[0] || (await ctx.newPage());
// Settings makes no HN list calls; stub everything defensively so nothing hangs.
await page.route(/hacker-news\.firebaseio\.com|hn\.algolia\.com|google\.com\/s2/, (r) =>
  r.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
);
await page.goto(`${BASE}#/settings`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('nav[aria-label="Settings sections"]', { timeout: 20000 });
await page.waitForTimeout(400);

// (1) All 12 entries render, in order, with the right labels.
const labels = await page.$$eval('nav[aria-label="Settings sections"] button', (bs) =>
  bs.map((x) => x.textContent.trim())
);
check('TOC lists all 13 sections', labels.length === EXPECTED.length, `got ${labels.length}: ${labels.join(' | ')}`);
check(
  'TOC labels match, in order',
  labels.join('||') === EXPECTED.map(([, l]) => l).join('||'),
  labels.join(' | ')
);

// (2) Every section id actually exists on the page (no dead anchors).
const missing = await page.evaluate(
  (ids) => ids.filter((id) => !document.getElementById(id)),
  EXPECTED.map(([id]) => id)
);
check('every TOC anchor resolves to a real element (no dead links)', missing.length === 0, `missing: ${missing.join(', ')}`);

// Poll an element's viewport-top until the smooth scroll settles (two equal reads), so
// assertions don't race the animation. Returns the settled top (or last read on timeout).
async function settledTop(pg, id, timeout = 3000) {
  const start = Date.now();
  let prev = null;
  while (Date.now() - start < timeout) {
    const top = await pg.evaluate((sid) => {
      const el = document.getElementById(sid);
      return el ? Math.round(el.getBoundingClientRect().top) : null;
    }, id);
    if (top !== null && top === prev) return top;
    prev = top;
    await pg.waitForTimeout(150);
  }
  return prev;
}

// Helper: click a TOC entry by label, return {active, top} for its section.
async function clickToc(label, id) {
  await page.getByRole('button', { name: label, exact: true }).click();
  const top = await settledTop(page, id);
  const active = await page.evaluate(() => {
    const el = document.querySelector('nav[aria-label="Settings sections"] [aria-current="true"]');
    return el ? el.textContent.trim() : '(none)';
  });
  return { active, top };
}

// (3) Click a mid-page entry (Filters) → scrolls into view, clear of nav, active.
const filters = await clickToc('Filters', 'filters');
check('clicking Filters marks it active', filters.active === 'Filters', filters.active);
check(
  'clicking Filters scrolls it into view, clear of the top nav',
  filters.top !== null && filters.top > 40 && filters.top < 320,
  `#filters top=${filters.top}`
);

// Click the last entry (Data) → also reachable + active.
const data = await clickToc('Data', 'data');
check('clicking Data marks it active', data.active === 'Data', data.active);
check('clicking Data scrolls it clear of the top nav', data.top !== null && data.top > 40 && data.top < 320, `#data top=${data.top}`);

// (4) ?section=<id> deep-link resolves for a section that only got its id from this feature.
// Use a fresh page (the realistic case: arriving via a link like "Edit system instruction"
// mounts Settings), and poll until the smooth scroll settles.
await ctx.close();
const dctx = await b.newContext({ viewport: { width: 1280, height: 820 } });
const dp = await dctx.newPage();
await dp.route(/hacker-news\.firebaseio\.com|hn\.algolia\.com|google\.com\/s2/, (r) =>
  r.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
);
await dp.goto(`${BASE}#/settings?section=reranker`, { waitUntil: 'domcontentloaded' });
await dp.waitForSelector('#reranker', { timeout: 15000 });
const rerankerTop = await settledTop(dp, 'reranker');
check(
  '?section=reranker deep-link scrolls to the section, clear of the nav',
  rerankerTop !== null && rerankerTop > 40 && rerankerTop < 320,
  `#reranker top=${rerankerTop}`
);
await dctx.close();

// Mobile: the rail WRAPS to multiple rows rather than becoming a horizontal-scroll strip
// (which hid sections off-screen with no scrollbar cue). It must still list every section
// and must NOT horizontally overflow.
const mctx = await b.newContext({ viewport: { width: 390, height: 780 } });
const mp = await mctx.newPage();
await mp.route(/hacker-news\.firebaseio\.com|hn\.algolia\.com|google\.com\/s2/, (r) =>
  r.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
);
await mp.goto(`${BASE}#/settings`, { waitUntil: 'domcontentloaded' });
await mp.waitForSelector('nav[aria-label="Settings sections"]', { timeout: 20000 });
const mLabels = await mp.$$eval('nav[aria-label="Settings sections"] button', (bs) => bs.map((x) => x.textContent.trim()));
check('mobile TOC still lists all 13 sections', mLabels.length === EXPECTED.length, `${mLabels.length}`);
const mOverflow = await mp.evaluate(() => {
  const ul = document.querySelector('nav[aria-label="Settings sections"] ul');
  return ul ? ul.scrollWidth > ul.clientWidth + 4 : true;
});
check('mobile TOC wraps to rows (no horizontal overflow / no hidden off-screen sections)', !mOverflow, `overflow=${mOverflow}`);

await mctx.close();
await b.close();
console.log(`\n${fails.length === 0 ? 'RESULT: SETTINGS-TOC PASS \u2713' : `RESULT: ${fails.length} FAILED`}`);
process.exit(fails.length ? 1 : 0);
