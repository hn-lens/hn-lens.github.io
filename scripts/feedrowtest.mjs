// The FEED's own control row keeps to one row — sibling of `wrapqualitytest`, which measures the
// same class on the DISCUSSION band (SPEC 9a criterion 10: "a row of controls occupies one row,
// with no empty stretch inside it, at every width").
//
// The feed's meta row holds a freshness status on the left and the Top-comments switch + Refresh on
// the right, under `justify-between`. Because the row was `flex-wrap`, the browser wrapped the pair
// onto two lines rather than shrinking the status text: at 320/360 the first line carried only
// "Updated just now" at 30-38% fill with the two controls orphaned beneath it. Page overflow is 0
// throughout, so no overflow guard can see this — the SHAPE of the row is the only thing that can.
//
// The text-size axis is swept because that is this defect class's signature (see R-23): rem-sized
// content in a row whose wrap behaviour was never budgeted for it, so Large reading text pushes the
// wrap out to widths that look clean at the default size.
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:4173/';
const fails = [];
const check = (name, pass, detail = '') => {
  console.log(`  ${pass ? '\u2713' : '\u2717'} ${name}${detail ? ` \u2014 ${detail}` : ''}`);
  if (!pass) fails.push(name);
};

const WIDTHS = [320, 340, 360, 375, 390, 414, 440];
const TEXT = ['md', 'lg'];
const FEEDS = ['foryou', 'top'];

let measuredCells = 0;

