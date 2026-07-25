// Verify every Settings/sidebar control actually writes its value to the store
// (i.e. changing a setting in the UI takes effect and will therefore persist).
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:4173/';
const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ viewport: { width: 1280, height: 1000 } });
const page = ctx.pages()[0] || (await ctx.newPage());
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__hnlens && window.__hnlens.prefs, null, { timeout: 20000 });

const get = (k) => page.evaluate((k) => window.__hnlens.prefs.getState()[k], k);
const results = [];
const check = async (name, field, expected) => {
  const got = await get(field);
  const pass = JSON.stringify(got) === JSON.stringify(expected);
  results.push({ name, pass, got, expected });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}  (${field} = ${JSON.stringify(got)})`);
};
const checkRaw = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

await page.getByRole('button', { name: 'Settings & models' }).click();
await page.getByText('For You ranking weights').waitFor({ timeout: 10000 });

// selects
await page.getByRole('combobox', { name: 'Theme design (palette + typography)' }).selectOption('nord');
await check('Theme design select', 'themeName', 'nord');
await page.getByRole('combobox', { name: 'Layout (structure)' }).selectOption('compact');
await check('Layout select', 'layout', 'compact');
await page.getByRole('combobox', { name: 'Light / dark mode' }).selectOption('dark');
await check('Light/dark mode select', 'theme', 'dark');
await page.getByRole('combobox', { name: 'Reading text size' }).selectOption('lg');
await check('Reading text size select', 'textSize', 'lg');
// Effect (not just the store): the reading-size axis sets data-textsize on <html> and
// actually scales the root font-size.
const tsDom = await page.evaluate(() => ({
  attr: document.documentElement.dataset.textsize,
  rootPx: parseFloat(getComputedStyle(document.documentElement).fontSize),
}));
await checkRaw('Reading text size applies to the DOM (data-textsize=lg, root font grows)', tsDom.attr === 'lg' && tsDom.rootPx > 16, JSON.stringify(tsDom));
await page.getByRole('combobox', { name: 'Default feed' }).selectOption('new');
await check('Default feed select', 'defaultFeed', 'new');
await page.getByRole('combobox', { name: 'Embedding model' }).selectOption('Xenova/bge-small-en-v1.5');
await check('Embedding model select', 'embeddingModel', 'Xenova/bge-small-en-v1.5');

// toggles (defaults: useLearnedRanker true, embeddingsEnabled false, llmEnabled false, showAiSummaries true)
await page.getByRole('switch', { name: 'Use learned reranker in For You' }).click();
await check('Learned-reranker toggle', 'useLearnedRanker', false);
await page.getByRole('switch', { name: 'Enable embeddings' }).click();
await check('Embeddings toggle', 'embeddingsEnabled', true);
await page.getByRole('switch', { name: 'Enable on-device model' }).click();
await check('LLM toggle', 'llmEnabled', true);
await page.getByRole('switch', { name: 'Show AI summary controls in comments' }).click();
await check('AI-summaries toggle', 'showAiSummaries', false);
await page.getByRole('switch', { name: 'Fetch linked-article text (free reader services)' }).click();
await check('Reader-article toggle', 'fetchArticleText', true);
await page.getByRole('switch', { name: /Load story favicons/ }).click();
await check('Remote-favicons toggle', 'remoteFavicons', false);

// AI provider picker + BYO API key (selecting a cloud provider swaps the local controls
// for a key input — so test it AFTER the on-device toggle above).
await page.getByRole('combobox', { name: 'AI provider' }).selectOption('gemini');
await check('AI provider select', 'llmProvider', 'gemini');
await page.getByPlaceholder('AIza…').fill('test-gemini-key');
const apiKeys = await get('apiKeys');
const keyPass = apiKeys?.gemini === 'test-gemini-key';
results.push({ name: 'Cloud API key input', pass: keyPass });
console.log(`${keyPass ? 'PASS' : 'FAIL'}  Cloud API key input  (apiKeys.gemini = ${JSON.stringify(apiKeys?.gemini)})`);

// weight slider (Popularity default 1.0 -> ArrowLeft lowers)
const pop = page.getByRole('slider', { name: 'Popularity (HN score)' });
await pop.focus();
await page.keyboard.press('ArrowLeft');
const w = await get('weights');
results.push({ name: 'Weight slider (popularity)', pass: w.popularity < 1.0, got: w.popularity });
console.log(`${w.popularity < 1.0 ? 'PASS' : 'FAIL'}  Weight slider (popularity) (= ${w.popularity})`);

// minPoints slider (default 0 -> ArrowRight raises)
const mp = page.getByRole('slider', { name: /Minimum points/ });
await mp.focus();
await page.keyboard.press('ArrowRight');
const minPoints = await get('minPoints');
results.push({ name: 'minPoints slider', pass: minPoints > 0, got: minPoints });
console.log(`${minPoints > 0 ? 'PASS' : 'FAIL'}  minPoints slider (= ${minPoints})`);

// tag editors
const tags = [
  ['Boost keywords (in title)', 'keywordsBoost', 'rust'],
  ['Mute keywords', 'keywordsMute', 'crypto'],
  ['Followed domains', 'followedDomains', 'github.com'],
  ['Muted domains', 'mutedDomains', 'example.com'],
  ['Followed users', 'followedUsers', 'pg'],
  ['Muted users', 'mutedUsers', 'spammer'],
];
for (const [label, field, val] of tags) {
  const input = page.getByRole('textbox', { name: label });
  await input.fill(val);
  await input.press('Enter');
  await page.waitForTimeout(80);
  const arr = await get(field);
  const pass = Array.isArray(arr) && arr.includes(val);
  results.push({ name: `TagEditor ${label}`, pass, got: arr });
  console.log(`${pass ? 'PASS' : 'FAIL'}  TagEditor ${label} (= ${JSON.stringify(arr)})`);
}

// The control checks above set filters (minPoints=5, mutes) + defaultFeed=new, and
// they're already verified. Reset them before loading a feed: global filtering now
// applies to EVERY feed, and "new" stories are often below 5 points, which would
// empty the feed and make the sidebar/topnav checks below flaky. Use Top (high
// scores) with no filters so the feed reliably populates.
await page.evaluate(() =>
  window.__hnlens.prefs.getState().set({ minPoints: 0, mutedDomains: [], mutedUsers: [], keywordsMute: [], defaultFeed: 'top' })
);

// sidebar: HN username (go home, lg viewport shows sidebar)
await page.getByRole('link', { name: 'HN Lens' }).click();
await page.waitForSelector('article', { timeout: 40000 });
const uname = page.getByPlaceholder('HN username');
if (await uname.count()) {
  await uname.fill('wiretest');
  await page.getByRole('button', { name: 'Connect' }).click();
  await page.waitForTimeout(200);
  await check('HN username (sidebar)', 'hnUsername', 'wiretest');
}

// TopNav theme control toggles light <-> dark
const before = await get('theme');
await page.getByRole('button', { name: /mode$/ }).first().click();
const after = await get('theme');
const pass = after !== before;
results.push({ name: 'TopNav theme toggle', pass, got: after });
console.log(`${pass ? 'PASS' : 'FAIL'}  TopNav theme cycle (${before} -> ${after})`);

// Back to Settings for the reset controls (the HN-username step is on the feed).
await page.getByRole('button', { name: 'Settings & models' }).click();
await page.getByText('For You ranking weights').waitFor({ timeout: 10000 });

// "Reset to defaults" (weights) actually restores the default weights (#8)
await page.evaluate(() => window.__hnlens.prefs.getState().setWeights({ popularity: 0.1, recency: 0.1 }));
await page.getByRole('button', { name: 'Reset to defaults' }).click();
await page.waitForTimeout(150);
const wr = await get('weights');
const wReset = wr.popularity !== 0.1 && wr.recency !== 0.1;
results.push({ name: 'Reset weights to defaults', pass: wReset, got: wr });
console.log(`${wReset ? 'PASS' : 'FAIL'}  Reset weights to defaults (popularity=${wr.popularity})`);

// "Reset all settings" (prefs.reset) restores defaults (#9) — behind a confirm()
page.on('dialog', (d) => d.accept());
// Change the STORE and the live DOM axes (design/mode/layout), then reset and assert
// BOTH revert — including the DOM, not just the store (the reset-appearance bug).
await page.evaluate(() => {
  const s = window.__hnlens.prefs.getState();
  s.set({ minPoints: 77, defaultFeed: 'new' });
  s.setThemeName('dracula');
  s.setTheme('dark');
  s.setLayout('zen');
  s.setTextSize('lg');
});
await page.waitForTimeout(100);
const domBefore = await page.evaluate(() => ({
  theme: document.documentElement.dataset.theme,
  dark: document.documentElement.classList.contains('dark'),
  layout: document.documentElement.dataset.layout,
  textsize: document.documentElement.dataset.textsize,
}));
await page.getByRole('button', { name: /Reset all settings/i }).click();
await page.waitForTimeout(200);
const mpR = await get('minPoints');
const dfR = await get('defaultFeed');
const allReset = mpR === 0 && dfR === 'foryou';
results.push({ name: 'Reset all settings (store)', pass: allReset, got: { minPoints: mpR, defaultFeed: dfR } });
console.log(`${allReset ? 'PASS' : 'FAIL'}  Reset all settings store (minPoints=${mpR}, defaultFeed=${dfR})`);
// The live appearance must revert WITHOUT a reload (reset re-applies theme/design/layout).
const domAfter = await page.evaluate(() => ({
  theme: document.documentElement.dataset.theme,
  dark: document.documentElement.classList.contains('dark'),
  layout: document.documentElement.dataset.layout,
  textsize: document.documentElement.dataset.textsize,
}));
const domReverted =
  domBefore.theme === 'dracula' && domBefore.dark && domBefore.layout === 'zen' && domBefore.textsize === 'lg' &&
  domAfter.theme !== 'dracula' && !domAfter.dark && domAfter.layout !== 'zen' && domAfter.textsize === 'md';
results.push({ name: 'Reset all settings reverts the live DOM', pass: domReverted, got: { domBefore, domAfter } });
console.log(`${domReverted ? 'PASS' : 'FAIL'}  Reset reverts DOM (theme ${domBefore.theme}->${domAfter.theme}, dark ${domBefore.dark}->${domAfter.dark}, layout ${domBefore.layout}->${domAfter.layout})`);

await b.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length} controls tested, ${failed.length} failed.`);
process.exit(failed.length ? 1 : 0);
