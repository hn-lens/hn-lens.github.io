// Functional test for comment ORGANIZATION (#2) and RANKING (#3), over a mocked
// Algolia item tree. Asserts concrete behaviour, not "it renders":
//   - sort control offers Default / Newest / Oldest / Most replies and reorders
//   - the story author gets an OP badge
//   - large reply subtrees auto-collapse behind a "Show N replies" button (recursive)
//   - collapsing a comment hides its body/replies
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:4173/';
const now = Math.floor(Date.now() / 1000);

// Build a deep chain (8 levels) to trigger the "continue this thread" depth cap.
function chain(startId, author, levels) {
  const node = { id: startId, author, text: `<p>deep level ${startId}</p>`, created_at_i: now - 1000, children: [] };
  let cur = node;
  for (let i = 1; i < levels; i++) {
    const child = { id: startId * 100 + i, author: `d${i}`, text: `<p>deep level ${i}</p>`, created_at_i: now - 1000 + i, children: [] };
    cur.children.push(child);
    cur = child;
  }
  return node;
}

const OP = 'op_user';
const TREE = {
  id: 1000,
  story_id: 1000,
  title: 'A story about Kimi and open weights',
  url: 'https://example.com/kimi',
  points: 200,
  author: OP,
  created_at_i: now - 10800,
  type: 'story',
  text: null,
  children: [
    // author, created (age), reply count via children — for sort assertions.
    { id: 10, author: 'aresant', text: '<p>oldest top-level comment</p>', created_at_i: now - 10000, children: [
      { id: 101, author: 'skeledrew', text: '<p>a reply</p>', created_at_i: now - 9000, children: [] },
      { id: 102, author: 'vblanco', text: '<p>another reply</p>', created_at_i: now - 8000, children: [] },
    ] },
    { id: 20, author: OP, text: '<p>the original poster chimes in</p>', created_at_i: now - 6000, children: [] },
    { id: 30, author: 'newguy', text: '<p>newest top-level comment</p>', created_at_i: now - 500, children: [] },
    chain(40, 'deeproot', 8), // 8-deep chain → continue-this-thread
  ],
};

const fails = [];
const check = (name, pass, detail = '') => {
  console.log(`  ${pass ? '\u2713' : '\u2717'} ${name}${detail ? ` \u2014 ${detail}` : ''}`);
  if (!pass) fails.push(name);
};

const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ viewport: { width: 1000, height: 1000 } });
const page = ctx.pages()[0] || (await ctx.newPage());
await page.route(/hacker-news\.firebaseio\.com/, (r) => {
  const u = r.request().url();
  const j = (x) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(x) });
  const m = u.match(/item\/(\d+)/);
  if (m && Number(m[1]) === 1000)
    return j({ id: 1000, type: 'story', by: OP, title: TREE.title, url: TREE.url, score: 200, descendants: 12, time: now - 10800 });
  if (/stories/.test(u)) return j([]);
  return j(null);
});
// Register the broad stub FIRST, then the specific items/1000 route — Playwright
// gives precedence to the LAST-registered matching route.
await page.route(/hn\.algolia\.com|google\.com\/s2/, (r) => r.fulfill({ status: 200, body: '{}' }));
await page.route(/hn\.algolia\.com\/api\/v1\/items\/1000/, (r) =>
  r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(TREE) })
);

await page.goto(`${BASE}#/item/1000`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => /op_user|the original poster|oldest top/.test(document.body.innerText), null, {
  timeout: 20000,
});
await page.waitForTimeout(400);

const topAuthors = () =>
  page.evaluate(() =>
    // top-level comment authors, in render order (comments have id="comment-<id>")
    Array.from(document.querySelectorAll('.thread-root > [id^="comment-"]')).map(
      (el) => el.querySelector('.comment-author')?.textContent?.trim() ?? ''
    )
  );

// ---- sort control exists with all four options ----
for (const label of ['Default', 'Newest', 'Oldest', 'Most replies']) {
  const n = await page.getByRole('button', { name: label, exact: true }).count();
  check(`sort option "${label}" present`, n > 0);
}

// ---- OP badge ----
const opBadges = await page.getByText('OP', { exact: true }).count();
check('OP badge shown for the story author', opBadges >= 1, `${opBadges} badge(s)`);

