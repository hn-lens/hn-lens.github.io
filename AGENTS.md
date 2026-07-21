# AGENTS.md — HN Lens

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
> The two review agents run as a **read-only iterative loop** (usability → bug → primary fixes →
> iterate; see golden rule #7). This file is the *why* and the *gotchas*; the skills are the *how*.

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
   and stale-snapshot); the sound resolution is a **load-time snapshot** — hide read stories from For
   You on refresh, but stay stable in-session (no mid-read yank) — see the auto-hide lesson under
   Product decisions.
5. **Heavy ML libs load only via dynamic `import()`** (`@huggingface/transformers`, `@mlc-ai/web-llm`).
   Never statically import them in the app path — it would bloat the main bundle.
6. **Test at realistic laptop viewport heights** (768/800/900), never oversized canvases — that is
   how the clipped-sidebar bug slipped through. Any `sticky`/`overflow` container needs a
   max-height + scroll and a bottom-reachability assertion (`npm run test:reach`).
7. **Review is done by INDEPENDENT, READ-ONLY agents in an iterative loop — not by solo guessing,
   and the review agents NEVER change code.** The primary agent is biased (wrote the code, has
   wrong theories — proven repeatedly), so two fresh agents review, and only the primary fixes:
   - **Usability agent** (load **`hnlens-usability`**) role-plays a *real user pursuing a real
     goal* (default persona: a regular daily HN reader — HN Lens is a personalized HN *reader*, so
     don't let a stray word narrow the review to one feed), tries to get the goal done, and reports
     **usability issues + feature requests + information-presentation improvements** — effectiveness
     & ease.
    - **Bug/review agent** (load **`hnlens-bughunt`**) gets a *neutral, factual* brief (how to drive
      the app + the expected-behavior spec + "exhaustively discover every discrepancy and root-cause
      it"), never seeded with suspected bugs, and reports **correctness** discrepancies with root
      causes (`file:line`).
    - **REFRESH THE SPEC BEFORE EVERY RUN (do not reuse a stale brief).** Both reviewers' briefs must
      be rebuilt from the *current* features each time — re-read this file's "Product decisions &
      lessons learned" section AND `git log` since the last review, and fold every new/changed feature
      into the expected-behavior spec + the usability persona's goals. A reviewer can only catch
      behaviors its spec describes; a feature added after the spec was written is invisible to it.
      (2026-07-20: the "clicking a link surfaces an *Article text* link" bug shipped because the
      reviewers' spec predated fetch-on-click, so nobody checked that surface.)
   - **The loop:** usability report → bug report → **the primary combines both, validates each
     finding against the code (a report can be wrong — confirm first), applies the fixes (+
     regression tests), and runs the gate** → then iterate from the usability pass again.
   Both review agents are **strictly READ-ONLY: they never edit code or tests, never run the gate,
   never commit** — their only deliverable is a report. Run each as a **durable** job — a foreground
   `task` (block on it) or `session_spawn` (survives turns) — **never a background `task`**: those
   are turn-scoped and get torn down at a context boundary, which silently killed a hunt mid-run
   (2026-07-19).

---

## Architecture map

- `src/lib/hn/article.ts` — opt-in linked-article text via a **free CORS-proxy chain** (the ONE
  non-local feature; off by default — see the reader-proxy note below).
- `src/lib/hn/` — `firebase.ts` (official API: lists return **ids only** → N+1), `algolia.ts`
  (search + **whole nested comment tree in one request** via `/items/:id`), `client.ts` (IndexedDB
  cache + bounded-concurrency fetch pool; use it, don't fetch raw in components).
- `src/lib/db.ts` — Dexie schema: `events, items, lists, embeddings, kv, seen, saved, hidden` +
  `pruneCaches()` (called on startup).
- `src/lib/prefs.ts` — Zustand `persist` store → `localStorage['hn:prefs']`. **All 21 settings.**
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
- `src/hooks/` — `useFeed`, `useItem`, `useLocalData`, `useImpression`, `useTheme`, `useUi`, `useToast`.
- `src/components/` — `layout/` (TopNav, FeedTabs, Sidebar, HnAccount), `feed/` (Feed, StoryCard,
  SearchResults), `comments/` (CommentsView, CommentsDrawer, Comment, ThreadSummary),   `ranking/`
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
  the one the drawer already has), generates, and caches. A model/prompt change or toggling article
  text re-summarizes; **"Regenerate"** (`force`) overwrites. **Lesson:** "cached" must mean *fast* —
  test that a hit does no network work, not just that it returns the right text.
- **Comment organization (`Comment.tsx`) — research-backed (Reddit/HN/Tildes patterns):** a subtle
  vertical **thread line** per depth (accent-tinted for unread), **collapse a subtree** (shows "+N
  replies"), an **OP badge** on the story author, a **jump-to-parent** control on nested replies, and
  an **indent cap** (`INDENT_CAP=6`) past which a **"Continue this thread →"** link opens the branch on
  its own `/item/:id` page (stops threads collapsing to a sliver). Guarded by `commenttest`.
- **Comment ranking (`CommentsView`) — HN's API does NOT expose per-comment scores**, so there is no
  "top by points." The sort control offers **Default** (HN's own returned order), **Newest**, **Oldest**,
  **Most replies** (by descendant count). Don't add a score sort — the data isn't there.
- **Feed tabs refresh INDEPENDENTLY, not together:** each feed is its own TanStack Query (lists cached
  ~2 min). `useFeed` returns `updatedAt`/`isFetching`; `Feed` shows **"Updated Xm ago" + a Refresh
  button** (re-rendered on a 30s tick). Guarded by `audit` ([A2]).
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
  when a thread is open (drawer or `/item`; Enter/`c` then collapses the selected comment). **`h`/`l`**
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
  real score. `useFeed` computes `explainItem` only for the *visible* cards (cheap). Guarded by the
  personalization proof's UI phase (opens the dialog, asserts the score→weights→data trace).
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
- **The two "read" surfaces MUST agree — both drop hidden (fixed 2026-07-20):** the Read tab renders
  through `useFeed('read')`, whose non-For-You filter drops `hidden.has(id)`, but the sidebar "Recently
  read" panel comes from `recentRead()`, which had **no** hidden check — so a read+hidden story showed in
  the sidebar yet not the Read tab (two surfaces claiming "what you've read" disagreeing). `recentRead()`
  now excludes ids in `db.hidden` to match. **Lesson: when two surfaces derive from the same concept,
  test that they AGREE on the same seeded state** — `readtest.mjs` seeds a read+hidden story and asserts
  it's absent from BOTH the Read tab and the sidebar (F2). **Extended (fixed 2026-07-20): they must also
  agree under the GLOBAL filters, not just Hide.** The Read tab applies `isFiltered` (muted domain/user/
  keyword + min-points) via `useFeed`, but `recentRead()` only dropped hidden — so a read story from a
  muted domain showed in the sidebar yet not the Read tab. `recentRead()` now applies the SAME
  `isFiltered` (reusing the one source of truth, with a minimal context — affinities don't affect
  filtering) so both surfaces honor global mutes/min-points identically. Guarded by `readtest` F2b (seed a
  read story on a muted domain → absent from BOTH surfaces; verified to fail pre-fix). *Same lesson, wider:
  when a concept is filtered on one surface, every surface deriving from it must apply the same filter.*
  (The Read + For-You empty states are correspondingly filter-aware: a Read history hidden entirely by
  filters says "your filters are hiding your read stories", and a For You emptied only because every
  candidate is already-read says "you're all caught up · see the Read tab", not a generic "nothing to show".)
- **For You hides read stories via a LOAD-TIME SNAPSHOT (`hideReadInFeed`, default ON; resolved
  2026-07-20):** the earlier auto-hide was a dead-end in its two naive forms — hiding **live** yanks a
  card out mid-read; a snapshot that RE-SNAPSHOTS on focus/navigation trades that for stale-until-
  refresh churn. The working design (what the user asked for) is a snapshot captured **once per page
  load** and held **fixed for the whole session**: a story read **mid-session is NOT removed** (no
  yank), and a **browser refresh recomputes** it so already-read stories drop out then (so they're not
  duplicated in For You *and* the Read tab). The snapshot is **PRIMED ONCE AT APP STARTUP in `main.tsx`**
  (`queryClient.prefetchQuery({ queryKey: ['readSnapshot'], … staleTime/gcTime: Infinity })`), NOT
  captured lazily inside `useFeed`. `useFeed`'s `readSnapshotQ` is a **plain, always-enabled reader** of
  that primed cache (never invalidated → stable in-session, reset on reload) and only *applies* it to the
  For-You `cards` when `hideReadInFeed` is on; scoring/`explainItem` stay pure. **The lazy-capture
  version was a bug (fixed 2026-07-20):** gating the query `enabled: isForYou && hideReadInFeed` captured
  the set the first time both turned true — so toggling the pref ON mid-session *yanked* a story read
  this session, and if For You wasn't the default feed a story read before opening it vanished on first
  view (both contradicting "load-time + stable-in-session"). Capturing at startup makes it feed- and
  toggle-independent. Toggle in Settings → Appearance & feed. **Do NOT** make the hide reactive to
  in-session reads (that's the yank), **do NOT** re-snapshot on tab switch/focus/first-mount (that's the
  churn / lazy-capture bug), and **do NOT** invalidate `['readSnapshot']` on engagement in `main.tsx`
  (that re-introduces the mid-session yank — the comment there says so) — the whole point is load-stable
  + refresh-recompute. `readtest.mjs` guards ALL of it: after refresh read stories are gone from For You
  but present in the Read tab (no duplication); a mid-session read STAYS; the next refresh drops it; the
  pref OFF hides nothing; **toggling the pref ON mid-session does NOT yank a mid-session read (F3a);** and
  **a mid-session read is not hidden when For You is opened late with a non-For-You default feed (F3b).**
  Tests that seed read history and assert For-You *ranking/stability* (personalization proof, audit) set
  `hideReadInFeed: false` so the snapshot doesn't remove their fixtures.
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
  **"new since last visit" comment badge only worked on `/item`, never on the feed→drawer path** (how
  users actually open a discussion): `StoryCard.onOpenComments` pre-called `markSeen` before
  `CommentsView` captured the previous seen timestamp, so `lastVisit ≈ now` and nothing was ever
  "new". `commenttest` had asserted the badge — but only via `/item`, so the broken primary path passed
  green. Fix: `onOpenComments` no longer marks seen (CommentsView is the single place that records a
  discussion visit; the card still dims via the live seen map). **Rules:** for every setting, assert
  its ON vs OFF changes the rendered UI (not just the store); for every feature, drive the path a real
  user takes (the feed card / drawer), not only the convenient permalink. Both are guarded by
  `discussionviewtest` (hermetic, in `verify`): the summary control shows with the toggle ON + hides
  with it OFF, and the "new" badge appears on the **drawer** path, not just `/item`.
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
  public favicon service (`faviconUrl` in `time.ts` → `google.com/s2/favicons`), so the *domains* of
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
  toggle OFF, opening a discussion (drawer OR `/item`, one definition of "read") still leaked the
  domain to Google. `CommentsView` now gates the header favicon on `remoteFavicons` too, and
  `favicontest` was extended to assert **0** favicon requests when opening a discussion on both paths
  (verified to fail pre-fix). *Same lesson, wider: test a privacy/effect toggle on EVERY surface that
  can trigger the effect — the original test only checked feed cards and missed the discussion header.*
- **Search:** cap query length (Algolia 400s on long queries); provide a Relevance/Newest sort; hide
  For-You-only sidebar panels during search.
- **Hard filters are GLOBAL, not For-You-only (fixed 2026-07-19):** muted domains/users/keywords and
  min-points apply on **every** feed (Top/New/Best/Ask/Show/Jobs/Read) **and search**, via
  `isFiltered()` in `useFeed`'s plain-feed path + `SearchResults`, not just `computeForYou()` — the
  Settings "Filters" section and labels promise global muting. **Min-points only filters items that
  carry a numeric score** (`features.ts`), so a threshold can't silently empty the score-less **Jobs**
  feed. Guarded by `filtertest` (mute domain/keyword + min-points across Top/Jobs/Search, and the
  scoreless-job negative). *Lesson: a filter whose label implies "everywhere" must run everywhere; test
  it on a plain feed + search, not only For You.*
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
