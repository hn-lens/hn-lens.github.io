---
name: "hnlens-bughunt"
description: "Independent agent-driven bug hunting, testing, and root-cause analysis for HN Lens via human-interaction simulation. Use for ANY bug hunt, exploratory test, or RCA: spawn a fresh unbiased agent, feed it a neutral factual spec of expected behavior + how to drive the app, and have it exhaustively self-discover discrepancies and root-cause them, then REPORT. The hunt agent is READ-ONLY (never edits code/tests); the primary agent triages the report and applies each fix. Covers the neutral prompt template, driving harness (Playwright + WebGPU + window.__hnlens), and the no-bias rules."
---
# hnlens-bughunt

## Core principle

**All bug hunting, exploratory testing, and root-cause analysis for HN Lens is done by an
INDEPENDENT agent, driven by a NEUTRAL spec — never by the primary agent guessing.** The
primary agent (you) has *bias*: it wrote the code, it has theories, it rationalizes. Those
theories have repeatedly been wrong. So instead:

1. You write a **neutral, factual** brief: *how to drive the app* + *the expected behavior*
   (the spec) + *"find every discrepancy and root-cause it."*
2. You spawn a **fresh, independent agent** (no shared conversation, no hints about suspected
   bugs) and hand it that brief.
3. That agent **drives the app like a human**, exhaustively self-discovers where actual ≠
   expected, root-causes each in the code (`file:line`), and **REPORTS**. It does **not** touch
   the code.
4. **You (the primary) triage the report** and apply each fix + a regression test yourself, then
   re-run the gate.

You do NOT tell it what you think is broken. You give it the ground truth of what SHOULD
happen and let it discover what DOESN'T.

**This is one half of a two-agent iterative review loop.** The other half is the `hnlens-usability`
agent, which role-plays a real user pursuing a real goal and reports usability issues + feature
requests + presentation improvements. This bug-hunt agent checks **correctness** (does it match
the spec); the usability agent checks **effectiveness + ease**. The standing loop:
**usability report → bug report → primary combines/validates/fixes (+ regression tests) + runs the
gate → iterate.** Both agents are read-only; only the primary changes code.

**The hunt agent is strictly READ-ONLY.** It never edits source or tests, never runs builds/the
gate to "make it green," never commits. Its only deliverable is the findings report. This keeps
discovery unbiased AND keeps every code change reviewable — a fix lands only via the primary,
traceable to a specific reported finding. (An earlier version let the hunt agent fix + test +
re-run the gate; it died mid-run and left opaque, unreviewable edits with no report. Don't do
that.)

## When to use this

- Any "there are bugs" / "X is broken" / "hunt for bugs" / "test this thoroughly" / "why does
  Y happen" request.
- After a big feature/refactor, before handing back, as an exploratory pass beyond `test:full`.
- Any root-cause analysis — spawn the independent agent to diagnose, don't theorize solo.

## The no-bias rules (do not violate)

- **Never seed suspected bugs.** Don't write "the Read tab is probably buggy" or paste recent
  failures into the brief. The brief contains only: the expected behavior + how to drive +
  "discover discrepancies." Leading the agent defeats the purpose.
- **Expected behavior is factual, not aspirational-vague.** State concrete, checkable
  behaviors ("opening the discussion and leaving within 8s does NOT mark the story read"), not
  "the read feature should work well."
- **The agent decides what's a bug** by comparing actual vs the spec + by any console/page
  error. If the spec itself turns out wrong, that's a finding too.
- **Exhaustive, adversarial self-discovery** — the agent must not assume anything works; it
  verifies every surface, tries edge cases, cross-feature interactions, every theme×layout,
  mobile, and keyboard-only.

## How to run it

Spawn ONE independent agent with the brief below. **Use a DURABLE primitive so the hunt can't
evaporate at a turn/context boundary:**

