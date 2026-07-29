// Un-hiding a story from Settings / the Hidden dialog (i.e. NOT via the feed's own "Restore")
// must also clear the in-session "Hidden — Restore" placeholder stub. Otherwise the feed keeps
// rendering the story as a hidden stub while search shows it normally — the two surfaces disagree.
//
// The feed's own Restore already unmarks the stub; the fix moves that into unhideItem/unhideAll so
// EVERY un-hide path clears it. Hermetic: drives feedSession + the real unhideItem via __hnlens.
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:4173/';
const fails = [];
const check = (name, pass, detail = '') => {
  console.log(`  ${pass ? '\u2713' : '\u2717'} ${name}${detail ? ` \u2014 ${detail}` : ''}`);
  if (!pass) fails.push(name);
};

const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
const page = ctx.pages()[0] || (await ctx.newPage());
await page.route(/hacker-news\.firebaseio\.com/, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: 'null' }));
await page.route(/hn\.algolia\.com|google\.com\/s2/, (r) => r.fulfill({ status: 200, body: '{}' }));
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__hnlens && window.__hnlens.feedSession && window.__hnlens.localData, null, { timeout: 20000 });

const res = await page.evaluate(async () => {
  const fs = await window.__hnlens.feedSession();
  const ld = await window.__hnlens.localData();
  const ID = 987654;
  fs.clearHiddenStubs();
  // Simulate a feed-level hide: the card records a session stub placeholder.
  fs.markHiddenInSession(ID);
  const before = fs.hiddenInSession().includes(ID);
  // Un-hide via the Settings / Hidden-dialog path (NOT the feed Restore).
  await ld.unhideItem(ID);
  const afterItem = fs.hiddenInSession().includes(ID);
  // And the bulk path.
  fs.markHiddenInSession(ID);
  await ld.unhideAll();
  const afterAll = fs.hiddenInSession().includes(ID);
  return { before, afterItem, afterAll };
});

check('PRECONDITION: a feed hide leaves a session stub', res.before === true, `before=${res.before}`);
check('unhideItem (Settings/dialog path) clears the session stub', res.afterItem === false, `stub-still-present=${res.afterItem}`);
check('unhideAll (bulk) clears the session stub', res.afterAll === false, `stub-still-present=${res.afterAll}`);

await b.close();
console.log(`\n${fails.length === 0 ? 'RESULT: HIDDEN STUB PASS \u2713' : `RESULT: ${fails.length} FAILED`}`);
process.exit(fails.length ? 1 : 0);
