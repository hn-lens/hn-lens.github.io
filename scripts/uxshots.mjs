import { chromium } from 'playwright';
const BASE = 'http://localhost:4173/';
const OUT = '/tmp/ux';
import { mkdirSync } from 'node:fs';
mkdirSync(OUT, { recursive: true });
const b = await chromium.launch({ headless: true });

async function shot(name, { w, h, theme, url, full = false, wait = 2500, prep }) {
  const ctx = await b.newContext({ viewport: { width: w, height: h } });
  await ctx.addInitScript((theme) => {
    const st = { defaultFeed: 'foryou', embeddingsEnabled: false, useLearnedRanker: false };
    if (theme) st.theme = theme;
    localStorage.setItem('hn:prefs', JSON.stringify({ state: st, version: 0 }));
    if (theme === 'dark') document.documentElement.classList.add('dark');
  }, theme);
  const p = await ctx.newPage();
  await p.goto(BASE + (url || ''), { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('article,main', { timeout: 40000 }).catch(() => {});
  await p.waitForTimeout(wait);
  if (prep) await prep(p);
  await p.screenshot({ path: `${OUT}/${name}.png`, fullPage: full });
  await ctx.close();
  console.log('shot', name);
}

// Desktop feed (dark + light)
await shot('01-feed-desktop-dark', { w: 1440, h: 1500, theme: 'dark' });
await shot('02-feed-desktop-light', { w: 1440, h: 1500, theme: 'light' });
// Mobile feed
await shot('03-feed-mobile', { w: 390, h: 844, theme: 'light' });
// Mobile nav zoom (top only)
await shot('04-nav-mobile', { w: 390, h: 300, theme: 'light' });
// Comments drawer desktop
await shot('05-drawer-desktop', { w: 1440, h: 1200, theme: 'light', url: '#/?feed=top', prep: async (p) => {
  await p.getByRole('button', { name: 'Open comments' }).first().click();
  await p.waitForTimeout(2500);
} });
// Comments drawer mobile
await shot('06-drawer-mobile', { w: 390, h: 844, theme: 'light', url: '#/?feed=top', prep: async (p) => {
  await p.getByRole('button', { name: 'Open comments' }).first().click();
  await p.waitForTimeout(2500);
} });
// Item permalink mobile
await shot('07-item-mobile', { w: 390, h: 900, theme: 'light', url: '#/item/48956688' });
// Settings desktop + mobile
await shot('08-settings-desktop', { w: 1440, h: 1600, theme: 'light', url: '#/settings' });
await shot('09-settings-mobile', { w: 390, h: 1400, theme: 'light', url: '#/settings' });
// Saved empty
await shot('10-saved-empty', { w: 1440, h: 700, theme: 'light', url: '#/saved' });
// Search results
await shot('11-search-desktop', { w: 1440, h: 1200, theme: 'light', url: '#/?q=rust' });
// Sidebar with tune ranking expanded
await shot('12-sidebar-tune', { w: 1440, h: 1500, theme: 'light', prep: async (p) => {
  await p.getByRole('button', { name: /Tune ranking/ }).click().catch(() => {});
  await p.waitForTimeout(500);
} });

await b.close();
console.log('done ->', OUT);
