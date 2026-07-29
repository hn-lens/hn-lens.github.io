// Generate the brand raster assets from the "AI Pulse Stack" mark. Renders with headless Chromium
// so there is no image-library dependency. Outputs to public/:
//   favicon-32.png, apple-touch-icon.png (180), icon-192.png, icon-512.png, og.png (1200x630)
// Run: node scripts/gen-assets.mjs   (regenerate whenever the brand mark changes)
//
// public/icon.svg is the ONE drawing of the mark: every raster here derives from it, and the browser
// loads it directly as the SVG favicon (index.html, site.webmanifest). A second byte-identical
// favicon.svg used to sit beside it with nothing keeping the two in sync, so recolouring the mark
// meant shipping a tab icon that disagreed with every generated raster. That file is gone.
//
// The mark is READ FROM public/icon.svg rather than re-drawn here. An earlier version drew its own
// copy — a slate-blue square with a centered dot — and when the mark changed only the committed
// PNGs were updated, so this generator silently became a way to REVERT the brand: running it would
// have overwritten every shipped raster with the retired mark. A generator whose output does not
// match what it claims to generate is worse than no generator, because it looks maintained. There
// is now exactly one drawing of the mark and every raster derives from it.
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'public');
const MARK = readFileSync(join(OUT, 'icon.svg'), 'utf8').trim();

// The mark's own base rect is rounded (rx="115" on a 512 viewBox ≈ 22.5%). iOS applies its own
// mask and double-rounding leaves pale wedges in the corners, so the square variants flatten that
// one attribute instead of keeping a second, drifting copy of the artwork.
const markSquared = MARK.replace(/(<rect width="512" height="512")\s+rx="\d+"/, '$1');
const iconHtml = (size, rounded) => `<!doctype html><html><body style="margin:0">
  <div style="width:${size}px;height:${size}px">
    ${(rounded ? MARK : markSquared).replace(/width="512" height="512"(\s+role=)/, `width="${size}" height="${size}"$1`)}
  </div></body></html>`;

const ogHtml = `<!doctype html><html><body style="margin:0">
  <div style="width:1200px;height:630px;background:radial-gradient(1100px 700px at 78% -10%, #16324a 0%, #0d1117 55%);
              color:#e6edf3;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;
              display:flex;flex-direction:column;justify-content:center;padding:0 96px;box-sizing:border-box">
    <div style="display:flex;align-items:center;gap:28px">
      <div style="width:120px;height:120px;border-radius:28px;box-shadow:0 12px 40px rgba(0,0,0,.45)">
        ${MARK.replace(/width="512" height="512"(\s+role=)/, 'width="120" height="120"$1')}
      </div>
      <div style="font-size:88px;font-weight:800;letter-spacing:-2px">Hacker Lens</div>
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

await shot(iconHtml(32, true), 32, 32, 'favicon-32.png', true); // the mark's own rounding, transparent corners
await shot(iconHtml(180, false), 180, 180, 'apple-touch-icon.png'); // full square; iOS applies its own mask
await shot(iconHtml(192, false), 192, 192, 'icon-192.png');
await shot(iconHtml(512, false), 512, 512, 'icon-512.png');
await shot(ogHtml, 1200, 630, 'og.png');

await b.close();
console.log('done');
