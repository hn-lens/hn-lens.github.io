// Theme gallery generator: screenshots every theme design in BOTH light and dark
// over a mocked HN API, and assembles one self-contained HTML (images embedded as
// base64) so you can eyeball all 20 designs and pick a favorite. Not a test gate —
// a review deliverable. Output: scripts/.artifacts/themes/gallery.html
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.BASE || 'http://localhost:4173/';
const OUT = join(dirname(fileURLToPath(import.meta.url)), '.artifacts', 'themes');
mkdirSync(OUT, { recursive: true });

const now = Math.floor(Date.now() / 1000);
const STORIES = [
  { id: 1, title: 'Show HN: I built a local-first Hacker News reader with on-device AI', by: 'reader_dev', url: 'https://hnlens.example/blog', score: 842, descendants: 214 },
  { id: 2, title: 'The unreasonable effectiveness of plain text', by: 'patio11', url: 'https://text.example/essay', score: 613, descendants: 158 },
  { id: 3, title: 'A deep dive into how Postgres handles concurrent writes', by: 'db_nerd', url: 'https://pg.example/mvcc', score: 498, descendants: 121 },
  { id: 4, title: 'Rust in the Linux kernel: one year later', by: 'ferris', url: 'https://kernel.example/rust', score: 401, descendants: 96 },
  { id: 5, title: 'Ask HN: What are you building this weekend?', by: 'curious', url: '', score: 233, descendants: 187 },
  { id: 6, title: 'Mechanistic interpretability: reverse-engineering a small transformer', by: 'anthropic_fan', url: 'https://interp.example/paper', score: 356, descendants: 74 },
];
const byId = new Map(STORIES.map((s) => [s.id, { ...s, type: 'story', time: now - 3600 * s.id }]));
const IDS = STORIES.map((s) => s.id);

const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ viewport: { width: 1180, height: 780 }, deviceScaleFactor: 1 });
const page = ctx.pages()[0] || (await ctx.newPage());
await page.route(/hacker-news\.firebaseio\.com/, (r) => {
  const u = r.request().url();
  const j = (x) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(x) });
  if (/(top|best|new)stories/.test(u)) return j(IDS);
  if (/(ask|show|job)stories/.test(u)) return j([]);
  const m = u.match(/item\/(\d+)/);
  if (m) return j(byId.get(Number(m[1])) ?? null);
  if (u.includes('/user/')) return j({ id: 'x', karma: 1, created: now });
  return j(null);
});
await page.route(/hn\.algolia\.com|google\.com\/s2/, (r) => r.fulfill({ status: 200, body: '{}' }));

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__hnlens && window.__hnlens.prefs, null, { timeout: 20000 });
await page.evaluate(() => window.__hnlens.prefs.getState().set({ defaultFeed: 'top', minPoints: 0, useLearnedRanker: false, embeddingsEnabled: false }));
await page.waitForSelector('article', { timeout: 15000 });

const clip = { x: 0, y: 0, width: 1180, height: 780 };

// ── Part 1: the LAYOUTS (structure), all under the neutral 'reader' design ──
await page.evaluate(() => {
  const s = window.__hnlens.prefs.getState();
  s.setThemeName('reader');
  s.setTheme('light');
});
// Read the layout list straight from the app's own dropdown (skip 'auto').
const LAYOUTS = (
  await page.$$eval('select[aria-label="Layout"] option', (els) =>
    els.map((e) => [e.value, e.textContent.trim()])
  )
).filter(([id]) => id !== 'auto');
const layoutShots = [];
for (const [id, label] of LAYOUTS) {
  await page.evaluate((l) => window.__hnlens.prefs.getState().setLayout(l), id);
  await page.waitForTimeout(220);
  const buf = await page.screenshot({ clip });
  layoutShots.push({ id, label, img: buf.toString('base64') });
  console.log(`  ✓ layout: ${id}`);
}
// Back to 'auto' so each design shows ITS OWN default layout below.
await page.evaluate(() => window.__hnlens.prefs.getState().setLayout('auto'));

