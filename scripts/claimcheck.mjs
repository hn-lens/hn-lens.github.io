// Static audit of CLAIMS made in source comments.
//
// A comment is an unverified assertion. Two rounds in a row, a false one in the ranking code cost a
// review round: c3r24 rated correct, intended behaviour a HIGH because a comment said the behaviour
// was impossible, and c3r25 found the identical claim surviving in a sibling file the c3r24 purge
// never grepped. This guard makes both classes mechanically checkable.
//
// Two kinds of check:
//   1. FORBIDDEN SHAPES  — claim families proven false in this codebase. Never write them again.
//   2. NUMERIC CLAIMS    — a number stated in prose that must equal a number in code.
//
// A check that cannot evaluate its own input FAILS. A guard that green-lights on an unparseable
// input is worse than no guard (see the themecontrasttest NaN incident).

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const SRC = join(ROOT, 'src');

/** Every .ts/.tsx/.css file under src/. */
function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx|css)$/.test(p)) out.push(p);
  }
  return out;
}

/**
 * Comment regions only, as {line, text}. Scanning raw source would flag user-facing copy and test
 * fixtures; this guard is about what the code CLAIMS ABOUT ITSELF.
 *
 * Deliberately conservative: a `//` inside a string literal (a URL) is treated as a comment. That
 * can only ever produce a false POSITIVE, which a human sees and dismisses — never a false negative,
 * which is the failure mode that matters here.
 */
function comments(src) {
  const out = [];
  let block = false;
  src.split('\n').forEach((raw, i) => {
    const line = raw.trim();
    const ln = i + 1;
    if (block) {
      out.push({ line: ln, text: line.replace(/^\*+\s?/, '') });
      if (line.includes('*/')) block = false;
      return;
    }
    if (line.startsWith('/*')) {
      out.push({ line: ln, text: line.replace(/^\/\*+\s?/, '') });
      if (!line.includes('*/')) block = true;
      return;
    }
    if (line.startsWith('//')) {
      out.push({ line: ln, text: line.replace(/^\/+\s?/, '') });
      return;
    }
    const idx = raw.indexOf('//');
    if (idx >= 0) out.push({ line: ln, text: raw.slice(idx + 2).trim() });
  });
  return out;
}

// ── 1. FORBIDDEN CLAIM SHAPES ────────────────────────────────────────────────
//
// Each entry records WHY it is forbidden, so a future reader does not reinstate it.
const FORBIDDEN = [
  {
    // c3r24 false HIGH, then c3r25 found the survivor in features.ts. Measured false: `learnedScale`
    // divides the learned term only, so changing it reorders the blend against the unscaled terms.
    // SPEC.md §2.2 names any such claim as a defect BY NAME.
    re: /\b(can ?not|cannot|can never|never|without ever)\b[^.]{0,80}\breorder/i,
    why: 'SPEC.md §2.2 — a claim that any part of the ranking pipeline cannot reorder the feed. Measured false twice.',
  },
  {
    // Same family, stated as a property rather than a negation.
    re: /\b(ranking[- ]neutral|order[- ]preserving)\b/i,
    why: 'SPEC.md §2.2 — asserts an ordering invariant the pipeline does not have. State what is mechanically true instead.',
  },
];

// ── 2. NUMERIC CLAIMS THAT MUST MATCH CODE ───────────────────────────────────
//
// Each reads the authoritative value out of the code, then greps prose for a contradicting number.
// `read` MUST throw if it cannot find the value — an unevaluatable check is a failure, not a pass.
const NUMERIC = [
  {
    name: 'design count',
    read() {
      const s = readFileSync(join(SRC, 'lib/themes.ts'), 'utf8');
      const m = /THEMES[^=]*=\s*\[([\s\S]*?)\n\]/.exec(s);
      if (!m) throw new Error('cannot locate the THEMES array in src/lib/themes.ts');
      const n = (m[1].match(/\bid:\s*'/g) ?? []).length;
      if (!n) throw new Error('THEMES array parsed as empty');
      return n;
    },
    // "the 31 designs", "DESIGN (one of the 20)". Both anchored: a bare "5 more designs" section
    // divider describes a SUBSET, not the total, and must not match.
    claim: /\bthe\s+(\d+)\s+designs?\b|\bdesign\b[^.]{0,10}\(one of the\s+(\d+)\)/i,
  },
  {
    name: 'learned amplitude floor at chance',
    read() {
      const s = readFileSync(join(SRC, 'lib/ranking/strategies.ts'), 'utf8');
      const m = /const amplitude\s*=\s*([\d.]+)\s*\+/.exec(s);
      if (!m) throw new Error('cannot locate the amplitude floor in src/lib/ranking/strategies.ts');
      return Number(m[1]);
    },
    // "0.15 at chance"
    claim: /\b([\d.]+)\s+at chance\b/i,
  },
];

const files = walk(SRC);
if (files.length < 20) {
  console.error(`[claimcheck] FAIL — only ${files.length} source files found; the walk is broken.`);
  process.exit(1);
}

const failures = [];
let scanned = 0;

for (const f of files) {
  const rel = relative(ROOT, f);
  const cs = comments(readFileSync(f, 'utf8'));
  scanned += cs.length;
  for (const c of cs) {
    for (const rule of FORBIDDEN) {
      if (rule.re.test(c.text)) {
        failures.push(`${rel}:${c.line} — forbidden claim shape\n      "${c.text}"\n      ${rule.why}`);
      }
    }
    for (const num of NUMERIC) {
      const m = num.claim.exec(c.text);
      if (!m) continue;
      const stated = Number(m[1] ?? m[2]);
      if (!Number.isFinite(stated)) {
        failures.push(`${rel}:${c.line} — ${num.name}: matched a claim but could not parse its number from "${c.text}"`);
        continue;
      }
      const actual = num.read();
      if (stated !== actual) {
        failures.push(`${rel}:${c.line} — ${num.name}: comment says ${stated}, code says ${actual}\n      "${c.text}"`);
      }
    }
  }
}

// Prove the numeric readers actually resolve, even when no comment happens to state them. Otherwise
// a broken reader is indistinguishable from "no claims found".
for (const num of NUMERIC) {
  const v = num.read();
  if (!Number.isFinite(v)) {
    console.error(`[claimcheck] FAIL — reader for "${num.name}" returned a non-finite value.`);
    process.exit(1);
  }
}

if (failures.length) {
  console.error(`[claimcheck] FAIL — ${failures.length} false or contradicted claim(s) in source comments:\n`);
  for (const f of failures) console.error(`  • ${f}\n`);
  console.error('Prefer DELETION over correction: a comment you cannot keep true should not exist.');
  process.exit(1);
}

console.log(
  `[claimcheck] clean — ${scanned} comment line(s) across ${files.length} source file(s); ` +
    `${FORBIDDEN.length} forbidden shape(s), ${NUMERIC.length} numeric claim(s) cross-checked against code.`
);
