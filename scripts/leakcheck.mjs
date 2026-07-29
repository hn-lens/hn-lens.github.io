/**
 * Fail the build if an employer-internal reference has crept into anything that ships publicly.
 *
 * This project is developed in a private environment and published to a public repo, so an internal
 * hostname, short link, bug/CL reference, group path, username or tool name is a release blocker.
 * Two have already shipped and were caught only by a manual review pass.
 *
 * THE PATTERNS ARE NOT IN THIS FILE ON PURPOSE. This script is itself tracked and published, and a
 * scrub list is self-defeating: the list alone identifies the employer, which is exactly what the
 * check exists to prevent. So the patterns are read from a GITIGNORED local notes file, under a
 * heading that holds a fenced block of alternation patterns.
 *
 * THE GOVERNING INVARIANT: this script must never print "clean" about something it did not actually
 * examine. A missing pattern list, a git error, and a path outside the graded range must each be
 * visibly distinct from a pass. The previous version violated this three ways — it swallowed every
 * git error into an empty result, it graded only unpushed commits, and it never looked at commit
 * identities — so a malformed pattern would have disabled all history checking while still printing
 * a green line.
 *
 * Usage: node scripts/leakcheck.mjs [--require-notes]
 */
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const NOTES = 'AGENTS.local.md';
const HEADING = /^##\s+OSS scrub patterns/im;
// Grading every commit is the point (see below), but on a long-lived repo it is O(commits) greps.
// If a repo ever outgrows this, the answer is to raise the cap deliberately — NOT to silently skip
// history, which is the failure this rewrite exists to remove.
const MAX_COMMITS = Number(process.env.LEAKCHECK_MAX_COMMITS || 500);

function fail(msg) {
  console.error(`[leakcheck] ${msg}`);
  process.exit(1);
}

if (!existsSync(NOTES)) {
  // No pattern list here (a public clone, or CI). Say so LOUDLY and distinctly: an early version
  // printed "SKIPPED" and exited 0, which in CI is indistinguishable from a pass — a check that
  // cannot fail where it runs most often. The maintainer machine is where this must actually run,
  // and `--require-notes` (passed by the gate outside CI) makes that enforceable.
  const msg = `[leakcheck] NOT RUN — no ${NOTES} on this machine, so there is no pattern list to check against.`;
  if (process.argv.includes('--require-notes')) {
    console.error(msg + ' (--require-notes given, so this is a failure)');
    console.error(
      '[leakcheck] Contributing from a public clone? This check is maintainer-only — it needs a\n' +
        '            private pattern list that deliberately is not published. Re-run the gate with\n' +
        '            LEAKCHECK_OPTIONAL=1 to skip it.'
    );
    process.exit(1);
  }
  console.warn(msg);
  console.warn('[leakcheck] Expected in a public clone or CI; on the maintainer machine it MUST run before publishing.');
  process.exit(0);
}

const notes = readFileSync(NOTES, 'utf8');
const idx = notes.search(HEADING);
if (idx < 0) fail(`${NOTES} exists but has no "## OSS scrub patterns" section — cannot check.`);

// First fenced block after the heading holds the alternation patterns, one or more lines.
const fence = /```[a-z]*\n([\s\S]*?)```/.exec(notes.slice(idx));
if (!fence) fail('no fenced pattern block under the scrub-patterns heading.');

const pattern = fence[1]
  .split('\n')
  .map((l) => l.trim())
  .filter(Boolean)
  .join('')
  .replace(/\|$/, '');
if (!pattern) fail('pattern block is empty.');

// git exit codes: 0 = success (grep: matched), 1 = "no match", >=2 = a real error. The first version
// collapsed all three into '' through a bare `catch`, so a malformed pattern — which makes `git grep`
// exit 128 — was indistinguishable from "nothing found". Every invocation now fails loudly unless the
// status is one we explicitly named.
function git(args, { noMatchOk = false } = {}) {
  const r = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error) fail(`\`git ${args[0]}\` could not run: ${r.error.message}`);
  if (r.status === 0) return r.stdout;
  if (r.status === 1 && noMatchOk) return '';
  fail(
    `\`git ${args.join(' ')}\` exited ${r.status} — refusing to report "clean" on a check that did not run.\n` +
      (r.stderr || '').trim()
  );
  return '';
}

