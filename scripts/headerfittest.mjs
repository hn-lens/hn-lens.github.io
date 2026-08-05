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
// Swept on the feed AND on a discussion, because the discussion carries a second pinned bar with
// its own text field; checking only the landing page cannot see it.
let ROUTES = [''];
const fails = [];
const check = (name, pass, detail = '') => {
  console.log(`  ${pass ? '\u2713' : '\u2717'} ${name}${detail ? ` \u2014 ${detail}` : ''}`);
  if (!pass) fails.push(name);
};

// 320 is the narrowest phone still in use; 1024 is where both selects are shown; 1920 is where the
// most header space goes unused.
const WIDTHS = [320, 360, 375, 390, 430, 768, 1024, 1280, 1920];
const WIDE = 1024;
// Reading text size is a root font-size axis, and the header's controls are rem-sized: raising it
// grows the icon buttons and SHRINKS the flexible search field while the string inside it grows.
// Sweeping widths alone therefore misses the worst case entirely.
const TEXT_SIZES = ['md', 'lg'];

let sawToolbarField = false;
const b = await chromium.launch({ headless: true });
try {
  // Discover a real discussion. A hard-coded id is not reliably a story with a comment thread, and
  // without a thread the toolbar never renders, so its text field would go unmeasured and this
  // sweep would report a clean pass having never looked at it.
  {
    const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
    const p0 = await ctx.newPage();
    await p0.goto(BASE, { waitUntil: 'domcontentloaded' });
    await p0.waitForSelector('article[data-id]', { timeout: 45000 }).catch(() => {});
    await p0.waitForTimeout(2000);
    const id = await p0.evaluate(() => document.querySelector('article[data-id]')?.getAttribute('data-id') ?? null);
    await ctx.close();
    if (id) ROUTES = ['', `#/item/${id}`];
  }
  check('PRECONDITION: a live discussion was found to sweep as well as the feed', ROUTES.length === 2, JSON.stringify(ROUTES));
  for (const ROUTE of ROUTES) {
  for (const ts of TEXT_SIZES) {
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
    await page.goto(BASE + (ROUTE ? ROUTE : ''), { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('header', { timeout: 20000 });
    await page.evaluate((size) => window.__hnlens.prefs.getState().setTextSize(size), ts);
    await page.waitForTimeout(600);
    if (ROUTE) {
      await page.waitForSelector('.disc-toolbar', { timeout: 20000 }).catch(() => {});
      // The toolbar's search box lives behind a tool; open it or there is no placeholder to measure.
      await page.evaluate(() => {
        const direct = [...document.querySelectorAll('.disc-toolbar button')].find((b) => /search/i.test(b.getAttribute('aria-label') || ''));
        if (direct) return direct.click();
        document.querySelector('.disc-toolbar button[aria-label="More discussion tools"]')?.click();
      });
      await page.waitForTimeout(250);
      await page.evaluate(() => {
        const mi = [...document.querySelectorAll('[role="menuitem"]')].find((i) => /search/i.test(i.textContent || ''));
        mi?.click();
      });
      await page.waitForTimeout(350);
    }
    const applied = await page.evaluate(() => document.documentElement.dataset.textsize);
    check(`PRECONDITION: reading text size ${ts} is actually applied at ${w}px`, applied === ts, `applied=${applied}`);

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
        // The invariant is that the label is not cut. A small margin on top of that guards the
        // exact-boundary case, where sub-pixel rounding decides it; it is deliberately NOT a large
        // font-variation allowance, because the machine that builds this measures the same string
        // wider than a development machine does, and demanding a wide margin here fails states
        // that render perfectly well.
        return {
          text: text.slice(0, 26), textW: Math.round(textW), avail: Math.round(avail),
          headroom: Math.round(avail - textW), clipped: avail - textW < 4,
          ellipsis: cs.textOverflow === 'ellipsis',
        };
      };
      // EVERY placeholder living in a pinned bar, not just the top nav's. The discussion toolbar's
      // own search box escaped this check by being a different element in a different bar, and was
      // cut mid-word for exactly the reason the top nav's wording was already shortened.
      const barInputs = [...document.querySelectorAll('header input, .disc-toolbar input')].filter(
        (el) => el.offsetParent !== null && el.placeholder,
      );
      const input = document.querySelector('header input');
      const inner = document.querySelector('header')?.firstElementChild;
      return {
        search: fit(input, input?.placeholder ?? ''),
        barPlaceholders: barInputs.map((el) => ({ name: el.getAttribute('aria-label') || 'input', ...fit(el, el.placeholder) })),
        selects: [...document.querySelectorAll('header select')]
          .map((s) => fit(s, s.options[s.selectedIndex]?.text ?? ''))
          .filter(Boolean),
        docOverflow: Math.round(document.documentElement.scrollWidth - document.documentElement.clientWidth),
        headerOverflow: inner ? Math.round(inner.scrollWidth - inner.clientWidth) : 0,
      };
    });

    // Without this the loop can pass at a width where the header rendered nothing to measure.
    check(`PRECONDITION: the header search field is present and measurable at ${w}px/${ts}`, r.search !== null, JSON.stringify(r.search));
    if (r.search) {
      check(`the search placeholder fits its field with room to spare at ${w}px/${ts}`, !r.search.clipped, JSON.stringify(r.search));
    }
    // The two controls are held to DIFFERENT standards, because they fail differently. An input
    // cannot ellipsise its placeholder, so a hard cut is unacceptable at any width or text size and
    // is asserted above for every cell. A select DOES ellipsise, which is a graceful, legible
    // outcome; it is only a defect when the header had room and trimmed anyway. At an enlarged
    // reading size the header genuinely runs out of room, so an ellipsis there is correct
    // behaviour, not a defect, and asserting otherwise would demand space that does not exist.
    // Not asserted per width: at the narrowest sizes this field folds away by design, so demanding
    // it everywhere would fail a correct state. Asserted ONCE across the sweep instead, below,
    // so the field cannot silently go unmeasured either.
    if (r.barPlaceholders.length >= 2) sawToolbarField = true;
    for (const ph of r.barPlaceholders) {
      // A field narrower than this is a SLIVER: flex has given it whatever was left over, its
      // purpose is carried by its icon and its accessible name, and its placeholder ellipsises
      // rather than being sliced. Requiring the wording to fit there would instead force the field
      // to fold away entirely, which just moves the empty space somewhere else in the row.
      const SLIVER = 60;
      if (ph.avail < SLIVER) {
        check(`the "${ph.name}" sliver field at ${w}px/${ts} ellipsises rather than hard-cuts`, ph.ellipsis, JSON.stringify(ph));
        continue;
      }
      check(`the "${ph.name}" placeholder fits its field at ${w}px/${ts}`, !ph.clipped, JSON.stringify(ph));
    }
    if (w >= WIDE && ts === 'md') {
      check(`PRECONDITION: the header shows its selects at ${w}px/${ts}`, r.selects.length >= 2, `visible=${r.selects.length}`);
      for (const s of r.selects) {
        check(`the selected value fits its control with room to spare at ${w}px/${ts}`, !s.clipped, JSON.stringify(s));
      }
    }
    // Bounds the widening: a cap raised too far would simply move the defect into an overflow.
    check(`the header does not overflow at ${w}px/${ts}`, r.docOverflow <= 0 && r.headerOverflow <= 0, JSON.stringify({ docOverflow: r.docOverflow, headerOverflow: r.headerOverflow }));

    await ctx.close();
  }
  }
  }
  check('PRECONDITION: the discussion toolbar text field was measured somewhere in the sweep', sawToolbarField);
} finally {
  await b.close();
}

console.log(`\n${fails.length === 0 ? 'RESULT: HEADER FIT PASS \u2713' : `RESULT: ${fails.length} FAILED`}`);
process.exit(fails.length ? 1 : 0);