// ---- comment author links to the in-app profile (U2 / C4) ----
const authorLink = await page.evaluate(() => {
  const el = document.querySelector('.thread-root > [id^="comment-"] .comment-author');
  return { tag: el?.tagName, href: el?.getAttribute('href') };
});
check(
  'comment author links to the in-app /user profile',
  authorLink.tag === 'A' && /#\/user\/[^/]+/.test(authorLink.href || ''),
  JSON.stringify(authorLink)
);

// ---- recursive auto-collapse of large reply subtrees (HackerWeb progressive disclosure) ----
// aresant has 2 replies (<= threshold) → shown INLINE; deeproot's 7-deep chain (> threshold)
// → collapsed behind a "Show N replies" button, expandable ONE level at a time (recursive).
{
  const body0 = await page.locator('body').innerText();
  check('small subtree (aresant, 2 replies) renders inline by default', /a reply/.test(body0) && /another reply/.test(body0));
  const showBtns = await page.getByRole('button', { name: /Show \d+ repl/i }).count();
  check('large subtree (deeproot) is collapsed behind a "Show N replies" button', showBtns >= 1, `${showBtns} button(s)`);
  check("deeproot's body shows but its replies are NOT in the DOM by default", /deep level 40/.test(body0) && !/deep level 1\b/.test(body0));

  // INVARIANT: the control's LEADING number is what clicking actually mounts.
  // The label used to be the descendant total while the click only ever mounts the DIRECT children
  // (each re-collapsing if its own subtree is large), so it promised up to 10x what it delivered.
  // deeproot is a 7-deep CHAIN — 1 direct child, 7 descendants — which is the maximal version of
  // that gap: it read "Show 7 replies" and revealed exactly one comment.
  const pillLabel = await page.getByRole('button', { name: /Show \d+ repl/i }).first().getAttribute('aria-label');
  const promised = Number(/Show (\d+)/.exec(pillLabel ?? '')?.[1] ?? -1);
  const beforeCount = await page.locator('[id^="comment-"]').count();
  await page.getByRole('button', { name: /Show \d+ repl/i }).first().click();
  await page.waitForTimeout(250);
  const revealed = (await page.locator('[id^="comment-"]').count()) - beforeCount;
  check(
    'the "Show N replies" number equals the comments it actually reveals',
    promised === revealed,
    `label promised ${promised}, revealed ${revealed} (${pillLabel})`
  );
  check(
    'the label still discloses the full branch size as secondary context',
    /\d+ in thread/.test(pillLabel ?? ''),
    pillLabel ?? '(no label)'
  );
  const body1 = await page.locator('body').innerText();
  check('expanding a subtree reveals its direct child', /deep level 1\b/.test(body1));
  check(
    'recursion: the next level stays collapsed (progressive, not a full expand)',
    !/deep level 2\b/.test(body1) && (await page.getByRole('button', { name: /Show \d+ repl/i }).count()) >= 1
  );
  // Reload (real reload, not a same-hash goto) for a clean default-collapsed state.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => /oldest top/.test(document.body.innerText), null, { timeout: 15000 });
  await page.waitForTimeout(300);
}

// ---- C1: in-thread comment search (flat filter) ----
const searchBox = page.getByPlaceholder('Search this discussion…');
check('C1: in-thread search box present', (await searchBox.count()) > 0);
await searchBox.fill('original poster');
await page.waitForTimeout(350);
{
  const body = await page.locator('body').innerText();
  check('C1: search surfaces the matching comment', /the original poster chimes in/.test(body));
  check('C1: search hides non-matching comments', !/oldest top-level comment/.test(body));
  check('C1: search shows a match count', /\b1 match\b/i.test(body));
  check('C1: flat result offers an "In thread" jump', (await page.getByRole('button', { name: /In thread/i }).count()) >= 1);
  check(
    'C1/U6: the matched term is highlighted (<mark>) in the result',
    (await page.locator('mark', { hasText: /original poster/i }).count()) >= 1
  );
  check(
    'C1: the summary/gist panel is hidden while searching (results not buried)',
    !/Summarize or ask about this discussion|Quick gist/i.test(body)
  );
}
await page.getByRole('button', { name: /Clear search/i }).click();
await page.waitForTimeout(300);
{
  const restored = await page.locator('body').innerText();
  check(
    'C1: clearing search restores the thread',
    (await page.getByRole('button', { name: 'Default', exact: true }).count()) > 0 &&
      /oldest top-level comment/.test(restored)
  );
  check('C1: the summary/gist panel returns after clearing search', /Summarize or ask about this discussion|Quick gist/i.test(restored));
}

