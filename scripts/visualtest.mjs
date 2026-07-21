// Visual regression: capture key screens over a mocked HN API (deterministic,
// animations disabled, fixed viewport) and diff against baselines with pixelmatch.
// First run (or `--update`) writes baselines; later runs fail on >0.5% pixel drift.
// Baselines live in scripts/.artifacts/visual/baseline (gitignored) — this is a
// within-session/CI regression tool unless you commit the baselines.
import { chromium } from 'playwright';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';

const BASE = process.env.BASE || 'http://localhost:4173/';
const UPDATE = process.argv.includes('--update');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '.artifacts', 'visual');
const BASELINE = join(ROOT, 'baseline');
const CURRENT = join(ROOT, 'current');
const DIFF = join(ROOT, 'diff');
for (const d of [BASELINE, CURRENT, DIFF]) mkdirSync(d, { recursive: true });

const now = Math.floor(Date.now() / 1000);
const ids = [1, 2, 3, 4, 5];
const mk = (id) => ({ id, type: 'story', by: `user${id}`, title: `Story number ${id} about software and systems`, url: `https://d${id}.example/x`, score: 100 + id, descendants: 20 + id, time: now - 3600 });

const fails = [];
const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
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
  r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id, created_at_i: now - 3600, author: `user${id}`, title: mk(id).title, url: mk(id).url, points: 100, story_id: id, parent_id: null, type: 'story', children: [{ id: id * 10, created_at_i: now - 100, author: 'c', text: 'A stable comment for the visual snapshot.', parent_id: id, story_id: id, points: 3, type: 'comment', children: [] }] }) });
});
await page.route(/hn\.algolia\.com\/api\/v1\/search/, (r) => r.fulfill({ status: 200, body: '{"nbHits":0,"hits":[]}' }));
await page.route(/google\.com\/s2\/favicons/, (r) => r.fulfill({ status: 200, body: '' }));
await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}' }).catch(() => {});

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__hnlens, null, { timeout: 20000 });
await page.evaluate(async () => {
  await (await window.__hnlens.interactions()).clearAllData();
  window.__hnlens.prefs.getState().set({ defaultFeed: 'top', theme: 'light', useLearnedRanker: false, embeddingsEnabled: false, minPoints: 0 });
});

async function snap(name, prep) {
  await prep();
  await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important}' }).catch(() => {});
  await page.waitForTimeout(300);
  const buf = await page.screenshot();
  writeFileSync(join(CURRENT, `${name}.png`), buf);
  const basePath = join(BASELINE, `${name}.png`);
  if (UPDATE || !existsSync(basePath)) {
    writeFileSync(basePath, buf);
    console.log(`  = ${name}: baseline ${UPDATE ? 'updated' : 'created'}`);
    return;
  }
  const a = PNG.sync.read(readFileSync(basePath));
  const c = PNG.sync.read(buf);
  if (a.width !== c.width || a.height !== c.height) {
    console.log(`  \u2717 ${name}: size changed ${a.width}x${a.height} -> ${c.width}x${c.height}`);
    fails.push(name);
    return;
  }
  const diff = new PNG({ width: a.width, height: a.height });
  const px = pixelmatch(a.data, c.data, diff.data, a.width, a.height, { threshold: 0.1 });
  const ratio = px / (a.width * a.height);
  const ok = ratio < 0.005;
  console.log(`  ${ok ? '\u2713' : '\u2717'} ${name}: ${(ratio * 100).toFixed(3)}% changed (${px}px)`);
  if (!ok) {
    writeFileSync(join(DIFF, `${name}.png`), PNG.sync.write(diff));
    fails.push(name);
  }
}

console.log('\n[visual] snapshots vs baseline' + (UPDATE ? ' (updating)' : ''));
await snap('home-light', async () => {
  await page.evaluate(() => window.__hnlens.prefs.getState().set({ theme: 'light' }));
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('article', { timeout: 15000 });
});
await snap('home-dark', async () => {
  await page.evaluate(() => window.__hnlens.prefs.getState().setTheme('dark'));
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('article', { timeout: 15000 });
});
await snap('settings', async () => {
  await page.evaluate(() => window.__hnlens.prefs.getState().setTheme('light'));
  await page.goto(BASE + '#/settings', { waitUntil: 'domcontentloaded' });
  await page.getByText('For You ranking weights').waitFor({ timeout: 10000 }).catch(() => {});
});
await snap('item', async () => {
  await page.goto(BASE + '#/item/1', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(800);
});

await b.close();
console.log('\n==================================================');
console.log(`VISUAL: ${fails.length === 0 ? 'no regressions \u2713' : `${fails.length} changed \u2717 (see scripts/.artifacts/visual/diff)`}`);
process.exit(fails.length ? 1 : 0);
