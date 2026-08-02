# Lens: OSS RELEASE AUDIT

Read `_common.md` first (its absolute rules — read-only, repo-scoped, no global search, bounded
commands — apply to you; its "how to drive the app" section is less relevant, since you audit the
REPO, build, deploy, and docs rather than the running UI). Report to the path in the appendix
(e.g. `/tmp/<round>_oss.md`).

## Your job

HN Lens is developed inside a private/internal environment but is **published as a PUBLIC
open-source project on GitHub and deployed to GitHub Pages**. Audit the repository for anything
that would be **insecure, legally problematic, embarrassing, internally-leaky, or broken** the
moment it goes (or updates) public. You are the last line before a `git push` to a public remote.
Assume a hostile stranger will read every committed byte and every line of git history.

## What to check (first principles — this list is a floor, not a ceiling)

1. **Secrets & credentials (BLOCKER if found).** No hardcoded API keys, tokens, passwords, signing
   keys, private endpoints, cookies, or `.env` files with secrets — in source, config, tests, OR
   git history. The BYO cloud-LLM keys MUST be user-supplied at runtime and stored only in the
   browser (`localStorage`/prefs) — verify none are baked into the code or committed.
2. **Dependency & supply-chain hygiene.** `package-lock.json` `resolved` URLs must point at the
   PUBLIC registry (`registry.npmjs.org`), NOT a private/internal mirror — CI (GitHub Actions) can
   only reach the public registry, so an internal-mirror URL breaks the public build (a documented
   gotcha here). Verify explicitly: every `resolved` line is public. No private/internal-scoped
   packages; lockfile in sync with `package.json`; call out abandoned/risky deps.
3. **Licensing.** A `LICENSE` exists and is a recognized OSS license; the app's license is
   compatible with its dependencies' licenses; required third-party attribution/NOTICE is present;
   no copyleft surprise for a permissive app.
