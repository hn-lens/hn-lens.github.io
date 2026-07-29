// Point git at .githooks so the pre-push leak check runs. Invoked from the `prepare` npm script, so
// a fresh clone self-arms on `npm install` instead of relying on a comment a human reads once.
//
// Must never fail an install, and must leave things alone wherever arming would be wrong:
//   - not a git worktree (a tarball or CI checkout without .git);
//   - .githooks absent;
//   - this package is a NESTED checkout inside another repo — `git config` would then write to the
//     ENCLOSING repo and point its hooksPath at a directory holding only our hook, silently
//     disabling whatever hooks that project had;
//   - the repo already uses another hook manager (husky, lefthook, a corporate wrapper) — clobbering
//     it on every `npm install` would disable their hooks to install one that is inert on a public
//     clone anyway (the hook self-skips when the private pattern list is absent).
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const q = (args) => execFileSync('git', args, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();

try {
  if (!existsSync('.githooks/pre-push')) process.exit(0);
  if (q(['rev-parse', '--is-inside-work-tree']) !== 'true') process.exit(0);

  if (resolve(q(['rev-parse', '--show-toplevel'])) !== resolve(process.cwd())) {
    console.log('arm-hooks: not the git top level (nested checkout) — leaving hooks alone.');
    process.exit(0);
  }

  let existing = '';
  try {
    existing = q(['config', '--get', 'core.hooksPath']);
  } catch {
    existing = ''; // unset: `git config --get` exits non-zero
  }
  if (existing === '.githooks') process.exit(0); // already armed
  if (existing) {
    console.log(`arm-hooks: core.hooksPath is already "${existing}" — leaving it alone.`);
    process.exit(0);
  }

  execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { stdio: 'ignore' });
  console.log('arm-hooks: core.hooksPath -> .githooks (pre-push leak check armed).');
} catch {
  // No git, no permission, detached environment — arming is best-effort and never blocks install.
}
process.exit(0);
