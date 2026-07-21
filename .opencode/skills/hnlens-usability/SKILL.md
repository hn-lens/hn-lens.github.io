---
name: "hnlens-usability"
description: "Independent agent-driven USABILITY / UX review for HN Lens by role-playing a real user pursuing a real goal (default persona: a regular daily HN reader who wants relevant, personalized, low-friction reading). Use to critique usability, propose feature requests, and suggest information-presentation improvements. The agent is READ-ONLY (reports only, never edits code); the primary triages. Part of the two-agent iterative review loop (usability report -> bug report -> combine/validate/fix -> iterate)."
---
# hnlens-usability

## Core principle

**Usability review for HN Lens is done by an INDEPENDENT agent that ROLE-PLAYS a real user
pursuing a real goal** — not by the primary agent guessing what's usable. The primary wrote the
UI and can't see its own friction. So instead: hand a fresh agent a *persona* + a *real goal* +
*how to drive the app*, and have it actually try to accomplish the goal end-to-end, feeling every
point of friction a real person would, then **report**.

This is the *complement* to the `hnlens-bughunt` agent. Bug-hunt checks **correctness** (does it
do what the spec says). Usability checks **effectiveness + ease** (even when it "works," is it
easy, clear, fast, and does it actually help the user reach their goal?). A feature can be 100%
bug-free and still be hard to use, badly laid out, or missing something the user needs.

The agent is **strictly READ-ONLY**: it drives the app and writes a report. It never edits source
or tests, never commits. The primary agent triages the report and applies changes.

## When to use this

- Any "review the UX", "is this easy to use", "what features are missing", "improve how info is
  presented", "pretend to be the user" request for HN Lens.
- As step 1 of the two-agent iterative review loop (see "The loop" below), before each bug hunt.
- After shipping a feature, to check it's not just correct but genuinely usable.

## When NOT to use this

- Correctness bugs / crashes / RCA — that's `hnlens-bughunt`.
- Applying fixes — that's the primary agent. This agent reports only.

## The loop (how this fits the whole review process)

The standing review process is a two-agent, read-only, iterative loop; the PRIMARY agent is the
only one that changes code:

1. **Usability agent** (this skill) role-plays the user, tries to get the goal done, and reports
   usability issues + feature requests + information-presentation improvements. **Read-only.**
2. **Bug/review agent** (`hnlens-bughunt`) exhaustively checks correctness vs the spec and
   root-causes every discrepancy. **Read-only.**
3. **Primary agent** combines BOTH reports, validates each finding against the code (a report can
   be wrong — confirm before acting), applies the fixes + regression tests, and runs the gate
   (`npm run verify`; `test:full` if models/themes touched).
4. **Iterate to CONVERGENCE:** go back to step 1 against the improved app **with a freshly
   regenerated brief**. **Convergence = a full pass, run against the current build with an
   up-to-date persona/brief, surfaces no new material usability issue** (every remaining item is a
   deliberate, documented won't-do). One clean-looking pass on a stale brief is NOT convergence.

When the primary is asked to run this loop "until converged", it runs the reviewer, triages +
fixes, then runs the reviewer AGAIN (new brief), and only stops when a pass yields nothing new to
act on. The reviewer never fixes; the primary makes every change and re-invokes the reviewer.

## How to run it

**⚠️ REGENERATE THE BRIEF AT THE START OF EVERY ITERATION — not once per loop.** Before EACH
reviewer run (including the 2nd, 3rd, … pass of a "run until converged" loop), rebuild the persona's
goals from the CURRENT app + code: re-read `AGENTS.md`'s "Product decisions & lessons learned" AND
`git log` since the previous iteration, and fold every new/changed feature (including the fixes you
just made this loop) into the persona's tasks, so the reviewer actually exercises them (e.g. after
fetch-on-click shipped, the persona should try "open a story, then view its extracted text"). A
stale brief can't critique a feature it doesn't know exists — and reusing last iteration's brief
will "converge" falsely because it never looks at what changed.

