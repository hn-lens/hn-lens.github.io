/**
 * Fail the build if an employer-internal reference has crept into a file that ships publicly.
 *
 * This project is developed in a private environment and published to a public repo, so an internal
 * hostname, short link, bug/CL reference, group path, username or tool name in a tracked file is a
 * release blocker. Two have already shipped and were caught only by a manual review pass.
 *
 * THE PATTERNS ARE NOT IN THIS FILE ON PURPOSE. This script is itself tracked and published, and a
 * scrub list is self-defeating: the list alone identifies the employer, which is exactly what the
 * check exists to prevent. So the patterns are read from a GITIGNORED local notes file, under a
 * heading that holds a fenced block of alternation patterns.
 *
 * Where there is no local notes file (a clean public clone, or CI), there is nothing to check
 * against and the step SKIPS loudly rather than pretending to pass.
 *
 * Usage: node scripts/leakcheck.mjs
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const NOTES = 'AGENTS.local.md';
const HEADING = /^##\s+OSS scrub patterns/im;

if (!existsSync(NOTES)) {
  // No pattern list here (a public clone, or CI). Say so LOUDLY and distinctly: the first version
  // printed "SKIPPED" and exited 0, which in CI is indistinguishable from a pass — a check that
  // cannot fail where it runs most often. The maintainer machine is where this must actually run,
  // and `--require-notes` makes that enforceable.
  const msg = `[leakcheck] NOT RUN — no ${NOTES} on this machine, so there is no pattern list to check against.`;
  if (process.argv.includes('--require-notes')) {
    console.error(msg + ' (--require-notes given, so this is a failure)');
    process.exit(1);
  }
  console.warn(msg);
  console.warn('[leakcheck] Expected in a public clone or CI; on the maintainer machine it MUST run before publishing.');
  process.exit(0);
}

const notes = readFileSync(NOTES, 'utf8');
const idx = notes.search(HEADING);
if (idx < 0) {
  console.error(`[leakcheck] ${NOTES} exists but has no "## OSS scrub patterns" section — cannot check.`);
  process.exit(1);
}
// First fenced block after the heading holds the alternation patterns, one or more lines.
const fence = /```[a-z]*\n([\s\S]*?)```/.exec(notes.slice(idx));
if (!fence) {
  console.error('[leakcheck] no fenced pattern block under the scrub-patterns heading.');
  process.exit(1);
}
const pattern = fence[1]
  .split('\n')
  .map((l) => l.trim())
  .filter(Boolean)
  .join('')
  .replace(/\|$/, '');
if (!pattern) {
  console.error('[leakcheck] pattern block is empty.');
  process.exit(1);
}

// Also grade what is COMMITTED, not just what is on disk.
//
// The first version checked working-tree bytes only. A scrub that was written but left STAGED
// therefore reported "clean" while the leak sat in HEAD and in 7 commits — `git push` would have
// published it. Working-tree-only is the wrong unit for a check whose whole subject is "what will
// become public": that is HEAD, the unpushed commits, and their messages.
function gitOut(args) {
  try {
    return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return '';
  }
}

const files = gitOut(['ls-files']).split('\n').filter(Boolean);
// This script legitimately DESCRIBES the check, and the notes file is gitignored, so neither is a
// finding. Everything else that ships is in scope.
const SELF = new Set(['scripts/leakcheck.mjs']);

// Base64/hex digests are random enough to contain any short token by chance — a lockfile integrity
// hash matched the pattern and would have been reported as an internal reference forever. Skip lines
// that are unmistakably a digest rather than prose.
const DIGEST_LINE = /"integrity"\s*:|\b(sha256|sha512)-[A-Za-z0-9+/=]{20,}/;
// Word boundaries: without them a short pattern entry matched inside a longer ordinary word and
// produced 26 pure false positives, which is how a guard gets muted instead of fixed. (The entry is
// not named here: this file is published, and the pattern list is private precisely because its
// contents identify the employer.)
const re = new RegExp(`\\b(${pattern})\\b`, 'i');

const hits = [];
for (const f of files) {
  if (SELF.has(f)) continue;
  let text;
  try {
    text = readFileSync(f, 'utf8');
  } catch {
    continue; // binary or unreadable — nothing to leak in text form
  }
  text.split('\n').forEach((line, i) => {
    if (DIGEST_LINE.test(line)) return;
    const m = re.exec(line);
    if (m) hits.push({ file: f, line: i + 1, term: m[1], text: line.trim().slice(0, 100) });
  });
}

// HEAD's tree, every unpushed commit's tree, and every unpushed commit MESSAGE.
const headHits = gitOut(['grep', '-n', '-i', '-E', pattern, 'HEAD'])
  .split('\n')
  .filter(Boolean)
  .filter((l) => !SELF.has(l.replace(/^HEAD:/, '').split(':')[0]) && !DIGEST_LINE.test(l));
for (const l of headHits) hits.push({ file: 'HEAD', line: 0, term: 'committed', text: l.slice(0, 120) });

const upstream = gitOut(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']).trim();
if (upstream) {
  const range = `${upstream}..HEAD`;
  for (const sha of gitOut(['rev-list', range]).split('\n').filter(Boolean)) {
    const msg = gitOut(['log', '-1', '--format=%B', sha]);
    const m = new RegExp(`\\b(${pattern})\\b`, 'i').exec(msg);
    if (m) hits.push({ file: `commit ${sha.slice(0, 8)} message`, line: 0, term: m[1], text: msg.split('\n')[0].slice(0, 100) });
    const inTree = gitOut(['grep', '-n', '-i', '-E', pattern, sha])
      .split('\n')
      .filter(Boolean)
      .filter((l) => !SELF.has(l.replace(/^[0-9a-f]+:/, '').split(':')[0]) && !DIGEST_LINE.test(l));
    if (inTree.length) hits.push({ file: `commit ${sha.slice(0, 8)} tree`, line: 0, term: 'committed', text: `${inTree.length} hit(s), e.g. ${inTree[0].slice(0, 90)}` });
  }
} else {
  console.warn('[leakcheck] no upstream branch — unpushed-commit history was NOT checked.');
}

if (hits.length) {
  console.error(`[leakcheck] ${hits.length} possible internal reference(s) (working tree + committed history):\n`);
  for (const h of hits.slice(0, 40)) {
    console.error(`  ${h.file}:${h.line}  [${h.term}]  ${h.text}`);
  }
  console.error(
    '\nIf a hit is an ordinary English word that collides with an internal tool name, reword the' +
      '\nsentence rather than loosening the pattern — the pattern protects a release, the sentence' +
      '\ndoes not.'
  );
  process.exit(1);
}
console.log(`[leakcheck] clean — ${files.length} tracked files, no internal references.`);
