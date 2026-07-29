// Modal dialogs must be fully reachable BY KEYBOARD, not only by wheel. A dialog whose scroll
// container is not the focused element leaves ArrowDown/PageDown/End/Space scrolling nothing, so the
// content below the fold — in the keyboard-help dialog, the "reachable with Tab" note itself — is
// unreachable for a keyboard user while looking healthy under a mouse. Each scrollable dialog must
// also carry a visible close control.
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:4173/';
const fails = [];
const check = (name, pass, detail = '') => {
  console.log(`  ${pass ? '\u2713' : '\u2717'} ${name}${detail ? ` \u2014 ${detail}` : ''}`);
  if (!pass) fails.push(name);
};

const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 844, height: 390 } });
const page = ctx.pages()[0] || (await ctx.newPage());
try {
  await page.route(/hacker-news\.firebaseio\.com|hn\.algolia\.com/, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
  );
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__hnlens, null, { timeout: 20000 });
  // Force overflow so the keyboard-scroll assertion is not vacuous (a dialog that fits needs no
  // scroll). A large root font is the realistic trigger the report hit.
  await page.evaluate(() => (document.documentElement.style.fontSize = '22px'));

  async function assertReach(label, open, dialogSel) {
    await open();
    await page.waitForSelector(dialogSel, { timeout: 5000 });
    await page.waitForTimeout(250);
    const info = await page.evaluate((sel) => {
      const dlg = document.querySelector(sel);
      const scroller = [dlg, ...dlg.querySelectorAll('*')].find(
        (el) => el.scrollHeight - el.clientHeight > 8 && /auto|scroll/.test(getComputedStyle(el).overflowY)
      );
      const active = document.activeElement;
      const hasClose = !!dlg.querySelector('[aria-label^="Close" i], [aria-label="Close"]');
      return {
        overflow: scroller ? scroller.scrollHeight - scroller.clientHeight : 0,
        activeInScroller: scroller ? scroller.contains(active) || scroller === active : false,
        hasClose,
        before: scroller ? scroller.scrollTop : 0,
      };
    }, dialogSel);
    if (info.overflow <= 8) {
      // Fits even at 22px — keyboard scroll is moot, but a close control is still required.
      check(`${label}: has a visible close control`, info.hasClose);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(150);
      return;
    }
    check(`${label}: focus lands in the scroll container`, info.activeInScroller, JSON.stringify(info));
    await page.keyboard.press('End');
    await page.waitForTimeout(200);
    const after = await page.evaluate((sel) => {
      const dlg = document.querySelector(sel);
      const scroller = [dlg, ...dlg.querySelectorAll('*')].find(
        (el) => el.scrollHeight - el.clientHeight > 8 && /auto|scroll/.test(getComputedStyle(el).overflowY)
      );
      return scroller ? scroller.scrollTop : 0;
    }, dialogSel);
    check(`${label}: the keyboard (End) scrolls the content`, after > info.before, `top ${info.before} -> ${after}`);
    check(`${label}: has a visible close control`, info.hasClose);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
  }

  await assertReach(
    'keyboard-help',
    () => page.keyboard.press('?'),
    '[role="dialog"][aria-label="Keyboard shortcuts"]'
  );

  // Settings → the "N signals recorded" viewer, the other sticky-header + scroll-body dialog.
  await assertReach(
    'signals',
    async () => {
      await page.evaluate(() => {
        // Seed enough events that the list overflows.
        void (async () => {
          const { db } = window.__hnlens.db();
          const now = Date.now();
          await db.events.bulkAdd(
            Array.from({ length: 60 }, (_, i) => ({ ts: now + i, type: 'impression', itemId: 4000 + i, domain: 'e.com', author: 'a' }))
          );
        })();
      });
      await page.goto(`${BASE}#/settings`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(400);
      const btn = page.locator('button', { hasText: /signals recorded/i }).first();
      await btn.click();
    },
    '[role="dialog"]'
  );

  // EMPTY scroll body: a brand-new reader opens the signals viewer with 0 events. Its initial focus
  // lands on the empty tabIndex={-1} scroll body, which is not in the tab order — the first Tab used
  // to fall through to the page BEHIND the overlay. It must stay contained.
  await page.evaluate(async () => (await window.__hnlens.interactions()).clearAllData());
  await page.goto(`${BASE}#/settings`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(400);
  await page.locator('button', { hasText: /signals recorded/i }).first().click();
  await page.waitForSelector('[role="dialog"]', { timeout: 5000 });
  await page.waitForTimeout(200);
  // Exactly ONE Tab: the bug is the FIRST Tab escaping. A second Tab from outside would be pulled
  // back by the handler's `outside` branch, masking the escape.
  await page.keyboard.press('Tab');
  const contained = await page.evaluate(() => {
    const d = document.querySelector('[role="dialog"]');
    return { inside: !!d && d.contains(document.activeElement), active: document.activeElement?.className?.slice?.(0, 40) || document.activeElement?.tagName };
  });
  check('signals(empty): the first Tab stays INSIDE the dialog (no escape to the page behind)', contained.inside, JSON.stringify(contained));
} finally {
  await b.close();
}

console.log(`\nRESULT: DIALOG REACH ${fails.length ? `FAIL \u2717 (${fails.join('; ')})` : 'PASS \u2713'}`);
process.exit(fails.length ? 1 : 0);
