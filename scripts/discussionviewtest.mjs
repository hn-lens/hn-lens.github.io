// Discussion-view surface tests — two behaviours the rest of the suite drove only
// on the /item permalink (never through the FEED → drawer path a real user takes):
//
//   [A] The "Show AI summary controls in comments" setting (showAiSummaries) must
//       actually GATE the AI discussion-summary control in the comments view. It is a
//       persisted, wired toggle whose label promises an effect; before the fix it was
//       read by NO component, so turning it off did nothing (a dead control).
//
//   [B] The "new since last visit" comment badge must work when a discussion is
//       opened from a feed card (which now navigates to the full /item page). Before the
//       original fix, StoryCard.onOpenComments pre-marked the story "seen" before
//       CommentsView captured the previous seen timestamp, so lastVisit ≈ now and NO
//       comment was ever flagged "new" on the feed-open path. Guards that on the page path.
//
// Hermetic: fully mocked HN API, chromium, no WebGPU. (Without WebGPU the AI summary
// control renders its "needs WebGPU" box, which is still the control being gated — so
// the gate is testable without a GPU.)
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:4173/';
const now = Math.floor(Date.now() / 1000);

// Two stories in Top. Each Algolia tree has one OLD comment (before the prior visit)
// and two FRESH comments (after it) so the "new" badge has a definite expected count.
const STORY_IDS = [1000, 1001];
const mkStory = (id) => ({ id, type: 'story', by: `op${id}`, title: `Story ${id}`, url: `https://d${id}.example/x`, score: 150, descendants: 3, time: now - 100000 });
const mkTree = (id) => ({
  id, story_id: id, title: `Story ${id}`, url: `https://d${id}.example/x`, points: 150, author: `op${id}`,
  created_at_i: now - 100000, type: 'story', text: null,
  children: [
    { id: id * 10 + 1, author: 'oldtimer', text: '<p>An OLD comment from before your last visit.</p>', created_at_i: now - 90000, children: [] },
    { id: id * 10 + 2, author: 'freshA', text: '<p>A FRESH comment posted after your last visit.</p>', created_at_i: now - 1800, children: [] },
    { id: id * 10 + 3, author: 'freshB', text: '<p>Another FRESH comment after your last visit.</p>', created_at_i: now - 1700, children: [] },
  ],
});

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
  if (u.includes('/topstories.json')) return j(STORY_IDS);
  for (const ep of ['beststories', 'newstories', 'askstories', 'showstories', 'jobstories']) if (u.includes(`/${ep}.json`)) return j([]);
  const m = u.match(/item\/(\d+)/);
  if (m) return j(STORY_IDS.includes(Number(m[1])) ? mkStory(Number(m[1])) : null);
  if (u.includes('/user/')) return j({ id: 'x', karma: 1, created: now });
  if (u.includes('maxitem')) return j(9999);
  return j(null);
});
await page.route(/hn\.algolia\.com\/api\/v1\/search/, (r) =>
  r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ nbHits: 0, page: 0, nbPages: 0, hits: [] }) })
);
await page.route(/hn\.algolia\.com\/api\/v1\/items\/(\d+)/, (r) => {
  const id = Number(r.request().url().match(/items\/(\d+)/)[1]);
  r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(mkTree(id)) });
});
await page.route(/google\.com\/s2\/favicons|gstatic\.com\/faviconV2/, (r) => r.fulfill({ status: 200, body: '' }));

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__hnlens && window.__hnlens.prefs, null, { timeout: 20000 });
await page.evaluate(async () => {
  const i = await window.__hnlens.interactions();
  await i.clearAllData();
  window.__hnlens.prefs.getState().set({ useLearnedRanker: false, embeddingsEnabled: false, defaultFeed: 'top', minPoints: 0, mutedDomains: [], mutedUsers: [] });
});

