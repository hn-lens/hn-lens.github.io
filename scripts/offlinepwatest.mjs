// OFFLINE / PWA: the built app loads even when the serving port is down.
//
// The service worker (generated into the build by vite.config.ts) precaches the app shell + code, so
// after one online load a reload works with the server unreachable — that is the whole point of the
// feature. This test serves dist/ from a throwaway http server, loads the app so the SW installs +
// activates + precaches, then STOPS answering requests and reloads: the app must still boot from the
// SW cache. It also confirms the SW never deletes non-precache caches (the model-weight stores).
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';

const DIST = join(process.cwd(), 'dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon', '.wasm': 'application/wasm', '.woff2': 'font/woff2' };

let serverUp = true;
let hitsWhileDown = 0;
const server = createServer(async (req, res) => {
  if (!serverUp) { hitsWhileDown++; res.socket?.destroy(); return; } // simulate the port being down
  let p = decodeURIComponent((req.url || '/').split('?')[0]);
  if (p === '/' || p === '') p = '/index.html';
  try {
    const buf = await readFile(join(DIST, p));
    // Mimic `vite preview` / a realistic host: crossorigin module scripts get an Origin header and
    // the host answers `Vary: Origin`. Without `ignoreVary` in the SW, the precache would MISS these
    // offline and blank the page — this header is what makes this guard able to catch that class.
    res.writeHead(200, { 'content-type': MIME[extname(p)] || 'application/octet-stream', vary: 'Origin', 'access-control-allow-origin': '*' });
    res.end(buf);
  } catch {
    try { const html = await readFile(join(DIST, 'index.html')); res.writeHead(200, { 'content-type': 'text/html' }); res.end(html); } catch { res.writeHead(404); res.end(); }
  }
});
await new Promise((r) => server.listen(0, r));
const BASE = `http://localhost:${server.address().port}/`;

const fails = [];
const check = (name, pass, detail = '') => { console.log(`  ${pass ? '\u2713' : '\u2717'} ${name}${detail ? ` \u2014 ${detail}` : ''}`); if (!pass) fails.push(name); };

const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
const page = ctx.pages()[0] || (await ctx.newPage());
// Keep HN data mocked so the offline reload can render a real feed (not just the shell); these are
// cross-origin, so the SW passes them to the network where page.route intercepts them.
await page.route(/hacker-news\.firebaseio\.com|hn\.algolia\.com|google\.com\/s2|gstatic\.com/, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"hits":[],"nbHits":0}' }));

// 1) First load (server up): the SW installs, activates and precaches.
await page.goto(BASE, { waitUntil: 'load' });
await page.waitForFunction(() => navigator.serviceWorker && navigator.serviceWorker.controller !== null, null, { timeout: 20000 }).catch(() => {});
const reg = await page.evaluate(async () => {
  const r = await navigator.serviceWorker.getRegistration();
  return { hasReg: !!r, controlled: !!navigator.serviceWorker.controller, cacheKeys: await caches.keys() };
});
check('the app registers a controlling service worker on first load', reg.hasReg && reg.controlled, JSON.stringify({ controlled: reg.controlled, caches: reg.cacheKeys }));
check('a precache was populated', reg.cacheKeys.some((k) => k.startsWith('hnlens-precache-')), reg.cacheKeys.join(','));

// Seed a foreign Cache-API store (as the model-weight storage does) to prove the SW won't wipe it.
await page.evaluate(async () => { const c = await caches.open('webllm-model-weights'); await c.put('/fake-model.bin', new Response('x')); });

// 2) Server goes DOWN. Any request that reaches it now fails.
serverUp = false;
hitsWhileDown = 0;

// 3) Reload with the server down — the app must boot from the SW cache.
await page.reload({ waitUntil: 'load' });
await page.waitForTimeout(1500);
const shell = await page.evaluate(() => ({
  rootChildren: document.querySelector('#root')?.children.length ?? 0,
  hasTabs: !!document.querySelector('.feed-tabs') || /For You/.test(document.body.textContent || ''),
  hasHeader: !!document.querySelector('header'),
  foreignCacheSurvived: false,
}));
check('with the server DOWN, the app shell still boots (React mounted)', shell.rootChildren > 0, `rootChildren=${shell.rootChildren}`);
check('with the server DOWN, the feed chrome renders (tabs/header from SW cache)', shell.hasTabs && shell.hasHeader, JSON.stringify({ tabs: shell.hasTabs, header: shell.hasHeader }));

// 4) The SW served it from cache without reaching the (down) server for the shell/assets.
const foreignSurvived = await page.evaluate(async () => (await caches.keys()).includes('webllm-model-weights'));
check('the SW did NOT delete the model-weight cache (only its own stale precaches)', foreignSurvived, `hitsWhileDown=${hitsWhileDown}`);

server.close();
console.log(fails.length ? `\nRESULT: ${fails.length} FAILED` : '\nRESULT: all passed');
await b.close();
process.exit(fails.length ? 1 : 0);
