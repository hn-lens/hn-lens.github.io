// Control-row WRAP QUALITY.
//
// Every overflow guard in this repo measures `scrollWidth - clientWidth`. That number is 0 for one
// of the ugliest layouts the app can produce: a control row that wraps onto a second line, leaving
// the first line half empty, while the page itself fits perfectly. It shipped twice — once because a
// `flex-1` spacer ate every pixel of slack so the last control had nowhere to sit, and once because
// the row was simply over-stuffed at ordinary desktop widths. Both looked broken; neither overflowed.
//
// Two distinct failures, which need opposite fixes:
//   (a) wrapped ALTHOUGH the content would fit  -> a layout bug (greedy spacer / atomic cluster)
//   (b) wrapped at a desktop width (>= 768px)   -> over-stuffed; something has to get shorter
// Wrapping on a narrow screen because the content genuinely does not fit is correct and is allowed.
//
// The fixture deliberately turns EVERYTHING on (a prior visit so the "N new" jump renders, and a
// cloud key so the Ask tool renders). Without them the toolbar is two controls lighter than a real
// reader's and the failing band disappears — a fixture easier than reality reports clean.
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:4173/';
const now = Math.floor(Date.now() / 1000);
const STORY = 90210;
const kids = Array.from({ length: 40 }, (_, i) => ({
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

  // PRECONDITION: the row really is carrying its full complement of controls.
  const pre = await page.evaluate(() => {
    const t = document.querySelector('.disc-toolbar')?.textContent ?? '';
    return { hasNew: /\d+\s+new/.test(t), hasAsk: /Ask/.test(t) };
  });
  check('precondition: the toolbar carries every control (jump + Ask)', pre.hasNew && pre.hasAsk, JSON.stringify(pre));

  const offenders = [];
  for (const w of [1440, 1280, 1150, 1024, 980, 900, 820, 768, 700, 600, 500, 430, 390]) {
    await page.setViewportSize({ width: w, height: 800 });
    await page.waitForTimeout(300);
    const r = await page.evaluate(() => {
      const bar = document.querySelector('.disc-toolbar > div');
      if (!bar) return null;
      const inner = bar.clientWidth - 16;
      const items = [...bar.children].filter((k) => k.getBoundingClientRect().width > 0);
      // Bucket by vertical CENTRE: children of different heights share a visual row but never
      // share a `top`, so grouping on `top` counts every child as its own row.
      const buckets = [];
      for (const k of items) {
        const rect = k.getBoundingClientRect();
        const cy = rect.top + rect.height / 2;
        const hit = buckets.find((x) => Math.abs(x.cy - cy) < 12);
        if (hit) hit.w += rect.width;
        else buckets.push({ cy, w: rect.width });
      }
      const total = items.reduce((n, k) => n + k.getBoundingClientRect().width, 0) + 8 * (items.length - 1);
      return { rows: buckets.length, fits: total <= inner, total: Math.round(total), inner: Math.round(inner) };
    });
    if (!r) continue;
    if (r.rows > 1 && (r.fits || w >= 768)) {
      offenders.push(`${w}px: ${r.rows} rows, ${r.total}/${r.inner}px ${r.fits ? '(WRAPPED THOUGH IT FITS)' : '(over-stuffed at desktop width)'}`);
    }
  }
  check('the discussion toolbar is a single row at every desktop width', offenders.length === 0, offenders.join(' | ') || '13 widths swept');

  // PHONE SHAPE. Below ~440px the row genuinely cannot fit, so it WILL wrap — the requirement is
  // that it wraps WELL. Two failures were measured before: the comment count orphaned alone on a
  // line at 6% fill, and the action cluster stayed pinned right by `ml-auto` so its line began
  // ~60% of the way across. Page overflow is 0 in both cases, which is why an overflow-only guard
  // misses them entirely.
  const shapeOffenders = [];
  for (const w of [440, 390, 375, 360, 320]) {
    await page.setViewportSize({ width: w, height: 800 });
    await page.waitForTimeout(300);
    const r = await page.evaluate(() => {
      const bar = document.querySelector('.disc-toolbar > div');
      if (!bar) return null;
      const barRect = bar.getBoundingClientRect();
      const inner = bar.clientWidth - 16;
      const items = [...bar.children].filter((k) => k.getBoundingClientRect().width > 0);
      const buckets = [];
      for (const k of items) {
        const rect = k.getBoundingClientRect();
        const cy = rect.top + rect.height / 2;
        const hit = buckets.find((x) => Math.abs(x.cy - cy) < 12);
        if (hit) {
          hit.w += rect.width;
          hit.left = Math.min(hit.left, rect.left);
        } else buckets.push({ cy, w: rect.width, left: rect.left });
      }
      return {
        rows: buckets.length,
        fills: buckets.map((b) => +(b.w / inner).toFixed(2)),
        startX: buckets.map((b) => Math.round(b.left - barRect.left)),
      };
    });
    if (!r) continue;
    // No line may be nearly empty (the orphan), and no line may start stranded across the row.
    const orphan = r.fills.some((f) => f < 0.2);
    const stranded = r.startX.some((x) => x > 40);
    if (orphan || stranded || r.rows > 2) {
      shapeOffenders.push(`${w}px: rows=${r.rows} fills=[${r.fills}] startX=[${r.startX}]`);
    }
  }
  check(
    'when the toolbar must wrap on a phone, it wraps well (no orphan line, no stranded line, <=2 rows)',
    shapeOffenders.length === 0,
    shapeOffenders.join(' | ') || '5 phone widths swept'
  );
} finally {
  await ctx.close().catch(() => {});
  await b.close().catch(() => {});
}

console.log(`\nRESULT: WRAP QUALITY ${fails.length ? `FAIL \u2717 (${fails.join('; ')})` : 'PASS \u2713'}`);
process.exit(fails.length ? 1 : 0);
