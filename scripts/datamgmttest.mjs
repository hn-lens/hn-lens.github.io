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
  // Orphan-prone caches (bug LOW-1): a per-user PERSONA summary (usersum:, NOT sum:), the derived
  // article-terms memo (aterms:, must be purged WITH article text or it keeps feeding ranking), and
  // the comment caches (topc:/cterms:). Pre-fix these survived their category's delete.
  await dbMod.kvSet('usersum:alice:v7', { text: 'a persona summary', sources: {} });
  await dbMod.kvSet('aterms:1', ['alpha', 'beta', 'gamma']);
  await dbMod.kvSet('topc:9', [{ by: 'x', text: 'top comment preview' }]);
  await dbMod.kvSet('cterms:9', ['comment', 'terms', 'memo']);
  await dbMod.db.saved.bulkPut([
    { id: 11, item: { id: 11, title: 'Saved A' }, ts: t },
    { id: 12, item: { id: 12, title: 'Saved B' }, ts: t },
  ]);
  await dbMod.db.hidden.put({ id: 21, ts: t });
  // Interaction signals (for the "N signals recorded — view" viewer).
  await dbMod.db.events.bulkAdd([
    { type: 'open_link', itemId: 101, domain: 'news.ycombinator.com', author: 'patio11', ts: t * 1000 },
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
      usersum: kv.filter((r) => r.key.startsWith('usersum:')).length,
      aterms: kv.filter((r) => r.key.startsWith('aterms:')).length,
      cacheKv: kv.filter((r) => r.key.startsWith('topc:') || r.key.startsWith('cterms:')).length,
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
check('AI summaries count includes persona (usersum:) summaries', /AI summaries/.test(txt) && /2 summaries/.test(txt), 'expected 2 summaries (sum + usersum)');

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
check('deleting article text ALSO purges the derived aterms: memo (bug LOW-1)', after.aterms === 0, JSON.stringify(after));

txt = await bodyText();
check('the article row now shows empty', /Fetched article text[\s\S]{0,80}none/i.test(txt), 'expected "none"');

// The saved-stories Delete button is still enabled (still has data).
const savedDeletable = await page.getByRole('button', { name: 'Delete Saved stories' }).isEnabled();
check('saved stories can still be deleted separately', savedDeletable);

// bug LOW-1: "Delete AI summaries" must remove persona summaries (usersum:) too, and deleting the
// cache category must remove the topc:/cterms: kv caches — else the per-type delete silently leaves
// data the user believes they purged (and aterms:/usersum: keep feeding ranking / show stale counts).
await page.getByRole('button', { name: 'Delete AI summaries' }).click();
await page.waitForTimeout(400);
const afterSum = await counts();
check('deleting AI summaries removes BOTH sum: and usersum: (persona)', afterSum.summaries === 0 && afterSum.usersum === 0, JSON.stringify(afterSum));
await page.getByRole('button', { name: 'Delete Cached stories & lists' }).click();
await page.waitForTimeout(400);
const afterCache = await counts();
check('deleting cached stories also purges topc:/cterms: kv caches', afterCache.cacheKv === 0, JSON.stringify(afterCache));

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

// Regression (c2r3): the signals dialog must fit a PHONE viewport. Its card lacked `min-w-0`, so
// on a 320px screen its automatic min-content overflowed — clipping rows and pushing the close (X)
// OFF-screen (and it wasn't even scroll-reachable). Resize the open dialog and assert it fits.
await page.setViewportSize({ width: 320, height: 720 });
await page.waitForTimeout(250);
const fit = await page.evaluate(() => {
  const dlg = [...document.querySelectorAll('[role="dialog"]')].find((d) => /Signals recorded locally/i.test(d.textContent || ''));
  const card = dlg?.firstElementChild;
  const closeBtn = dlg?.querySelector('button[aria-label="Close"]');
  const vw = window.innerWidth;
  const cardR = card?.getBoundingClientRect();
  const btnR = closeBtn?.getBoundingClientRect();
  return {
    vw,
    cardRight: cardR ? Math.round(cardR.right) : null,
    cardLeft: cardR ? Math.round(cardR.left) : null,
    closeInView: btnR ? btnR.right <= vw + 1 && btnR.left >= -1 : false,
    pageOver: Math.max(0, document.documentElement.scrollWidth - vw),
  };
});
check('signals dialog card fits a 320px viewport', fit.cardRight !== null && fit.cardRight <= fit.vw + 1 && fit.cardLeft >= -1, JSON.stringify(fit));
check('signals dialog close (X) stays on-screen at 320px', fit.closeInView, JSON.stringify(fit));
check('signals dialog causes no horizontal page overflow at 320px', fit.pageOver <= 1, `over=${fit.pageOver}`);

await b.close();
console.log(`\n${fails.length === 0 ? 'RESULT: DATA MANAGEMENT PASS \u2713' : `RESULT: ${fails.length} FAILED`}`);
process.exit(fails.length ? 1 : 0);
