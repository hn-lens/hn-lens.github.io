// Nav chrome test — guards two TopNav/feed-tabs behaviours:
//   (1) The theme + layout SELECTORS are a proper width at lg+ (not chopped to ~9rem/8rem) AND the
//       action icons reach the right content edge (no dead gap — was 113px), WITHOUT widening the
//       search, and with NO horizontal page overflow at any width.
//   (2) The feed-tabs strip is STICKY below the header (stays visible when the feed is scrolled),
//       pinned just under the h-14 header, without reflowing content.
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:4173/';
const now = Math.floor(Date.now() / 1000);
const fails = [];
const check = (name, pass, detail = '') => {
  console.log(`  ${pass ? '\u2713' : '\u2717'} ${name}${detail ? ` \u2014 ${detail}` : ''}`);
  if (!pass) fails.push(name);
};
const j = (r, x) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(x) });

const b = await chromium.launch({ headless: true });

async function mountFeed(page) {
  await page.route(/hacker-news\.firebaseio\.com/, (r) => {
    const u = r.request().url();
    if (/topstories/.test(u)) return j(r, Array.from({ length: 30 }, (_, i) => 9000 + i));
    if (/(best|new|ask|show|job)stories/.test(u)) return j(r, []);
    const m = u.match(/item\/(\d+)/);
    if (m) return j(r, { id: Number(m[1]), type: 'story', by: 'u', title: `A story about distributed systems number ${m[1]}`, url: `https://ex.com/${m[1]}`, score: 120, descendants: 15, time: now - 3600 });
    return j(r, null);
  });
  await page.route(/hn\.algolia\.com|google\.com\/s2|gstatic\.com/, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__hnlens && window.__hnlens.prefs, null, { timeout: 20000 });
  await page.evaluate(async () => {
    await (await window.__hnlens.interactions()).clearAllData();
    window.__hnlens.prefs.getState().set({ defaultFeed: 'top', minPoints: 0, useLearnedRanker: false, embeddingsEnabled: false, hideReadInFeed: false, themeName: 'reader', layout: 'auto' });
    location.hash = '#/';
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__hnlens, null, { timeout: 20000 });
  await page.getByRole('button', { name: 'Top', exact: true }).click();
  await page.waitForSelector('article', { timeout: 15000 });
}

// (1) selector width + closed gap + no overflow, across widths
for (const w of [1280, 1180, 1024, 768, 375]) {
  const ctx = await b.newContext({ viewport: { width: w, height: 820 } });
  const page = await ctx.newPage();
  await mountFeed(page);
  const m = await page.evaluate(() => {
    const header = document.querySelector('header');
    const inner = header.querySelector(':scope > div');
    const nav = header.querySelector('nav[aria-label="Primary"]');
    const themeSel = nav.querySelector('select'); // first select = theme (only present md+)
    return {
      gap: Math.round(inner.getBoundingClientRect().right - nav.getBoundingClientRect().right),
      themeW: themeSel ? Math.round(themeSel.getBoundingClientRect().width) : 0,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
  check(`w=${w}: no horizontal page overflow`, m.overflow <= 0, `overflow=${m.overflow}`);
  if (w >= 1024) {
    check(`w=${w}: no dead gap on the right of the nav (actions reach the edge)`, m.gap <= 24, `gap=${m.gap}px`);
    check(`w=${w}: theme selector widened to a proper width (not the chopped ~144px)`, m.themeW >= 190, `themeW=${m.themeW}px`);
  }
  await ctx.close();
}

// (2) sticky feed tabs
{
  const ctx = await b.newContext({ viewport: { width: 1180, height: 820 } });
  const page = await ctx.newPage();
  await mountFeed(page);
  await page.evaluate(() => window.scrollTo(0, 1200));
  await page.waitForTimeout(400);
  const s = await page.evaluate(() => {
    const ft = document.querySelector('.feed-tabs');
    const r = ft.getBoundingClientRect();
    const hr = document.querySelector('header').getBoundingClientRect();
    return { tabsTop: Math.round(r.top), tabsBottom: Math.round(r.bottom), headerBottom: Math.round(hr.bottom) };
  });
  // pinned just below the header, on-screen (pre-fix it scrolled far off, top ~ -1000)
  check('feed tabs stay visible (sticky) after scrolling the feed', s.tabsTop >= 40 && s.tabsTop <= 100 && s.tabsBottom > s.tabsTop, JSON.stringify(s));
  check('sticky tabs sit BELOW the header (no overlap)', s.tabsTop >= s.headerBottom - 2, JSON.stringify(s));
  await ctx.close();
}

await b.close();
console.log(`\n${fails.length === 0 ? 'RESULT: NAV CHROME PASS \u2713' : `RESULT: ${fails.length} FAILED`}`);
process.exit(fails.length ? 1 : 0);