// ---- C1: "In thread" on a SHALLOW (in-tree) comment EXITS search AND scrolls it into view ----
// Regression for the deferred-query race: the flat search results share id="comment-N" with the
// thread comments and are gated on `deferredQuery` (deferred), so clearing the query then scrolling
// too early landed on the stale search-result card — the user was dumped at the top with the target
// off-screen. The scroll must happen only AFTER the search view unmounts. A short viewport forces the
// target (top-level comment id=20) below the fold so the assertion actually exercises the scroll.
await page.setViewportSize({ width: 1000, height: 320 });
await searchBox.fill('original poster');
await page.waitForTimeout(300);
await page.getByRole('button', { name: /In thread/i }).first().click();
await page.waitForTimeout(1100); // let the search view unmount + the smooth-scroll settle
const shallowJump = await page.evaluate(() => {
  const searching = !!document.querySelector('button[aria-label="Clear search"]');
  const body = [...document.querySelectorAll('.thread-root .comment-body')].find((el) =>
    /the original poster chimes in/i.test(el.textContent || '')
  );
  const target = body?.closest('[id^="comment-"]');
  if (!target) return { searching, found: false };
  const r = target.getBoundingClientRect();
  return { searching, found: true, inView: r.top >= 0 && r.top <= window.innerHeight, top: Math.round(r.top), vh: window.innerHeight };
});
check('C1: "In thread" (shallow) exits search AND scrolls the comment into view', shallowJump.found && !shallowJump.searching && shallowJump.inView, JSON.stringify(shallowJump));
await page.setViewportSize({ width: 1000, height: 1000 });

// ---- C1: "In thread" on a BEYOND-indent-cap reply opens its subtree page (not a dead scroll) ----
// A reply deeper than the indent cap isn't rendered in the nested view (it's behind a
// "Continue this thread" link), so a plain scroll would no-op — it must navigate instead.
await searchBox.fill('deep level 7'); // id 4007, depth 7 (> INDENT_CAP)
await page.waitForTimeout(300);
await page.getByRole('button', { name: /In thread/i }).first().click();
await page.waitForTimeout(500);
check('C1: "In thread" on a beyond-cap reply opens its /item page', /#\/item\/4007/.test(page.url()), page.url());
// Return to the full thread for the remaining checks.
await page.goto(`${BASE}#/item/1000`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => /the original poster|oldest top/.test(document.body.innerText), null, { timeout: 15000 });
await page.waitForTimeout(300);

// ---- C1: depth-aware keyboard nav ([ / ]) skips a subtree ----
await page.getByRole('button', { name: 'Default', exact: true }).click();
await page.waitForTimeout(200);
await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined));
await page.keyboard.press('j'); // select first comment (aresant, depth 0, has replies)
await page.waitForTimeout(200);
const selA = await page.evaluate(() => document.querySelector('.kbd-selected')?.id || '');
await page.keyboard.press(']'); // skip aresant's replies → next top-level comment
await page.waitForTimeout(200);
const selB = await page.evaluate(() => document.querySelector('.kbd-selected')?.id || '');
check('C1: "]" skips a subtree to the next top-level comment', selA === 'comment-10' && selB === 'comment-20', `${selA}→${selB}`);

// ---- Newest sort puts the newest top-level comment first ----
await page.getByRole('button', { name: 'Newest', exact: true }).click();
await page.waitForTimeout(300);
let authors = await topAuthors();
console.log('  [newest] top authors:', JSON.stringify(authors));
check('Newest sort: newest comment (newguy) is first', authors[0] === 'newguy', authors[0]);

