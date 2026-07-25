// Switch-control RENDERING guard (WCAG 1.4.11 non-text component contrast).
//
// Both switches in the app — the feed-header "Top comments" toggle (Feed.tsx) and the Settings
// `Toggle` (controls.tsx) — now share ONE presentational recipe (`SwitchVisual`). This test renders
// the REAL controls and MEASURES, for reader light AND dark, in BOTH states, that:
//   • the track BORDER is ≥3:1 vs the surface behind it (so the control is visible AS a control,
//     even when the track fill is intentionally subtle), and
//   • the THUMB is ≥3:1 vs the track fill (so ON vs OFF is unambiguous).
// This is the exact class a screenshot-first UI/UX review caught by eye (a white-thumb-on-white
// Settings toggle at 1.00:1, and a washed-out feed toggle); this guard makes it a hard gate so a
// future regression to a non-token color (e.g. `bg-white`, transparent border) fails CI.
//
// Hermetic: mocked firebase so the feed header renders, chromium, no WebGPU.
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:4173/';
const now = Math.floor(Date.now() / 1000);
const STORY_IDS = [4100, 4101];
const mkStory = (id) => ({
  id, type: 'story', by: `op${id}`, title: `Story ${id}`, url: `https://d${id}.example/x`,
  score: 120, descendants: 0, time: now - 90000, kids: [],
});

// --- WCAG contrast (parses rgb()/rgba() AND color(srgb …); THROWS on anything else so it can
// never silently NaN-pass — the lesson from the theme-contrast guard) ---
function parseColor(s) {
  s = String(s).trim();
  let m = s.match(/^rgba?\(([^)]+)\)/);
  if (m) {
    const p = m[1].split(/[,/\s]+/).filter(Boolean).map(Number);
    return [p[0], p[1], p[2]];
  }
  m = s.match(/^color\(srgb\s+([^)]+)\)/);
  if (m) {
    const p = m[1].split(/[/\s]+/).filter(Boolean).map(Number);
    return [p[0] * 255, p[1] * 255, p[2] * 255];
  }
  throw new Error(`unparseable color: ${s}`);
}
function lum([r, g, b]) {
  const f = (c) => {
    c /= 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function contrast(a, b) {
  const la = lum(parseColor(a));
  const lb = lum(parseColor(b));
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}
// Parse a color WITH its alpha (rgba()/color(srgb …/a)); THROWS on anything else.
function parseColorA(s) {
  s = String(s).trim();
  let m = s.match(/^rgba?\(([^)]+)\)/);
  if (m) {
    const p = m[1].split(/[,/\s]+/).filter(Boolean).map(Number);
    return [p[0], p[1], p[2], p[3] ?? 1];
  }
  m = s.match(/^color\(srgb\s+([^)]+)\)/);
  if (m) {
    const p = m[1].split(/[/\s]+/).filter(Boolean).map(Number);
    return [p[0] * 255, p[1] * 255, p[2] * 255, p[3] ?? 1];
  }
  throw new Error(`unparseable color: ${s}`);
}
// Composite a possibly-translucent color OVER an opaque backdrop → the actual visible rgb. A tinted
// control border (`border-red-500/40` → rgba(239,68,68,0.4)) is far weaker vs its surface than its
// opaque hue suggests, so it MUST be composited before measuring 1.4.11 contrast (a plain rgb parse
// that drops alpha over-estimates it and hides the failure).
function compositeOver(fg, bgStr) {
  const [r, g, b, a] = parseColorA(fg);
  if (a >= 1) return `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})`;
  const [br, bgc, bb] = parseColor(bgStr);
  return `rgb(${Math.round(r * a + br * (1 - a))}, ${Math.round(g * a + bgc * (1 - a))}, ${Math.round(b * a + bb * (1 - a))})`;
}

const fails = [];
const check = (name, ratio, detail = '') => {
  const pass = ratio >= 3;
  console.log(`  ${pass ? '\u2713' : '\u2717'} ${name} — ${ratio.toFixed(2)}:1${detail ? ` (${detail})` : ''}`);
  if (!pass) fails.push(`${name} (${ratio.toFixed(2)}:1)`);
};

const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ viewport: { width: 1100, height: 900 } });
const page = ctx.pages()[0] || (await ctx.newPage());