// The summary lives behind the toolbar's Summarize TOOL now — four stacked always-on blocks used to
// push the first comment 493px down an 800px viewport. "Visible" therefore means: the labelled tool
// is on the toolbar, and opening it reveals the control. Checking only for on-screen text would
// report the redesign as a regression while the feature is actually one keystroke away.
const openSummaryTool = async () => {
  const btn = page.getByRole('button', { name: /^Summary$/ });
  if ((await btn.count()) === 0) return false;
  await btn.first().click();
  await page.waitForTimeout(350);
  return true;
};
const summaryControlVisible = async () => {
  if (!(await openSummaryTool())) return false;
  return page.evaluate(() => /AI discussion summary|AI summaries need WebGPU/i.test(document.body.innerText));
};
// The discoverability CTA shown when local AI is OFF (so the feature isn't invisible).
const ctaVisible = async () => {
  if (!(await openSummaryTool())) return false;
  return page.evaluate(() => /Enable local AI|Summarize or ask about this discussion/i.test(document.body.innerText));
};

// ===== [A] showAiSummaries gates the comments AI summary control =====
console.log('\n[A] "Show AI summary controls in comments" (showAiSummaries) gates the control');

// A1: llm ON + showAiSummaries ON → control is present
await page.evaluate(() => window.__hnlens.prefs.getState().set({ llmEnabled: true, showAiSummaries: true }));
await page.goto(`${BASE}#/item/1000`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => /comments/i.test(document.body.innerText), null, { timeout: 15000 });
await page.waitForTimeout(500);
check('with LLM on + showAiSummaries ON, the AI summary control is shown', await summaryControlVisible());

// A2: toggle showAiSummaries OFF (live) → control disappears
await page.evaluate(() => window.__hnlens.prefs.getState().set({ showAiSummaries: false }));
await page.waitForTimeout(400);
check('turning showAiSummaries OFF hides the AI summary control', !(await summaryControlVisible()), 'still visible after OFF ⇒ dead toggle');

// A3: OFF persists across a reload of the item page
await page.goto(`${BASE}#/item/1000`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => /comments/i.test(document.body.innerText), null, { timeout: 15000 });
await page.waitForTimeout(500);
check('showAiSummaries OFF keeps the control hidden after reload', !(await summaryControlVisible()));

// A4: with LLM OFF (default) the summarize CONTROL is hidden, but a discoverability
// CTA is shown so the feature isn't invisible on a long thread.
await page.evaluate(() => window.__hnlens.prefs.getState().set({ llmEnabled: false, showAiSummaries: true }));
await page.goto(`${BASE}#/item/1000`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => /comments/i.test(document.body.innerText), null, { timeout: 15000 });
await page.waitForTimeout(400);
check('with LLM off, the AI summary control itself is hidden', !(await summaryControlVisible()));
check(
  'with LLM off, the Summarize TOOL is still on the toolbar (feature stays discoverable)',
  (await page.getByRole('button', { name: /^Summary$/ }).count()) > 0
);
check('with LLM off, a discoverability CTA to enable local AI IS shown', await ctaVisible(), 'feature must not be invisible');

// A5: turning showAiSummaries OFF hides EVERYTHING (control AND the CTA).
await page.evaluate(() => window.__hnlens.prefs.getState().set({ llmEnabled: false, showAiSummaries: false }));
await page.goto(`${BASE}#/item/1000`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => /comments/i.test(document.body.innerText), null, { timeout: 15000 });
await page.waitForTimeout(400);
check('showAiSummaries OFF hides the CTA too (fully opts out)', !(await ctaVisible()) && !(await summaryControlVisible()));
// restore default for later sections
await page.evaluate(() => window.__hnlens.prefs.getState().set({ showAiSummaries: true }));

// ===== [B] "new since last visit" badge on the FEED → full /item PAGE path =====
console.log('\n[B] "new since last visit" badge works when opening a discussion from a feed card (full page)');
await page.evaluate(async () => {
  const i = await window.__hnlens.interactions();
  await i.clearAllData();
  window.__hnlens.prefs.getState().set({ llmEnabled: false });
});
// Seed a PRIOR visit: story 1000 was seen 50000s ago (before the two fresh comments).
await page.evaluate(async (t) => {
  const dbMod = await window.__hnlens.db();
  await dbMod.db.seen.put({ id: 1000, ts: (t - 50000) * 1000 });
}, now);