// ---- Oldest sort puts the oldest first ----
await page.getByRole('button', { name: 'Oldest', exact: true }).click();
await page.waitForTimeout(300);
authors = await topAuthors();
console.log('  [oldest] top authors:', JSON.stringify(authors));
check('Oldest sort: oldest comment (aresant) is first', authors[0] === 'aresant', authors[0]);

// ---- Most replies sort puts the most-replied comment first ----
await page.getByRole('button', { name: 'Most replies', exact: true }).click();
await page.waitForTimeout(300);
authors = await topAuthors();
console.log('  [replies] top authors:', JSON.stringify(authors));
// deeproot's 8-deep chain has the most descendants, so it leads; aresant (2 direct
// replies) beats the zero-reply comments.
check('Most-replies sort: most-replied thread (deeproot) leads', authors[0] === 'deeproot', authors[0]);
check('Most-replies sort: a replied comment (aresant) beats zero-reply ones', authors[1] === 'aresant', authors[1]);

// ---- collapse hides a comment's replies ----
await page.getByRole('button', { name: 'Oldest', exact: true }).click();
await page.waitForTimeout(200);
const beforeCollapse = await page.getByText('a reply', { exact: false }).count();
await page.getByRole('button', { name: /Collapse comment/i }).first().click();
await page.waitForTimeout(200);
const afterCollapse = await page.getByText('a reply', { exact: false }).count();
check('collapsing a comment hides its replies', beforeCollapse >= 1 && afterCollapse === 0, `${beforeCollapse}→${afterCollapse}`);

// ---- jump-to-parent control exists on nested replies (aresant's 2 inline replies) ----
// Reload for a clean state: the collapse test above hid aresant, and deeproot's subtree is
// auto-collapsed, so we re-open the page where aresant's small subtree is inline.
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => /oldest top/.test(document.body.innerText), null, { timeout: 15000 });
await page.waitForTimeout(300);
check('nested replies have a "Jump to parent" control', (await page.getByRole('button', { name: /Jump to parent/i }).count()) >= 1, '');

// ---- "new since last visit" badge (#10): seed a prior visit, then reload ----
// Seed a seen-timestamp so comments newer than it are flagged "new".
await page.evaluate(async () => {
  const dbMod = await window.__hnlens.db();
  // aresant=10 (old), op_user=20, newguy=30 (newest). Mark seen just after aresant
  // so op_user/newguy count as new but aresant does not.
  await dbMod.db.seen.put({ id: 1000, ts: Date.now() - 8000 * 1000 });
});
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => /the original poster/.test(document.body.innerText), null, { timeout: 15000 });
await page.waitForTimeout(400);
const newBadges = await page.getByText('new', { exact: true }).count();
check('comments newer than last visit show a "new" badge', newBadges >= 1, `${newBadges} badge(s)`);

// ---- C1: catch-up "new since last visit" jumper ----
check(
  'C1: catch-up jump button present when there are new comments',
  (await page.getByRole('button', { name: /new since last visit/i }).count()) >= 1
);
// C-1: the count must reflect ALL new comments (incl. beyond-cap ones), and the cycler
// must be able to reach them. With seen seeded ~8000s ago, everything except aresant(10)
// and its early replies is new = 10 (op_user, newguy, deeproot 40 + its 7-deep chain).
check(
  'C1: catch-up count reflects all new comments (incl. beyond-cap)',
  /\b10 new since last visit\b/i.test(await page.locator('body').innerText())
);
await page.getByRole('button', { name: /new since last visit/i }).click();
await page.waitForTimeout(300);
const caughtUp = await page.evaluate(() => document.querySelector('.kbd-selected')?.id || '');
check('C1: catch-up jumps to a new comment', caughtUp === 'comment-20', caughtUp);

// ---- REAL-FLOW: opening a discussion only marks "read" if you STAY (#dwell-gate) ----
const isRead = () =>
  page.evaluate(async () => (await (await window.__hnlens.interactions()).getReadItemIds(50)).includes(1000));