const hasHead = spawnSync('git', ['rev-parse', '--verify', '--quiet', 'HEAD'], { encoding: 'utf8' }).status === 0;
if (!hasHead) fail('repository has no commits — nothing committed to grade, and this is not a pass.');

// ---------------------------------------------------------------------------
// Word boundaries, applied PER ALTERNATIVE rather than around the whole group.
//
// Wrapping the entire alternation as `\b(a|b|c)\b` looks equivalent and is not. A leading `\b`
// requires the character *before* the match to be a word character, so any alternative that begins
// with punctuation can only ever match when it is glued to the end of a preceding word. The
// address-shaped entry in this list begins with `@`, and that single wrapper made it unmatchable in
// 6 of 7 realistic renderings — backticked, bulleted, parenthesised, after a space, at line start,
// or inside a JSON string. Backticked is this repo's own documentation style, so the guard was blind
// to the most likely rendering of the one entry chosen because it identifies a person.
//
// A boundary is therefore attached only on a side where the alternative actually starts or ends with
// a word character, and the SAME constructed pattern now drives both engines — previously the JS half
// had boundaries and the `git grep` half did not, so the two halves did not match the same things.
// ---------------------------------------------------------------------------

/** Split on top-level `|` only — a `|` inside a class, group or brace quantifier is not a separator. */
function splitAlternatives(src) {
  const out = [];
  let depth = 0;
  let inClass = false;
  let cur = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') {
      cur += c + (src[i + 1] ?? '');
      i++;
      continue;
    }
    if (inClass) {
      if (c === ']') inClass = false;
      cur += c;
      continue;
    }
    if (c === '[') inClass = true;
    else if (c === '(' || c === '{') depth++;
    else if (c === ')' || c === '}') depth--;
    else if (c === '|' && depth === 0) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

/** First character a bracket class can produce, so `[a-z]` → `a` and `[0-9]` → `0`. */
function firstOfClass(body) {
  if (body.startsWith('^')) return 'x'; // negated: any ordinary letter satisfies it
  const m = /^\\?(.)/.exec(body);
  return m ? m[1] : 'x';
}

/**
 * Build one concrete string the alternative must match. This exists so the guard can PROVE every
 * entry in the list can actually fire, in both engines, instead of assuming it. An entry that cannot
 * fire is the quietest possible failure: the list looks longer than the protection it provides.
 */
function sampleOf(alt) {
  let out = '';
  let i = 0;
  while (i < alt.length) {
    let atom;
    const c = alt[i];
    if (c === '\\') {
      atom = alt[i + 1] ?? '';
      i += 2;
    } else if (c === '[') {
      let close = i + 1;
      while (close < alt.length && alt[close] !== ']') close += alt[close] === '\\' ? 2 : 1;
      atom = firstOfClass(alt.slice(i + 1, close));
      i = close + 1;
    } else if (c === '(') {
      let depth = 1;
      let close = i + 1;
      while (close < alt.length && depth > 0) {
        if (alt[close] === '\\') close++;
        else if (alt[close] === '(') depth++;
        else if (alt[close] === ')') depth--;
        close++;
      }
      const inner = alt.slice(i + 1, close - 1).replace(/^\?:/, '');
      atom = sampleOf(splitAlternatives(inner)[0] ?? '');
      i = close;
    } else if (c === '.') {
      atom = 'x';
      i++;
    } else {
      atom = c;
      i++;
    }
    let reps = 1;
    if (alt[i] === '+' || alt[i] === '*' || alt[i] === '?') {
      i++;
    } else if (alt[i] === '{') {
      const close = alt.indexOf('}', i);
      const min = parseInt(alt.slice(i + 1, close).split(',')[0], 10);
      if (Number.isFinite(min) && min > 0) reps = min;
      i = close + 1;
    }
    out += atom.repeat(reps);
  }
  return out;
}

const WORD = /[A-Za-z0-9_]/;
const alternatives = splitAlternatives(pattern);
if (!alternatives.length) fail('pattern block produced no alternatives.');

const samples = alternatives.map((alt) => {
  const s = sampleOf(alt);
  if (!s) fail(`could not synthesise a sample for one fence entry — cannot prove it is enforceable.`);
  return s;
});

