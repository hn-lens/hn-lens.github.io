// In-thread search index — guards that the cost of the FEATURE is paid by the people who USE it.
//
// Building the search index costs one `stripHtml` per comment, and `stripHtml` is a DOMPurify
// sanitize plus a full DOM build and walk. Built eagerly it ran on every discussion open, ahead of
// the comments the reader was waiting for, whether or not they ever searched — so a reader who
// never used search still paid for the whole index on every thread they opened.
//
// The observable is `sanitizeCacheStats().size`: the number of DISTINCT comment bodies parsed this
// page-load. Auto-collapse leaves most of a real thread unmounted, so an open should parse only the
// comments actually on screen. If the index is eager, the count on open is the whole thread instead
// — which is exactly what this asserts against, and what it caught.
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:4173/';
const now = Math.floor(Date.now() / 1000);
const ID = 7100;
const N = 400; // top-level comments, each with a distinct body

const mkStory = (id, n) => ({ id, type: 'story', by: 'op', title: `Story ${id}`, url: `https://ex${id}.com/x`, score: 300, descendants: n, time: now - 100000 });

// Every comment gets a UNIQUE body so each is a distinct cache key, and each top-level comment
// carries 3 replies — over the auto-collapse threshold — so the replies stay out of the document
// until expanded. Total bodies in the thread: N * 4.
const children = [];
for (let i = 0; i < N; i++) {
  children.push({
    id: 8000 + i, author: `user${i}`,
    text: `<p>Distinct comment body number ${i} about a topic, long enough to be a realistic paragraph of discussion text.</p>`,
    created_at_i: now - 9000 + i, parent_id: ID, story_id: ID, points: null, type: 'comment',
    children: Array.from({ length: 3 }, (_, k) => ({
      id: 800000 + i * 10 + k, author: `r${i}_${k}`,
      text: `<p>Nested reply ${k} to comment ${i}, also unique so it is its own sanitize-cache entry.</p>`,
      created_at_i: now - 8000, parent_id: 8000 + i, story_id: ID, points: null, type: 'comment', children: [],
    })),
  });
}
const TOTAL_BODIES = N * 4;
const tree = { id: ID, story_id: ID, title: `Story ${ID}`, url: `https://ex${ID}.com/x`, author: 'op', created_at_i: now - 100000, text: null, points: 300, parent_id: null, type: 'story', children };

const fails = [];
const check = (name, pass, detail = '') => {
  console.log(`  ${pass ? '\u2713' : '\u2717'} ${name}${detail ? ` \u2014 ${detail}` : ''}`);
  if (!pass) fails.push(name);
};

const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
const page = ctx.pages()[0] || (await ctx.newPage());
await page.route(/hacker-news\.firebaseio\.com/, (r) => {
  const u = r.request().url();
  const j = (x) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(x) });
  if (/topstories/.test(u)) return j([ID]);
  if (/(best|new|ask|show|job)stories/.test(u)) return j([]);
  const m = u.match(/item\/(\d+)/);
  if (m) return j(Number(m[1]) === ID ? mkStory(ID, TOTAL_BODIES) : null);
  return j(null);
});
await page.route(/hn\.algolia\.com|google\.com\/s2/, (r) => r.fulfill({ status: 200, body: '{}' }));
await page.route(/hn\.algolia\.com\/api\/v1\/items\/(\d+)/, (r) =>
  r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(tree) })
);

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__hnlens && window.__hnlens.prefs, null, { timeout: 20000 });
await page.evaluate(() => window.__hnlens.prefs.getState().set({ llmEnabled: false, minPoints: 0 }));

const cacheSize = async () =>
  await page.evaluate(async () => (await window.__hnlens.html()).sanitizeCacheStats().size);