const b = await chromium.launch({ headless: true });
try {
  for (const feed of FEEDS) {
    for (const ts of TEXT) {
      for (const w of WIDTHS) {
        const ctx = await b.newContext({
          viewport: { width: w, height: 780 },
          isMobile: true,
          hasTouch: true,
        });
        const page = await ctx.newPage();
        await page.addInitScript(
          (t) => {
            try {
              localStorage.setItem('hn:onboard', 'skip');
              const raw = localStorage.getItem('hn:prefs');
              const o = raw ? JSON.parse(raw) : { state: {}, version: 0 };
              o.state = { ...(o.state || {}), textSize: t };
              localStorage.setItem('hn:prefs', JSON.stringify(o));
            } catch {
              /* private mode */
            }
          },
          ts,
        );
        await page.goto(`${BASE}#/?feed=${feed}`, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('article[data-id]', { timeout: 45000 }).catch(() => {});
        // The freshness status is asserted below, so wait for it to actually render rather than
        // racing it — an empty status would otherwise read as "the fix deleted the label".
        await page
          .waitForFunction(() => (document.querySelector('.feed-meta-status')?.textContent || '').trim().length > 0, {
            timeout: 15000,
          })
          .catch(() => {});
        await page.waitForTimeout(1600);

        const r = await page.evaluate(() => {
          const band = document.querySelector('.feed-meta');
          const cards = document.querySelectorAll('article[data-id]').length;
          if (!band) return { found: false, cards };
          // `display: contents` wrappers are not layout boxes; their children are the real flex
          // items. Reading `.children` alone reports a row that is not the one being painted.
          const flatten = (node) => {
            const out = [];
            for (const el of node.children) {
              if (getComputedStyle(el).display === 'contents') out.push(...flatten(el));
              else out.push(el);
            }
            return out;
          };
          const items = flatten(band).filter((el) => {
            const bb = el.getBoundingClientRect();
            return bb.width > 0 && bb.height > 0 && getComputedStyle(el).visibility !== 'hidden';
          });
          const rows = [];
          for (const el of items) {
            const bb = el.getBoundingClientRect();
            const cy = bb.top + bb.height / 2;
            let row = rows.find((rw) => Math.abs(rw.cy - cy) < 8);
            if (!row) {
              row = { cy, labels: [] };
              rows.push(row);
            }
            row.labels.push((el.textContent || '').trim().slice(0, 20));
          }
          const status = band.querySelector('.feed-meta-status');
          const sb = status?.getBoundingClientRect();
          // The Top-comments control must survive the fix that keeps the row on one line: folding
          // its word is allowed, removing the control is not.
          const toggle = band.querySelector('[role="switch"]');
          const tb = toggle?.getBoundingClientRect();
          const name = toggle
            ? (toggle.getAttribute('aria-label') || toggle.getAttribute('title') || toggle.textContent || '').trim()
            : '';
          // Criterion 6. This viewport is 780px tall, so the full 44px floor applies — the 36px
          // relaxation is only for screens under ~500px.
          const targets = [...band.querySelectorAll('button')].map((el) => ({
            name: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 18),
            h: +el.getBoundingClientRect().height.toFixed(2),
          }));
          return {
            found: true,
            cards,
            rows: rows.length,
            rowLabels: rows.map((rw) => rw.labels.join('|')),
            statusW: sb ? Math.round(sb.width) : null,
            statusText: (status?.textContent || '').trim(),
            toggleVisible: !!tb && tb.width > 0 && tb.height > 0,
            toggleNamed: name.length > 0,
            targets,
            overflow: Math.round(document.documentElement.scrollWidth - document.documentElement.clientWidth),
          };
        });

        const tag = `${feed}/${ts}@${w}`;
        // Without cards and a band on screen every assertion below would measure an empty page and
        // pass, which is how a guard certifies a live defect as fixed.
        check(`PRECONDITION ${tag}: feed rendered and the meta row exists`, r.found && r.cards > 0, JSON.stringify({ found: r.found, cards: r.cards }));
        if (!r.found || !r.cards) {
          await ctx.close();
          continue;
        }
        measuredCells += 1;

        check(`${tag}: the meta row is ONE row`, r.rows === 1, `${r.rows} row(s) ${JSON.stringify(r.rowLabels)}`);
        // Opposite case: keeping one row must not be bought by pushing the page sideways.
        check(`${tag}: the page does not scroll horizontally`, r.overflow <= 0, `overflow=${r.overflow}`);
        // Opposite case: nor by deleting the status text outright.
        check(
          `${tag}: the freshness status is still painted`,
          typeof r.statusW === 'number' && r.statusW > 0 && r.statusText.length > 0,
          `w=${r.statusW} text=${JSON.stringify(r.statusText)}`,
        );
        // Opposite case: nor by dropping the control whose label folded.
        check(
          `${tag}: the Top-comments control is present and still has an accessible name`,
          r.toggleVisible && r.toggleNamed,
          JSON.stringify({ visible: r.toggleVisible, named: r.toggleNamed }),
        );
        // A row that fits on one line by being too small to hit is not a fix. An unmeasurable
        // height must fail rather than sail through a `<` comparison as NaN.
        const short = r.targets.filter((t) => !Number.isFinite(t.h) || t.h < 44);
        check(
          `${tag}: every control in the row is at least 44px tall`,
          r.targets.length > 0 && short.length === 0,
          `${r.targets.length} control(s), under-floor: ${JSON.stringify(short)}`,
        );
        await ctx.close();
      }
    }
  }
  // A sweep that measured nothing is not evidence.
  check(
    `PRECONDITION: the sweep actually measured its cells`,
    measuredCells === WIDTHS.length * TEXT.length * FEEDS.length,
    `${measuredCells} of ${WIDTHS.length * TEXT.length * FEEDS.length}`,
  );

  // The `compact` layout is the narrowest and is the DEFAULT of the terminal and cyberpunk designs,
  // so it is reached with no non-default setting. It is also the only layout where the Top-comments
  // control is inoperative, which is what puts an explanation next to it. Both states have already
  // shipped broken here: the row overflowed the PAGE when the explanation sat inside it, and the
  // explanation was invisible on a phone when it was folded away instead. Measuring the row's OWN
  // box as well as the page, because a row can overflow itself while the page reports 0.
  for (const ts of ['md', 'lg']) {
    for (const w of [320, 360]) {
      const ctx = await b.newContext({ viewport: { width: w, height: 780 }, isMobile: true, hasTouch: true });
      const page = await ctx.newPage();
      await page.addInitScript(
        (t) => {
          try {
            localStorage.setItem('hn:onboard', 'skip');
            const raw = localStorage.getItem('hn:prefs');
            const o = raw ? JSON.parse(raw) : { state: {}, version: 0 };
            o.state = { ...(o.state || {}), textSize: t, layout: 'compact', showTopComments: true };
            localStorage.setItem('hn:prefs', JSON.stringify(o));
          } catch {
            /* private mode */
          }
        },
        ts,
      );
      await page.goto(`${BASE}#/?feed=top`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('article[data-id]', { timeout: 45000 }).catch(() => {});
      await page.waitForTimeout(1600);
      const r = await page.evaluate(() => {
        const band = document.querySelector('.feed-meta');
        if (!band) return { found: false };
        const toggle = band.querySelector('[role="switch"]');
        const note = [...document.querySelectorAll('p')].find((p) => /aren.t shown in the Compact layout/i.test(p.textContent || ''));
        const nb = note?.getBoundingClientRect();
        return {
          found: true,
          unavailable: !!toggle && toggle.hasAttribute('disabled'),
          shownOn: toggle?.getAttribute('aria-checked') === 'true',
          notePainted: !!nb && nb.width > 0 && nb.height > 0,
          selfOverflow: Math.round(band.scrollWidth - band.clientWidth),
          pageOverflow: Math.round(document.documentElement.scrollWidth - document.documentElement.clientWidth),
        };
      });
      const tag = `compact/${ts}@${w}`;
      check(`PRECONDITION ${tag}: the meta row exists`, r.found, JSON.stringify(r));
      if (!r.found) {
        await ctx.close();
        continue;
      }
      // If the control were not actually inoperative-and-on here, the explanation check below would
      // be asserting nothing at all.
      check(
        `PRECONDITION ${tag}: the Top-comments control is inoperative but drawn on`,
        r.unavailable && r.shownOn,
        JSON.stringify({ unavailable: r.unavailable, shownOn: r.shownOn }),
      );
      check(`${tag}: the row does not overflow its own box`, r.selfOverflow <= 0, `selfOverflow=${r.selfOverflow}`);
      check(`${tag}: the page does not scroll horizontally`, r.pageOverflow <= 0, `pageOverflow=${r.pageOverflow}`);
      check(
        `${tag}: the reason the control reads as on is visible on screen`,
        r.notePainted,
        `notePainted=${r.notePainted}`,
      );
      await ctx.close();
    }
  }
} finally {
  await b.close();
}

console.log(`\n${fails.length === 0 ? 'RESULT: FEED ROW PASS \u2713' : `RESULT: ${fails.length} FAILED`}`);
process.exit(fails.length ? 1 : 0);
