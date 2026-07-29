// Tiered test runner for Hacker Lens. One orchestrator, three modes:
//
//   quick    — fast hermetic inner loop: static checks + the mocked-HN behavioural
//              / a11y / robustness harnesses (chromium only, no network, no models).
//   standard — the pre-handback gate (this is what `npm run verify` runs): every
//              deterministic harness — quick's set PLUS live-HN persistence / wiring /
//              reachability / end-to-end tour and the personalization proof. No
//              WebGPU, no cross-browser, no live-stress (those are environment- or
//              network-sensitive and belong in `full`).
//   full     — everything: standard PLUS visual regression, the cross-browser sweep
//              (webkit + firefox), the adversarial live-HN stress run, and the WebGPU
//              model + summarization-eval harnesses (slow; download model weights).
//
// Tests are grouped into TIERS; a mode selects a set of tiers. A single production
// preview is built once and served on one port; every browser harness runs against it
// via the BASE env var (the convention every scripts/*.mjs already follows).
//
// Usage:
//   node scripts/test.mjs [quick|standard|full] [flags]
//
// Flags:
//   --only=tierA,tierB   run only these tiers (intersected with the mode's set)
//   --skip=tierA,tierB   skip these tiers
//   --continue           run every selected step even after a failure (default: fail-fast)
//   --update-visual      (re)write visual baselines instead of diffing against them
//   --port=N             preview port (default 4182; strictPort — fails loudly if busy)
//   --llm=ID             LLM_ID for the webgpu tier (default: harness's own default)
//   --list               print the tiers + modes and exit
//
// Exit code is non-zero if any selected step failed (or the preview never came up).
import { execFileSync, spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

// ---- args ------------------------------------------------------------------
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const val = (name, dflt) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const mode = argv.find((a) => !a.startsWith('--')) || 'standard';
const CONTINUE = flag('continue');
const UPDATE_VISUAL = flag('update-visual');
const PORT = Number(val('port', 4182));
const BASE = `http://localhost:${PORT}/`;
const LLM_ID = val('llm', process.env.LLM_ID || '');
const onlyTiers = (val('only', '') || '').split(',').filter(Boolean);
const skipTiers = (val('skip', '') || '').split(',').filter(Boolean);

// ---- tiers -----------------------------------------------------------------
// Each tier: { desc, preview (does it need the running app?), steps[] }.
// A step is either a raw command ({ name, cmd, args }) or a harness
// ({ name, script, args?, env? } → runs `node scripts/<script>.mjs`).
const llmEnv = LLM_ID ? { LLM_ID } : {};
const TIERS = {
  static: {
    desc: 'typecheck + lint + production build',
    preview: false,
    steps: [
      { name: 'typecheck (tsc -b)', cmd: 'npx', args: ['tsc', '-b'] },
      { name: 'lint (oxlint)', cmd: 'npx', args: ['oxlint'] },
      // THIRD_PARTY_NOTICES.md is generated from package.json's runtime deps and carries a real
      // Apache-2.0 section 4(d) obligation, so a dependency bump must not be able to leave it stale.
      { name: 'third-party notices up to date', cmd: 'node', args: ['scripts/gen-notices.mjs', '--check'] },
      // A comment is an unverified assertion, and a false one in the ranking code has now cost two
      // review rounds — c3r24 rated intended behaviour a HIGH because a comment said it was
      // impossible, and c3r25 found the same claim surviving in a sibling file. This checks the
      // claim families proven false here, plus numbers stated in prose that must match the code.
      { name: 'no false claims in source comments', cmd: 'node', args: ['scripts/claimcheck.mjs'] },
      // This repo is developed privately and published publicly, so an internal hostname/tool name
      // in a tracked file is a release blocker. `--require-notes` turns "the pattern list is
      // missing" from a warning into a failure — the only thing standing between a renamed or lost
      // notes file and a silent green publish on the maintainer machine. It is withheld where the
      // file is legitimately absent: CI, and public clones that opt out explicitly.
      {
        name: 'no internal references in tracked files',
        cmd: 'node',
        args:
          process.env.CI || process.env.LEAKCHECK_OPTIONAL
            ? ['scripts/leakcheck.mjs']
            : ['scripts/leakcheck.mjs', '--require-notes'],
      },
      // leakcheck itself must catch a leaky path name whether it exists now or only in history —
      // the summary claims it scans "all path names", so history has to actually be scanned.
      { name: 'leakcheck self-test (path names in history)', cmd: 'node', args: ['scripts/leakcheckselftest.mjs'] },
      { name: 'build (vite)', cmd: 'npx', args: ['vite', 'build'], build: true },
    ],
  },
  smoke: {
    desc: 'hermetic behavioural + a11y + robustness (chromium, mocked HN)',
    preview: true,
    steps: [
      { name: 'audit (behaviour)', script: 'audit' },
      { name: 'refreshtest (Refresh forces a fetch)', script: 'refreshtest' },
      { name: 'readtest (read tab)', script: 'readtest' },
      { name: 'personalizeliveupdatetest (mid-session personalize + explainer copy)', script: 'personalizeliveupdatetest' },
      { name: 'readstatetest (read transitions + monotonic)', script: 'readstatetest' },
      { name: 'feedstabilitytest (no wrong vanish)', script: 'feedstabilitytest' },
      { name: 'sessionsweeptest (read-sweep triggers on load/refresh, never nav)', script: 'sessionsweeptest' },
      { name: 'foryousourcetest (For-You from Algolia recent-stories + firebase fallback; jobs excluded)', script: 'foryousourcetest' },
      { name: 'offlinepwatest (service worker: app loads with the serving port down)', script: 'offlinepwatest' },
      { name: 'filtertest (global mute/min-points)', script: 'filtertest' },
      { name: 'feederrortest (outage → error state, not empty)', script: 'feederrortest' },
      { name: 'offlinetest (offline → outage, not not-found/no-results)', script: 'offlinetest' },
      { name: 'toasttest (toast de-dupe + cap)', script: 'toasttest' },
      { name: 'edgetest (security/edge)', script: 'edgetest' },
      { name: 'extremetest (malformed input)', script: 'extremetest' },
      { name: 'a11ytest (axe-core)', script: 'a11ytest' },
      { name: 'dialogreachtest (modals reachable by keyboard, not just wheel)', script: 'dialogreachtest' },
      { name: 'layouttest (structural layouts)', script: 'layouttest' },
      { name: 'commenttest (comment org + ranking)', script: 'commenttest' },
      { name: 'pluraltest (comment-count singular/plural)', script: 'pluraltest' },
      { name: 'hiddenstubtest (un-hide clears the session stub)', script: 'hiddenstubtest' },
      { name: 'searchscrolltest (search lands at top; feed tab kept)', script: 'searchscrolltest' },
      { name: 'discussionviewtest (summary gate + feed-open new-badge)', script: 'discussionviewtest' },
      { name: 'topcommenttest (inline top comment + header toggle)', script: 'topcommenttest' },
      { name: 'previewburst (top-comment previews bounded across cards)', script: 'previewburst' },
      { name: 'llmcachetest (summary sources + cache)', script: 'llmcachetest' },
      { name: 'cloudllmtest (BYO cloud LLM provider + key)', script: 'cloudllmtest' },
      { name: 'refusalattrtest (no false Llama attribution over a refusal)', script: 'refusalattrtest' },
      { name: 'askthreadtest (grounded ask-the-thread Q&A)', script: 'askthreadtest' },
      // The app vouches for what it SENDS, not for what the model emits: thin input refused,
      // untrusted text fenced, and provenance counted from the request. Structural, so a new
      // surface that calls the raw primitive fails the build.
      { name: 'aiguardtest (every AI path is wired to input hygiene)', script: 'aiguardtest' },
      // The list you come back to is the list you left, and you come back to the TOP of it. Covers
      // list identity and order across every excursion, and the session definition itself — a
      // reload continues a session; a new tab or Refresh starts one.
      { name: 'feedcontinuitytest (aim, leave, come back, act)', script: 'feedcontinuitytest' },
      // Page overflow is 0 for a control row that wraps while a line sits half empty, so no
      // overflow guard can see it. This measures the SHAPE of the row instead.
      { name: 'wrapqualitytest (control rows do not wrap raggedly)', script: 'wrapqualitytest' },
      { name: 'articleproxytest (reader-proxy attribution + prefetch)', script: 'articleproxytest' },
      { name: 'articlerankingtest (article body in ranking)', script: 'articlerankingtest' },
      { name: 'articlelinktest (full-text link on click)', script: 'articlelinktest' },
      { name: 'favicontest (privacy toggle: no remote request when off)', script: 'favicontest' },
      { name: 'keyboardtest (all-nav coverage)', script: 'keyboardtest' },
      { name: 'hnaccounttest (account displays + import)', script: 'hnaccounttest' },
      { name: 'datamgmttest (delete data by type)', script: 'datamgmttest' },
      { name: 'weighthintstest (inactive-signal hints)', script: 'weighthintstest' },
      { name: 'reasonstest (why-chip wording thresholds)', script: 'reasonstest' },
      { name: 'rankergatetest (learned min-sample gate)', script: 'rankergatetest' },
      { name: 'autotraingatetest (retrain only when hidden + enough new data)', script: 'autotraingatetest' },
      { name: 'trainlabeltest (glance vs stay training labels)', script: 'trainlabeltest' },
      { name: 'diversitytest (per-domain cap in For You)', script: 'diversitytest' },
      { name: 'themecontrasttest (WCAG contrast, all designs \u00d7 modes)', script: 'themecontrasttest' },
      { name: 'switchtest (switch control rendering + WCAG 1.4.11)', script: 'switchtest' },
      { name: 'cardteachtest (follow/mute from a card)', script: 'cardteachtest' },
      { name: 'mobiletest (mobile tune + read access)', script: 'mobiletest' },
      { name: 'onboardingtest (first-run interests)', script: 'onboardingtest' },
      { name: 'gisttest (non-AI thread digest)', script: 'gisttest' },
      { name: 'searchindextest (search cost is paid by searchers, not readers)', script: 'searchindextest' },
      { name: 'focustest (discussion|article dual-view)', script: 'focustest' },
      { name: 'usertest (profile: stories + comments + AI persona summary)', script: 'usertest' },
      { name: 'settingstoctest (settings table-of-contents nav)', script: 'settingstoctest' },
    ],
  },
  behaviour: {
    desc: 'settings persistence, control wiring, reachability, live end-to-end tour',
    preview: true,
    steps: [
      { name: 'persisttest (settings survive)', script: 'persisttest' },
      { name: 'uiwiring (controls → store)', script: 'uiwiring' },
      { name: 'reachtest (no clipping)', script: 'reachtest' },
      { name: 'uitest (end-to-end tour)', script: 'uitest' },
    ],
  },
  personalization: {
    desc: 'proves the recommender learns + reorders (hermetic)',
    preview: true,
    steps: [{ name: 'personalization-proof', script: 'personalization-proof' }],
  },
  visual: {
    desc: 'visual regression vs baselines (hermetic)',
    preview: true,
    steps: [{ name: 'visualtest', script: 'visualtest', args: UPDATE_VISUAL ? ['--update'] : [] }],
  },
  crossbrowser: {
    desc: 'behavioural + edge sweep on webkit and firefox',
    preview: true,
    steps: [
      { name: 'audit (webkit)', script: 'audit', env: { BROWSER: 'webkit' } },
      { name: 'edgetest (webkit)', script: 'edgetest', env: { BROWSER: 'webkit' } },
      { name: 'audit (firefox)', script: 'audit', env: { BROWSER: 'firefox' } },
      { name: 'edgetest (firefox)', script: 'edgetest', env: { BROWSER: 'firefox' } },
    ],
  },
  stress: {
    desc: 'adversarial rapid interactions (live HN)',
    preview: true,
    steps: [{ name: 'stress', script: 'stress' }],
  },
  webgpu: {
    desc: 'embedding + LLM load and summarization eval via WebGPU (slow, downloads)',
    preview: true,
    steps: [
      { name: 'modeltest', script: 'modeltest', env: llmEnv },
      { name: 'evaltest', script: 'evaltest', env: llmEnv },
    ],
  },
};

const MODES = {
  quick: ['static', 'smoke'],
  standard: ['static', 'smoke', 'behaviour', 'personalization'],
  full: ['static', 'smoke', 'behaviour', 'personalization', 'visual', 'crossbrowser', 'stress', 'webgpu'],
};

// ---- --list ----------------------------------------------------------------
if (flag('list')) {
  console.log('Modes:');
  for (const [m, tiers] of Object.entries(MODES)) console.log(`  ${m.padEnd(9)} → ${tiers.join(', ')}`);
  console.log('\nTiers:');
  for (const [t, def] of Object.entries(TIERS)) {
    console.log(`  ${t.padEnd(16)} ${def.desc}`);
    for (const s of def.steps) console.log(`      · ${s.name}`);
  }
  process.exit(0);
}

if (!MODES[mode]) {
  console.error(`Unknown mode "${mode}". Use one of: ${Object.keys(MODES).join(', ')} (or --list).`);
  process.exit(2);
}

// Resolve the selected tiers (mode set, filtered by --only / --skip), in canonical order.
let selected = MODES[mode];
if (onlyTiers.length) selected = selected.filter((t) => onlyTiers.includes(t));
selected = selected.filter((t) => !skipTiers.includes(t));
if (!selected.length) {
  console.error('No tiers selected after applying --only/--skip.');
  process.exit(2);
}

// ---- run -------------------------------------------------------------------
const results = []; // { tier, name, status: 'pass'|'fail'|'skip', ms }
const needsPreview = selected.some((t) => TIERS[t].preview);
let buildDone = false;
let preview = null;

function runStep(cmd, args, env) {
  const started = Date.now();
  execFileSync(cmd, args, { stdio: 'inherit', env: { ...process.env, ...env } });
  return Date.now() - started;
}

async function startPreview() {
  if (!buildDone) {
    // A preview needs a build; the static tier normally provides it, but if it was
    // skipped (e.g. --only=smoke) build here so there's something to serve.
    process.stdout.write('\n=== build (vite) [preview prerequisite] ===\n');
    runStep('npx', ['vite', 'build'], {});
    buildDone = true;
  }
  process.stdout.write(`\n=== start preview (port ${PORT}) ===\n`);
  preview = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'ignore' });
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(BASE);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  throw new Error(`preview did not start on ${BASE}`);
}

