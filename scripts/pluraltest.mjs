// Comment-count copy must singularise at N=1: "1 comment", never "1 comments".
// Two surfaces: the feed story-card top-comment-preview control, AND the discussion-page header.
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:4173/';
const now = Math.floor(Date.now() / 1000);
const longText = '<p>This is a genuinely substantive top comment, well over the forty-character preview floor.</p>';
const ONE = { id: 1, type: 'story', by: 'u1', title: 'Exactly one comment', url: 'https://ex1.com/a', score: 120, descendants: 1, time: now - 3600, kids: [11] };
const MANY = { id: 2, type: 'story', by: 'u2', title: 'Several comments', url: 'https://ex2.com/b', score: 130, descendants: 7, time: now - 3601, kids: [21] };
const C11 = { id: 11, type: 'comment', by: 'c1', text: longText, time: now - 3500, parent: 1 };
const C21 = { id: 21, type: 'comment', by: 'c2', text: longText, time: now - 3500, parent: 2 };
const byId = new Map([[1, ONE], [2, MANY], [11, C11], [21, C21]]);
// Algolia /items/:id tree — the discussion header reads `story.descendants ?? topLevel.length`.
const tree = (id, nKids) => ({
  id, story_id: id, title: byId.get(id).title, url: byId.get(id).url, points: byId.get(id).score,
  author: byId.get(id).by, created_at_i: now - 3600, type: 'story', text: null,
  children: Array.from({ length: nKids }, (_, i) => ({
    id: id * 100 + i, author: `r${i}`, text: longText, created_at_i: now - 3500 + i, children: [],
  })),
});

const fails = [];
const check = (name, pass, detail = '') => {
  console.log(`  ${pass ? '\u2713' : '\u2717'} ${name}${detail ? ` \u2014 ${detail}` : ''}`);
  if (!pass) fails.push(name);
};

const b = await chromium.launch({ headless: true });
// xl viewport so the discussion header's `xl:inline` "comments" word is visible.
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
const page = ctx.pages()[0] || (await ctx.newPage());
await page.route(/hacker-news\.firebaseio\.com/, (r) => {
  const u = r.request().url();
  const j = (x) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(x) });
  if (/topstories|beststories|newstories/.test(u)) return j([1, 2]);
  const m = u.match(/item\/(\d+)/);
  if (m) return j(byId.get(Number(m[1])) ?? null);
  return j(null);
});
// Broad algolia stub first, then specific tree routes (last-registered wins).
await page.route(/hn\.algolia\.com|google\.com\/s2/, (r) => r.fulfill({ status: 200, body: '{}' }));
await page.route(/hn\.algolia\.com\/api\/v1\/items\/1\b/, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(tree(1, 1)) }));
await page.route(/hn\.algolia\.com\/api\/v1\/items\/2\b/, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(tree(2, 7)) }));

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__hnlens && window.__hnlens.prefs, null, { timeout: 20000 });
await page.evaluate(() => window.__hnlens.prefs.getState().set({
  defaultFeed: 'top', minPoints: 0, hideReadInFeed: false, showTopComments: true, layout: 'cards',
}));
await page.waitForSelector('article', { timeout: 15000 });
await page.waitForFunction(() => /Read \d+ comment/.test(document.body.innerText), null, { timeout: 15000 }).catch(() => {});
await page.waitForTimeout(400);

// ---- Surface 1: feed story-card preview control ----
const feed = await page.evaluate(() => document.querySelector('.app-content')?.innerText ?? document.body.innerText);
const seen = (feed.match(/Read \d+ comments?\b/g) || []).join(' | ');
check('PRECONDITION: the top-comment preview rendered its "Read N comment(s)" control', /Read \d+ comment/.test(feed), seen);
check('feed card: a 1-comment story reads "1 comment" (singular)', /Read 1 comment(?!s)/.test(feed), seen);
check('feed card: a 1-comment story does NOT read "1 comments"', !/Read 1 comments\b/.test(feed), seen);
check('feed card: a multi-comment story still reads the plural "comments"', /Read 7 comments\b/.test(feed), seen);

// ---- Surface 2: discussion-page header ----
await page.evaluate(() => { location.hash = '#/item/1'; });
await page.waitForFunction(() => /Exactly one comment/.test(document.body.innerText), null, { timeout: 15000 }).catch(() => {});
await page.waitForTimeout(400);
// innerText puts the count and the word on separate lines; normalise whitespace before matching.
const hdr1 = (await page.evaluate(() => document.querySelector('.app-content')?.innerText ?? document.body.innerText)).replace(/\s+/g, ' ');
check('PRECONDITION: discussion header shows a count + "comment(s)" word', /\b1 comments?\b/.test(hdr1), (hdr1.match(/\b\d+ comments?\b/g) || []).join(' | '));
check('discussion header (N=1): reads "1 comment", not "1 comments"', /\b1 comment\b/.test(hdr1) && !/\b1 comments\b/.test(hdr1), (hdr1.match(/\b\d+ comments?\b/g) || []).join(' | '));

await page.evaluate(() => { location.hash = '#/item/2'; });
await page.waitForFunction(() => /Several comments/.test(document.body.innerText), null, { timeout: 15000 }).catch(() => {});
await page.waitForTimeout(400);
const hdr2 = (await page.evaluate(() => document.querySelector('.app-content')?.innerText ?? document.body.innerText)).replace(/\s+/g, ' ');
check('discussion header (N=7): still reads the plural "comments"', /\b7 comments\b/.test(hdr2), (hdr2.match(/\b\d+ comments?\b/g) || []).join(' | '));

await b.close();
console.log(`\n${fails.length === 0 ? 'RESULT: PLURAL PASS \u2713' : `RESULT: ${fails.length} FAILED`}`);
process.exit(fails.length ? 1 : 0);
