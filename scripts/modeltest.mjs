import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:4173/';
const OUT = '/tmp/uitest';
const LLM_MODEL_ID = process.env.LLM_ID || 'Llama-3.2-1B-Instruct-q4f16_1-MLC'; // the only catalog model (SmolLM2/Qwen were rejected + removed)
const errors = [];

const browser = await chromium.launch({
  headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=metal'],
});
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1300 } });
const page = await ctx.newPage();

page.on('console', (m) => {
  if (m.type() !== 'error') return;
  const u = m.location()?.url || '';
  if (/favicons|gstatic|google\.com\/s2/.test(u)) return;
  errors.push(m.text());
});
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));

const log = (...a) => console.log(...a);
async function snap(name) {
  await page.screenshot({ path: `${OUT}/model-${name}.png` });
}

// Detect degenerate LLM output (repetition loops, backtick spam, low lexical variety).
function looksDegenerate(text) {
  const body = text.replace(/^(TL;DR|AI discussion summary)/i, '').trim();
  if (/(`{2,}\s*){4,}/.test(body)) return 'backtick spam';
  const words = body.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length >= 15) {
    const uniq = new Set(words).size / words.length;
    if (uniq < 0.4) return `low lexical variety (${uniq.toFixed(2)})`;
  }
  return null;
}

// Initial load, then navigate everywhere client-side to preserve loaded engines.
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('article', { timeout: 40000 });
await page.getByRole('button', { name: 'Settings & models' }).click();
await page.getByText('For You ranking weights').waitFor({ timeout: 10000 });

// ---------- EMBEDDINGS (Transformers.js, WASM/WebGPU) ----------
log('\n== Embeddings ==');
const emb = page.locator('section', { hasText: 'Embeddings (Transformers.js)' });
await emb.getByRole('switch', { name: 'Enable embeddings' }).click();
await emb.getByRole('button', { name: /Load \/ test model/ }).click();
await emb.getByText(/ready|error/i).waitFor({ timeout: 180000 });
const embStatus = (await emb.getByText(/ready|error/i).first().innerText()).trim();
log('embeddings status:', embStatus);
await snap('embeddings');
if (/error/i.test(embStatus)) errors.push('EMBEDDINGS: ' + embStatus);

// ---------- LLM (WebLLM, WebGPU) ----------
log('\n== LLM ==');
const llm = page.locator('section', { hasText: 'Local LLM (WebLLM)' });
await llm.getByRole('switch', { name: 'Enable local LLM' }).click();
await llm.getByRole('combobox').selectOption(LLM_MODEL_ID);
await llm.getByRole('button', { name: 'Load model' }).click();
log('loading LLM (downloading weights)…');

// Poll status until ready/error, printing progress.
let llmStatus = '';
const deadline = Date.now() + 600000; // 10 min
while (Date.now() < deadline) {
  llmStatus = (await llm.getByText(/loading|ready|error|unsupported|%/i).first().innerText().catch(() => '')).trim();
  if (/window|WindowSizeConfigurationError/i.test(llmStatus)) throw new Error('LLM config error: ' + llmStatus);
  if (/\bready\b/i.test(llmStatus)) break;
  if (/error|unsupported/i.test(llmStatus)) throw new Error('LLM load failed: ' + llmStatus);
  await page.waitForTimeout(4000);
}
log('LLM status:', llmStatus);
await snap('llm-loaded');
if (!/\bready\b/i.test(llmStatus)) throw new Error('LLM did not reach ready: ' + llmStatus);

// ---------- TL;DR on a card (client-side nav to preserve engine) ----------
log('\n== TL;DR ==');
await page.getByRole('link', { name: 'HN Lens' }).click();
await page.waitForSelector('article', { timeout: 40000 });
const card = page.locator('article').first();
await card.getByRole('button', { name: /TL;DR/i }).click();
// A loading STATUS INDICATOR (spinner) must show while generating — not bare text.
const tldrSpinner = await card
  .locator('.sc-tldr .animate-spin')
  .first()
  .waitFor({ state: 'visible', timeout: 8000 })
  .then(() => true)
  .catch(() => false);
if (!tldrSpinner) errors.push('TLDR: no loading spinner/status shown while summarizing');
// TL;DR paragraph shows a "TL;DR" label then streams text.
await card.getByText('TL;DR').waitFor({ timeout: 120000 });
await page.waitForTimeout(12000); // let it stream
const cardText = (await card.innerText()).replace(/\s+/g, ' ');
const tldrIdx = cardText.indexOf('TL;DR');
const tldrOut = cardText.slice(tldrIdx, tldrIdx + 260);
log('TL;DR output:', tldrOut);
await snap('tldr');
if (tldrOut.length < 20 || /Could not generate/i.test(tldrOut)) errors.push('TLDR empty/failed: ' + tldrOut);
else {
  const deg = looksDegenerate(tldrOut);
  if (deg) errors.push('TLDR degenerate (' + deg + '): ' + tldrOut);
}
// REGRESSION: summarizing (clicking the TL;DR button) must NOT mark the item read.
// Nothing has been opened in this run yet, so read state must still be empty.
const readAfterTldr = await page.evaluate(async () => {
  const i = await window.__hnlens.interactions();
  return i.getReadItemIds(50);
});
log('read ids after TL;DR:', JSON.stringify(readAfterTldr));
if (readAfterTldr.length) errors.push('TLDR marked an item READ (summarizing ≠ reading): ' + JSON.stringify(readAfterTldr));

// #1: when article text was extracted, the card TL;DR offers a "view extracted
// article text" viewer. Seed the cache with articleText (deterministic), reopen
// the TL;DR (cache hit), and assert the viewer shows the extracted text.
const firstId = await card.getAttribute('data-id');
await page.evaluate(
  async ([id, m]) => {
    const llm = await window.__hnlens.llm();
    const dbMod = await window.__hnlens.db();
    await dbMod.kvSet(llm.summaryCacheKey('tldr', Number(id), m, false), {
      text: 'Cached summary sentence.',
      sources: { articleWords: 1200, comments: 5, selftext: false, articleAvailable: false },
      articleText: 'EXTRACTED_ARTICLE_BODY_MARKER full text of the linked article for the viewer test.',
    });
  },
  [firstId, LLM_MODEL_ID]
);
await card.getByRole('button', { name: /TL;DR/i }).click(); // close the open TL;DR
await card.getByRole('button', { name: /TL;DR/i }).click(); // reopen → cache hit (with articleText)
await page.waitForTimeout(1500);
// #1: the article-text link is at TITLE level (the card meta row), not inside the summary.
const viewBtn = card.getByRole('button', { name: /Article text/i });
if (!(await viewBtn.count())) errors.push('#1: no title-level "Article text" link when article text present');
else {
  await viewBtn.click();
  await page.waitForTimeout(400);
  if (!(await page.getByText(/EXTRACTED_ARTICLE_BODY_MARKER/).count()))
    errors.push('#1: extracted article text not shown in the overlay');
  await page.getByRole('button', { name: 'Close' }).click().catch(() => {}); // close the overlay
  await page.waitForTimeout(200);
}

// ---------- Thread summary in comments ----------
log('\n== Thread summary ==');
await card.getByRole('button', { name: 'Open comments' }).click();
await page.getByText(/comments/i).first().waitFor({ timeout: 40000 });
await page.getByRole('button', { name: 'Summarize' }).click();
await page.waitForTimeout(20000);
await snap('summary');
const drawer = page.locator('aside').last(); // sidebar + drawer both exist; drawer is last
const drawerText = (await drawer.innerText()).replace(/\s+/g, ' ');
const sumIdx = drawerText.indexOf('AI discussion summary');
const sumOut = drawerText.slice(sumIdx, sumIdx + 400);
log('summary output:', sumOut);
if (sumOut.length < 40 || /Could not summarize/i.test(sumOut)) errors.push('SUMMARY empty/failed');
else {
  const deg = looksDegenerate(sumOut);
  if (deg) errors.push('SUMMARY degenerate (' + deg + '): ' + sumOut);
}

// ---------- CONCURRENCY: a card TL;DR + a thread summary fired together must NOT
// deadlock the single WebLLM engine (the "stuck at Summarizing…" bug). Uses a
// FRESH card (index 1) so both are real generations, not cache hits. ----------
log('\n== Concurrency (serialized generation) ==');
await page.keyboard.press('Escape'); // close the drawer left open by the previous step
await page.waitForTimeout(500);
await page.getByRole('link', { name: 'HN Lens' }).click();
await page.waitForSelector('article', { timeout: 40000 });
const c2 = page.locator('article').nth(1);
await c2.getByRole('button', { name: /TL;DR/i }).click(); // generation #1 (streaming)
await c2.getByRole('button', { name: 'Open comments' }).click(); // open the same story's thread
await page.getByText(/comments/i).first().waitFor({ timeout: 40000 });
await page.getByRole('button', { name: 'Summarize' }).click(); // generation #2, fired while #1 runs
await page.waitForTimeout(75000); // serialized: both should finish within ~a minute
const c2tl = (await c2.locator('.sc-tldr').innerText().catch(() => '')).replace(/\s+/g, ' ');
const drawer2 = page.locator('aside').last();
const d2 = (await drawer2.innerText()).replace(/\s+/g, ' ');
const sum2 = d2.slice(d2.indexOf('AI discussion summary'), d2.indexOf('AI discussion summary') + 400);
log('concurrency TL;DR:', c2tl.slice(0, 120));
log('concurrency summary:', sum2.slice(0, 120));
if (!(c2tl.length > 25) || /Summarizing…\s*$/.test(c2tl) || /Could not/i.test(c2tl))
  errors.push('CONCURRENCY: card TL;DR stuck/empty: ' + c2tl.slice(0, 140));
if (!(sum2.length > 60) || /Could not/i.test(sum2))
  errors.push('CONCURRENCY: thread summary stuck/empty: ' + sum2.slice(0, 140));

await browser.close();
log('\n===== MODEL TEST DONE =====');
log('errors:', errors.length);
for (const e of errors.slice(0, 10)) log('  - ' + e);
process.exit(errors.length ? 1 : 0);
