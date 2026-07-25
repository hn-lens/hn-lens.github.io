// Theme-contrast test — the automated form of the "design & theme" review lens. For EVERY
// design (themeName) in BOTH light and dark modes it reads the resolved semantic tokens and
// asserts the key foreground/background pairs meet WCAG contrast, so a theme (or a new one)
// can't ship an illegible link / button / body-text combo. Enumerates the designs from the
// app itself (window.__hnlens.themes().THEME_IDS) so it never drifts from src/lib/themes.ts.
//
// Thresholds: AA 4.5:1 for normal-size text pairs; 3:1 (AA large/secondary) for the smaller,
// deliberately de-emphasized `subtle` metadata and the nested surface-2 tint.
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:4173/';

function parseColor(v) {
  v = (v || '').trim();
  // color(srgb r g b) with 0..1 components — the form color-mix() resolves to (e.g. --edge).
  let m = v.match(/color\(\s*srgb\s+([0-9.]+)\s+([0-9.]+)\s+([0-9.]+)/i);
  if (m) return [m[1], m[2], m[3]].map((x) => Math.round(parseFloat(x) * 255));
  m = v.match(/rgba?\(([^)]+)\)/i);
  if (m) {
    const [r, g, b] = m[1].split(/[,\s/]+/).map(Number);
    return [r, g, b];
  }
  let h = v.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const out = [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  if (out.some((n) => Number.isNaN(n))) throw new Error(`unparseable color: ${v}`); // never silently NaN-pass
  return out;
}
const hexToRgb = parseColor;
const chan = (c) => {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
};
const lum = ([r, g, b]) => 0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b);
function contrast(a, b) {
  const la = lum(a);
  const lb = lum(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const fails = [];
const check = (name, pass, detail = '') => {
  console.log(`  ${pass ? '\u2713' : '\u2717'} ${name}${detail ? ` \u2014 ${detail}` : ''}`);
  if (!pass) fails.push(name);
};

// Pairs that must meet AA 4.5 — all are NORMAL-size text in practice (subtle is used for 12px
// metadata; accent is a link on surface/surface-2/bg panels).
const AA = [
  ['fg', 'surface'],
  ['fg', 'bg'],
  ['muted', 'surface'],
  ['muted', 'bg'],
  ['accent', 'surface'], // accent link on a card
  ['accent', 'surface2'], // accent link on a nested panel (e.g. the "warming up" banner)
  ['accent', 'bg'], // accent link on the page canvas
  ['accentFg', 'accent'], // primary button text
  ['subtle', 'surface'], // 12px metadata (Updated / Refresh / timestamps)
  ['subtle', 'bg'],
  ['muted', 'surface2'], // summary BODY text (.sc-tldr / ThreadGist) sits on the surface-2 tint
];
// 3:1-only (AA large / decorative). `subtle` is the deliberately-faint DECORATIVE token; on the
// raised surface-2 tint it need only clear the non-text 3:1 bar (informative captions/metadata on
// surface-2 use `muted`, guarded at AA above — see the c2r3 fold). This catches a regression where
// a theme's `subtle` drops below 3:1 on surface-2 (would make even decorative glyphs invisible).
const SECONDARY = [['subtle', 'surface2']];
// NON-TEXT / UI-COMPONENT contrast (WCAG 1.4.11, ≥3:1): the interactive-control edge must be
// visible against the surfaces controls sit on, so buttons/toggles/inputs/pills don't melt into
// the page even where --border is a hairline. (Active states use accent, covered by AA above.)
const COMPONENT = [
  ['edge', 'surface'],
  ['edge', 'bg'],
  ['edge', 'surface2'], // .seg track border + the At-a-glance bar-chart ring sit on surface-2
];

const b = await chromium.launch({ headless: true });
const page = await b.newPage();
// A REALISTIC fixture, not `{}`. The rendered-DOM pass below grades the text actually painted, so a
// mock that returns an empty object renders zero story cards and zero comments — it was grading ~12
// nodes on the feed and ~11 on a discussion (page chrome only) while reporting a clean sweep across
// 31 designs. The surfaces that carry almost all of this app's text were simply never on screen.
const NOW = Math.floor(Date.now() / 1000);
const STORY_IDS = Array.from({ length: 25 }, (_, i) => 9000 + i);
const story = (id) => ({
  id,
  type: 'story',
  title: `Contrast fixture story ${id} — a realistic headline of about the usual length`,
  url: `https://example${id % 7}.com/a/path/to/the/article`,
  by: `author${id % 9}`,
  score: 40 + (id % 60),
  descendants: 5 + (id % 40),
  time: NOW - (id % 48) * 3600,
  kids: [id * 10 + 1, id * 10 + 2],
});
const comment = (id, depth) => ({
  id,
  author: `commenter${id % 11}`,
  text: `<p>A realistic comment body at depth ${depth}, long enough to wrap onto more than one line and exercise the reading surface.</p>`,
  created_at_i: NOW - (id % 24) * 3600,
  children: depth < 2 ? [{ id: id * 10 + 1, author: `replier${id % 5}`, text: '<p>A shorter reply.</p>', created_at_i: NOW - 600, children: [] }] : [],
});
await page.route(/hacker-news\.firebaseio\.com|hn\.algolia\.com|google\.com\/s2/, (r) => {
  const u = r.request().url();
  const json = (b) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
  if (/s2\/favicons/.test(u)) return r.fulfill({ status: 200, contentType: 'image/png', body: '' });
  if (/(top|new|best|ask|show|job)stories/.test(u)) return json(STORY_IDS);
  if (/maxitem/.test(u)) return json(STORY_IDS[STORY_IDS.length - 1]);
  const item = /\/item\/(\d+)/.exec(u);
  if (item && /firebaseio/.test(u)) return json(story(Number(item[1])));
  if (/algolia.*items\/(\d+)/.test(u)) {
    const id = Number(/items\/(\d+)/.exec(u)[1]);
    // Several top-level comments, each with a reply: a discussion is the app's densest reading
    // surface, so the fixture has to actually populate it or the pass grades page chrome.
    return json({
      ...story(id),
      // 10 top-level, each with one reply = 20 comments. The previous 8 yielded exactly 14, one
      // short of the >=15 threshold that makes the heuristic thread digest appear — so the digest was
      // structurally unreachable by this guard and a contrast defect inside it went unseen for
      // rounds. A fixture that lands one item below a feature's activation threshold silently
      // removes that feature from the audit.
      children: Array.from({ length: 10 }, (_, k) => comment(id * 10 + 3 + k, k % 3)),
    });
  }
  if (/algolia/.test(u)) return json({ hits: STORY_IDS.slice(0, 5).map((id) => ({ objectID: String(id), ...story(id) })) });
  return json({});
});
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__hnlens && window.__hnlens.prefs && window.__hnlens.themes, null, { timeout: 20000 });

const designs = await page.evaluate(() => window.__hnlens.themes().THEME_IDS);
check('enumerated the full design list from the app', Array.isArray(designs) && designs.length >= 25, `${designs?.length} designs`);

const aaFails = [];
const secFails = [];
const compFails = [];
for (const d of designs) {
  for (const mode of ['light', 'dark']) {
    const tok = await page.evaluate(
      ({ d, mode }) => {
        const s = window.__hnlens.prefs.getState();
        s.setThemeName(d);
        s.setTheme(mode);
        const cs = getComputedStyle(document.documentElement);
        const g = (n) => cs.getPropertyValue(n).trim();
        // --edge is a color-mix(); read its RESOLVED color by applying it to a real property.
        const probe = document.createElement('span');
        probe.style.color = 'var(--edge)';
        document.documentElement.appendChild(probe);
        const edge = getComputedStyle(probe).color;
        probe.remove();
        return { bg: g('--bg'), surface: g('--surface'), surface2: g('--surface-2'), fg: g('--fg'), muted: g('--muted'), subtle: g('--subtle'), accent: g('--accent'), accentFg: g('--accent-fg'), edge };
      },
      { d, mode }
    );
    const rgb = (k) => (tok[k] ? hexToRgb(tok[k]) : null);
    const eval1 = (pairs, min, sink) => {
      for (const [fg, bg] of pairs) {
        const a = rgb(fg);
        const c = rgb(bg);
        if (!a || !c) continue;
        const ratio = contrast(a, c);
        if (ratio < min) sink.push(`${d}/${mode} ${fg}-on-${bg}=${ratio.toFixed(2)}(<${min})`);
      }
    };
    eval1(AA, 4.5, aaFails);
    eval1(SECONDARY, 3.0, secFails);
    eval1(COMPONENT, 3.0, compFails);
  }
}

console.log(`[theme-contrast] ${designs.length} designs \u00d7 2 modes checked`);
if (aaFails.length) console.log('AA (4.5) failures:\n  ' + aaFails.join('\n  '));
if (secFails.length) console.log('secondary (3:1) failures:\n  ' + secFails.join('\n  '));
if (compFails.length) console.log('component/non-text (3:1) failures:\n  ' + compFails.join('\n  '));
check('all primary text pairs meet WCAG AA (4.5:1) in every design \u00d7 mode', aaFails.length === 0, `${aaFails.length} failing`);
check('all secondary text pairs meet 3:1 in every design \u00d7 mode', secFails.length === 0, `${secFails.length} failing`);
check('interactive-control edge meets non-text 3:1 (WCAG 1.4.11) in every design \u00d7 mode', compFails.length === 0, `${compFails.length} failing`);

// ---------------------------------------------------------------------------------------------
// RENDERED-DOM pass. Everything above checks TOKEN pairs — it can prove `--subtle` is legible where
// `--subtle` is supposed to be used, but it cannot see which token a COMPONENT actually chose. That
// gap shipped a whole class of defects: informative text (a collapsed reply pill's repliers preview,
// the Settings->Data stat read just before an irreversible Delete, the kbd chips, the reader-proxy
// ordinals, story metadata once :hover raises the row onto surface-2) was written in the deliberately
// faint DECORATIVE token and measured as low as 3.80 against a 4.5 requirement, in 17 of 31 designs —
// while this guard reported everything green, because every pair it was told about did pass.
//
// So measure what is actually PAINTED: walk the rendered text nodes, composite the real background by
// walking up until a non-transparent ancestor, and grade the pair. Single glyphs and separators
// ("·", "←", arrows) are excluded — those are the genuinely decorative use `--subtle` exists for.
//
// Scan several ROUTES, not just the feed: the sites this class hides in are the Settings data rows,
// a discussion's collapsed reply pills, and the keyboard-help dialog. A feed-only scan reported a
// clean sweep while five of the six known-bad sites were simply not on screen.
// Kill CSS transitions for the whole rendered pass. Several controls carry `transition-colors`, so
// reading getComputedStyle immediately after flipping the theme samples INTERPOLATED mid-flight
// colors — which produced the most alarming number in the whole report (an "unreadable" 1.00 on the
// active Settings tab) by pairing the OLD theme's foreground with the NEW theme's background. The
// element was perfectly legible; only the measurement was wrong. Sleeping would also work but is
// slower and still racy.
await page.addStyleTag({
  content: '*,*::before,*::after{transition:none!important;animation:none!important}',
});
const ROUTES = [
  ['feed', '#/'],
  ['settings', '#/settings'],
  ['discussion', '#/item/1'],
];
const renderFails = [];
const gradedPerRoute = {};
for (const [routeName, hash] of ROUTES) {
  await page.evaluate((h) => { window.location.hash = h; }, hash);
  await page.waitForTimeout(700);
  // Expand collapsed disclosures so their text is actually graded. The thread digest is collapsed by
  // default, which is the second reason its contrast defect was invisible here: unreachable fixture
  // AND unopened panel.
  await page
    .evaluate(() => {
      for (const d of document.querySelectorAll('details')) d.open = true;
      for (const b of document.querySelectorAll('button[aria-expanded="false"]')) b.click();
    })
    .catch(() => {});
  await page.waitForTimeout(500);
  for (const d of designs) {
  for (const mode of ['light', 'dark']) {
    const res = await page.evaluate(
      ({ d, mode }) => {
        const s = window.__hnlens.prefs.getState();
        s.setThemeName(d);
        s.setTheme(mode);
        // Resolve ANY CSS color via a 1x1 canvas rather than a regex. Modern Tailwind emits
        // `oklab(... / 0.15)` for an alpha tint like `bg-accent/15`, which an rgb()-only regex
        // cannot read — and the old code treated unreadable as "no background", so `bgOf` walked
        // past every layer and fell back to white. Against a DARK theme's light foreground that
        // fabricated a 1.01 ratio out of nothing and pointed at a control that was perfectly
        // legible. Canvas handles oklab/oklch/color()/named/hex uniformly.
        const cv = document.createElement('canvas');
        cv.width = cv.height = 1;
        const cx = cv.getContext('2d', { willReadFrequently: true });
        let unresolved = 0;
        const parse = (c) => {
          if (!c) return null;
          if (c === 'transparent' || c === 'none') return { r: 0, g: 0, b: 0, a: 0 };
          // fillStyle keeps its previous value when handed something invalid — use two different
          // sentinels so a color that merely EQUALS one sentinel isn't misread as a failure.
          cx.fillStyle = '#000000';
          cx.fillStyle = c;
          const first = cx.fillStyle;
          cx.fillStyle = '#ffffff';
          cx.fillStyle = c;
          if (cx.fillStyle !== first) { unresolved++; return null; }
          cx.globalCompositeOperation = 'copy';
          cx.fillStyle = c;
          cx.fillRect(0, 0, 1, 1);
          const d = cx.getImageData(0, 0, 1, 1).data;
          return { r: d[0], g: d[1], b: d[2], a: d[3] / 255 };
        };
        const lum = ({ r, g, b }) => {
          const f = (v) => {
            const x = v / 255;
            return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
          };
          return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
        };
        const ratio = (x, y) => {
          const a = lum(x), b2 = lum(y);
          return (Math.max(a, b2) + 0.05) / (Math.min(a, b2) + 0.05);
        };
        // Composite the effective background by walking ancestors until something is opaque enough.
        // Standard source-over compositing, front (nearest ancestor) to back, accumulating
        // PREMULTIPLIED and un-premultiplying at the end. Getting this wrong is not a small error:
        // an earlier version mixed premultiplied and straight alpha, which was exact for opaque
        // backgrounds but produced nonsense for any alpha tint (a `bg-accent/15` row reported a
        // 1.01 ratio). A guard that computes a WRONG number is worse than no guard, because it
        // sends you fixing something that isn't broken while hiding what is.
        const bgOf = (el) => {
          let n = el;
          const acc = { r: 0, g: 0, b: 0, a: 0 };
          while (n && n !== document.documentElement.parentElement) {
            const c = parse(getComputedStyle(n).backgroundColor);
            if (c && c.a > 0) {
              const k = 1 - acc.a;
              acc.r += c.r * c.a * k;
              acc.g += c.g * c.a * k;
              acc.b += c.b * c.a * k;
              acc.a += c.a * k;
              if (acc.a >= 0.99) break;
            }
            n = n.parentElement;
          }
          if (acc.a <= 0) return { r: 255, g: 255, b: 255 };
          // Any residual transparency composites over the canvas, which is opaque in practice.
          return { r: acc.r / acc.a, g: acc.g / acc.a, b: acc.b / acc.a };
        };
        const out = [];
        let graded = 0;
        for (const el of document.querySelectorAll('body *')) {
          if (el.children.length) continue; // leaf text only
          const t = (el.textContent || '').trim();
          // Skip decoration: separators, single glyphs, and icon-only nodes.
          if (t.length < 3) continue;
          if (!/[a-z0-9]/i.test(t)) continue;
          const cs = getComputedStyle(el);
          if (cs.visibility === 'hidden' || cs.display === 'none' || parseFloat(cs.opacity) < 0.5) continue;
          const r = el.getBoundingClientRect();
          if (r.width < 2 || r.height < 2) continue;
          const fg = parse(cs.color);
          if (!fg) continue;
          const size = parseFloat(cs.fontSize);
          const weight = Number(cs.fontWeight) || 400;
          // WCAG "large text" = >=24px, or >=18.66px bold.
          const large = size >= 24 || (size >= 18.66 && weight >= 700);
          const need = large ? 3.0 : 4.5;
          graded++;
          const got = ratio(fg, bgOf(el));
          if (got < need - 0.01) out.push(`${t.slice(0, 28).replace(/\s+/g, ' ')} ${got.toFixed(2)}<${need}`);
        }
        return { bad: out.slice(0, 6), unresolved, graded };
      },
      { d, mode }
    );
    if (res.unresolved) renderFails.push(`${routeName} ${d}/${mode} "UNRESOLVABLE COLOR x${res.unresolved} 0<4.5"`);
    gradedPerRoute[routeName] = Math.max(gradedPerRoute[routeName] ?? 0, res.graded);
    const bad = res.bad;
    for (const x of bad) renderFails.push(`${routeName} ${d}/${mode} "${x}"`);
  }
  }
}
if (renderFails.length) {
  // Group by the offending TEXT, not by theme: one bad token choice in one component shows up in
  // dozens of design x mode cells, and a flat list buries how few distinct SITES are actually wrong.
  const byText = new Map();
  for (const f of renderFails) {
    const m = /"(.+?) (\d+\.\d+)<([\d.]+)"$/.exec(f);
    const key = m ? m[1] : f;
    const e = byText.get(key) ?? { n: 0, worst: Infinity, need: m ? m[3] : '?', where: f.split(' ')[0] };
    e.n++;
    if (m && Number(m[2]) < e.worst) e.worst = Number(m[2]);
    byText.set(key, e);
  }
  const rows = [...byText.entries()].sort((a, b) => a[1].worst - b[1].worst);
  console.log(`RENDERED text failures: ${renderFails.length} cells across ${rows.length} distinct texts`);
  for (const [text, e] of rows.slice(0, 25)) {
    console.log(`  [${e.where}] "${text}" worst=${e.worst.toFixed(2)} need=${e.need} (${e.n} cells)`);
  }
}
console.log('[theme-contrast] rendered nodes graded per route:', JSON.stringify(gradedPerRoute));
// A rendered pass that grades nothing is not a pass. With an empty API mock the feed and discussion
// rendered page chrome only (~12 and ~11 nodes) and this check reported a clean sweep across all 31
// designs while the surfaces carrying almost all the app's text were never on screen.
const MIN_GRADED = { feed: 80, settings: 60, discussion: 40 };
const thin = Object.entries(MIN_GRADED).filter(([r, min]) => (gradedPerRoute[r] ?? 0) < min);
check(
  'the rendered pass actually graded real content on every route (fixture is not empty)',
  thin.length === 0,
  thin.length ? thin.map(([r, min]) => `${r}=${gradedPerRoute[r] ?? 0}<${min}`).join(' ') : JSON.stringify(gradedPerRoute)
);
check(
  'every RENDERED text element meets its WCAG bar in every design \u00d7 mode',
  renderFails.length === 0,
  `${renderFails.length} failing`
);

await b.close();
console.log(`\n${fails.length === 0 ? 'RESULT: THEME CONTRAST PASS \u2713' : `RESULT: ${fails.length} FAILED`}`);
process.exit(fails.length ? 1 : 0);
