// Content budget — a page must spend most of a screen on its CONTENT, not on its own furniture.
//
// The discussion page exists to be read. Density here was keyed to viewport WIDTH only, so a phone
// held sideways — wide but ~360px tall — got the roomy layout meant for a desktop and spent 92% of
// the screen on chrome, leaving zero lines of comment text visible.
//
// This measures the thing a reader actually cares about: how far down the first comment starts, and
// how many lines of comment body are on screen. Width-based checks cannot see this class at all.
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:4173/';
const fails = [];
const check = (name, pass, detail = '') => {
  console.log(`  ${pass ? '\u2713' : '\u2717'} ${name}${detail ? ` \u2014 ${detail}` : ''}`);
  if (!pass) fails.push(name);
};

// Short-and-wide is the case that was broken; the tall cases are the opposite-case control, so a
// fix that compacts everything everywhere fails here rather than shipping.
// These ceilings are measured to the first READABLE LINE, not to the top of the first comment box.
// That is the stricter of two readings of the spec and the one that matches what a reader is
// waiting to see; it costs every comment's byline, so the numbers are several points higher than
// the same layout scored under the looser reading. They were RE-DERIVED when the convention
// changed -- carrying the old figures across would be comparing measurements taken with two
// different rulers. On a screen this short the tap minimum is already relaxed to 36px, which is
// what brought the furniture down from 92% with zero lines of text visible; going further would
// mean shrinking targets past the point a fingertip can rely on them.
// The line counts stay low on short screens because a genuinely one-line first comment is common;
// the tall cases carry the higher counts, and act as the opposite-case control so a fix that
// compacts every screen fails here rather than shipping.
const CASES = [
  { w: 640, h: 360, maxChromePct: 72, minLines: 1 },
  { w: 740, h: 360, maxChromePct: 72, minLines: 1 },
  { w: 844, h: 390, maxChromePct: 67, minLines: 1 },
  { w: 1024, h: 768, maxChromePct: 39, minLines: 6 },
  { w: 390, h: 844, maxChromePct: 47, minLines: 5 },
  { w: 1280, h: 800, maxChromePct: 38, minLines: 6 },
];

const b = await chromium.launch({ headless: true });
try {
  let id = null;
  {
    const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
    const p = await ctx.newPage();
    await p.goto(BASE, { waitUntil: 'domcontentloaded' });
    await p.waitForSelector('article[data-id]', { timeout: 45000 }).catch(() => {});
    await p.waitForTimeout(2000);
    id = await p.evaluate(() => {
      const arts = [...document.querySelectorAll('article[data-id]')];
      const withComments = arts.find((a) => /\d+\s*comment/i.test(a.textContent || ''));
      return (withComments || arts[0])?.getAttribute('data-id') ?? null;
    });
    await ctx.close();
  }
  check('PRECONDITION: a live discussion was found to measure', !!id, `id=${id}`);

  for (const c of CASES) {
    const ctx = await b.newContext({ viewport: { width: c.w, height: c.h }, isMobile: c.w < 1024, hasTouch: c.w < 1024 });
    const page = await ctx.newPage();
    await page.addInitScript(() => {
      try {
        localStorage.setItem('hn:onboard', 'skip');
      } catch {
        /* private mode */
      }
    });
    await page.goto(`${BASE}#/item/${id}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[id^="comment-"]', { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(2200);

    const r = await page.evaluate(() => {
      // To the first READABLE line, not to the top of the comment box. A byline with no text under
      // it is not reading, and measuring to the container's edge flatters the result by the height
      // of every comment's header. This is the stricter of the two readings of the spec and the one
      // that matches what the reader is actually waiting to see.
      const firstBody = document.querySelector('.comment-body');
      const first = firstBody || document.querySelector('[id^="comment-"]');
      const bodies = [...document.querySelectorAll('.comment-body')];
      let lines = 0;
      for (const el of bodies) {
        const bb = el.getBoundingClientRect();
        if (bb.bottom <= 0 || bb.top >= window.innerHeight) continue;
        const visible = Math.min(bb.bottom, window.innerHeight) - Math.max(bb.top, 0);
        const lh = parseFloat(getComputedStyle(el).lineHeight) || 20;
        lines += Math.max(0, Math.floor(visible / lh));
      }
      return {
        hasThread: !!first && bodies.length > 0,
        firstTop: first ? Math.round(first.getBoundingClientRect().top) : null,
        lines,
        vh: window.innerHeight,
        overflow: Math.round(document.documentElement.scrollWidth - document.documentElement.clientWidth),
      };
    });

    const tag = `${c.w}x${c.h}`;
    // Without a thread on screen the two checks below would measure an empty page and pass.
    check(`PRECONDITION: the thread rendered at ${tag}`, r.hasThread && r.firstTop !== null, JSON.stringify(r));
    if (!r.hasThread) {
      await ctx.close();
      continue;
    }
    const pct = Math.round((r.firstTop / r.vh) * 100);
    check(
      `at ${tag} the page spends at most ${c.maxChromePct}% of the screen before the first comment`,
      pct <= c.maxChromePct,
      `${pct}% (${r.firstTop}px of ${r.vh})`,
    );
    check(
      `at ${tag} at least ${c.minLines} lines of comment text are on screen`,
      r.lines >= c.minLines,
      `${r.lines} line(s)`,
    );
    // Compacting must not be paid for by pushing the page sideways.
    check(`at ${tag} the page does not scroll horizontally`, r.overflow <= 0, `overflow=${r.overflow}`);
    await ctx.close();
  }
} finally {
  await b.close();
}

console.log(`\n${fails.length === 0 ? 'RESULT: CONTENT BUDGET PASS \u2713' : `RESULT: ${fails.length} FAILED`}`);
process.exit(fails.length ? 1 : 0);
