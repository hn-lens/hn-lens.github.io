// One-command personalization proof: build → serve → run the proof harness →
// render the visual dashboard → self-test the dashboard. Produces
// scripts/.artifacts/personalization-proof.{json,html} + screenshots.
// Fully hermetic (the HN API is mocked in the harness) — safe to run anywhere.
import { execFileSync, spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const PORT = Number(process.env.PORT || 4181);
const BASE = `http://localhost:${PORT}/`;
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...opts });
const step = (name) => process.stdout.write(`\n=== ${name} ===\n`);

step('build (tsc + vite)');
run('npx', ['tsc', '-b']);
run('npx', ['vite', 'build']);

const preview = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'ignore' });
let ok = false;
try {
  step('start preview');
  let up = false;
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(BASE)).ok) { up = true; break; } } catch { /* not up */ }
    await sleep(500);
  }
  if (!up) throw new Error('preview did not start');

  step('proof harness (real modules, mocked HN API)');
  run('node', ['scripts/personalization-proof.mjs'], { env: { ...process.env, BASE } });

  step('render dashboard');
  run('node', ['scripts/personalization-report.mjs']);

  step('self-test dashboard (renders + interacts, no console errors)');
  await selftestDashboard();

  ok = true;
} finally {
  preview.kill('SIGTERM');
}

console.log(ok ? '\n✅ personalization proof complete → scripts/.artifacts/personalization-proof.html' : '\n❌ personalization proof failed');
process.exit(ok ? 0 : 1);

async function selftestDashboard() {
  const { chromium } = await import('playwright');
  const file = join(process.cwd(), 'scripts/.artifacts/personalization-proof.html');
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errs = [];
  page.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
  page.on('pageerror', (e) => errs.push(String(e)));
  await page.goto(pathToFileURL(file).href, { waitUntil: 'networkidle' });
  const ready = await page.evaluate(() => window.__proofReady === true);
  const charts = await page.locator('svg.chart').count();
  const shots = await page.locator('img.shot').count();
  const before = await page.locator('#tblCausal tbody tr td:nth-child(5)').first().innerText();
  await page.locator('#tblCausal th').nth(5).click();
  await page.waitForTimeout(100);
  const after = await page.locator('#tblCausal tbody tr td:nth-child(5)').first().innerText();
  await browser.close();
  const pass = ready && charts >= 6 && shots >= 2 && errs.length === 0 && before !== after;
  console.log(`  charts=${charts} screenshots=${shots} consoleErrors=${errs.length} sortWorks=${before !== after}`);
  if (!pass) { console.error('  dashboard self-test FAILED', errs); throw new Error('dashboard self-test failed'); }
  console.log('  dashboard self-test PASS');
}
