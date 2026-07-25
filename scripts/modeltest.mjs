import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:4173/';
const OUT = '/tmp/uitest';
const LLM_MODEL_ID = process.env.LLM_ID || 'Llama-3.2-1B-Instruct-q4f16_1-MLC'; // the only catalog model (SmolLM2/Qwen were rejected + removed)
const errors = [];

/** Set a switch to a desired state, tolerating a profile where it is already there. */
async function setSwitch(locator, want) {
  await locator.waitFor({ timeout: 15000 });
  const isOn = (await locator.getAttribute('aria-checked')) === 'true';
  if (isOn !== want) await locator.click();
}

// Summaries are CACHED in IndexedDB, and this tier runs against a PERSISTENT browser profile (it
// needs a real WebGPU adapter, so it attaches to a long-lived browser rather than a throwaway
// context). That combination silently guts the tier's whole purpose: on the second run every
// "is the generated text degenerate?" assertion is graded against a string cached by the FIRST
// run, so no generation actually happens and the check passes vacuously.
//
// INVARIANT (asserted, not assumed — see the callers): before any generation-quality assertion,
// the summary cache for the item under test must be EMPTY, so the text being graded came from a
// real model call in THIS run.
/**
 * Wait until a card has stopped moving before clicking anything inside it.
 *
 * The inline top-comment preview is fetched lazily per card, and when it lands the card grows and
 * pushes its action row DOWN. Playwright's own "visible, enabled and stable" gate can pass just
 * before that reflow, so the click then hit-tests against the preview paragraph that has moved into
 * the button's old position — reported as "<p class='line-clamp-2 …'> … intercepts pointer events",
 * retried ~130 times, then failed at 30s. It reads exactly like a z-index defect and is not one:
 * with the card settled, elementFromPoint at each action button's centre returns the button itself,
 * and there is an 8px gap between the preview and the row.
 */
async function waitForStableCard(locator, { samples = 3, gapMs = 350, timeout = 20000 } = {}) {
  const until = Date.now() + timeout;
  let stable = 0;
  let last = null;
  while (Date.now() < until) {
    const box = await locator.boundingBox().catch(() => null);
    const key = box ? `${Math.round(box.y)}x${Math.round(box.height)}` : 'none';
    stable = key !== 'none' && key === last ? stable + 1 : 0;
    last = key;
    if (stable >= samples) return true;
    await locator.page().waitForTimeout(gapMs);
  }
  return false;
}

async function clearSummaryCache(page, itemId) {
  return page.evaluate(async (id) => {
    const dbMod = await window.__hnlens.db();
    const keys = (await dbMod.db.kv.toArray())
      .map((r) => r.key)
      .filter((k) => typeof k === 'string' && k.startsWith('sum:') && k.includes(`:${id}:`));
    for (const k of keys) await dbMod.db.kv.delete(k);
    const left = (await dbMod.db.kv.toArray())
      .map((r) => r.key)
      .filter((k) => typeof k === 'string' && k.startsWith('sum:') && k.includes(`:${id}:`));
    return { cleared: keys, left };
  }, itemId);
}

// These tests need a REAL WebGPU adapter. Headless CI has none, so they are skipped there. Set
// CDP_URL to point at an already-running browser that does have one (any machine, launched with
// --remote-debugging-port); otherwise we launch locally as before.
const CDP_URL = process.env.CDP_URL || '';
// When we CONNECT to an existing browser (CDP) rather than launching one, that browser OUTLIVES this
// script — so any page we open is ours to clean up, and a crash mid-run strands a tab in someone's
// real window. (With chromium.launch() the browser dies with the process and this never comes up,
// which is exactly why it is easy to miss.) Register cleanup up-front rather than only at the end.
let cleanup = async () => {};
// WATCHDOG. Every await below is unbounded, and when we are attached over CDP the browser outlives
// this process — so a step that never settles (a wedged GPU generation, a dead tunnel) hangs
// forever, prints nothing, and strands a tab in the user's real browser. Observed exactly that:
// the run vanished during the concurrency step with an empty log and left an /item tab open.
// Cap the whole run, and say WHICH step we were on when the cap hit.
let currentStep = 'startup';
const WATCHDOG_MS = Number(process.env.WATCHDOG_MS || 1500000); // 25 min
const watchdog = setTimeout(() => {
  console.error(`WATCHDOG: no completion after ${Math.round(WATCHDOG_MS / 1000)}s during step "${currentStep}" — cleaning up.`);
  void cleanup().finally(() => process.exit(1));
}, WATCHDOG_MS);
watchdog.unref(); // never keep the process alive just for the timer
for (const sig of ['SIGINT', 'SIGTERM', 'uncaughtException', 'unhandledRejection']) {
  // MUST await: firing an async close and then calling process.exit() synchronously kills the
  // process before the CDP close round-trips, so the tab survives anyway (observed).
  process.once(sig, async (e) => {
    await cleanup();
    if (e instanceof Error) console.error(e);
    process.exit(1);
  });
}
const browser = CDP_URL
  ? await chromium.connectOverCDP(CDP_URL)
  : await chromium.launch({
      headless: true,
      args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=metal'],
    });
