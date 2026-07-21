// Per-domain diversity test — guards the fix: one heavy/followed domain must not
// flood the top of For You. With 8 high-score github.com stories + 8 lower-score
// distinct-domain stories, pure score order would put all 8 github items on top;
// the diversity cap keeps at most 3 of one domain in the front (the rest are pushed
// down, not removed). Drives the REAL For-You ranking through the app.
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:4173/';
const now = Math.floor(Date.now() / 1000);

// 8 github.com stories with the HIGHEST scores (would dominate) + 8 distinct-domain
// stories with lower scores. Same time/comments so only score/domain differ.
const GH = Array.from({ length: 8 }, (_, i) => ({ id: 700 + i, type: 'story', by: `g${i}`, title: `GH story ${i}`, url: `https://github.com/p${i}`, score: 300 - i, descendants: 20, time: now - 3600 }));
const ALT = Array.from({ length: 8 }, (_, i) => ({ id: 800 + i, type: 'story', by: `a${i}`, title: `Alt story ${i}`, url: `https://alt${i}.com/p`, score: 150 - i, descendants: 20, time: now - 3600 }));
const ALL = [...GH, ...ALT];
const POOL = ALL.map((x) => x.id);
const byId = new Map(ALL.map((x) => [x.id, x]));

const fails = [];
const check = (name, pass, detail = '') => {
  console.log(`  ${pass ? '\u2713' : '\u2717'} ${name}${detail ? ` \u2014 ${detail}` : ''}`);
  if (!pass) fails.push(name);
};

const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ viewport: { width: 1280, height: 1100 } });
const page = ctx.pages()[0] || (await ctx.newPage());
await page.route(/hacker-news\.firebaseio\.com/, (r) => {
  const u = r.request().url();
  const j = (x) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(x) });
  if (/topstories/.test(u)) return j(POOL);
  if (/(best|new|ask|show|job)stories/.test(u)) return j([]);
  const m = u.match(/item\/(\d+)/);
  if (m) return j(byId.get(Number(m[1])) ?? null);
  return j(null);
});
await page.route(/hn\.algolia\.com|google\.com\/s2/, (r) => r.fulfill({ status: 200, body: '{}' }));
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__hnlens && window.__hnlens.prefs, null, { timeout: 20000 });
await page.evaluate(async () => {
  await (await window.__hnlens.interactions()).clearAllData();
  window.__hnlens.prefs.getState().set({ defaultFeed: 'foryou', useLearnedRanker: false, embeddingsEnabled: false, minPoints: 0, mutedDomains: [], mutedUsers: [], followedDomains: [], keywordsBoost: [] });
});
await page.getByRole('button', { name: 'For You' }).first().click().catch(() => {});
await page.waitForSelector('article', { timeout: 15000 });
await page.waitForTimeout(700);

const titles = await page.evaluate(() => [...document.querySelectorAll('article h3')].map((h) => h.textContent.trim()));
const top10 = titles.slice(0, 10);
const ghInTop10 = top10.filter((t) => t.startsWith('GH story')).length;
const altInTop10 = top10.filter((t) => t.startsWith('Alt story')).length;
console.log('[diversity] top 10:', JSON.stringify(top10));

check('at most 3 of one domain (github.com) in the top 10', ghInTop10 <= 3, `${ghInTop10} github items in top 10`);
check('exactly the cap (3) github items surface near the top', ghInTop10 === 3, `${ghInTop10}`);
check('other-domain stories reach the top 10 (diversity)', altInTop10 >= 6, `${altInTop10} alt items in top 10`);
check('nothing is removed — all 16 stories still present', titles.filter((t) => /^(GH|Alt) story/.test(t)).length === 16, `${titles.length} cards`);

await b.close();
console.log(`\n${fails.length === 0 ? 'RESULT: DIVERSITY PASS \u2713' : `RESULT: ${fails.length} FAILED`}`);
process.exit(fails.length ? 1 : 0);
