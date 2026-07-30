// Self-test for scripts/leakcheck.mjs: it must catch an internal reference in a path name whether
// that path exists now OR only in history. A leaky filename added and later deleted stays in the
// public history forever, and leakcheck's summary claims it scans "all path names" — so history must
// actually be scanned, not just the current tree.
//
// Builds throwaway repos in a temp dir with a SYNTHETIC pattern list (no real scrub pattern touches
// disk). Read-only w.r.t. this repo. Adapted from the c3r21 OSS-lens repro that first found the gap.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const LEAKCHECK = join(dirname(fileURLToPath(import.meta.url)), 'leakcheck.mjs');
const PATTERN = 'zzsecrethostzz'; // synthetic; never a real internal reference
const fails = [];
const check = (name, pass, detail = '') => {
  console.log(`  ${pass ? '\u2713' : '\u2717'} ${name}${detail ? ` \u2014 ${detail}` : ''}`);
  if (!pass) fails.push(name);
};

const root = mkdtempSync(join(tmpdir(), 'leakselftest-'));
const g = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] });
function initRepo() {
  const w = mkdtempSync(join(root, 'repo-'));
  mkdirSync(join(w, 'scripts'), { recursive: true });
  execFileSync('cp', [LEAKCHECK, join(w, 'scripts', 'leakcheck.mjs')]);
  g(w, 'init', '-q', '.');
  g(w, 'config', 'user.email', 't@example.com');
  g(w, 'config', 'user.name', 'T');
  g(w, 'config', 'commit.gpgsign', 'false');
  // The heading must match exactly what leakcheck looks for, or it aborts with "no scrub patterns"
  // (which exits non-zero and would make a leak-CAUGHT assertion pass for the wrong reason).
  writeFileSync(join(w, 'AGENTS.local.md'), `# local\n## OSS scrub patterns\n\`\`\`\n${PATTERN}\n\`\`\`\n`);
  writeFileSync(join(w, '.gitignore'), 'AGENTS.local.md\n');
  return w;
}
// Returns { caught } — caught === the check exited non-zero (a leak was reported).
function runLeakcheck(w) {
  try {
    execFileSync('node', ['scripts/leakcheck.mjs'], { cwd: w, stdio: 'pipe' });
    return { caught: false };
  } catch {
    return { caught: true };
  }
}