const ctx = CDP_URL
  ? browser.contexts()[0] || (await browser.newContext())
  : await browser.newContext({ viewport: { width: 1440, height: 1300 } });
const page = await ctx.newPage();
// Close only what WE opened; never the user's other tabs, and never their browser.
cleanup = async () => { try { await page.close(); } catch { /* already gone */ } };

// Third-party endpoints the app calls BY DESIGN and is built to survive. A reader proxy returning
// 401/429/5xx is precisely the case the fallback chain exists for (article.ts tries the next one),
// and the favicon service failing just yields the letter monogram — neither is an app defect, and
// counting them made this run's pass/fail depend on someone else's uptime.
const THIRD_PARTY_OK = /favicons|gstatic|google\.com\/s2|allorigins|cors\.eu\.org|codetabs/i;
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  const u = m.location()?.url || '';
  if (THIRD_PARTY_OK.test(u)) return;
  // Record the URL as well: "Failed to load resource: … 401" with no origin is undiagnosable, and
  // that is exactly how the last unexplained failure arrived.
  errors.push(u ? `${m.text()} [${u}]` : m.text());
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
currentStep = 'embeddings';
const emb = page.locator('section', { hasText: 'Embeddings (Transformers.js)' });
// Idempotent: prefs PERSIST (localStorage), and this may run against a profile where the toggle is
// already on — an unconditional click would then turn the feature OFF and every later assertion
// would fail confusingly (observed: the TL;DR button simply stopped rendering).
await setSwitch(emb.getByRole('switch', { name: 'Enable embeddings' }), true);
await emb.getByRole('button', { name: /Load \/ test model/ }).click();
// Same element-not-prose targeting as the LLM poll below (see the note there).
const embStatusEl = emb.locator('[data-model-status]').first();
await embStatusEl.filter({ hasText: /ready|error/i }).waitFor({ timeout: 180000 });
const embStatus = (await embStatusEl.innerText()).trim();
log('embeddings status:', embStatus);
await snap('embeddings');
if (/error/i.test(embStatus)) errors.push('EMBEDDINGS: ' + embStatus);

// ---------- LLM (WebLLM, WebGPU) ----------
log('\n== LLM ==');
currentStep = 'llm-load';
// NOTE: this section was renamed when the BYO-cloud provider landed ("Local LLM (WebLLM)" ->
// "AI summaries", "Enable local LLM" -> "Enable on-device model"). This harness only runs where a
// real WebGPU adapter exists, so it is skipped in CI and the drift went unnoticed for a long time —
// if you rename these controls, update here too.
const llm = page.locator('section', { hasText: 'AI summaries' });
await setSwitch(llm.getByRole('switch', { name: 'Enable on-device model' }), true);
// Target the select by its CONTENT, not its position: this section gained a provider dropdown
// (local / cloud) and may show a cloud-model dropdown too, so nth-based selection is fragile.
const modelSelect = llm.locator(`select:has(option[value="${LLM_MODEL_ID}"])`).first();
await modelSelect.selectOption(LLM_MODEL_ID);
await llm.getByRole('button', { name: 'Load model' }).click();
log('loading LLM (downloading weights)…');

