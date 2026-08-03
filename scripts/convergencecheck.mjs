// Convergence discipline, enforced instead of promised.
//
// Three rules in AGENTS.md were violated repeatedly by exactly the people who had just read them,
// because they were prose with nothing behind them. In this repo the only rules that have held are
// the ones with a gate. These are those three rules, as a gate.
//
// Everything is measured against a BASELINE — the last state confirmed clean by an independent
// read-only pass, recorded in `review/.baseline`. That is the interval that matters: not changes per
// commit, but changes between independent confirmations. Advance it with:
//
//     node scripts/convergencecheck.mjs --confirm
//
// which is only honest AFTER a diff-scoped read-only pass has come back clean.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const BASELINE_FILE = 'review/.baseline';

// A fix batch that changes more than this many files stops being reviewable as one idea. Measured
// here: a 27-file interval produced 13 self-inflicted defects; the 8-file intervals before it
// produced 2-3.
const MAX_FILES = 12;

// Net-new comment lines allowed in `src/` per interval. Not zero — an invariant worth stating is
// worth a line — but low enough that explaining a fix in prose fails. Reasoning belongs in
// review/README.md, which is audited and versioned; a source comment is an unverified claim, and
// prose written to explain a fix has been the single largest defect category in this project.
const MAX_NEW_COMMENT_LINES = 20;

// History-telling, first person, and review-round bookkeeping. These say what USED TO be true, which
// no reader can verify and no test can protect. They are not "state only what is mechanically true".
const NARRATIVE = [
  /\bused to\b/i,
  /\bpreviously\b/i,
  /\bpre-fix\b/i,
  /\bpost-fix\b/i,
  /\bthe old (code|version|implementation|behaviour|behavior)\b/i,
  /\bc3r\d+\b/i,
  /\bthis round\b/i,
  /\bself-inflicted\b/i,
  /(^|[^A-Za-z])we (added|removed|changed|found|fixed|measured|shipped|tried)\b/i,
];

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' });

const fails = [];
const check = (name, pass, detail = '') => {
  console.log(`  ${pass ? '\u2713' : '\u2717'} ${name}${detail ? ` \u2014 ${detail}` : ''}`);
  if (!pass) fails.push(name);
};

if (process.argv.includes('--confirm')) {
  const head = git('rev-parse', 'HEAD').trim();
  writeFileSync(BASELINE_FILE, `${head}\n`);
  console.log(`[convergence] baseline advanced to ${head.slice(0, 12)}`);
  process.exit(0);
}

// This measures the interval between independent review confirmations on a maintainer's machine.
// That interval does not exist on a CI runner, and `actions/checkout` clones shallow, so the
// baseline commit is not even present there. A check that cannot be satisfied by an automated
// context is a check that silently stops publishing, which is the class this repo just fixed
// elsewhere; skip rather than fail.
if (process.env.CI) {
  console.log('[convergence] skipped on CI — this measures a local review interval, and the runner has no baseline history.');
  process.exit(0);
}

if (!existsSync(BASELINE_FILE)) {
  console.log(`[convergence] no ${BASELINE_FILE} — nothing to measure against. Create one with --confirm.`);
  process.exit(0);
}

const baseline = readFileSync(BASELINE_FILE, 'utf8').trim().split(/\s+/)[0];
let base;
try {
  base = git('rev-parse', '--verify', `${baseline}^{commit}`).trim();
} catch {
  // A baseline that is not reachable (shallow clone, rewritten history, a fresh worktree) means the
  // interval cannot be measured. That is not evidence the change is bad, so it must not fail.
  console.log(`[convergence] ${BASELINE_FILE} names ${baseline}, which is not reachable here — skipping.`);
  process.exit(0);
}

// Compare the baseline against the WORKING TREE, so the rules bind before anything is committed.
const changed = git('diff', '--name-only', base, '--').trim().split('\n').filter(Boolean);
const isSrc = (f) => f.startsWith('src/');
const isInstrument = (f) => f.startsWith('review/base/') || f === 'review/SPEC.md';

const srcFiles = changed.filter(isSrc);
const instrumentFiles = changed.filter(isInstrument);

console.log(`[convergence] baseline ${base.slice(0, 12)} · ${changed.length} file(s) changed since\n`);

// RULE 1 — the instrument and the product must never move together.
//
// A review round measures the product with the reviewers' briefs and the spec. Change both in one
// interval and the next round's findings are partly a function of the instrument getting sharper,
// not of the product getting worse — so the target moves and the loop cannot terminate. Product
// changes and instrument changes each go in their own interval, with a confirmation between them.
check(
  'the product and the review instrument did not change in the same interval',
  !(srcFiles.length > 0 && instrumentFiles.length > 0),
  srcFiles.length && instrumentFiles.length
    ? `src: ${srcFiles.length} file(s) AND instrument: ${instrumentFiles.join(', ')}`
    : srcFiles.length
      ? `${srcFiles.length} src file(s), instrument untouched`
      : instrumentFiles.length
        ? `instrument only (${instrumentFiles.length} file(s))`
        : 'neither changed',
);

// RULE 2 — cap the interval, because self-inflicted defects scale with it.
check(
  `the interval is small enough to review as one change (<=${MAX_FILES} files)`,
  changed.length <= MAX_FILES,
  `${changed.length} file(s)`,
);

// RULE 3 — no explaining a fix in prose.
const diff = srcFiles.length ? git('diff', '-U0', base, '--', 'src') : '';
const addedCommentLines = [];
for (const line of diff.split('\n')) {
  if (!line.startsWith('+') || line.startsWith('+++')) continue;
  const body = line.slice(1).trim();
  // Line comments, block-comment bodies, and JSX comment text — enough to catch prose without
  // needing a parser.
  if (/^(\/\/|\/\*|\*(?!\/)|\{\/\*)/.test(body) || /^\*\s/.test(body)) addedCommentLines.push(body);
}
check(
  `a fix batch does not explain itself in source prose (<=${MAX_NEW_COMMENT_LINES} new comment lines in src/)`,
  addedCommentLines.length <= MAX_NEW_COMMENT_LINES,
  `${addedCommentLines.length} new comment line(s)`,
);

const narrative = addedCommentLines.filter((l) => NARRATIVE.some((re) => re.test(l)));
check(
  'no new source comment narrates history instead of stating what the code does',
  narrative.length === 0,
  narrative.length ? narrative.slice(0, 4).map((l) => l.slice(0, 84)).join(' | ') : 'none',
);

if (fails.length) {
  console.log(
    '\nThese are AGENTS.md convergence rules, enforced here because prose did not hold them.\n' +
      'Reasoning about a change belongs in review/README.md, not in the source.\n' +
      'If an interval is genuinely finished, run an independent read-only pass over it and then:\n' +
      '  node scripts/convergencecheck.mjs --confirm',
  );
}
console.log(`\n${fails.length === 0 ? 'RESULT: CONVERGENCE DISCIPLINE PASS \u2713' : `RESULT: ${fails.length} FAILED \u2717`}`);
process.exit(fails.length ? 1 : 0);