try {
  // CASE A — leak in a CURRENT path name (control).
  {
    const w = initRepo();
    mkdirSync(join(w, 'a'), { recursive: true });
    writeFileSync(join(w, 'a', `${PATTERN}-notes.txt`), 'hello\n');
    g(w, 'add', '-A');
    g(w, 'commit', '-qm', 'add current leaky filename');
    check('A: a leak in a current path name is caught', runLeakcheck(w).caught === true);
  }

  // CASE B — leak in a HISTORICAL path name, file since deleted (the defect).
  {
    const w = initRepo();
    writeFileSync(join(w, 'readme.txt'), 'ok\n');
    g(w, 'add', '-A');
    g(w, 'commit', '-qm', 'base');
    mkdirSync(join(w, 'a'), { recursive: true });
    writeFileSync(join(w, 'a', `${PATTERN}-notes.txt`), 'totally innocent contents\n');
    g(w, 'add', '-A');
    g(w, 'commit', '-qm', 'commit 2: adds a file whose NAME leaks');
    g(w, 'rm', '-q', `a/${PATTERN}-notes.txt`);
    g(w, 'commit', '-qm', 'commit 3: delete it again');
    check('B: a leak in a historical (deleted) path name is caught', runLeakcheck(w).caught === true);
  }

  // CASE B2 — leak in a RENAMED-AWAY path name. Distinct from B: with rename detection on, git
  // reports a rename as ONE entry naming only the NEW (clean) path, so the leaky OLD path never
  // appears in a `--diff-filter=A` scan. Renaming is precisely what someone does after noticing the
  // name, and the old name stays public forever. B passing does not imply B2 passes — it did not.
  {
    const w = initRepo();
    writeFileSync(join(w, 'readme.txt'), 'ok\n');
    g(w, 'add', '-A');
    g(w, 'commit', '-qm', 'base');
    mkdirSync(join(w, 'a'), { recursive: true });
    // Identical content before and after, so git certainly scores it as a rename.
    writeFileSync(join(w, 'a', `${PATTERN}-notes.txt`), 'x'.repeat(400) + '\n');
    g(w, 'add', '-A');
    g(w, 'commit', '-qm', 'commit 2: adds a file whose NAME leaks');
    g(w, 'mv', `a/${PATTERN}-notes.txt`, 'a/innocent-notes.txt');
    g(w, 'commit', '-qm', 'commit 3: rename it to something innocent');
    check('B2: a leak in a RENAMED-AWAY path name is caught', runLeakcheck(w).caught === true);
  }

  // CASE C — negative control: the check must still PASS when nothing leaks.
  {
    const w = initRepo();
    writeFileSync(join(w, 'readme.txt'), 'nothing to see here\n');
    g(w, 'add', '-A');
    g(w, 'commit', '-qm', 'clean');
    check('C: a clean repo is not falsely flagged', runLeakcheck(w).caught === false);
  }

  // ── Secret-shape detection (the app takes BYO cloud API keys — a hardcoded key must be caught) ──
  // The fake secrets are CONSTRUCTED from parts so no matchable full-shape literal appears in THIS
  // tracked file (leakcheck scans itself with no self-exemption). Each written only to a temp repo.
  const FAKE_GOOGLE = 'AIza' + 'x'.repeat(35); // matches AIza[0-9A-Za-z_-]{35}
  const FAKE_OPENAI = 'sk-' + 'x'.repeat(40); // matches sk-[A-Za-z0-9_-]{24,}
  const FAKE_PEM = '-'.repeat(5) + 'BEGIN RSA PRIVATE KEY' + '-'.repeat(5);

  // CASE D — a hardcoded API key / private key in file CONTENT is caught (committed).
  {
    const w = initRepo();
    writeFileSync(join(w, 'config.ts'), `export const KEY = '${FAKE_GOOGLE}';\nconst o = '${FAKE_OPENAI}';\n`);
    g(w, 'add', '-A');
    // --no-verify: a system-wide git-secrets pre-commit hook would itself block a fake key, but this
    // test is exercising LEAKCHECK's own detection (which runs in CI + pre-push, where git-secrets is
    // absent), so we must let the key land in the repo first.
    g(w, 'commit', '--no-verify', '-qm', 'oops, hardcoded keys');
    check('D: a hardcoded API key shape in content is caught', runLeakcheck(w).caught === true);
  }
  // CASE D2 — a PEM private key block is caught.
  {
    const w = initRepo();
    writeFileSync(join(w, 'key.pem'), `${FAKE_PEM}\nMIIEv...\n`);
    g(w, 'add', '-A');
    g(w, 'commit', '--no-verify', '-qm', 'oops, private key');
    check('D2: a PEM private-key block is caught', runLeakcheck(w).caught === true);
  }
  // CASE D3 — a key committed then DELETED from the working tree is still caught (it lives in history).
  {
    const w = initRepo();
    writeFileSync(join(w, 'readme.txt'), 'ok\n');
    g(w, 'add', '-A');
    g(w, 'commit', '-qm', 'base');
    writeFileSync(join(w, 'leak.ts'), `const k = '${FAKE_GOOGLE}';\n`);
    g(w, 'add', '-A');
    g(w, 'commit', '--no-verify', '-qm', 'commit a key');
    g(w, 'rm', '-q', 'leak.ts');
    g(w, 'commit', '--no-verify', '-qm', 'remove it from the tree (but it stays in history)');
    check('D3: a key removed from the tree but kept in history is caught', runLeakcheck(w).caught === true);
  }
  // CASE E — negative control: a too-short keyish string must NOT be flagged (no over-matching).
  {
    const w = initRepo();
    writeFileSync(join(w, 'notes.txt'), 'a short id like sk-abc123 is not a key\n');
    g(w, 'add', '-A');
    g(w, 'commit', '-qm', 'short keyish string');
    check('E: a too-short keyish string is not falsely flagged', runLeakcheck(w).caught === false);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\nRESULT: LEAKCHECK SELF-TEST ${fails.length ? `FAIL \u2717 (${fails.join('; ')})` : 'PASS \u2713'}`);
process.exit(fails.length ? 1 : 0);
