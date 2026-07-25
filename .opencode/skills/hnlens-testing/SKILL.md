---
name: hnlens-testing
description: >-
  Test HN Lens comprehensively with the Playwright harness suite and `npm run verify`. Use when
  adding a feature or fixing a bug (you MUST add/extend a harness), aiming for full surface
  coverage, testing the local models (WebGPU), or debugging flaky/uncaught UI issues. Covers the
  coverage matrix, realistic-viewport rules, reachability checks, and how tests drive real app code.
---

# Testing HN Lens

Tests are **Playwright end-to-end harnesses** in `scripts/*.mjs`, driven against a real preview
build. There is no unit-test runner — "coverage" means **every surface/interaction/state has a
harness assertion**, not line coverage. The app exposes `window.__hnlens` (lazy module loaders +
the prefs store) so harnesses drive the *real* code paths, not mocks.

## The one command (and its tiers)

```bash
npm run verify        # == node scripts/test.mjs standard — the pre-handback gate
```

Tests are organized into **tiers**. `scripts/test.mjs` runs a **mode** (a named set of tiers): it
builds the app once, serves ONE preview on port **4182** (override with `--port`), runs every
selected harness against it via the `BASE` env var, tears the preview down, and prints a per-tier
pass/fail summary with timings. **Run `npm run verify` (standard) before handing anything back.**

| Mode | `npm run` | Tiers | Use it for |
|---|---|---|---|
| `quick` | `test:quick` | static, smoke | fast inner loop — hermetic, chromium, no network/models |
| `standard` | `verify` | static, smoke, behaviour, personalization | **before handing anything back** |
| `full` | `test:full` | + visual, crossbrowser, stress, webgpu | pre-release / deep check (cross-browser + WebGPU models) |

**Tiers** (each step is a `scripts/*.mjs` harness unless noted):
- **static** — `tsc -b`, `oxlint` (0 warnings), `vite build` (no browser).
- **smoke** — hermetic, mocked-HN, chromium: `audit`, `readtest`, `readstatetest`, `feedstabilitytest`, `edgetest`, `extremetest`, `a11ytest`, `layouttest`, `commenttest`, `llmcachetest`, `keyboardtest`, `hnaccounttest`, `weighthintstest`.
- **behaviour** — `persisttest`, `uiwiring`, `reachtest`, `uitest` (the end-to-end tour hits **live HN**).
- **personalization** — `personalization-proof` (proves the recommender learns + reorders; hermetic).
- **visual** — `visualtest` (pixelmatch vs baselines; first run seeds them, `--update-visual` rewrites).
- **crossbrowser** — `audit` + `edgetest` re-run on **webkit** and **firefox** (needs those Playwright browsers).
- **stress** — `stress` (adversarial, **live HN**; informational — its lone expected finding is a benign 404).
- **webgpu** — `modeltest` + `evaltest` (load embeddings + Llama-3.2-1B and summarize; slow, downloads weights).

Flags: `--only=tierA,tierB`, `--skip=tier`, `--continue` (run all steps despite a failure),
`--update-visual`, `--port=N`, `--llm=ID`, `--list` (print modes+tiers). Every harness also runs
standalone via its own `test:*` script (defaulting `BASE` to `http://localhost:4173/`, i.e. a
`npm run dev`/`preview` you already have up) — handy for iterating on one harness.

## RULE: a functional test must assert BEHAVIOUR, not just "it renders"

A "read tab" bug shipped green once because its test only checked the tab *rendered or showed an empty
state* — it never asserted the tab showed the **right** items. It was actually rendering the For-You
feed (a `FeedKind` whitelist in `Home.tsx` was missing `'read'`, so the tab silently fell back to For
You). Lesson: for any feature, seed a **known** state and assert the **specific expected output**
(exact ids/titles/counts), plus the negative (what should NOT appear). "Didn't crash" is not a pass.
`readtest.mjs` is the model: it seeds a read history and asserts the Read tab lists exactly the read
stories (bounce excluded) and For You hides them.