await page.route(/hacker-news\.firebaseio\.com/, (r) => {
  const u = r.request().url();
  const j = (x) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(x) });
  if (u.includes('/topstories.json')) return j(STORY_IDS);
  for (const ep of ['beststories', 'newstories', 'askstories', 'showstories', 'jobstories']) if (u.includes(`/${ep}.json`)) return j([]);
  const m = u.match(/item\/(\d+)/);
  if (m) return j(STORY_IDS.includes(Number(m[1])) ? mkStory(Number(m[1])) : null);
  if (u.includes('/user/')) return j({ id: 'x', karma: 1, created: now });
  if (u.includes('maxitem')) return j(9999);
  return j(null);
});
await page.route(/hn\.algolia\.com/, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ nbHits: 0, hits: [] }) }));
await page.route(/google\.com\/s2\/favicons|gstatic\.com\/faviconV2/, (r) => r.fulfill({ status: 200, body: '' }));

// Measure a role=switch element's track border vs the surface behind it, and thumb vs track fill.
const measure = (sw) =>
  sw.evaluate((el) => {
    const withBorder = [...el.querySelectorAll('span')].find(
      (s) => parseFloat(getComputedStyle(s).borderTopWidth) > 0
    );
    const track = withBorder || el.querySelector('span');
    const thumb = track.querySelector('span');
    const cg = getComputedStyle(track);
    let p = el.parentElement;
    let behind = 'rgb(255, 255, 255)';
    while (p) {
      const bg = getComputedStyle(p).backgroundColor;
      if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') {
        behind = bg;
        break;
      }
      p = p.parentElement;
    }
    return {
      border: cg.borderTopColor,
      trackBg: cg.backgroundColor,
      thumbBg: getComputedStyle(thumb).backgroundColor,
      behind,
      checked: el.getAttribute('aria-checked'),
    };
  });

const setTheme = async (mode) => {
  // Use the store's setTheme/setThemeName ACTIONS — the plain `set({theme})` updates state but does
  // NOT toggle the <html>.dark class (that side-effect lives in setTheme), which would make a dark
  // run silently measure LIGHT and falsely pass.
  await page.evaluate((m) => {
    const s = window.__hnlens.prefs.getState();
    s.setThemeName('reader');
    s.setTheme(m);
  }, mode);
  await page.waitForTimeout(150);
  const dark = await page.evaluate(() => document.documentElement.classList.contains('dark'));
  if (dark !== (mode === 'dark')) throw new Error(`theme "${mode}" did not apply (.dark=${dark})`);
};

async function checkSwitch(labelPrefix, sw) {
  const m = await measure(sw);
  const state = m.checked === 'true' ? 'ON' : 'OFF';
  check(`${labelPrefix} ${state}: border vs surface`, contrast(m.border, m.behind));
  check(`${labelPrefix} ${state}: thumb vs track`, contrast(m.thumbBg, m.trackBg));
}