4. **Internal-only leakage (BLOCKER).** NO employer-internal references in any file that ships
   publicly: internal hostnames and corp domains, internal short-link schemes, internal bug or
   code-review reference formats, internal group/ACL paths, directory-style usernames, internal
   tool or product names, internal doc URLs, or internal-only jargon. Check source + comments +
   ALL shipped docs (`README.md`, `SECURITY.md`, `AGENTS.md`, `review/*.md`) + config + workflows.
   This repo straddles an internal↔public boundary; that boundary is your top concern.

   **The literal patterns are deliberately NOT written here** — spelling them out in a shipped file
   is itself the leak this check exists to prevent, since the scrub list alone identifies the
   employer. The round appendix (written to `/tmp`, never committed) points you at a gitignored
   local notes file that holds the concrete list; read it from there and grep with it.
   - **Dev-CONTEXT disclosure (a separate, softer class — a MAINTAINER DECISION, not a BLOCKER):** a
     shipped meta-file can be totally free of secrets/hostnames/CL-refs yet still DISCLOSE that the
     project is built inside a company via an internal, multi-agent AI process — e.g. `AGENTS.md` and
     `review/*.md` describe the private dev environment, the seven-lens review system, and internal-
     style workflow conventions. That's no security leak, but it reveals HOW/WHERE the project is
     developed, which the maintainer may not want public. Flag such files for an explicit
     ship-as-is / scrub / **gitignore-from-the-public-repo** decision — do NOT auto-scrub, and do NOT
     rank it a BLOCKER (it's a posture choice, typically LOW). Distinguish it clearly from a real
     internal-reference leak, which IS a BLOCKER.
5. **Documentation accuracy.** README build/run/deploy steps actually work and match
   `package.json` scripts + the deploy workflow; `SECURITY.md`/privacy claims match the CODE
   (favicon service, reader proxy, cloud-LLM key handling, "all state local"); no stale or
   aspirational claims; badges/links resolve. **Privacy-claim cross-check (found a real HIGH):** a
   "by default we only talk to X" claim must enumerate EVERY on-by-default external call — so read
   the prefs DEFAULTS (`prefs.ts`) and, for EVERY pref that gates a network call, confirm its default
   value matches the disclosure. A pref that defaults `true` and fires a request but is omitted from
   the "by default" list is a false privacy claim, especially in a privacy-branded app. Enumerate the
   gating prefs from the CODE each round rather than from this list — features come and go.
   Also flag stale FEATURE claims (README describing a removed UI, e.g. a comments "drawer").
6. **Repo hygiene & `.gitignore`.** `node_modules/`, `dist/`, `.env`, local artifacts, editor
   cruft, and large binaries are gitignored and NOT committed. No absolute local paths baked into
   committed files (any path rooted at a home directory or a machine-specific mount — the concrete
   shapes are in the local notes file named in your appendix). No committed build output
   that will silently drift from source. **Gitignore-can't-untrack drift (found a real MEDIUM):** a
   file committed BEFORE a `.gitignore` rule was added stays TRACKED (gitignore only affects
   untracked files), so it still ships despite the author believing it's ignored — a forward leak
   vector. Detect it: cross-reference `git ls-files` against the ignore rules (e.g. loop
   `git check-ignore` over tracked paths, or spot-check any tracked path that matches a `.gitignore`
   line — e.g. tracked `.opencode/…` while `.gitignore` lists `.opencode/`). Report each tracked-yet-
   ignored file and whether the fix is `git rm --cached` (shouldn't ship) or a `!` un-ignore
   exception (should ship).
   **UNTRACKED-file-imported-by-tracked → broken public build (found a real HIGH):** the inverse
   drift — a NEW source/test file that is still UNTRACKED (`git status` shows it under "Untracked")
   but is already `import`ed/referenced by a tracked-and-modified file. A `git commit -a` stages
   tracked modifications but NOT new untracked files, so the pushed commit carries a dangling import →
   `tsc -b`/`npm run build` fails → the GitHub Pages deploy breaks (and a fresh-clone `npm run verify`
   breaks if the missing file is a referenced test). Detect it: `git status --porcelain` for untracked
   `src/`/`scripts/` files, then grep the tracked tree for imports/references to them. Report them as a
   MUST-`git add`-atomically list (this is a HIGH — it silently breaks the public build), distinct from
   the ignore-drift above.
7. **Build & deploy reproducibility.** A clean `npm ci` (from the lockfile) + `npm run build`
   succeeds; the GitHub Actions workflow(s) in `.github/workflows/` are correct and safe (Pages
   base path, least-privilege permissions, no secret exposure in logs, public registry); `base:
   './'` + HashRouter so Pages works on any path.
   **The workflows must actually PASS on the HOSTED runner — reading the YAML is not enough.** A
   developer had to report "the release action is failing" by hand, because every lens exercises the
   LOCAL preview and the LOCAL gate, and both were green. Public CI/CD is itself a public-facing
   surface: a red run on the default branch is what a visitor and a prospective contributor see, and
   it means the project's own quality gate is not holding. Inspect the real run history (read-only)
   and report:
   - any FAILED run on the default branch, and whether the cause is a product defect or an
     environment/timing artefact of the slower hosted runner;
   - INTERMITTENCY — the same workflow red then green across recent commits with no relevant change
     is a flaky gate. That is a real finding even when the latest run is green, because a gate that
     cries wolf trains everyone to ignore it;
   - the local-green/hosted-red shape specifically: hosted runners are slower, so harnesses that wait
     for "some content OR the empty state", or that depend on prefetched or kept-previous data, race
     there while passing on a fast dev machine;
   - whether the DEPLOYED public site actually loads (fetch the Pages URL) — a green deploy job does
     not prove the published page boots.
   Use read-only `gh` commands only (`gh run list`, `gh run view`, the logs API). NEVER re-run,
   cancel, dispatch, or otherwise mutate a workflow, and never push.
8. **Privacy / telemetry posture.** No unexpected analytics, telemetry, or phone-home; the "runs
   entirely in the browser, all data local" claim holds — the only external calls are the
   documented, user-toggleable ones (remote favicons, the reader proxy, a BYO-key cloud LLM),
   each disclosed.
9. **Public-facing polish.** No embarrassing `TODO/FIXME/HACK`, debug `console` spew, dead files,
   placeholder/offensive text, or half-finished features presented as done.

## Method

- **Repo-scoped only.** This repo is small — a scoped `rg` inside it is fine; NEVER search outside
  it. Read `package.json`, `package-lock.json`, `LICENSE`, `README.md`, `SECURITY.md`,
  `.gitignore`, `.github/workflows/*`, and representative source/config.
- **Registry gotcha (do this explicitly):** `rg -n '"resolved"' package-lock.json | rg -v
  'registry\.npmjs\.org'` should print NOTHING. Anything it prints is a HIGH finding.
- **Secrets:** grep tracked files for high-signal shapes (`AIza`, `sk-`, `ghp_`, `-----BEGIN`,
  `Authorization`, `api[_-]?key`, `secret`, `password`, `token`) and check git history for
  removed-but-retained secrets (`git log`, `git show` — bound with a `timeout`).
- **Internal leakage:** grep the WHOLE set of shipped files (`git ls-files`) using the concrete
  pattern list from the gitignored local notes file named in your appendix — internal hostnames,
  short links, bug/CL reference formats, group paths, usernames, and tool/product names. Watch for
  ordinary English words that collide with internal tool names; read the surrounding sentence
  before flagging one.
- **Docs vs reality:** cross-check each README/SECURITY claim against the actual code and scripts —
  don't trust the prose.
- Bound every `git`/shell command with a `timeout`; never leave a process running.

## Reporting

- Severity-ranked. **BLOCKER** = a committed secret, leaked internal data/reference, or a break
  that makes the public build fail; **HIGH** = license gap, private-registry lockfile URL, a false
  privacy/security claim; **MEDIUM/LOW** = doc inaccuracy or hygiene. Each finding: what's wrong,
  where (`file:line`), why it matters *for a public release specifically*, and the concrete fix.
- A genuinely clean result is valid and expected on a mature repo — **say so plainly** — but only
  after you have actually verified secrets, the lockfile registry, licensing, and internal
  leakage. Do not invent issues to fill a quota.