// Open the discussion via the CARD's "Open comments" button — now navigates to the full
// /item discussion page (the drawer was removed for a clean, readable HackerWeb-style view).
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.getByRole('button', { name: 'Top', exact: true }).click();
await page.waitForSelector('article[data-id="1000"]', { timeout: 15000 });
await page.waitForTimeout(300);
// Re-seed (in case a prior render marked it) so the prior-visit ts is definitely old.
await page.evaluate(async (t) => {
  const dbMod = await window.__hnlens.db();
  await dbMod.db.seen.put({ id: 1000, ts: (t - 50000) * 1000 });
}, now);
await page.locator('article[data-id="1000"]').getByRole('button', { name: 'Open comments' }).click();
// The card navigates to the full discussion page (not a drawer).
await page.waitForFunction(() => location.hash.includes('/item/1000'), null, { timeout: 15000 });
await page.waitForFunction(() => document.querySelector('[id^="comment-"]'), null, { timeout: 15000 });
await page.waitForTimeout(500);
const feedOpenNew = await page.evaluate(() => {
  const main = document.querySelector('main');
  if (!main) return -1;
  // Comment badges only. The control band's catch-up button also says "new", and it lives in
  // <main> too, so an unscoped span sweep counts it as a third badge on a two-fresh-comment fixture.
  return [...main.querySelectorAll('span')].filter((s) => !s.closest('.disc-toolbar') && s.textContent.trim() === 'new').length;
});
check('feed→page path: comments newer than last visit show a "new" badge', feedOpenNew >= 2, `${feedOpenNew} badge(s) (expected 2)`);
check('feed→page path: the OLD comment is NOT flagged new', feedOpenNew === 2, `${feedOpenNew} badge(s) — should be exactly the 2 fresh ones`);

// Cross-check the /item path still works (guards the fix both ways).
await page.evaluate(async (t) => {
  const dbMod = await window.__hnlens.db();
  await dbMod.db.seen.put({ id: 1001, ts: (t - 50000) * 1000 });
}, now);
await page.goto(`${BASE}#/item/1001`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => /comment/i.test(document.body.innerText), null, { timeout: 15000 });
await page.waitForTimeout(500);
const itemNew = await page.evaluate(() => [...document.querySelectorAll('main span')].filter((s) => !s.closest('.disc-toolbar') && s.textContent.trim() === 'new').length);
check('/item path: still shows the "new" badge for fresh comments', itemNew >= 2, `${itemNew} badge(s)`);

// ===== [C] Save from the discussion view header =====
// The reader decides a story is worth keeping WHILE reading its discussion — Save must
// be reachable there (not only on the feed card), and it must persist.
console.log('\n[C] Save toggle in the discussion header');
await page.evaluate(async () => {
  await (await window.__hnlens.interactions()).clearAllData();
});
await page.goto(`${BASE}#/item/1000`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => /comments/i.test(document.body.innerText), null, { timeout: 15000 });
await page.waitForTimeout(400);
const saveBtn = page.getByRole('button', { name: 'Save', exact: true });
check('discussion header shows a Save action', await saveBtn.isVisible().catch(() => false));
await saveBtn.click();
await page.waitForTimeout(300);
check('clicking Save flips the label to Saved', await page.getByRole('button', { name: 'Saved', exact: true }).isVisible().catch(() => false));
const savedInDb = await page.evaluate(async () => {
  const dbMod = await window.__hnlens.db();
  return !!(await dbMod.db.saved.get(1000));
});
check('the story is persisted to db.saved from the discussion view', savedInDb);

// ===== [D] The comment Sort control (a 4-option .seg) must not cause horizontal PAGE
// overflow on a narrow phone — the segmented track wraps within its bounds instead of
// pushing the page wider (regression: the .seg row overflowed at 320px in every theme and
// at 390px in monospace themes). Still on /item/1000, so the Sort control is present.
console.log('\n[D] Sort control fits narrow viewports (no page overflow)');
for (const w of [360, 320]) {
  await page.setViewportSize({ width: w, height: 780 });
  await page.waitForTimeout(300);
  const r = await page.evaluate(() => ({
    hasSeg: !!document.querySelector('.seg[aria-label="Sort comments"]'),
    over: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  }));
  check(`discussion Sort control: no horizontal page overflow at ${w}px`, r.hasSeg && r.over <= 2, JSON.stringify({ w, ...r }));
}
// Reset to a wide viewport after the narrow [D] sweep: below ~576px the discussion tools fold into
// the "…" overflow menu, so the sections below (which drive the INLINE Search/tool buttons) must run
// at a width where those buttons are inline. Narrow-width tool reachability (via the menu) is covered
// by wrapqualitytest.
await page.setViewportSize({ width: 1280, height: 900 });
await page.waitForTimeout(200);

