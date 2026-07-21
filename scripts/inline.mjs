// Inline the built JS and CSS into a single self-contained index.html so the
// production build can be opened directly via file:// (double-click).
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2] || 'dist-single';
const htmlPath = join(dir, 'index.html');
let html = readFileSync(htmlPath, 'utf8');

const read = (url) => readFileSync(join(dir, url.replace(/^\.?\//, '')), 'utf8');

// Inline <script ... src="..."></script>
html = html.replace(/<script\b[^>]*\bsrc="([^"]+)"[^>]*><\/script>/g, (_m, src) => {
  const code = read(src).replace(/<\/script>/gi, '<\\/script>');
  return `<script type="module">\n${code}\n</script>`;
});

// Inline <link rel="stylesheet" href="...">
html = html.replace(/<link\b[^>]*rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/g, (_m, href) => {
  return `<style>\n${read(href)}\n</style>`;
});

writeFileSync(htmlPath, html);
try {
  rmSync(join(dir, 'assets'), { recursive: true, force: true });
} catch {
  /* ignore */
}
console.log(`Inlined -> ${htmlPath} (${(html.length / 1024).toFixed(0)} KB, single file)`);