for (const mode of ['light', 'dark']) {
  console.log(`\n===== reader ${mode} =====`);

  // ---- Feed "Top comments" switch (sm) ----
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__hnlens && window.__hnlens.prefs, null, { timeout: 20000 });
  await page.evaluate(() => window.__hnlens.prefs.getState().set({ defaultFeed: 'top', showTopComments: false }));
  await setTheme(mode);
  await page.getByRole('button', { name: 'Top', exact: true }).click();
  await page.waitForSelector('article[data-id="4100"]', { timeout: 15000 });
  const feedSw = page.getByRole('switch', { name: /Top comments/i });
  await checkSwitch('feed', feedSw); // OFF
  await feedSw.click();
  await page.waitForTimeout(200);
  await checkSwitch('feed', feedSw); // ON

  // ---- Settings Toggle (md) ----
  await page.goto(BASE + '#/settings', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__hnlens && window.__hnlens.prefs, null, { timeout: 20000 });
  await setTheme(mode);
  await page.waitForSelector('[role=switch]', { timeout: 15000 });
  const setSw = page.getByRole('switch').first();
  await setSw.scrollIntoViewIfNeeded();
  await checkSwitch('settings', setSw); // whichever state
  await setSw.click();
  await page.waitForTimeout(200);
  await checkSwitch('settings', setSw); // flipped

  // ---- Bordered CONTROLS (fields AND buttons) must be visible AS controls (WCAG 1.4.11) ----
  // A field/button with no fill is delineated ONLY by its border, so that border must be >=3:1 vs its
  // surface. Two classes the design lens caught: (a) form fields drawing `border-border` (the
  // ~1.1-1.6:1 decorative hairline) instead of `border-edge`; (b) bordered <button>s drawing a TINTED
  // palette border (`border-red-500/40`, `border-accent/40`) that composites <3:1. Enumerate every
  // real field AND bordered button on Settings (skip range sliders / checkboxes / switches — checked
  // above or borderless) and assert the COMPOSITED border ≥3:1. Card/section CONTAINERS keep the
  // subtle border-border and are not interactive, so they're not walked.
  const fields = await page.evaluate(() => {
    // A solid, parseable backdrop (skip transparent AND translucent alpha-composited colors — the
    // sticky TopNav uses `bg-bg/85` which computes to oklab(.../0.85); we want the opaque surface
    // BEHIND the field, and our contrast parser handles rgb()/color(srgb), not oklab).
    const solid = (bg) =>
      !!bg &&
      bg !== 'transparent' &&
      bg !== 'rgba(0, 0, 0, 0)' &&
      !bg.includes('oklab') &&
      !bg.includes('oklch') &&
      !/rgba\([^)]*,\s*(0|0?\.\d+)\)\s*$/.test(bg) &&
      !/\/\s*(0|0?\.\d+)\s*\)/.test(bg);
    const els = [...document.querySelectorAll('input:not([type=range]):not([type=checkbox]), select, textarea, button:not([role=switch]):not([role=checkbox]), a[role=button]')]
      .filter((el) => !el.closest('header')); // skip the sticky TopNav search; check page controls
    return els.map((el) => {
      const cg = getComputedStyle(el);
      let p = el.parentElement;
      let behind = 'rgb(255, 255, 255)';
      while (p) {
        if (solid(getComputedStyle(p).backgroundColor)) {
          behind = getComputedStyle(p).backgroundColor;
          break;
        }
        p = p.parentElement;
      }
      return {
        tag: el.tagName.toLowerCase(),
        aria: (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.textContent || '').trim().slice(0, 22),
        border: cg.borderTopColor,
        bw: parseFloat(cg.borderTopWidth),
        behind,
      };
    }).filter((f) => f.bw > 0);
  });
  if (fields.length === 0) {
    console.log('  \u2717 Settings exposes bordered controls to check');
    fails.push('no bordered controls found on Settings');
  } else {
    console.log(`  (checking ${fields.length} bordered controls: fields + buttons)`);
  }
  for (const f of fields) {
    // Composite a tinted (/N alpha) border over its surface BEFORE measuring — a bordered <button>
    // drawing `border-<palette>/N` instead of the control-grade `border-edge` fails here.
    check(`control <${f.tag}> "${f.aria}": border vs surface`, contrast(compositeOver(f.border, f.behind), f.behind));
  }
}


// `check` in this file grades a CONTRAST RATIO; this guard is boolean, so it needs its own helper.
const okCheck = (name, pass, detail = '') => {
  console.log(`  ${pass ? '\u2713' : '\u2717'} ${name}${detail ? ` \u2014 ${detail}` : ''}`);
  if (!pass) fails.push(name);
};

// --- A THEME TREATMENT MUST NOT ERASE THE CONTROL BOUNDARY (WCAG 1.4.11) ---
// Regression for: `bento`'s neumorphic tile rule targeted the Tailwind utility `.bg-surface`, which
// is also the FILL of the shared control recipe (`border border-edge bg-surface`) — so it stripped
// the control-grade `--edge` border from ~26 controls (both TopNav selects, search inputs, every
// inactive feed tab, all Settings selects/textareas, Load more): measured 1.00:1 border in BOTH
// modes, i.e. invisible AS controls. Focus didn't rescue it (the block is un-layered, so it beat the
// utility even when focused). A surface treatment must never reach interactive controls.
for (const mode of ['light', 'dark']) {
  await page.evaluate((m) => {
    const s = window.__hnlens.prefs.getState();
    s.setThemeName('bento');
    s.setTheme(m);
  }, mode);
  await page.waitForTimeout(250);
  const transparent = await page.evaluate(() => {
    const sels = ['header input[type="search"], header input', 'header select', '.feed-tabs button'];
    const out = [];
    for (const sel of sels) {
      for (const el of document.querySelectorAll(sel)) {
        const cs = getComputedStyle(el);
        const c = cs.borderTopColor || '';
        const alpha = /rgba?\(([^)]+)\)/.exec(c)?.[1]?.split(',')[3];
        const isTransparent = c === 'transparent' || (alpha !== undefined && Number(alpha) === 0);
        if (isTransparent && cs.borderTopWidth !== '0px') out.push(`${sel}:${c}`);
      }
    }
    return out;
  });
  okCheck(`bento/${mode}: no interactive control has a transparent border`, transparent.length === 0, transparent.slice(0, 4).join(' | ') || 'none');
}

await b.close();
console.log(`\n${fails.length === 0 ? 'RESULT: SWITCH RENDERING (WCAG 1.4.11) PASS \u2713' : `RESULT: ${fails.length} FAILED \u2717`}`);
if (fails.length) fails.forEach((f) => console.log('  - ' + f));
process.exit(fails.length ? 1 : 0);