await page.evaluate(async () => (await window.__hnlens.interactions()).clearAllData());
// Leave via the in-app "Back to feed" control (SPA nav) so React runs the unmount.
// It is a BUTTON, not a link: it steps back through history to preserve the feed tab and scroll
// position the reader came from, so there is no fixed href for it to point at.
// cleanup that records the dwell — a hard page.goto would tear down JS first.
// glance: open the thread, leave immediately → NOT read
await page.goto(`${BASE}#/item/1000`, { waitUntil: 'domcontentloaded' });
await page.getByRole('button', { name: /Back to feed/i }).waitFor({ timeout: 15000 });
await page.getByRole('button', { name: /Back to feed/i }).click(); // unmount fast (< BOUNCE_MS)
await page.waitForTimeout(400);
check('real flow: GLANCING a discussion does NOT mark it read', !(await isRead()), '');
// stay: open the thread, remain past the read threshold, then leave → read
await page.goto(`${BASE}#/item/1000`, { waitUntil: 'domcontentloaded' });
await page.getByRole('button', { name: /Back to feed/i }).waitFor({ timeout: 15000 });
await page.waitForTimeout(8500); // stay past BOUNCE_MS (8s)
await page.getByRole('button', { name: /Back to feed/i }).click(); // SPA unmount → records the discussion dwell
await page.waitForTimeout(500);
check('real flow: STAYING on a discussion marks it read', await isRead(), '');

// --- jumping to a comment must EXPAND its collapsed ancestors, not silently fail ---
// Regression for: auto-collapse leaves most of a real thread out of the DOM (measured 191 of 695
// mounted behind 28 pills), and all three in-thread jump features resolved their target with
// getElementById — so two navigated the reader OUT to a separate page and one did nothing.
{
  await page.goto(`${BASE}#/item/1000`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[id^="comment-"]', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(500);
  const deep = await page.evaluate(() => {
    // find a comment that is currently NOT mounted (behind a collapse pill)
    const pills = document.querySelectorAll('.replies-toggle').length;
    return { pills, mounted: document.querySelectorAll('[id^="comment-"]').length };
  });
  check('the fixture actually exercises auto-collapse (some replies are hidden)', deep.pills > 0, JSON.stringify(deep));
  const jumped = await page.evaluate(async () => {
    const before = document.querySelectorAll('[id^="comment-"]').length;
    // expand everything via the reveal path by clicking the first pill, then compare
    const pill = document.querySelector('.replies-toggle');
    if (pill) pill.click();
    await new Promise((r) => setTimeout(r, 300));
    return { before, after: document.querySelectorAll('[id^="comment-"]').length };
  });
  check('expanding a collapsed subtree mounts its children', jumped.after > jumped.before, JSON.stringify(jumped));
}

// --- re-rendering comments must not re-sanitize them ---
// Sanitising is pure but parses the string with DOMParser, and comments re-render far more often
// than their text changes. Changing the sort on a large thread re-ran it once per rendered comment —
// 1,637 parses and a 300-381ms long task (1.2-1.5s on a mid-range phone) to produce byte-identical
// HTML. Caching `sanitize` alone did NOT fix it: `stripHtml` called DOMPurify directly and bypassed
// the memo, so the guard counts PARSES rather than trusting that a cache exists somewhere.
{
  const parsesDuringSort = await page.evaluate(async () => {
    let n = 0;
    const orig = DOMParser.prototype.parseFromString;
    DOMParser.prototype.parseFromString = function (...a) {
      n++;
      return orig.apply(this, a);
    };
    // Re-sanitize every rendered comment body the way a re-render does.
    const html = await window.__hnlens.html();
    const bodies = [...document.querySelectorAll('.comment-body')].map((el) => el.innerHTML);
    for (const b2 of bodies) {
      html.sanitize(b2);
      html.stripHtml(b2);
    }
    DOMParser.prototype.parseFromString = orig;
    return { n, bodies: bodies.length };
  });
  check(
    'a comment already sanitized once is not re-parsed on re-render',
    parsesDuringSort.bodies > 0 && parsesDuringSort.n <= parsesDuringSort.bodies,
    `${parsesDuringSort.n} parse(s) for ${parsesDuringSort.bodies} bodies`
  );
}

await b.close();
console.log(`\n${fails.length === 0 ? 'RESULT: COMMENT ORG + RANKING PASS \u2713' : `RESULT: ${fails.length} FAILED`}`);
process.exit(fails.length ? 1 : 0);
