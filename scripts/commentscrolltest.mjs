// Scroll-load (windowed) comments for large discussions. A big thread must NOT render every
// top-level comment at once (that was ~4s to first comment for 400+ comments); it renders an initial
// WINDOW and grows it as the reader nears the bottom, while jump/search targets past the window still
// resolve. Asserts concrete behaviour over a mocked 90-comment tree.
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:4173/';
const now = Math.floor(Date.now() / 1000);
const STORY_ID = 2000;
const N = 90; // top-level comments — well above the initial window
const UNIQUE = 'zephyruniquetoken'; // only in the LAST comment, for the search-jump test
const children = Array.from({ length: N }, (_, i) => {
  const n = i + 1;
  return {
    id: STORY_ID + n,
    author: `u${n}`,
    // Long enough that ~30 comments exceed the viewport + rootMargin, so the initial window does not
    // auto-grow on load (the whole point — a real first paint renders only the window).
    text: `<p>Top-level comment number ${n}. A substantive paragraph about the topic with enough length to occupy real vertical space on the page so the window does not immediately fill. ${n === N ? UNIQUE : ''}</p>`,
    created_at_i: now - 100000 + n * 10,
    children: [],
  };
});
const story = { id: STORY_ID, type: 'story', by: 'op', title: 'A very large discussion thread', url: 'https://ex.com/big', score: 500, descendants: N, time: now - 100000 };
const tree = { id: STORY_ID, story_id: STORY_ID, title: story.title, url: story.url, author: 'op', created_at_i: now - 100000, type: 'story', text: null, points: 500, children };

const fails = [];
const check = (name, pass, detail = '') => {
  console.log(`  ${pass ? '\u2713' : '\u2717'} ${name}${detail ? ` \u2014 ${detail}` : ''}`);
  if (!pass) fails.push(name);
};

const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ viewport: { width: 1000, height: 800 } });
const page = ctx.pages()[0] || (await ctx.newPage());
const json = (r, x) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(x) });
await page.route(/hacker-news\.firebaseio\.com/, (r) => {
  const u = r.request().url();
  const m = u.match(/item\/(\d+)/);
  if (m) return json(r, Number(m[1]) === STORY_ID ? story : null);
  if (/stories/.test(u)) return json(r, []);
  return json(r, null);
});
// Generic route FIRST so the specific /items/ route (registered next) WINS (Playwright runs matching
// routes in reverse registration order).
await page.route(/hn\.algolia\.com|google\.com\/s2|gstatic\.com/, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
await page.route(/hn\.algolia\.com\/api\/v1\/items\/(\d+)/, (r) => json(r, tree));

const topCount = () => page.evaluate(() => document.querySelectorAll('.thread-root > *').length);
const hasComment = (cid) => page.evaluate((c) => !!document.getElementById(`comment-${c}`), cid);

await page.goto(`${BASE}#/item/${STORY_ID}`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.thread-root > *', { timeout: 20000 });
await page.waitForTimeout(600);

// (1) INITIAL render is a WINDOW, not the whole thread.
const initial = await topCount();
check('initial render is windowed (far fewer than the 90 comments)', initial > 0 && initial <= 45, `rendered ${initial} of ${N}`);
check('the last comment is NOT rendered initially (proves windowing)', !(await hasComment(STORY_ID + N)), `#comment-${STORY_ID + N}`);

// (2) A "Show more comments (N more)" control discloses the remainder and grows the window.
const showMore = page.getByRole('button', { name: /Show more comments/ });
check('a "Show more comments" control is shown with the remaining count', /Show more comments \(\d+ more\)/.test(await showMore.innerText().catch(() => '')), (await showMore.innerText().catch(() => '')) || '(none)');
await showMore.click();
await page.waitForTimeout(300);
const afterClick = await topCount();
check('clicking "Show more" grows the window', afterClick > initial, `${initial} → ${afterClick}`);

// (3) Scrolling to the bottom repeatedly grows the window until ALL comments are shown.
for (let i = 0; i < 6; i++) {
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(250);
  if ((await topCount()) >= N) break;
}
check('scrolling grows the window until every comment is rendered', (await topCount()) >= N, `${await topCount()} of ${N}`);
check('the last comment renders once fully grown', await hasComment(STORY_ID + N));

// (4) JUMP past the window: a search hit in the LAST comment must resolve to the thread comment even
// though it starts outside the initial window (jumpToComment expands the window).
await page.evaluate(() => {
  window.scrollTo(0, 0);
  location.reload();
});
await page.waitForSelector('.thread-root > *', { timeout: 20000 });
await page.waitForTimeout(500);
check('PRECONDITION: back to a windowed render before the jump test', (await topCount()) <= 45, `${await topCount()} of ${N}`);
// Search is an always-visible INLINE box on the toolbar; click it to focus, then type.
await page.getByLabel('Search comments in this discussion').first().click().catch(() => {});
await page.waitForSelector('input[type="search"]', { timeout: 8000 }).catch(() => {});
await page.keyboard.type(UNIQUE);
await page.waitForTimeout(500);
// Click the search result → it clears the query and jumps to the comment in the thread.
const resultLink = page.locator(`a[href="#/item/${STORY_ID + N}"], [id="comment-${STORY_ID + N}"]`).first();
// The search result card carries the same id; click the "jump to thread" affordance if present, else
// the result itself.
const jumpBtn = page.getByRole('button', { name: /in thread|jump|go to/i }).first();
if (await jumpBtn.count()) await jumpBtn.click().catch(() => {});
else await resultLink.click().catch(() => {});
await page.waitForTimeout(800);
check('a search hit past the initial window is reachable (window expands to it)', await hasComment(STORY_ID + N), `#comment-${STORY_ID + N}`);

await b.close();
console.log(`\n${fails.length === 0 ? 'RESULT: COMMENT SCROLL-LOAD PASS \u2713' : `RESULT: ${fails.length} FAILED`}`);
process.exit(fails.length ? 1 : 0);
