// For-You candidate SOURCE: the fast Algolia path + its firebase fallback, and the guards that
// exist because the first cut of this feature regressed.
//
// For You is materialised from ONE Algolia request for RECENT STORIES (`tags=story` +
// created_at_i recency filter) — NOT `tags=front_page`, which is ~half pinned "YC is hiring" job
// posts that (a) flood the pool and (b) bypass the min-points filter (a job's null score is not a
// number). `tags=story` excludes jobs by construction; the recency filter stops relevance-sort from
// resurfacing months-old items. `hitToItem` maps children->kids (top-comment preview) and
// story_text->text (Ask/text-post body). On an Algolia failure/empty it falls back to the firebase
// blended pool.
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:4173/';
const now = Math.floor(Date.now() / 1000);
const POOL = [601, 602, 603, 604, 605, 606, 607, 608];
const CHILD_ID = 605; // this candidate carries children + story_text, to prove they map through
const JOB_ID = 699; // a job hit the pool must EXCLUDE (mirrors the real front_page contamination)
const storyHit = (id) => ({
  objectID: String(id), title: `Story ${id}`, url: `https://ex${id}.com/x`, points: 100 + id,
  num_comments: 4, author: `u${id}`, created_at_i: now - 3600, _tags: ['story', `author_u${id}`],
  ...(id === CHILD_ID ? { children: [9001, 9002], story_text: 'A self-post body that must survive mapping.' } : {}),
});
const jobHit = { objectID: String(JOB_ID), title: 'A YC Startup (S25) Is Hiring', url: 'https://ex699.com/jobs', points: null, num_comments: 0, author: 'whoishiring', created_at_i: now - 1800, _tags: ['job'] };
const fbItem = (id) => ({ id, type: 'story', by: `u${id}`, title: `Story ${id}`, url: `https://ex${id}.com/x`, score: 100 + id, descendants: 4, time: now - 3600 });

let algoliaMode = 'ok'; // 'ok' => search returns hits; 'fail' => 500
let fbListCount = 0;
let poolReqUrl = null;

const fails = [];
const check = (name, pass, detail = '') => { console.log(`  ${pass ? '\u2713' : '\u2717'} ${name}${detail ? ` \u2014 ${detail}` : ''}`); if (!pass) fails.push(name); };

const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ viewport: { width: 1280, height: 1000 } });
const page = ctx.pages()[0] || (await ctx.newPage());
await page.route(/hacker-news\.firebaseio\.com/, (r) => {
  const u = r.request().url();
  const j = (x) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(x) });
  if (/(top|best|new)stories/.test(u)) { fbListCount++; return j(POOL); }
  if (/stories/.test(u)) return j([]);
  const m = u.match(/item\/(\d+)/);
  if (m) return j(fbItem(Number(m[1])));
  return j(null);
});
// Broad catch-all FIRST; the specific /search/ route is registered LAST so it wins (Playwright runs
// matching routes in reverse registration order — the last-registered handler takes precedence).
await page.route(/hn\.algolia\.com|google\.com\/s2|gstatic\.com/, (r) => r.fulfill({ status: 200, body: '{}' }));
await page.route(/hn\.algolia\.com\/api\/v1\/search/, (r) => {
  const u = r.request().url();
  poolReqUrl = u; // the For-You pool query (this test never runs a user search)
  if (algoliaMode === 'fail') return r.fulfill({ status: 500, body: 'err' });
  // The API responds to tags=story with only stories, but include a job hit to prove the client
  // also drops one defensively (type !== 'job').
  const hits = [...POOL.map(storyHit), jobHit];
  return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ nbHits: hits.length, hits, page: 0, nbPages: 1 }) });
});

const ids = () => page.evaluate(() => [...document.querySelectorAll('article h3')].map((h) => Number((h.textContent.match(/Story (\d+)/) || [])[1])).filter(Boolean));

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__hnlens && window.__hnlens.prefs, null, { timeout: 20000 });
await page.evaluate(async () => {
  await (await window.__hnlens.interactions()).clearAllData();
  window.__hnlens.prefs.getState().set({ defaultFeed: 'foryou', minPoints: 0, embeddingsEnabled: false, hideReadInFeed: false });
});

// ---- PHASE 1: fast path ----
algoliaMode = 'ok';
fbListCount = 0;
await page.goto(`${BASE}#/?feed=foryou`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('article h3', { timeout: 20000 });
await page.waitForTimeout(900);
const p1 = await ids();
check('fast path: For You shows the story pool', p1.length >= 6 && p1.every((id) => POOL.includes(id)), p1.join(','));
check('fast path: ZERO firebase list fetches (no 3-list merge, no N+1)', fbListCount === 0, `fbListCount=${fbListCount}`);
check('the pool query uses tags=story + a recency filter, NOT front_page (jobs excluded by construction)',
  !!poolReqUrl && /tags=story/.test(poolReqUrl) && /created_at_i/.test(poolReqUrl) && !/front_page/.test(poolReqUrl),
  poolReqUrl ? decodeURIComponent(poolReqUrl.split('?')[1] || '') : 'no request seen');
check('a job post is NOT shown in For You', !p1.includes(JOB_ID), `jobShown=${p1.includes(JOB_ID)}`);

// getForYouCandidates maps children->kids and story_text->text, and drops the job hit defensively.
const mapped = await page.evaluate(async (childId) => {
  const c = await window.__hnlens.client();
  const items = await c.getForYouCandidates(90);
  const child = items.find((it) => it.id === childId);
  return { hasJob: items.some((it) => it.type === 'job' || it.id === 699), kids: child?.kids ?? null, text: child?.text ?? null };
}, CHILD_ID);
check('hitToItem maps children -> kids (restores the top-comment preview)', Array.isArray(mapped.kids) && mapped.kids.length === 2, JSON.stringify(mapped.kids));
check('hitToItem maps story_text -> text (restores Ask/text-post body)', typeof mapped.text === 'string' && mapped.text.length > 0, String(mapped.text));
check('getForYouCandidates drops job hits (they cannot bypass min-points)', mapped.hasJob === false, `hasJob=${mapped.hasJob}`);

// min-points inversion guard: with a high threshold, the job (null score) must still be absent.
await page.evaluate(() => window.__hnlens.prefs.getState().set({ minPoints: 50 }));
await page.getByRole('button', { name: 'Refresh' }).first().click().catch(() => {});
await page.waitForTimeout(900);
const p1b = await ids();
check('min-points high: the job post stays absent (no null-score bypass)', !p1b.includes(JOB_ID), `feed=${p1b.join(',')}`);
await page.evaluate(() => window.__hnlens.prefs.getState().set({ minPoints: 0 }));

// ---- PHASE 2: fallback (Algolia fails -> firebase blended pool) ----
await page.evaluate(async () => {
  if (indexedDB.databases) for (const d of await indexedDB.databases()) await new Promise((res) => { const q = indexedDB.deleteDatabase(d.name); q.onsuccess = q.onerror = q.onblocked = () => res(); });
});
algoliaMode = 'fail';
fbListCount = 0;
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('article h3', { timeout: 20000 });
await page.waitForTimeout(900);
const p2 = await ids();
check('fallback: Algolia down -> For You still loads (from firebase)', p2.length >= 6 && p2.every((id) => POOL.includes(id)), p2.join(','));
check('fallback: the firebase blended pool WAS fetched (resilient path)', fbListCount > 0, `fbListCount=${fbListCount}`);

console.log(fails.length ? `\nRESULT: ${fails.length} FAILED` : '\nRESULT: all passed');
await b.close();
process.exit(fails.length ? 1 : 0);