- a **foreground `task`** (`subagent_type: "general"`) — you block on it and get the report in
  the same turn; simplest and most reliable, or
- **`session_spawn`** — a truly independent session that survives across turns; poll it with
  `session_read` (use this if you don't want to block).
- **NEVER a background `task`** for the hunt: background tasks are turn-scoped and get torn down
  when the turn ends / context is compacted — that silently killed a hunt mid-run (2026-07-19).

For very wide sweeps, use `batch_task` to fan out the brief across surface areas (one lane each:
feeds/tabs, themes×layouts, comments, summaries/AI, settings/persistence, saved/read,
mobile/keyboard/a11y), then triage the combined report.

The hunt agent's loop is **discover → root-cause → REPORT** (read-only — no code changes). It
returns a structured list: each bug's repro, actual, expected, and root cause (`file:line`) with
evidence. **The primary agent then owns fix → add regression test → re-run `npm run verify` (and
`test:full` if models/themes touched)** — one reviewable change per reported finding.

**Running "until converged":** this is a loop, not a single hunt. After the primary fixes a
report's findings (validating each first — a report can be wrong) and the gate is green, spawn the
hunt AGAIN with a **freshly regenerated spec** (see the rebuild rule below), because the fixes
changed the app and can introduce or reveal new issues. **Convergence = a fresh hunt, driven by an
up-to-date spec against the current build, finds no new actual-vs-expected discrepancy and no
console/page error** (every remaining reported item is validated as a non-bug / documented won't-
fix). A clean-looking hunt run on a stale spec is NOT convergence — it just wasn't looking at what
changed. The reviewer only reports; the primary makes every code change and re-invokes the reviewer.

## The neutral brief (copy, fill the two placeholders, hand to the independent agent)

> You are an independent QA + debugging agent for a static, in-browser Hacker News reader
> ("HN Lens") in the repository at `<REPO_PATH>`. You have NO prior context and should form no
> assumptions — verify everything yourself.
>
> **Your job:** drive the running app like a human across every surface, exhaustively find
> every place where ACTUAL behavior differs from the EXPECTED behavior below (or where the
> console/page throws), and root-cause each in the source (`file:line`). Be adversarial and
> complete: do not assume any feature works.
> **You are strictly READ-ONLY.** Do NOT modify any file in the repo, do NOT fix anything, do NOT
> add or edit tests, do NOT run builds or the test gate to "make it green," do NOT commit or push.
> Building/serving a preview to interact with the app, and writing throwaway Playwright driver
> scripts **in a temp dir outside the repo** (e.g. `/tmp`), are fine; changing the repo's source
> or tests is not. Your ONLY deliverable is a structured findings report — per bug: repro steps,
> actual, expected, root cause (`file:line`), and supporting evidence. The primary agent triages
> your report and applies every fix.
>
> **How to run & drive the app:**
> - Install/build per the `hnlens-build` skill if needed. Build + serve the production preview:
>   `npm run build && npx vite preview --port 4190 --strictPort` (serve on a free port).
> - Automate with **Playwright's bundled Chromium** (a managed/policy-locked system Chrome can
>   stall on external fetches). For
>   the local AI features (embeddings/LLM) launch with `--enable-unsafe-webgpu
>   --enable-features=Vulkan --use-angle=metal` and load over `http://localhost` (WebGPU needs a
>   secure context; models download on first use, minutes).
> - Interact like a real user: click, type, navigate, scroll, use the keyboard. Also test a
>   mobile viewport (~375×780) and keyboard-only navigation.
> - `window.__hnlens` exposes the real modules for seeding/inspecting state: `prefs` (Zustand
>   store), `interactions()`, `db()`, `algolia()`, `llm()`, etc. Use it to seed known local
>   state and to read derived state (e.g. `interactions().getReadItemIds()`).
> - For deterministic runs, mock the HN API with `page.route`: Firebase
>   (`hacker-news.firebaseio.com` — lists return id arrays; `item/<id>` returns one item),
>   Algolia (`hn.algolia.com/api/v1` — `items/<id>` returns a comment tree, `search` returns
>   hits). Playwright uses the LAST-registered matching route. You may also use live HN.
> - Capture **every** console `error` and `pageerror` — each is a bug. Ignore only third-party
>   favicon/network noise (`google.com/s2`, `gstatic`).
> - Existing harnesses are in `scripts/*.mjs` (`node scripts/test.mjs --list`); study them for
>   the driving patterns and mock shapes, but your job is to find what they DON'T cover.
>
> **EXPECTED BEHAVIOR (the spec — this is the ground truth to check actual against):**
> <EXPECTED_BEHAVIOR_SPEC>
>
> **Rules:** verify each expected behavior explicitly; try edge cases and cross-feature
> interactions (e.g. do something to an item in one feed, then check other feeds/tabs/sidebar);
> exercise ALL 31 theme designs × 14 layouts for render/console errors; when you find a
> discrepancy, read the code to identify the true root cause (`file:line`, not a symptom) and
> record it with evidence. You may suggest a fix direction, but do NOT apply it. **Read-only:
> never edit source or tests, never run the gate, never commit or push.**