const boundedPattern = alternatives
  .map((alt, n) => {
    const s = samples[n];
    const lead = WORD.test(s[0]) ? '\\b' : '';
    const tail = WORD.test(s[s.length - 1]) ? '\\b' : '';
    // Plain groups, not `(?:…)`: POSIX ERE has no non-capturing group and `git grep -E` rejects it
    // outright. This is exactly the engine divergence the both-engines check exists to catch.
    return `${lead}(${alt})${tail}`;
  })
  .join('|');

let re;
try {
  re = new RegExp(`(${boundedPattern})`, 'i');
} catch (e) {
  fail(`pattern does not compile as a JavaScript regex: ${e.message}`);
}

// `git grep -E` must accept the same constructed pattern. The two engines differ in what syntax they
// accept, so a pattern valid in one can be rejected by the other, which would leave the working tree
// checked while all of history silently stopped being checked.
{
  const probe = spawnSync('git', ['grep', '-q', '-i', '-E', boundedPattern, 'HEAD'], { encoding: 'utf8' });
  if (probe.status !== 0 && probe.status !== 1) {
    fail(`pattern is not valid POSIX ERE — \`git grep\` exited ${probe.status}:\n${(probe.stderr || '').trim()}`);
  }
}

// SELF-TEST: every alternative must be able to FIRE, in BOTH engines, in every rendering a human
// would plausibly write. "Clean" must not be printable while any entry is silently unmatchable.
{
  const renderings = [
    (s) => s,
    (s) => `see \`${s}\` here`,
    (s) => `- ${s}`,
    (s) => `(${s})`,
    (s) => `contact ${s} for details`,
    (s) => `"host": "${s}"`,
  ];
  const PROBE_NAME = 'sample.txt';
  const probeDir = mkdtempSync(join(tmpdir(), 'leakcheck-selftest-'));
  const probeFile = join(probeDir, PROBE_NAME);
  const unmatchable = [];
  try {
    for (let n = 0; n < alternatives.length; n++) {
      for (const render of renderings) {
        const line = render(samples[n]);
        if (!re.test(line)) {
          unmatchable.push(`entry #${n + 1} is unmatchable by the JavaScript half as "${render('<entry>')}"`);
          break;
        }
        writeFileSync(probeFile, line + '\n');
        // `--no-index` runs git's own regex engine over a plain file, so this tests the ACTUAL
        // history-half matcher rather than a stand-in like GNU grep. The pathspec must be RELATIVE
        // to cwd — git rejects an absolute one with "outside the directory tree" (exit 128), which
        // would otherwise be misread as "did not match".
        const g = spawnSync('git', ['grep', '--no-index', '-q', '-i', '-E', boundedPattern, '--', PROBE_NAME], {
          encoding: 'utf8',
          cwd: probeDir,
        });
        if (g.status >= 2) {
          fail(`self-test probe could not run (\`git grep\` exited ${g.status}):\n${(g.stderr || '').trim()}`);
        }
        if (g.status !== 0) {
          unmatchable.push(`entry #${n + 1} is unmatchable by the git half as "${render('<entry>')}"`);
          break;
        }
      }
      // A word-bounded entry must still refuse to match inside a longer word, or the boundaries have
      // stopped suppressing the false positives they were added for.
      const s = samples[n];
      if (WORD.test(s[0]) && WORD.test(s[s.length - 1]) && re.test(`zzz${s}zzz`)) {
        unmatchable.push(`entry #${n + 1} matches inside a longer word — its boundaries are not holding`);
      }
    }
  } finally {
    rmSync(probeDir, { recursive: true, force: true });
  }
  if (unmatchable.length) {
    fail(
      `${unmatchable.length} scrub-list problem(s) — the list claims protection it does not provide:\n  ` +
        unmatchable.join('\n  ')
    );
  }
}

// Base64/hex digests are random enough to contain any short token by chance — a lockfile integrity
// hash matched the pattern and would have been reported as an internal reference forever.
//
// The first version skipped the whole LINE, which re-created the "exempt means unexamined" hole this
// script is otherwise built to avoid: a lockfile line carries a digest AND a resolved URL, so a
// private-registry host on that line was invisible. Blank out just the digest RUN and scan what is
// left, so the exemption is as narrow as the reason for it.
const DIGEST_RUN = /("integrity"\s*:\s*"[^"]*")|(\b(?:sha256|sha512)-[A-Za-z0-9+/=]{20,})/g;
const scrubDigests = (line) => line.replace(DIGEST_RUN, ' ');

