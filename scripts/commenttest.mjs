// Functional test for comment ORGANIZATION (#2) and RANKING (#3), over a mocked
// Algolia item tree. Asserts concrete behaviour, not "it renders":
//   - sort control offers Default / Newest / Oldest / Most replies and reorders
//   - the story author gets an OP badge
//   - a chain deeper than the indent cap shows "Continue this thread"
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
    Array.from(document.querySelectorAll('.space-y-3 > [id^="comment-"]')).map(
      (el) => el.querySelector('span.font-medium')?.textContent?.trim() ?? ''
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

// ---- continue this thread (depth cap) ----
const cont = await page.getByText(/Continue this thread/i).count();
check('deep chain shows "Continue this thread"', cont >= 1, `${cont}`);

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

// ---- jump-to-parent control exists on nested replies (#11) ----
await page.getByRole('button', { name: 'Default', exact: true }).click();
await page.waitForTimeout(200);
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

// ---- REAL-FLOW: opening a discussion only marks "read" if you STAY (#dwell-gate) ----
const isRead = () =>
  page.evaluate(async () => (await (await window.__hnlens.interactions()).getReadItemIds(50)).includes(1000));
await page.evaluate(async () => (await window.__hnlens.interactions()).clearAllData());
// Leave via the in-app "Back to feed" link (SPA nav) so React runs the unmount
// cleanup that records the dwell — a hard page.goto would tear down JS first.
// glance: open the thread, leave immediately → NOT read
await page.goto(`${BASE}#/item/1000`, { waitUntil: 'domcontentloaded' });
await page.getByRole('link', { name: /Back to feed/i }).waitFor({ timeout: 15000 });
await page.getByRole('link', { name: /Back to feed/i }).click(); // unmount fast (< BOUNCE_MS)
await page.waitForTimeout(400);
check('real flow: GLANCING a discussion does NOT mark it read', !(await isRead()), '');
// stay: open the thread, remain past the read threshold, then leave → read
await page.goto(`${BASE}#/item/1000`, { waitUntil: 'domcontentloaded' });
await page.getByRole('link', { name: /Back to feed/i }).waitFor({ timeout: 15000 });
await page.waitForTimeout(8500); // stay past BOUNCE_MS (8s)
await page.getByRole('link', { name: /Back to feed/i }).click(); // SPA unmount → records the discussion dwell
await page.waitForTimeout(500);
check('real flow: STAYING on a discussion marks it read', await isRead(), '');

await b.close();
console.log(`\n${fails.length === 0 ? 'RESULT: COMMENT ORG + RANKING PASS \u2713' : `RESULT: ${fails.length} FAILED`}`);
process.exit(fails.length ? 1 : 0);
