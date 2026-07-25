import { chromium } from 'playwright';
const BASE = process.env.BASE || 'http://localhost:4173/';
const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ viewport: { width: 1280, height: 1000 } });
const page = ctx.pages()[0] || (await ctx.newPage());
const status = [];
page.on('response', (r) => {
  if (r.url().includes('hn.algolia.com') && r.status() >= 400) status.push(r.status() + ' ' + r.url().slice(0, 90));
});
const log = (...a) => console.log(...a);
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__hnlens?.prefs, null, { timeout: 20000 });

// P1: minPoints huge -> should empty For You with empty-state
log('\nP1 minPoints=100000');
await page.evaluate(() => window.__hnlens.prefs.getState().set({ minPoints: 100000 }));
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3000);
log('  cards=', await page.locator('article').count(), 'emptyState=', await page.getByText(/Nothing to show/i).count());
await page.evaluate(() => window.__hnlens.prefs.getState().set({ minPoints: 0 }));

// P2: mute-all keyword
log('\nP2 keywordsMute=["e","a","t"]');
await page.evaluate(() => window.__hnlens.prefs.getState().set({ keywordsMute: ['e', 'a', 't'] }));
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3000);
log('  cards=', await page.locator('article').count(), 'emptyState=', await page.getByText(/Nothing to show/i).count());
await page.evaluate(() => window.__hnlens.prefs.getState().set({ keywordsMute: [] }));

// P3: long search query status
log('\nP3 search long/special query');
await page.goto(BASE + '#/?q=' + encodeURIComponent('a'.repeat(2000)), { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);
log('  algolia 4xx responses:', status.length ? status.join(' | ') : 'none');
log('  results text:', (await page.getByText(/results for|No results/i).count()) ? 'present' : 'ABSENT (no feedback)');

// P4: Saved page should NOT expose the confusing Hide button
log('\nP4 Saved page has no Hide button');
await page.goto(BASE + '#/?feed=top', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('article', { timeout: 40000 });
await page.locator('article').first().getByRole('button', { name: /Save/ }).click();
await page.waitForTimeout(200);
await page.getByRole('banner').getByRole('button', { name: 'Saved items' }).click();
await page.waitForSelector('article', { timeout: 20000 });
const hideOnSaved = await page.locator('article').first().getByRole('button', { name: 'Not interested' }).count();
log('  Hide button on Saved card:', hideOnSaved === 0 ? 'absent ✓' : 'PRESENT (bug)');

// P5: drawer closes on browser back navigation
log('\nP5 drawer closes on back navigation');
await page.goto(BASE + '#/?feed=top', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('article', { timeout: 40000 });
await page.getByRole('link', { name: 'HN Lens' }).click(); // push a history entry
await page.waitForTimeout(400);
await page.getByRole('button', { name: 'Open comments' }).first().click();
await page.waitForTimeout(600);
await page.goBack();
await page.waitForTimeout(600);
const drawerAfterBack = await page.locator('aside[role="dialog"]').evaluate((el) => el.classList.contains('translate-x-0')).catch(() => false);
log('  drawer still open after Back:', drawerAfterBack ? 'YES (bug)' : 'no ✓');

// P6: exit search affordance
log('\nP6 exit-search affordance');
await page.goto(BASE + '#/?q=rust', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);
const tabs = await page.getByRole('button', { name: 'For You', exact: true }).count();
log('  feed tabs visible during search:', tabs > 0 ? 'yes' : 'NO (must manually clear box)');

// P7: layout overflow with long query in box
log('\nP7 horizontal overflow');
const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 2);
log('  page has horizontal overflow:', overflow ? 'YES (bug)' : 'no');

await b.close();