/**
 * A BINARY blob is scanned for the strings a human could have embedded in it, not as raw text.
 *
 * Scanning compressed bytes line-by-line generates false positives out of noise — a freshly
 * regenerated PNG failed this check because four bytes of its pixel data happened to spell a
 * pattern. That is worse than a missed check: a guard that cries wolf on unreproducible byte soup
 * gets its findings waved through, which is precisely the reflex this check exists to prevent.
 *
 * So do what `strings` does — take runs of printable ASCII long enough to be deliberate text and
 * match only those. A real leak in a binary (a hostname in PNG metadata, a path baked into a
 * compiled artifact) is exactly such a run and is still caught; random bytes essentially never
 * produce one that matches.
 *
 * THE GAP THIS LEAVES, stated rather than glossed: a short entry — and a majority of the literal
 * entries are shorter than this threshold — is missed if it appears in a binary ISOLATED between
 * non-printable bytes, with fewer than MIN_STRING_RUN printable characters around it. In practice
 * an embedded reference is part of a longer run (a URL, a path, a sentence) and is found inside it,
 * while an isolated short token surrounded by NULs is the false-positive case rather than the leak
 * case. Text files are unaffected: they are scanned in full, line by line.
 */
const MIN_STRING_RUN = 6;
const isBinary = (buf) => buf.includes(0);
// The class is written as the literal range space-to-tilde rather than with hex escapes, because
// the hex form of the space character spells one of the scrub entries — and this file is subject to
// the pattern like everything else that ships, with no self-exemption.
const printableRuns = (buf) =>
  buf
    .toString('latin1')
    .split(/[^ -~]+/)
    .filter((s) => s.length >= MIN_STRING_RUN);

const hits = [];
// `-z` (NUL-separated), NOT the default newline listing. By default git QUOTES any path containing
// non-ASCII or control characters — `"src/caf\303\251.ts"` — and that quoted string is not a real
// path, so `readFileSync` threw and the old `catch { continue }` skipped the file silently while
// the summary still counted it as examined. A file could therefore be published unread by the
// guard that reported it clean, and naming it in a way git quotes was all it took.
const lsFiles = (args) => git(['ls-files', '-z', ...args]).split('\0').filter(Boolean);
const tracked = lsFiles([]);
// Untracked-but-not-ignored files are one `git add` away from being published, and an earlier
// version printed "clean" without ever looking at them. Grading them costs nothing and removes
// another way for the success line to mean less than it says.
const untracked = lsFiles(['--others', '--exclude-standard']);
const untrackedSet = new Set(untracked);

