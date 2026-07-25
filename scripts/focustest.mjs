// C2 — HackerWeb-style Focus page: the Discussion | Article dual-view on /item.
// Asserts the toggle appears for link stories, the Article view renders the extracted
// text + proxy attribution + original link (and hides the comments), and toggling back
// restores the discussion.
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:4173/';
const now = Math.floor(Date.now() / 1000);

const STORY = { id: 3000, type: 'story', by: 'author1', title: 'A great article about widgets', url: 'https://example.com/widgets', score: 123, descendants: 2, time: now - 3600 };
const TREE = {
  id: 3000, story_id: 3000, title: STORY.title, url: STORY.url, author: 'author1', points: 123, created_at_i: now - 3600, type: 'story', text: null,
  children: [
    { id: 3001, author: 'commenter_a', text: '<p>a fine discussion comment</p>', created_at_i: now - 3000, children: [] },
    { id: 3002, author: 'commenter_b', text: '<p>another discussion comment</p>', created_at_i: now - 2000, children: [] },
  ],
};
const ARTICLE = { text: 'First paragraph about widgets and their uses.\n\nSecond paragraph with deeper widget detail.', proxy: 'AllOrigins' };

// A second link story whose article is NOT cached and whose reader proxies all FAIL —
// used to prove the Article view shows a definitive failure state, not an endless spinner.
const STORY2 = { id: 3100, type: 'story', by: 'author2', title: 'A broken article about gadgets', url: 'https://example.com/broken-gadgets', score: 50, descendants: 1, time: now - 1800 };
const TREE2 = {
  id: 3100, story_id: 3100, title: STORY2.title, url: STORY2.url, author: 'author2', points: 50, created_at_i: now - 1800, type: 'story', text: null,
  children: [{ id: 3101, author: 'commenter_c', text: '<p>broken-article discussion comment</p>', created_at_i: now - 1700, children: [] }],
};

const fails = [];
const check = (name, pass, detail = '') => {
  console.log(`  ${pass ? '\u2713' : '\u2717'} ${name}${detail ? ` \u2014 ${detail}` : ''}`);
  if (!pass) fails.push(name);
};

const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ viewport: { width: 1000, height: 1000 } });
const page = ctx.pages()[0] || (await ctx.newPage());
// Stub speech synthesis so we can assert Listen (TTS) actually speaks (headless has no audio).
await page.addInitScript(() => {
  window.__spoke = [];
  const fake = {
    speaking: false,
    speak(u) { window.__spoke.push(u && u.text ? u.text.slice(0, 30) : ''); this.speaking = true; },
    cancel() { this.speaking = false; },
  };
  Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: fake });
  window.SpeechSynthesisUtterance = function (t) { this.text = t; };
});
await page.route(/hacker-news\.firebaseio\.com/, (r) => {
  const u = r.request().url();
  const j = (x) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(x) });
  if (/item\/3000/.test(u)) return j({ id: 3000, type: 'story', by: STORY.by, title: STORY.title, url: STORY.url, score: STORY.score, descendants: STORY.descendants, time: STORY.time });
  if (/item\/3100/.test(u)) return j({ id: 3100, type: 'story', by: STORY2.by, title: STORY2.title, url: STORY2.url, score: STORY2.score, descendants: STORY2.descendants, time: STORY2.time });
  if (/stories/.test(u)) return j([3000]);
  return j(null);
});
await page.route(/hn\.algolia\.com|google\.com\/s2/, (r) => r.fulfill({ status: 200, body: '{}' }));
await page.route(/hn\.algolia\.com\/api\/v1\/items\/3000/, (r) =>
  r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(TREE) })
);
await page.route(/hn\.algolia\.com\/api\/v1\/items\/3100/, (r) =>
  r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(TREE2) })
);
// All reader proxies FAIL (rate-limited / down) for the U1 failure-state test.
await page.route(/allorigins\.win|cors\.eu\.org|codetabs\.com/, (r) => r.fulfill({ status: 500, body: 'nope' }));

// Seed the article cache + enable the reader proxy BEFORE opening the item.
await page.goto(`${BASE}#/`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.__hnlens, null, { timeout: 15000 });
await page.evaluate(async (art) => {
  const dbMod = await window.__hnlens.db();
  await dbMod.kvSet('atext:3000', art);
  window.__hnlens.prefs.getState().set({ fetchArticleText: true });
}, ARTICLE);

await page.goto(`${BASE}#/item/3000`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => /a fine discussion comment|A great article/.test(document.body.innerText), null, { timeout: 20000 });
await page.waitForTimeout(400);

// ---- toggle present for a link story ----
check(
  'C2: Discussion|Article toggle present for a link story',
  (await page.getByRole('tab', { name: 'Discussion' }).count()) > 0 && (await page.getByRole('tab', { name: 'Article' }).count()) > 0
);
check('C2: defaults to Discussion (comments shown)', /a fine discussion comment/.test(await page.locator('body').innerText()));

// ---- switch to Article: extracted text + attribution + original link, comments hidden ----
await page.getByRole('tab', { name: 'Article' }).click();
await page.waitForTimeout(500);
{
  const body = await page.locator('body').innerText();
  check('C2: Article view shows the extracted text', /First paragraph about widgets/.test(body));
  check('C2: Article view shows proxy attribution', /via AllOrigins/i.test(body));
  check('C2: Article view offers the original link', (await page.getByRole('link', { name: /read the original/i }).count()) > 0);
  check('C2: Article view hides the discussion comments', !/a fine discussion comment/.test(body));
}

// ---- C3: Listen (local text-to-speech) reads the article aloud ----
check('C3: Article view offers a Listen (TTS) button', (await page.getByRole('button', { name: /Listen/i }).count()) > 0);
await page.getByRole('button', { name: /Listen/i }).click();
await page.waitForTimeout(300);
const spoke = await page.evaluate(() => window.__spoke || []);
check('C3: clicking Listen speaks the article text', spoke.length > 0 && /First paragraph/.test(spoke[0] || ''), JSON.stringify(spoke));

// ---- toggle back to Discussion ----
await page.getByRole('tab', { name: 'Discussion' }).click();
await page.waitForTimeout(400);
check('C2: toggling back to Discussion restores comments', /a fine discussion comment/.test(await page.locator('body').innerText()));

// ---- U1: Article view shows a definitive FAILURE state (not endless "Fetching…") when all proxies fail ----
await page.goto(`${BASE}#/item/3100`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => /broken-article discussion|A broken article/i.test(document.body.innerText), null, { timeout: 20000 }).catch(() => {});
await page.waitForTimeout(400);
await page.getByRole('tab', { name: 'Article' }).click();
await page.waitForSelector('text=/Couldn.t fetch the article/i', { timeout: 15000 }).catch(() => {});
{
  const body = await page.locator('body').innerText();
  check('U1: all-proxies-fail shows a definitive "Couldn\'t fetch" state', /Couldn.t fetch the article/i.test(body));
  check('U1: failure state offers a Retry control', (await page.getByRole('button', { name: /^Retry$/ }).count()) > 0);
  check('U1: failure state offers the original link', (await page.getByRole('link', { name: /Open the original/i }).count()) > 0);
  check('U1: not stuck on an endless "Fetching the article text…"', !/Fetching the article text/i.test(body));
}

await b.close();
console.log(`\n${fails.length === 0 ? 'RESULT: FOCUS PAGE (dual-view) PASS \u2713' : `RESULT: ${fails.length} FAILED`}`);
process.exit(fails.length ? 1 : 0);