## Harnesses (what each guarantees)

| Script | `npm run` | Guards |
|---|---|---|
| `uitest.mjs` | `test:ui` | End-to-end tour: all 7 feed tabs, search (+ empty/special-char), discussion page (open/collapse/sort/back), save→Saved, hide, permalink, **invalid routes**, Settings (toggles/sliders/dropdowns), reset, retrain, **cached-models list+remove**, HN-account import, theme, clear-data. **Must stay green (0 issues, 0 console errors).** Ignores `net::ERR_ABORTED` (cancelled in-flight requests are not failures). |
| `persisttest.mjs` | `test:persist` | All **20 settings** survive refresh AND close/reopen (persistent profile) — incl. `themeName` (design) + `layout` (structure); IndexedDB saved/hidden persist; `partialize` completeness. Uses a keyed `EXPECT` map — add new prefs there. |
| `uiwiring.mjs` | `test:wiring` | Every control writes to the store (selects incl. **theme design** + **layout** + **light/dark mode**, toggles, sliders, all 6 tag editors, HN-username, TopNav theme cycle). |
| `reachtest.mjs` | `test:reach` | At realistic heights (1280×800, 1440×900, 1366×768) the expanded **Tune ranking** panel + panels below are **reachable** (clicks auto-scroll and fail if clipped). |
| `readtest.mjs` | `test:read` | **Read tab + the "read" definition + no-destructive-auto-hide.** Mocks the HN API, seeds a known history and asserts `getReadItemIds` = opened-article(non-bounce) + **stayed-on-discussion** only: **bounce, save, summarize, GLANCED-discussion, and IMPORTED (`meta.source:'hn_import'`) are all excluded**; the Read tab + sidebar "Recently read" list exactly the read stories. Then the **negative**: For You **KEEPS** read stories (reading one in-session doesn't vanish it, survives reload). Hermetic — in `verify`. |
| `audit.mjs` | `test:audit` | **Behavioural sweep over a fully mocked HN API** — asserts concrete outcomes with distinct per-feed id ranges: every feed tab loads *its own* feed (catches silent fallback), save→Saved→unsave, hide→removed→Undo→restored, the discussion page shows the fetched comments, search shows results. Screenshots to `scripts/.artifacts/audit/`. This is the safety net for "renders ≠ works". Honors `BROWSER` — re-run on webkit + firefox by the crossbrowser tier. |
| `edgetest.mjs` | `test:edge` | **Edge / security / robustness** ("1B hostile users"): XSS payloads in title/self-text/comment do NOT execute (DOMPurify), `javascript:` URLs never become links (`safeUrl`), empty-feed + fetch-error+Retry + no-results states, pagination/Load-more, `?` shortcuts overlay, mobile layout (sidebar hidden), whole-card click records an open. Hermetic (mock behaviour flipped per scenario). Honors `BROWSER` (chromium/webkit/firefox) — the crossbrowser tier re-runs it on all three. |
| `extremetest.mjs` | `test:extreme` | **Malformed / extreme input** a real feed eventually produces: items missing every field + a `null` item in the list, an 8k-char title, unicode/RTL/emoji titles, a 60-deep comment thread, rapid feed-tab hammering. Any `pageerror`/console error fails. Hermetic. |
| `a11ytest.mjs` | `test:a11y` | **Accessibility (axe-core, WCAG 2 A/AA)** on Home, Item permalink, Settings, and a discussion opened from a feed card. **Fails on any serious/critical** issue; reports moderate/minor as warnings. Hermetic. (Caught real bugs: `aria-hidden-focus` on a closed overlay → `inert`; low-contrast tokens → darkened.) |
| `layouttest.mjs` | `test:layout` | **Proves the LAYOUT axis restructures the DOM** (not just recolors). Switches all **11 layouts** and asserts concrete structure at a desktop width: `magazine`/`grid` feed = CSS grid (2/3 cols), `list`/`compact` cards borderless + numbered + favicons hidden, `compact` body = single flex row + actions hidden, `zen` sidebar hidden, `rail` content = grid + nav tabs vertical, `timeline` spine gutter + node dot (`::before`), `media` larger title + index, `newspaper` multi-`column-count` flow, `cover` accent left-bar + big title; plus 0 console errors. Then a **render sweep** applies **all 31 designs** in light AND dark and asserts each still renders with no console error. Screenshots each layout to `scripts/.artifacts/themes/`. Hermetic. |
| `visualtest.mjs` | `test:visual` | **Visual regression** (pixelmatch) of Home light/dark, Settings, Item over a mocked HN API (animations off, fixed viewport). First run seeds baselines in `scripts/.artifacts/visual/` (gitignored); later runs fail on >0.5% pixel drift. `--update` rewrites baselines. |
| `readstatetest.mjs` | `test:readstate` | **Exhaustive read-state transitions + monotonicity.** Seeds a matrix (article stay/bounce/no-dwell, discussion stay/glance, save/summarize/upvote/import) and asserts `getReadItemIds` for each; asserts **MONOTONICITY** — a genuine read then a later bounce/summarize/save STAYS read; then real-flow: in the Read tab, **re-clicking a read item + bouncing keeps it** (the reported vanish bug), and summarizing a read item keeps it. Hermetic. |
| `feedstabilitytest.mjs` | `test:feedstability` | **The "interacting wrongly makes an item vanish" bug class**, across feeds: save / summarize / open+bounce / open keep an item in Top; hide removes it + Undo restores; the Saved page lists saved & excludes unsaved; saved persists across reload. Hermetic. |
| `hnaccounttest.mjs` | `test:hnaccount` | **HN-account sidebar** over a mocked user + Algolia: profile stats (karma/posts/comments), "You post most from", "Recent posts", invalid-username error, and — the *dual-purpose* `countHnImport()` (the Recently-read bug class) — the button label flip (Use my history ⇄ Re-import…) AND the persistent "N … personalizing your feed" line after import + reload. Hermetic. |
| `weighthintstest.mjs` | `test:weighthints` | **WeightSliders "inactive" hints** (a derived guard for a documented no-op trap): with no data/model the affinity/relevance/learned sliders show inactive hints; enabling embeddings clears the relevance hint, following a domain clears the affinity hint. Hermetic. |
| `keyboardtest.mjs` | `test:keyboard` | **ALL keyboard navigation** (the rule: cover every nav need or remove it). `j`/`k` move through **feed cards**; `h`/`l` switch tabs; the **sidebar** has focusable controls in tab order; opening a thread, `j`/`k` move through **comments** and **Enter collapses** the selected one; `/` focuses search, `?` opens help. Hermetic. |
| `commenttest.mjs` | `test:comments` | **Comment organization + ranking + discussion-dwell** over a mocked Algolia tree: sort (Default/Newest/Oldest/Most-replies) reorders; **OP badge**; 8-deep chain shows **"Continue this thread"**; collapse hides replies; jump-to-parent; "new since last visit" badge; and the **real-flow dwell gate** — glancing a discussion (leave immediately) does NOT mark it read, staying past `BOUNCE_MS` does. Hermetic. |
| `llmcachetest.mjs` | `test:llmcache` | **Summary source-transparency + caching (no WebGPU).** Seeds the IndexedDB cache at `summaryCacheKey()`, then drives the real `summarizeItem`/`describeSources`: a cache hit returns `cached=true` + the stored text (no model call); the `SummarySources` descriptor reports article words / comment count / self-text; the "enable article text" hint fires only when a URL exists + proxy off. Hermetic. |
| `personalization-proof.mjs` | (in `test:personalization`) | **Proves the recommender learns + reorders**, not just renders. Seeds a known taste, runs the *real* affinity/train/score/embedding/**content**/**dwell**/**autotrain** modules, and asserts (32 checks): affinities recover the taste; the **pairwise-ranking** model fits (loss ↓, held-out AUC); weights have correct sign incl. **content** (`relevance`, `termAffinity`) and are **calibrated**; `scoreItem()` == hand-computed (1e-9); learned term == 0 when toggled off; cold-vs-personalized ranking lifts liked stories to the top; a **comment-only term** and (opt-in) an **article-body-only term** each lift an otherwise-neutral story above its twin; the **"Why #N?" explainer** opens with the score→weights→data trace; a **quick bounce** trains as negative while a **long read** trains positive (dwell); and **auto-train** fires on new engagement, is rate-limited, and is gated by the toggle. **Hermetic — mocks the HN API + reader proxy**, so it's in `verify`. |
| `stress.mjs` | `test:stress` | Adversarial: rapid tab/save/hide/discussion, nasty search (XSS/long/unicode), invalid routes, extreme weights, weird HN usernames, clear-data-mid-use. Watches for ErrorBoundary crashes + console errors. (Informational; the only expected finding is a benign 404 network log for a genuinely nonexistent item id.) |
| `modeltest.mjs` | `test:models` | Loads the embedding model + default LLM via **WebGPU** and asserts: TL;DR + thread summary generate coherent (non-degenerate) output; a **loading spinner** shows while summarizing; clicking the TL;DR button **does NOT mark the item read** (`getReadItemIds` stays empty — summarize ≠ read); and a card TL;DR + thread summary fired **concurrently both finish** (serialized, no deadlock). Slow: downloads models. |
| `evaltest.mjs` | `test:eval` | Summarization quality on live threads for a given `LLM_ID`; prints outputs to read. Use to compare models/prompts. |

Model tests are **excluded from `verify` (standard)** — they need WebGPU + large downloads. They
live in the **webgpu tier of `full`** (`npm run test:full`, or `node scripts/test.mjs full
--only=webgpu`); run them when you touch `src/lib/models/*` or ranking/summarization. Keep their
`LLM_ID` in sync with `src/lib/models/catalog.ts` — `modeltest` selects the model in the UI dropdown,
so a model removed from the catalog (e.g. SmolLM2/Qwen were rejected) breaks the harness.

## Hard rules (these are why bugs slipped through before)

1. **Add or extend a harness for every feature/bug.** New control → add to `uiwiring` + `persist`.
   New view/state → add a `uitest` step. New sticky/scroll area → add a `reachtest` case.
2. **Test at realistic laptop heights (768/800/900), never oversized canvases.** A 1440×1500
   viewport hid the clipped-sidebar bug. Overflow only bites at real heights.
3. **Assert the *last* control in any scroll/sticky container is clickable** — a Playwright click
   auto-scrolls and *fails* if the element is clipped. Don't just check it "renders".
4. **Catch console errors**: harnesses collect `console.error` + `pageerror`; filter only the known
   external CDN 404s (favicons/gstatic/HF/MLC). Any app console error = failure.
5. **XSS check stays green**: nasty search/HTML input must not execute (DOMPurify + React escaping).

## Running the model / eval harnesses (WebGPU)

Launch Playwright Chromium with WebGPU flags and a **persistent profile** so the model is cached
across runs (fast iteration). Use `launchPersistentContext('/tmp/hnlens-eval-profile', { headless:
true, args: ['--enable-unsafe-webgpu','--enable-features=Vulkan','--use-angle=metal'] })`.
`navigator.gpu` is only exposed in a **secure context** — always drive `http://localhost`, never
`about:blank`. Pick a model with `LLM_ID=...` (e.g. `LLM_ID=Qwen2.5-1.5B-Instruct-q4f16_1-MLC
npm run test:eval`).

`modeltest.mjs` includes a degeneration detector (backtick spam / low lexical variety) — a model
that echoes the prompt or loops fails, which is how Gemma-3 (broken in WebLLM 0.2.84) and the
too-small models were rejected.

## Driving real code from a harness

```js
await page.evaluate(async () => {
  window.__m = await window.__hnlens.llm();          // real llm.ts module
  const alg = await window.__hnlens.algolia();       // real algolia client
  window.__hnlens.prefs.getState().set({ minPoints: 50 }); // real zustand store (== UI setters)
});
```

Prefer `getByRole`/`getByLabel`/`getByPlaceholder`; every control has an `aria-label`. Feed cards
are `<article>`; the primary link is `article h3 a|button`; the comments button is
`aria-label="Open comments"`.

## Proving personalization works (not just "it renders")

Recommenders can silently no-op (empty affinities, untrained model, a term that's always 0). To
*prove* the pipeline learns and changes the feed, run:

```bash
npm run test:personalization   # build → serve → proof harness → render dashboard → self-test it
```

It produces (in `scripts/.artifacts/`, gitignored): `personalization-report.json` (machine-checkable),
`personalization-proof.html` (a self-contained visual dashboard — affinity/weight bars, loss curve,
P(engage) separation, before/after ranking, embedding-similarity bars, embedded UI screenshots), and
the two screenshots. Regenerate the dashboard alone with `node scripts/personalization-report.mjs`.

**Method — a controlled A/B that drives the real code:**
1. Seed a *known* taste as interaction history (e.g. loves arXiv + Rust + user "pg"; ignores/hides
   crypto), with crypto deliberately given the **highest** HN scores so a non-personalized ranker
   gets it wrong — that gap is the proof.
2. Via `window.__hnlens` call the **real** modules — `interactions.computeAffinities`,
   `train.buildTrainingSamples` + `train.trainFromHistory`, `logistic.trainModel/predictProba`,
   `features.*`, `strategies.computeForYou/scoreItem`, `embeddings.computeSimMap`. Nothing is
   reimplemented; the loss curve re-runs the *actual* trainer at k=1…120 epochs.
3. Assert each claim with data: affinity signs, loss ↓, train **and held-out** AUC, weight signs,
   P(engage) separation, `scoreItem()` == recomputed-by-hand (1e-9), learned term == 0 with the
   model off, and cold-vs-personalized rank deltas (liked items rise to the top).
   **Content features** (`content.ts`): `relevance` (title/self-text embeddings) is a *trained*
   feature and `termAffinity` (title + comment terms) trains too — assert both weights are positive.
   The **comment-content** proof seeds a term that appears only in engaged threads' COMMENTS, then
   shows an otherwise-neutral story whose title has that term outranks its identical twin — proving
   comment text (fetched via mocked Algolia `/items/:id`) drives ranking. Training uses **leave-one-
   out** so a story never sees a profile containing itself; keep that invariant when editing.
4. Drive the **real UI over a mocked HN API** (`page.route` on `hacker-news.firebaseio.com`) so the
   controlled taste flows end-to-end: For-You shows a liked story first with a real "why" chip;
   Settings shows "trained on N examples"; and the **"Why #N?" rank explainer** (`RankExplainDialog`)
   opens with the full score→weights→data trace. NOTE: several other overlays use `role="dialog"`
   too — select the explainer by content (`/How the score adds up/`), not the first
   `[role=dialog]`.

`train.ts` exports `buildTrainingSamples()` **specifically so the harness can evaluate the exact
samples the trainer fits on** — keep it exported. If you change ranking/features/training, update the
seeded dataset + assertions here (a new feature dimension → assert its weight/behaviour).

## Environment note

Use **Playwright's bundled Chromium** (all harnesses do), not a system browser — a managed/
policy-locked Chrome can stall on external fetches. See `hnlens-build` for the WebGPU flags.