// THE INDEX, which is what `git commit` actually publishes.
//
// Everything above reads the WORKING TREE. Those are usually the same bytes, and when they are not
// it is the index that becomes the commit — so a leak staged and then edited out of the working
// copy was invisible to a guard whose whole claim is that nothing reaches a commit unexamined.
// `git diff --cached --name-only` lists exactly the paths where the two differ, and each is read
// from the index (`git show :path`) rather than from disk.
const stagedDiffers = git(['diff', '--cached', '--name-only', '-z'], { noMatchOk: true })
  .split('\0')
  .filter(Boolean)
  .filter((f) => {
    const w = spawnSync('git', ['show', `:${f}`], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
    if (w.status !== 0 || !w.stdout) return false; // deleted in the index; nothing to publish
    let disk = null;
    try {
      disk = readFileSync(f);
    } catch {
      /* not on disk at all — the index copy is the only version */
    }
    return disk === null || !disk.equals(w.stdout);
  });
for (const f of stagedDiffers) {
  const r = spawnSync('git', ['show', `:${f}`], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0 || !r.stdout) continue;
  const binary = isBinary(r.stdout);
  const lines = binary ? printableRuns(r.stdout) : r.stdout.toString('utf8').split('\n');
  lines.forEach((line, i) => {
    const m = re.exec(scrubDigests(line));
    if (m) {
      hits.push({
        where: `${f} (staged${binary ? ', embedded string' : ''})`,
        line: binary ? 0 : i + 1,
        term: m[1],
        text: line.trim().slice(0, 100),
      });
    }
  });
}

// PATH NAMES are published too. A file called after an internal host leaks it without containing a
// single matching byte, and every scan above looks only at CONTENTS.
for (const f of [...tracked, ...untracked, ...stagedDiffers]) {
  const m = re.exec(f);
  if (m) hits.push({ where: `${f} (path name)`, line: 0, term: m[1], text: f });
}

// ...and path names that existed only in HISTORY. A leaky filename added and later renamed/deleted
// is gone from every current-state list above, but stays in the public history forever. One command
// yields every path ever added across all refs — O(1) invocations, not O(commits x paths).
//
// `--no-renames` is load-bearing. With rename detection on, a rename is reported as a single R entry
// naming only the NEW path, so the OLD path — the one that may carry the internal reference, and the
// likely reason someone renamed it — never appears as an A and is never scanned. Disabling detection
// records the rename as delete + add, which puts the old path back in the A set.
const everAdded = new Set(
  git(['log', '--all', '--no-renames', '--diff-filter=A', '--name-only', '--pretty=format:'], { noMatchOk: true })
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
);
for (const f of everAdded) {
  if (tracked.includes(f) || untrackedSet.has(f)) continue; // already covered current-state, above
  const m = re.exec(f);
  if (m) hits.push({ where: `${f} (path name, in history)`, line: 0, term: m[1], text: f });
}

// There is deliberately no self-exemption. An earlier version excused this file on the grounds that
// it "describes the check", but an exempt file is an unexamined path, and the notes file it reads is
// gitignored anyway — so this script must survive its own pattern like everything else that ships.

const unreadable = [];
let binaryScanned = 0;
for (const f of [...tracked, ...untracked]) {
  let buf;
  try {
    // A SYMLINK's published content is its target PATH, stored in the blob — `readFileSync` follows
    // the link and reads the target's bytes instead, so the path itself was never examined by
    // either engine. Read the link text when the entry is a link.
    const st = lstatSync(f);
    buf = st.isSymbolicLink() ? Buffer.from(readlinkSync(f), 'utf8') : readFileSync(f);
  } catch (e) {
    // NOT skipped quietly. With `-z` there is no benign reason a listed file cannot be read, so an
    // unreadable path means the guard did not examine something it is about to call clean. Collect
    // and fail below rather than continue — the same rule this script applies to a git command that
    // exits non-zero. (A submodule gitlink would land here; that needs a deliberate exemption, not
    // an invisible skip.)
    unreadable.push(`${f} — ${e.code || e.message}`);
    continue;
  }
  const label = untrackedSet.has(f) ? `${f} (untracked)` : f;
  const binary = isBinary(buf);
  if (binary) binaryScanned++;
  const lines = binary ? printableRuns(buf) : buf.toString('utf8').split('\n');
  lines.forEach((line, i) => {
    const m = re.exec(scrubDigests(line));
    if (m) {
      hits.push({
        where: binary ? `${label} (embedded string)` : label,
        line: binary ? 0 : i + 1,
        term: m[1],
        text: line.trim().slice(0, 100),
      });
    }
  });
}
if (unreadable.length) {
  fail(
    `${unreadable.length} listed file(s) could not be read, so they were not examined:\n` +
      unreadable.map((u) => `  ${u}`).join('\n') +
      '\nRefusing to report "clean" over an unexamined path.'
  );
}

// `git grep` reports a matching BINARY blob as `Binary file <rev>:<path> matches` — a summary line
// that does not contain the matched text. Re-testing it against the pattern therefore always fails,
// so the old single filter DROPPED it and a committed binary carrying an internal string (a cached
// model blob, a screenshot, a compiled artifact) passed as clean.
//
// Such a line cannot simply be kept either: git's match is over raw bytes, so compressed pixel data
// produces matches out of noise. Re-open the blob and apply the same printable-string test used on
// the working tree, so a deliberate embedded string is reported and byte soup is not.
const BINARY_MATCH = /^Binary file (.*) matches$/;
function binaryBlobHit(line) {
  const path = line.match(BINARY_MATCH)?.[1];
  if (!path) return null;
  const r = spawnSync('git', ['show', path], { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0 || !r.stdout) return line; // cannot inspect it — surface rather than assume
  for (const s of printableRuns(r.stdout)) {
    const m = re.exec(scrubDigests(s));
    if (m) return `${path} (embedded string) [${m[1]}] ${s.trim().slice(0, 80)}`;
  }
  return null; // matched only in non-textual bytes
}
/**
 * Symlink blobs in a committed tree. `git grep` does not search mode-120000 entries, so a symlink
 * whose TARGET PATH carries a flagged string was invisible to the history scan even after the
 * working-tree scan learned to read link text — and a pushed leak is permanent.
 */
function symlinkHits(rev) {
  const out = [];
  const entries = git(['ls-tree', '-r', rev], { noMatchOk: true }).split('\n').filter(Boolean);
  for (const line of entries) {
    if (!line.startsWith('120000 ')) continue;
    const path = line.split('\t').slice(1).join('\t');
    const blob = line.split(/\s+/)[2];
    const target = spawnSync('git', ['cat-file', 'blob', blob], { encoding: 'utf8' }).stdout ?? '';
    const m = re.exec(scrubDigests(target));
    if (m) out.push(`${rev}:${path} (symlink target) [${m[1]}] ${target.trim().slice(0, 80)}`);
  }
  return out;
}

function treeHits(rev) {
  return symlinkHits(rev).concat(
    git(['grep', '-n', '-i', '-E', boundedPattern, rev], { noMatchOk: true })
    .split('\n')
    .filter(Boolean)
    .map((l) => (BINARY_MATCH.test(l) ? binaryBlobHit(l) : l))
    .filter((l) => l !== null)
    // Re-test the digest-scrubbed line rather than dropping any line that merely contains a digest:
    // dropping the line would hide a real reference sharing a line with a hash.
      .filter((l) => l.includes('(embedded string)') || re.test(scrubDigests(l)))
  );
}

for (const l of treeHits('HEAD')) {
  hits.push({ where: 'HEAD tree', line: 0, term: 'committed', text: l.slice(0, 120) });
}

// Grade ALL history, not just the unpushed part. A leak becomes permanent the moment it is pushed,
// so already-public commits are the case that most needs re-checking, and the previous `@{u}..HEAD`
// range was the one case that excluded them.
const commits = git(['rev-list', '--all']).split('\n').filter(Boolean);
if (commits.length > MAX_COMMITS) {
  fail(
    `${commits.length} commits exceeds LEAKCHECK_MAX_COMMITS=${MAX_COMMITS}. Raise the cap deliberately;\n` +
      'silently grading a subset of history is the failure mode this check was rewritten to remove.'
  );
}

for (const sha of commits) {
  const short = sha.slice(0, 8);

  const msg = git(['log', '-1', '--format=%B', sha]);
  const mm = re.exec(msg);
  if (mm) hits.push({ where: `commit ${short} message`, line: 0, term: mm[1], text: msg.split('\n')[0].slice(0, 100) });

  // Every commit carries an author and committer identity into the public repo, and nothing here
  // looked at them. A single global-git-config change on a managed workstation would otherwise
  // publish a corporate address in every future commit, invisibly to this guard.
  const ident = git(['log', '-1', '--format=%an%n%ae%n%cn%n%ce', sha]);
  const mi = re.exec(ident);
  if (mi) hits.push({ where: `commit ${short} identity`, line: 0, term: mi[1], text: ident.split('\n').join(' | ').slice(0, 100) });

  if (sha !== git(['rev-parse', 'HEAD']).trim()) {
    const inTree = treeHits(sha);
    if (inTree.length) {
      hits.push({ where: `commit ${short} tree`, line: 0, term: 'committed', text: `${inTree.length} hit(s), e.g. ${inTree[0].slice(0, 90)}` });
    }
  }
}

if (hits.length) {
  console.error(`[leakcheck] ${hits.length} possible internal reference(s) (working tree + all committed history):\n`);
  for (const h of hits.slice(0, 40)) {
    console.error(`  ${h.where}:${h.line}  [${h.term}]  ${h.text}`);
  }
  console.error(
    '\nIf a hit is an ordinary English word that collides with an internal tool name, reword the' +
      '\nsentence rather than loosening the pattern — the pattern protects a release, the sentence' +
      '\ndoes not.'
  );
  process.exit(1);
}

// State exactly what was examined, so "clean" can never be read as broader than the check performed.
console.log(
  `[leakcheck] clean — ${tracked.length} tracked + ${untracked.length} untracked file(s) ` +
    `(${binaryScanned} binary, scanned for embedded strings), ${stagedDiffers.length} staged-only version(s), ` +
    `all path names (current + ${everAdded.size} ever added in history), HEAD tree, ` +
    `${commits.length} commit(s) across all refs (tree + message + author/committer identity), ` +
    `${alternatives.length} scrub entries self-tested in both engines.`
);
