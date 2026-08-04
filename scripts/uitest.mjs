import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE || 'http://localhost:4173/';
const OUT = '/tmp/uitest';
mkdirSync(OUT, { recursive: true });

const consoleErrors = [];
const results = [];
let shot = 0;

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1300 } });
const page = await ctx.newPage();

const EXTERNAL = /favicons|gstatic|google\.com\/s2|huggingface|hf\.co|mlc|raw\.github/;
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  const url = m.location()?.url || '';
  if (EXTERNAL.test(url)) return; // benign favicon/model CDN 404s, handled by fallbacks
  consoleErrors.push(m.text() + (url ? ` (${url})` : ''));
});
page.on('pageerror', (e) => consoleErrors.push('PAGEERROR: ' + e.message));
page.on('requestfailed', (r) => {
  const u = r.url();
  if (EXTERNAL.test(u)) return;
  const err = r.failure()?.errorText || '';
  // ERR_ABORTED = a cancelled request (navigation / React Query cancelling an
  // in-flight fetch on invalidate or unmount, e.g. during "clear all data") — not a bug.
  if (/ERR_ABORTED|aborted/i.test(err)) return;
  consoleErrors.push('REQFAIL: ' + u + ' — ' + err);
});
// Auto-accept confirm() dialogs (e.g. Clear all data).
page.on('dialog', (d) => d.accept());

async function snap(name) {
  const file = `${OUT}/${String(++shot).padStart(2, '0')}-${name}.png`;
  await page.screenshot({ path: file, fullPage: false });
  return file;
}

async function step(name, fn) {
  const before = consoleErrors.length;
  try {
    await fn();
    const errs = consoleErrors.slice(before);
    results.push({ name, ok: errs.length === 0, errs });
    console.log(`${errs.length === 0 ? 'PASS' : 'WARN'}  ${name}${errs.length ? ' — ' + errs.length + ' err' : ''}`);
  } catch (e) {
    results.push({ name, ok: false, errs: [String(e.message || e)] });
    console.log(`FAIL  ${name} — ${e.message || e}`);
    await snap('FAIL-' + name.replace(/\W+/g, '-'));
  }
}

const TABS = ['Top', 'New', 'Best', 'Ask', 'Show', 'Jobs', 'For You'];

await step('home loads + feed populates', async () => {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('article', { timeout: 40000 });
  const n = await page.locator('article').count();
  if (n === 0) throw new Error('no story cards rendered');
  await snap('home');
});

for (const tab of TABS) {
  await step(`tab: ${tab}`, async () => {
    await page.getByRole('button', { name: tab, exact: true }).first().click();
    // Live feed: wait for the tab to SETTLE into a terminal state — cards, a legitimate empty
    // state, or an outage — instead of asserting a card count after a fixed wait. Show/Jobs can be
    // sparse and any live feed can be slow, which raced the old fixed 800ms. A genuine hang (never
    // settling past skeletons) still fails the 40s poll.
    await page.waitForFunction(
      () =>
        document.querySelector('article') ||
        document.querySelector('[data-empty-state]') ||
        /Couldn.t load/i.test(document.body.innerText),
      null,
      { timeout: 40000 }
    );
    await snap('tab-' + tab.replace(/\s/g, ''));
  });
}

await step('search', async () => {
  await page.getByRole('searchbox', { name: 'Search Hacker News' }).fill('rust');
  await page.getByRole('searchbox', { name: 'Search Hacker News' }).press('Enter');
  await page.waitForSelector('article', { timeout: 40000 });
  await page.getByText(/results for/i).waitFor({ timeout: 40000 });
  await snap('search');
});

await step('search edge cases (empty + special chars)', async () => {
  await page.getByRole('searchbox', { name: 'Search Hacker News' }).fill('');
  await page.getByRole('searchbox', { name: 'Search Hacker News' }).press('Enter');
  await page.waitForTimeout(500); // empty => back to feed
  await page.getByRole('searchbox', { name: 'Search Hacker News' }).fill('c++ <script> "quotes"');
  await page.getByRole('searchbox', { name: 'Search Hacker News' }).press('Enter');
  await page.waitForTimeout(2500);
  await snap('search-special');
});

