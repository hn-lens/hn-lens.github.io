// Self-test for scripts/gen-notices.mjs: what the generated attribution file is a function of.
//
// THIRD_PARTY_NOTICES.md is a committed artifact enforced byte-exact by `--check`, so whatever the
// generator writes into it becomes a thing every contributor — including an automated dependency
// bump — has to be able to reproduce. The attribution obligations are about WHICH packages are
// redistributed, under WHAT license, and WHAT upstream NOTICE text they carry. A package version is
// not one of them, and it changes far more often than they do.
//
// So the split asserted here:
//   - a version change alone leaves the file identical  → `--check` passes
//   - a dependency added, removed, relicensed, or whose upstream NOTICE text changes → `--check` fails
//
// Runs the real generator against SYNTHETIC fixture trees in a temp dir (its own package.json,
// node_modules and model catalog). Read-only with respect to this repo: the real
// THIRD_PARTY_NOTICES.md is never read or written.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const GEN = join(dirname(fileURLToPath(import.meta.url)), 'gen-notices.mjs');
const NOTICE_TEXT = 'Alpha Project\nCopyright 2019 The Alpha Authors';

const fails = [];
const check = (name, pass, detail = '') => {
  console.log(`  ${pass ? '\u2713' : '\u2717'} ${name}${detail ? ` \u2014 ${detail}` : ''}`);
  if (!pass) fails.push(name);
};

const root = mkdtempSync(join(tmpdir(), 'noticesbump-'));

/** Write `node_modules/<name>/package.json`, plus a NOTICE file when one is given. */
function installPkg(w, name, meta, notice) {
  const dir = join(w, 'node_modules', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, ...meta }, null, 2));
  if (notice) writeFileSync(join(dir, 'NOTICE'), `${notice}\n`);
}

function setDeps(w, deps) {
  writeFileSync(join(w, 'package.json'), JSON.stringify({ name: 'fixture', version: '0.0.0', dependencies: deps }, null, 2));
}

/**
 * A fixture exercising every render path the generator has: a direct dependency with a transitive
 * one, an Apache-2.0 package shipping an upstream NOTICE, a dual-licensed package, and a model
 * catalog carrying an attribution requirement.
 */
function initFixture() {
  const w = mkdtempSync(join(root, 'fx-'));
  mkdirSync(join(w, 'scripts'), { recursive: true });
  cpSync(GEN, join(w, 'scripts', 'gen-notices.mjs'));
  setDeps(w, { alpha: '^1.0.0', beta: '^1.0.0' });
  installPkg(w, 'alpha', { version: '1.0.0', license: 'Apache-2.0', homepage: 'https://example.invalid/alpha', dependencies: { gamma: '^1.0.0' } }, NOTICE_TEXT);
  installPkg(w, 'beta', { version: '1.0.0', license: 'MIT', homepage: 'https://example.invalid/beta' });
  installPkg(w, 'gamma', { version: '1.0.0', license: '(MIT OR CC0-1.0)' });
  mkdirSync(join(w, 'src', 'lib', 'models'), { recursive: true });
  writeFileSync(
    join(w, 'src', 'lib', 'models', 'catalog.ts'),
    "export const LLMS = [{ id: 'Llama-3.2-1B-Instruct-q4f16_1-MLC' }];\nexport const EMBEDDINGS = [{ value: 'all-MiniLM-L6-v2' }];\n",
  );
  return w;
}

const gen = (w) => execFileSync('node', ['scripts/gen-notices.mjs'], { cwd: w, stdio: 'pipe' });
/** true when the committed file is accepted as up to date. */
function checkOk(w) {
  try {
    execFileSync('node', ['scripts/gen-notices.mjs', '--check'], { cwd: w, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}
const notices = (w) => readFileSync(join(w, 'THIRD_PARTY_NOTICES.md'), 'utf8');

try {
  // CONTROL — the fixture actually reaches the generator. A later case that "passes" against an
  // empty or unparsed tree would be measuring nothing.
  {
    const w = initFixture();
    gen(w);
    const out = notices(w);
    const reached = ['alpha', 'beta', 'gamma', 'Apache-2.0', 'Built with Llama.', 'Copyright 2019 The Alpha Authors'].filter((s) => !out.includes(s));
    check('CONTROL: the generator renders every fixture package, licence, NOTICE and model', reached.length === 0, reached.length ? `missing: ${reached.join(', ')}` : '6 markers present');
    check('CONTROL: a freshly generated file is reported up to date', checkOk(w) === true);
  }

  // A — a VERSION change alone is not an attribution change. Every package is bumped, so every
  // place a version could be rendered (table, Apache list, dual-licence election) is covered.
  {
    const w = initFixture();
    gen(w);
    const before = notices(w);
    setDeps(w, { alpha: '^2.0.0', beta: '^1.4.0' });
    installPkg(w, 'alpha', { version: '2.0.0', license: 'Apache-2.0', homepage: 'https://example.invalid/alpha', dependencies: { gamma: '^1.0.0' } }, NOTICE_TEXT);
    installPkg(w, 'beta', { version: '1.4.0', license: 'MIT', homepage: 'https://example.invalid/beta' });
    installPkg(w, 'gamma', { version: '1.9.2', license: '(MIT OR CC0-1.0)' });
    check('A: a version-only bump of every package leaves the notices up to date', checkOk(w) === true);
    gen(w);
    check('A: and regenerating produces an identical file', notices(w) === before);
  }

  // B — an ADDED package is an attribution change: something new is redistributed.
  {
    const w = initFixture();
    gen(w);
    setDeps(w, { alpha: '^1.0.0', beta: '^1.0.0', delta: '^1.0.0' });
    installPkg(w, 'delta', { version: '1.0.0', license: 'BSD-3-Clause' });
    check('B: an ADDED dependency still fails the check', checkOk(w) === false);
  }

  // C — a REMOVED package is an attribution change: the file would over-claim.
  {
    const w = initFixture();
    gen(w);
    setDeps(w, { alpha: '^1.0.0' });
    rmSync(join(w, 'node_modules', 'beta'), { recursive: true, force: true });
    check('C: a REMOVED dependency still fails the check', checkOk(w) === false);
  }

  // D — a LICENCE change is the attribution fact itself.
  {
    const w = initFixture();
    gen(w);
    installPkg(w, 'beta', { version: '1.0.0', license: 'GPL-3.0', homepage: 'https://example.invalid/beta' });
    check('D: a CHANGED licence still fails the check', checkOk(w) === false);
  }

  // E — upstream NOTICE text is what Apache-2.0 section 4(d) obliges this file to propagate.
  {
    const w = initFixture();
    gen(w);
    installPkg(w, 'alpha', { version: '1.0.0', license: 'Apache-2.0', homepage: 'https://example.invalid/alpha', dependencies: { gamma: '^1.0.0' } }, 'Alpha Project\nCopyright 2026 Someone Else');
    check('E: CHANGED upstream NOTICE text still fails the check', checkOk(w) === false);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\n${fails.length === 0 ? 'RESULT: NOTICES BUMP-TOLERANCE PASS \u2713' : `RESULT: ${fails.length} FAILED \u2717`}`);
if (fails.length) fails.forEach((f) => console.log('  - ' + f));
process.exit(fails.length ? 1 : 0);
