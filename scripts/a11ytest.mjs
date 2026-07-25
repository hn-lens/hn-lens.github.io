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
await page.route(/google\.com\/s2\/favicons|gstatic\.com\/faviconV2/, (r) => r.fulfill({ status: 200, body: '' }));

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
// Named for the surface it ACTUALLY audits. The comments drawer was deleted in 2026-07; this step
// opens a discussion from a feed card, which now navigates to the full /item page.
//
// The `.catch(() => {})` on the click is removed deliberately: it swallowed a failed click, so if
// the control were ever renamed this step would silently degrade to auditing the Home feed a second
// time and still report green — an audit that cannot fail is not an audit. Let it throw.
await audit('Discussion opened from a feed card', async () => {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('article', { timeout: 15000 });
  await page.locator('article').first().getByRole('button', { name: 'Open comments' }).click();
  // Prove we actually LEFT the feed, so the audit below is of the discussion, not of Home again.
  await page.waitForURL(/#\/item\//, { timeout: 15000 });
  await page.waitForTimeout(900);
});

// --- MODALITY IS IMPLEMENTED, not just declared (aria-modal promises; the browser enforces nothing) ---
// Regression for: seven hand-rolled dialogs with no shared primitive, none of which locked
// background scroll or contained focus. The page scrolled behind the overlay (dismissing the dialog
// left the reader somewhere else, no undo) and Tab immediately walked out into the hidden page, so
// keyboard/screen-reader users could focus controls they cannot see and never cycle back.
const modalFails = [];
const mcheck = (name, pass, detail = '') => {
  console.log(`  ${pass ? '\u2713' : '\u2717'} ${name}${detail ? ` \u2014 ${detail}` : ''}`);
  if (!pass) modalFails.push(name);
};
console.log('\n=== modality: scroll lock + focus containment ===');
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('article', { timeout: 15000 });
const lockBefore = await page.evaluate(() => document.body.style.overflow || '');
await page.keyboard.press('?');
await page.waitForSelector('[role="dialog"][aria-modal="true"]', { timeout: 8000 });
const lockOpen = await page.evaluate(() => document.body.style.overflow || '');
for (let i = 0; i < 20; i++) await page.keyboard.press('Tab');
const contained = await page.evaluate(() => {
  const d = document.querySelector('[role="dialog"][aria-modal="true"]');
  return d ? d.contains(document.activeElement) : null;
});
await page.keyboard.press('Escape');
await page.waitForTimeout(200);
const lockAfter = await page.evaluate(() => document.body.style.overflow || '');
mcheck('a mounted-but-CLOSED dialog does not lock the page', lockBefore !== 'hidden', `before="${lockBefore}"`);
mcheck('an open modal locks background scroll', lockOpen === 'hidden', `open="${lockOpen}"`);
mcheck('focus stays INSIDE the modal across 20 real Tabs', contained === true, `contained=${contained}`);
mcheck('closing the modal restores page scroll', lockAfter !== 'hidden', `after="${lockAfter}"`);

await b.close();
console.log('\n==================================================');
console.log(`A11Y: ${allSevere.length === 0 && modalFails.length === 0 ? 'no serious/critical issues \u2713' : `${allSevere.length} serious/critical + ${modalFails.length} modality \u2717`}`);
if (warns.length) console.log(`  (${warns.length} minor/moderate: ${[...new Set(warns)].slice(0, 10).join(', ')})`);
process.exit(allSevere.length || modalFails.length ? 1 : 0);