await step('open comments (full page) + sort + back to feed', async () => {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('article', { timeout: 40000 });
  await page.getByRole('button', { name: 'Open comments' }).first().click();
  // The card now navigates to the full /item discussion page (the drawer was removed).
  await page.waitForFunction(() => location.hash.includes('/item/'), null, { timeout: 40000 });
  await page.getByRole('button', { name: /Back to feed/i }).waitFor({ timeout: 40000 });
  await page.waitForTimeout(1500);
  await snap('discussion');
  // sort by most replies (present only when the discussion has comments)
  const mr = page.getByRole('button', { name: 'Replies', exact: true });
  if (await mr.count()) await mr.first().click();
  await page.waitForTimeout(400);
  await page.getByRole('button', { name: /Back to feed/i }).click();
  await page.waitForSelector('article', { timeout: 20000 });
  await page.waitForTimeout(300);
});

await step('save then verify on Saved page', async () => {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('article', { timeout: 40000 });
  await page.getByRole('button', { name: 'Save', exact: true }).first().click();
  await page.waitForTimeout(400); // let the Dexie save write commit
  await page.getByRole('banner').getByRole('button', { name: 'Saved' }).click(); // top-nav Saved
  // Poll for the saved item rather than asserting after a fixed wait (the Dexie liveQuery that
  // backs the Saved page can lag). Re-navigate once if it hasn't appeared — a genuine save failure
  // still fails after the retry.
  let n = 0;
  for (let attempt = 0; attempt < 2 && n === 0; attempt++) {
    await page.waitForSelector('article', { timeout: 15000 }).catch(() => {});
    n = await page.locator('article').count();
    if (n === 0) {
      await page.goto(BASE + '#/saved', { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(500);
    }
  }
  if (n === 0) throw new Error('saved item not shown on Saved page');
  await snap('saved');
});

await step('hide leaves a placeholder stub for the hidden card', async () => {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('article', { timeout: 40000 });
  await page.waitForTimeout(600);
  // Assert by data-id, not title: this is a LIVE feed and real HN stories can share a
  // title (e.g. two distinct submissions both "Superlogical"), so a title-string check is
  // ambiguous. The id is unique per card.
  const firstCard = page.locator('article').first();
  const hiddenId = await firstCard.getAttribute('data-id');
  if (!hiddenId) throw new Error('first card has no data-id');
  await firstCard.getByRole('button', { name: 'Not interested' }).click();
  await page.waitForTimeout(900);
  // The row is NOT yanked (that would jump the list under the reader's next click). It
  // becomes a "Hidden — <title> · Restore" placeholder stub keyed to the same id, and is
  // no longer a full interactive card (its title h3 is gone from that slot).
  const stub = page.locator(`article[data-id="${hiddenId}"][data-hidden-stub="true"]`);
  if ((await stub.count()) === 0) throw new Error(`hidden card ${hiddenId} did not become a placeholder stub`);
  const stillFull = await page.locator(`article[data-id="${hiddenId}"] h3`).count();
  if (stillFull > 0) throw new Error(`hidden card ${hiddenId} is still a full card, not a stub`);
});

await step('permalink page /item/:id', async () => {
  await page.goto(BASE + '#/item/1', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  await snap('permalink');
});

await step('invalid item id does not crash', async () => {
  await page.goto(BASE + '#/item/abc', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(800);
  await snap('invalid-item');
});

await step('settings: toggles, sliders, dropdowns', async () => {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Settings & models' }).click();
  await page.getByText('For You ranking weights').waitFor({ timeout: 10000 });
  await snap('settings');
  // flip every switch on, then back off — returns to defaults so we don't leave
  // e.g. the opt-in reader proxy enabled (which would hit the network).
  const switches = page.getByRole('switch');
  const sc = await switches.count();
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < sc; i++) {
      await switches.nth(i).click();
      await page.waitForTimeout(120);
    }
  }
  // move first slider
  const sliders = page.getByRole('slider');
  if (await sliders.count()) {
    await sliders.first().focus();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
  }
  // exercise the last dropdown (LLM model); it may have only one option
  const combos = page.getByRole('combobox');
  const cc = await combos.count();
  if (cc) {
    const last = combos.nth(cc - 1);
    const opts = await last.locator('option').count();
    await last.selectOption({ index: Math.min(1, opts - 1) });
  }
  await page.waitForTimeout(300);
  await snap('settings-after');
});

await step('settings: reset weights + train from history', async () => {
  const reset = page.getByRole('button', { name: 'Reset to defaults' });
  if (await reset.count()) await reset.first().click();
  const train = page.getByRole('button', { name: 'Retrain now' });
  if (await train.count()) {
    await train.click();
    await page.waitForTimeout(2500);
    await snap('trained');
  }
});

await step('read tab renders', async () => {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('article', { timeout: 40000 });
  await page.getByRole('button', { name: 'Read', exact: true }).click();
  // Shows the read-history feed or a graceful empty state — either is fine, no crash. Keyed on the
  // `data-empty-state` hook rather than on prose: the tab has four valid empty states and matching
  // their wording made this fail whenever the tour reached one the list did not name.
  await page.waitForFunction(
    () => document.querySelector('article') || document.querySelector('[data-empty-state]'),
    null,
    { timeout: 15000 }
  );
  await snap('read-tab');
});

await step('settings: cached models list + remove', async () => {
  // Seed a fake cached model shard, then remove it via the UI.
  await page.evaluate(async () => {
    const c = await caches.open('webllm/model');
    await c.put(
      new Request('https://huggingface.co/mlc-ai/Llama-3.2-1B-Instruct-q4f16_1-MLC/resolve/main/params_shard_0.bin'),
      new Response(new Uint8Array(4), { headers: { 'content-length': '943718400' } })
    );
  });
  await page.goto(BASE + '#/settings', { waitUntil: 'domcontentloaded' });
  await page.getByText('Cached models & storage').waitFor({ timeout: 10000 });
  const section = page.locator('section', { hasText: 'Cached models & storage' });
  await section.getByRole('button', { name: 'Refresh' }).click(); // rescan after seeding
  const removeBtn = page.getByRole('button', { name: /Remove cached model/ }).first();
  await removeBtn.waitFor({ timeout: 8000 });
  await removeBtn.click();
  // after removal the shard is gone from the cache
  await page.waitForTimeout(600);
  const gone = await page.evaluate(async () => {
    const c = await caches.open('webllm/model');
    return !(await c.match('https://huggingface.co/mlc-ai/Llama-3.2-1B-Instruct-q4f16_1-MLC/resolve/main/params_shard_0.bin'));
  });
  if (!gone) throw new Error('cached model was not removed');
  await snap('cached-models');
});

await step('HN account: connect + import', async () => {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('article', { timeout: 40000 });
  const input = page.getByPlaceholder('HN username');
  if (await input.count()) {
    await input.fill('pg');
    await page.getByRole('button', { name: 'Connect' }).click();
    await page.getByText('karma').waitFor({ timeout: 20000 });
    await snap('hn-account');
    const imp = page.getByRole('button', { name: /Use my history to personalize/i });
    if (await imp.count()) {
      await imp.click();
      // Scope to the sidebar + require the actual import-status shape ("Imported N
      // posts" / "Import failed") — a page-wide getByText(/Imported|failed/i) collides
      // with random seeded feed text that happens to contain "failed" (mirrors the
      // robust wait in hnaccounttest).
      await page.waitForFunction(
        () =>
          /Imported \d+ posts|Import failed/i.test(
            document.querySelector('.app-sidebar')?.innerText ?? ''
          ),
        null,
        { timeout: 30000 }
      );
      await snap('hn-imported');
    }
  }
});

await step('theme toggle', async () => {
  const t = page.getByRole('button', { name: /mode$/ });
  if (await t.count()) {
    await t.first().click();
    await page.waitForTimeout(300);
    await snap('theme');
    await t.first().click();
  }
});

await step('clear all local data', async () => {
  await page.getByRole('button', { name: 'Settings & models' }).click();
  await page.getByText('Clear all local data').waitFor({ timeout: 10000 });
  await page.getByRole('button', { name: /Clear all local data/ }).click();
  await page.waitForTimeout(800);
  // App should still be alive and navigable after wiping local data
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('article', { timeout: 40000 });
  const n = await page.locator('article').count();
  if (n === 0) throw new Error('feed empty after clearing data');
  await snap('after-clear');
});

await browser.close();

console.log('\n===== SUMMARY =====');
let fails = 0;
for (const r of results) {
  if (!r.ok) {
    fails++;
    console.log(`\n[${r.ok ? 'ok' : 'ISSUE'}] ${r.name}`);
    for (const e of r.errs.slice(0, 6)) console.log('   - ' + e);
  }
}
console.log(`\n${results.length} steps, ${fails} with issues. Total console errors: ${consoleErrors.length}`);
console.log('Screenshots in ' + OUT);
process.exit(fails > 0 || consoleErrors.length > 0 ? 1 : 0);
