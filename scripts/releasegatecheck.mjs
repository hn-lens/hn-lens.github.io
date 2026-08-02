// Release-gate check: the AUTOMATIC publish path may only run for a commit whose CI gate passed.
//
// Scope, stated precisely because a guard that overclaims is worse than none. This asserts that a
// SPECIFIC set of known-dangerous regressions has not been reintroduced — the ones listed below,
// each of which has been a real defect here. It is a text check, not a semantic one: it does not
// evaluate the `if:` expression, so a rewrite that keeps these substrings while inverting their
// logic would still pass. It also deliberately does NOT constrain `workflow_dispatch`, the
// maintainer's manual override. Treat a PASS as "these specific regressions are absent", not as
// "publishing is provably safe".
import { readFileSync, existsSync } from 'node:fs';

const CI = '.github/workflows/ci.yml';
const DEPLOY = '.github/workflows/deploy.yml';

const fails = [];
const check = (name, pass, detail = '') => {
  console.log(`  ${pass ? '\u2713' : '\u2717'} ${name}${detail ? ` \u2014 ${detail}` : ''}`);
  if (!pass) fails.push(name);
};

for (const f of [CI, DEPLOY]) {
  if (!existsSync(f)) {
    console.error(`[releasegate] missing ${f}`);
    process.exit(1);
  }
}

const ci = readFileSync(CI, 'utf8');
const deploy = readFileSync(DEPLOY, 'utf8');

// The section of a workflow file before the first job — where the triggers live.
const triggersOf = (src) => src.split(/^jobs:/m)[0];
const ciName = (ci.match(/^name:\s*(.+)$/m)?.[1] ?? '').trim();
const deployTriggers = triggersOf(deploy);

check(
  'the CI gate runs on pushes to main (so it can gate a deploy)',
  /^\s*push:/m.test(triggersOf(ci)) && /branches:\s*\[[^\]]*main/.test(triggersOf(ci)),
  ciName ? `workflow "${ciName}"` : 'CI',
);

check(
  'the deploy workflow is triggered by the CI gate completing, not directly by a push',
  /^\s*workflow_run:/m.test(deployTriggers) && !/^\s*push:/m.test(deployTriggers),
  /^\s*push:/m.test(deployTriggers) ? 'deploy still triggers on a bare push' : 'workflow_run',
);

check(
  'the deploy workflow listens to the CI workflow by name',
  new RegExp(`workflows:\\s*\\[?\\s*["']?${ciName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']?`).test(deployTriggers),
  `expected workflows: ["${ciName}"]`,
);

check(
  'the deploy job refuses to publish unless that gate run SUCCEEDED',
  /workflow_run\.conclusion\s*==\s*'success'/.test(deploy),
  "expected an if: guarding on workflow_run.conclusion == 'success'",
);

// workflow_run checks out the default branch by default, which is NOT necessarily the commit the
// gate ran on. Publishing the wrong tree would defeat the gate just as thoroughly as not having one.
check(
  'the deploy build checks out the exact commit the gate passed on',
  /ref:\s*\$\{\{\s*github\.event\.workflow_run\.head_sha/.test(deploy),
  'expected ref: github.event.workflow_run.head_sha',
);

// Gating on conclusion alone is NOT enough, and this is the dangerous half. CI also runs on
// pull_request; the workflow_run `branches` filter matches the TRIGGERING run's head branch, and a
// fork's default branch is called `main`. So a pull request from `fork:main` passes the branch
// filter, and the deploy job would check out the PR's own commit and build it in a job holding
// `pages: write` — executing a stranger's lifecycle scripts and publishing the result.
check(
  'only a PUSH run may publish (a fork pull request must not)',
  /workflow_run\.event\s*==\s*'push'/.test(deploy),
  "expected the deploy if: to require workflow_run.event == 'push'",
);
check(
  'only a gate run from THIS repository may publish (not a fork)',
  /workflow_run\.head_repository\.full_name\s*==\s*github\.repository/.test(deploy),
  'expected a head_repository.full_name == github.repository check',
);

// Without a branch filter the trigger accepts a green gate run on ANY pushed branch, so a
// work-in-progress branch would publish over the live site.
check(
  'only the main branch may publish',
  /branches:\s*\[[^\]]*main/.test(deployTriggers),
  'expected branches: [main] on the workflow_run trigger',
);

console.log(`\n${fails.length === 0 ? 'RESULT: RELEASE GATE PASS \u2713' : `RESULT: ${fails.length} FAILED \u2717`}`);
if (fails.length) fails.forEach((f) => console.log('  - ' + f));
process.exit(fails.length ? 1 : 0);