// ── Part 2: the 20 DESIGNS (palette + type + default layout), light & dark ──
// The list of designs comes straight from the app's own dropdown (single source of truth).
const themes = await page.$$eval('select[aria-label="Theme design"] option', (els) =>
  els.map((e) => ({ id: e.value, label: e.textContent.trim() }))
);
console.log(`Capturing ${themes.length} designs × {light, dark}…`);

const shots = [];
for (const t of themes) {
  const row = { id: t.id, label: t.label, light: '', dark: '' };
  for (const mode of ['light', 'dark']) {
    await page.evaluate(
      ([id, m]) => {
        const s = window.__hnlens.prefs.getState();
        s.setThemeName(id);
        s.setTheme(m);
      },
      [t.id, mode]
    );
    await page.waitForTimeout(220);
    const buf = await page.screenshot({ clip });
    row[mode] = buf.toString('base64');
  }
  shots.push(row);
  console.log(`  ✓ ${t.id}`);
}
await b.close();

const layoutCard = (r) => `
  <section class="layout" id="layout-${r.id}">
    <h3>${r.label}</h3>
    <img alt="${r.id} layout" src="data:image/png;base64,${r.img}">
  </section>`;

const themeCard = (r) => `
  <section class="theme" id="${r.id}">
    <h2>${r.label}</h2>
    <div class="pair">
      <figure><figcaption>Light</figcaption><img alt="${r.id} light" src="data:image/png;base64,${r.light}"></figure>
      <figure><figcaption>Dark</figcaption><img alt="${r.id} dark" src="data:image/png;base64,${r.dark}"></figure>
    </div>
  </section>`;

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>HN Lens — designs &amp; layouts</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; font: 15px/1.5 -apple-system, system-ui, sans-serif; background: #12141a; color: #e6e8ee; }
  header { padding: 24px 28px; border-bottom: 1px solid #2a2e38; position: sticky; top: 0; background: #12141a; z-index: 2; }
  header h1 { margin: 0 0 4px; font-size: 20px; }
  header p { margin: 0; color: #9aa2b1; }
  nav { padding: 12px 28px; display: flex; flex-wrap: wrap; gap: 8px; border-bottom: 1px solid #2a2e38; }
  nav a { color: #8ab4ff; text-decoration: none; font-size: 13px; padding: 3px 8px; border: 1px solid #2a2e38; border-radius: 999px; }
  nav .sep { width: 100%; height: 0; }
  h2.group { margin: 26px 28px 0; font-size: 13px; letter-spacing: .08em; text-transform: uppercase; color: #7f8797; }
  main { padding: 12px 28px 60px; display: grid; gap: 30px; }
  .layout h3, .theme h2 { margin: 0 0 10px; font-size: 16px; }
  .pair { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
  figure { margin: 0; }
  figcaption { font-size: 12px; color: #9aa2b1; margin-bottom: 4px; }
  img { width: 100%; height: auto; display: block; border: 1px solid #2a2e38; border-radius: 10px; }
  @media (max-width: 820px) { .pair { grid-template-columns: 1fr; } }
</style></head><body>
<header><h1>HN Lens — designs &amp; layouts</h1>
<p>TWO independent axes you can mix: <b>${layoutShots.length} layouts</b> (structure) × <b>${shots.length} designs</b> (palette + type), each with light &amp; dark. Switch from the top-nav dropdowns or Settings → Appearance.</p></header>
<nav>
  <a href="#layouts">Layouts</a>${layoutShots.map((r) => `<a href="#layout-${r.id}">${r.id}</a>`).join('')}
  <span class="sep"></span>
  <a href="#designs">Designs</a>${shots.map((r) => `<a href="#${r.id}">${r.id}</a>`).join('')}
</nav>
<h2 class="group" id="layouts">${layoutShots.length} Layouts — structure (shown in the Reader design)</h2>
<main>${layoutShots.map(layoutCard).join('')}</main>
<h2 class="group" id="designs">${shots.length} Designs — palette &amp; type (each in its default layout, light &amp; dark)</h2>
<main>${shots.map(themeCard).join('')}</main>
</body></html>`;

const outPath = join(OUT, 'gallery.html');
writeFileSync(outPath, html);
console.log(`\nGallery written: ${outPath}  (${(html.length / 1e6).toFixed(1)} MB)`);
