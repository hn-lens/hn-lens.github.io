// Device-matrix capture tool for the device-matrix review lens.
//
// Captures every major page at every device profile and writes two sets of PNGs: full-resolution
// originals, and copies scaled so the longest edge is at most MAX_EDGE. Review agents read ONLY the
// scaled set, because an image whose longest edge exceeds the model's per-image limit cannot be
// attached at all.
//
// This is a review instrument, not a gate: what it produces is judged by eye. Mechanical properties
// that a screenshot review has already found (clipped labels, sub-minimum touch targets, container
// misalignment) belong in the automated harnesses instead, so that each round spends its judgement
// on what only judgement can see.
//
// Usage:
//   node scripts/devicematrix.mjs [--base http://localhost:4188/] [--out /tmp/shots]
//   node scripts/devicematrix.mjs --pages feed-top,discussion --profiles phone-360,laptop-1280
import { chromium } from 'playwright';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const BASE = arg('base', 'http://localhost:4188/');
const OUT = arg('out', '/tmp/shots');
const SMALL = `${OUT}_small`;
const MAX_EDGE = 1400;

// Widths chosen at the points where this layout actually changes hands, not at round numbers:
// 320 is the narrowest phone still in use, 768 is the tablet/sidebar boundary, and 1920 is where
// a fixed content column leaves the most unused canvas.
const PROFILES = [
  { name: 'phone-320', viewport: { width: 320, height: 640 }, dsf: 2, mobile: true },
  { name: 'phone-360', viewport: { width: 360, height: 640 }, dsf: 2, mobile: true },
  { name: 'iphone-se', viewport: { width: 375, height: 667 }, dsf: 2, mobile: true },
  { name: 'iphone-12', viewport: { width: 390, height: 844 }, dsf: 2, mobile: true },
  { name: 'iphone-max', viewport: { width: 430, height: 932 }, dsf: 2, mobile: true },
  { name: 'tablet-768', viewport: { width: 768, height: 1024 }, dsf: 2, mobile: true },
  { name: 'laptop-1280', viewport: { width: 1280, height: 800 }, dsf: 1, mobile: false },
  { name: 'desktop-1920', viewport: { width: 1920, height: 1080 }, dsf: 1, mobile: false },
];

const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

const only = (name) => {
  const raw = arg(name, '');
  return raw ? new Set(raw.split(',').map((s) => s.trim())) : null;
};
const wantPages = only('pages');
const wantProfiles = only('profiles');

mkdirSync(OUT, { recursive: true });
mkdirSync(SMALL, { recursive: true });
for (const dir of [OUT, SMALL]) {
  for (const f of readdirSync(dir)) if (f.endsWith('.png')) rmSync(join(dir, f));
}

const b = await chromium.launch({ headless: true });

// Discover a real story that actually has a discussion, so the comments page is not captured empty.
let itemId = null;
{
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
  const p = await ctx.newPage();
  await p.goto(BASE, { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('article', { timeout: 45000 });
  await p.waitForTimeout(2500);
  itemId = await p.evaluate(() => {
    const arts = [...document.querySelectorAll('article[data-id]')];
    const withComments = arts.find((a) => /\d+\s*comment/i.test(a.textContent || ''));
    return (withComments || arts[0])?.getAttribute('data-id') ?? null;
  });
  await ctx.close();
}
if (!itemId) {
  console.error('[devicematrix] could not find a story id — is the app serving live data?');
  process.exit(1);
}

const PAGES = [
  { key: 'feed-foryou', hash: '#/?feed=foryou', wait: 'article' },
  { key: 'feed-top', hash: '#/?feed=top', wait: 'article' },
  { key: 'discussion', hash: `#/item/${itemId}`, wait: '[id^="comment-"]' },
  { key: 'search', hash: '#/?q=rust', wait: null },
  { key: 'settings', hash: '#/settings', wait: null },
  { key: 'saved', hash: '#/saved', wait: null },
];

let shots = 0;
for (const prof of PROFILES) {
  if (wantProfiles && !wantProfiles.has(prof.name)) continue;
  const ctx = await b.newContext({
    viewport: prof.viewport,
    deviceScaleFactor: prof.dsf,
    isMobile: prof.mobile,
    hasTouch: prof.mobile,
    userAgent: prof.mobile ? MOBILE_UA : undefined,
  });
  const p = await ctx.newPage();
  // The first-run modal would otherwise be the only thing in every frame.
  await p.addInitScript(() => {
    try {
      localStorage.setItem('hn:onboard', 'skip');
    } catch {
      /* private mode */
    }
  });
  for (const pg of PAGES) {
    if (wantPages && !wantPages.has(pg.key)) continue;
    try {
      await p.goto(BASE + pg.hash, { waitUntil: 'domcontentloaded' });
      if (pg.wait) await p.waitForSelector(pg.wait, { timeout: 30000 }).catch(() => {});
      await p.waitForTimeout(2600);
      await p.evaluate(() => window.scrollTo(0, 0));
      await p.waitForTimeout(250);
      await p.screenshot({ path: `${OUT}/${pg.key}__${prof.name}.png` });
      shots += 1;
    } catch (e) {
      console.log(`[devicematrix] FAILED ${pg.key} @ ${prof.name}: ${String(e).slice(0, 100)}`);
    }
  }
  await ctx.close();
  console.log(`[devicematrix] captured ${prof.name}`);
}
await b.close();

// Scale every capture under the per-image limit. A review agent handed an oversized image cannot
// read it, and on some clients the failure aborts the whole message rather than that one image.
let over = 0;
for (const f of readdirSync(OUT)) {
  if (!f.endsWith('.png')) continue;
  execFileSync('convert', [join(OUT, f), '-resize', `${MAX_EDGE}x${MAX_EDGE}>`, join(SMALL, f)]);
  const dims = execFileSync('identify', ['-format', '%w %h', join(SMALL, f)]).toString().split(' ').map(Number);
  if (dims[0] > MAX_EDGE || dims[1] > MAX_EDGE) over += 1;
}
if (over > 0) {
  console.error(`[devicematrix] ${over} scaled image(s) still exceed ${MAX_EDGE}px — refusing to report clean`);
  process.exit(1);
}
console.log(`[devicematrix] ${shots} capture(s); review copies (<=${MAX_EDGE}px) in ${SMALL}`);