// Poll status until ready/error. This step can legitimately take minutes (a cold run downloads
// ~1GB of weights), so ECHO the status as it changes: a silent 10-minute wait is indistinguishable
// from a hang, and the previous version printed nothing until the loop had already finished.
let llmStatus = '';
let lastEcho = '';
const t0Llm = Date.now();
const deadline = t0Llm + 600000; // 10 min
// Read the status ELEMENT (data-model-status), not any text in the section that happens to contain
// one of these words: the privacy disclosure's "downloading AI model weights" matches /loading/,
// so with the reader-proxy toggle on the old getByText poll locked onto that paragraph and burned
// the entire 10-minute deadline before failing with a wall of privacy copy as the "LLM status".
const llmStatusEl = llm.locator('[data-model-status]').first();
while (Date.now() < deadline) {
  llmStatus = (await llmStatusEl.innerText().catch(() => '')).trim();
  if (llmStatus && llmStatus !== lastEcho) {
    log(`  [${Math.round((Date.now() - t0Llm) / 1000)}s] ${llmStatus.replace(/\s+/g, ' ').slice(0, 100)}`);
    lastEcho = llmStatus;
  }
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
currentStep = 'tldr';
await page.getByRole('link', { name: 'HN Lens' }).click();
await page.waitForSelector('article', { timeout: 40000 });
const card = page.locator('article').first();
const cardId = await card.getAttribute('data-id');
// Let the lazily-fetched top-comment preview land before clicking into the card (see
// waitForStableCard) — otherwise the reflow moves the action row out from under the click.
if (!(await waitForStableCard(card))) log('WARN: first card never settled; clicks may be flaky');
// Force a real generation (see clearSummaryCache): otherwise a prior run's cached summary is what
// gets graded below, and both the loading-indicator and the degeneracy checks become vacuous.
const tldrClear = await clearSummaryCache(page, cardId);
log('cleared summary cache for', cardId, '->', JSON.stringify(tldrClear));
if (tldrClear.left.length) errors.push('HARNESS: summary cache not empty before TL;DR: ' + JSON.stringify(tldrClear.left));
const readBeforeTldr = await page.evaluate(async () => (await window.__hnlens.interactions()).getReadItemIds(50));
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
// Assert the DELTA, not an absolute empty set: this may run against a profile that already has
// reading history (a previous run's thread-summary step legitimately reads a discussion), and
// asserting emptiness reported a false "summarizing marked it read" every time.
const readAfterTldr = await page.evaluate(async () => {
  const i = await window.__hnlens.interactions();
  return i.getReadItemIds(50);
});
const newlyRead = readAfterTldr.filter((id) => !readBeforeTldr.includes(id));
log('read ids after TL;DR:', JSON.stringify(readAfterTldr), '| newly read:', JSON.stringify(newlyRead));
if (newlyRead.length) errors.push('TLDR marked an item READ (summarizing ≠ reading): ' + JSON.stringify(newlyRead));

// #1: when a linked article's body has been extracted, the card surfaces a title-level
// "Article text" link that opens the extracted text in an overlay. Seed the ARTICLE cache
// (`atext:<id>` — the real store the card reads via getCachedArticle), which is how the link
// appears whether the text came from a click, the speculative prefetch, or a summary.
//
// That link is deliberately gated on the `fetchArticleText` reader-proxy opt-in (default OFF),
// so assert BOTH directions: absent while the opt-in is off, present once it is on. Asserting
// only the "present" half against a default profile reported a phantom failure every run — the
// precondition simply did not hold.
await page.evaluate(
  async (id) => {
    const dbMod = await window.__hnlens.db();
    await dbMod.kvSet(`atext:${id}`, {
      text: 'EXTRACTED_ARTICLE_BODY_MARKER full text of the linked article for the viewer test.',
      proxy: 'AllOrigins',
    });
  },
  cardId
);
async function setArticlePref(on) {
  await page.evaluate((v) => window.__hnlens.prefs.getState().set({ fetchArticleText: v }), on);
  await page.waitForTimeout(1000);
}
// Remember the incoming value so this step can restore it (see the note after the assertions).
const articlePrefWasOn = await page.evaluate(() => window.__hnlens.prefs.getState().fetchArticleText);
const articleLink = () => card.getByRole('button', { name: /Article text/i });
await setArticlePref(false);
if (await articleLink().count())
  errors.push('#1 PRIVACY: "Article text" link shown while the reader-proxy opt-in is OFF');
await setArticlePref(true);
// #1: the article-text link is at TITLE level (the card meta row), not inside the summary.
const viewBtn = articleLink();
if (!(await viewBtn.count())) errors.push('#1: no title-level "Article text" link when article text present');
else {
  await viewBtn.click();
  await page.waitForTimeout(400);
  if (!(await page.getByText(/EXTRACTED_ARTICLE_BODY_MARKER/).count()))
    errors.push('#1: extracted article text not shown in the overlay');
  await page.getByRole('button', { name: 'Close' }).click().catch(() => {}); // close the overlay
  await page.waitForTimeout(200);
}
// Put the reader-proxy opt-in back how we found it. This tier runs against a PERSISTENT profile,
// so a pref left flipped here leaks into every later run — and this one is not inert: turning it on
// renders the privacy disclosure whose "downloading AI model weights" text broke the model-status
// poll above, and it makes summaries fetch article bodies through third-party proxies.
await setArticlePref(articlePrefWasOn);

// ---------- Thread summary in comments ----------
log('\n== Thread summary ==');
currentStep = 'thread-summary';
await card.getByRole('button', { name: 'Open comments' }).click();
await page.getByText(/comments/i).first().waitFor({ timeout: 40000 });
// Same stale-cache trap as the TL;DR step: without this, the degeneracy check below grades a
// summary generated by a previous run instead of exercising the model.
const sumClear = await clearSummaryCache(page, cardId);
log('cleared summary cache for', cardId, '->', JSON.stringify(sumClear));
if (sumClear.left.length) errors.push('HARNESS: summary cache not empty before Summarize: ' + JSON.stringify(sumClear.left));
await page.getByRole('button', { name: 'Summarize' }).click();
await page.waitForTimeout(20000);
await snap('summary');
// The comments DRAWER was removed — discussions are a full page (`/item/:id`) now, so there is no
// second <aside> to grab. Read the summary from the page itself. (More harness rot that CI could
// never catch: this tier only runs where a real WebGPU adapter exists.)
const drawerText = (await page.locator('main, body').first().innerText()).replace(/\s+/g, ' ');
const sumIdx = drawerText.indexOf('AI discussion summary');
const sumOut = drawerText.slice(sumIdx, sumIdx + 400);
log('summary output:', sumOut);
if (sumOut.length < 40 || /Could not summarize/i.test(sumOut)) errors.push('SUMMARY empty/failed');
else {
  const deg = looksDegenerate(sumOut);
  if (deg) errors.push('SUMMARY degenerate (' + deg + '): ' + sumOut);
}

// ---------- CONCURRENCY: two generations fired together must NOT deadlock the single
// WebLLM engine (the "stuck at Summarizing…" bug). Calls generate() directly, so it never
// touches the summary cache and is immune to the stale-cache trap above. ----------
log('\n== Concurrency (serialized generation) ==');
currentStep = 'concurrency';
// The documented invariant: WebLLM runs on ONE GPU context, so two concurrent completions must be
// SERIALIZED by the generate() queue and BOTH must finish. (Historically they deadlocked, leaving
// "Summarizing…" forever.) This used to be driven through the UI by opening the comments DRAWER over
// a card that was still streaming — but the drawer was removed and opening comments now NAVIGATES to
// a full page, unmounting the card, so that arrangement can no longer produce two live generations
// and the check reported a phantom "stuck" every run. Drive the invariant directly instead.
// Bound it IN-PAGE. A deadlock here is precisely what this step exists to detect, so it must come
// back as a reported failure ("timed out") rather than an unbounded await that hangs the run — the
// previous version could only distinguish "both finished" from "never returns".
const concurrency = await page.evaluate(async () => {
  const llm = await window.__hnlens.llm();
  const model = window.__hnlens.prefs.getState().llmModel;
  const timeout = (ms) => new Promise((_, rej) => setTimeout(() => rej(new Error(`timed out after ${ms}ms`)), ms));
  const ask = (q) =>
    Promise.race([llm.generate(model, [{ role: 'user', content: q }], { maxTokens: 40 }), timeout(180000)]);
  const t0 = performance.now();
  const settled = await Promise.allSettled([
    ask('In one short sentence: what is a CPU?'),
    ask('In one short sentence: what is RAM?'),
  ]);
  return {
    ms: Math.round(performance.now() - t0),
    ok: settled.map((r) => r.status === 'fulfilled' && String(r.value ?? '').trim().length > 10),
    errs: settled.filter((r) => r.status === 'rejected').map((r) => String(r.reason).slice(0, 120)),
  };
});
log('concurrency:', JSON.stringify(concurrency));
if (!concurrency.ok.every(Boolean)) {
  errors.push('CONCURRENCY: not both generations completed: ' + JSON.stringify(concurrency));
}

clearTimeout(watchdog);
await cleanup();
await browser.close();
log('\n===== MODEL TEST DONE =====');
log('errors:', errors.length);
for (const e of errors.slice(0, 10)) log('  - ' + e);
process.exit(errors.length ? 1 : 0);