const fmt = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`);
let aborted = false;

try {
  for (const tier of selected) {
    if (aborted) {
      for (const s of TIERS[tier].steps) results.push({ tier, name: s.name, status: 'skip', ms: 0 });
      continue;
    }
    const def = TIERS[tier];
    process.stdout.write(`\n########## tier: ${tier} — ${def.desc} ##########\n`);
    for (const s of def.steps) {
      if (aborted) {
        results.push({ tier, name: s.name, status: 'skip', ms: 0 });
        continue;
      }
      // Bring the preview up lazily, right before the first step that needs it.
      if (def.preview && !preview) {
        try {
          await startPreview();
        } catch (e) {
          console.error(`\n❌ ${e.message}`);
          results.push({ tier, name: s.name, status: 'fail', ms: 0 });
          aborted = !CONTINUE;
          continue;
        }
      }
      const cmd = s.script ? 'node' : s.cmd;
      const args = s.script ? [`scripts/${s.script}.mjs`, ...(s.args || [])] : s.args;
      const env = { ...(s.env || {}), ...(def.preview ? { BASE } : {}) };
      process.stdout.write(`\n=== ${tier} · ${s.name} ===\n`);
      try {
        const ms = runStep(cmd, args, env);
        if (s.build) buildDone = true; // static tier already built — don't rebuild for the preview
        results.push({ tier, name: s.name, status: 'pass', ms });
      } catch {
        results.push({ tier, name: s.name, status: 'fail', ms: 0 });
        if (!CONTINUE) aborted = true;
      }
    }
  }
} finally {
  if (preview) preview.kill('SIGTERM');
}

// ---- summary ---------------------------------------------------------------
const pass = results.filter((r) => r.status === 'pass').length;
const fail = results.filter((r) => r.status === 'fail');
const skip = results.filter((r) => r.status === 'skip').length;
const icon = { pass: '✅', fail: '❌', skip: '⏭️ ' };
process.stdout.write(`\n================= summary (mode: ${mode}) =================\n`);
let curTier = '';
for (const r of results) {
  if (r.tier !== curTier) {
    process.stdout.write(`\n  ${r.tier}\n`);
    curTier = r.tier;
  }
  process.stdout.write(`    ${icon[r.status]} ${r.name.padEnd(34)} ${r.status === 'pass' ? fmt(r.ms) : ''}\n`);
}
process.stdout.write(`\n  ${pass} passed · ${fail.length} failed · ${skip} skipped\n`);
if (needsPreview) process.stdout.write(`  (preview served on ${BASE})\n`);

if (fail.length) {
  console.log(`\n❌ ${mode} failed: ${fail.map((f) => f.name).join(', ')}`);
  process.exit(1);
}
console.log(`\n✅ ${mode} passed`);
process.exit(0);
