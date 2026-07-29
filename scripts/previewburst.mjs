// The default-on top-comment preview must not flood the shared 6-connection firebase origin: with
// many cards in view at once, each card fetching its preview independently produced a large burst
// (queue depth 85, ~1.2s dispatch wait, starving the For-You item fetches). getTopComments now holds
// a cross-card concurrency slot, so at most a few cards fetch previews AT ONCE.
//
// This counts CONCURRENT preview (kid) fetches — kid ids are >= 1000 so they are distinguishable from
// story-item fetches — while a tall viewport brings many cards into view simultaneously.
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:4173/';
const now = Math.floor(Date.now() / 1000);
const N = 30;
const FEED = Array.from({ length: N }, (_, i) => i + 1);
const longText = '<p>This is a genuinely substantive comment, comfortably over the forty-character preview floor.</p>';
const story = (id) => ({ id, type: 'story', by: `u${id}`, title: `Story ${id} with a headline`, url: `https://s${id}.com/x`, score: 100 + id, descendants: 3, time: now - 3600, kids: [id * 1000, id * 1000 + 1, id * 1000 + 2] });
const kid = (id) => ({ id, type: 'comment', by: `c${id}`, text: longText, time: now - 3000, parent: Math.floor(id / 1000) });

const fails = [];
const check = (name, pass, detail = '') => {
  console.log(`  ${pass ? '\u2713' : '\u2717'} ${name}${detail ? ` \u2014 ${detail}` : ''}`);
  if (!pass) fails.push(name);
};

let kidInflight = 0;
let kidPeak = 0;

const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ viewport: { width: 1180, height: 2200 } }); // tall → many cards in view at once
const page = ctx.pages()[0] || (await ctx.newPage());
await page.route(/hacker-news\.firebaseio\.com/, async (r) => {
  const u = r.request().url();
  const j = (x) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(x) });
  if (/topstories|beststories|newstories/.test(u)) return j(FEED);
  const m = u.match(/item\/(\d+)\.json/);
  if (m) {
    const id = Number(m[1]);
    if (id >= 1000) {
      // A preview (kid) fetch — measure concurrency with a delay.
      kidInflight++;
      kidPeak = Math.max(kidPeak, kidInflight);
      await new Promise((res) => setTimeout(res, 150));
      kidInflight--;
      return j(kid(id));
    }
    return j(story(id)); // story item — immediate, not counted
  }
  return j(null);
});
await page.route(/hn\.algolia\.com|google\.com\/s2/, (r) => r.fulfill({ status: 200, body: '{}' }));

await page.goto(`${BASE}#/?feed=top`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__hnlens && window.__hnlens.prefs, null, { timeout: 20000 });
await page.evaluate(() => window.__hnlens.prefs.getState().set({ defaultFeed: 'top', minPoints: 0, showTopComments: true, hideReadInFeed: false, layout: 'cards' }));
await page.waitForSelector('.story-card', { timeout: 20000 });
// Let all in-view cards fire their preview fetches and settle.
await page.waitForTimeout(4000);

const cardsInView = await page.evaluate(() => {
  const vh = window.innerHeight;
  return [...document.querySelectorAll('.story-card')].filter((c) => { const r = c.getBoundingClientRect(); return r.top < vh + 250 && r.bottom > -250; }).length;
});
check('PRECONDITION: many cards were in view at once (a real burst)', cardsInView >= 8, `cardsInView=${cardsInView}`);
check('PRECONDITION: previews actually fetched', kidPeak > 0, `kidPeak=${kidPeak}`);
// The cross-card slot caps concurrent preview fetches at PREVIEW_CARD_CONCURRENCY(2) × getItems-bound(3) = 6.
check('preview fetches are bounded across cards (peak concurrent <= 6)', kidPeak <= 6, `kidPeak=${kidPeak} across ${cardsInView} in-view cards`);

await b.close();
console.log(`\n${fails.length === 0 ? 'RESULT: PREVIEW BURST PASS \u2713' : `RESULT: ${fails.length} FAILED`}`);
process.exit(fails.length ? 1 : 0);
