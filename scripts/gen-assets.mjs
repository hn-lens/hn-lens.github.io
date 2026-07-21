// Generate the brand raster assets from the "lens" mark (a slate-blue rounded square with
// a centered dot — the same mark used in the TopNav logo and favicon.svg). Renders with
// headless Chromium so there is no image-library dependency. Outputs to public/:
//   favicon-32.png, apple-touch-icon.png (180), icon-192.png, icon-512.png, og.png (1200x630)
// Run: node scripts/gen-assets.mjs   (regenerate whenever the brand mark changes)
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const ACCENT = '#3f607e'; // light-mode slate-blue accent (matches --accent)
const DOT = '#ffffff';

// A square icon: full-bleed accent tile + centered white dot (the "lens"). `radius` is the
// corner rounding as a % (0 = square, for platforms that apply their own mask like iOS).
const iconHtml = (size, radiusPct) => `<!doctype html><html><body style="margin:0">
  <div style="width:${size}px;height:${size}px;background:${ACCENT};border-radius:${radiusPct}%;
              display:flex;align-items:center;justify-content:center">
    <div style="width:${Math.round(size * 0.42)}px;height:${Math.round(size * 0.42)}px;
                background:${DOT};border-radius:50%"></div>
  </div></body></html>`;

const ogHtml = `<!doctype html><html><body style="margin:0">
  <div style="width:1200px;height:630px;background:radial-gradient(1100px 700px at 78% -10%, #16324a 0%, #0d1117 55%);
              color:#e6edf3;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;
              display:flex;flex-direction:column;justify-content:center;padding:0 96px;box-sizing:border-box">
    <div style="display:flex;align-items:center;gap:28px">
      <div style="width:120px;height:120px;background:${ACCENT};border-radius:28px;
                  display:flex;align-items:center;justify-content:center;box-shadow:0 12px 40px rgba(0,0,0,.45)">
        <div style="width:50px;height:50px;background:#fff;border-radius:50%"></div>
      </div>
      <div style="font-size:88px;font-weight:800;letter-spacing:-2px">HN Lens</div>
    </div>
    <div style="margin-top:40px;font-size:44px;font-weight:600;line-height:1.25;max-width:960px;color:#f0f6fc">
      A smarter, personalized Hacker&nbsp;News reader
    </div>
    <div style="margin-top:20px;font-size:30px;color:#9fb0c0;line-height:1.4;max-width:960px">
      Recommendation feed, custom ranking &amp; on-device AI summaries — runs entirely in your browser.
    </div>
    <div style="margin-top:44px;display:flex;gap:14px">
      ${['For You ranking', 'AI summaries', '100% local', 'No backend']
        .map(
          (t) =>
            `<span style="font-size:24px;color:#c9d6e2;border:1px solid #2b3a4a;border-radius:999px;padding:10px 22px">${t}</span>`
        )
        .join('')}
    </div>
    <div style="position:absolute;bottom:52px;right:96px;font-size:26px;color:#6e8398">hn-lens.github.io</div>
  </div></body></html>`;

const b = await chromium.launch();
const page = await b.newPage({ deviceScaleFactor: 1 });

async function shot(html, w, h, file, omitBackground = false) {
  await page.setViewportSize({ width: w, height: h });
  await page.setContent(html, { waitUntil: 'load' });
  await page.screenshot({ path: join(OUT, file), clip: { x: 0, y: 0, width: w, height: h }, omitBackground });
  console.log('wrote public/' + file);
}

await shot(iconHtml(32, 25), 32, 32, 'favicon-32.png', true); // rounded, transparent corners
await shot(iconHtml(180, 0), 180, 180, 'apple-touch-icon.png'); // full square; iOS masks
await shot(iconHtml(192, 0), 192, 192, 'icon-192.png');
await shot(iconHtml(512, 0), 512, 512, 'icon-512.png');
await shot(ogHtml, 1200, 630, 'og.png');

await b.close();
console.log('done');
