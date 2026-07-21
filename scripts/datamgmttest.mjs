// Data-management-by-type test — guards the feature: Settings shows local data broken
// out by category with per-type counts, and you can delete ONE type while KEEPING the
// others (e.g. remove fetched article text but keep saved stories). Drives the real
// Settings DataManager UI over seeded IndexedDB.
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:4173/';
const now = Math.floor(Date.now() / 1000);

const fails = [];
const check = (name, pass, detail = '') => {
  console.log(`  ${pass ? '\u2713' : '\u2717'} ${name}${detail ? ` \u2014 ${detail}` : ''}`);
  if (!pass) fails.push(name);
};

const b = await chromium.launch({ headless: true });
const page = (await b.newContext({ viewport: { width: 1280, height: 1000 } })).pages()[0] || (await b.newPage());
page.on('dialog', (d) => d.accept()); // auto-accept the delete confirm()
await page.route(/hacker-news\.firebaseio\.com|hn\.algolia\.com|google\.com\/s2/, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__hnlens && window.__hnlens.db, null, { timeout: 20000 });

// Seed distinct data types: 2 fetched articles, 1 summary, 2 saved, 1 hidden.
await page.evaluate(async (t) => {
  const dbMod = await window.__hnlens.db();
  const i = await window.__hnlens.interactions();
  await i.clearAllData();
  await dbMod.kvSet('atext:1', { text: 'article one body', proxy: 'AllOrigins' });
  await dbMod.kvSet('atext:2', { text: 'article two body', proxy: 'codetabs' });
  await dbMod.kvSet('sum:tldr:1:m:v5:a0', { text: 'a summary', sources: {}, articleText: '' });
  await dbMod.db.saved.bulkPut([
    { id: 11, item: { id: 11, title: 'Saved A' }, ts: t },
    { id: 12, item: { id: 12, title: 'Saved B' }, ts: t },
  ]);
  await dbMod.db.hidden.put({ id: 21, ts: t });
  // Interaction signals (for the "N signals recorded — view" viewer).
  await dbMod.db.events.bulkAdd([
    { type: 'open_link', itemId: 101, domain: 'ex.com', ts: t * 1000 },
    { type: 'save', itemId: 102, ts: t * 1000 },
    { type: 'dwell', itemId: 101, value: 12000, ts: t * 1000 },
  ]);
}, now);

const counts = () =>
  page.evaluate(async () => {
    const dbMod = await window.__hnlens.db();
    const kv = await dbMod.db.kv.toArray();
    return {
      article: kv.filter((r) => r.key.startsWith('atext:')).length,
      summaries: kv.filter((r) => r.key.startsWith('sum:')).length,
      saved: await dbMod.db.saved.count(),
      hidden: await dbMod.db.hidden.count(),
    };
  });

// open Settings → Data section
await page.getByRole('button', { name: 'Settings & models' }).click();
await page.getByText('For You ranking weights').waitFor({ timeout: 10000 });
await page.getByText('Fetched article text').first().waitFor({ timeout: 10000 });

const bodyText = () => page.evaluate(() => document.body.innerText);
let txt = await bodyText();
check('data breakdown shows fetched article text count', /Fetched article text/.test(txt) && /2 articles/.test(txt), 'expected 2 articles');
check('data breakdown shows saved stories count', /Saved stories/.test(txt) && /2 saved/.test(txt), 'expected 2 saved');

const before = await counts();
check('seed is present (2 articles, 2 saved)', before.article === 2 && before.saved === 2, JSON.stringify(before));

// Delete ONLY the fetched article text.
await page.getByRole('button', { name: 'Delete Fetched article text' }).click();
await page.waitForTimeout(500);

const after = await counts();
check('deleting article text removes it', after.article === 0, JSON.stringify(after));
check('deleting article text KEEPS saved stories', after.saved === 2, `saved=${after.saved}`);
check('deleting article text KEEPS the summary', after.summaries === 1, `summaries=${after.summaries}`);
check('deleting article text KEEPS hidden', after.hidden === 1, `hidden=${after.hidden}`);

txt = await bodyText();
check('the article row now shows empty', /Fetched article text[\s\S]{0,80}none/i.test(txt), 'expected "none"');

// The saved-stories Delete button is still enabled (still has data).
const savedDeletable = await page.getByRole('button', { name: 'Delete Saved stories' }).isEnabled();
check('saved stories can still be deleted separately', savedDeletable);

// The "N interaction signals recorded" text must be CLICKABLE and reveal the actual
// signals (not a dead-end stat). A user seeing a count wants to know what's in it.
const signalsBtn = page.getByRole('button', { name: /interaction signals recorded/i });
check('the signals count is a clickable control (not dead text)', await signalsBtn.isVisible().catch(() => false));
await signalsBtn.click();
await page.waitForTimeout(300);
const dlgText = await page.evaluate(
  () => [...document.querySelectorAll('[role="dialog"]')].find((d) => /Signals recorded locally/i.test(d.textContent || ''))?.textContent ?? ''
);
check('clicking it opens a dialog listing the actual signals', /Signals recorded locally/i.test(dlgText));
check('the signals dialog shows real event types + item links', /Opened article/.test(dlgText) && /Saved/.test(dlgText) && /#101/.test(dlgText), dlgText.replace(/\s+/g, ' ').slice(0, 100));

await b.close();
console.log(`\n${fails.length === 0 ? 'RESULT: DATA MANAGEMENT PASS \u2713' : `RESULT: ${fails.length} FAILED`}`);
process.exit(fails.length ? 1 : 0);
