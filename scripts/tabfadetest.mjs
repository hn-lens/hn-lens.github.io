// The feed-tab strip's edge fade hints that the strip scrolls — but it must not wash out the text
// of a tab that is FULLY on screen (SPEC 9a criterion 7: text meets WCAG AA against its surface).
//
// The fade is `bg-gradient-to-l from-bg to-transparent` over the scroll edge: opaque `--bg` at the
// viewport edge, transparent at its inner edge. When the last VISIBLE tab ends close to that edge,
// the opaque part of the fade composites `--bg` over the tab's trailing glyphs and drops their
// contrast below AA — measured 2.48:1 on "Best" at 360/md and 3.29:1 on "New" at 320/lg, against a
// base of 6.68:1, because the 44px fade bit ~20px into a tab that ended ~23px from the edge.
//
// Contrast is computed from the fade's known linear gradient (validated against the rendered result)
// rather than sampled, so it is deterministic. A separate visual pass covers what the model can't
// (e.g. a pill BORDER under the fade). The opposite case is guarded too: the fade must still EXIST
// when the strip is scrollable, so this cannot be "passed" by deleting the affordance.
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:4173/';
const fails = [];
const check = (name, pass, detail = '') => {
  console.log(`  ${pass ? '\u2713' : '\u2717'} ${name}${detail ? ` \u2014 ${detail}` : ''}`);
  if (!pass) fails.push(name);
};

// Narrow phones where the tab strip overflows, at both reading sizes: the text-size axis moves the
// tab widths, so a tab that clears the fade at one size ends inside it at another.
const CASES = [
  { w: 320, ts: 'md' },
  { w: 360, ts: 'md' },
  { w: 375, ts: 'md' },
  { w: 390, ts: 'md' },
  { w: 320, ts: 'lg' },
  { w: 360, ts: 'lg' },
  { w: 390, ts: 'lg' },
];

const b = await chromium.launch({ headless: true });
let measured = 0;
try {
  for (const c of CASES) {
    const ctx = await b.newContext({ viewport: { width: c.w, height: 780 }, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    await page.addInitScript(
      (t) => {
        try {
          localStorage.setItem('hn:onboard', 'skip');
          localStorage.setItem('hn:prefs', JSON.stringify({ state: { textSize: t }, version: 0 }));
        } catch {
          /* private mode */
        }
      },
      c.ts,
    );
    await page.goto(`${BASE}#/?feed=top`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.feed-tabs', { timeout: 45000 }).catch(() => {});
    await page.waitForTimeout(1200);

    const r = await page.evaluate(() => {
      const parse = (col) => {
        const m = col.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)/);
        return m ? [+m[1], +m[2], +m[3]] : null;
      };
      const lum = ([r, g, b]) => {
        const f = (x) => {
          x /= 255;
          return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
        };
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
      };
      const cr = (a, cc) => {
        const L1 = lum(a);
        const L2 = lum(cc);
        return (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
      };
      // The fade composites `--bg` OVER the content at gradient alpha a.
      const over = (fg, bg, a) => fg.map((v, i) => bg[i] * a + v * (1 - a));

      const strip = document.querySelector('.feed-tabs');
      if (!strip) return { noStrip: true };
      const overflows = strip.scrollWidth > strip.clientWidth + 2;
      const sb = strip.getBoundingClientRect();
      const bg = parse(getComputedStyle(document.body).backgroundColor) || [255, 255, 255];
      const root = strip.parentElement || strip;
      // The RIGHT-edge fade: an absolutely-positioned gradient element on the right half.
      const fade = [...root.querySelectorAll('*')].find((e) => {
        const cs = getComputedStyle(e);
        return /gradient/.test(cs.backgroundImage) && cs.position === 'absolute' && e.getBoundingClientRect().left > sb.left + sb.width / 2;
      });
      const fb = fade ? fade.getBoundingClientRect() : null;
      // Last tab fully within the strip's visible box.
      const tabs = [...strip.querySelectorAll('button')];
      let last = null;
      for (const t of tabs) {
        const bb = t.getBoundingClientRect();
        if (bb.right <= sb.right + 0.5 && bb.left >= sb.left - 0.5) last = t;
      }
      const moreToRight = strip.scrollLeft + strip.clientWidth < strip.scrollWidth - 4;
      if (!overflows || !fb || !last) return { overflows, hasFade: !!fb, hasLast: !!last, moreToRight };

      const textColor = parse(getComputedStyle(last).color) || [0, 0, 0];
      const bgStr = getComputedStyle(last).backgroundColor;
      const tabBgParsed = parse(bgStr);
      const tabBg = tabBgParsed && bgStr !== 'rgba(0, 0, 0, 0)' ? tabBgParsed : bg;
      // Exact glyph extent via a Range over the text node.
      const tn = [...last.childNodes].find((n) => n.nodeType === 3 && n.textContent.trim());
      let textRight = last.getBoundingClientRect().right - 12;
      if (tn) {
        const rg = document.createRange();
        rg.selectNodeContents(tn);
        textRight = rg.getBoundingClientRect().right;
      }
      const alphaAt = (x) => Math.max(0, Math.min(1, (x - fb.left) / (fb.right - fb.left)));
      const a = alphaAt(textRight - 1);
      const contrast = cr(over(textColor, bg, a), over(tabBg, bg, a));
      return {
        overflows,
        moreToRight,
        label: (last.textContent || '').trim(),
        base: +cr(textColor, tabBg).toFixed(2),
        alphaAtGlyph: +a.toFixed(2),
        contrast: +contrast.toFixed(2),
        fadeW: Math.round(fb.right - fb.left),
      };
    });

    const tag = `${c.w}/${c.ts}`;
    // Only measure cells where the strip overflows AND a fade is shown AND a last-visible tab
    // exists (contrast is defined) — otherwise the contrast check would be vacuous.
    const usable = !r.noStrip && r.overflows && r.contrast !== undefined;
    check(`PRECONDITION ${tag}: strip overflows, a fade is shown, a last-visible tab exists`, usable, JSON.stringify(r));
    if (!usable) {
      await ctx.close();
      continue;
    }
    measured += 1;
    check(
      `${tag}: the last visible tab "${r.label}" keeps AA text contrast under the fade`,
      r.contrast >= 4.5,
      `contrast=${r.contrast}:1 (alpha ${r.alphaAtGlyph}, base ${r.base}, fadeW ${r.fadeW})`,
    );
    // Opposite case: the fix must not be "remove the fade". When there is more to scroll to, the
    // affordance must still be present.
    check(`${tag}: a scroll-hint fade is still present when the strip can scroll`, !r.moreToRight || r.fadeW > 0, `fadeW=${r.fadeW} moreToRight=${r.moreToRight}`);
    await ctx.close();
  }
  check(`PRECONDITION: at least 4 overflowing cells were measured`, measured >= 4, `${measured} measured`);
} finally {
  await b.close();
}

console.log(`\n${fails.length === 0 ? 'RESULT: TAB FADE PASS \u2713' : `RESULT: ${fails.length} FAILED`}`);
process.exit(fails.length ? 1 : 0);
