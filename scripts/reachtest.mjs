// Guards against clipped/unreachable controls in sticky/scroll containers.
// Uses a REALISTIC window height (not an oversized canvas that hides overflow).
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:4173/';
const b = await chromium.launch({ headless: true });
const fails = [];

// Test at a few common laptop heights — this is where overflow bites.
for (const [w, h] of [
  [1280, 800],
  [1440, 900],
  [1366, 768],
]) {
  const ctx = await b.newContext({ viewport: { width: w, height: h } });
  await ctx.addInitScript(() =>
    localStorage.setItem(
      'hn:prefs',
      JSON.stringify({ state: { defaultFeed: 'foryou', embeddingsEnabled: false }, version: 0 })
    )
  );
  const p = await ctx.newPage();
  await p.goto(BASE, { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('article', { timeout: 40000 });
  await p.waitForTimeout(1500);

  const tune = p.getByRole('button', { name: /Tune ranking/ });
  if (await tune.count()) {
    await tune.click();
    await p.waitForTimeout(300);
    // The LAST control in the expanded panel + a panel BELOW it must be reachable.
    for (const [label, locator] of [
      ['Reset to defaults', p.getByRole('button', { name: 'Reset to defaults' })],
      ['Learned reranker slider', p.getByRole('slider', { name: 'Learned reranker' })],
      ['Local models (below)', p.getByText('Local models')],
    ]) {
      try {
        await locator.scrollIntoViewIfNeeded({ timeout: 4000 });
        await locator.waitFor({ state: 'visible', timeout: 2000 });
      } catch {
        fails.push(`${w}x${h}: "${label}" not reachable in sidebar`);
      }
    }
    // And actually click the last control (fails if truly clipped).
    try {
      await p.getByRole('button', { name: 'Reset to defaults' }).click({ timeout: 4000 });
    } catch {
      fails.push(`${w}x${h}: cannot click "Reset to defaults" (clipped)`);
    }
  }
  console.log(`${w}x${h} checked`);
  await ctx.close();
}

await b.close();
if (fails.length) {
  console.log('\nUNREACHABLE CONTROLS:');
  fails.forEach((f) => console.log(' - ' + f));
  process.exit(1);
}
console.log('\nAll sidebar controls reachable at realistic heights ✓');
