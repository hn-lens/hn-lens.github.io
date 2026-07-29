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
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\nRESULT: LEAKCHECK SELF-TEST ${fails.length ? `FAIL \u2717 (${fails.join('; ')})` : 'PASS \u2713'}`);
process.exit(fails.length ? 1 : 0);
