// TOP-COMMENT PREVIEW uses RANKED kids, even on the For-You (Algolia) feed.
//
// The card preview picks a standout from the story's first few top-level comments — which only works
// if the kids are HN-RANKED (best-first). firebase item.kids is ranked; the Algolia For-You pool's
// `children` is CHRONOLOGICAL. So getTopComments ranks from the story's FIREBASE item. This drives
// the REAL getTopComments (via window.__hnlens) with an Algolia-shaped item whose chronological kids
// bury the standout past MAX_KIDS, and asserts the preview still surfaces it. Falls back to the
// item's own kids if the firebase story fetch fails.
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:4173/';

// Story 800: standout comment (8007) is posted LAST (chronological), so it's past the first 5 kids
// chronologically, but FIRST in firebase's ranked order.
const CHRONO = [8001, 8002, 8003, 8004, 8005, 8006, 8007];
const RANKED = [8007, 8001, 8002, 8003, 8004, 8005, 8006];
const weakText = '<p>A middling early comment, just long enough to clear the floor.</p>'; // ~55 chars, 0 replies
const STANDOUT = 'GENUINE STANDOUT: a substantive top comment many people replied to and engaged with.';

const fails = [];
const check = (name, pass, detail = '') => { console.log(`  ${pass ? '\u2713' : '\u2717'} ${name}${detail ? ` \u2014 ${detail}` : ''}`); if (!pass) fails.push(name); };

const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
const page = ctx.pages()[0] || (await ctx.newPage());
await page.route(/hacker-news\.firebaseio\.com/, (r) => {
  const u = r.request().url();
  const j = (x) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(x) });
  const m = u.match(/item\/(\d+)/);
  if (m) {
    const id = Number(m[1]);
    if (id === 800) return j({ id: 800, type: 'story', by: 'op', title: 'Story 800', url: 'https://ex.com/800', score: 300, descendants: 7, kids: RANKED, time: 1 });
    // id 801 has NO story mock -> getItem(801) resolves null -> getTopComments falls back to the
    // item's own (chronological) kids. Its comment ids (8001..) DO resolve, so a preview still shows.
    if (id === 8007) return j({ id: 8007, type: 'comment', by: 'sage', text: `<p>${STANDOUT}</p>`, kids: [9001, 9002, 9003, 9004, 9005], parent: 800 });
    if (id >= 8001 && id <= 8006) return j({ id, type: 'comment', by: `u${id}`, text: weakText, kids: [], parent: 800 });
    if (id >= 9001) return j({ id, type: 'comment', by: `r${id}`, text: '<p>a reply</p>', kids: [], parent: 8007 });
    return j(null);
  }
  return j(null);
});
await page.route(/hn\.algolia\.com|google\.com\/s2|gstatic\.com/, (r) => r.fulfill({ status: 200, body: '{}' }));

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__hnlens && window.__hnlens.topComment, null, { timeout: 20000 });
await page.evaluate(async () => { await (await window.__hnlens.interactions()).clearAllData(); });

// The For-You card carries the ALGOLIA (chronological) kids; getTopComments must rank from firebase.
const algoliaItem = { id: 800, type: 'story', by: 'op', title: 'Story 800', url: 'https://ex.com/800', score: 300, descendants: 7, kids: CHRONO, time: 1 };

// 1) RANKED: the standout (posted last) is surfaced despite being past the first 5 chronological kids.
const picked = await page.evaluate(async (item) => {
  const tc = await window.__hnlens.topComment();
  return await tc.getTopComments(item);
}, algoliaItem);
check('preview surfaces the RANKED standout, not an oldest-first comment', Array.isArray(picked) && picked.length > 0 && /GENUINE STANDOUT/.test(picked[0].text) && picked[0].by === 'sage', JSON.stringify(picked?.[0] ?? null));

// 2) FALLBACK: no firebase story item (getItem null) -> fall back to the item's own kids, so a
// preview still renders (id 801: fresh, no kv cache, no story mock; its chronological kids resolve).
const fallback = await page.evaluate(async (item) => {
  const tc = await window.__hnlens.topComment();
  return await tc.getTopComments(item);
}, { ...algoliaItem, id: 801, kids: CHRONO });
check('a missing firebase story still yields a preview (fallback to the item\u2019s kids)', Array.isArray(fallback) && fallback.length > 0, JSON.stringify(fallback?.[0] ?? null));

console.log(fails.length ? `\nRESULT: ${fails.length} FAILED` : '\nRESULT: all passed');
await b.close();
process.exit(fails.length ? 1 : 0);
