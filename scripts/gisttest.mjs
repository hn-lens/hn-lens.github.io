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
// A "quote-then-respond" comment (the most common HN reply shape): a BARE leading `&gt; quote`
// before the first <p> rebuttal, and the MOST replies (5) so it should TOP the gist. Guards the
// MEDIUM-2 fix: ThreadGist.clean used stripHtml().split('\n'), but stripHtml collapses newlines →
// the split was a no-op → a comment whose flattened text started with '>' was dropped ENTIRELY, so
// the single most-discussed comment was silently omitted from the "most-discussed" digest.
const QUOTE_AUTHOR = 'quoteperson';
longChildren.push({
  id: 96, author: QUOTE_AUTHOR,
  text: `&gt; the parent comment claimed a specific thing here<p>Here is the substantive rebuttal explaining exactly why that is wrong, with concrete reasoning worth reading.</p>`,
  created_at_i: now - 9000, parent_id: LONG_ID, story_id: LONG_ID, points: null, type: 'comment',
  children: Array.from({ length: 5 }, (_, k) => ({ id: 960 + k, author: `qr${k}`, text: '<p>reply</p>', created_at_i: now - 8000, parent_id: 96, story_id: LONG_ID, points: null, type: 'comment', children: [] })),
});
// A substantive comment BURIED BEHIND AN AUTO-COLLAPSE PILL. Its parent has 4 descendants (>
// AUTO_COLLAPSE_DESCENDANTS = 2), so the parent's replies render collapsed behind "Show N replies"
// and the target is NOT IN THE DOCUMENT until something expands it. It still scores into the gist's
// top-5, so the gist offers a jump to a comment `getElementById` cannot find. Guards the fix that
// routes ThreadGist's jump through CommentsView's `jumpToComment` (which expands the target's
// ancestor chain first): resolving the id locally was a silent no-op for exactly this shape — no
// scroll, no fallback, no feedback.
const BURIED_ID = 971;
const BURIED_AUTHOR = 'buriedgem';
longChildren.push({
  id: 97, author: 'parenty', text: '<p>short</p>', created_at_i: now - 9000, parent_id: LONG_ID, story_id: LONG_ID, points: null, type: 'comment',
  children: [{
    id: BURIED_ID, author: BURIED_AUTHOR,
    text: '<p>A deeply buried but highly substantive analysis that scores into the digest on length and replies, sitting behind a collapsed reply pill so it is absent from the document until an ancestor is expanded.</p>',
    created_at_i: now - 8500, parent_id: 97, story_id: LONG_ID, points: null, type: 'comment',
    children: Array.from({ length: 3 }, (_, k) => ({ id: 9710 + k, author: `br${k}`, text: '<p>reply</p>', created_at_i: now - 8000, parent_id: BURIED_ID, story_id: LONG_ID, points: null, type: 'comment', children: [] })),
  }],
});
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
// The gist lives behind the toolbar's Summary tool now — the discussion header was collapsed from
// four always-on blocks into one row because they pushed the first comment 493px down an 800px
// viewport. It must still be one click away, and reachable WITHOUT AI configured.
check(
  'the Summary tool is on the toolbar even with AI off',
  (await page.getByRole('button', { name: /^Summary$/ }).count()) > 0
);
await page.getByRole('button', { name: /^Summary$/ }).first().click();
await page.waitForTimeout(350);
const gist = page.getByTestId('thread-gist');
check('long thread shows the non-AI "Quick gist" panel', await gist.isVisible());
check('gist works without the LLM enabled', await page.evaluate(() => window.__hnlens.prefs.getState().llmEnabled === false));
await gist.getByRole('button', { name: /Quick gist/ }).click();
await page.waitForTimeout(250);
const gistText = await gist.innerText();
check('expanded gist lists the most-substantive comment (alice, with replies)', /alice/.test(gistText) && /replies/.test(gistText), gistText.replace(/\s+/g, ' ').slice(0, 120));
check('gist excludes trivial one-word comments (no "thanks")', !/thanks/i.test(gistText));
// MEDIUM-2: a quote-then-respond comment (leading "&gt; …") that is the MOST-replied must appear in
// the gist — its substantive rebuttal, not the quoted line. Pre-fix it was dropped whole (blank).
check('the most-replied quote-then-respond comment IS in the gist (leading > not dropped)', /quoteperson/.test(gistText) && /substantive rebuttal/.test(gistText), gistText.replace(/\s+/g, ' ').slice(0, 200));
check('the quoted line itself is filtered from the gist snippet (not the rebuttal)', !/parent comment claimed/i.test(gistText));

// MEDIUM-2 SIBLING: the LLM comment selector (llm.ts cleanComment/collectComments — feeds every AI
// summary/TL;DR/Ask) had the SAME stripHtml().split('\n') quote-drop the gist fixed. Grep-the-siblings:
// reuse the same most-replied quote-then-respond comment (id 96) and assert the LLM path keeps it (the
// rebuttal), not drops it. Pre-fix collectComments returned '' for it → excluded at the length gate.
const llmSel = await page.evaluate(async (children) => {
  const llm = await window.__hnlens.llm();
  const infos = llm.collectComments(children); // applies cleanComment + the >=40-char gate
  const q = infos.find((c) => c.author === 'quoteperson');
  return { authors: infos.map((c) => c.author), quoteText: q ? q.text : null };
}, longChildren);
check('LLM collectComments keeps the quote-then-respond comment (sibling of the gist fix)', llmSel.authors.includes('quoteperson'), JSON.stringify(llmSel.authors).slice(0, 160));
check('LLM comment cleaning keeps the rebuttal + drops the quoted line', !!llmSel.quoteText && /substantive rebuttal/.test(llmSel.quoteText) && !/parent comment claimed/i.test(llmSel.quoteText), (llmSel.quoteText || '(dropped)').slice(0, 120));

// ---- a gist pick must actually LAND the reader on the comment ----
// "the element exists" is not the behaviour; the behaviour is that the comment ends up on screen.
// `inView` measures that, so a jump that silently does nothing fails here instead of passing.
const inView = async (cid) =>
  await page.evaluate((id) => {
    const el = document.getElementById(`comment-${id}`);
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.bottom > 0 && r.top < window.innerHeight;
  }, cid);

// (a) a top-level pick — mounted all along, so this only exercises the scroll.
await page.evaluate(() => window.scrollTo(0, 0));
await gist.getByText('alice').first().click();
await page.waitForTimeout(450);
check('clicking a gist pick scrolls that comment into view', await inView(91));

// (b) a pick BEHIND AN AUTO-COLLAPSE PILL. The precondition is asserted first: if the target were
// already mounted this guard would be vacuous (it would pass without the jumper expanding
// anything), so a fixture that stops burying the comment fails loudly rather than going quiet.
check(
  `PRECONDITION: the buried pick (${BURIED_AUTHOR}) is collapsed out of the document before the jump`,
  (await page.locator(`#comment-${BURIED_ID}`).count()) === 0
);
const gistNames = await gist.innerText();
check(`PRECONDITION: the buried comment is offered as a gist pick`, gistNames.includes(BURIED_AUTHOR));
await gist.getByText(BURIED_AUTHOR).first().click();
await page.waitForTimeout(600);
check(
  'jumping to a pick behind a collapse pill expands its ancestors and mounts it',
  (await page.locator(`#comment-${BURIED_ID}`).count()) > 0
);
check('...and scrolls it into view', await inView(BURIED_ID));
check(
  '...without bouncing the reader out to a separate page',
  page.url().includes(`/item/${LONG_ID}`),
  page.url().slice(-40)
);

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
