// Header fit — labels must be SHORTENED to fit, never cut mid-word, and never trimmed by a fixed
// cap while the bar around them sits empty.
//
// Two distinct failures live here and they pull in opposite directions, so both are asserted:
//   (a) a text INPUT cannot ellipsise its own placeholder. Anything wider than the field is sliced
//       mid-word and reads as a typo rather than as truncation. So the placeholder must FIT at the
//       narrowest supported viewport.
//   (b) a SELECT ellipsises, but a fixed max-width trims its value even when the header has room
//       to spare. So at the wide widths the selected value must fit.
// Fixing either alone re-creates the other (shorten everything and the wide screens look starved;
// widen everything and the narrow ones overflow), which is why the narrow and wide cases are both
// here, along with a no-overflow assertion that bounds the widening.
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:4173/';
const fails = [];
const check = (name, pass, detail = '') => {
  console.log(`  ${pass ? '\u2713' : '\u2717'} ${name}${detail ? ` \u2014 ${detail}` : ''}`);
  if (!pass) fails.push(name);
};

// 320 is the narrowest phone still in use; 1024 is where both selects are shown; 1920 is where the
// most header space goes unused.
const WIDTHS = [320, 360, 375, 390, 430, 768, 1024, 1280, 1920];
const WIDE = 1024;

const b = await chromium.launch({ headless: true });
try {
  for (const w of WIDTHS) {
    const ctx = await b.newContext({ viewport: { width: w, height: 900 }, isMobile: w < 768, hasTouch: w < 768 });
    const page = await ctx.newPage();
    await page.addInitScript(() => {
      try {
        localStorage.setItem('hn:onboard', 'skip');
      } catch {
        /* private mode */
      }
    });
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('header', { timeout: 20000 });
    await page.waitForTimeout(600);

    const r = await page.evaluate(() => {
      // Measure the rendered text against the space inside the control's own padding box. A
      // display:none control reports a negative width; treat it as absent rather than as failing.
      const fit = (el, text) => {
        if (!el || el.offsetParent === null) return null;
        const cs = getComputedStyle(el);
        const probe = document.createElement('span');
        probe.style.cssText = `position:absolute;visibility:hidden;white-space:pre;font:${cs.font}`;
        probe.textContent = text;
        document.body.appendChild(probe);
        const textW = probe.getBoundingClientRect().width;
        probe.remove();
        const avail = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
        return { text: text.slice(0, 26), textW: Math.round(textW), avail: Math.round(avail), clipped: textW > avail };
      };
      const input = document.querySelector('header input');
      const inner = document.querySelector('header')?.firstElementChild;
      return {
        search: fit(input, input?.placeholder ?? ''),
        selects: [...document.querySelectorAll('header select')]
          .map((s) => fit(s, s.options[s.selectedIndex]?.text ?? ''))
          .filter(Boolean),
        docOverflow: Math.round(document.documentElement.scrollWidth - document.documentElement.clientWidth),
        headerOverflow: inner ? Math.round(inner.scrollWidth - inner.clientWidth) : 0,
      };
    });

    // Without this the loop can pass at a width where the header rendered nothing to measure.
    check(`PRECONDITION: the header search field is present and measurable at ${w}px`, r.search !== null, JSON.stringify(r.search));
    if (r.search) {
      check(`the search placeholder fits its field at ${w}px (not cut mid-word)`, !r.search.clipped, JSON.stringify(r.search));
    }
    if (w >= WIDE) {
      check(`PRECONDITION: the header shows its selects at ${w}px`, r.selects.length >= 2, `visible=${r.selects.length}`);
      for (const s of r.selects) {
        check(`the selected value fits its control at ${w}px, where the header has room`, !s.clipped, JSON.stringify(s));
      }
    }
    // Bounds the widening: a cap raised too far would simply move the defect into an overflow.
    check(`the header does not overflow at ${w}px`, r.docOverflow <= 0 && r.headerOverflow <= 0, JSON.stringify({ docOverflow: r.docOverflow, headerOverflow: r.headerOverflow }));

    await ctx.close();
  }
} finally {
  await b.close();
}

console.log(`\n${fails.length === 0 ? 'RESULT: HEADER FIT PASS \u2713' : `RESULT: ${fails.length} FAILED`}`);
process.exit(fails.length ? 1 : 0);
