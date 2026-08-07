// Content budget — a reading page must spend most of a screen on its CONTENT, not on its own
// furniture. Density here was keyed to viewport WIDTH only, so a phone held sideways — wide but
// ~360px tall — got the roomy desktop layout and spent 92% of the screen on chrome, leaving zero
// lines of comment text visible. This measures how far down the first comment starts and how many
// lines of body text are on screen.
//
// HERMETIC (2026-08-06): this used to measure whichever LIVE discussion HN happened to serve, so a
// story with a two-line title pushed the first comment ~44px lower and the measurement swung 45% ->
// 51% between runs — green locally, red on CI, for a reason that had nothing to do with the code.
// A randomly-failing gate is worse than none. The story is now a fixture with a fixed one-line
// title, so the number reflects the CHROME (topbar + header + control band) — which is what the
// budget is about — not title-length roulette. The components under measurement (topbar, header,
// band, comments) are the REAL ones; only the story DATA is mocked, so the furniture height is
// production-accurate. A two-line title counting as furniture is a separate SPEC-interpretation
// question, tracked in the register, not something this gate should decide at random.
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:4173/';
const now = Math.floor(Date.now() / 1000);
const fails = [];
const check = (name, pass, detail = '') => {
  console.log(`  ${pass ? '\u2713' : '\u2717'} ${name}${detail ? ` \u2014 ${detail}` : ''}`);
  if (!pass) fails.push(name);
};

const STORY_ID = 1000;
// A representative one-line HN title (~55 chars fits one line at 390px), a real URL so the
// Discussion/Article toggle renders (production furniture), and enough comments — each a paragraph
// long enough to wrap to several lines — that the tall viewports can show 5-6 lines of body text.
const TITLE = 'A small language model that runs entirely in your browser';
const PARA =
  '<p>This is a substantive comment with enough words to wrap across several lines at a comfortable ' +
  'reading measure, so the tall viewports have real body text to count rather than a one-line stub ' +
  'that would make the minimum-lines check pass for the wrong reason.</p>';
const mkTree = () => ({
  id: STORY_ID,
  story_id: STORY_ID,
  title: TITLE,
  url: 'https://example.com/small-lm',
  points: 240,
  author: 'op',
  created_at_i: now - 100000,
  type: 'story',
  text: null,
  children: Array.from({ length: 12 }, (_, i) => ({
    id: STORY_ID * 10 + i + 1,
    author: `commenter${i + 1}`,
    text: PARA,
    created_at_i: now - 80000 + i * 100,
    children: [],
  })),
});
const mkStory = () => ({ id: STORY_ID, type: 'story', by: 'op', title: TITLE, url: 'https://example.com/small-lm', score: 240, descendants: 12, time: now - 100000 });

const applyMocks = async (page) => {
  await page.route(/hacker-news\.firebaseio\.com/, (r) => {
    const u = r.request().url();
    const j = (x) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(x) });
    if (u.includes('/topstories.json')) return j([STORY_ID]);
    for (const ep of ['beststories', 'newstories', 'askstories', 'showstories', 'jobstories']) if (u.includes(`/${ep}.json`)) return j([]);
    const m = u.match(/item\/(\d+)/);
    if (m) return j(Number(m[1]) === STORY_ID ? mkStory() : null);
    if (u.includes('/user/')) return j({ id: 'x', karma: 1, created: now });
    if (u.includes('maxitem')) return j(9999);
    return j(null);
  });
  await page.route(/hn\.algolia\.com\/api\/v1\/search/, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ nbHits: 0, page: 0, nbPages: 0, hits: [] }) }),
  );
  await page.route(/hn\.algolia\.com\/api\/v1\/items\/(\d+)/, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(mkTree()) }),
  );
  await page.route(/google\.com\/s2\/favicons|gstatic\.com\/faviconV2/, (r) => r.fulfill({ status: 200, body: '' }));
};

// Short-and-wide is the case that was broken; the tall cases are the opposite-case control, so a
// fix that compacts everything everywhere fails here rather than shipping. On a screen under ~500px
// tall the tap minimum is already relaxed to 36px, which is what brought the furniture down from 92%.
 // Landscape ceilings were relaxed ~1-2pt (640/740x360: 72->73; 844x390: 67->69) so the /item
 // back-to-feed link can be a WCAG-AA 24px tap target. On a short landscape viewport the chrome is
 // an inherently large fraction of the screen — an independent review found even the pre-fix ~16px
 // button already sat at the 67% ceiling (844x390), so the %-budget was effectively unsatisfiable
 // there. 24px measures 71.4% (640/740) and 67.9% (844) — the relax keeps a real, near-current
 // budget while allowing the AA-minimum target. Portrait/desktop ceilings are UNCHANGED.
 const CASES = [
   { w: 640, h: 360, maxChromePct: 73, minLines: 1 },
   { w: 740, h: 360, maxChromePct: 73, minLines: 1 },
   { w: 844, h: 390, maxChromePct: 69, minLines: 1 },
   { w: 1024, h: 768, maxChromePct: 39, minLines: 6 },
   { w: 390, h: 844, maxChromePct: 47, minLines: 5 },
   { w: 1280, h: 800, maxChromePct: 38, minLines: 6 },
];

const b = await chromium.launch({ headless: true });
try {
  for (const c of CASES) {
    const ctx = await b.newContext({ viewport: { width: c.w, height: c.h }, isMobile: c.w < 1024, hasTouch: c.w < 1024 });
    const page = await ctx.newPage();
    await applyMocks(page);
    await page.addInitScript(() => {
      try {
        localStorage.setItem('hn:onboard', 'skip');
      } catch {
        /* private mode */
      }
    });
    await page.goto(`${BASE}#/item/${STORY_ID}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[id^="comment-"]', { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(1600);

    const r = await page.evaluate(() => {
      // To the first READABLE line, not to the top of the comment box: a byline with no text under
      // it is not reading, and measuring to the container edge flatters the result by every
      // comment's header. This is the stricter reading of the spec and what the reader waits to see.
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
        // Proof the FIXTURE (not a live fallback) is what's being measured, so the number is
        // deterministic across machines and runs.
        isFixture: /small language model/i.test(document.body.innerText),
        vh: window.innerHeight,
        overflow: Math.round(document.documentElement.scrollWidth - document.documentElement.clientWidth),
      };
    });

    const tag = `${c.w}x${c.h}`;
    check(`PRECONDITION: the thread rendered at ${tag}`, r.hasThread && r.firstTop !== null, JSON.stringify(r));
    if (!r.hasThread) {
      await ctx.close();
      continue;
    }
    // The mocked story — not a live one — is what's being measured, so the number is deterministic.
    check(`PRECONDITION: the fixture discussion is what rendered at ${tag}`, r.isFixture, `isFixture=${r.isFixture}`);
    const pct = Math.round((r.firstTop / r.vh) * 100);
    check(
      `at ${tag} the page spends at most ${c.maxChromePct}% of the screen before the first comment`,
      pct <= c.maxChromePct,
      `${pct}% (${r.firstTop}px of ${r.vh})`,
    );
    check(`at ${tag} at least ${c.minLines} lines of comment text are on screen`, r.lines >= c.minLines, `${r.lines} line(s)`);
    check(`at ${tag} the page does not scroll horizontally`, r.overflow <= 0, `overflow=${r.overflow}`);
    await ctx.close();
  }
} finally {
  await b.close();
}

console.log(`\n${fails.length === 0 ? 'RESULT: CONTENT BUDGET PASS \u2713' : `RESULT: ${fails.length} FAILED`}`);
process.exit(fails.length ? 1 : 0);