// ---- opening the discussion must not index the thread ----
await page.goto(`${BASE}#/item/${ID}`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('[id^="comment-"]', { timeout: 20000 });
await page.waitForTimeout(900); // let any deferred work settle, so this is not just a timing race

const mounted = await page.locator('[id^="comment-"]').count();
const onOpen = await cacheSize();
check(
  `PRECONDITION: auto-collapse keeps most of the thread unmounted (${mounted} of ${TOTAL_BODIES} rendered)`,
  mounted < TOTAL_BODIES * 0.6,
  `${mounted}/${TOTAL_BODIES}`
);
check(
  'opening a discussion parses only the comments it renders, not the whole thread',
  onOpen < TOTAL_BODIES * 0.6,
  `${onOpen} parsed / ${TOTAL_BODIES} in thread`
);
// Tie the number to what is on screen, so a future eager-index regression cannot hide behind a
// loose fraction: the parse count should track the rendered count, with headroom for the story
// body and any preview text.
check(
  '...and the parse count tracks what is on screen',
  onOpen <= mounted + 50,
  `${onOpen} parsed vs ${mounted} rendered`
);

// ---- the first search must not freeze the input ----
// The index used to be built with `stripHtml` — a DOMPurify pass plus a full DOM parse per comment.
// It all landed on keystroke 2 (the minimum query length): 849ms blocked at 500 comments and
// 2,710ms at 2,000 on a throttled phone, with the caret frozen mid-word. Matching needs plain text,
// not a sanitized DOM, so the index is built with `searchText` and the sanitize cache — the
// observable this file used to count — is no longer touched by searching at all. That is the fix,
// which is why the assertion is now about TIME rather than about parses.
// Search is now an always-visible INLINE filter box on the toolbar (no tool/tray to open at this width).
await page.getByLabel('Search comments in this discussion').first().click();
await page.waitForTimeout(200);
const box = page.getByLabel('Search comments in this discussion');
check('PRECONDITION: the inline search input is present and reachable', (await box.count()) > 0);

await page.evaluate(() => {
  window.__lt = [];
  new PerformanceObserver((l) => {
    for (const e of l.getEntries()) window.__lt.push(e.duration);
  }).observe({ entryTypes: ['longtask'] });
});
await box.first().fill('di'); // exactly the minimum length — the keystroke that used to freeze
await page.waitForTimeout(1500);
const firstSearchBlocked = await page.evaluate(() => window.__lt.reduce((a, b) => a + b, 0));
check(
  'the first search does not freeze the input while it indexes',
  firstSearchBlocked < 250,
  `${Math.round(firstSearchBlocked)}ms blocked across ${TOTAL_BODIES} comments`
);

await box.first().fill('distinct');
await page.waitForTimeout(900);
const matched = await page.evaluate(() => /\d+ match/.test(document.body.innerText));
check('...and it still actually matches', matched);

// Searching must not drag the display cache along with it: the index is plain-text only, so the
// count that measures RENDERED comments should be unchanged by a search over all of them.
const afterSearch = await cacheSize();
check(
  'searching does not sanitize the whole thread as a side effect',
  afterSearch <= onOpen + 50,
  `${onOpen} on open -> ${afterSearch} after searching ${TOTAL_BODIES} comments`
);

// ---- a session's working set stays under the eviction cap ----
// The sanitize cache is per-page-load and CUMULATIVE across threads, and its eviction policy has a
// cliff rather than a slope: past the cap a cyclic re-render evicts the entry it is about to need,
// and the measured cost inverted to worse than no cache at all. So the property that matters is not
// "is there a cap" but "does a realistic session stay under it". Reading several large threads in
// one tab is the case that used to blow it, because each open indexed the entire thread.
// Scaled to the largest thread HN actually produces (~4,383 bodies) rather than to this fixture, so
// the assertion is about the real budget and not about the size of the mock.
const { max } = await page.evaluate(async () => (await window.__hnlens.html()).sanitizeCacheStats());
const BIGGEST_REAL_THREAD = 4383;
const renderedFraction = mounted / TOTAL_BODIES;
const openCostOfBiggest = Math.round(BIGGEST_REAL_THREAD * renderedFraction);
check(`PRECONDITION: the cap is visible to the harness`, max > 0, String(max));
check(
  'a heavy session of OPENED large threads stays under the eviction cap',
  openCostOfBiggest * 10 < max,
  `10 x ~${openCostOfBiggest} (largest thread, ${(renderedFraction * 100).toFixed(0)}% rendered) = ${openCostOfBiggest * 10} vs cap ${max}`
);
// The search-crosses-the-cap residual that used to be documented here is GONE: the index no longer
// sanitizes anything, so searching contributes nothing to this cache. Only rendering does.
check(
  'searching contributes nothing to the eviction budget',
  afterSearch <= onOpen + 50,
  `${afterSearch} after searching ${TOTAL_BODIES} comments`
);

await b.close();
if (fails.length) {
  console.error(`\nRESULT: ${fails.length} FAILED`);
  process.exit(1);
}
console.log('\nRESULT: SEARCH INDEX PASS \u2713');
