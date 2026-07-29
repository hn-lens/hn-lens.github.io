# AGENTS.md — Hacker Lens

A **static, in-browser** Hacker News reader: personalized recommendation feed, custom ranking,
comments UX, and **local** AI (embeddings + a small in-browser LLM). No backend. Everything runs
in the browser; deploys to GitHub Pages.

**Stack:** React 19 + TypeScript + Vite + Tailwind v4 · TanStack Query · Zustand · Dexie
(IndexedDB) · Transformers.js + WebLLM (lazy).

> Procedures are codified as skills — load them, don't improvise:
> **`hnlens-build`** (install/dev/build/preview/single-file/deploy), **`hnlens-testing`**
> (the Playwright harness suite + `npm run verify`, coverage rules), **`hnlens-bughunt`**
> (the independent-agent, human-simulation bug-hunt / RCA process — how ALL bug hunting is done),
> and **`hnlens-usability`** (the independent-agent USABILITY/UX review — role-play a real user).
> Review runs as a **read-only iterative loop of SEVEN independent lenses** (usability → UI/UX
> stress → design & theme → AI → bug → performance → OSS release audit → primary fixes → iterate;
> see golden rule #7). This file is the *why* and the *gotchas*; the skills are the *how*.

---

## Golden rules

1. **Never commit or push unless asked.** When asked, gates must be green first (`npm run verify`).
2. **`npm run verify` before you hand anything back** — it runs the **standard** test tier
   (typecheck, lint, build + the hermetic/behavioural/personalization harnesses). `npm run
   test:quick` is the fast inner loop; `npm run test:full` adds visual, cross-browser, stress, and
   the WebGPU model tests. Keep `test:ui` green (**0 issues, 0 console errors**). See the
   `hnlens-testing` skill for the tier map (`node scripts/test.mjs --list`).
3. **When you add a feature or fix a bug, add/extend a harness for it** (see the testing skill's
   coverage matrix). Coverage is by *surface/interaction*, not lines — every control and state has a
   test.
4. **Exercise judgment on UX soundness — don't just implement-and-green.** If a requested behavior is
   destructive or surprising (e.g. removing/moving items a user is actively reading), say so and
   propose the non-destructive alternative *before* building it. A passing test proves the code does
   what you told it to, **not** that the behavior is right — never encode a workaround as "correct" in
   a test. The `hideReadInFeed` auto-hide shipped green *twice* in bad naive forms this way (live-yank
   and stale-snapshot); the sound resolution is **design #4** — recompute the sweep on a fresh load
   (reload / new tab) or Refresh, **never** on in-app navigation, and keep it fixed within a page load
   (no mid-read yank) — see the auto-hide lesson under Product decisions.
5. **Heavy ML libs load only via dynamic `import()`** (`@huggingface/transformers`, `@mlc-ai/web-llm`).
   Never statically import them in the app path — it would bloat the main bundle.
6. **Test at realistic laptop viewport heights** (768/800/900), never oversized canvases — that is
   how the clipped-sidebar bug slipped through. Any `sticky`/`overflow` container needs a
   max-height + scroll and a bottom-reachability assertion (`npm run test:reach`).
7. **Review is done by SEVEN INDEPENDENT, READ-ONLY lenses in an iterative loop — not by solo
   guessing, and the review agents NEVER change code.** The primary agent is biased (wrote the code,
   has wrong theories — proven repeatedly), so fresh agents review and only the primary fixes. Run
   these seven lenses each round, **IN THIS ORDER**, each as its own read-only agent:
   1. **Usability** (load **`hnlens-usability`**) — role-plays a *real user pursuing a real goal*
      (default persona: a regular daily HN reader — Hacker Lens is a personalized HN *reader*, so don't
      let a stray word narrow it to one feed); reports usability issues + feature requests +
      information-presentation improvements (effectiveness & ease).
   2. **UI/UX stress** — a creative "break the app" pass across a **device matrix** (desktop, mobile
      emulation *with touch*, tablet) at realistic viewport heights; drives every control + hostile
      combinations and hunts visual / layout / overflow / **scrollbar** glitches. (This is the lens
      that must independently catch things like the mobile feed-tabs scrollbar — headless overlay
      scrollbars hide it, so it must emulate a real touch device and inspect computed styles.)
   3. **Design & theme** — a VISUAL DESIGN & readability pass across the **full theme/layout matrix**:
      EVERY one of the 31 designs (`themeName`) in BOTH light and dark modes, and every one of the 14
      layouts (`data-layout`). It must check TWO distinct kinds of contrast, because passing one does
      NOT imply the other:
      - **(a) TEXT contrast** of every text element (body/muted/subtle text, headings, accent links,
        button LABELS, "why" chips, badges, the At-a-glance chart colors + treemap tile labels + SVG
        network/mind-map text & edges, context panel, dialogs, sidebar) — WCAG AA: 4.5:1 normal, 3:1
        large.
      - **(b) NON-TEXT / UI-COMPONENT contrast (WCAG 1.4.11, ≥3:1)** — whether each INTERACTIVE
        CONTROL is *visible AS a control and distinguishable from its neighbours*, independent of its
        label. For EVERY button, segmented toggle, text input, dropdown, and pill (e.g. the
        discussion **Discussion|Article** view toggle, the At-a-glance **viz switcher**, the comment
        **Sort** control, the **"N replies"** collapse pill, story-card action buttons, the search
        box, dialog buttons) check: does the control's FILL and/or BORDER contrast ≥3:1 against the
        ADJACENT surface (so it doesn't melt into the page)? For a GROUPED/segmented control, can you
        tell there are N SEPARATE segments (visible divider/border between them) AND which one is
        SELECTED (the active segment clearly distinct from the inactive)? A control whose label is
        readable but whose body is invisible, or a two-segment toggle that looks like one blob, is a
        FAILURE — and this fails even in the DEFAULT theme, so text-only checks miss it.
      It **computes contrast programmatically** for the key foreground/background pairs AND the
      control-fill/border-vs-surface pairs of every design×mode, AND **screenshots the control
      clusters** (discussion header toggle + action row, viz switcher, sort control, collapsed-reply
      pills, story-card actions) in representative themes to confirm each control is findable and its
      segments/active-state are distinguishable. Reports per-(design, mode/layout) the elements that
      are hard to READ or hard to SEE/FIND/tell-apart, with the measured ratio + the responsible token
      (`index.css` / `themes.ts` `file:line`). (This is the lens that catches both "text X is illegible
      in theme Y" AND "you can't tell that control Z is a button / has two segments" — the UI/UX-stress
      lens only spot-checks themes and does not measure component contrast.)
   4. **AI** — reviews the *use* of AI (summaries, editable prompts, transparency, discoverability)
      AND the technical ML: model choice, prompt completeness/config, learned-ranker training /
      eval / calibration, on-device vs cloud correctness, and data gaps.
   5. **Bug/correctness** (load **`hnlens-bughunt`**) — a *neutral, factual* brief (how to drive the
      app + the expected-behavior spec + "exhaustively discover every discrepancy and root-cause
      it"), never seeded with suspected bugs; reports correctness discrepancies with root causes
      (`file:line`).
   6. **Performance** — latency (interaction, render, feed/summary/context load) AND resource use
      (bundle size, memory, redundant fetches / network, IndexedDB growth); reports concrete costs
      + causes.
   7. **OSS release audit** (load **`oss-release`** base prompt) — Hacker Lens is developed in a private
      environment but **published publicly** (GitHub + Pages). Audits the REPO/build/deploy/docs (not
      the running UI) for anything unsafe to make public: committed **secrets** / API keys, **internal
      leakage** (employer-internal hostnames, short-link schemes, bug/CL reference formats, group
      paths, usernames or tool names in any shipped file incl. `AGENTS.md` + `review/*.md` — the
      literal patterns live in the gitignored local notes, deliberately NOT here), the
      **`package-lock.json` public-
      registry** gotcha (a private-mirror `resolved` URL breaks the public CI build), **license**
      presence/compatibility, **doc accuracy** (README/SECURITY claims vs. code), `.gitignore` /
      committed-artifact / absolute-local-path hygiene, deploy-workflow safety, and the "all-local, no
      telemetry" privacy posture. Reports `file:line` + the public-release risk.
   - **Briefs:** usability + UI/UX-stress + design-&-theme get a PERSONA / visual-quality goal + the
     device or theme/layout matrix (NOT a correctness spec); AI + bug + performance + OSS-release get
     a neutral factual SPEC / release-checklist + how to drive it (NOT hypotheses). Never tell any
     lens where a bug is.
   - **REFRESH THE SPEC BEFORE EVERY RUN (do not reuse a stale brief).** Rebuild every lens's brief
     from the *current* features each time — re-read this file's "Product decisions & lessons
     learned" AND `git log` since the last review, and fold every new/changed feature into the spec
     + persona goals. A lens can only catch behaviors its brief describes. (2026-07-20: the "Article
     text link" bug shipped because the spec predated fetch-on-click.)
   - **The loop:** usability → UI/UX stress → design & theme → AI → bug → performance → OSS release
     audit → **the primary combines all reports, validates each finding against the code (a report can
     be wrong — confirm first), applies root-cause fixes (+ regression tests), and runs the gate** →
     then iterate from usability again, until a full round is clean.
   - **FIX DISCIPLINE (a fix is not done until all four hold — see `review/README.md` step 3).**
     (i) re-run the LENS'S repro across the LENS'S matrix, not a narrower probe of your own;
     (ii) enumerate the SIBLINGS of the shape and fix them in the SAME change, stating what you
     grepped and how many sites you found; (iii) write down and TEST the invariant your fix assumes;
     (iv) after the fix batch, run one diff-scoped read-only pass over just the changed surfaces.
      Also record each finding's ORIGIN (new-from-my-fix / incomplete-sibling / pre-existing) so the
      self-inflicted-regression rate stays measurable.
    - **CONVERGENCE MODE (adopted 2026-07-26, after rounds 16–20 all failed to converge).** Measured
      across round 20, **8 of 15 findings were created by round 19's own fixes** — a loop that
      generates ~1 new finding per fix cannot terminate, and the review side was not the problem.
      While converging, four rules bind:
      1. **No narrative comments in source.** Reasoning goes in `review/README.md`, which is audited
         and versioned. In code, state only what is mechanically true. Long explanatory comments
         added during fixes were the single largest defect category (12 false claims in one round,
         nearly all prose written to explain a fix — `Logo.tsx`, `useFeed.ts`, `feedSession.ts`,
         `html.ts`, `index.css`). Every comment is an unverified claim; stop manufacturing them
         faster than anything can audit them.
      2. **Feature freeze.** Defect removal only — no new notices, controls or capabilities until a
         round is clean. The `departed` notice was new capability added while fixing a claim audit,
         and became a HIGH in the next round.
      3. **Write the failing test FIRST, from the lens's own words, before touching code.** A guard
         written after the fix encodes what you did, not what should be true — twice in one session a
         guard passed while the behaviour was still wrong.
      4. **Cap the batch at ~5 findings**, then gate, then run a diff-scoped read-only pass over only
         those changes, before taking the next batch. Fixing fifteen things and gating once is how
         the regressions get in.
      **Prefer deletion.** When a lens says something is wrong, removing the wrong thing (a false
      comment, a dead function, a broken notice) is usually the correct minimal fix.
    - **TERMINATION.** "Zero findings" is unreachable — any thorough lens always finds something, which
      is why rounds 16–20 all "failed". A round CONVERGES when: **zero BLOCKER/HIGH**, **zero
      self-inflicted regressions**, and **every MEDIUM either fixed or explicitly accepted in writing
      with a rationale**. That makes the self-inflicted rate the actual convergence signal.
   All seven lenses are **strictly READ-ONLY: never edit code/tests, never run the gate, never
   commit** — their only deliverable is a report. Run each as a **durable** job — a foreground
   `task` (block on it) or `session_spawn` (survives turns) — **never a background `task`** (turn-
   scoped; gets torn down at a context boundary, which silently killed a hunt mid-run 2026-07-19).
8. **A DEVELOPER-REPORTED DEFECT GOES THROUGH THE LENSES — NEVER STRAIGHT TO A FIX.** When the
   developer reports something that needs fixing (a bug, a wrong output, a confusing UI — e.g. the
   "Why #N?" reconciliation defect), **DO NOT fix it directly.** A direct fix is wrong three ways: the
   primary agent is biased (rule #7), a hand-patch carries **no independent signal** that the problem
   is real or fully understood, and it addresses only the **reported instance**, never the **class** —
   so the next instance of the same kind ships again, and the review loop still can't see it. A
   developer report is not a work order; it is **evidence that a lens has a blind spot.** The report's
   real value is that it tells you *which detector is broken*. Instead, in this order:
   1. **Diagnose the CLASS, not the case.** Ask "what general kind of defect is this an instance of?"
      (not "how do I make this one symptom go away"). Name the class explicitly.
   2. **Identify which lens should have caught it**, and why it didn't — quote the brief's existing
      wording that *nearly* covers it and explain the gap. (For "Why #N?": `ai-ml.md` checked "each
      number equals feature×weight" — individually exact — but never "do the parts RECONCILE / does
      the sign mean what a reader thinks".)
   3. **Upgrade that lens's brief** (`review/base/*.md`) to catch the whole KIND — generalized beyond
      the reported surface, with the grading procedure that would surface it. Fold into every other
      lens whose scope also touches the class.
   4. **PROVE THE DETECTOR on the PRE-FIX state.** A brief edit is a hypothesis until demonstrated.
      Reproduce the defect (a scratch copy of the tree with the fix reverted, served on its own port —
      never disturb the developer's 5173) and run the upgraded lens against it **read-only**. It must
      **independently rediscover the defect without being told it exists**. If it doesn't, the brief is
      still wrong — iterate on the brief, not on the code. This is the same pre-fix-must-fail /
      post-fix-must-pass discipline already required of regression guards.
   5. **Only THEN fix**, on the lens's independent signal — and fix **every** instance the lens found,
      root-cause, plus a regression guard.
   6. **Re-run the review loop** so a *clean* round is what certifies the fix (a change round is never
      its own confirmation), and record the whole thing in `review/README.md`.
   The success test for this rule: **the same developer report, made again later, would be caught by
   a lens first.** If a fix leaves the lenses exactly as blind as they were, the work isn't done.

---

## Architecture map

- `src/lib/hn/article.ts` — opt-in linked-article text via a **free CORS-proxy chain** (the ONE
  non-local feature; off by default — see the reader-proxy note below).
- `src/lib/hn/` — `firebase.ts` (official API: lists return **ids only** → N+1), `algolia.ts`
  (search + **whole nested comment tree in one request** via `/items/:id`), `client.ts` (IndexedDB
  cache + bounded-concurrency fetch pool; use it, don't fetch raw in components).
- `src/lib/db.ts` — Dexie schema: `events, items, lists, embeddings, kv, seen, saved, hidden` +
  `pruneCaches()` (called on startup).
- `src/lib/prefs.ts` — Zustand `persist` store → `localStorage['hn:prefs']`. **Every persisted setting.**
  `partialize` must list every persisted field. `onRehydrateStorage` applies theme + design + layout
  **and migrates away invalid/removed model/theme/layout ids** to defaults.
- `src/lib/themes.ts` — the 31 theme designs (id + label + `defaultLayout`) that drive the design
  switcher, plus the 14 **layouts** and `effectiveLayout()` (resolves the `'auto'` layout pref against
  the current design). Also the `data-theme`/`data-layout` validation/migration.
- `src/lib/interactions.ts` — event tracking + behavioural affinities (excludes muted domains/users;
  **dwell-aware** — a bounce is negative, a long read positive); `onEngagement` pub/sub for the
  auto-trainer.
- `src/lib/dwell.ts` — read-time tracking (tab blur→return ≈ time-on-article) → `dwell` events.
- `src/lib/query.ts` — the shared TanStack QueryClient (so background code can invalidate the feed).
- `src/lib/ranking/` — `features.ts` (10-dim feature vector incl. **interaction/cross** features,
  **word-boundary** keyword match, hard filters), `logistic.ts` (in-browser reranker: **pairwise
  learning-to-rank** for weights + **Platt calibration** for probabilities), `strategies.ts` (For You scoring + "why"
  reasons), `content.ts` (content signals: liked/disliked embedding centroids + title/comment term
  profile, with **leave-one-out** for training), `train.ts` (train from local history — retrains from
  scratch each time; exports `buildTrainingSamples()` so the personalization proof can evaluate the
  exact samples it fits on; retrains from scratch each time), `autotrain.ts` (background retrain —
  debounced after engagement + startup-if-stale, gated on `useLearnedRanker`, rate-limited).
- `src/lib/models/` — `registry.ts` (status store, `webgpuAvailable()`), `embeddings.ts`
  (Transformers.js, lazy), `llm.ts` (WebLLM, lazy; prompts live here; `generate()` routes to the
  cloud provider when one is selected), `cloud.ts` (BYO-key cloud LLM clients — Gemini/OpenAI/Anthropic,
  browser fetch, no heavy imports), `catalog.ts` (model lists), `storage.ts` (list/remove browser-cached
  model weights via the Cache API — no heavy imports).
- `src/hooks/` — `useFeed`, `useItem`, `useLocalData`, `useImpression`, `useTheme`, `useToast`.
- `src/components/` — `layout/` (TopNav, FeedTabs, Sidebar, HnAccount), `feed/` (Feed, StoryCard,
  SearchResults), `comments/` (CommentsView, Comment, ThreadSummary),   `ranking/`
  (WeightSliders, **RankExplainDialog** — the in-app "Why #N?" rank traceback), `ui/` (primitives,
  controls, Favicon, Toaster, ScrollTop), `CachedModels` (show/remove browser-cached model weights),
  `ErrorBoundary`, `KeyboardShortcuts`. Sidebar's **"Your interests"** shows the *titles* of stories
  you've recently **read** (`recentRead` — the read definition, NOT engagement), not just domains.
- `src/routes/` — `Home`, `Item`, `Settings`, `Saved`.
- `src/main.tsx` exposes `window.__hnlens` (lazy module loaders + the prefs store) **for the test
  harnesses** — keep it; it's how tests drive real code.

---

## Hard constraints (verified, not assumed)

- **CORS:** Firebase (`hacker-news.firebaseio.com`) and Algolia (`hn.algolia.com/api/v1`) are
  CORS-enabled, including `Origin: null` (so they work from `file://`). **`news.ycombinator.com` and
  `hnrss.org` have NO CORS** → you cannot fetch/scrape/write from the browser. Therefore **no real
  upvote/comment** — deep-link out to HN instead.
- **WebLLM needs WebGPU** in a **secure context** (`https://` or `localhost`). Transformers.js
  embeddings fall back to WASM when WebGPU is absent. `file://` can't run the AI (WASM/workers are
  blocked) — the single-file build stubs it.
- **Deploy:** `base: './'` + HashRouter → works on any Pages path with no config.

---

## Environment / tooling gotchas

- **Keep `package-lock.json` on the public registry** (`registry.npmjs.org`). If a network/proxy
  policy rewrites `resolved` URLs to a private mirror, rewrite them back before committing — CI
  (GitHub Actions) can only reach the public registry, and the deploy workflow forces it too.
- **Use Playwright's bundled Chromium for all automation**, not a system browser — a managed/
  policy-locked Chrome can stall on external fetches. For WebGPU add
  `--enable-unsafe-webgpu --enable-features=Vulkan --use-angle=metal` and load over `localhost`
  (WebGPU needs a secure context).
- **Show the user visual MOCKUPS by hosting them on the user's RUNNING server — NOT the Artifacts
  panel, inline images, or any external file host (the user can't see any of those in the TUI).**
  CONFIRM which server
  is up first — the user typically runs `npm run dev` (**port 5173**, serves `public/`), not
  `npm run preview` (port 4173, serves `dist/`). Put mockup HTML in **`public/mocks/`** — it's served
  by the dev server immediately at `http://localhost:5173/mocks/` AND survives a `vite build` into
  `dist/`. (`dist/mocks/` only works for `preview` and is wiped by a rebuild.) Give the user the
  `http://localhost:5173/mocks/…` link. Build explorations as self-contained HTML with realistic
  sample data styled like the app, and host them for the user to pick a direction *before*
  implementing. Remove `public/mocks/` before shipping so throwaway mockups don't get committed.

---

## TypeScript / tooling conventions

- Strict TS with **`verbatimModuleSyntax`** (use `import type`), **`erasableSyntaxOnly`** (NO `enum`,
  NO constructor parameter properties — use const objects + union types), and
  `noUnusedLocals`/`noUnusedParameters`. Prefer explicit field picks over destructure-omit.
- **Tailwind v4** via `@tailwindcss/vite`; semantic tokens defined in `index.css` under
  `@theme inline`; dark mode is class-based (`.dark` + `@custom-variant`).
- **Theming has TWO independent axes** (see `src/lib/themes.ts` + `index.css`): a **design** (31 of
  them, `themeName` pref → `data-theme="<id>"` on `<html>`) and a **light/dark mode** (`theme` pref →
  `.dark` class; **binary toggle — the "system" option was removed**, new users seed from OS pref once).
  Every design defines a full token set for BOTH modes — the default `reader` (v2ex-inspired:
  whitesmoke canvas, white boxed surfaces, hairline borders, **slate-blue** accent; dark = "Midnight"
  deep canvas, **cyan** accent) lives in `:root`/`.dark`; the other 30 live in `[data-theme='<id>']` +
  `[data-theme='<id>'].dark` (paper, terminal, brutalist, soft, solarized, nord, gruvbox, dracula,
  sepia, ocean, forest, sunset, rose, mono, contrast, cyber, mocha, slate, candy, amber, crimson,
  emerald, royal, obsidian, **geist, linear, bento, editorial, clay, swiss**). A design varies
  **palette + accent** (`--bg/--surface/--border/--accent/...`), **typography** (`--app-font`:
  serif/mono/rounded/sans), **corner radius** (overriding Tailwind's `--radius-*` scale — verified to
  cascade), and (for the 6 research-backed "design languages") a **surface treatment** applied via the
  class hooks: geist = dotted-grid body bg, linear = translucent `backdrop-filter: blur` glass (dark),
  bento/clay = soft/neumorphic `box-shadow` on `:is(.story-card,.bg-surface)`, swiss = flat + square.
  Components only use semantic utilities (`bg-surface`, `text-accent`, `rounded-lg`), so adding a
  design = CSS token/treatment blocks + one entry in `themes.ts`; **no component changes.** Switch from
  the TopNav dropdown or Settings → Appearance (`prefs.setThemeName(id)`). Mockup explorations live as
  review artifacts (`hn-lens-*-directions.html`), not in the repo.
- **A THIRD axis: LAYOUT (structure), independent of palette.** The `layout` pref → `data-layout` on
  `<html>` picks one of **14 genuinely different structures** — `cards` (comfortable boxed), `list`
  (dense numbered HN rows, no chrome), `compact` (one line per story), `magazine` (responsive card
  grid + full-width hero), `zen` (single wide centered reading column, sidebar hidden), `rail` (left
  vertical nav rail → 3-pane app, lg+), `grid` (uniform 3-col tiles), `timeline` (vertical spine +
  node dots), `media` (large spacious rows + prominent index), `newspaper` (multi-column text flow +
  column rule), `cover` (bold full-width bands with an accent left bar), `bento` (mixed-size tile
  grid), `feature` (one large hero + dense list), `masonry` (staggered CSS columns). Pref value
  `'auto'` follows the design's `defaultLayout`
  (`effectiveLayout()`), so changing design also changes structure; pin any layout to override. It's
  driven by CSS `[data-layout='<id>']` blocks in `index.css` acting on **class hooks** the components
  expose (`.feed-list`, `.story-card` + `.sc-lead/.sc-num/.sc-favicon/.sc-rank/.sc-body/.sc-meta/
  .sc-title/.sc-reasons/.sc-tldr/.sc-sub/.sc-actions`, and the shell `.app-grid/.app-content/
  .app-sidebar/.feed-tabs`) — so a new layout = a CSS block, minimal JSX. Guarded by `layouttest.mjs`
  (asserts each layout actually restructures the DOM: grid vs flex, borderless numbered rows, hidden
  sidebar, vertical rail). **Don't restyle a layout by editing components' Tailwind inline —** add the
  hook + a `[data-layout]` rule.
- **oxlint must stay at 0 warnings** — it lints `scripts/` too.

---

## Product decisions & lessons learned

- **Summarization model:** **Llama-3.2-1B** (`Llama-3.2-1B-Instruct-q4f16_1-MLC`) is the smallest
  WebLLM model that reliably follows the format and stays grounded (<1 GB). Rejected after eval:
  Qwen2.5-0.5B & SmolLM2-360M (leak the prompt / echo / hallucinate / drop format); **Gemma-3-1B is
  broken in WebLLM 0.2.84** (sliding-window attention → garbage). Re-run `npm run test:eval` before
  changing the default/model list.
- **BYO cloud LLM (optional, opt-in) — a CHOICE, not a replacement:** the `llmProvider` pref picks the
  AI-summary backend: `'local'` (WebLLM, default, fully private, needs WebGPU + a one-time download) or a
  cloud provider you supply your OWN API key for — `'gemini'` / `'openai'` / `'anthropic'` (keys in
  `prefs.apiKeys`, stored only in this browser). All three are **browser-callable** (no backend, fits the
  static model): Gemini via `?key=`, OpenAI via a Bearer key, Anthropic via `x-api-key` +
  `anthropic-dangerous-direct-browser-access`. `cloud.ts` holds the provider metadata + `cloudGenerate`
  (a single non-streaming fetch, friendly errors on bad-key/rate-limit); `generate()` in `llm.ts` routes
  to it (outside the WebLLM `genQueue` — independent HTTP, no GPU-context serialization) when a provider
  is selected + keyed. **Cloud needs NO WebGPU**, so `ThreadSummary`/`StoryCard`/`CommentsView` gate on
  `hasCloudKey(prefs) || (llmEnabled && webgpu !== 'unavailable')` (helper in `prefs.ts`); the summary
  cache key is provider-qualified so switching backend re-summarizes. **Privacy tradeoff (like the reader
  proxy):** cloud sends the summary content + your key to the provider — Settings shows an amber warning
  and the on-device option stays the private default. Guarded by `cloudllmtest` (routing to each
  provider, no-key error, works with WebGPU unavailable, gist hidden, provider+key persist) +
  `uiwiring` (provider select + key input write to the store). *Lesson: a provider abstraction at the ONE
  `generate()` choke point keeps every summary path (TL;DR, thread, eval) backend-agnostic.*
- **Cloud model choice + "thinking" models need TOKEN HEADROOM (fixed 2026-07-20):** once a key is set,
  Settings queries the provider's model list (`listModels` in `cloud.ts` → Gemini `/v1beta/models`
  filtered to `generateContent`; OpenAI `/v1/models` filtered to gpt/o-chat ids; Anthropic `/v1/models`)
  and the user picks one (`prefs.cloudModels[provider]`; empty ⇒ the provider default; summary cache key
  uses the chosen model). **The reported bug:** picking a *thinking* model (e.g. `gemini-2.5-flash`) made
  summaries come back **empty/truncated** — the small local-model token caps (80 for a TL;DR, 600 for a
  thread) were consumed by the model's THINKING tokens, leaving no answer. Fix: `generate()` gives cloud
  a generous `maxOutputTokens` floor (**4096** — cloud has no GPU cost), and `cloudGenerate` **throws a
  clear error** when a provider returns no text (surfacing `finishReason`/`blockReason`, e.g. "Gemini
  returned no text (MAX_TOKENS) — try a non-thinking model") instead of rendering a **blank summary
  block**. Guarded by `cloudllmtest` (headroom ≥4096; a simulated thinking-truncated/empty response
  throws, not blank; the model picker populates + the choice is used in `generate`). *Lesson (this is why
  the mocked reviewer missed it): a MOCK that returns clean text can't catch a real provider's
  empty/thinking response — the test must simulate the failure shape, and an empty model response must
  become a visible error, never a silent blank.* **Two picker follow-up bugs (fixed 2026-07-20):** the
  fetched model list is transient (not persisted), so after a reload the `<select>` value (the persisted
  choice) matched no `<option>` and silently rendered the first (the default) — showing the DEFAULT while
  `generate()` used the saved choice (**used ≠ displayed**). Fix: always include the chosen model as an
  option (so value ∈ options). And a `Load models` error leaked across a provider switch / key edit
  (single shared `cloudModelsErr`); it's now cleared on both. Cloud fetches also wrap network rejections
  in a friendly "Couldn't reach <provider>" via `cloudFetch`. Guarded by `cloudllmtest` (after reload the
  picker shows the chosen model; the load-error clears on provider switch — both verified to fail pre-fix).
- **LLM calls are TRANSPARENT + user-controllable (2026-07-20):** every AI summary (card TL;DR + thread,
  local + cloud) shows a `SummaryActions` row — **Refresh** (regenerate, bypassing the cache),
  **View request** (a modal showing the EXACT `system` + `user` messages sent to the model), and **Edit
  system instruction** (→ Settings). `summarizeItem` returns + caches the `request` (the messages), so
  even a cached summary can show what was sent. Every call now sends a **system message**: a default per
  type (`DEFAULT_SYSTEM` in the dependency-light `models/prompts.ts` so Settings can show/reset it without
  pulling the lazy `llm.ts` into the main bundle) OR the user's override (`prefs.systemPrompts.{tldr,
  thread}`, edited in Settings → "AI prompts (advanced)"). The summary cache key includes a fingerprint of
  the system instruction, so editing it re-summarizes (`SUMMARY_PROMPT_VER` 6). Guarded by `cloudllmtest`
  (request returned with system+user; a custom instruction flows into the actual provider request +
   invalidates the cache) + `llmcachetest` (cache key includes `systemFor`).
- **AI prompts are now FULLY editable — system + user TEMPLATE, for all 4 summary types (2026-07-22,
  supersedes the system-only note above):** `prefs.systemPrompts.{tldr,thread}` became
  `prefs.prompts: Record<PromptKind, {system, user}>` where `PromptKind = 'tldr'|'thread'|'ask'|'user'`.
  `models/prompts.ts` exports `DEFAULT_PROMPTS` (a system instruction AND a user-message TEMPLATE with
  `{placeholders}` — {title}/{url}/{post}/{article}/{comments}/{question}/{userId}/{stories}) + `PROMPT_META`.
  In `llm.ts`, `promptFor(kind,part)` + `renderTemplate()` substitute the data and `buildPromptMessages()`
  drives every summary path (tldr/thread/ask/user). `SummaryActions` gained an **in-place "Edit prompt"**
  control (`PromptEditorDialog`: edit the system instruction AND the user template, "Save & re-run") next
  to Refresh + View request; Settings → "AI prompts (advanced)" edits all 4 kinds × (system + user
  template). The summary cache key fingerprints system **and** user (`SUMMARY_PROMPT_VER` 7); a rehydrate
  migration folds the legacy `systemPrompts` into `prompts`. Guarded by `cloudllmtest` (a custom user
  template + data substitution flows into the actual provider request) + `llmcachetest`.
- **Displayed data must be EXPLORABLE — no dead-end stats (usability, 2026-07-20):** the Settings "N
  interaction signals recorded" text was inert; a user who sees a count of data ABOUT them wants to see
  what it is. It's now a button → `SignalsDialog`, which lists the real `db.events` (type label, item
  link, domain/author, dwell seconds, when) + a per-type breakdown. Guarded by `datamgmttest` (the count
  is a clickable control that opens a dialog listing real signals). *Lesson (added to the
  `hnlens-usability` skill as an explicit "affordance / dead-end data" sweep): for EVERY count/stat/
  status/label/provenance the UI shows, ask "would a user want to click this to see or change the thing
  behind it, and can they?" — a goal-only walkthrough repeatedly missed this class.*
- **The affordance sweep's batch (2026-07-20):** running that sweep found ~10 dead-ends; the material
  ones are fixed: (a) **BLOCKER** — the card TL;DR's new Refresh/View-request/Edit controls (`.sc-tldr`)
  were covered by the card's stretched title link and were **completely unclickable** (they worked on the
  thread); fixed by adding `relative z-10` to `.sc-tldr` (same class the Personalize menu needed).
  *Lesson: any interactive block inside a story card MUST get `z-10` or the whole-card stretched link
  eats its clicks — and a control test must exercise the CARD path, not just the /item path.* (b) the
  sidebar's "N signals recorded" twin was still a dead `<p>` (Settings' was fixed) → now opens
  `SignalsDialog`; (c) "Your interests" chips are now click-to-unfollow; (d) author names link to the HN
  profile (story card + discussion header + account); (e) `SignalsDialog`'s "delete below" copy (it has
  no deletes) was corrected to point at Settings → Data; (f) "Edit system instruction" deep-links to the
  AI-prompts section (`?section=ai-prompts` → scroll+focus), not the top of Settings. Guarded by
  `cloudllmtest` (card controls topmost via `elementFromPoint` — verified to fail without the z-10 fix;
  sidebar signals opens the viewer; an interests chip unfollows). Deferred (documented, lower value):
  per-item hidden-story viewer, comment/gist author links (they sit inside collapse/jump controls), and
  touch-friendly "Why #N?" hover hints.
- **The Personalize (⋯) menu must paint ABOVE the next card (fixed 2026-07-20):** the card's dropdown is
  `absolute` inside the card; a later sibling card (its chips/Why-button at `z-10`) painted on top of it,
  so the menu appeared overlapped/torn. Fix: when the menu is open the card gets `z-30`, raising its
  whole stacking context above following cards (the menu bg is already opaque). Guarded by `cardteachtest`
  (the lowest menu item is the topmost element via `elementFromPoint`; verified it fails without the fix).
  *Lesson: an absolutely-positioned popover that extends past its card needs its card raised (or a
  portal) — a realistic-viewport UI review catches this; a store-only test never will.*
- **Summary prompt:** one **user** message (Gemma-family has no `system` role), **no fill-in
  `<...>` template** (weak models echo it), plus frequency/presence penalties to curb repetition.
- **Comment selection for summaries:** rank by **substance × replies** (`selectKeyComments`).
  Embedding-MMR "diversity" was A/B-tested and **loses** — it rewards off-topic tangents. Embeddings
  are for *feed ranking / more-like-this*, not summary input.
- **Summaries use ARTICLE TEXT + comments, and say so (`summarizeItem` in `llm.ts`):** the summary
  orchestrator gathers the linked-article body (via the reader-proxy chain, **only when the
  `fetchArticleText` toggle is on** — it's the one non-local, privacy-sensitive feature), the top
  comments, and the HN self-text, feeds them all to the model, and returns a `SummarySources`
  descriptor. The UI shows **exactly what it used** ("Based on article text (~N words) + M comments"),
  offers a **title-level "Article text" link** (in the card meta row, not buried in the summary) that
  opens the extracted text in a **formatted overlay** (paragraphs preserved via `htmlToText`), and —
  when a URL exists but the proxy is off — prompts to enable it. Both go through `summarizeItem`.
  `summarizeThread`/`tldr` still exist (article optional) for the eval harnesses.
- **Summaries are CACHED in IndexedDB (`kv`) and a HIT must be CHEAP.** `summarizeItem` checks the
  cache **first** and returns the stored `{text, sources, articleText}` object with **no network** —
  crucially it does **NOT fetch the comment tree** on a hit. (Bug fixed 2026-07: the key used to include
  comment count, forcing a full `fetchItemTree` before the cache check on *every* click — so a "cached"
  re-click still fetched the whole 500-comment tree and felt slow. `llmcachetest` now asserts a hit
  triggers **0 tree fetches**.) Key = `summaryCacheKey()` = item + model + `SUMMARY_PROMPT_VER` +
  article-INTENT flag (the toggle, knowable without fetching). On a MISS it fetches the tree (or uses
  the one the discussion view already has), generates, and caches. A model/prompt change or toggling article
  text re-summarizes; **"Regenerate"** (`force`) overwrites. **Lesson:** "cached" must mean *fast* —
  test that a hit does no network work, not just that it returns the right text.
- **Comments open FULL-PAGE by default (HackerWeb-style) — the side drawer was removed (2026-07-22):**
  a feed card's comments control (and a text post's title) navigates to the full `/item/:id` discussion
  **page** (`StoryCard.onOpenComments` → `navigate`), not a cramped ~560px side drawer. The old
  `CommentsDrawer` + `useUi` store were the reason users "never saw the clean comments page" — they were
  deleted (no dead code; nothing else used `useUi`). `/item` is the single discussion surface (shared
  `CommentsView`, also used by "Continue this thread" and every `/item` deep-link). **Readability polish**
  on that page: a stronger page title (`text-xl`), a comfortable comment/story **reading body**
  (`.comment-body` = ~15px / line-height 1.7, rem-based so the reading-text-size axis scales it), and
  airier thread spacing (top-level `space-y-4`, replies `space-y-3`, indent `pl-3.5`). The top-level list
  carries a stable **`.thread-root`** hook class so tests/tooling don't couple to cosmetic spacing classes
  (a spacing tweak previously broke `commenttest`'s `.space-y-3 >` selector). Keyboard `j`/`k`/`[`/`]`
  comment nav + `c` still work (they operate on `[id^="comment-"]` on `/item`). Guarded by
  `discussionviewtest` (feed card → `/item`, "new" badge on that path) + `keyboardtest` (comment nav on
  the page) + `commenttest`. *Lesson: a default side-drawer hid the app's best surface; make the clean
  full page the default, and give test-driven surfaces a stable hook class, not a cosmetic one.*
- **Comment organization (`Comment.tsx`) — research-backed (Reddit/HN/Tildes patterns):** a subtle
  vertical **thread line** per depth (accent-tinted for unread), an **OP badge** on the story author,
  a **jump-to-parent** control on nested replies, and an **indent cap** (`INDENT_CAP=6`) past which a
  **"Continue this thread →"** link opens the branch on its own `/item/:id` page (stops threads
  collapsing to a sliver). **Large reply subtrees auto-collapse (HackerWeb-style, 2026-07-22):** a
  comment whose total descendants exceed `AUTO_COLLAPSE_DESCENDANTS` (2) renders its replies collapsed
  behind a **"Show N replies"** control (`.replies-toggle`, with a repliers preview + a "new" flag if
  the subtree has unread comments); expanding is per-level so deep threads stay progressively disclosed
  rather than dumping the whole tree. Guarded by `commenttest` (small subtree inline; large subtree
  collapsed; expand reveals a direct child; recursion keeps the next level collapsed).
- **Comment ranking (`CommentsView`) — HN's API does NOT expose per-comment scores**, so there is no
  "top by points." The sort control offers **Default** (HN's own returned order), **Newest**, **Oldest**,
  **Most replies** (by descendant count). Don't add a score sort — the data isn't there.
- **In-app user profiles (`/user/:id`, `User.tsx`) show stories AND comments + an AI persona summary
  (2026-07-22):** author names across the app (`StoryCard`, discussion header, `Comment`, HnAccount) link
  to a profile built from the CORS-enabled Firebase user API (karma/bio/submitted ids) — fully
  client-side, with an "on HN" escape hatch for actions CORS blocks. The user's `submitted` ids (mixed
  stories + comments) are fetched via `getItems` and split into a **Stories/Comments toggle** (with
  counts) — previously only stories were shown, so a commenter's activity was invisible. Comments render
  as read-body cards (`.comment-body`) linking to `/item/<comment.id>` (CommentsView handles a comment
  permalink); NOT wrapped in an outer `<Link>` (HN comment HTML has its own `<a>` — nesting anchors is
  invalid). An on-demand **"About this user"** AI summary (`summarizeUser` in `llm.ts`) describes what
  they post/comment about, built ONLY from that recent activity (no invented facts / identity guessing) —
  it's **button-triggered, never auto-run** (an LLM call per profile view would be costly/surprising),
  gated on `hasCloudKey || (llmEnabled && webgpu !== 'unavailable')` (hidden otherwise), cached in `kv`
  keyed on a fingerprint of the actual activity (new activity re-summarizes), and carries the standard
  `SummaryActions` transparency row (Refresh / View request / Edit system instruction). Guarded by
  `usertest` (toggle + counts, comment content + `/item` deep-link, AI card hidden without a key + works
  with a mocked Gemini key). *Lesson: a profile that shows only submissions hides half of what a reader
  wants to size up an author; and an AI persona summary must be explicit-trigger + grounded, not auto-run.*
  **Honest counts + AI discoverability (fixed 2026-07-22, independent review):** the Stories/Comments
  toggle counts are a **capped recent sample** (≤12 each of the first 40 submissions), so a caption now
  says "Recent activity (up to 12 of each shown) · full history on Hacker News" — otherwise "Comments (12)"
  for a prolific user reads as their lifetime total (it isn't). And when AI is NOT configured, the profile
  shows a **"Set up an AI summary" CTA** (→ Settings AI section) instead of hiding the persona feature
  entirely — mirroring the discussion page's CTA so a no-WebGPU user still discovers it. Guarded by
  `usertest` (recent-activity caption; AI-off CTA + its deep-link; generator hidden without AI).
- **Feed tabs refresh INDEPENDENTLY, not together:** each feed is its own TanStack Query (lists cached
  ~2 min). `useFeed` returns `updatedAt`/`isFetching`; `Feed` shows **"Updated Xm ago" + a Refresh
  button** (re-rendered on a 30s tick). Guarded by `audit` ([A2]).
- **[REMOVED 2026-07-24] The "At a glance" overview tab was deleted** — it was judged not to earn a
  tab. Deleted: `FeedOverview`/`OverviewCharts`/`ContextPanel`/`overviewViz.ts`/`categorize.ts`/
  `context.ts`, the `overview` `TabKind` (feeds are now plain `FeedKind`), the `webContext`/`relatedNews`
  prefs + their Settings toggles + the Wikipedia/related-news disclosures, and the `overviewtest`/
  `contexttest` harnesses. **Every "At a glance" / "Around the web" bullet below is retained as a
  historical lesson only — that feature no longer exists in the app.**
- **"At a glance" is a GRAPHIC overview tab; it replaced the inline "For you here" widget (2026-07-22):**
  the old `FeedForYou` chip strip (interest tag counts) was noise, so it's gone (`FeedForYou.tsx` +
  `foryouglancetest` deleted, dropped from `Feed.tsx`). In its place, an **`overview`** tab (`FeedOverview.tsx`,
  icon PieChart, label "At a glance") shows the current front page (**Top**) broken down by **curated topic**
  — a horizontal bar chart (CSS bars, one fixed color per topic) you can **expand to each topic's stories**,
  plus headline stats (stories / comments / topics) and a "Busiest sites" mini-chart. Classification is
  **on-device, NO AI, NO extra network** (`categorize.ts`: word-boundary keyword + high-confidence domain
  rules, first-match by a priority-ordered `CATEGORIES` list, `Other` fallback last) and reuses the
  already-cached Top feed via `useFeed('top')`. This is deliberately NOT title-word-frequency (which surfaced
  noise like "show"/"five"); every topic is a real HN category, so the breakdown is meaningful by
  construction. **Mechanics:** `overview` is a **`TabKind` (`FeedKind | 'overview'`), NOT a `FeedKind`** —
  kept separate so `useFeed`/`getFeedIds` only ever see real feeds; `Home` renders `<FeedOverview/>` for it
  (never `<Feed kind='overview'>`), and it's in the `VALID` whitelist + `FeedTabs` + `Sidebar` label. Guarded
  by `overviewtest` (per-topic counts, count-desc order with Other last, domain-classification, word-boundary
  → Other, expand-to-stories, stats, tab reachability). *Lesson: a useless inline widget is better replaced
  by a dedicated, genuinely-informative view than tweaked in place; and a non-feed tab should be a separate
  tab type, not a fake FeedKind that leaks into the fetch machinery.* **Bar-scaling + coverage (fixed
  2026-07-22, independent review):** bars scale to the TRUE max across ALL buckets `Math.max(1,
  ...buckets.map(count))` — NOT `buckets[0]` (the top *named* bucket). `Other` is appended last but is
  often the plurality on a real front page, so keying the scale off `buckets[0]` let `Other` overflow the
  track (clipped to 100%) and made a smaller topic look co-dominant — the chart's whole point (which topic
  dominates) was inverted. Now `Other` (if biggest) renders the longest bar while staying last in the list.
  A **"Most discussed"** section (top stories by `descendants`) makes the comments stat actionable, and a
  **"Policy & Society"** category (law/regulation/privacy/… keywords) was added to shrink the `Other`
  bucket. Guarded by `overviewtest` (Other-as-largest → 100% bar while a smaller topic is proportional;
  most-discussed ordering; policy classification). *Lesson: scale a bar chart to the true max across every
  series, or the biggest bar lies — and a catch-all bucket that's placed last must still be measured.*
  **Convergence tweaks (2026-07-22, 2nd review round):** the keyword lists were substantially expanded
  (curated, distinctive terms — avoiding ambiguous words like "hacker" that would match "Hacker News")
  which cut live-HN `Other` from ~48% to ~36%; the `Most discussed` title now opens the **discussion**
  (not the article — it's a discussion widget); and the "topics" stat counts only **named** categories
  (`Other` is a catch-all, not a topic). `Other` remaining the plurality on some front pages is honest —
  pushing coverage further trades misclassification (a wrong label is worse than "Other") for a smaller
  bucket, so the classifier is deliberately best-effort keyword/domain, not exhaustive.
- **At a glance now visualizes YOUR feed, with five interchangeable views + external context
  (2026-07-22):** the overview was upgraded from a single Top bar chart to a richer personalized
  dashboard. **(1) Source: For You, not Top** — `FeedOverview` reads `useFeed('foryou')` (the same
  personalized candidates the For You tab ranks; cold-start = popularity, so it's always populated),
  so the breakdown reflects what the reader will actually see. **(2) Five visualizations** via a
  switcher (`.ovw-viz-switch`, `data-viz`): **Bars** (default; each row expands inline to its
  stories), **Treemap** (squarified, area ∝ story count, click a tile to select a topic), **Words**
  (title-term cloud, each term a search link), **Network** (bipartite topic↔site SVG), **Mind map**
  (radial: your feed → topics → top stories). Pure layout math is in `overviewViz.ts`
  (`treemap`/`extractTerms`/`buildNetwork` — unit-testable, deterministic); the views live in
  `OverviewCharts.tsx` and use **semantic CSS tokens** (`var(--fg/--muted/--border/--accent)`) so SVG
  text/edges follow the theme, and topic colors from `categorize.ts` (with a luminance check for
  readable tile-label contrast). Treemap + mind map are topic-clickable and share ONE selection
  panel (`StoryRows` — one source of truth, also used by the bars inline expansion). Guarded by
  `overviewtest` (switcher offers all 5; each view renders + restructures; treemap/mind-map selection
  lists the topic's stories; cloud drops stopwords + term→search link; network maps topics→domains).
- **"Around the web" external context in At a glance (`ContextPanel.tsx` + `context.ts`, 2026-07-22):**
  a supplementary panel with **Wikipedia background** (pref `webContext`, **default ON**) on the
  salient entities in your feed — on-device entity extraction (`extractEntities`: runs of capitalized
  proper-noun tokens, leading/trailing generic words dropped, ranked by feed centrality), looked up
  via Wikipedia's **CORS-enabled, keyless** REST summary API; a small `WIKI_ALIASES` map disambiguates
  bare language names (Rust → the programming language, not the metal) and Wikipedia `disambiguation`
  pages are dropped. Plus **related news** (pref `relatedNews`, **default OFF, opt-in**) for the top
  story, fetched through the SAME free reader-proxy chain as article text (Google News RSS → parsed
  with DOMParser). Both are bounded by `AbortController` timeouts, cached in `kv` (successes only), and
  fire live external calls — so, like the reader proxy + favicons, each is a **Settings → Privacy
  toggle** with a disclosure (the amber warning appears when related-news is on). External calls are
  **SUPPRESSED under automation** (`navigator.webdriver`) unless a harness sets
  `localStorage['hn:context']='force'` (mirrors the onboarding suppression), so headless tests that
  visit the overview don't make failing network calls. Guarded by `contexttest` (Wikipedia entity
  resolves + links; alias disambiguation; disambiguation-page dropped; opt-in news via the proxy with
  the " - Source" suffix stripped; **PRIVACY: zero Wikipedia requests when `webContext` is off** — the
  effect, not just the store). *Lesson: an always-on external call still needs an off switch + a
  test that proves the call actually stops (the favicon-toggle lesson, applied to Wikipedia).*
- **Themes are WCAG-audited across the WHOLE matrix, guarded by a test (2026-07-22):** the
  independent design-&-theme lens found that ~10 light/mid designs shipped accents (used as link /
  chip / active-tab / button / graphic color) that failed WCAG AA on their surface, the treemap tile
  labels were illegible (white text chosen by a luminance cutoff, ~2.3:1 on light green/cyan/orange),
  the active feed-tab was indistinguishable in low-contrast themes, and a couple of `muted` bodies
  were too faint. Fixes: (a) **darkened the failing accents hue-preservingly** (adjust HSL lightness
  in the contrast-increasing direction until accent-on-surface ≥ 4.6 — `terminal/solarized/nord/
  ocean/sunset/candy/amber/emerald/clay` + `solarized`-dark; `nord` `--accent-fg` → pure white); (b)
  **`readableText()` (OverviewCharts.tsx) now picks the treemap label color by the ACTUAL WCAG
  contrast** vs black/white, not a luminance threshold; (c) the **active feed-tab carries two cues**
  (heavier weight + stronger tint), not accent-color alone; (d) the **mind-map center label uses
  `--accent-fg`** (the semantic text-on-accent color) instead of `--surface`; (e) **`clay`'s
  `--border` is a soft hairline, not `transparent`** (transparent erased dividers/outlines); (f)
  darkened `solarized`/`mocha` `--muted`. **Guarded by `themecontrasttest`** — it enumerates every
  design from `window.__hnlens.themes().THEME_IDS` (so new designs are auto-covered) and asserts, for
  ALL 31 designs × light+dark, that the primary text pairs (fg/muted/accent on surface+bg, accent-fg
  on accent) meet **AA 4.5:1** and the secondary pairs (subtle, muted-on-surface-2) meet **3:1**.
  *Lesson: a palette must be legible BY CONSTRUCTION across every theme×mode — compute contrast for
  the whole matrix in a test, don't eyeball a few; and a "pick black or white text" helper must use
  real WCAG contrast, not a luminance cutoff (that's what made the treemap labels illegible).*
- **Interactive controls must be VISIBLE AS controls — non-text contrast (WCAG 1.4.11), not just
  text (2026-07-22):** a follow-up design-&-theme pass (after the reviewer brief was upgraded to
  measure component contrast, not only text) found that many controls "melt into the page" — the
  Discussion|Article view toggle, the comment **Sort** control, the collapsed **"N replies"** pill,
  the search inputs, the At-a-glance **viz switcher**, the **"Why #N?"** button, and the feed tabs —
  because they were drawn with `border-border` (a deliberately-subtle hairline, <1.7:1) and/or
  `bg-surface-2` (≈ `--surface`), so a user couldn't tell a control was there or that a segmented
  toggle had TWO segments. This failed even in the DEFAULT `reader` theme, and a TEXT-only contrast
  audit missed it entirely (the labels were perfectly readable). Fix: a new **`--edge`** token
  (`index.css`) = `color-mix(--fg, --surface)`, a guaranteed ≥3:1 control boundary derived from each
  theme's OWN fg+surface (so it stays visible in every design/mode without touching the subtle
  decorative `--border`); a shared **`.seg`/`.seg-btn`** segmented-control treatment (a bounded track
  + an unmistakable accent-tinted/accent-bordered SELECTED segment) for the view toggle + sort +
  (edge-bordered) viz switcher; and `border-edge` on the inputs, reply pill, Why button, and feed
  tabs. Guarded by `themecontrasttest`'s **component/non-text pass** — it asserts the resolved
  `--edge` meets ≥3:1 against BOTH `--surface` and `--bg` in all 31 designs × light/dark. *Lesson:
  passing TEXT contrast does NOT imply a control is visible — WCAG 1.4.11 (non-text/UI-component
  contrast of a control's fill/border vs its surface, ≥3:1) is a SEPARATE axis the design lens + the
  automated test must both check; and a grouped control must make "there are N segments and this one
  is selected" obvious by construction.*
- **A contrast GUARD that can't parse its own colors is worse than none (fixed 2026-07-22):** the
  first `themecontrasttest` component pass reported "0 failing" while controls were genuinely <3:1 —
  its `parseColor` only handled hex/`rgb()`, but `--edge` (a `color-mix()`) resolves to the
  `color(srgb …)` form, so every ratio came out `NaN` and `NaN < 3` is `false` (silent pass). Fixes:
  parse `color(srgb r g b)` (0–1 components ×255) AND **throw on any unparseable color** so a guard
  can never silently NaN-pass again; and rebase `--edge` on **`--muted`** (which is contrast-
  normalized to ≥4.5:1 vs surface+bg in every theme) at 85% instead of a fixed `--fg` mix (which
  varied wildly — 42%-fg was only ~2.0–2.9:1 in light themes). Now the real check enforces `--edge`
  ≥3:1 vs surface AND bg across all 62 combos. Applied `border-edge` to every remaining interactive
  control the lens flagged (TopNav design/layout dropdowns, Settings/SummaryActions inputs +
  textareas + secondary buttons, User back, Home tune, DataManager/CachedModels/ErrorBoundary
  buttons), and the segmented `.seg` selected state uses a raised surface thumb + shadow (accent
  label keeps full contrast). *Lesson: a test that computes a metric MUST fail loudly on an
  unparseable/NaN input — a guard that green-lights on NaN is a false sense of safety.*
- **One SHARED, legible-by-construction switch — the two divergent hand-rolled toggles were unified
  (2026-07-24):** the app had TWO custom switches — the Settings `Toggle` (`controls.tsx`) and the
  feed-header "Top comments" toggle (`Feed.tsx`) — and both rendered poorly: the Settings one was a
  white thumb on a border-LESS `surface-2` track (invisible OFF in light themes, **1.00:1**
  thumb-vs-card), and the feed one had a washed-out fill + a ~1px-low thumb + a same-hue
  accent-thumb-on-accent-tint ON state. Both now render ONE presentational recipe, **`SwitchVisual`**
  (`controls.tsx`, `size` sm|md), legible BY CONSTRUCTION across every theme×mode because it uses only
  contrast-normalized tokens: an always-visible `--edge` border (≥3:1), an OFF thumb in `--muted`
  (≥4.5:1 vs the track), an ON track of solid `--accent` with an `--accent-fg` thumb (guaranteed
  legible on accent), and a vertically-CENTERED thumb (`top-1/2 -translate-y-1/2`, so it can't sit low
  inside the border). Guarded by **`switchtest`** — it renders the REAL feed + Settings switches and
  asserts border-vs-surface AND thumb-vs-track ≥3:1 (WCAG 1.4.11) in reader light+dark, BOTH states
  (it first asserts `.dark` actually applied, since the plain `set({theme})` does NOT toggle the class
  — only the `setTheme()` action does — so a naive test would measure light twice and falsely pass).
  Also this round: the scroll-to-top FAB is anchored bottom-LEFT on phones (`sm:right-5` on desktop)
  so it no longer occludes the right-aligned Settings "Add"/"Load models" buttons (tap → scroll-to-top
  instead of submit), guarded by `mobiletest`; and the Minimum-points slider passes `decimals={0}` so
  it shows "0", not "0.0". *Lesson: a custom form control is legible-by-construction only if it's built
  from the contrast-guaranteed tokens and there is exactly ONE of it — two hand-rolled copies drift
  apart, and a METRIC-driven UI/UX review sailed past the malformed one until the lens was rewritten to
  be SCREENSHOT-FIRST (visually inspect every control); see `review/`.*
- **Round-2 review batch — other fixes (2026-07-22):** the independent bug lens found ZERO
  correctness bugs; the other lenses' actionable items were fixed: search-results heading wraps long
  tokens (no horizontal page blowout); the comment header wraps so the Sort control fits on phones;
  the learned-ranker gate now requires enough POSITIVES (`MIN_TRAIN_POSITIVES` 3), not just total
  samples (12 skips + 1 click carried no signal); cloud LLM summaries get a much larger article +
  comment budget than the local 1B model (`PromptData.large`); the "Set up AI" CTAs deep-link to the
  AI settings section; treemap/mind-map tiles show a pointer cursor; a small tech-brand alias set for
  Wikipedia (bare "Apple" → the company); the "Why #N?" explainer discloses that diversity caps can
  shift final position; route code-splitting (`React.lazy` for Item/Saved/User/Settings) trims the
  initial bundle; `pruneCaches` now caps the `db.events` log; and a **per-item un-hide viewer**
  (`HiddenDialog`, opened from Settings → Data) so recovering one hidden story doesn't require
  clearing them all. Deferred (documented follow-ups, not regressions): For-You cold-start latency
  (it fetches the full ~150-candidate pool before first paint), a Gemini `thinkingConfig` (the
  4096-token headroom workaround handles it and forcing budget 0 can error on pro models), and a few
   design-choice ML items (in-sample Platt calibration, the w≥0 weight clamp).
- **Round-3 review batch — text-AA on EVERY surface + mobile/perf (2026-07-23):** the independent bug
  lens again found ZERO correctness bugs; the actionable items across the other five lenses were fixed
  and regression-tested. (a) **Accent must be AA-legible on ALL surfaces it can be text on, and
  `--subtle` is AA too** — the design lens found `accent`-as-text (e.g. the `.seg` selected-segment
  label, links/chips on raised rows) failing AA on `--surface-2` and directly on `--bg` in ~26 light
  designs, and `--subtle` <4.5 in a few. Fix: hue-preservingly darkened **23 accents + 5 subtles** (a
  lightness shift until ≥4.6 vs surface **and** surface-2 **and** bg — Δ4–28 in RGB, same colors just
  deeper/brighter) and **extended `themecontrasttest`'s AA pass** to require `accent`-on-{surface,
  surface-2, bg} and `subtle`-on-{surface, bg} — so the whole 31×2 matrix is AA by construction, not
  just accent-on-surface. (b) **`newspaper` layout caused horizontal PAGE overflow on phones** — its
  ~150px columns can't fit the nowrap `.sc-actions` row of shrink-0 44px touch targets (measured +18px
  at 360); fixed with `[data-layout='newspaper'] .sc-actions { flex-wrap: wrap }` (guarded by
  `mobiletest` at 360px: `over ≤ 2`). (c) **HN bios render bare URLs as plain text** (the `about` field
  has no `<a>` tags) — added `linkifyHtml` (walks text nodes, skips existing anchors, trims trailing
  punctuation) applied before `sanitize` in `User.tsx` (guarded by `usertest`). (d) **`StoryCard` is
  now `React.memo`** — the feed's 30s "updated Xm ago" tick re-rendered every card; StoryCard takes no
  function props (internal hooks), so a shallow-props memo skips those parent re-renders while its live
  queries still update it. (e) **For-You cold-start pool 150→90** — the default landing feed
  materializes each candidate via a firebase N+1, so the pool size dominates time-to-first-card;
  90 keeps ample headroom for the diversity caps + Load-more while cutting ~40% of the cold-start
  fetches (the fuller Algolia `front_page` rewrite stays deferred — it would break the firebase-mocking
  hermetic tests). (f) **AskThread** feeds cloud providers a much larger thread budget (`large` +40
  comments) and **ThreadGist** guards a malformed `tree?.children ?? []`. Deferred (documented, not
  regressions): the Algolia cold-start rewrite, a Gemini `thinkingConfig`, and the in-sample-Platt /
  w≥0-clamp ML choices. *Lesson: text-AA must hold on EVERY surface a token can be text on (surface,
  surface-2, AND bg) — auditing only accent-on-surface misses the raised-surface + on-bg cases; compute
  it for the whole matrix in the guard.*
- **Round-4/5 review batch — control-row overflow, honest gates, bounded fetches (2026-07-23):** the
  independent bug lens again found ZERO correctness bugs; the actionable items across the six lenses
  were fixed + regression-tested. (a) **The comment Sort control (a 4-option `.seg`) overflowed the
  PAGE on narrow phones** — non-wrapping segmented track, +17–77px at 320 in every theme and +5–6px at
  390 in monospace themes; fixed with `.seg { flex-wrap: wrap; max-width: 100% }` (the track bg+border
  keep the group cohesive across the wrap), guarded by `discussionviewtest` at 360/320px. *Same class
  as the newspaper `.sc-actions` overflow: any control ROW that can't wrap will overflow a narrow
  viewport — give segmented controls + action rows `flex-wrap`.* (b) **`--up` (the upvote accent) was
  used as the import-confirmation TEXT and failed AA in ~20/62 combos** (worst clay:light 2.39); the
  text now uses the AA-guaranteed `--muted`, keeping the success check icon colored (`HnAccount.tsx`).
  *A token tuned as a non-text accent must NOT be reused as small text without meeting AA there.* (c)
  **The sidebar "Learned reranker on" copy keyed off `model.n` alone** (`Sidebar.tsx`), so it claimed
  "on" for a passive scroller (n≥12, pos<3) while scoring + the "Why #N?" explainer said "still
  learning" — it now uses the SAME `rankerTrained()` gate (n≥12 AND pos≥3), with an honest "read a few
  stories" message for the enough-samples-but-too-few-positives edge; guarded by
  `personalizeliveupdatetest`. *When N surfaces derive from one concept, they must all use the one
  gate function.* (d) **HN fetches are now timeout-bounded** (`hn/http.ts` `fetchWithTimeout`, applied
  to firebase item/user/list/maxitem + algolia tree/search) so a hung endpoint can't stall the
  For-You cold-start `Promise.all` or a background retrain's comment-tree enrichment indefinitely —
  closing the last "training does unbounded network I/O" gap (the article path was already cache-only;
  the comment path is now bounded). Item/tree fetches return null on timeout (the pool tolerates
  gaps); list/search throw (surface an outage). (e) **The sidebar "N signals recorded locally" was a
  staleTime'd snapshot that read 0 while impressions accrued** — now a Dexie live query (`useEventCount`
  in `useLocalData.ts`), fresh as you scroll. *A count of live-growing local data should be a live
  query, not a cached snapshot.* (f) **At-a-glance network topic nodes** get a `--edge` stroke (+
  stronger edge opacity) so a pale category fill is still delineated as a graphic (WCAG 1.4.11).
  Deferred (documented, not regressions): profile comments showing their parent-story title (an
  enhancement needing an Algolia-based profile-comments fetch), tiny accent-tinted badge near-misses
  (3.15–4.5, decorative/text-shadow-mitigated), the Personalize (⋯) menu's upward-flip (items are
  reachable via scroll), and the Algolia `front_page` cold-start rewrite (would break the
  firebase-mocking hermetic tests).
- **Round-6/7 review batch — small-tile labels, viewport-clamped popover, AA body text on every
  surface (2026-07-23):** the independent bug lens again found ZERO correctness bugs (24 behaviors
  verified); the six lenses' actionable items were fixed + regression-tested. (a) **The
  Personalize (⋯) menu spilled off the LEFT screen edge on phones in the `newspaper` layout** (the
  default for the royal/swiss designs) — it's right-anchored inside a slim column, measured
  `left=-45px` at 390. Fixed with a `useLayoutEffect` viewport clamp in `StoryCard` (nudges the menu
  back on-screen via `translateX` after it opens; handles both left- and right-column cases), guarded
  by `mobiletest` (menu fully on-screen in newspaper@360). *A popover anchored inside a narrow
  column needs a viewport clamp, not just a stacking fix.* (b) **At-a-glance treemap small tiles
  showed a bare count with no topic label** (unidentifiable at a glance / on touch) — the label is
  now ALWAYS shown (truncated); the count, which is redundant with tile AREA, is shown only when the
  tile is big. (c) **An empty on-device (WebLLM) generation rendered a silent blank summary** — the
  cloud path already threw on empty; the local path now throws too (`llm.ts`), so an empty response
  is a visible error, never a blank block. (d) **`muted` body text on `surface-2` (the `.sc-tldr` /
  ThreadGist summary block) failed AA** in 4 combos (worst solarized-dark 3.96) — promoted
  `muted`-on-`surface-2` from the guard's 3:1 tier to the **AA tier** and darkened `--muted` in
  solarized(L/D)/mocha(L)/clay(L). *Text-AA must hold on surface-2 too when a token carries real
  body text there — compute it in the guard.* (e) The "Why #N?" explainer's "still learning" copy no
  longer hard-codes "activates once it has 12 (you have 15)" for the n≥12/pos<3 edge (matches the R5
  sidebar fix — it needs enough interactions AND a few actually-read stories). (f) Mind-map topic
  nodes use the `--edge` stroke (like the network view) so pale categories are delineated (WCAG
  1.4.11). *Lesson: `FeedGlance.tsx` — deleted in a4b03f0 — keeps surfacing as a phantom `tsc`/LSP
  error (a stale LSP cache); the authoritative signal is `npm run verify`'s `tsc -b`, which is clean.
  Don't trust an LSP diagnostic for a file that doesn't exist on disk.* Deferred (documented, not
  regressions): a `cover`+monospace 320px title overflow (smallest phone + pinned non-default
  layout), decorative accent-tinted badge near-misses, the redundant search "0 results"+outage line,
  and word-cloud stopword leakage.
- **Round-8/10 review batch — Jobs min-points bug + copy-vs-behavior honesty; loop converged
  (2026-07-23):** two more independent rounds. (a) **The bug lens caught a latent MEDIUM by testing
  against REALISTIC data:** `minPoints ≥ 2` silently emptied the **Jobs** feed because real HN jobs
  carry a constant `score: 1` (not upvotes) — see the "Hard filters" bullet for the `item.type !==
  'job'` exemption + the corrected `filtertest` fixture. *Lesson: a mock that diverges from the real
  API shape (a job's `score:1`) green-lights a live-only bug — match the real shape.* (b) **Copy must
  match behavior:** the sidebar's At-a-glance blurb promised "click a topic to see its stories", but
  the **Network** view's topic nodes weren't clickable (only treemap + mind map were). Rather than
  weaken the copy, the Network topic nodes were made topic-clickable too (they share the same category
  ids → the existing `StoryRows` selection panel), so all three topic-node views (treemap / mind map /
  network) drill in and the copy is honest everywhere (guarded by `overviewtest`). (c) **Convergence:**
  the six read-only lenses then returned a CLEAN round — the bug lens found ZERO correctness bugs, and
  usability/UI-UX/design/AI/performance reported only LOW/nitpick or documented-deferred items (no new
  blocker/high/medium). Remaining documented-deferred LOWs (not regressions): the `cover`+monospace
  320px long-token overflow, the rank-explain dialog's hardcoded green/red bars (<3:1 on some light
  themes but info is redundant with the signed value), `subtle`-on-`surface-2` decorative arrows, the
  redundant search "0 results"+outage line, word-cloud stopword leakage, author-profile capped-sample
  counts, and the architectural For-You cold-start N+1 (deferred Algolia `front_page` rewrite).
- **Reviewer prompts are version-controlled + the AI lens now RUNS/measures instead of checklisting
  (2026-07-23):** the six review lenses' instructions live in `review/base/*.md` (a shared `_common.md`
  + one file per lens) and `review/README.md` documents composing each round's prompt from the base +
  a freshly-rebuilt CURRENT STATE appendix. The AI/ML lens was rewritten from a "confirm these
  algorithms exist" checklist (which for 4 rounds only ever re-confirmed soundness) into a mandate to
  **run the model on real + hostile inputs and GRADE the output, and MEASURE ranker efficacy vs a
  popularity baseline**. On its FIRST run the rewritten lens produced a concrete efficacy number (a
  seeded taste moved held-out items from mean rank 11.0→3.0 past a 10×-more-popular distractor) AND
  found a real MEDIUM training-label bug the old prompt missed. *Lesson: a reviewer prompt that asks
  the agent to VERIFY named properties yields low-value confirmations; one that asks it to RUN, break,
  and MEASURE finds real defects.*
- **A discussion GLANCE was mislabeled as a training POSITIVE (fixed 2026-07-23):** `train.ts`
  `buildTrainingSamples` put `open_comments` in the unconditional `STRONG` positive set, so merely
  OPENING a discussion (a glance/summarize-and-leave) trained the learned ranker *toward* that story —
  even though the ARTICLE path was already dwell-aware (a bounce demotes an `open_link`) and the app's
  own "read" definition requires STAYING. Fix: `open_comments` is no longer STRONG; a discussion counts
  as a positive only with a genuine `dwell{where:'comments'}` ≥ `BOUNCE_MS` stay (mirroring the article
  path); a bare open (glance) is not a positive (and, if it was also impressed, is a negative like an
  article bounce). Deliberate actions (save/upvote/summarize) stay STRONG. The personalization proof was
  unaffected (its positives are anchored by `save`, not bare `open_comments`). Guarded by the new
  `trainlabeltest` (stay→positive, glance→not-positive, impression-only→negative, save→positive), which
  drives the REAL `buildTrainingSamples` via `window.__hnlens`. *Lesson: when there are two paths to the
  same outcome (read an article vs. read a discussion), a correctness rule (dwell-awareness) applied to
  one MUST be applied to the other — the AI lens caught this by measuring labels, not reading code.*
- **At-a-glance polish (2026-07-23):** the "Busiest sites" domain rows were inert dead-ends that looked
  identical to the clickable topic bars — now each drills in to that site's stories in the feed (reusing
  `StoryRows`, no new network; guarded by `overviewtest`). And the bar-chart ring is now the `--edge`
  token (was a ~1.8:1 `--fg 22%` mix) so a neutral "Other" bar on a neutral dark `surface-2` track is
  delineated ≥3:1 (WCAG 1.4.11); `themecontrasttest` now also asserts `--edge` ≥3:1 vs `surface-2`.
- **Training labels must be MONOTONIC like the read definition (fixed 2026-07-23, review rev2):** the
  bug lens found that a genuinely-read ARTICLE (dwell ≥ `BOUNCE_MS`) became a NEGATIVE training example
  after a later re-click+bounce — `buildTrainingSamples` tracked article *bounces* but never a *good*
  article dwell, so a later bounce demoted the read (`open_link && !bounced`). This contradicts
  `getReadItemIds`'s "once read, stays read" rule (re-clicking a story from the Read tab and bouncing is
  common). Fix: track article reads (`readArticle` = non-comments dwell ≥ BOUNCE) AND discussion stays as
  positives that WIN over a later bounce — training is now monotonic, mirroring the read definition and
  the earlier glance fix. Guarded by `trainlabeltest` (read-then-bounce → positive; bounce-only →
  negative). *Lesson: the SAME correctness rule (a genuine read is monotonic and dwell-aware) must hold in
  BOTH the read-DISPLAY path (getReadItemIds) and the TRAINING-label path (buildTrainingSamples) — they
  independently derive "did the user read this" and drifted apart.* Also this round: the Settings privacy
  disclosure boxes used `text-amber-600` (failed AA ~2.9:1 on light themes) → `amber-800` like the sibling
  danger boxes; the red delete buttons `red-600`→`red-700` (AA); and the topic classifier learned the
  plural `transformers` (word-boundary matching missed it). Deferred LOWs: the For-You `total`/`hasMore`
  overcount (counts hidden/read-hidden items → an occasional no-op "Load more"; self-heals via the
  auto-loader), a transient fresh-story "N comments" vs "No comments yet" mismatch (Firebase count leads
  Algolia indexing), and decorative sub-3:1 status dots / the dark-mode search-highlight near-miss.
- **An EMPTY feed must not show the PREVIOUS feed's stale cards (fixed 2026-07-20):** `useFeed`'s
  `itemsQ` uses `placeholderData: keepPreviousData` so a tab switch doesn't flash a skeleton. But when
  the target feed has **no ids** (Read with no history, an empty Jobs), the items query is disabled
  (`sliceCount === 0`), so React Query keeps returning the PRIOR feed's items as a placeholder that
  never clears — the Read tab showed Top's stories, fully interactive, masking the empty state. Fix:
  the non-For-You `cards` memo returns `[]` when `ids.length === 0`, so an empty feed shows its empty
  state, not stale cards. (A narrower guard than filtering every card by id-membership, which would
  also blank the intentional keepPreviousData flash on populated→populated switches and broke `uitest`.)
  Guarded by `readtest` (populated Top → empty Read shows the empty state, no stale cards). *Lesson:
  keepPreviousData leaks across DIFFERENT queries when the new one is disabled — guard the empty case.*
- **Keyboard nav covers ALL navigation, or it's removed (`KeyboardShortcuts.tsx`):** the rule is *all
  nav needs*, not just the feed. `j`/`k` walk the **current list** — feed cards normally, **comments**
  when a discussion page is open (`/item`; Enter/`c` then collapses the selected comment). **`h`/`l`**
  prev/next feed tab (walks `.feed-tabs button[aria-current]` in DOM order → works for horizontal tabs
  AND the vertical `rail`). `s` save, `g` top, `/` search, `?` help. **Everything else — the whole
  sidebar and every control — is reachable via native `Tab`/`Shift+Tab` + `Enter`** (baseline a11y;
  focus-visible rings are in `index.css`). Guarded by **`keyboardtest`** (feed j/k, tab h/l, sidebar
  focusability, comment j/k + Enter-collapse, `/`, `?`). If you add a navigable surface, extend
  `keyboardtest` — a passing "it renders" is not coverage.
- **The LLM runs on ONE GPU context — generations MUST be serialized (`generate` in `llm.ts`):** two
  concurrent WebLLM completions deadlock the engine (the "stuck at Summarizing…" bug when a card TL;DR
  and a thread summary fire together). `generate()` chains every request through a single `genQueue`
  promise so they queue instead of colliding; a failure can't wedge the queue. Guarded by the
  **modeltest concurrency step** (fires a card TL;DR + a thread summary at once and asserts BOTH finish).
- **HN usernames are case-sensitive**; domains/keywords are not → `TagEditor lowercase={false}` for
  users. Keyword boost/mute uses **word-boundary** matching (so "ai" ≠ "rain").
- **Persistence:** settings → `localStorage['hn:prefs']` (keep `partialize` complete); local data →
  IndexedDB. Removing a model must auto-heal stale prefs via the rehydrate migration. Guarded by
  `test:persist` (refresh + close/reopen) and `test:wiring` (every control writes to the store).
- **Ranking UX:** For You blends popularity/recency/discussion/affinity/relevance/learned; weights
  tune **live** from the sidebar. Personalization signals are **inactive without data/embeddings/a
  trained model** — show inactivity hints so tuning them isn't a silent no-op.
- **Content-aware ranking (what the model reads):** the learned reranker trains on **content**, not
  just metadata — `relevance` (title + HN self-text embedding similarity to your engaged-centroid,
  now a *trained* feature) and `termAffinity` (contrastive overlap of title terms vs a profile built
  from the **titles + top comments** of threads you engaged with, minus a hidden-story term profile).
  Two hard rules: (1) **CORS** means linked *article* bodies are unreadable in-browser — "content" is
  titles, HN self-text, and HN comments only (all fetchable), never external page text; a backend/
  proxy would be required for more. (2) **Leave-one-out at training** (`content.ts`) — a story must
  never be scored against a profile that contains itself, or the label leaks and AUC is meaningless.
  Comment enrichment is bundled under the embeddings toggle (it fetches comment trees); title-term
  affinity works even with embeddings off.
- **Explainable ranking (in-app, not a separate page):** every For-You card has a "Why #N?" button →
  `RankExplainDialog` traces the rank end-to-end: final score = Σ (weight × signal) → the learned
  model's per-feature contributions (shows P(engage), "trained on N of your interactions",
  leave-one-out) → the specific data signals for that item (domain/author affinity, embedding
  relevance, title/comment term overlap, keyword). **Single source of truth:** `scoreItem()` and
  `explainItem()` share one `blend()` in `strategies.ts`, so the explanation can never drift from the
  real score. `useFeed` does **not** precompute explanations at all: a card carries only a boolean
  `explainable`, and the trace is built on demand by the identity-stable `explainFor(id)` when the
  dialog opens. Handing every card a fresh `RankExplanation` **object** — and, in the prop next to
  it, a fresh `reasons` **array** — defeated `memo(StoryCard)` for the entire list on every
  save/hide/read (they invalidate `['affinities']`/`['content']` → re-rank), costing 60/111/197ms of
  blocked frames at 25/50/90 cards versus 0ms for the same action on Top. Both are now
  identity-stable (`explainFor` has an empty-dep `useCallback`; `stableReasons` reuses the previous
  array when its contents are unchanged). Guarded by the
  personalization proof's UI phase (opens the dialog, asserts the score→weights→data trace) and by
  `feedcontinuitytest` (engaging does not re-render the whole list).
- **Closed learning loop (dwell + auto-train):** clicks are recorded instantly; read-time (**dwell**)
  is measured via tab blur→return (`dwell.ts`), since article links open in a new tab. A quick bounce
  is a **negative** signal that trains the model *against* a story; a long read is a strong positive
  (`dwellSignal`/`isBounce` in `interactions.ts`; label demotion in `train.ts`). The logistic model
  **auto-retrains** in the background (`autotrain.ts`): debounced after engagement + once on startup
  if stale, gated on `useLearnedRanker`, rate-limited (~45s), and it invalidates `['ranker']` so the
  feed refreshes. Caveat: dwell only knows *how long you were away*, not what you read; a background
  (cmd-click) tab open produces no visibility change, so no dwell — those stay plain link-opens.
- **In-session engagement must update For You LIVE, not only after a reload (fixed 2026-07-20):**
  `onEngagement` in `main.tsx` invalidates the event-derived For-You inputs — **`['affinities']`** and
  **`['content']`** — alongside `['readIds']`/`['recentRead']`/`['eventCount']`, and For You's Refresh
  re-pulls them too (`useFeed.refetch`). Without this, reading a few stories did **nothing** in-session:
  the "warming up" banner stayed, ranking ignored the new domain/author/content signals, and "Why #N?"
  falsely said "no personal signals" — everything self-healed only on a full reload (`refetchOnWindowFocus`
  is off + the affinities observer lives for the whole session, so nothing refetched). The import path
  (`HnAccount.tsx`) already invalidated `['affinities']`, proving the in-app path just wasn't wired the
  same. **Do NOT** invalidate `['readSnapshot']` here (that's the deliberately session-frozen read-hide
  snapshot — invalidating it re-introduces the mid-session yank). Guarded by `personalizeliveupdatetest`
  (reading mid-session clears the banner + makes "Why #N?" show a signal, both WITHOUT a reload — the
  existing `readtest` cold-banner check reloads, so it couldn't catch this).
- **Personalization is HONEST about the learned reranker's state (fixed 2026-07-20):** two trust fixes on
  the warming-up window. (a) The "Why #N?" explainer (`RankExplainDialog`) no longer collapses
  "enabled-but-untrained" into "disabled" — it branches on the real `useLearnedRanker` toggle: ON-but-
  untrained says it **trains itself automatically** as you read (activates at `MIN_TRAIN_SAMPLES`, "you
  have N"), OFF says turn it on. It never references a "Train from history" button (there is none — the
  Settings button is "Retrain now" and training is automatic; the reranker defaults ON, so "turn it on"
  was wrong for the default user). (b) The For You **sidebar** shows learned-reranker progress —
  "Learning your taste — N/12 interactions" before the gate, "personalizing from N interactions" after —
  using `model.n` (the same count the explainer shows) so the 12-interaction gate isn't invisible.
  Guarded by `personalizeliveupdatetest` (explainer copy for ON-untrained + OFF; sidebar progress before
  and after the gate). *Lesson: an explainer that gives instructions must match the ACTUAL control state
  and the ACTUAL button names — and don't hide a activation threshold behind a per-card dialog.*
- **Model choice (why logistic, how it's trained):** the reranker stays **logistic/linear on purpose**
  — tiny local data (hundreds of rows), must train in ms offline, and MUST be explainable (the "Why
  #N?" traceback *is* `feature × weight`). Trees/NNs would overfit + kill the explainer. The wins came
  from the **objective + features**, not the model class: (1) **pairwise learning-to-rank** (RankNet —
  logistic on engaged-vs-skipped feature *differences*) optimizes ranking, not pointwise
  classification; (2) **Platt calibration** folds a scale+bias in so P(engage) is meaningful and
  ranking is preserved; (3) **cross features** (`popularity×recency`, `domainAffinity×discussion`,
  `relevance×termAffinity`) add non-linearity while staying interpretable. All in `logistic.ts`
  (`trainPairwise`/`calibrate`/`trainRanker`).
- **Reader proxy (the ONE non-local feature) — zero-setup + resilient:** `fetchArticleText` pref
  (boolean, default **off**). No URL/API-key to configure: `article.ts` ships a **fallback chain of
  free, no-signup, CORS-enabled proxies** (`READER_PROXIES`: **AllOrigins → cors.eu.org → codetabs**)
  and tries the next when one is rate-limited or down — so it works out of the box and survives a
  service breaking. It fetches linked-article **body** text (the only way past the CORS wall on article
  bodies) to feed the **term profile** (lexical, not embeddings), cached in `kv['atext:<id>']` (successes
  only, so a failed fetch can retry once a service recovers). **Opt-in with a privacy warning** — it
  sends the URLs you engage with to whichever free proxy answers; everything else stays on-device.
  Re-verify the proxies periodically: `r.jina.ai` (now 401/keyed), `corsproxy.io` (paid), and
  `thingproxy` (dead) were dropped after probing — free services rot, which is why it's a *chain*.
  **Attribution:** `fetchArticleBody` returns `{text, proxy}` and caches the **proxy name** it used
  (`getCachedArticle` reads it back; handles legacy string entries); it flows through
  `SummarySources.articleProxy` (cache `SUMMARY_PROMPT_VER` 5). The summary UI (StoryCard TL;DR +
  ThreadSummary) shows **"· via &lt;proxy&gt;"** and, in the extracted-text view, a **link to the source
  URL + "fetched via &lt;proxy&gt;"**; Settings lists the chain live from `READER_PROXIES` (never
  hard-code the names in prose). Guarded by `articleproxytest` (selection + fallback + cache shape) +
  `llmcachetest` (proxy survives the cache).
- **Article text feeds RANKING, not just AI summaries (all gated on `fetchArticleText`):** opening a
  story's link fetches + caches its body (`prefetchArticleText` in `StoryCard.onOpenArticle`), and
  `prefetchArticles()` speculatively fetches the **top For-You candidates you didn't click** (bounded
  6, single-flight, throttled to be gentle on the free proxies — driven from a `useFeed` effect). A
  candidate's OWN cached article-body terms then feed **`termAffinity`** (`cachedArticleTerms` +
  `computeContentSignals({articleTerms})`), so the learned reranker weighs the **full text**, not just
  the title — previously `termAffinity` scored a candidate by its title alone and article text only
  enriched the *engaged-items* profile. *Privacy: this widens what's sent to the proxies (URLs of
  stories you DIDN'T click), so the Settings warning says so; it stays behind the opt-in.* Guarded by
  `articlerankingtest` (candidate body lifts termAffinity; ignored when off), `articleproxytest`
  (fetch-on-click gating + bounded prefetch), and the personalization proof's candidate-article-body
  assertion. **Embeddings too:** `ensureItemEmbeddings(model, items, {withArticle})` folds a cached
  article body into the embedded text (`embedTextForItem`, bounded larger) so `relevance` reflects the
  full text, not just title+self-text; it stores a `withArticle` flag and re-embeds only on *upgrade*
  (`row.withArticle === false` — a STRICT check, so rows predating the field like the hermetic proof's
  seeded embeddings are `undefined` and never force a live re-embed, which would hang the proof). Both
  the liked centroid and candidate embeddings are gated on the same `fetchArticleText` opt-in so
  they stay consistent. *Caveat: an embedding computed while the proxy was ON keeps its article
  content until re-embedded; toggling off stops NEW article embedding but doesn't scrub existing rows.*
  Settings lists all `READER_PROXIES` (numbered, name + host, always visible).
- **Article fetch is BOUNDED, and TRAINING never fetches (fixed 2026-07-20):** two robustness gaps a
  proxy-unreachable environment exposed. (1) `fetchArticleBody` now aborts each proxy attempt after
  `PROXY_TIMEOUT_MS` (8s) via `AbortController` — a hung/unreachable free proxy used to stall the whole
  chain (and anything awaiting it) indefinitely. (2) Profile-building (`enrichmentTermsFor` in
  `content.ts`, used by `buildContentProfile` → `train.ts`) now reads article terms from the CACHE ONLY
  (`cachedArticleTerms`) — it never does a live fetch. Auto-train runs in the background and invalidates
  `['ranker']`; a live fetch there could stall the retrain (the reviewer saw a retrain re-fetch ~19
  bodies and blow past 100s when proxies were down). Engaged items are ones you OPENED/summarized, so
  their bodies are already cached by the on-click/summary fetch; reading the cache keeps profiling fast
  and consistent with the embeddings + candidate paths (both already cache-only). Guarded by
  `articleproxytest` (a hung proxy is abandoned via the timeout and the chain continues; profile-building
  makes **zero** proxy requests). *Lesson: background training must never do unbounded network I/O — feed
  it cached data, and bound every external fetch with a timeout.*
- **For You is HONEST about how much it knows (usability pass, 2026-07-20):** four presentation fixes so
  the personalization never over- or under-claims. (a) The "Why #N?" dialog shows a **bounded** engage
  chance (`engageChancePct`, ~5–95%, prefixed "~"), never a false "100% chance you'll engage" — the
  logistic saturates on small separable local data (AGENTS.md rule: don't show confidence you don't
  have). (b) Card "why" reasons only say **"often"** when the affinity reflects *repeated* engagement
  (author > 0.55, domain > 0.5 on the `tanh(score/5)` scale — a lone save no longer reads as a habit);
  below that a softer "…whom/which you've read". (c) A **cold-start** For You (no history/follows/model)
  shows a "warming up — ranked by popularity" banner instead of a hollow "why" on every card
  (`useFeed.personalized`). (d) When the load-time snapshot hides read stories, For You **says so** ("N
  already-read hidden · see the Read tab", `useFeed.readHiddenCount`) so stories don't appear to
  silently vanish. Guarded by `reasonstest` (the "often" thresholds) and `readtest` (cold banner
  appears then clears after a real engagement; the read-hidden count note) + the proof's UI phase (the
  bounded ~%).
- **One summary block per discussion — the non-AI gist is a FALLBACK (fixed 2026-07-20):** `ThreadGist`
  (heuristic digest) and `ThreadSummary` (local-AI summary) used to stack when AI was fully on. The gist
  now renders only when the AI summary block is NOT active (`aiSummaryActive = showAiSummaries &&
  llmEnabled && webgpu !== 'unavailable'` in `CommentsView`) — so AI-on shows the AI summary, AI-off /
  no-WebGPU shows the gist, never both. Guarded by `gisttest` (AI on ⇒ gist hidden, AI block shown; AI
  off ⇒ gist shown). `main.tsx` exposes the model store via `window.__hnlens.registry()` so harnesses can
  set the WebGPU state (headless has no adapter).
- **The feed tab strip hints it scrolls (fixed 2026-07-20):** `FeedTabs` shows an edge-fade gradient on
  whichever side has more tabs off-screen, so a narrow/mobile viewport reveals that "Read" (last tab)
  and others exist to scroll to — previously off-screen tabs had no cue. Pure scroll-position driven
  (hidden at each end; absent in the vertical `rail` layout which has no horizontal overflow). Guarded by
  `layouttest`/`mobiletest` (structure + rail unaffected by the wrapper).
- **Data management is BY TYPE (`lib/dataUsage.ts` + `DataManager.tsx`):** Settings → Data breaks
  IndexedDB data into categories (fetched article text `atext:*`, AI summaries `sum:*`, embeddings,
  reading history/`events`, learned model, saved, hidden, seen, cached stories/lists) each with a
  count + approx size and its own delete, so a user can drop one kind and keep the rest (e.g. remove
  fetched article text, keep saved). **Model WEIGHTS are separate** — they live in the Cache API, not
  IndexedDB, and are managed by `CachedModels`/`storage.ts`. `clearDataCategory` invalidates derived
  queries after a delete. *Lesson (per-origin storage): local data + model weights are keyed by
  origin `http://localhost:<port>` — keep the preview on ONE port (4173) or you strand GBs the user
  can't reach; see the `hnlens-build` skill.* Guarded by `datamgmttest`.
- **The HN-import button is a re-sync, not a toggle:** "Use my history to personalize" (`HnAccount`)
  imports your posts + commented threads as signals (idempotent — deletes the prior import first). It
  shows a persistent "N of your posts & discussions are personalizing your feed" once imported and
  relabels to "Re-import…", so it doesn't look like a no-op after the first click.
- **THE definition of "read" (one definition, everywhere):** you **clicked through and STAYED** —
  opened the article link and did **not** bounce straight back (dwell ≥ `BOUNCE_MS`), **or** opened the
  discussion **and stayed on it** (`trackDiscussionDwell` records a `dwell{where:'comments'}` only for a
  ≥ `BOUNCE_MS` stay; a glance/summarize-and-leave records nothing). Merely *opening* the discussion no
  longer counts — you must stay. **Saving, summarizing, upvoting are NOT reading**, and neither are
  the **synthetic `open_link`/`open_comments` events from the HN-history import** (`meta.source ===
  'hn_import'`) — those are personalization *signals* (they feed affinities/embeddings/training via
  `getEngagedItemIds`), not in-app reads, so `getReadItemIds()` **skips `hn_import` events**. This lives
   in ONE function; every read-surface (Read tab, sidebar "Recently read") derives from it.
- **READ IS MONOTONIC — once genuinely read, it STAYS read.** A later quick bounce (re-clicking a story
  from the Read tab and closing the tab fast) must NEVER un-read it — that made items **vanish** from the
  Read tab. In `getReadItemIds`, a genuine read (article dwell ≥ `BOUNCE_MS`, or a discussion stay) wins
  over any later bounce; a bounce keeps an item out only if it was never actually read. **Guarded by
  `readstatetest`** (full transition matrix + monotonicity + real-flow: re-click a read item & bounce →
  stays in the Read tab; summarize a read item → stays) and **`feedstabilitytest`** (save/summarize/
  open/seen never wrongly remove an item from a feed; hide/unsave do; saved persists). **Lessons:** (1)
  state derived from an append-only event log must be monotonic where the user expects it — test the
  *transition*, not just the end state; (2) a bug can live in the *interaction between two features*
  (import × read display; read × dwell) that each pass their own test — cross them.
- **"Newest first" means newest-READ first, not last-SEEN (fixed 2026-07-20):** `getReadItemIds` used to
  order by each item's most recent event of *any* type. But `impression` events fire for any card that's
  ≥50% visible (on the Read tab itself, and on Top/New/Best which don't hide read stories), and save/
  summarize fire their own events — so merely *re-seeing* an old-read story jumped it to the top of the
  Read tab (and the sidebar "Recently read"). It now orders by each item's most recent **read-qualifying**
  event only (an article open, or a ≥`BOUNCE_MS` article/discussion stay). Split further (fixed
  2026-07-20): read-order uses `goodReadTs` (a ≥`BOUNCE_MS` stay) and falls back to `openTs` (a bare
  background open) — a **bounce RE-open never sets a read-order time**, so re-clicking a read story from
  the Read tab and bouncing can't float it back to the top (it stays read — monotonic — but keeps its
  original read-order position). Impressions/saves never set read-order time. Guarded by `readtest`
  (three timed reads keep order after an `impression` on the oldest; a genuine read then a bounced
  re-visit keeps its position). *Lesson: when a surface says "newest X first", sort by the timestamp of
  the X-qualifying event, not the last event of any kind — and a non-X event (a bounce) must not set it.*
- **An OUTAGE must look different from an EMPTY feed (fixed 2026-07-20):** `fetchList` used to return
  `[]` on `!res.ok`, so a backend 5xx/network failure was indistinguishable from a legitimately empty
  list — the feed showed the "Nothing to show" empty state (and, with a filter set, the misleading
  "Your filters may be hiding everything · Check filters", blaming the user for a network failure). Now
  `fetchList` **throws** on `!res.ok`, and `getFeedIds` catches it to fall back to a **stale cache** if
  one exists (good) or **re-throws** when there's none, so `useFeed`'s query enters `isError` → the feed
  shows the "Couldn't load stories · Retry" state. A successful-but-empty list (`200` + `[]`) still
  returns `[]` → the empty state. Guarded by `feederrortest` (outage → error/Retry, not empty, not
  "Check filters"; legit-empty → empty state; Retry after recovery loads). *Lesson: a data layer that
  swallows errors into an empty result erases the difference between "nothing" and "broken" — surface
  the error (after a stale-cache fallback), don't mask it.* **Search got the SAME parity fix
  (2026-07-20):** `algolia.ts` `search()` used to return `{hits:[]}` on `!res.ok`, so a search-backend
  outage looked identical to "No results". It now throws; `SearchResults` shows a "Couldn't load results
  · Retry" state on `q.isError`. Guarded by `filtertest` (search 500 → error/Retry, not "No results").
  *When you apply an outage-vs-empty fix to one data path, apply it to ALL of them (feeds AND search).*
- **Save (and the article/HN links) are reachable from the DISCUSSION view, not just the feed card
  (2026-07-20):** the reader decides a story is worth keeping *while reading its discussion*, so
  `CommentsView`'s header has a **Save** toggle (`useIsSaved`/`toggleSaved`, stories only — hidden on a
  comment permalink) alongside the Article/HN links. Guarded by `discussionviewtest` [C] (Save flips to
  Saved + persists to `db.saved`). *Don't advertise a capability only on one surface when the user needs
  it on another.*
- **"Read" feed tab:** a local `read` FeedKind (not from an HN list) lists `getReadItemIds()`, newest
  first. `useFeed` sources `read` ids locally and reuses the items path; `getFeedIds`/`fetchList`
  exclude both `foryou` and `read`. Read-state updates promptly because `main.tsx` invalidates
  `['readIds']`/`['recentRead']` on every engagement (via `onEngagement`). **Gotcha (shipped a bug
  once):** a new `FeedKind` must be added to the `VALID` whitelist in `Home.tsx` — otherwise
  `?feed=<kind>` fails validation and silently falls back to the default feed. Also wire: `FeedTabs`,
  Sidebar `FEED_LABEL`, `useFeed`.
- **Sidebar "Recently read" panel uses `recentRead()` = the SAME `getReadItemIds` definition** — NOT
  engagement. **Bug shipped + fixed (2026-07):** the panel used `recentEngaged()`/`getEngagedItemIds()`
  (which counts save/summarize/upvote), so summarized stories showed as "read". The lesson: **a read
  DISPLAY surface must call the read function** — and **test the surface, not just the function.**
  `readtest.mjs` had asserted `getReadItemIds` was correct but never checked the sidebar panel, so the
  mislabeled panel passed green. `readtest.mjs` now asserts the sidebar "Recently read" lists read
  stories and EXCLUDES summarized/saved/bounced ones. Guarded by `readtest.mjs`.
- **The Read tab is a HISTORY — "Not interested" does NOT erase it; the two read surfaces still AGREE
  (updated 2026-07-22):** the Read tab (`useFeed('read')`) and the sidebar "Recently read" (`recentRead()`)
  must always show the SAME set. Marking a story you genuinely READ as "Not interested" (hidden) shapes
  future ranking but must NOT delete the record that you read it — so **both read surfaces are EXEMPT from
  the `hidden` filter** (`useFeed` skips `!hidden.has(id)` when `kind === 'read'`; `recentRead()` no longer
  consults `db.hidden`). Hidden still removes a story from every **browsing** feed (Top/New/…/For You/
  Search) and the "Not interested" toast + Undo are unchanged — it's a downvote, not a history-eraser.
  **Global mutes/min-points DO still apply to the read surfaces** (a read story from a muted domain/user/
  keyword or below min-points is absent from BOTH), via the one `isFiltered` source of truth. Guarded by
  `readtest`: **F2** seeds a read+hidden story and asserts it is PRESENT on BOTH surfaces; **F2b** seeds a
  read story on a muted domain and asserts it is ABSENT from BOTH. *Lesson: distinguish a per-item DOWNVOTE
  (shapes ranking, keep the history) from a browsing-feed FILTER (removes the card); and when two surfaces
  derive from one concept, test they AGREE on the same seeded state.* (Earlier this was the opposite — both
  surfaces dropped hidden — but that erased reading history on a downvote, which the usability review flagged
  as surprising.)
  (The Read + For-You empty states are correspondingly filter-aware: a Read history hidden entirely by
  filters says "your filters are hiding your read stories", and a For You emptied only because every
  candidate is already-read says "you're all caught up · see the Read tab", not a generic "nothing to show".)
- **For You hides read stories via the read SWEEP (`hideReadInFeed`, default ON; `lib/readSweep.ts`; design #4).**
  The sweep is recomputed on every FRESH DOCUMENT LOAD — a browser **reload** or a **new tab** — and by the
  explicit **Refresh** button, and **NEVER on in-app navigation** (the home icon, a feed-tab switch,
  opening/closing a discussion). It is fixed for the life of a page load, so a story read mid-session is
  never yanked out from under the reader; arriving fresh (reload / new tab) shows fresh stories. It is
  announced ("N already-read hidden · Undo"), lands at the top, and keeps the pinned order + paging (a
  reload is not a re-rank). Done RIGHT so it does not repeat the earlier dead ends: live-hide (yanks
  mid-read) and a SILENT per-load snapshot with a seed-vs-history race — the seed now runs AFTER the
  read-history query resolves and For You waits for it (main.tsx primes `['readSnapshot']`), so there is no
  flash and no race. A reader reported stories vanishing on merely clicking the home icon; that path was
  verified NOT to sweep (it is in-app nav) — only a load or Refresh does. **NOTE (supersedes an earlier
  bullet that said the sweep "changes only on Refresh / reloading never alters it"):** that was the
  short-lived design #3 (Refresh-only), which readers found unintuitive because read items sat in the feed
  until a manual Refresh. Guarded by `readtest.mjs` (sweep behaviour) and `sessionsweeptest.mjs` (the
  trigger matrix: load/new-tab/Refresh sweep; icon/tab/discussion never). See SPEC.md section 4.
- **A tier CI never runs will rot silently, and its rot LOOKS like app bugs (2026-07-25).** The
  `webgpu` tier (`modeltest`/`evaltest`) only runs where a real GPU adapter exists, so nothing
  exercised it for a long time. When finally run it reported 2 failures — **neither was an app
  defect**, and the reasons generalize: (a) **missing preconditions** — it asserted a loading spinner
  while the summary was CACHED from an earlier run (no loading phase to observe) and asserted the
  "Article text" link without enabling `fetchArticleText`, which deliberately gates it; (b) **stale
  cache made the real assertions vacuous** — this tier runs against a PERSISTENT profile, so every
  "is the generated text degenerate?" check was grading a string produced by a previous run. Both
  generation steps now clear the summary cache and ASSERT it is empty first, so the graded text came
  from a real model call. (c) **A poll matched PROSE, not an element**:
  `getByText(/loading|ready|…/)` also matches the privacy disclosure's "**down**loading AI model
  weights", so with the reader-proxy toggle on the harness locked onto that paragraph and burned its
  full 10-minute deadline — fixed with a `data-model-status` hook (model now ready in 4s). (d) **A
  crash with an empty log leaked a tab** into the user's real browser, because over CDP the browser
  outlives the script; there is now a watchdog that names the step it died on, and the concurrency
  generations are bounded in-page so a deadlock is REPORTED rather than hung on. (e) An apparent
  z-index defect ("`<p class='line-clamp-2 …'>` intercepts pointer events") was **async layout
  shift** — the lazily-fetched top-comment preview lands and pushes the action row out from under
  the click; `elementFromPoint` on a settled card shows every action button topmost with an 8px gap.
  *Lessons: a harness must establish its own preconditions; a generation-quality assertion must prove
  it graded a FRESH generation; poll an element, never words; anything attached over CDP needs a
  watchdog + guaranteed cleanup; and "intercepts pointer events" means measure the geometry before
  believing it is a stacking bug.*
- **Behavioural tests, not "it renders":** `audit.mjs` (`test:audit`) is the safety net — it mocks the
  HN API with distinct per-feed id ranges and asserts *concrete outcomes* (which feed loaded, save/
  hide/undo, comments, search, per-tab freshness). Two real bugs shipped green because tests only
  checked rendering (the Read tab silently fell back to For You; summarizing vanished the card). Any
  new feature gets a behavioural check that seeds known state and asserts the exact expected output +
  the negative.
- **Coverage means SURFACE × interaction, and you test the DISPLAY, not just the function.** The
  "Recently read" bug (a display calling `getEngagedItemIds` instead of the read fn) and the risk of
  `ThreadSummary` hand-mirroring `describeSources` are the same failure mode: a **data-derived display
  that duplicates or misuses a function** passes a function-level test while the surface is wrong.
  Rules: (1) never duplicate a display helper — import the one source of truth (ThreadSummary now
  imports `describeSources`, no local copy); (2) every data-derived display gets a test that seeds
  known local state and asserts the rendered surface. Guarded hermetically: sidebar Recently-read
  (`readtest`), HN-account stats + dual-purpose import count (`hnaccounttest`), WeightSliders inactive
  hints (`weighthintstest`), comment "new"/jump-parent (`commenttest`), summary source line + cache
  (`llmcachetest`). When you add a data-derived display, add its hermetic surface test in the same PR.
- **Test a control's EFFECT and a feature's PRIMARY path — not just that it writes the store / works on
  one path.** Two bugs shipped green this way and were caught by a later bug hunt (both are the same
  failure mode as the Recently-read bug — coverage that misses the real surface): (1) the **"Show AI
  summary controls in comments" toggle (`showAiSummaries`) was DEAD** — persisted, in Settings, and
  covered by `uiwiring`/`persisttest`, but **no component read it**, so turning it off did nothing.
  `uiwiring` only proves a control *writes* to the store; it does NOT prove the store value *changes the
  UI*. `ThreadSummary` now gates on it (`if (!llmEnabled || !showAiSummaries) return null`). A third
  instance (2026-07-20): **"Reset all settings" reverted the store but not the live DOM** — `reset()`
  did `set({...DEFAULT})` without re-calling `applyTheme/applyThemeName/applyLayout`, so the page kept
  the old design/dark/layout until reload; `uiwiring` missed it because it only checked the store.
  `reset()` now re-applies the DOM axes, and `uiwiring` asserts the `data-theme`/`.dark`/`data-layout`
  actually revert. *Lesson: for appearance/DOM-affecting controls, assert the DOM, not just the store.* (2) the
  **"new since last visit" comment badge only worked on `/item`, never on the feed-open path** (how
  users actually open a discussion): `StoryCard.onOpenComments` pre-called `markSeen` before
  `CommentsView` captured the previous seen timestamp, so `lastVisit ≈ now` and nothing was ever
  "new". `commenttest` had asserted the badge — but only via `/item`, so the broken primary path passed
  green. Fix: `onOpenComments` no longer marks seen (CommentsView is the single place that records a
  discussion visit; the card still dims via the live seen map). **Rules:** for every setting, assert
  its ON vs OFF changes the rendered UI (not just the store); for every feature, drive the path a real
  user takes (the feed card → discussion page), not only the convenient permalink. Both are guarded by
  `discussionviewtest` (hermetic, in `verify`): the summary control shows with the toggle ON + hides
  with it OFF, and the "new" badge appears when opening from a feed card (which now navigates to the
  full `/item` page), not just via a direct `/item` load.
- **Proving personalization (don't trust "it renders"):** `npm run test:personalization` runs a
  controlled A/B that seeds a known taste and drives the **real** affinity/train/score/embedding
  modules via `window.__hnlens`, then asserts the recommender actually learns and reorders — loss ↓,
  held-out AUC, correct weight signs, `scoreItem()` == recomputed-by-hand (1e-9), learned term == 0
  when toggled off, cold-vs-personalized rank deltas, and a **comment-content** check (a term seen
  only in comments lifts an otherwise-neutral story above its twin). It emits a visual dashboard
  (`scripts/.artifacts/personalization-proof.html`) and is a hard gate inside `verify` (it mocks the
  HN API, so it's hermetic). See the `hnlens-testing` skill.
- **Robustness patterns baked in:** `ErrorBoundary` (no white screens), `safeUrl` (http/https only),
   toasts + Undo for destructive actions, whole-card click via stretched link (interactive controls
   at `z-10`), empty states with icon + CTA, keyboard shortcuts, scroll-to-top, focus-visible rings.
- **Favicon fetch is user-controllable (privacy, 2026-07-20):** story favicons load from Google's
  public favicon service (`faviconUrl` in `time.ts` → `t*.gstatic.com/faviconV2`, matching
  SECURITY.md; the older `s2/favicons` alias was dropped because it 301-redirects to exactly this
  endpoint anyway), so the *domains* of
  stories shown to you are visible to that service — the one always-on non-HN network call (distinct
  from the opt-IN reader proxy). The `remoteFavicons` pref (default ON, Settings → Privacy) turns it
  OFF: `Favicon.tsx` then renders a letter monogram only and makes **zero** requests to the service
  (the monogram fallback already existed; the toggle just skips the `<img>`). Disclosed in SECURITY.md.
  Guarded by `favicontest` — the definitive privacy proof: it route-counts requests to the service and
  asserts **0** when off (and >0 when on) + monogram shown. *Lesson (the AGENTS.md "test the EFFECT,
  not just the store" rule): a privacy toggle's test must prove the network call actually stops, not
  just that the pref flipped.* **The toggle must be honored on EVERY favicon surface, not just feed
  cards (fixed 2026-07-20):** `faviconUrl` is used in `Favicon.tsx` (gated) AND the discussion header
  (`CommentsView.tsx`), and the latter rendered the remote `<img>` **unconditionally** — so with the
  toggle OFF, opening a discussion (from a feed card OR a direct `/item` load, one definition of
  "read") still leaked the domain to Google. `CommentsView` now gates the header favicon on
  `remoteFavicons` too, and
  `favicontest` was extended to assert **0** favicon requests when opening a discussion on both paths
  (verified to fail pre-fix). *Same lesson, wider: test a privacy/effect toggle on EVERY surface that
  can trigger the effect — the original test only checked feed cards and missed the discussion header.*
- **Search:** cap query length (Algolia 400s on long queries); provide a Relevance/Newest sort; hide
  For-You-only sidebar panels during search.
- **Hard filters are GLOBAL, not For-You-only (fixed 2026-07-19):** muted domains/users/keywords and
  min-points apply on **every** feed (Top/New/Best/Ask/Show/Jobs/Read) **and search**, via
   `isFiltered()` in `useFeed`'s plain-feed path + `SearchResults`, not just `computeForYou()` — the
   Settings "Filters" section and labels promise global muting. **Min-points exempts JOB posts**
   (`features.ts`): real HN jobs carry a CONSTANT `score: 1` (not upvotes — the earlier belief that
   "Jobs are score-less" was WRONG), so without the `item.type !== 'job'` exemption a threshold ≥2 would
   silently empty the entire **Jobs** feed. Guarded by `filtertest` (mute domain/keyword + min-points
   across Top/Jobs/Search, with a realistic `score:1` job fixture — the earlier score-less fixture gave
   false assurance and hid this bug; fixed 2026-07-23). *Lesson: a filter whose label implies "everywhere"
   must run everywhere; test it on a plain feed + search, not only For You — AND mock fixtures must match
   the REAL API shape (a job's `score:1`), or the test green-lights a live-only bug.*
- **HIDDEN is global too — including Search (fixed 2026-07-20):** "Hide" is a per-item "remove this"
  that every feed honors (`!hidden.has(id)` in `useFeed`), but `SearchResults.tsx` read only
  `useSavedIds`/`useSeenMap` — never `useHiddenIds` — so a story hidden in a feed *reappeared* in Search,
  and hiding a card *inside* Search had no visible effect (toast fired, card stayed). Fixed by reading
  `useHiddenIds()` (a Dexie live query, so an in-search hide re-renders) and adding `!hidden.has(it.id)`
  to the search item filter, mirroring `useFeed`. Guarded by `filtertest` (a pre-hidden hit stays out of
  Search; an in-search Hide removes the card live). *Same lesson as the mute one: item-level state whose
  meaning is "everywhere" must be consulted on every surface that lists items, Search included.*
- **The learned reranker is gated on `MIN_TRAIN_SAMPLES` (12):** with only a few labels the logistic
  model produces noisy, contradictory weights and a meaningless "N% chance you'll engage", which
  destroys the trust the "Why #N?" explainer is meant to build. Below the gate the feed uses the manual
  weighted blend and the explainer says it's *still learning (X/12)* — `used=false` in `scoreItem`/
  `explainItem` (`strategies.ts`). The personalization proof trains on 24 (> gate) so it's unaffected.
  Guarded by `rankergatetest`. *Lesson: don't show model confidence you don't have; gate application on
  enough data.*
- **The AI summary must be DISCOVERABLE, not invisible:** local AI is off by default (large opt-in
  download), so `ThreadSummary` used to render nothing on discussions — a daily reader never learned the
  marquee feature existed. It now shows a compact in-context CTA to enable local AI when the LLM is off
  (still fully hidden when the user turns off "show AI summaries in comments"). Guarded by
  `discussionviewtest` [A4/A5]. *Lesson: an off-by-default power feature needs an in-context path to
  discover + enable it, not silence.*
- **Card-level teaching (`StoryCard` "Personalize" menu):** follow/mute a story's domain + author
  straight from the card, wired to the existing `toggleFollow/MuteDomain|User` prefs the ranker +
  global filters already use (muting removes the story, with Undo). Don't build a parallel teaching
  store — reuse those toggles. Guarded by `cardteachtest`.
- **Per-domain AND per-author diversity caps (`diversifyByDomain` cap 3, `diversifyByAuthor` cap 2):**
  applied in `useFeed` (`diversifyByAuthor(diversifyByDomain(...))`) AFTER `computeForYou`, NOT inside it
  — scoring/`explainItem` stay pure and the #1 pick is preserved, so the personalization proof (which
  drives the ranking modules directly) is unaffected. Nothing is removed; extras from a flooding domain
  **or author** are pushed down. The author cap was added 2026-07-20 after a usability pass found ONE
  deeply-read author's *unrelated* stories filling 3 of the top 6 (a single deep read spikes author
  affinity). Guarded by `diversitytest` (domain) + `reasonstest` (per-author cap unit check).
- **Card "why" chips are HONEST — count-aware + contribution-aware (usability pass, 2026-07-20):**
  `reasonsFor` (`strategies.ts`) now (a) says **"often"** only for a real habit — high affinity AND
  **≥2 distinct engaged items** (`fs.authorEngagedN`/`domainEngagedN`, from `computeAffinities`'
  new `authorCounts`/`domainCounts`) — so one deeply-read story (whose dwell alone spikes the affinity
  score) no longer reads as "often"; and (b) shows a **soft** affinity chip ("…whom/which you've
  engaged with") only when personalization is actually the TOP contributor to that card's rank (it
  receives the blend `terms`), so a card really ranked by recency/popularity shows "Trending"/"Fresh",
  never a misleading "engaged with X" that contradicts its own "Why #N?" trace. The count fields are
  display-only — they are NOT added to `featureVector` (the model dimension is 10). Guarded by
  `reasonstest` (lone vs single-deep-read vs repeated; soft-chip-only-when-personal-drives). *Lesson:
  a "why" label must agree with the actual score trace and must not infer a habit from one interaction.*
- **EXPLICIT preferences are NOT learned features (fixed 2026-07-20):** the learned reranker's
  `featureVector` (`features.ts`) is **10-dim** and covers BEHAVIOUR + CONTENT only — popularity, recency,
  discussion, domain/author affinity, relevance, termAffinity, and 3 crosses. The **explicit** signals
  `followedDomain`/`followedUser`/`boostKeyword` were removed from it: they're user *declarations*, already
  applied deterministically (fixed positive weights) in the manual blend's `affinity` term
  (`strategies.ts` `blend`), so learning a weight for them double-counted the signal AND — because a
  followed domain's stories appear as impression-*negatives* when you don't click every one — the model
  learned a **negative** weight for "Followed domain". That made "Why #N?" contradict itself on a #1
  followed-domain card ("~5% chance you'll engage" + a demoting "Followed domain −2.4" bar), eroding the
  explainer's whole purpose. The manual blend still ranks followed items up (it reads
  `fs.followedDomain` directly), so rankings are unchanged; only the learned model stopped mis-learning an
  explicit choice. The personalization proof is unaffected (it seeds NO follows, so those features were
  always 0 in its training). *Lesson: a learned model should learn from behaviour, not re-learn a noisy
  (often negative) weight for a signal the user set explicitly — that's double-counting and it makes the
  explainer lie.*
- **WebGPU: probe the ADAPTER, not just the API (`probeWebgpu` in `registry.ts`):** `'gpu' in
  navigator` can be true with no usable adapter (blocklisted GPU / accel off), which made the AI
  controls render then error on click. `probeWebgpu()` runs once at startup and stores
  `webgpu: 'unknown'|'available'|'unavailable'`; UI gates (StoryCard TL;DR, ThreadSummary, Settings)
  use that, optimistic while 'unknown'. `webgpuAvailable()` (sync API check) stays only for the
  embeddings WASM-fallback choice.
- **First-run onboarding (`Onboarding.tsx`, `hasOnboarded` pref):** a one-time modal to pick interest
  topics → seeds `keywordsBoost` so For You is personalized from session one. **Suppressed under
  automation (`navigator.webdriver`) unless a harness sets `localStorage['hn:onboard']='force'`** —
  otherwise a default-on first-run modal would block the whole test suite. Guarded by
  `onboardingtest` (flow + the suppression). *Lesson: a default-on first-run modal must opt OUT of
  automation, or every other test breaks.*
- **Non-AI thread "gist" (`ThreadGist.tsx`):** long threads (>=15 comments) get a fast, on-device
  digest of the most-substantive/most-replied comments (length + replies − depth), each a jump to the
  comment — for readers who won't enable the LLM. Self-contained (no `llm.ts` import, so the heavy
  module stays out of the main path). Guarded by `gisttest`.
- **Mobile access:** the personalization/Tune UI lives in the desktop-only sidebar (`hidden lg:block`),
  so For You also renders a `lg:hidden` "Tune ranking" disclosure (`Home.tsx`) with the same
  `WeightSliders`; the Read tab is reachable via the horizontally-scrollable `.feed-tabs`. Guarded by
  `mobiletest` (375×780).

- **A SESSION is the one definition behind every "where was I" behaviour (2026-07-26, replaces the
  load-time read snapshot):** a session is one continuous sitting in one tab. It STARTS when you open
  the app in a new tab or press **Refresh**; it CONTINUES across reading, opening a discussion,
  switching feed tab, and **reloading**. Treating a reload as a fresh start is what produced the
  reported defect — a story read and returned to was silently gone, everything below shifted up a
  card, and the next click opened the wrong story. `src/lib/session.ts` owns the definition and the
  key list; `sessionStorage` is the primitive precisely because it already means "this tab, surviving
  reload". Everything positional lives there — pinned order, paging depth, the read sweep, and
  session-hidden stubs — so they cannot disagree.
- **SCROLL POSITION IS NOT RESTORED, deliberately (2026-07-27, c3r21).** Arriving at a feed puts the
  reader at the TOP of it. An anchor-based restore (which card was at the top + its offset, recorded
  with a watermark, a debounce and a `pagehide` sample, then held through a settling loop) shipped and
  was **deleted**: it cost ~160 lines in `Feed.tsx` plus a storage layer, it produced a defect in each
  of four consecutive rounds, and its final one was self-inflicted — the `showingPrevious` guard added
  to fix a tab-switch race made the restore unreachable on the default feed. The list you come back to
  is still the list you left (pinned order + paging depth are KEPT); only the scroll offset is not.
  Note that "restore nothing" is **not** the same as "do nothing": React Router leaves the window
  offset where the previous route had it, so the scroll to top must be explicit, and `instant`, since
  `scroll-behavior: smooth` is global. Guarded by `feedcontinuitytest` (list identity and order across
  every excursion, landing at the top, and the session definition itself).
- **The discussion header is ONE sticky toolbar + an on-demand tray (2026-07-26):** four stacked
  always-on blocks (AI summary, Ask, search, count+sort) put the first comment **493px** down an
  800px viewport — 62% of the first screen of a page whose job is reading comments. Now: one row
  (`count · Sort · Search|Summary|Ask · N new`) that sticks BELOW the TopNav (`top: 3.5rem`; at 0 it
  slides under the nav and disappears), and the tray lives INSIDE the sticky region so a tool invoked
  at the bottom of a 150-comment thread opens where the reader already is, input focused. Keys are
  context-scoped: `l` search, `s` summary, `a` ask — all three are free on `/item` because
  `switchTab` returns early with no feed tabs and `s`-to-save is guarded to story cards. The action
  group is skin-2 (`.seg-act`: raised fill + `--edge` border) so it reads as ACTIONS beside the flat
  `.seg` selection control. Labels collapse to icon-only below `lg`, so each carries an explicit
  `aria-label`. **Watch for duplicate accessible names** — three collisions appeared in one sitting
  (toolbar *Summary* vs panel *Summarize*, toolbar *Ask* vs submit *Send*, toast *Undo* vs stub
  *Restore*). Guarded by `wrapqualitytest`, which measures row SHAPE because page overflow is 0 for a
  row that wraps while a line sits half empty.
- **"Not interested" leaves a placeholder, it does not yank the row (2026-07-26):** removing the row
  instantly pulled everything below up a card and sent the reader's next click to the wrong story.
  The hide is still immediate everywhere else; only the ROW lingers as a `Hidden — <title> · Restore`
  stub until the next session boundary. Never stub on the **Read** tab: that is history, where a
  hidden story is shown normally.
- **Brand: "Hacker Lens" (2026-07-26).** Display name, package name, manifest and docs only. The
  storage identifiers are deliberately UNCHANGED — `Dexie('hnlens')`, `localStorage['hn:prefs']`,
  the `hn:*` session keys and `window.__hnlens` — because renaming any of them silently wipes an
  existing reader's settings and history and breaks every harness. The GitHub org/repo and the Pages
  domain are infrastructure identity, not product name, and also stay. The mark is drawn from
  semantic tokens (`--logo-*` aliased to `--border`/`--muted`/`--accent` in `index.css`), so all 31
  designs × light/dark are covered automatically rather than by a hand-maintained 62-entry table.

---

## Ship checklist

1. `npm run verify` (== the **standard** tier) → green: **static** (tsc, lint, build), **smoke**
   (audit/read/edge/**extreme**/**a11y**), **behaviour** (ui/persist/wiring/reach), and the
   **personalization** proof. `npm run test:quick` is the fast hermetic inner loop.
2. For a deep check (or if you touched models/summarization/theme): `npm run test:full` — adds
   **visual** regression, the **crossbrowser** sweep (webkit+firefox), **stress**, and the **webgpu**
   model + eval harnesses (needs WebGPU + downloads). `node scripts/test.mjs --list` prints every tier.
3. Rebuild the review artifacts: `npm run build` (Pages) and `npm run build:single` (file://).
4. Only then, if asked: commit / push (deploy runs via `.github/workflows/deploy.yml`).
