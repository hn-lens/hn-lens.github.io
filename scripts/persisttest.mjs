// Systematic persistence audit: change every setting, then verify it survives
// (a) a page refresh and (b) closing & reopening the browser (persistent profile).
// Also checks IndexedDB-backed local data (saved / hidden).
import { chromium } from 'playwright';
import { rmSync } from 'node:fs';

const BASE = process.env.BASE || 'http://localhost:4173/';
const DIR = '/tmp/hnlens-persist-test';
rmSync(DIR, { recursive: true, force: true }); // start clean

const EXPECT = {
  theme: 'dark',
  themeName: 'nord',
  layout: 'magazine',
  defaultFeed: 'top',
  weights: { popularity: 0.3, recency: 2.1, discussion: 1.9, affinity: 0.2, relevance: 2.4, learned: 0.1 },
  followedDomains: ['github.com', 'arxiv.org'],
  mutedDomains: ['example.com'],
  followedUsers: ['pg', 'dang'],
  mutedUsers: ['spammer'],
  keywordsBoost: ['rust', 'llm'],
  keywordsMute: ['crypto'],
  minPoints: 75,
  showAiSummaries: false,
  embeddingsEnabled: true,
  embeddingModel: 'Xenova/bge-small-en-v1.5',
  llmEnabled: true,
  llmModel: 'Llama-3.2-1B-Instruct-q4f16_1-MLC',
  useLearnedRanker: false,
  hnUsername: 'testuser',
  fetchArticleText: true,
  remoteFavicons: false,
};
const KEYS = Object.keys(EXPECT);

let launch = async () =>
  chromium.launchPersistentContext(DIR, { headless: true, viewport: { width: 1200, height: 900 } });

async function open() {
  const ctx = await launch();
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__hnlens && window.__hnlens.prefs, null, { timeout: 20000 });
  return { ctx, page };
}
const readPrefs = (page) =>
  page.evaluate((keys) => {
    const s = window.__hnlens.prefs.getState();
    const o = {};
    for (const k of keys) o[k] = s[k];
    return o;
  }, KEYS);

function diff(actual, label) {
  const fails = [];
  for (const k of KEYS) {
    if (JSON.stringify(actual[k]) !== JSON.stringify(EXPECT[k])) {
      fails.push(`  ✗ ${k}: got ${JSON.stringify(actual[k])} expected ${JSON.stringify(EXPECT[k])}`);
    }
  }
  console.log(`\n[${label}] ${fails.length === 0 ? `ALL ${KEYS.length} PERSISTED ✓` : fails.length + ' FAILED'}`);
  fails.forEach((f) => console.log(f));
  return fails.length === 0;
}

let ok = true;

// ---- 1. change every setting ----
let { ctx, page } = await open();
await page.evaluate((e) => {
  const st = window.__hnlens.prefs.getState();
  const { theme, ...rest } = e;
  st.set(rest);
  st.setTheme(theme);
}, EXPECT);
await page.waitForTimeout(300);

// partialize completeness: every key present in the persisted blob
const persistedKeys = await page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('hn:prefs')).state));
const missing = KEYS.filter((k) => !persistedKeys.includes(k));
console.log('persisted keys:', persistedKeys.length, missing.length ? 'MISSING: ' + missing : '(all present ✓)');
if (missing.length) ok = false;

ok = diff(await readPrefs(page), 'immediately after set') && ok;

// ---- 2. refresh ----
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__hnlens && window.__hnlens.prefs, null, { timeout: 20000 });
await page.waitForTimeout(400); // allow migration microtask
ok = diff(await readPrefs(page), 'after REFRESH') && ok;
const themeAfterReload = await page.evaluate(() => document.documentElement.classList.contains('dark'));
console.log('  theme applied to <html> after refresh:', themeAfterReload ? 'dark ✓' : 'NOT dark ✗');
if (!themeAfterReload) ok = false;

// ---- 3. save + hide (IndexedDB local data) ----
await page.getByRole('button', { name: 'Top', exact: true }).first().click().catch(() => {});
await page.waitForSelector('article', { timeout: 40000 });
// A card action is INLINE when the card is wide enough, else it overflows into the "..." menu — and
// the persisted `magazine` layout renders non-hero cards as NARROW grid columns, so their actions
// overflow. Click the inline control if visible, else open the menu and use the menu item.
const clickCardAction = async (cardLoc, label) => {
  const inline = cardLoc.getByRole('button', { name: label, exact: true });
  if (await inline.isVisible().catch(() => false)) {
    await inline.click();
    return;
  }
  await cardLoc.getByRole('button', { name: 'More actions' }).click();
  await page.waitForTimeout(200);
  await page.getByRole('menuitem', { name: label }).first().click();
};
const firstTitle = (await page.locator('article h3').first().innerText()).trim();
await clickCardAction(page.locator('article').first(), 'Save');
const secondTitle = (await page.locator('article h3').nth(1).innerText()).trim();
await clickCardAction(page.locator('article').nth(1), 'Not interested');
await page.waitForTimeout(500);

// ---- 4. close & reopen ----
await ctx.close();
({ ctx, page } = await open());
await page.waitForTimeout(500);
ok = diff(await readPrefs(page), 'after CLOSE & REOPEN') && ok;

// verify saved persisted
await page.getByRole('banner').getByRole('button', { name: 'Saved items' }).click();
await page.waitForTimeout(800);
const savedTitles = await page.$$eval('article h3', (els) => els.map((e) => e.textContent.trim()));
const savedOk = savedTitles.includes(firstTitle);
console.log('\n[local data] saved item present after reopen:', savedOk ? '✓' : `✗ (looking for "${firstTitle}")`);
if (!savedOk) ok = false;

// verify hidden persisted (hidden title should NOT appear on Top)
await page.getByRole('button', { name: 'Top', exact: true }).first().click().catch(() => {});
await page.waitForSelector('article', { timeout: 40000 });
await page.waitForTimeout(500);
const topTitles = await page.$$eval('article h3', (els) => els.map((e) => e.textContent.trim()));
const hiddenOk = !topTitles.includes(secondTitle);
console.log('[local data] hidden item stays hidden after reopen:', hiddenOk ? '✓' : `✗ ("${secondTitle}" reappeared)`);
if (!hiddenOk) ok = false;

await ctx.close();
console.log('\n==================================================');
console.log(ok ? 'RESULT: ALL PERSISTENCE CHECKS PASSED ✓' : 'RESULT: SOME CHECKS FAILED ✗');
process.exit(ok ? 0 : 1);
