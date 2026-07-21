// Non-AI thread "gist" test — guards the feature: long threads get a fast, no-model
// digest of the most-substantive/most-replied comments (for readers who won't enable
// the local LLM). Asserts it appears on a long thread, lists the key comments when
// expanded, and does NOT appear on a short thread.
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:4173/';
const now = Math.floor(Date.now() / 1000);

const LONG_ID = 5000;
const SHORT_ID = 5001;
const mkStory = (id, n) => ({ id, type: 'story', by: 'op', title: `Story ${id}`, url: `https://ex${id}.com/x`, score: 200, descendants: n, time: now - 100000 });

// Long thread: 5 substantive comments (one with replies) + 11 short ones = 16 top-level.
const longChildren = [];
const substantive = [
  { id: 91, author: 'alice', text: 'This is a genuinely substantive point about the architecture and why the tradeoffs matter here.', kids: 2 },
  { id: 92, author: 'bob', text: 'A second detailed comment explaining an alternative approach with real reasoning behind it.', kids: 0 },
  { id: 93, author: 'carol', text: 'A third substantial remark that adds useful context and enough length to qualify as signal.', kids: 0 },
  { id: 94, author: 'dave', text: 'Fourth meaningful contribution to the discussion with a concrete example worth reading fully.', kids: 0 },
  { id: 95, author: 'erin', text: 'Fifth substantive take covering an edge case that people in the thread kept running into.', kids: 0 },
];
for (const s of substantive) {
  longChildren.push({
    id: s.id, author: s.author, text: `<p>${s.text}</p>`, created_at_i: now - 9000, parent_id: LONG_ID, story_id: LONG_ID, points: null, type: 'comment',
    children: Array.from({ length: s.kids }, (_, k) => ({ id: s.id * 10 + k, author: `r${k}`, text: '<p>a short reply</p>', created_at_i: now - 8000, parent_id: s.id, story_id: LONG_ID, points: null, type: 'comment', children: [] })),
  });
}
for (let i = 0; i < 11; i++) {
  longChildren.push({ id: 200 + i, author: `u${i}`, text: '<p>thanks</p>', created_at_i: now - 7000, parent_id: LONG_ID, story_id: LONG_ID, points: null, type: 'comment', children: [] });
}
const longTree = { id: LONG_ID, story_id: LONG_ID, title: `Story ${LONG_ID}`, url: `https://ex${LONG_ID}.com/x`, author: 'op', created_at_i: now - 100000, text: null, points: 200, parent_id: null, type: 'story', children: longChildren };

const shortTree = { id: SHORT_ID, story_id: SHORT_ID, title: `Story ${SHORT_ID}`, url: `https://ex${SHORT_ID}.com/x`, author: 'op', created_at_i: now - 100000, text: null, points: 200, parent_id: null, type: 'story', children: [
  { id: 301, author: 'x', text: '<p>a single short comment</p>', created_at_i: now - 9000, parent_id: SHORT_ID, story_id: SHORT_ID, points: null, type: 'comment', children: [] },
] };
const trees = { [LONG_ID]: longTree, [SHORT_ID]: shortTree };

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
  if (/topstories/.test(u)) return j([LONG_ID, SHORT_ID]);
  if (/(best|new|ask|show|job)stories/.test(u)) return j([]);
  const m = u.match(/item\/(\d+)/);
  if (m) { const id = Number(m[1]); return j(id === LONG_ID ? mkStory(LONG_ID, 18) : id === SHORT_ID ? mkStory(SHORT_ID, 1) : null); }
  return j(null);
});
// Register the generic route FIRST; Playwright uses the LAST-registered matching
// route, so the specific /items/ route below wins for comment-tree fetches.
await page.route(/hn\.algolia\.com|google\.com\/s2/, (r) => r.fulfill({ status: 200, body: '{}' }));
await page.route(/hn\.algolia\.com\/api\/v1\/items\/(\d+)/, (r) => {
  const id = Number(r.request().url().match(/items\/(\d+)/)[1]);
  r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(trees[id] ?? { children: [] }) });
});
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__hnlens && window.__hnlens.prefs, null, { timeout: 20000 });
await page.evaluate(() => window.__hnlens.prefs.getState().set({ llmEnabled: false, defaultFeed: 'top', minPoints: 0 }));

// ---- long thread: gist present + lists key comments ----
await page.goto(`${BASE}#/item/${LONG_ID}`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('[id^="comment-"]', { timeout: 15000 });
await page.waitForTimeout(400);
const gist = page.getByTestId('thread-gist');
check('long thread shows the non-AI "Quick gist" panel', await gist.isVisible());
check('gist works without the LLM enabled', await page.evaluate(() => window.__hnlens.prefs.getState().llmEnabled === false));
await gist.getByRole('button', { name: /Quick gist/ }).click();
await page.waitForTimeout(250);
const gistText = await gist.innerText();
check('expanded gist lists the most-substantive comment (alice, with replies)', /alice/.test(gistText) && /replies/.test(gistText), gistText.replace(/\s+/g, ' ').slice(0, 120));
check('gist excludes trivial one-word comments (no "thanks")', !/thanks/i.test(gistText));

// clicking a gist item scrolls to that comment (it exists in the DOM)
await gist.getByText('alice').first().click();
await page.waitForTimeout(300);
check('the referenced comment exists to jump to', await page.locator('#comment-91').count() > 0);

// ---- short thread: NO gist ----
await page.goto(`${BASE}#/item/${SHORT_ID}`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('[id^="comment-"]', { timeout: 15000 });
await page.waitForTimeout(300);
check('short thread does NOT show the gist', !(await page.getByTestId('thread-gist').isVisible().catch(() => false)));

// ---- AI ON + WebGPU available: the AI summary block replaces the non-AI gist, so a
// long thread never stacks TWO summary blocks. (The gist is the no-AI fallback only.)
await page.goto(`${BASE}#/item/${LONG_ID}`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('[id^="comment-"]', { timeout: 15000 });
await page.evaluate(async () => {
  window.__hnlens.prefs.getState().set({ llmEnabled: true, showAiSummaries: true });
  // Force a usable WebGPU state (headless has no adapter, and startup probe set
  // 'unavailable'); this must happen AFTER load so the startup probe can't override it.
  (await window.__hnlens.registry()).useModelStore.getState().setWebgpu('available');
});
await page.waitForTimeout(400);
check('AI ON (WebGPU ok): the non-AI gist is hidden (no duplicate summary block)', !(await page.getByTestId('thread-gist').isVisible().catch(() => false)));
check('AI ON: the AI summary block is shown instead', await page.getByText('AI discussion summary').isVisible().catch(() => false));

await b.close();
console.log(`\n${fails.length === 0 ? 'RESULT: GIST PASS \u2713' : `RESULT: ${fails.length} FAILED`}`);
process.exit(fails.length ? 1 : 0);