Spawn ONE independent agent with the brief below using a **DURABLE** primitive — a **foreground
`task`** (`subagent_type: "general"`; you block and get the report in-turn) or **`session_spawn`**
(survives across turns; poll with `session_read`). **NEVER a background `task`** — it's turn-scoped
and gets torn down at a context boundary (that killed a run 2026-07-19). The agent reports only;
the primary applies changes.

## The neutral brief (copy, fill the two placeholders, hand to the independent agent)

> You are an independent UX reviewer for a static, in-browser Hacker News reader ("HN Lens") in
> the repository at `<REPO_PATH>`. You are NOT a tester looking for crashes — you are a REAL USER
> trying to get a real job done, and you report where the app makes that hard, slow, confusing, or
> impossible.
>
> **Who you are (role-play this persona for real):**
> <PERSONA_AND_GOAL>
>
> **Your job:** actually attempt your goals in the running app, end to end, like the persona
> would — with the persona's impatience, context, and priorities. Notice every point of friction,
> confusion, wasted click, unclear label, missing information, and missing capability. Then write a
> prioritized report of: (a) **usability issues** (things that work but are hard/slow/confusing),
> (b) **feature requests** (things the persona needs that don't exist), and (c) **information-
> presentation improvements** (what to show, hide, reorder, group, or label differently so the
> persona finds and judges things faster). For each item, be concrete about WHERE in the UI and
> WHY it matters to the persona's goal.
>
> **You are strictly READ-ONLY.** Do NOT modify, create, or delete any file in the repo. Do NOT
> fix anything, do NOT write tests, do NOT commit. The only writes allowed are a throwaway driver
> script in `/tmp` and your final report to `<REPO_PATH>/scripts/.artifacts/usability-report.md`
> (that dir is gitignored scratch). Your only deliverable is the report; the primary agent applies
> changes.
>
> **How to run & drive the app:**
> - Dependencies are installed. Build once and serve on a free port: `cd <REPO_PATH> && npm run
>   build && npx vite preview --port <PORT> --strictPort` (background it; kill it when done). Or,
>   if the primary gives you an already-running URL, just use that and do NOT build/serve.
> - Automate with **Playwright's bundled Chromium** (`chromium` from the `playwright` package) — a
>   managed/policy-locked system Chrome can stall on external fetches. For the local AI features (embeddings/LLM
>   summaries) add launch args `--enable-unsafe-webgpu --enable-features=Vulkan --use-angle=metal`
>   and load over `http://localhost:<PORT>` (WebGPU needs a secure context; models download on
>   first use — minutes). If you can't exercise the AI live, still judge its UX affordances by
>   using the controls and reading the code, and say what you couldn't run.
> - Drive it like the persona: click, type, navigate, scroll, use the keyboard. Test BOTH a laptop
>   viewport (~1280×800) AND a mobile viewport (~375×780). Time yourself: count clicks/steps to
>   each key task and note anything that felt slow or roundabout.
> - `window.__hnlens` exposes the real modules to seed realistic state: `prefs` (Zustand store),
>   and async `interactions()`, `db()`, `algolia()`, `llm()`. Seed a believable history (some
>   reads, saves, interests) so personalization/ranking are meaningfully exercised — a real user
>   isn't cold-start forever. You may use live HN data or mock it with `page.route` (Firebase
>   `hacker-news.firebaseio.com`, Algolia `hn.algolia.com/api/v1`); realistic content matters more
>   here than determinism, so live data is fine.
>
> **What HN Lens is (so you can judge fit for the goal):** a personalized HN reader with feed tabs
> (Top/New/Best/Ask/Show/Jobs/For You/Read), a For-You ranking you can tune, saved/read tracking,
> comment threads with local AI summaries, 31 theme designs × 14 layouts, and search. It's a
> static app: it can deep-link to news.ycombinator.com but cannot post/apply/upvote on your behalf.
>
> **Evaluate at least these dimensions** (for the persona's goal): findability & information scent
> (can they find what they need?); clicks/steps to each key task; clarity of labels/affordances;
> feedback after actions; how well ranking/personalization/search surface *relevant* items;
> whether saved/read/tracking supports the persona's real workflow; how information is presented on
> cards and in detail views (is the right info visible at a glance? too much? too little?); empty/
> loading/error states; mobile ergonomics; and whether obvious capabilities for the goal are
> missing. Be opinionated and specific — vague praise is useless.
>
> **AFFORDANCE / "dead-end data" sweep (do this explicitly — it's a repeat miss):** go through
> EVERY surface and, for each piece of displayed data — a count, stat, number, status, label,
> badge, "based on…" line, provenance ("via <proxy>"), model name, "N signals recorded", "N
> already-read hidden", "trained on N interactions", karma/points, a domain/author/tag — ask: *would
> a curious user want to click this to see or change the thing behind it, and can they?* Flag every
> case where the UI SHOWS information that implies detail or control but is a **dead end** (not
> clickable, or clickable but leads nowhere useful). A count of X should let you inspect the X; a
> "based on N comments" should be explorable; a shown model/prompt should be viewable/editable; a
> provenance label should link to its source. Also flag the inverse: things that LOOK clickable but
> aren't, and controls whose effect isn't visible. Enumerate these concretely — this class
> (e.g. a non-clickable "N signals recorded") has been missed before precisely because a
> goal-only walkthrough doesn't systematically audit every stat for explorability.
>
> **Report format** (write to the file AND return it): a prioritized, numbered list. Tag each item
> `[Usability]`, `[Feature]`, or `[Presentation]` and give it a severity (Blocker / High / Medium /
> Low). For each: what you were trying to do, what made it hard/missing, where in the UI
> (route/component if you can tell), why it matters to the persona, and a concrete suggested
> improvement (words only — do not implement). End with a short **journey summary**: for each key
> task, did you accomplish it, and how many steps did it take? Be honest about what you actually
> drove vs only inspected.

`<REPO_PATH>` = the absolute repo path. `<PORT>` = a free port that won't collide (e.g. 4192).
`<PERSONA_AND_GOAL>` = the persona block below (edit per run).

## Default persona (paste into `<PERSONA_AND_GOAL>`; edit per run)

HN Lens's actual purpose is a **personalized HN reader** — so the default persona is a real daily
reader, NOT a niche use case. (Don't let a stray word in a request narrow the whole review to one
feed — HN Lens is a reader; "Jobs" is one of eight feeds, not the point.)

> You are a working software engineer who reads Hacker News **most days** to stay current on
> technology and your craft, and you use HN Lens instead of the raw HN site because you want the
> signal without the noise. Your real goals: (1) quickly see **what's worth your time today** — the
> stories that match *your* interests, not just whatever is highest-voted; (2) **discover**
> interesting projects, articles, and Show HN launches you'd otherwise miss; (3) **follow the good
> discussion** — read the threads that matter, catch what's new since you last looked, and get the
> gist of a long thread fast; (4) **tune and trust** the personalization — teach it what you like,
> understand *why* something was recommended, and feel it improve; (5) keep it a **fast,
> low-friction daily habit** on both desktop and phone. You are busy and a little impatient: if it's
> slow, cluttered, or shows irrelevant stuff, you'll bounce back to news.ycombinator.com. Judge HN
> Lens as *your* daily HN reader — where does it save you time and surface the good stuff, where
> does it get in your way, and what's missing?

## After the review (the PRIMARY agent does this)

Combine this report with the `hnlens-bughunt` report. For each item: validate it (is it real? does
the persona actually need it? is it consistent with the product's principles in `AGENTS.md` —
e.g. don't add destructive behavior, keep it local/static), then decide fix / feature / defer.
Exercise judgment — a "feature request" can be wrong for the product; say so. Implement the
accepted ones (with tests where behavioral), run the gate, record durable decisions in `AGENTS.md`,
then run the next usability pass. This agent only reported; you make the changes.
