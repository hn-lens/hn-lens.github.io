// A popover must never be painted underneath a bar pinned to the top of the screen.
//
// `cardteachtest` owns this invariant for the card menu, but its fixture places every menu at the
// same y whatever the viewport, so it cannot host the case where the anchor itself sits just under
// the tab strip. That case only appears on the real feed, in the tile layouts, where the first
// card's control is high on the screen — and it appears at SCROLL 0, the state the reader arrives
// in, which no existing sweep measured.
//
// It is measured as OVERLAP rather than as a stolen tap on purpose. Whether an item's exact centre
// lands on the bar is a knife-edge: an unrelated change to the row above the list moved the menu
// down by 17px and took a real defect from "steals the New tab's tap" to "merely paints under it",
// which would have read as fixed. Painting under an opaque bar is the defect either way.
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:4173/';
const fails = [];
const check = (name, pass, detail = '') => {
  console.log(`  ${pass ? '\u2713' : '\u2717'} ${name}${detail ? ` \u2014 ${detail}` : ''}`);
  if (!pass) fails.push(name);
};

// The tile layouts put a card's control high on the screen at scroll 0; Large text raises it
// further. `cards` at default text is the opposite-case control: it must stay clean too.
const CASES = [
  { w: 375, h: 844, ts: 'lg', layout: 'grid' },
  { w: 360, h: 780, ts: 'lg', layout: 'grid' },
  { w: 390, h: 844, ts: 'lg', layout: 'bento' },
  { w: 320, h: 800, ts: 'lg', layout: 'grid' },
  { w: 360, h: 800, ts: 'lg', layout: 'bento' },
  { w: 412, h: 896, ts: 'lg', layout: 'grid' },
  { w: 375, h: 812, ts: 'lg', layout: 'media' },
  { w: 414, h: 896, ts: 'md', layout: 'grid' },
  { w: 390, h: 844, ts: 'md', layout: 'cards' },
];

const b = await chromium.launch({ headless: true });
let measured = 0;
try {
  for (const c of CASES) {
    const ctx = await b.newContext({
      viewport: { width: c.w, height: c.h },
      isMobile: true,
      hasTouch: true,
    });
    const page = await ctx.newPage();
    await page.addInitScript(
      ({ t, l }) => {
        try {
          localStorage.setItem('hn:onboard', 'skip');
          localStorage.setItem('hn:prefs', JSON.stringify({ state: { textSize: t, layout: l }, version: 0 }));
        } catch {
          /* private mode */
        }
      },
      { t: c.ts, l: c.layout },
    );
    await page.goto(`${BASE}#/?feed=foryou`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('article[data-id]', { timeout: 45000 }).catch(() => {});
    await page.waitForTimeout(2200);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(300);

    const r = await page.evaluate(async () => {
      const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
      const btns = [...document.querySelectorAll('article[data-id] button')].filter((x) =>
        /personalize|more/i.test(x.getAttribute('aria-label') || x.textContent || ''),
      );
      if (!btns.length) return { noBtn: true };
      btns.sort((a, z) => a.getBoundingClientRect().top - z.getBoundingClientRect().top);
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      // Whether a card menu lands under the strip depends on where its ⋯ sits relative to the
      // strip, which shifts with the feed-row height and text size — so a single card can be masked
      // by an unrelated layout change (it was, once). Sweep several cards and keep the WORST, so the
      // invariant is caught wherever a menu flips into the strip rather than only for the top card.
      const CARDS = Math.min(5, btns.length);
      let worst = null;
      let cardsOpened = 0;
      let barsSeenAny = 0;
      for (let i = 0; i < CARDS; i++) {
        const btn = btns[i];
        btn.click();
        await sleep(360);
        const m = document.querySelector('[role="menu"]');
        if (!m) continue;
        cardsOpened += 1;
        const mb = m.getBoundingClientRect();
        let over = 0;
        let overBy = null;
        const seen = new Set();
        for (const x of [vw * 0.25, vw * 0.5, vw * 0.75]) {
          for (const y of [2, 24, 48, 72, 96, 120, 144, 168]) {
            for (const el of document.elementsFromPoint(Math.round(x), y)) {
              if (!(el instanceof HTMLElement) || m.contains(el) || el.contains(m)) continue;
              const cs = getComputedStyle(el);
              if (cs.position !== 'sticky' && cs.position !== 'fixed') continue;
              const bb = el.getBoundingClientRect();
              if (bb.height <= 0 || bb.height > vh * 0.6) continue;
              seen.add(el);
              const ov = Math.round(Math.min(mb.bottom, bb.bottom) - Math.max(mb.top, bb.top));
              if (ov > over) {
                over = ov;
                overBy = `${el.tagName}.${String(el.className || '').slice(0, 26)} [${Math.round(bb.top)},${Math.round(bb.bottom)}]`;
              }
            }
          }
        }
        barsSeenAny = Math.max(barsSeenAny, seen.size);
        const items = [...m.querySelectorAll('a,button,[role="menuitem"]')].filter((e) => {
          const bb = e.getBoundingClientRect();
          return bb.width > 0 && bb.height > 0;
        });
        let stolen = 0;
        const stolenBy = [];
        for (const it of items) {
          const bb = it.getBoundingClientRect();
          const cy = bb.top + bb.height / 2;
          if (cy < 0 || cy > vh) continue;
          const hit = document.elementFromPoint(Math.round(bb.left + bb.width / 2), Math.round(cy));
          if (hit && hit !== it && !it.contains(hit)) {
            stolen += 1;
            stolenBy.push(`"${(it.textContent || '').trim().slice(0, 18)}"@${Math.round(bb.top)} <- ${hit.tagName} "${(hit.textContent || '').trim().slice(0, 14)}"`);
          }
        }
        const cand = { items: items.length, menuTop: Math.round(mb.top), over, overBy, stolen, stolenBy, card: i };
        if (!worst || over > worst.over || stolen > worst.stolen) worst = cand;
        // Close before the next card so only one menu is measured at a time.
        btn.click();
        await sleep(160);
      }
      if (!worst) return { noMenu: true };
      return { ...worst, barsSeen: barsSeenAny, cardsOpened, scrollY: Math.round(window.scrollY) };
    });

    const tag = `${c.w}x${c.h}/${c.ts}/${c.layout}`;
    // Each of these would make the two checks below vacuously true.
    check(
      `PRECONDITION ${tag}: several card menus opened at scroll 0, with a pinned bar on screen`,
      !r.noBtn && !r.noMenu && r.items >= 3 && r.barsSeen >= 1 && r.scrollY === 0 && r.cardsOpened >= 2,
      JSON.stringify(r),
    );
    if (r.noBtn || r.noMenu) {
      await ctx.close();
      continue;
    }
    measured += 1;
    check(`${tag}: the menu is not painted under a pinned bar`, r.over <= 0, `over=${r.over} by ${r.overBy} menuTop=${r.menuTop}`);
    check(`${tag}: every menu entry takes its own tap`, r.stolen === 0, `stolen=${r.stolen} ${JSON.stringify(r.stolenBy)}`);
    await ctx.close();
  }
  check(`PRECONDITION: the sweep measured every case`, measured === CASES.length, `${measured} of ${CASES.length}`);
} finally {
  await b.close();
}

console.log(`\n${fails.length === 0 ? 'RESULT: POPOVER BAND PASS \u2713' : `RESULT: ${fails.length} FAILED`}`);
process.exit(fails.length ? 1 : 0);