`<REPO_PATH>` = the absolute repo path. `<EXPECTED_BEHAVIOR_SPEC>` = the spec in the next
section (kept in sync with `AGENTS.md` → "Product decisions & lessons learned", the canonical
source of expected behavior).

## Expected behavior spec (paste into `<EXPECTED_BEHAVIOR_SPEC>`)

> **⚠️ REBUILD THIS AT THE START OF EACH ITERATION — it goes stale.** Before every hunt (including
> the 2nd, 3rd, … pass of a "run until converged" loop), re-read `AGENTS.md`'s "Product
> decisions & lessons learned" section AND `git log` since the previous iteration (which includes
> the fixes you just landed this loop), and fold every
> new/changed feature into the spec below. A reviewer only checks behaviors the spec names — a
> feature added after the spec was written is invisible to it. (The "clicking a link surfaces an
> *Article text* link" bug shipped because this list predated fetch-on-click.) The bullets below are
> a **baseline**, not the whole truth.

Keep factual and checkable. Source of truth: `AGENTS.md`. Point the agent there for depth and
inline these headline behaviors:

- **Feeds/tabs** (Top/New/Best/Ask/Show/Jobs/For You/Read): each tab loads ITS OWN stories (no
  silent fallback to another feed). Each shows an independent "Updated Xm ago" + Refresh (tabs
  are cached separately, not refreshed together). For You is personalized + ranked, with a
  "Why #N?" explainer per card. Nothing an ordinary action does (save/summarize/open) removes a
  card from a feed; only Hide removes (with Undo), and Unsave removes from Saved.
- **Story card:** title opens the article (new tab) or, for text/Show-HN posts, the discussion;
  domain/favicon/meta; score · comments · by; actions = TL;DR, Save, Hide, Open comments, Open
  on HN. Whole-card click opens it. `javascript:` URLs never become links; HTML is sanitized.
- **"Read" = clicked through and STAYED:** opened the article and did not bounce back within
  ~8s, OR opened the discussion and stayed ~8s. Save, summarize, upvote, and imported HN history
  (`meta.source:'hn_import'`) are NOT reads. Read is MONOTONIC — once genuinely read, a later
  quick bounce never un-reads it. Read tab lists read stories newest-first; sidebar "Recently
  read" uses the SAME definition.
- **Comments:** sort control (Default/Newest/Oldest/Most replies) reorders top-level; OP badge
  on the story author; collapse a subtree (shows "+N replies"); indent cap → "Continue this
  thread →" opens the branch at `/item/:id`; jump-to-parent on nested; "new since last visit"
  badge. HN exposes no comment scores → no "top by points."
- **AI summaries** (need WebGPU + LLM enabled): card TL;DR and thread summary both show what
  they used ("Based on article text (~N words) + M comments"); a title-level "Article text" link
  opens the extracted text in a formatted overlay when article-fetch is on. Results are cached —
  a second summarize is INSTANT and does no network (no comment-tree refetch). Two summaries
  fired at once both finish (serialized, no deadlock). Summarizing does NOT mark an item read.
- **Themes/layouts:** 31 designs (palette + font + corners + surface) via the TopNav/Settings
  dropdown; 14 layouts (structure); light/dark is a binary toggle (no "system"). Every design ×
  layout renders with no console error. All 20 settings persist across reload + reopen.
- **Keyboard:** j/k walk the current list (feed, or comments when a thread is open), h/l switch
  tabs, o/Enter open, c comments, s save, g top, / search, ? help; everything else reachable via
  Tab/Shift+Tab + Enter.
- **Filters are GLOBAL:** muted domains/users/keywords + min-points apply on EVERY feed
  (Top/New/Best/Ask/Show/Jobs/Read) AND search, not just For You. Min-points only filters items that
  carry a score (so it can't empty the score-less Jobs feed). The Read empty state says "no reading
  history", not "check filters".
- **Reader proxy + article text (opt-in `fetchArticleText`, default OFF; nothing article-related
  happens when off):** when ON, opening a story's link fetches + caches its full text, and a few top
  For-You candidates you didn't click are prefetched. A card whose body is cached (via click,
  prefetch, or a summary) shows an **"Article text" link** that opens the extracted text + a link to
  the source + **"via &lt;proxy&gt;"**. Summaries show "· via &lt;proxy&gt;". Settings lists the whole
  proxy chain. The candidate's own article body feeds ranking (termAffinity + embedding relevance).
- **Learned reranker trust:** applied only after ≥12 interactions; below that the "Why #N?" dialog
  says it's still learning (X/12) — no noisy "% chance" / contradictory weights on tiny data.
- **AI summary discoverability:** with local AI off, the comments view shows a compact CTA to enable
  it (not silence), unless "show AI summaries" is off. WebGPU is probed (adapter, not just the API)
  so controls don't render then error.
- **Per-domain diversity:** For You caps ~3 stories per domain near the top (a followed mega-domain
  can't flood it); nothing is removed. **Card "Personalize" menu:** follow/mute the story's domain +
  author from the card. **Non-AI "gist":** long threads (≥15 comments) show a heuristic digest.
- **Onboarding:** first-run modal to pick interests (suppressed under automation). **Mobile:** the
  Tune-ranking UI + Read tab are reachable on a phone. **Toasts** de-dupe + cap (no stacking).
- **Data management by type:** Settings → Data lists each data category (fetched article text, AI
  summaries, embeddings, reading history, learned model, saved, hidden, seen, cached stories) with a
  count/size + its own delete; models are managed separately in "Cached models".
- **Robustness:** no uncaught console errors anywhere; empty/error/no-results states; works at a
  laptop and a mobile viewport; visible keyboard focus. It's a static app (no backend); linked
  ARTICLE bodies are only reachable via the opt-in reader-proxy chain.

## After the hunt (the PRIMARY agent does this)

The hunt agent has only reported — it changed nothing. **You (the primary) triage the report and
apply the fixes**, one reviewable change per finding: read the cited root cause, verify it against
the code (a report can be wrong — confirm before fixing), make the root-cause fix (not a symptom
patch), and add a hermetic regression test (assert the corrected behavior AND its negative) in
`scripts/`, wired into the tier runner (see the `hnlens-testing` skill). Then re-run `npm run
verify` (and `test:full` for model/theme/visual), and record any durable lesson in `AGENTS.md`.
A passing test proves the code matches your instruction, not that the behavior is right — keep
judgment on. The independent-agent process itself is the standing method — use it for the next
hunt too, don't regress to solo guessing.