// --- "Back to feed" must preserve the feed you came from, and must never leave the app ---
// It used to push "/" unconditionally, which resolves to the DEFAULT feed — so the tab was lost from
// every non-default feed, along with a search context and the remembered paging depth. Stepping back
// through history fixes that, but the first attempt gated on `window.history.length > 1`, which
// counts the whole TAB's session history: anyone opening a shared link after visiting any other site
// would have been navigated straight out of the app. Assert BOTH halves.
{
  // (a) arrived by clicking inside the app → returns to the exact feed URL you came from.
  // Only `top` is populated in this fixture, so drive the real in-app path: open a discussion from
  // a card on an explicitly-qualified feed URL and assert that qualifier survives the round trip.
  await page.goto(`${BASE}#/?feed=top`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('article', { timeout: 20000 });
  await page.locator('article').first().getByRole('button', { name: 'Open comments' }).click();
  await page.waitForURL(/#\/item\//, { timeout: 15000 });
  await page.getByRole('button', { name: /Back to feed/i }).click();
  await page.waitForTimeout(600);
  const backUrl = page.url();
  check('Back to feed returns to the feed URL you came from', /feed=top/.test(backUrl), backUrl);

  // (b) landed directly on the discussion (shared link) → goes to the feed, and STAYS in the app.
  await page.goto(`${BASE}#/item/1`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: /Back to feed/i }).waitFor({ timeout: 15000 });
  await page.getByRole('button', { name: /Back to feed/i }).click();
  await page.waitForTimeout(600);
  const coldUrl = page.url();
  check('Back to feed from a direct link stays in the app', coldUrl.startsWith(BASE), coldUrl);
  check('Back to feed from a direct link lands on the feed', !/#\/item\//.test(coldUrl), coldUrl);
}

// ---- [E] the discussion TOOLS: one dismissal path, a focused input, never an empty tray ----
{
  await page.goto(`${BASE}#/item/${STORY_IDS[0]}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[id^="comment-"]', { timeout: 20000 });
  await page.waitForTimeout(500);

  // E1 — Search is an always-visible INLINE box on the toolbar (it flex-fills the row); typing filters
  // the thread, and clearing it via the × restores the thread with no orphaned filter. (The box only
  // moves into the "…" menu at the very narrowest widths; this section runs at a wide viewport.)
  const box = page.getByLabel('Search comments in this discussion');
  check('PRECONDITION: the inline search box is present', (await box.count()) > 0);
  await box.first().fill('repl');
  await page.waitForTimeout(800);
  check('PRECONDITION: typing filters the discussion', /\d+ match/.test(await page.evaluate(() => document.body.innerText)));
  await page.getByRole('button', { name: /^Clear search$/ }).first().click();
  await page.waitForTimeout(600);
  const afterClear = await page.evaluate(() => ({
    stillFiltering: /\d+ match/.test(document.body.innerText),
    threadShown: !!document.querySelector('[id^="comment-"]'),
    boxEmpty: (document.querySelector('input[type="search"]')?.value ?? '') === '',
  }));
  check(
    'clearing the inline search (×) restores the thread (no orphaned filter)',
    !afterClear.stillFiltering && afterClear.threadShown && afterClear.boxEmpty,
    JSON.stringify(afterClear)
  );

  // E2 — a tool that HAS an input opens with it focused. Ask never focused its box, so with focus
  // left on <body> every letter typed was read as a shortcut: "are there objections" hit `a`
  // (re-closing Ask) then `s` (opening Summary), destroying the question as it was written.
  await page.evaluate(() => {
    window.__hnlens.prefs.getState().set({ llmProvider: 'gemini', apiKeys: { gemini: 'test-key' } });
  });
  await page.waitForTimeout(500);
  const askBtn = page.getByRole('button', { name: /^Ask$/ });
  check('PRECONDITION: Ask is offered once AI is configured', (await askBtn.count()) > 0);
  if (await askBtn.count()) {
    await askBtn.first().click();
    await page.waitForTimeout(600);
    const focused = await page.evaluate(() => document.activeElement?.id || document.activeElement?.tagName);
    check('opening Ask focuses its input, so typing goes to the question', focused === 'ask-thread', String(focused));
    await page.keyboard.type('are there objections');
    await page.waitForTimeout(500);
    const typed = await page.evaluate(() => ({
      value: document.getElementById('ask-thread')?.value ?? null,
      tray: document.querySelector('.disc-tray')?.getAttribute('aria-label') ?? null,
    }));
    check(
      'typing a normal question neither triggers shortcuts nor destroys the panel',
      typed.value === 'are there objections' && typed.tray === 'ask panel',
      JSON.stringify(typed)
    );
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  }

  // E3 — with AI NOT configured, `a` must not open an empty tray. The BUTTON is correctly hidden in
  // that case; the KEY was not, so it opened a panel headed "Ask this discussion" with nothing in
  // it. (Summary stays available either way: it has a non-AI fallback to show. Ask has none.)
  await page.evaluate(() => window.__hnlens.prefs.getState().set({ llmProvider: 'local', apiKeys: {} }));
  await page.waitForTimeout(500);
  await page.evaluate(() => document.body.click());
  await page.keyboard.press('a');
  await page.waitForTimeout(500);
  const askOff = await page.evaluate(() => document.querySelector('.disc-tray')?.getAttribute('aria-label') ?? null);
  check('with AI unconfigured, `a` does NOT open an empty Ask tray', askOff !== 'ask panel', String(askOff));
}

// ===== [F] Toolbar keyboard + jump interaction (c3r39 review fixes) =====
// The redesign made discussion Search a persistent INLINE box. Three interaction bugs followed:
//  F1 (M1): `l` still opened the tray search TOOL, stacking a second, identical search input on top
//           of the always-visible inline box. `l` should FOCUS the inline box instead.
//  F2 (M2): jumping to a comment (the "N new" catch-up) while a search filter is active navigated the
//           reader AWAY to a permalink — the thread isn't mounted under an active search, so the jump
//           fell through to navigate(). It must clear the search and land within the thread.
//  F4 (L2): the narrow ⇅ Sort toggle only flipped Newest↔Replies, so a "Default"/"Oldest" label was
//           unreachable by the toggle. It should cycle through all four sorts.
console.log('\n[F] toolbar keyboard + jump interaction');
{
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${BASE}#/item/1000`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[id^="comment-"]', { timeout: 20000 });
  // A prior visit BEFORE the two fresh comments ⇒ they render as "new" (the N-new catch-up button).
  // Seed then RELOAD: an earlier section already sits on /item/1000 and marked it seen ~now, and a
  // goto to the same #/item URL is a hash-only nav (no remount) — so without a reload lastVisit≈now
  // and nothing is "new" (the HashRouter same-URL gotcha).
  await page.evaluate(async (t) => {
    await (await window.__hnlens.interactions()).clearAllData();
    const dbMod = await window.__hnlens.db();
    await dbMod.db.seen.put({ id: 1000, ts: (t - 50000) * 1000 });
    window.__hnlens.prefs.getState().set({ llmEnabled: false });
  }, now);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[id^="comment-"]', { timeout: 20000 });
  await page.waitForTimeout(600);

  // F1 (M1) — `l` focuses the inline search; it must NOT open a second (tray) search input.
  await page.evaluate(() => document.body.click());
  await page.keyboard.press('l');
  await page.waitForTimeout(300);
  const afterL = await page.evaluate(() => ({
    activeInInlineBar: !!document.activeElement?.closest?.('.disc-tb-bar') && document.activeElement?.getAttribute('type') === 'search',
    trayOpen: !!document.querySelector('.disc-tray'),
  }));
  check('`l` focuses the inline discussion search (no duplicate tray search box)', afterL.activeInInlineBar && !afterL.trayOpen, JSON.stringify(afterL));

  // F3 (L1) — on a discussion, `/` focuses the INLINE discussion search, not TopNav's global "Search
  // Hacker News" box. Before the fix `/` grabbed the first input[type=search] in the DOM (TopNav's).
  await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
  await page.evaluate(() => document.body.click());
  await page.keyboard.press('/');
  await page.waitForTimeout(250);
  const afterSlash = await page.evaluate(() => ({
    inInlineBar: !!document.activeElement?.closest?.('.disc-tb-bar') && document.activeElement?.getAttribute('type') === 'search',
    inTopNav: !!document.activeElement?.closest?.('header'),
  }));
  check('`/` focuses the inline discussion search on /item (not the global nav search)', afterSlash.inInlineBar && !afterSlash.inTopNav, JSON.stringify(afterSlash));

  // F3b (SR1 regression) — at the narrowest width the inline search folds into the "…" menu
  // (display:none but still in the DOM). `/` must fall back to the VISIBLE global nav search, not
  // target the hidden inline box and no-op. (A null-coalesce on mere presence, not visibility, made
  // `/` a dead key here.) The width is the narrowest supported one, because the Search box is the
  // flex filler and is the LAST control to fold.
  await page.setViewportSize({ width: 320, height: 800 });
  await page.waitForTimeout(300);
  await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
  await page.evaluate(() => document.body.click());
  await page.keyboard.press('/');
  await page.waitForTimeout(250);
  const slashNarrow = await page.evaluate(() => {
    const a = document.activeElement;
    const inline = document.querySelector('input[type="search"].sr-only, .disc-tb-bar input[type="search"]');
    return {
      focusedSearch: a?.getAttribute?.('type') === 'search',
      inTopNav: !!a?.closest?.('header'),
      inlineFolded: !inline || inline.getBoundingClientRect().width === 0,
    };
  });
  check('`/` at a narrow width focuses the VISIBLE global search (inline box folded → not a dead key)', slashNarrow.focusedSearch && slashNarrow.inTopNav && slashNarrow.inlineFolded, JSON.stringify(slashNarrow));
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForTimeout(200);

  // F2 (M2) — "N new" during an active search stays on the discussion + clears the filter.
  // Search a term that matches ONLY the OLD comment ("...before your last visit"), so the NEW comments
  // are NOT in the results (not mounted). Jumping to one then reproduces the navigate-away: the thread
  // isn't mounted under the filter, so the pre-fix jump fell through to a /item/<commentId> permalink.
  const box = page.getByLabel('Search comments in this discussion');
  await box.first().fill('before');
  await page.waitForTimeout(700);
  const nnew = page.locator('.disc-tb-bar button', { hasText: /\d+ new/ });
  const preF2 = { nnew: await nnew.count(), matching: /\d+ match/.test(await page.evaluate(() => document.body.innerText)) };
  check('PRECONDITION: an active search filter + a "N new" button are both present', preF2.nnew > 0 && preF2.matching, JSON.stringify(preF2));
  if (await nnew.count()) {
    await nnew.first().click();
    await page.waitForTimeout(700);
    const afterJump = await page.evaluate(() => ({
      hash: location.hash,
      filtering: /\d+ match/.test(document.body.innerText),
      threadShown: !!document.querySelector('[id^="comment-"]'),
    }));
    check('clicking "N new" during a search stays on the discussion (no navigate-away) + clears the filter',
      /\/item\/1000$/.test(afterJump.hash) && !afterJump.filtering && afterJump.threadShown, JSON.stringify(afterJump));
  }

  // F4 (L2) — the narrow ⇅ Sort toggle cycles through all four sorts (every label reachable).
  await page.setViewportSize({ width: 380, height: 800 });
  await page.waitForTimeout(300);
  const cycleLabels = [];
  for (let i = 0; i < 5; i++) {
    const lbl = await page.evaluate(() => {
      const segs = [...document.querySelectorAll('.seg[aria-label="Sort comments"]')].filter((s) => s.offsetParent !== null);
      const btns = segs.flatMap((s) => [...s.querySelectorAll('button')]).filter((btEl) => btEl.offsetParent !== null);
      return btns.length === 1 ? btns[0].textContent.trim() : `UNEXPECTED_BTN_COUNT:${btns.length}`;
    });
    cycleLabels.push(lbl);
    await page.evaluate(() => {
      const segs = [...document.querySelectorAll('.seg[aria-label="Sort comments"]')].filter((s) => s.offsetParent !== null);
      const btns = segs.flatMap((s) => [...s.querySelectorAll('button')]).filter((btEl) => btEl.offsetParent !== null);
      btns[0]?.click();
    });
    await page.waitForTimeout(150);
  }
  check('narrow ⇅ sort toggle cycles through all four sorts (every label reachable)', new Set(cycleLabels).size === 4, JSON.stringify(cycleLabels));
  await page.setViewportSize({ width: 1280, height: 900 });

  // F5 — WIDE: the inline search box is visible and owns the query, so opening and closing
  // Summary/Ask must leave the reader's filter alone. Paired with F6 below, which covers the narrow
  // width where the box has folded and the opposite behaviour is required; one dismissal rule has to
  // satisfy both, so testing either width alone passes a rule that strands the other.
  await page.waitForTimeout(200);
  const inline = page.locator('.disc-tb-bar input[type="search"]').first();
  await inline.fill('the');
  await page.waitForTimeout(350);
  const beforeTool = await page.evaluate(() => ({
    q: document.querySelector('.disc-tb-bar input[type="search"]')?.value ?? '',
  }));
  // Open Summary from the toolbar, then close it again via the same button.
  for (const _pass of [0, 1]) {
    await page.evaluate(() => {
      const b = [...document.querySelectorAll('.disc-tb-bar button')].find((x) => /summary/i.test(x.textContent || x.getAttribute('aria-label') || ''));
      b?.click();
    });
    await page.waitForTimeout(250);
  }
  const afterTool = await page.evaluate(() => ({
    q: document.querySelector('.disc-tb-bar input[type="search"]')?.value ?? '',
  }));
  check(
    'opening and closing Summary preserves the in-thread search filter',
    beforeTool.q === 'the' && afterTool.q === 'the',
    JSON.stringify({ beforeTool, afterTool }),
  );
  await inline.fill('');
  await page.waitForTimeout(200);

  // F6 — the thread must never be left FILTERED with no visible control to clear the filter. Below
  // ~400px the inline box folds into the "…" menu and the tray owns the input, so a rule phrased as
  // "the search tool clears its own query" strands the reader: switch from Search to Summary and the
  // results still own the page with no input, and Escape is inert because it is guarded on a
  // non-null tool. The invariant is about REACHABILITY, not about which tool cleared what.
  await page.setViewportSize({ width: 340, height: 780 });
  await page.waitForTimeout(300);
  const openFromMenu = async (label) => {
    await page.evaluate(() => document.querySelector('.disc-toolbar button[aria-label="More discussion tools"]')?.click());
    await page.waitForTimeout(250);
    await page.evaluate((l) => {
      const items = [...document.querySelectorAll('.disc-toolbar [role="menu"] button, .disc-toolbar [role="menu"] [role="menuitem"]')];
      items.find((x) => new RegExp(l, 'i').test(x.textContent || ''))?.click();
    }, label);
    await page.waitForTimeout(300);
  };
  await openFromMenu('search');
  // The folded inline box is still in the DOM (display:none) at this width, so target the VISIBLE
  // input — the tray's — not merely the first match.
  const trayInput = page.locator('.disc-toolbar input[type="search"]:visible').first();
  if (await trayInput.count()) {
    await trayInput.fill('the');
    await page.waitForTimeout(350);
    await openFromMenu('summary');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    const stranded = await page.evaluate(() => {
      const filtered = /\d+\s+match/i.test(document.body.innerText);
      const inputVisible = [...document.querySelectorAll('.disc-toolbar input[type="search"]')]
        .some((el) => el.offsetParent !== null);
      return { filtered, inputVisible };
    });
    check(
      'narrow: the thread is never left filtered with no visible way to clear it',
      !stranded.filtered || stranded.inputVisible,
      JSON.stringify(stranded),
    );
  }
  // F7 — the SIBLING route into the same stranded state, which has nothing to do with tools: type a
  // filter while the inline box is visible, then NARROW the window so that box folds away. `tool` is
  // already null, so a tool-centred rule cannot help. Whatever the route, a filtered thread must
  // offer a visible way out.
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForTimeout(250);
  const wideBox = page.locator('.disc-tb-bar input[type="search"]:visible').first();
  if (await wideBox.count()) {
    await wideBox.fill('the');
    await page.waitForTimeout(350);
    await page.setViewportSize({ width: 360, height: 780 });
    await page.waitForTimeout(400);
    const afterNarrow = await page.evaluate(() => {
      const filtered = /\d+\s+match/i.test(document.body.innerText);
      const inputVisible = [...document.querySelectorAll('.disc-toolbar input[type="search"]')]
        .some((el) => el.offsetParent !== null);
      const clearVisible = [...document.querySelectorAll('button')]
        .some((el) => el.offsetParent !== null && /^clear/i.test((el.textContent || el.getAttribute('aria-label') || '').trim()));
      return { filtered, inputVisible, clearVisible };
    });
    check(
      'a filter that outlives its input (window narrowed) still has a visible way out',
      !afterNarrow.filtered || afterNarrow.inputVisible || afterNarrow.clearVisible,
      JSON.stringify(afterNarrow),
    );
    // F8 — and ESCAPE must dismiss it too. The keydown listener is installed by an effect; if that
    // effect is not keyed on the query, the handler closes over the value from the render that
    // installed it, so a filter typed after the last tool change is invisible to it and the key does
    // nothing. Checking only that a visible control exists cannot see that.
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
    const afterEsc = await page.evaluate(() => /\d+\s+match/i.test(document.body.innerText));
    check('Escape clears a filter that outlived its input', !afterEsc, `stillFiltered=${afterEsc}`);
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForTimeout(200);

  // F9 — one Escape dismisses ONE layer. The overflow menu is topmost, so closing it must not also
  // clear the in-thread filter underneath it.
  await page.setViewportSize({ width: 700, height: 800 });
  await page.waitForTimeout(300);
  const box9 = page.locator('.disc-tb-bar input[type="search"]:visible').first();
  if (await box9.count()) {
    await box9.fill('the');
    await page.waitForTimeout(300);
    const pre9 = await page.evaluate(() => document.querySelector('.disc-tb-bar input[type="search"]')?.value ?? '');
    check('PRECONDITION: the filter is actually set before the menu is opened', pre9 === 'the', `value=${JSON.stringify(pre9)}`);
    await page.evaluate(() => document.querySelector('.disc-toolbar button[aria-label="More discussion tools"]')?.click());
    await page.waitForTimeout(250);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    const layers = await page.evaluate(() => ({
      menuOpen: !!document.querySelector('.disc-toolbar [role="menu"]'),
      q: document.querySelector('.disc-tb-bar input[type="search"]')?.value ?? '',
    }));
    check(
      'one Escape closes the overflow menu WITHOUT clearing the in-thread filter',
      !layers.menuOpen && layers.q === 'the',
      JSON.stringify(layers),
    );
    await page.keyboard.press('Escape');
    await page.waitForTimeout(250);
  }

  // F10 — the view is reused across ids, so a filter must not follow the reader to a DIFFERENT
  // discussion and render "0 matches" over a thread that has comments.
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForTimeout(250);
  const box10 = page.locator('.disc-tb-bar input[type="search"]:visible').first();
  if (await box10.count()) {
    await box10.fill('zzzzz');
    await page.waitForTimeout(350);
    await page.evaluate(() => { window.location.hash = '#/item/2'; });
    await page.waitForTimeout(900);
    const carried = await page.evaluate(() => ({
      q: document.querySelector('.disc-tb-bar input[type="search"]')?.value ?? '',
      saysNoMatch: /no comments match/i.test(document.body.innerText),
    }));
    check(
      'a filter does not follow the reader to a different discussion',
      carried.q === '' && !carried.saysNoMatch,
      JSON.stringify(carried),
    );
  }
  await page.evaluate(() => { window.location.hash = '#/item/1'; });
  await page.waitForTimeout(700);
}

await b.close();
console.log(`\n${fails.length === 0 ? 'RESULT: DISCUSSION VIEW (summary gate + feed-open new-badge) PASS \u2713' : `RESULT: ${fails.length} FAILED \u2717`}`);
if (fails.length) fails.forEach((f) => console.log('  - ' + f));
process.exit(fails.length ? 1 : 0);
