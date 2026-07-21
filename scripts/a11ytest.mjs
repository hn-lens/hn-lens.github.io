// Accessibility audit via axe-core on the key surfaces (Home feed, Item permalink,
// Settings, and the open comments drawer). Fails on serious/critical WCAG issues;
// reports moderate/minor as warnings. Mocks HN so pages have deterministic content.
import { chromium } from 'playwright';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const axePath = require.resolve('axe-core/axe.min.js');

const BASE = process.env.BASE || 'http://localhost:4173/';
const now = Math.floor(Date.now() / 1000);
const ids = [1, 2, 3, 4, 5];
const mk = (id) => ({ id, type: 'story', by: `user${id}`, title: `Story number ${id} about software`, url: `https://d${id}.example/x`, score: 100, descendants: 8, time: now - 3600 });

const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ viewport: { width: 1280, height: 1000 } });
const page = ctx.pages()[0] || (await ctx.newPage());
await page.route(/hacker-news\.firebaseio\.com/, (r) => {
  const u = r.request().url();
  const j = (x) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(x) });
  if (/(top|best|new)stories\.json/.test(u)) return j(ids);
  if (/(ask|show|job)stories\.json/.test(u)) return j([]);
  const m = u.match(/item\/(\d+)/);
  if (m) return j(mk(Number(m[1])));
  if (u.includes('/user/')) return j({ id: 'x', karma: 1, created: now });
  return j(null);
});
await page.route(/hn\.algolia\.com\/api\/v1\/items\/(\d+)/, (r) => {
  const id = Number(r.request().url().match(/items\/(\d+)/)[1]);
  r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id, created_at_i: now - 3600, author: `user${id}`, title: mk(id).title, url: mk(id).url, points: 100, story_id: id, parent_id: null, type: 'story', children: [{ id: id * 10, created_at_i: now - 100, author: 'c', text: 'A readable comment for the accessibility check.', parent_id: id, story_id: id, points: 3, type: 'comment', children: [] }] }) });
});
await page.route(/hn\.algolia\.com\/api\/v1\/search/, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"nbHits":0,"hits":[]}' }));
await page.route(/google\.com\/s2\/favicons/, (r) => r.fulfill({ status: 200, body: '' }));

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__hnlens, null, { timeout: 20000 });
await page.evaluate(async () => {
  await (await window.__hnlens.interactions()).clearAllData();
  window.__hnlens.prefs.getState().set({ defaultFeed: 'top', useLearnedRanker: false, embeddingsEnabled: false, minPoints: 0 });
});

const SEVERE = new Set(['serious', 'critical']);
const allSevere = [];
const warns = [];

async function audit(label, prep) {
  await prep();
  await page.addScriptTag({ path: axePath });
  const res = await page.evaluate(async () => window.axe.run(document, { resultTypes: ['violations'] }));
  const severe = res.violations.filter((v) => SEVERE.has(v.impact));
  const minor = res.violations.filter((v) => !SEVERE.has(v.impact));
  console.log(`  ${severe.length === 0 ? '\u2713' : '\u2717'} ${label}: ${severe.length} serious/critical, ${minor.length} minor`);
  for (const v of severe) {
    console.log(`      [${v.impact}] ${v.id}: ${v.help} (${v.nodes.length} node/s) e.g. ${(v.nodes[0]?.target || []).join(' ')}`);
    allSevere.push(`${label}:${v.id}`);
  }
  for (const v of minor) warns.push(`${label}:${v.id} (${v.impact})`);
}

console.log('\n[a11y] axe-core WCAG 2 A/AA');
await audit('Home / feed', async () => {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('article', { timeout: 15000 });
  await page.waitForTimeout(400);
});
await audit('Item permalink', async () => {
  await page.goto(BASE + '#/item/1', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);
});
await audit('Settings', async () => {
  await page.goto(BASE + '#/settings', { waitUntil: 'domcontentloaded' });
  await page.getByText('For You ranking weights').waitFor({ timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(400);
});
await audit('Comments drawer', async () => {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('article', { timeout: 15000 });
  await page.locator('article').first().getByRole('button', { name: 'Open comments' }).click().catch(() => {});
  await page.waitForTimeout(900);
});

await b.close();
console.log('\n==================================================');
console.log(`A11Y: ${allSevere.length === 0 ? 'no serious/critical issues \u2713' : `${allSevere.length} serious/critical \u2717`}`);
if (warns.length) console.log(`  (${warns.length} minor/moderate: ${[...new Set(warns)].slice(0, 10).join(', ')})`);
process.exit(allSevere.length ? 1 : 0);
