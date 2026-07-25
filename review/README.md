# HN Lens — independent review system

HN Lens is reviewed by **seven independent, read-only agent "lenses"** each round. This directory
holds their **base prompts** — the persistent, version-controlled instructions that define each
lens. They are stable across rounds and improved over time; git history is how we iterate on
reviewer quality itself.

> Why this exists: the coding agent that wrote a change is biased (it has the wrong theories and
> knows where it "should" work). Fresh, unbiased, read-only agents review; only the primary fixes.
> See golden rule #7 in `AGENTS.md`.

## The seven lenses

| Lens | Base prompt | Finds |
|---|---|---|
| Usability | `base/usability.md` | Real-user friction, dead-ends, copy-vs-behavior, discoverability |
| UI/UX stress | `base/uiux-stress.md` | Overflow, scrollbars, popover/stacking, device-matrix glitches |
| Design & theme | `base/design-theme.md` | Text AA + non-text (1.4.11) contrast + visual quality, full matrix |
| AI / ML | `base/ai-ml.md` | Summary output quality, ranker efficacy, injection/robustness, AI UX |
| Bug / correctness | `base/bug-correctness.md` | Behavioral discrepancies vs. spec, root-caused |
| Performance | `base/performance.md` | Latency + resource use; architectural vs. fixable |
| OSS release audit | `base/oss-release.md` | Secrets, license, lockfile registry, internal-reference leakage, doc accuracy, deploy safety |

Every lens also inherits `base/_common.md` (shared rules: read-only, repo-scoped, how to drive the
app, mindset, deliverable format).

## How a round is run (compose base + current state)

Base prompts are deliberately **free of volatile specifics** (URLs, exact `file:line` invariants,
the current feature list) — baking those in is what made earlier prompts leak answers and go stale.
Each round, the primary constructs the actual dispatch prompt for each lens as:

```
<base/_common.md>  +  <base/{lens}.md>  +  CURRENT STATE appendix
```

The **CURRENT STATE appendix** is rebuilt every round from the live repo and injects only the
volatile facts:

1. **Running app URL** (the `vite preview`, rebuilt from HEAD before the round) and the **repo path**.
2. **`window.__hnlens` surface** actually exposed this round (grep `src/main.tsx`).
3. **Feature set**: a short summary distilled from `AGENTS.md` ("Product decisions & lessons
   learned") + `git log` since the previous round — so each lens knows every new/changed feature.
   For the **bug lens**, this is the neutral expected-behavior spec (no suspected bugs).
4. **Existing automated guards** relevant to the lens (e.g. `scripts/themecontrasttest.mjs` for
   design) so it spends effort on gaps, not re-running the guard.
5. **Round-specific inputs**: e.g. a real cloud API key for the AI lens's output-quality grading;
   a persona for usability; the report path `/tmp/<round>_<lens>.md`.

Rules for the appendix: **refresh it every round from current code** (never reuse a stale one), and
**never tell a lens where a bug is** or seed it with hypotheses. Usability / UI-UX / design get a
persona or matrix goal; AI / bug / performance get a factual spec + how to drive it.

## The loop (until convergence)

1. Rebuild `dist` from HEAD so the preview reflects the code under review.
2. Compose the seven prompts (base + fresh appendix) and dispatch all seven as **durable** jobs
   (foreground `task`, blocking, or `session_spawn` — **never a background task**, which gets torn
   down at a context boundary and silently kills a hunt).
3. The primary **combines all seven reports, validates each finding against the code** (a report can
   be wrong — confirm first), applies **root-cause fixes + regression tests**, and runs the gate
   (`npm run verify`). **Every fix must clear the four checks below before it counts as done** — they
   exist because measured rounds showed the primary's own fixes were a leading source of the next
   round's findings.
   - **(i) Re-run the LENS'S repro, across the LENS'S matrix.** Not a narrower probe of your own.
     Paste the before/after numbers from their script. (A fix verified on one viewport shipped a
     BLOCKER that their 14-layout sweep caught immediately.)
   - **(ii) Enumerate the SIBLINGS, with evidence.** Grep the SHAPE, not the symptom; state how many
     sites you found and that you checked them all in this same change. "Fixed one instance of a
     class" is not a fix.
   - **(iii) Verify the INVARIANT the fix assumes.** Write it down and test it. ("At sm+ the FAB sits
     in an empty gutter" was simply false — the gutter starts at lg — and re-created the same defect
     in a different range.)
   - **(iv) After the fix batch, run ONE diff-scoped adversarial pass** — a fresh read-only agent that
     audits ONLY the surfaces the diff touched — before declaring the round done. This is far cheaper
     than discovering a self-inflicted regression a whole round later.
3b. **Classify every finding's ORIGIN** in the changelog: `new-from-my-fix` / `incomplete-sibling` /
   `pre-existing`. Without this the regression rate is argued from memory, and memory has already
   been wrong about it in both directions.
4. **Fold this round's findings back into the base prompts (MANDATORY — do it every iteration).**
   For each finding, ask "what CLASS of defect is this, and why didn't the lens catch it sooner (or
   catch it from first principles)?" — then update the relevant `base/*.md` so the lens hunts that
   class next time: add the recurring **blind spot** (esp. gaps the automated guards can't see), the
   proven **high-yield area**, or the **technique** that found it. Fold in as *classes/invariants/
   techniques*, NOT as "the bug was in file X" (never turn a base prompt into a spoiler checklist —
   the lens must still discover from first principles). Record it in the changelog below and commit.
5. Iterate from step 1. **Convergence = a full round with no new blocker/high/medium** (only
   documented-deferred LOWs remain).

## When the DEVELOPER reports a defect (do NOT fix it directly)

A defect the developer reports by hand is the loop's most valuable input — **not because it tells you
what to fix, but because it tells you which lens is BLIND.** Fixing it directly wastes that: the
primary agent is biased (that's why the lenses exist), a hand-patch carries no independent signal, and
it repairs only the reported instance while the class stays invisible to every future round. See
AGENTS.md golden rule #8. The required sequence:

1. **Name the CLASS**, not the case — "what general kind of defect is this an instance of?"
2. **Identify the lens that should have caught it** and articulate the gap: quote the brief wording
   that *nearly* covers the class and say precisely what it failed to demand.
3. **Upgrade that lens's `base/*.md`** to hunt the whole kind (generalized past the reported surface),
   including the grading procedure that would surface it. Fold into any other lens whose scope
   overlaps the class.
4. **PROVE THE DETECTOR against the PRE-FIX state.** A brief edit is only a hypothesis. Reproduce the
   defect — a scratch copy of the tree with the fix reverted, served on **its own port** (never touch
   the developer's 5173) — and run the upgraded lens on it read-only. It must **rediscover the defect
   unaided, without being told it exists.** If it doesn't, the brief is still wrong: iterate on the
   *brief*, not the code. (Same pre-fix-must-fail / post-fix-must-pass rule already required of guards.)
5. **Only then fix**, on the lens's independent signal — every instance it found, at root cause, with a
   regression guard.
6. **Re-run the loop** so a *clean* round certifies the fix, and record it in the changelog below.

**Success test:** the same report, made again later, would be caught by a lens first. A fix that leaves
the lenses as blind as they were is not done.

## Iterating on the reviewers themselves

The base prompts are living documents — improving them is step 4 of every round, not a one-off. If a
lens is low-yield, misses a class of defect, or keeps re-discovering the same class the hard way,
sharpen its base prompt here and commit (git history is the audit trail). Keep the edits at the level
of *what class to hunt / what invariant to check / what technique to use* — a base prompt that names
a specific past bug stops teaching and starts leaking.

### Changelog — findings folded into these prompts

- **2026-07-23 (rev1–rev3, first cycle on these prompts):**
  - `ai-ml.md` — promoted the one-line dwell/label check into an explicit **training-label matrix**
    with two invariants (labels must MIRROR the read definition with the same dwell-awareness on the
    article AND discussion paths; labels must be MONOTONIC). Rationale: the rewritten lens found a
    real MEDIUM here in two consecutive rounds (a discussion glance labeled positive; a read-then-
    bounce article demoted to negative).
  - `design-theme.md` — named the recurring **hardcoded/literal Tailwind palette color** and
    **accent-on-accent-tint badge** blind spot (the semantic-token guard can't see them), with a grep
    technique. Rationale: three rounds each surfaced one more sub-AA literal color (bar fills, Settings
    amber warnings, red delete buttons, the HnAccount error).
  - `bug-correctness.md` — added "**two paths that answer the same user question must AGREE and be
    monotonic**" (e.g. `getReadItemIds` vs `buildTrainingSamples`). Rationale: both of the cycle's
    correctness MEDIUMs were parallel-derivation drift.
  - (The prior big change — rewriting `ai-ml.md` from a "confirm these algorithms exist" checklist
    into a "run the model on hostile inputs + measure ranker efficacy" mandate — is what made rev1
    find the first training-label bug at all.)
- **2026-07-23 (cycle 2 — first re-run on the sharpened prompts; it found 4 new MEDIUMs, validating
  the fold):**
  - `ai-ml.md` — **corrected** the training-label matrix: the earlier fold wrongly asserted "HN-import
    events are NOT positives." Imported *engagement* (posts AND commented threads) MUST be training
    positives; the trap is that the SAME event type is a glance in-app. Labels key on provenance +
    dwell, not event type. (And training legitimately diverges from the read-DISPLAY definition on
    imports.) Rationale: a real MEDIUM — the ranker stayed dormant after import for commenters.
  - `bug-correctness.md` — sharpened the parallel-derivation rule with "**enumerate EVERY surface that
    reflects one concept**" (the `rankerTrained` gate recurred as a bug on a 3rd surface — the For-You
    warming-up banner — after the sidebar was fixed in an earlier round).
  - `design-theme.md` — added accent-on-tint **severity triage** (primary/≥14px text = must-fix AA;
    tiny redundant decorative micro-badges = LOW, may be an appendix-ACCEPTED motif). Rationale: the
    accent-on-tint hunt correctly caught a real MEDIUM (the active FeedTab label, 19 themes) but also
    a swarm of tiny decorative chips that are an accepted motif — triage keeps severity proportionate.
  - *Lesson about the folding practice itself:* a fold can encode a WRONG invariant (the import case);
    the next cycle's lens, following the sharpened prompt, surfaces the contradiction — so the loop
    self-corrects the prompts, not just the code. Per-round folding (recording appendix ACCEPTANCES) is
    also what lets a round converge instead of re-flagging known-accepted decoration forever.
- **2026-07-23 (cycle 2, round 2 — convergence check on the cycle-2 prompts; found 1 MEDIUM + 1 LOW,
  so not yet converged):**
  - `bug-correctness.md` — the `rankerTrained` gate recurred on a **FIFTH** surface (the ranking-
    weights "Learned reranker" slider inactive-hint, which gated on `n > 0`), so the "enumerate EVERY
    surface" example now lists all five AND makes the meta-point explicit: the list grew to five over
    separate rounds, so treat it as non-exhaustive — grep every reader of the concept (`model.n`, the
    gate constants) rather than trusting the named list.
  - `design-theme.md` — folded the **`subtle` is a DECORATIVE token** distinction into the text-AA
    axis: informative captions a user must read (a summary's provenance line, stats, status) must use
    `muted` (AA-normalized on surface-2), not `subtle` (intentionally faint, sub-AA on raised
    surfaces). Rationale: the TL;DR provenance caption used `subtle` on surface-2 (17 combos < AA) —
    a real LOW the guard misses because it checks tokens, not which token a component chose.
- **2026-07-23 (cycle 2, round 3 — added the 7th lens; found 3 MEDIUM + a borderline-MEDIUM + LOWs,
  so still not converged):**
  - **Added the seventh lens: `oss-release.md`** (OSS RELEASE AUDIT). HN Lens is developed internally
    but published publicly (GitHub + Pages), so a lens now audits the repo/build/deploy/docs for
    secrets, the `package-lock.json` public-registry gotcha, internal-reference leakage, license,
    doc accuracy, and privacy/telemetry posture. Wired into the table, the loop, and `AGENTS.md`
    golden rule #7. (It runs starting c2r4.)
  - `uiux-stress.md` — folded the **`min-w-0` overflow class**: a flex/grid child with `w-full
    max-w-*` and no `min-w-0` overflows a narrow viewport and pushes controls (a dialog's close X)
    off-screen. The lens now opens EVERY dialog at 320px + drives grid/magazine/bento, multiplied by
    the "Large" reading-text axis. Rationale: the Signals dialog overflowed at 320px (close off-screen)
    and grid layouts overflowed the page at 320px with Large text — 8 dialogs shared the latent bug.
  - `ai-ml.md` — strengthened the training-label MONOTONICITY invariant with the **import SYMMETRY
    trap**: imported posts and imported comments are both declared engagement and must be UNCONDITIONAL
    positives; a real MEDIUM had imported posts (but not comments) flowing through the bounce-overridable
    set, so a later in-app re-click+bounce flipped your own submitted post to a negative.
  - `bug-correctness.md` — the ranker-gate example is now **two-part** (`useLearnedRanker && rankerTrained`)
    and up to a SIXTH surface: a surface can get one part right and miss the other (the weights slider
    checked `rankerTrained` but ignored the toggle). Check the WHOLE gate, and seed both edge cases.
  - `usability.md` — folded **self-contradicting explanations** (the "Why #N?" trace calling a
    demoting/negative contribution the "biggest factor" a story ranks HIGH) into the honesty sweep, and
    **device-neutral copy** ("tap" in desktop copy) into the copy-vs-behavior sweep.
  - `performance.md` — folded the **fix-tradeoff** rule: a perf win can be net-negative (the favicon
    301→faviconV2 "fix" would 404 on faviconless domains → console-error spam), so flag the risk of the
    obvious fix, don't assume it's free.
  - *Process lesson:* validating a finding includes validating its FIX — the favicon optimization
    passed review as a clean idea but the gate (`extremetest`'s no-console-errors invariant) caught the
    404 regression, so it was reverted with a documented rationale. The gate is part of the loop for a
    reason; a "fix" isn't done until the whole gate is green.
- **2026-07-23 (cycle 2, round 4 — FIRST run with all 7 lenses; found 1 HIGH + 3 MEDIUM + LOWs, so
  still not converged — but the bug lens again found ZERO correctness bugs):**
  - **The new OSS-release lens paid for itself on run #1**, finding a HIGH the six app-lenses can't
    see: `SECURITY.md`/README/CONTRIBUTING claimed "all-local by default except HN + favicons", but
    `webContext` defaults `true`, so viewing At-a-glance calls Wikipedia by default (undisclosed).
    Fixed the docs to disclose both on-by-default enrichment calls (favicons + Wikipedia) and all
    three opt-in ones. Folded the technique into `oss-release.md`: cross-check each network-triggering
    pref's DEFAULT against the disclosure. It also caught a stale README "drawer" feature claim.
  - `bug-correctness.md` — the ranker-gate reached a SEVENTH surface (the Settings "Learned reranker"
    status line + Retrain message), found by the USABILITY lens, not the bug lens — because the bug
    lens only verified the feed gate-surfaces agree and treated the Settings COUNT display as
    out-of-scope. Folded: count/status DISPLAYS of a gated concept are surfaces too and must reflect
    the gate, not show a raw "Trained on N examples".
  - `uiux-stress.md` — the `min-w-0` class recurred on NON-dialog flex rows (a `flex-1` TagEditor
    input pushed "Add" off-screen at 320px+Large; a `flex-shrink:0` compact meta row). Broadened the
    fold from "dialog cards + grid" to "any flex/grid child without min-w-0", incl. input+button rows
    and pinned meta rows, and to scan Settings + the compact layout.
  - *Process lesson (again):* changing user-facing COPY breaks tests that assert on it — the Settings
    status-line reword broke the personalization-proof's "trained on N examples" regex; the gate caught
    it and both the code and the proof were updated together. Grep tests for asserted copy when you
    reword UI.
  - Deferred (documented, not regressions): affinity features lack leave-one-out at train time (train-
    serve skew is nil since candidates have no events; it only mildly inflates the proof's reported
    AUC); "Ask this discussion" lacks in-place Edit-prompt/Refresh (transparency asymmetry); At-a-glance
    Network/Mind-map connector-line opacity is <3:1 for pale hues on light themes (mitigated colored-
    graphic near-miss, like the treemap ai/policy labels); TopNav theme/layout `<select>` label
    truncation; optional THIRD_PARTY_NOTICES for Apache-2.0 deps.
- **2026-07-23 (cycle 2, round 5 — 7 lenses; found 2 MEDIUM + LOWs; bug lens again ZERO correctness
  bugs; AI/design/perf clean beyond LOW):**
  - The prompt PREDICTED the round's main bug: the c2r4 ranker-gate fix was INCOMPLETE — it made the
    Settings status line + Retrain message consult `rankerTrained` but NOT `useLearnedRanker`, so a
    trained-but-toggled-off model read "Active · personalizing". The bug-correctness prompt's "a
    surface can get ONE part right and miss the other … seed BOTH edges (… trained-but-toggle-off)"
    is exactly this trap, and the bug + usability lenses caught it. Now both surfaces apply the WHOLE
    gate. *Process lesson (README-level): a fix to a multi-part concept must handle EVERY part, and
    the regression must seed the part you didn't touch — my c2r4 weighthintstest status check only
    seeded toggle-ON, so it missed the toggle-OFF hole; it now seeds both.*
  - `uiux-stress.md` — folded the **long-unbreakable-token overflow class** (distinct from `min-w-0`):
    user-content text elements need `overflow-wrap:anywhere`; the discussion `<h1>` and the word-cloud
    term overflowed at 320px with a ~44-char snake_case title because they didn't reuse the feed's
    `.sc-title`/`.hn-html` guard. Fixed both; the tell is "same title wraps on the card, not on /item".
  - `oss-release.md` — folded the **gitignore-can't-untrack drift** check: the 4 `.opencode/skills/`
    files were committed before `.gitignore` listed `.opencode/`, so they still ship. Resolved by
    KEEPING them (AGENTS.md references them; leak-free like review/) via `.opencode/*` + `!.opencode/
    skills/`. The lens should cross-check `git ls-files` vs the ignore rules.
  - Deferred (documented): lazy-loading `SummaryActions` to keep the ~5 KB prompts chunk off the
    landing path (a real but minor perf win with a Suspense-boundary tradeoff on the AI controls).
- **2026-07-23 (cycle 2, round 6 — 7 lenses; nearly converged: bug + design + performance + OSS
  lenses ALL fully clean; usability clean beyond one by-design LOW; only 1 MEDIUM + minor LOWs):**
  - `uiux-stress.md` — folded the **SVG-viewBox-clip sub-case** of the long-token class: the
    At-a-glance Network view clipped long domain labels (`raw.githubusercontent.com`) past the fixed
    SVG viewBox with NO page scroll, so `scrollWidth` guards can't catch it — the mind map already
    truncated but the network view didn't. Fixed by truncating to fit + a `<title>` for the full
    value (overviewtest now asserts it). The TagEditor tag chip also got the long-token break.
  - Notable: the OSS lens returned a FULLY clean audit (secrets / lockfile registry / internal
    leakage / privacy-doc consistency / gitignore state all verified), and the bug lens found zero
    correctness bugs for the Nth round running — the remaining findings are display-truncation and
    can't-happen-in-prod defensive nits, i.e. the loop is at the edge of convergence.
  - Deferred (documented, not defects): author/username/reply-pill `break-words` (HN usernames are
    ≤15 chars, so the ~44-char overflow can't occur); `computeFeatures` NaN-guard (only for score/
    time values the real HN API never emits); the repeated cold-start interest chip (honest, by
    design); the warning-box literal-palette guard extension (no current failure).
- **2026-07-24 (cycle 3, round 1 — first round after removing the "At a glance" tab and adding the
  inline top-comment card preview; 7 lenses; found 1 HIGH + 5 MEDIUM + LOWs; bug lens again ZERO
  correctness bugs; OSS clean for public release apart from a dev-context posture decision):**
  - `performance.md` — folded **per-render data overhead of a default-on CARD feature**: measure
    BYTES-PER-RENDERED-ELEMENT (not just request count) and confirm the feature uses the cheapest
    sufficient data source. Rationale: the new inline top-comment (default ON) fetched the whole
    nested Algolia comment tree per card (~4.6 MB across a feed page, max 599 KB/card) to render ONE
    preview line; fixed to a bounded firebase item-pool fetch of `item.kids`.
  - `bug-correctness.md` — sharpened "test against REALISTIC data" with an **HTML-shape realism**
    sub-point: a `textContent`-flatten extraction helper drops block boundaries (`<p>a</p><p>b</p>`
    → "ab"; a trailing `<a>` fuses onto the next word), so a single-`<p>`, link-free fixture passes
    while real content mashes. Mock ≥2 blocks + a link and assert a space survives (read `textContent`,
    not `body.innerText`). Rationale: `stripHtml` word-mashing shipped green because `topcommenttest`'s
    fixtures were single-`<p>`.
  - `ai-ml.md` — added **grade the heuristic SELECTORS too, not just the LLM** (`pickTopComments`,
    `selectKeyComments`, the topic classifier): feed realistic comment mixes and judge the CHOICE — a
    good "best comment" selector caps raw length, weights ENGAGEMENT (replies) over length, demotes
    link-dumps, excludes dead/deleted. Rationale: the inline top-comment score was length-dominated, so
    a 600-char zero-reply wall beat a short, highly-replied insight.
  - `design-theme.md` — sharpened the accent-on-tint hunt: **`bg-accent/N` must be COMPOSITED over the
    element's actual surface before measuring** (a distinct, lower pair than accent-on-surface, which
    the guard already guarantees — so measuring accent vs pure surface hides it), it recurs in BATCHES,
    and the durable fix is to teach the guard `accent` vs `color-mix(accent 10–20%, surface)`. Rationale:
    `text-accent`-on-tint dipped sub-AA at once on the reply-collapse pill, the "N new" button, the
    story-card "why" chips, and the sidebar interest chips.
  - `usability.md` — added an **affordance-feedback sweep** (computed `cursor` + hover state): a
    framework/dep upgrade can silently drop a global affordance (Tailwind v4's preflight no longer
    resets `button { cursor: pointer }`), invisible to a DOM audit. Also **pruned the stale "At a
    glance" reference** now that the tab is removed.
  - `uiux-stress.md` — sharpened the long-token class with **enumerate EVERY user-content text node on
    a surface, not just the headline**: fixing one leaves siblings exposed. Rationale: after the
    discussion `<h1>` was guarded in a prior round, its SIBLING domain meta line on the same header
    still overflowed at 320px.
  - `oss-release.md` — folded the **dev-CONTEXT disclosure** class (a MAINTAINER DECISION, not a
    BLOCKER): a shipped meta-file (`AGENTS.md`, `review/*.md`) can be free of secrets/hostnames yet
    still reveal the private/internal multi-agent dev process — flag it for a ship / scrub / gitignore
    choice, distinct from a real internal-reference leak. Rationale: the OSS lens flagged exactly this.
  - *Process lesson:* folding must also **PRUNE references to removed features** (the "At a glance"
    mention in `usability.md`), not only add new classes — a base prompt that names a deleted feature
    sends the lens hunting a ghost. Rebuild each round's CURRENT STATE appendix from live code so the
    volatile feature list is never stale.
- **2026-07-24 (cycle 3 — UI/UX lens made SCREENSHOT-FIRST after a user-reported miss):** the user
  caught a **malformed control** (the new feed-header "Top comments" toggle switch rendered wrong) that
  c3r1's UI/UX lens did not find. Root of the miss: the lens was written **metric-first** — it hunted
  overflow/stacking/off-screen via `scrollWidth`/`getBoundingClientRect`/computed style, which are
  STRUCTURALLY BLIND to a control that is on-screen, correctly sized, and even AA-contrast yet renders
  malformed. The only lens that screenshotted controls (design) worked from a **fixed hand-list** that
  was stale (named the deleted "viz switcher") and never included the new switch. Fixes to the review
  system:
  - `uiux-stress.md` — **rewritten so its PRIMARY method is a screenshot-first visual review of EVERY
    surface and EVERY element**: visit every page/overlay, screenshot full views AND tight crops of
    each element cluster, and judge each control's rendered FORM + state by eye (a switch must look
    like a switch, etc.). Metrics are demoted to a SUPPLEMENT that quantifies what the eye flags. Added
    "malformed / broken-looking control" as the top defect class, and made **control enumeration
    DOM-driven at runtime** so new elements are auto-covered.
  - `design-theme.md` — its control-screenshot step is now **DOM-enumerated** (not a hand-list) and no
    longer names the deleted viz switcher (CORRECTION, c11: that prune was only partially applied at
    the time and was completed in c11); it explicitly checks a switch/segmented control renders
    correctly.
  - `_common.md` — corrected stale "six lenses" → seven and began removing the deleted "At a glance"
    from the
    product description.
  - *Lesson (README-level):* a lens that judges the UI **must LOOK at it** — a metric/DOM-only pass
    cannot see a visual-rendering defect, and ANY hand-maintained "controls to check" list goes stale
    the moment a control is added, so enumerate elements from the live DOM. This is now the core
    mandate of the UI/UX lens, not a footnote.
- **2026-07-24 (cycle 3, round 2 — full 7-lens round after the switch fix; near convergence: bug lens
  ZERO correctness bugs ≥MEDIUM, ranker efficacy CONFIRMED (held-out mean rank 8.0→3.0), OSS core-clean;
  1 design MEDIUM + LOWs + 1 OSS HIGH):**
  - The strengthened (screenshot-first) UI/UX lens's OWN fold paid off on re-verify: it INDEPENDENTLY
    confirmed the unified switch renders correctly across 12 designs×light/dark×ON/OFF, AND caught a new
    MEDIUM — the card **TL;DR** `<p>` lacked `break-words` (the exact "guard the siblings" class the fold
    had just added; the top-comment sibling was guarded, the TL;DR wasn't).
  - `design-theme.md` — folded a **THIRD guard blind spot: a control drawing the DECORATIVE
    `border-border` token instead of control-grade `border-edge`**. The guard verifies the `--edge`
    token EXISTS at ≥3:1 but not that controls USE it, so a fillless text field / `<select>` / bordered
    button with `border-border` fails WCAG 1.4.11 (58/62 combos in this round) while the guard stays
    green. Added the durable fix: a rendered-control-border test (now in `switchtest`, which walks every
    `input/select/textarea` + switch and asserts border ≥3:1 vs surface — 26 fields).
  - `bug-correctness.md` — folded **partial-failure resilience**: a `Promise.all` multi-source
    aggregation errors ENTIRELY on one source's failure; simulate a partial outage and expect graceful
    degradation (`allSettled`). Rationale: `getForYouCandidateIds` errored the whole feed if one of
    top/best/new 503'd.
  - `ai-ml.md` — sharpened the selector-grading fold with **sibling drift**: when one selector is
    hardened (`pickTopComments`), grep + grade its siblings (`selectKeyComments`) on the SAME hostile
    set; factor the shared predicate into ONE util. Rationale: the length-dominated scoring + link-dump
    hole persisted in `selectKeyComments` after `pickTopComments` was fixed.
  - `uiux-stress.md` — folded **`line-clamp`/`overflow:hidden` MASKS overflow**, so the UNCLAMPED
    full-text sibling is the real risk (the clamped top-comment preview was safe; the unclamped card
    TL;DR overflowed +501px). A clamped fixture hides the bug — the test must render the full-text node.
  - `oss-release.md` — folded **UNTRACKED-file-imported-by-tracked → broken public build** (a HIGH,
    inverse of the ignore-drift): a `git commit -a` stages tracked mods but not new untracked files, so
    a committed file importing an untracked module breaks `tsc`/build/deploy. Detect via `git status`
    untracked `src/`/`scripts/` cross-referenced against imports.
  - *Process lesson:* a guard that checks a TOKEN exists (`--edge` ≥3:1) is NOT the same as one that
    checks controls USE it — the durable guard must render the real controls and measure. And the
    "guard the siblings" fold caught its own next instance (TL;DR) on the very next run, validating the
    per-round folding loop.
- **2026-07-24 (cycle 3, round 3 — convergence-check round; NEAR-clean: bug lens ZERO correctness bugs,
  design confirms the `border-border` fix HELD (third blind spot now clean), usability + performance
  clean beyond documented LOWs; found 1 AI MEDIUM, now fixed):**
  - The AI lens's "run + MEASURE" mandate paid off again: it re-confirmed ranker efficacy (a planted
    on-taste item moved #10→#1 past distractors 28–40× more popular) AND found a real MEDIUM the
    label-matrix audit alone would miss — the **content PROFILE's liked set (`getEngagedItemIds`) was
    NOT dwell-aware while the training LABELS were**, so a bounced article's terms leaked into the LIKED
    centroid/term-profile and ranked its topic UP, contradicting the negative label.
  - `ai-ml.md` — folded **"the content profile must use the SAME dwell-aware engaged set as the
    labels"** (measure `getEngagedItemIds` == the label positive set; a bounce/glance in NEITHER). Fix:
    extracted ONE shared `classifyEngagement` (interactions.ts) feeding BOTH `buildTrainingSamples` AND
    `buildContentProfile` — output-preserving (the personalization proof + `trainlabeltest`'s new
    engaged-set assertion guard it). This is the labels-vs-features instance of the general
    "two parallel derivations of one concept must AGREE" rule.
  - The OSS lens re-flagged the commit-hygiene HIGH (untracked new files + unstaged overview deletions
    must commit atomically) — a WORKING-TREE state handled at commit time; `docs/competitive-analysis.md`
    was gitignored per the maintainer's decision.
  - *Convergence:* c3r3 surfaced 1 MEDIUM (now fixed), so it was not yet a fully-clean round — c3r4
    would confirm convergence (all else was LOW / documented-accepted).
- **2026-07-24 (cycle 3, round 4 — the convergence-CONFIRM round instead dug deeper and found 1 HIGH +
  1 MEDIUM, both now fixed; design + AI + performance clean beyond documented LOWs, and AI re-confirmed
  the c3r3 content-profile fix byte-identical):**
  - The bug lens's first HIGH of the cycle: the discussion **in-thread search "In thread" jump was
    broken** — a `useDeferredValue` race where the flat search results share `id="comment-N"` with the
    thread, so clearing the (deferred) query then rAF-scrolling landed on the stale search card (target
    off-screen, 0/5). Fix: defer the scroll to an effect keyed on `searching` (runs after the search
    view unmounts). Folded into `bug-correctness.md` as the **deferred-state / duplicate-DOM-id race**
    class (drive such jump/scroll paths REPEATEDLY — they land 0/5 or 2/3, so single-shot passes hide
    them — and assert the target is actually IN VIEW, not just that the handler ran).
  - The usability lens found a **MEDIUM: Undo of "Not interested" didn't fully reverse** — `unhideItem`
    fired an `unhide` event with no `SIGNAL_WEIGHT` entry and no domain/author, so the hide's −2.5
    affinity survived and buried the un-hidden story (~#22, not #1). Fix: `unhide: +2.5` (net zero,
    excluded from the engaged-count) + `unhideItem` now carries domain/author. Folded into
    `usability.md` as **"Undo must FULLY reverse"** (reverse the affinity/training side-effect, not just
    the visible row — test the item returns to its ORIGINAL position).
  - New guards: `commenttest` now asserts a SHALLOW "In thread" jump exits search AND scrolls the
    comment into view (short viewport forces the target below the fold); `feedstabilitytest` asserts
    hide+unhide nets ~0 affinity (and a hide-only stays negative). Gate green 48/0/0.
  - *Process lesson:* a "confirm-convergence" round is NOT a formality — fresh lenses probing untested
    paths (the shallow-jump SCROLL case, the Undo affinity side-effect) still surface real HIGH/MEDIUM
    bugs. Convergence means a round finds NOTHING new, which takes as many rounds as it takes.
- **2026-07-24 (cycle 3, round 5 — the SECOND convergence-confirm round again found 1 MEDIUM (the c3r4
  Undo fix was INCOMPLETE) + LOWs, all now fixed; bug + AI + performance + OSS clean beyond documented
  LOWs; ranker efficacy + content-profile==labels re-confirmed):**
  - The MEDIUM (found by BOTH the bug and usability lenses independently): the c3r4 Undo-of-"Not
    interested" fix reversed only ONE of the action's THREE derivations. It cancelled the affinity SUM,
    but `classifyEngagement` had no `unhide` case (a read→hid→un-hid story stayed a training NEGATIVE)
    and `getDislikedItemIds` ignored `unhide` (it stayed in the disliked-CONTENT profile) — so the
    un-hidden story was still demoted by two learning signals. Fixed both (unhide clears the hidden
    state in the shared classifier; the disliked set is now newest-hide/unhide-decides).
  - `bug-correctness.md` — folded **"a reversal event must be honored by EVERY derivation of the event
    it reverses"**: an append-only action (`hide`) feeds several independent derivations (affinity sum,
    training label, disliked-content set) and its UNDO must neutralize ALL of them; grep every reader of
    the original event type and confirm each handles the reversal symmetrically. This is the
    event-derivation instance of the multi-surface-gate recurrence (a partial fix recurs the next round).
  - `usability.md` — sharpened **"Undo must FULLY reverse"** so "FULLY" explicitly means EVERY learning
    derivation (affinity + training label + content profile), not just the affinity — the exact
    incompleteness this round exposed.
  - `bug-correctness.md` — sharpened the **HTML-shape realism** sub-point: the block-separator is a
    tag-ENUMERATED list, so it can be INCOMPLETE — `<pre>` code blocks mashed one round AFTER `<p>` was
    fixed. Mock EACH block type the app renders (`<pre>`, `<blockquote>`, `<li>`, heading), not just
    `<p>`+`<a>`. (`topcommenttest` now includes a `<pre>` fixture asserting the space survives.)
  - `design-theme.md` — folded a **FOURTH border-guard facet: a TINTED palette border on a control**
    (`border-accent/40`, `border-red-500/40`) — the rendered-control-border guard walked only
    input/select/textarea, so bordered BUTTONS with a semi-transparent tinted border went unmeasured;
    the guard must walk bordered `<button>`s and composite the tint over the surface before measuring.
  - `ai-ml.md` — sharpened the sibling-selector fold: sharing a predicate ≠ agreeing — sibling scorers
    can still diverge in scoring CONSTANTS (sometimes legitimately), and a stale "mirrors X" comment
    over divergent constants is a real (LOW) find. Grade each sibling on its own job; verify parity
    comments match code.
  - New guards: `feedstabilitytest` now asserts hide+unhide removes the story from the disliked-CONTENT
    profile (and a hide-only stays disliked); `trainlabeltest` asserts a read→hid→un-hid story is a
    training POSITIVE again and is back in the content-profile engaged set; `topcommenttest` gained the
    `<pre>` block-boundary fixture.
  - Deferred (documented, not defects): the tinted-border buttons themselves (labels carry the
    affordance) pending the guard extension; top-comments preview absent on Search (hitToItem omits
    kids); redundant Settings→Data hidden-story controls; mobile 390px hides the sidebar; RankExplain
    bars collapse ≤320px (info redundant with the numbers); the "Inside the learned model" bars omit
    the logistic intercept.
  - *Convergence:* c3r5 surfaced 1 MEDIUM (now fixed), so still not a fully-clean round — c3r6 is the
    next convergence-confirm round. Two straight "confirm" rounds each found a real defect on an
    untested path, reinforcing that convergence is reached only when a round finds NOTHING new.
- **2026-07-24 (cycle 3, round 6 — the THIRD straight "confirm" round again dug up 4 MEDIUMs, all now
  fixed; design/perf/uiux/OSS clean beyond documented LOWs; ranker efficacy + all prior fixes
  re-confirmed by the AI + bug lenses):**
  - Two of the four MEDIUMs were the SAME shared-organ (`html.ts`) the c3r5 `<pre>` fix touched, but a
    DEEPER defect the c3r5 fixture couldn't see: (M1) the block separator was APPEND-only, so the
    leading-bare-text → first-block boundary that EVERY real HN comment has (the first paragraph isn't
    wrapped in `<p>`) mashed (`…access.Least…`); (M2) `ThreadGist.clean` did `stripHtml().split('\n')`,
    but stripHtml COLLAPSES newlines, so the split was a no-op and a leading `>` (quote-then-respond,
    the most common HN reply) dropped the WHOLE comment from the "most-discussed" gist. Fixed both:
    both-sides `insertAdjacentText` + container tags in `stripHtml`/`htmlToText`; `ThreadGist` uses
    `htmlToText` (M2 depends on M1's leading-boundary fix).
  - `bug-correctness.md` — extended the HTML-shape-realism fold twice: (a) the fixture must match the
    real DOCUMENT SHAPE (start with a BARE text node abutting the first block), because an append-only
    separator only fixes the trailing side; (b) a shared text helper has a WHITESPACE CONTRACT
    (stripHtml collapses vs htmlToText preserves newlines) — audit every consumer's assumption against
    the helper it calls when touching the organ.
  - (M3) The usability lens caught that the c4/c5 Undo fix was STILL incomplete at the WIRING layer:
    the affinity/label/disliked DATA reversed, but `unhide` wasn't in `ENGAGEMENT_TYPES`, so Undo never
    fired `onEngagement` → the feed kept the stale un-cancelled −2.5 and the story reappeared BURIED
    until a manual Refresh. Fixed by adding `unhide` to `ENGAGEMENT_TYPES`. Folded into `usability.md`
    + `bug-correctness.md`: "a derivation includes the LIVE-UPDATE WIRING, not just stored data — test
    the reversal takes effect WITHOUT a reload."
  - (M4) The AI lens (running + measuring) found the THIRD derivation of engagement — behavioural
    AFFINITY (`computeAffinities`) — was never made dwell-aware (c3r3 unified only labels + content
    profile), so a bounce-only domain accrued +affinity, ranked UP, and hit the dishonest "You often
    read X". Fixed by gating the OPEN credit on the shared `classifyEngagement`. Folded into `ai-ml.md`:
    the engagement concept has (≥)THREE derivations — GREP + MEASURE every one, don't stop at the two
    you already unified.
  - New guards: `topcommenttest` fixture rebuilt to the realistic BARE-leading shape + a `<ul>` boundary
    + an empty-content high-reply comment (guards the leading-boundary fix AND the blank-preview drop);
    `gisttest` seeds a most-replied quote-then-respond comment (guards M2); `personalizeliveupdatetest`
    asserts an unhide fires onEngagement (M3); `feedstabilitytest` asserts a bounce-only domain gets ≤0
    affinity + 0 engaged-count (M4). Also fixed 2 cheap LOWs: `pickTopComments` requires stripped-
    non-empty text (AI LOW — no blank preview line); red delete labels red-700/300 → red-800/200 on
    surface-2 (design LOW-2, AA).
  - *Meta-lesson (folded implicitly):* THREE consecutive "confirm-convergence" rounds each found real
    MEDIUMs, and TWO of this round's were deeper defects in an organ a PRIOR round had already "fixed" —
    a fix that greens a narrow fixture is not a fix of the CLASS. Convergence is earned only when a
    round genuinely finds nothing, and each fix must be guarded by a fixture that mirrors REAL data
    shape/flow, not the minimal case that makes the assertion pass.
  - Deferred (documented, not defects): the tinted-BORDER control class (design LOW-1, labels carry the
    affordance) — the durable fix is a guard extension that walks bordered `<button>`s + composites
    tinted `border-<palette>/N` over the surface (top guard rec, recurring 4+ rounds); the `<mark>`
    highlight fg-on-accent/42 near-miss (design LOW-3); the Why#N value-column clip at 320px+Large
    (uiux LOW-1); the Personalize ⋯ menu resize-clamp (uiux LOW-2); the memItems LRU cap + top-comments
    fetch multiplier (perf LOWs, mitigated); the HiddenDialog pruned-item residual affinity + the
    5000/3000 event-window skew (bug LOWs, edge cases); the contrastive term-profile liked/disliked
    asymmetry (AI LOW, defensible); the commit-hygiene HIGH (working-tree state, handled atomically at
    commit time) + the dev-context disclosure (accepted). c3r7 is the next convergence-confirm round.
- **2026-07-24 (cycle 3, round 7 — a CLEANER round (bug found only c6-fallout; AI 1 LOW; usability/
  perf/OSS LOW-only) but still 4 MEDIUMs, TWO of them fallout from c6's OWN fixes; all fixed + guarded):**
  - The headline: the independent loop caught that TWO of c6's fixes were incomplete. (M1) adding the
    shared `classifyEngagement` to `computeAffinities` REINTRODUCED drift — `computeAffinities` feeds
    events NEWEST-first while the classifier's hide/unhide reduction was order-DEPENDENT, so a
    read→hid→un-hid item was under-credited in affinity ONLY. (M2) c6's ThreadGist quote-drop fix left
    the IDENTICAL `stripHtml().split('\n')` bug in `llm.ts`'s sibling `cleanComment`, dropping
    quote-then-respond comments from every AI summary. Fixed (order-independent classifier via latest-ts
    comparison; `cleanComment`→`htmlToText`). Plus the design tinted-button-border MEDIUM (escalated
    from c6 LOW) and a uiux RankExplain a11y MEDIUM.
  - `bug-correctness.md` — folded (a) a shared helper with ORDER-DEPENDENT logic must be order-
    INDEPENDENT or every caller's input order verified (unifying via one helper can REINTRODUCE drift
    if a caller slices events differently); (b) when you FIX one consumer of a shared anti-pattern,
    grep + fix EVERY sibling in the SAME change (the c6 "audit consumers" fold existed but wasn't
    applied at fix-time); (c) a per-type DELETE must cover EVERY kv prefix a feature writes (bug LOW-1:
    "Delete AI summaries" left `usersum:`, article delete left `aterms:`).
  - `design-theme.md` — the tinted-button-border blind spot is now GUARDED (`switchtest` walks bordered
    `<button>`s + composites `/N` borders; 5 controls → `border-edge`); repointed the fold at NEW/
    uncovered bordered controls.
  - `uiux-stress.md` — folded the FIXED-REM-column collapse class (fixed rem side columns starve a
    `flex-1` middle to 0px + overflow under Large text; RankExplain bars vanished ≤360+lg) + a guard-
    authoring caveat (measure the SCROLL CONTAINER's overflow, not every descendant — a `truncate`d
    child self-reports overflow and false-positives).
  - New guards: `feedstabilitytest` (open→hide→UNDO restores affinity byte-identical — order-
    independence); `gisttest` (llm `collectComments` keeps the quote-then-respond comment); `switchtest`
    (bordered-button + composited-tint border walk); `mobiletest` (Why#N bars non-zero + modal
    no-overflow at 320+Large, `setTextSize` via the ACTION + scroll-container measurement);
    `datamgmttest` (deleting summaries removes `usersum:`, article removes `aterms:`, cache removes
    `topc:`/`cterms:`).
  - *Process lesson (README-level):* a fold is only worth its ink if APPLIED AT FIX TIME. c6 had
    ALREADY folded "audit every consumer of a shared organ" and "reversal honored by every derivation,"
    yet c6's own fixes violated both (a missed sibling; an order-contract mismatch) — caught only by
    c7's independent lenses. When fixing, re-read the relevant base-prompt classes and apply them
    proactively (grep siblings; check the input-order contract of any shared helper you add a caller
    to). Also: a guard's METRIC can itself be wrong — my first M4 guard counted a `truncate`d label's
    self-clip as overflow (false-positive) and had to be corrected to measure the scroll container;
    validate a new guard against BOTH the pre-fix (must fail) and post-fix (must pass) state.
  - Deferred (documented, not defects): the "Article" affordance-consistency cluster (usability LOW-1
    dual "Article" labels + bug LOW-2 meta-link records no read + usability card-TL;DR-undiscoverable +
    non-tappable HN stat cards) — worth a focused pass; AI LOW (contrastive term-profile asymmetry,
    defensible); design LOWs (accepted micro-badges, rank bars, `<mark>`); perf LOWs (top-comments
    MAX_KIDS 5:1, memItems LRU, For-You N+1 — mitigated); HiddenDialog pruned-item residual affinity +
    5000/3000 event-window skew (bug LOWs, edge); commit-hygiene HIGH (at commit time) + dev-context
    disclosure (accepted).
   - *Convergence:* c7 fixed 4 MEDIUMs → not clean; c8 is the next confirm round. Encouraging signal —
     the remaining MEDIUMs were self-inflicted c6 regressions (not fresh latent defects) + one escalated
     LOW + one a11y-intersection; usability/perf/OSS were LOW-only. Once fix-time discipline holds,
     convergence is near.
- **2026-07-24 (cycle 3, round 8 — the LENSES CONVERGED (first fully-clean round: bug 0 defects, AI 0
  defects, all others LOW-only), but a HUMAN eyeballing the real UI caught a transparency defect 8
  rounds of independent lenses missed — fixed + folded):**
  - **The review round itself was CLEAN:** the bug lens found 0 correctness defects (re-verified every
    c5–c7 fix); the AI lens found 0 defects and re-measured ranker efficacy (learned beats popularity,
    held-out mean rank 13→3.6) with all three engagement derivations agreeing / dwell-aware / order-
    independent; usability/design/uiux/perf reported only LOWs; OSS only the standing commit-hygiene
    HIGH (working-tree, handled at commit time) + accepted dev-context disclosure. No new
    blocker/high/medium — the convergence criterion was met by the loop.
  - **The headline defect came from the USER, not a lens.** Looking at a real "Why #N?" dialog on a
    trained model, they saw it show "Learned model −0.83" in *How the score adds up* while *Inside the
    learned model* showed mostly POSITIVE feature bars — a self-contradiction. Root cause (two traps at
    once): (a) an **omitted intercept** — the panel rendered per-feature `w·x` (positive) but hid the
    strongly-negative BIAS (`P = sigmoid(bias + Σ w·x)`, bias ≈ −4 for a ~9% engager), so the pieces
    couldn't be reconciled; (b) a **signal centered at the absolute midpoint** — `learnedPull =
    (P − 0.5)·k` reads negative for almost every story when you engage with a small minority, so a story
    the model actually likes *relative to your norm* still showed a confusing negative. Crucially the old
    "explanation matches the real contribution math" check PASSED (each bar WAS exactly feature×weight) —
    the numbers were individually exact, they just didn't RECONCILE for a human reader.
  - Fix (the user chose "re-center the sign at your base rate"): `learnedBaseRate(model)` = clamp(pos/n,
    .03–.95); `blend()` takes a `baseRate` param and computes `learnedPull = (learned − baseRate)·2`
    (a constant per-model shift, so **ranking is unchanged**); `explainItem` prepends an explicit
    "Baseline (you rarely engage)" bar = the model bias, so features + baseline now sum to the logit that
    yields the shown P; RankExplainDialog copy explains the base rate ("you engage with only ~N% of
    stories") and hides the "(w×v)" formula on the baseline row. Visually verified on a real model:
    "Learned model +0.03" (not −0.83), a prominent "Baseline: −4.20" bar beside the positive features.
  - `ai-ml.md` — folded the class: **the explainer's PARTS must RECONCILE and displayed SIGNS must be
    meaningful** — it is not enough that each number is individually exact; show the intercept as its own
    bar so the sub-parts add up, and center a displayed pull on the base rate (not the absolute midpoint)
    so its sign matches "vs my typical story." Grade by opening the explainer on a real trained model and
    asking "do the pieces add up, and does the sign mean what a human reads it to mean?"
  - Bundled cheap LOWs (all guarded): follow-USER from the Personalize ⋯ menu now offers Undo like the
    other three actions (`cardteachtest`); the `media` + non-first `feature` layouts hid their duplicate
    `.sc-rank` so a For-You card shows ONE rank number (`layouttest`); the in-thread-search "N matches"
    line wraps (`overflow-wrap:anywhere`); OP/"new"/followed-chip badges use `text-fg` (keep the
    tint/star as the accent cue) instead of `text-accent`.
  - New/extended guards: `personalization-proof` byHand recompute now uses `learnedBaseRate` +
    `(P − baseRate)·2` (proves the re-center is ranking-identical — byHand == scoreItem to 1e-9);
    `personalizeliveupdatetest` seeds a real-bias model and asserts the "Baseline" bar + "~N%" copy +
    `learnedBaseRate == pos/n`; `cardteachtest` (follow-author Undo); `layouttest` (media/feature single
    rank).
  - *Meta-lesson (the important one):* EIGHT rounds of exhaustive independent agent lenses converged to
    "clean," yet a human glancing at the actual rendered dialog immediately caught a real transparency
    defect — because the lens checked "does each number equal the math" (true) rather than "do the parts
    reconcile and do the signs mean what a reader thinks" (false). Automated/agent review that verifies
    named properties can be individually exact and collectively misleading; a SCREENSHOT-FIRST human (or
    lens) pass that reads the whole panel as a user is not redundant with the math check. The AI lens is
    now told to grade reconciliation + sign-meaning on a real model, not just per-number exactness.
  - Deferred (documented, not defects): design LOWs (rank-explain bars hardcoded green/red <3:1 on light
    themes but redundant with the signed value; `--up` unguarded; `<mark>` fg-on-accent near-miss;
    accent/10 hover) + the guard-coverage recs (teach `themecontrasttest` to compute `--up` vs surfaces /
    accent-on-tint / rank-bar fills / `<mark>`; extend `switchtest` to `/item` controls + full theme
    matrix); perf LOWs (useFeed whole-store subscribe; itemsQ sliceCount key; memItems no LRU); usability
    NTHs (card TL;DR undiscoverable when AI off; HN quote lines not styled as blockquotes) + the standing
    "Article" affordance cluster; commit-hygiene HIGH (at commit time) + dev-context disclosure (accepted).
  - *Convergence:* the LENSES reached a fully-clean round at c8 (first time), but the post-review changes
    (the user transparency fix + bundled LOWs) mean c9 is the next confirm round — a real change round is
    never its own confirmation. The signal is strong: the loop found no latent defects; the one real find
    came from a human reading the UI, and its fix is now guarded + folded so the lens catches the class.
- **2026-07-24 (cycle 3, round 9 — PROCESS CHANGE + the detector proof that justified it: a developer
  report is now treated as evidence a LENS IS BLIND, never as a work order. Proving the upgraded lens on
  the pre-fix state immediately surfaced 1 HIGH + 2 MEDIUM the c8 hand-fix had missed):**
  - **The rule (AGENTS.md golden rule #8 + the "When the DEVELOPER reports a defect" section above).**
    c8's transparency defect was hand-fixed directly — wrong three ways: the primary agent is biased, a
    patch carries no independent signal, and it repairs the reported INSTANCE while the CLASS stays
    invisible to every future round. The required sequence is now: name the CLASS → identify which lens
    should have caught it and why it didn't → upgrade that brief to catch the KIND → **PROVE the detector
    against the PRE-FIX state** → only then fix, on the lens's signal → re-run the loop.
  - **The brief upgrade.** c8's fold was a SPOILER (it described the exact defect and its fix), so a lens
    would only have re-confirmed the patch. Rewritten as two class-level invariants + a grading
    procedure, with no mention of the surface: **(R) RECONCILIATION** — enumerate every term in the
    composing formula, verify each is shown or provably zero, then recompute the whole from ONLY what is
    displayed; **(S) REFERENCE POINT** — every displayed signed quantity needs a defensible zero, checked
    against the actual distribution — plus "grade in a REALISTIC regime" (a minority engager), because a
    balanced fixture hides the whole class.
  - **The proof (rule #8 step 4), run honestly.** A scratch copy of the tree with the fix reverted, served
    on its own port (5199, never the developer's 5173), spoiler-stripped (`review/` removed, rule #8
    removed from its `AGENTS.md`). First attempt was NOT faithful — the revert left the *new* tooltip in
    place, which contradicted the old math and handed the lens a hint; the sandbox was rebuilt to the true
    pre-fix text and the run redone. On that faithful state the lens **independently rediscovered both
    invariants**, tagging them with the brief's own labels: *(R) "the intercept is computed and then never
    displayed"*, *(S) "a red, negative drag on every card, including the #1 card"* — unaided, "reproduced
    end-to-end in the running UI, not inferred from source." Detector proven.
  - **What the proof caught that the hand-fix never would have — HIGH: the learned reranker was INERT in
    the feed.** The blend consumed the Platt-CALIBRATED PROBABILITY as though it were a symmetric ±1
    signal. Platt anchors P at the user's base rate, so for a minority engager a good and a mediocre story
    both sit in the sigmoid's flat tail: measured on real code, a model that separated two groups **7:1 in
    odds** (P .129 vs .019, from a genuine termAffinity of 0.404) produced a learned-term differential of
    only **0.22**, while popularity/discussion each swing a full 0..1. Result: For You opened with five
    sports stories the user had **never once clicked**, above every story on the only topic they read —
    and NO slider setting could fix it (unreachable even at the 2.5 max). Critically, **c8's re-centering
    could not have helped**: it subtracts a different constant, so the SPREAD is identical — the hand-fix
    made the sign honest while leaving the signal impotent. Fixed with `learnedSignal()`: a **log-odds**
    margin (linear in `w·x`, so calibration can't crush it), `tanh`-bounded to ±1 (commensurate with the
    other signals) and centered on the base rate (so c8's honest sign is preserved), monotone in P so it
    can never reorder against the model. Measured after: differential **0.22 → 0.605**, and the user's
    taste becomes reachable (`learned=1.5` and the 2.5 max now both surface it; default still lets a
    450-point story beat a 25-point one, which is correct).
  - **Two more from the same proof, both validated against main before fixing.** (a) **TRAIN/SERVE SKEW:**
    serving folded each candidate's cached article body into `termAffinity`, training did not — the model
    fitted a weight against a title-only distribution and applied it to a title+article one (measured:
    training feature 0.0 vs serving 0.82 for the same item), silently mis-scaling the feature and the
    P(engage) the explainer prints, for exactly the stories the reader proxy had fetched. Fixed by passing
    `articleTerms` from the same pref (cache-only, so training still does no network I/O). (b) **REVISIT
    AFFINITY INFLATION:** the dwell-aware guard was per-ITEM while the credit was per-EVENT, so once a
    story qualified, every later open was credited +1 against a −0.6 bounce — **+0.4 per re-click**.
    Re-opening a story from the Read tab and bailing (the commonest "I've read this" gesture) made its
    domain look MORE liked; measured 3.33 → 5.33 over five cycles. Fixed so a revisit is exactly neutral
    (credit the earliest open once — by timestamp, so it stays order-independent — and ignore a revisit
    bounce), while a genuine RE-READ still counts.
  - New guards, each validated **pre-fix-FAILS / post-fix-PASSES**: `rankergatetest` (base-rate zero,
    7:1 margin survives ≥0.5, bounded ±1, monotone — and degrades to a clean failure instead of crashing
    on a build without the helper); `articlerankingtest` (training folds the article body when the proxy
    is ON, ignores it when OFF — drives the real `buildTrainingSamples`); `feedstabilitytest` (revisit
    doesn't inflate domain OR author affinity, doesn't deflate it either, is order-independent, counts the
    story once, and a genuine re-read still adds). `personalization-proof`'s independent hand-recompute
    was updated to the log-odds form and still matches `scoreItem` exactly.
  - Folded: `ai-ml.md` — "test the DISCOVERY case, and measure the model's opinion SEPARATELY from its
    effect on the feed" (no shared domain/author so only content can carry the taste; a MODERATE overlap,
    since a saturating transform passes an overwhelming signal and fails the realistic one; report the
    model's margin AND the term's spread vs the competing signals; sweep the weight to its documented max
    — "correct model, unreachable through the UI" is a defect). `bug-correctness.md` — the **granularity**
    class (a rule enforced per-ENTITY but applied per-EVENT leaves the hole open; drive the same entity
    repeatedly and assert the derived value converges rather than accumulating) and **TRAIN/SERVE PARITY**
    (diff every feature-construction call site's options; compare the same item's vector through both
    paths). `usability.md` — read a whole panel as a user and check the sub-sections RECONCILE.
  - *Meta-lesson:* the c8 entry below congratulated the loop for converging while a HIGH sat undetected in
    the ranking core. What surfaced it was not more review effort but **making the detector honest and
    then testing the detector itself** — and the first attempt at that test was compromised by a hint the
    fix had left behind, which is exactly why step 4 demands a faithful pre-fix reproduction. A hand-fix
    to a developer report is worse than it looks: it can be *correct as far as it goes* (c8's sign fix was
    right) and still leave the substantive defect (an impotent signal) in place, because nothing
    independent ever examined the area.
  - Deferred: `RankExplanation.learned.bias` is now a dead field (the baseline TERM carries it) — a LOW,
    left in place as harness-visible data. Prior LOWs carried forward unchanged.
- **2026-07-24 (cycle 3, round 10 — the FIRST round run under golden rule #8, and the first with all
  seven lenses on the newest model: 4 HIGH + ~14 MEDIUM, the richest round of the cycle. Several
  findings were fallout from c9's own fixes, which is exactly what the rule predicts):**
  - *Process note:* every lens ran on `claude-opus-5` (the shared config had been defaulting spawned
    sessions to the previous Opus while the primary session ran the newer one — a silent capability
    gap across every prior round). Each report now states its model on line 1.
  - **HIGH (bug) — a cache key encoded a COUNT, not the content.** `itemsQ` was keyed
    `['items', kind, sliceCount]`, so any id-list change that didn't alter the sliced LENGTH was
    invisible: re-reading a story didn't reorder the Read tab, and with ≥25 items of history a
    brand-new read was MISSING entirely while the sidebar beside it listed it correctly. No in-place
    recovery (`refetchOnWindowFocus` is off). Keyed on the ids. The existing guard only asserted
    across a RELOAD, which is why it never saw the surface the user looks at.
  - **HIGH (perf) — `memo(StoryCard)` never bailed out.** `useHiddenIds`/`useSavedIds`/`useSeenMap`
    returned a fresh `Set`/`Map` every render, so `useFeed`'s `cards` memo re-derived every card and
    the feed's 30s tick re-rendered the whole list: measured 1.5–4.6s of main-thread lockup at 4×
    throttle on a 75-card list while the user was idle. Memoized on `[rows]`.
  - **HIGH (design) — a theme TREATMENT erased a guarded token.** `bento`'s tile rule targeted the
    `.bg-surface` utility, which is also the fill of the shared control recipe, stripping the
    `--edge` border from ~26 controls (1.00:1, both modes) — invisible AS controls even focused,
    because the un-layered theme block beats `@layer utilities`. Scoped the treatment away from
    controls. A token-level audit is structurally blind to this; only rendered pixels show it.
  - **HIGH (uiux) — a fixed overlay in the tap layer.** The scroll-to-top FAB was topmost over real
    controls in 5 of 14 layouts and over comment authors/collapse chevrons on `/item`; a tap 1000px
    into a thread threw the reader to the top with no undo. This was c8's own "fix" (it had been
    moved bottom-LEFT to stop it eating right-aligned Settings buttons) — treating the SIDE as the
    problem just relocated the collision. Root fix: no overlay in the phone tap layer at all; phones
    get the action from the sticky TopNav, desktop keeps the FAB in its empty gutter.
  - **Fallout from c9's fixes, caught by the lenses (the rule working as designed).** (a) The baseline
    copy I added hardcoded "you rarely engage"/"only ~N%", which for an avid reader rendered "you
    rarely engage (you engage with only ~90% of stories)" — the trust surface contradicting itself;
    the label and clause are now derived from the actual rate. (b) That same panel promised "the
    baseline + the feature bars below sum to that estimate" while rendering only the top 8 of up to
    11 bars — the (R) invariant broken by my own copy; it now renders all of them. (c) The log-odds
    signal was centered on the TRAINING positive-rate, but the weights are dominated by
    domain/author affinity (~0 for unfamiliar sources), so candidates systematically undershoot it:
    measured 0/20 positive, a story the model knew nothing about printing −0.675 of a nominal −1,
    while the tooltip promised "a typical story reads ~0". Now centered on the ranked POOL's median
    (`withPoolCenter`), giving 10/20 positive with the ORDER provably unchanged — and the feed passes
    the SAME context to `explainItem`, or the explanation would be centered differently from the
    score it explains.
  - **The rest, all validated against the code before fixing:** the `compact` layout amputated the
    whole action row + the rank explainer (and `terminal`/`cyberpunk` DEFAULT to it, so users who
    picked a colour scheme silently lost every card action) → progressive disclosure on pointer
    devices, always visible on touch; the "Top comments" switch was a visible, enabled, ON no-op
    there; Search reported Algolia's UNFILTERED `nbHits` above "No results." with no route out →
    filter-aware count + an empty state that names the real cause; the cold-start banner pointed at
    a ⋯ menu that isn't rendered in every layout; both TopNav `<select>`s drew the chevron ON TOP of
    the label in the DEFAULT state (25/31 and 15/15 labels colliding); dialogs declared `aria-modal`
    but implemented neither scroll lock nor focus containment (seven hand-rolled dialogs, no shared
    primitive) → one `useModalBehavior` hook, gated so a mounted-but-closed dialog can't lock the
    page; the text-extraction separator list had `table`/`tr`/`dl` but not `td`/`th`/`dt`/`dd`, fusing
    real article tables into junk that also poisons ranking terms and LLM input; `computeAffinities`
    read only the last 3000 events while its three siblings read the whole log (the log is already
    capped at 10000) — slice-level drift that could invert a downvoted story's sign; bulk "Unhide
    all" / Data-delete cleared the table without the `unhide` EVENTS, so stories came back BURIED
    with the learned downvote intact; and the card's top-comment preview kept HN quote lines, so it
    attributed the QUOTED claim — often the opposite of the commenter's position — to the person
    rebutting it (the two sibling selectors already filtered quotes; the visible, default-on one
    didn't, so all three now share one `commentToText`).
  - New/extended guards, each validated **pre-fix-FAILS / post-fix-PASSES**: `readtest` (an
    in-session read appears live, agrees with `getReadItemIds`, doesn't contradict the sidebar);
    `a11ytest` (scroll lock + 20-real-Tab focus containment + the mounted-but-closed case);
    `switchtest` (no interactive control has a transparent border in `bento` light/dark);
    `layouttest` (compact still renders the action row + explainer; visible outright on touch);
    `topcommenttest` (quote dropped, rebuttal kept, selector agrees with the shared cleaner);
    `rankergatetest` (the learned signal is two-sided across the pool; re-centering leaves order
    unchanged); `personalizeliveupdatetest` (the rate is disclosed, and "rarely" only appears when
    the rate really is low).
  - Folded: `uiux-stress.md` — fixed overlays live in the tap layer (hit-test every layout; no side
    is safe), `aria-modal` declares what the browser doesn't implement, native `<select>` chevrons
    overlap clamped labels. `design-theme.md` — a theme TREATMENT can override a guarded token
    (measure composited pixels, not token values), and `opacity-N` destroys a contrast guarantee.
    `bug-correctness.md` — a cache key that encodes a SHAPE instead of CONTENT serves stale data,
    and an ENUMERATED list is a defect generator (check every LEVEL of each family, not just the
    container). `ai-ml.md` — a reference point must summarise the distribution actually being
    DISPLAYED, and every surface derived from a score must use the same one. `usability.md` — copy
    describing a number must hold across that number's whole range, and a layout/theme choice must
    not silently delete functionality.
  - *Convergence:* c10 fixed 4 HIGH + ~14 MEDIUM → not clean; c11 is the next confirm round.

- **2026-07-24 (cycle 3, round 11 — a confirm round that found a BLOCKER I had just introduced, plus
  two HIGHs that were the SAME CLASS as c10 fixes applied to only one of their siblings):**
  - **BLOCKER (uiux), self-inflicted by c10.** Un-hiding the inline top-comment preview in the
    `compact` layout crushed the story TITLE to 10–30px on every viewport (the preview is a SIBLING
    of the title inside a single flex ROW, so the title absorbed all the shrink), and added
    +130–166px of horizontal page overflow on touch. Reachable with zero deliberate action — the
    `terminal`/`cyberpunk` designs default to this layout. The c10 fix had treated "the switch is a
    no-op here" as the whole problem without checking what showing it did to the row. Resolved by
    keeping the preview out of a one-line layout (density is that layout's entire purpose) while
    giving the hover-revealed action row + explainer their own wrapped full-width line.
  - **HIGH (bug) — the content-blind cache key had a SIBLING.** c10 fixed `itemsQ`; `contentQ` was
    keyed on `pool.length`, so Refresh swapping 25 ids for 25 DIFFERENT ids reused signal maps built
    for the old pool: `relevance` and `termAffinity` silently read 0 for every card and
    personalization degraded to popularity until an unrelated engagement. Same fix, applied to the
    class this time (both keys now carry the ids).
  - **HIGH (design) — the theme-treatment defect had a SIBLING.** c10 scoped `bento`'s tile rule away
    from controls; `clay` has the same `:is(.story-card, .bg-surface)` rule with `border: 0` and was
    left stripping the `--edge` boundary from every control in both modes.
  - **HIGH (perf) — a documented invariant was false.** `train.ts` asserts "training performs no
    network I/O", which held for the article path but not for the item loop 20 lines above it:
    `getItem` falls through to the network past `ITEM_TTL` (true of all of yesterday's history), so
    every engagement fired hundreds of SEQUENTIAL background fetches from both `buildContentProfile`
    and `buildTrainingSamples`. Added a genuinely cache-only `getCachedItems` and routed both
    background paths through it.
  - **MEDIUM (ai/bug, self-inflicted by c10) — the pool-median re-centre made the copy lie.** Moving
    the centring reference to the ranked pool's median left the panel describing that value as "you
    engage with about N% of stories" — a false fact ABOUT THE USER (3% shown for a 15% engager). The
    two concepts are now separate fields: `engagementRate` (the user's real rate, the only one shown
    as a fact about them) and `baseRate` (the centring reference). Also corrected the reconciliation
    sentence: the bars are LOG-ODDS and the estimate is their sigmoid, so "the bars sum to that
    estimate" had readers adding −0.43 next to "40%".
  - Also fixed: the remaining THREE `aria-modal` dialogs that never got the shared modal hook (c10
    wired five of eight — the same miss-a-sibling shape); the scroll-to-top FAB was gated at `sm`
    while the gutter it relies on only exists at `lg`, so it overlaid full-width content from
    640–1023px including touch tablets; and the OSS lens caught that several LIVE brief sections
    still specified deleted features (the At-a-glance viz switcher, `hn:context`, Wikipedia context)
    while `review/README.md` claimed a prune that had only partly landed — both the references and
    the false claims are corrected.
  - *Meta-lesson (the dominant pattern of this round):* four of the six findings were the SAME CLASS
    as something c10 had already "fixed", just in a sibling — a second query key, a second theme
    treatment, three more dialogs, a second item loop. `bug-correctness.md` has carried "when you fix
    one consumer of a shared anti-pattern, grep + fix EVERY sibling in the SAME change" since c7, and
    I violated it four times in one round. The fold is not the hard part; APPLYING it at fix time is.
    A fix is not done until you have enumerated the other call sites of the same shape.
  - *Convergence:* c11 found 1 BLOCKER + 3 HIGH + several MEDIUM → not clean; c12 is the next confirm
    round.

- **2026-07-24 (cycle 3, round 12 — first round run under the new FIX DISCIPLINE; the visual/perf axes
  converged, the trust/ML axes did not. 0 BLOCKER, 5 HIGH (1 standing), ~15 MEDIUM):**
  - **Trend.** design 1 HIGH → **0**, perf 1 HIGH → **0**, uiux 1 BLOCKER + 1 HIGH → **0** (3 MEDIUM).
    The surfaces with strong automated guards are converging. What remains is concentrated in TRUST
    copy and the ML training path, which no guard covers well.
  - **ORIGIN CLASSIFICATION (new — the point is to stop arguing this from memory):**
    - `new-from-my-fix` (3): usability U1 (the "Top comments" switch became an ON no-op again when c11
      re-hid the preview to fix the BLOCKER — and the CSS comment I wrote *promised* a disclosure that
      I never implemented, so the promise shipped for a whole round); usability U2 / ai M3 (my c11
      copy claimed the model "starts from a matching baseline" — the bar is a fitted intercept in
      LOG-ODDS, the rate is a probability, and they differed by 15–83 points).
    - `incomplete-sibling` (1): bug HIGH — `getReadItemIds` still read a 5000-event window while every
      sibling derivation read the whole log. c11 removed the 3000-event window from `computeAffinities`
      and did not sweep the class. Impressions dominate the log, so a normal reader passes 5000 in
      days and their entire reading history silently vanished from the Read tab AND the sidebar while
      the UI claimed they had never read anything.
    - `pre-existing` (rest): the ai HIGH (label leakage — affinity features are computed WITH the
      training row's own engagement events while content features are leave-one-out, so the model
      over-relies on affinity and goes inert on unfamiliar sources: this is the *cause* of the
      discovery-case symptom c10 treated at the display layer); the OSS HIGH (the in-app privacy
      warning claimed the reader proxy is "the only feature that isn't fully on-device" while remote
      favicons default ON and call Google — in-app copy that had drifted from CONTRIBUTING.md, which
      is why doc-only passes missed it); and the standing untracked-files staging HIGH.
  - **Fixed this pass, each with the four checks:** the read-history window (sibling enumeration
    documented: 9 `db.events` read sites examined, exactly 1 offender — `autotrain`'s `limit(200)` is
    a legitimate "was there recent activity" debounce, not a state derivation); the false privacy
    claim (+ a sibling sweep for other absolute "only/everything else" claims — none); the
    matching-baseline copy; and the compact no-op disclosure. New guards, each verified
    pre-fix-FAILS / post-fix-PASSES: `readtest` (a genuine read survives a >5000-event log),
    `favicontest` (Settings makes no absolute non-local claim, still discloses favicons),
    `layouttest` (compact discloses the inert switch; the note disappears where previews DO render).
  - *Meta-lesson:* the new discipline earned its keep immediately on the sibling check (a clean
    9-site enumeration found the one offender in seconds) — but it did NOT prevent the two
    new-from-my-fix defects, because both were introduced in c11, before the rule existed, and both
    are of a kind the checks don't cover: **a fix that trades one defect for another, and a comment
    that promises a follow-up that never lands.** Worth folding: when a fix RESTORES a previously
    reported defect as the price of fixing a newer one, that is not a fix — and a code comment
    describing compensating behaviour must not be written until that behaviour exists.
  - **The ai label-leakage HIGH is now FIXED** (`origin: pre-existing`). Behavioural affinity is
    leave-one-out at TRAINING time only — the row's own contribution is subtracted from the
    domain/author sums and its distinct-item count decremented (exact, since affinity is a sum, and
    O(1) per row). Serve time is deliberately untouched: there, all history legitimately counts.
    Verified by re-running the LENS'S OWN matrix, not a narrower probe: p4 `A_popSkew` odds-ratio
    **1.16 → 1.80** with max-slider mean rank **12.5 → 4.5**, now identical to the lens's `B_noLeak`
    ablation control; p6's real 90-candidate pool went from **46 of 90 candidates receiving exactly
    zero learned contribution → 0**, with a balanced 45/45 sign split and a learned spread of 1.048.
    Guarded by `trainlabeltest` (a positive row sees 0 for its own domain/author affinity while
    serve-time affinity for the same item stays 0.58) — verified pre-fix-FAILS / post-fix-PASSES.
  - **Honest limit of that fix, from the lens's own sensitivity sweep (p5).** Leave-one-out fully
    closes the leak when positives are spread across domains (12 domains/positive: `w_term` 1.19 →
    **4.02**, affinity/content ratio 0). When the user's positives CLUSTER on a few domains (4/2/1
    per positive) affinity still dominates ~20×, because the residual signal comes from OTHER items
    on that domain — which is not leakage: it exists at serve time too, and a reader who only reads
    three sites genuinely IS predictable by domain. The lens's ablation zeroed affinity outright,
    which is a stronger intervention than LOO and would regress the familiar-source case its own
    stated invariant protects. Recorded as a modelling trade-off for a later round to judge, not
    silently closed.
  - *Convergence:* not clean. Remaining: ~15 MEDIUMs across all lenses, the clustering trade-off
    above, and the standing staging HIGH. c13 is the next round.

- **2026-07-24 (cycle 3, round 13 — 2 HIGH + the standing staging item; ZERO self-inflicted defects
  for the first time. The remaining HIGHs were both pre-existing sibling drift):**
  - **Trend.** usability 2 HIGH → **0**; ai 1 HIGH → **0**; design/uiux stayed at 0 HIGH. Only bug and
    perf carried a HIGH, and OSS the standing untracked-files item. **Origin: 0 `new-from-my-fix`,
    2 `incomplete-sibling`, rest `pre-existing`** — the fix discipline's first clean scorecard.
  - **The c12 leakage fix was independently confirmed** by a fresh AI lens: discovery-case odds ratio
    **10.06×**, the learned term now has the LARGEST single-signal spread in the blend (0.942 vs
    popularity 0.404 / recency 0.499 / discussion 0.272), and at the exposed maximum it fully
    separates the pool (mean rank of on-taste items 15.5 baseline → 5.5). Its verdict: *"the learned
    term is not inert."* Weights collapsed to effectively a single transferable feature
    (`termAffinity`), which is the correct shape for a stranger pool once affinity is LOO'd.
  - **HIGH (bug, `incomplete-sibling`) — jump-to-comment vs auto-collapse.** All THREE in-thread jump
    features resolved their target with `getElementById`, but auto-collapse leaves most of a real
    thread out of the DOM (measured **191 of 695 mounted, behind 28 pills**) — so two silently
    navigated the reader OUT to a separate page and one did nothing. Fixed with a single
    `jumpToComment` that computes the target's ancestor chain, force-expands it (`revealIds` threaded
    into `Comment`), waits two frames, then scrolls — falling back to navigation only when the id
    genuinely isn't in this tree. All three sites now route through it.
  - **HIGH (perf, `incomplete-sibling` of the c10 memo fix).** `reasons: [] as string[]` minted a
    fresh array per card per recompute, so any engagement (which invalidates `['affinities']` → new
    ctx → the cards memo re-runs) re-rendered the ENTIRE loaded feed — up to ~2.3s of main-thread
    freeze for a one-card action. c10 stabilised the derived Set/Map identities and missed this one.
    Hoisted a module-level `NO_REASONS`, applied to BOTH the plain-feed and For-You paths.
  - **Also fixed (all `pre-existing`):** the summary selector's length-dominated `keyScore` (cap 400 /
    reply 60) was a stale copy of a heuristic the card selector had already been hardened to (cap 200
    / reply 70) — it fed the model **91.4% filler** on a 120-comment thread; both now share one
    `commentSubstanceScore`, and re-running the lens's own probe gives **0% filler, 16/20 insights
    selected (was 6/20), cloud 20/20 (was 9/20)**. `pickTopComments` gained the 40-char substance
    floor its own comment already claimed (a 3-char joke with 6 replies was winning the card's single
    preview slot). A degenerate all-zero-weight model is no longer reported as an active
    personalization. The "Learned model" tooltip now names the reference it is ACTUALLY centred on
    (the ranked pool's median, not the user's engagement rate). Privacy copy: the on-device model's
    one-time weight download from `huggingface.co` is disclosed, and the "fully-local" claim was
    removed from the Listen control (platform `speechSynthesis` may pick a NETWORK voice). README's
    non-existent `ModelProvider` interface and impossible "sort by best" were corrected; SECURITY.md
    now names the favicon redirect host.
  - **A fixture class worth noting:** three tests seeded `emptyModel()` (all-zero weights) to represent
    a "trained" model. That is degenerate — it cannot move a card — so the new gate correctly rejected
    it and the tests failed. The fixtures were unrealistic, not the fix; all three now seed a non-zero
    weight. *A fixture that cannot occur in production will eventually block a correct change.*
  - New guards (each pre-fix-FAILS / post-fix-PASSES): `commenttest` (expanding a collapsed subtree
    mounts its children), `rankergatetest` (all-zero model is not "trained"; any non-zero weight is).
  - *Convergence:* not clean. Remaining: ~15 MEDIUM across all lenses (none HIGH except the standing
    staging item), which is the smallest and least severe backlog of the cycle. c14 is the next round.

- **2026-07-24 (developer-reported, handled under golden rule #8 — the CROSS-SECTION reconciliation
  gap in "Why #N?", plus the display the developer proposed):**
  - **The report.** A screenshot of a real trained panel: the "Inside the learned model" bars
    (−4.42, +1.60, +0.98, −0.03, −0.02, −0.01) annotated *"these does not add up to the score above"*,
    pointing at **Learned model +0.22** in the score table. Verified: every figure was individually
    exact — the bars sum to −1.90 in log-odds, `sigmoid(−1.90) = 13%` (which the panel stated), and
    `tanh((logit .13 − logit .087)/2) = +0.22`. The panel explained the FIRST conversion and never the
    second, so a reader adding the bars got a number appearing nowhere in the panel.
  - **The CLASS:** one quantity surfacing in several places, in different units or after a further
    transform, with each section internally exact and the LINK between them never shown. The lens had
    reported *"panel arithmetic reconciles exactly"* — truthfully, because the (R) invariant said
    "compare it to **the headline figure**", singular and section-local. It checked bars → % and
    passed. Nothing asked it to treat the OTHER section's figure as a whole needing to be accounted
    for. **The invariant was scoped within a section; the defect lived in the seam.**
  - **Brief upgraded** (`ai-ml.md`, invariant R): after the within-section pass, do a **CROSS-SECTION
    pass** — enumerate every place the same underlying quantity surfaces anywhere in the panel, often
    in different units (raw sum → probability → signed pull; per-item → aggregate; log-space →
    linear), and verify the link between each pair is SHOWN to the reader, not merely internally
    consistent. Checking only the headline inside the section you are reading is how this class
    survives a round.
  - **The fix (the developer's proposal).** Rather than explaining the second conversion, remove the
    need for it: show each bar in the SAME UNITS as the score-table figure so they literally add up to
    it. A literal per-bar sigmoid is impossible (it is non-additive), but the model IS additive in
    log-odds — `z = (bias − poolCentre) + Σ wᵢxᵢ`, pull `= tanh(z/2)` — so every term is scaled by
    `(learnedWeight × pull) / z`, the standard proportional attribution. Exact by construction,
    sign- and magnitude-preserving, and numerically safe (the factor tends to `weight/2` as `z → 0`
    and shrinks as tanh saturates). The baseline bar became `bias − poolCentre` — "a typical story
    here" — which is both what makes the sum work and a truer label than the old absolute intercept.
    Display-only; ranking untouched.
  - **Two traps caught while fixing, before they shipped:** (a) scaling to the bare pull matches only
    at the default weight of 1.0 — it must target the WEIGHTED contribution the table actually shows,
    or it drifts by exactly the weight everywhere else; (b) rounding each bar to 2dp independently
    left the visible numbers off by a cent or two, which for a small pull is a large relative error
    and re-opens the same mismatch — the residual is now apportioned onto the largest bar so the
    numbers a user SEES reconcile exactly. Also suppressed the `(w×v)` annotation on model bars,
    which would otherwise have printed a formula contradicting the number beside it — the very shape
    being fixed.
  - Guarded by `personalizeliveupdatetest`: the RENDERED bars sum exactly to the RENDERED score-table
    figure, swept across learned weights **0.8 / 1.0 / 2.5** (the sweep is the point — a single
    default-weight check is what would have hidden trap (a)), plus no contradicting formula, plus the
    copy now claims what is actually true ("they add up to it") and none of the three superseded
    claims. Gate green 48/0/0.
  - *Process note:* the detector proof for the upgraded brief was started against the live pre-fix app
    and then cancelled when the developer directed the fix. It should be re-run against a scratch
    pre-fix copy to confirm the upgraded (R) invariant catches this class unaided — rule #8 step 4 is
    not yet discharged for this finding.

- **2026-07-24 (cycle 3, round 14 — IN PROGRESS, handed off mid-round):**
  - **Tally (6 of 7 lenses in; uiux still running):** bug 2 MEDIUM (**0 HIGH**, down from 1);
    design 1 MEDIUM (**0 HIGH**); ai 1 HIGH + 3 MEDIUM; perf 2 HIGH + 3 MEDIUM; usability 1 HIGH +
    4 MEDIUM; oss the standing staging HIGH + 2 MEDIUM.
  - **Fixed and gated this round (48/0/0):**
    - *(oss M1/M2, `incomplete-sibling`)* — the on-device model-weight download and the read-aloud
      network-voice caveat were disclosed in the APP but in no public doc. Added both to
      `SECURITY.md`; reworded the in-app Privacy blurb, which claimed "the exceptions all live here"
      while naming four exceptions eleven lines earlier.
    - *(ai M2, `new-from-my-fix`)* — the cross-section fix MOVED the seam rather than closing it: the
      bars now summed to the score-table figure, but the paragraph still juxtaposed an ABSOLUTE
      "~6% chance" against "you engage with about 75%" — two reference frames, no conversion, and on
      an avid reader that reads as "the model hates this" beside a green promoting bar. It also
      referenced a Baseline bar that was being filtered out when it rounded to ~0. Both fixed: the
      paragraph now states the user's rate, this story's prediction, AND what a typical story in this
      feed scores ("that gap — not the absolute number — is what moves the rank"), and the Baseline
      bar is never filtered.
    - *(perf F1, `pre-existing`)* — in-thread search rendered EVERY match as a full `<Comment>`:
      measured 869 comments mounted and ~2.9s of blocked main thread to type one word on a
      967-comment thread. Now requires 2 characters and renders at most 50 matches, while still
      reporting the true total ("showing the first 50, keep typing to narrow"). Matching itself is
      unchanged.
  - **NOT yet addressed — the next session should start here:**
    - **ai HIGH-1** "learned ranker inert in the discovery case: weight collapses onto affinity
      features that are 0 for any unfamiliar source". Note this appears to CONTRADICT c13's
      independent measurement (odds ratio 10.06×, "the learned term is not inert") — most likely a
      CLUSTERED-positives fixture, i.e. the trade-off already documented under c12 (leave-one-out
      cannot remove cross-item domain signal, which genuinely exists at serve time). **Verify which
      fixture shape each lens used before acting** — if it is the clustering case, the honest move is
      to decide the trade-off deliberately, not to zero affinity in training.
    - **perf F2** (saving one story → 272ms render / 21 DOM mutations), **usability HIGH-1**,
      the remaining MEDIUMs, and the **uiux report** (still running when this was written).
    - Rule #8 step 4 is still **undischarged** for the cross-section finding: the upgraded (R)
      invariant has not been proven against a pre-fix copy.
  - *Convergence:* not clean.

- **2026-07-25 (FIRST real-hardware run of the on-device AI path — 14 rounds of review never once
  executed it; found a grounding defect immediately):**
  - **Setup.** A headed Chrome on a machine with a real GPU, driven over CDP (`CDP_URL`), with the
    dev server reachable from it. WebGPU genuinely available (a hardware adapter, secure context) —
    unlike CI/headless, where there is no adapter at all.
  - **Capability (all PASS):** embeddings load and return a 384-dim vector (18.2s cold);
    `Llama-3.2-1B-Instruct-q4f16_1-MLC` loads and generates coherently (103s cold, ~1GB download,
    0 errors). This is plumbing, not behaviour — do not confuse the two, as I initially did.
  - **BEHAVIOUR — a real defect, visible only by LOOKING at the rendered summary.** On live item
    49038433 ("Claude Opus 5", anthropic.com, 790 comments) the on-device summary rendered with the
    correct structure (Gist + "What commenters say" with two real, correctly-attributed quotes, no
    prompt leakage, no template artifacts). But the **Gist is ungrounded**: it states Claude Opus 5
    "is a new AI-powered software development tool… designed to help developers create and optimize
    their code" — a confabulated product description; it is a language model. With the reader proxy
    OFF (the default) the model gets only the TITLE plus comments, and it invented a description of
    the subject rather than reporting what the discussion says. It also pads with "which is being
    discussed on Hacker News", restating the context.
  - **Class:** *the summarizer's quote EXTRACTION is grounded; its GIST is not, when article text is
    absent.* The fix direction is to make the gist report the DISCUSSION (what is being argued) rather
    than describe the SUBJECT, or to state plainly that the subject is unknown without article text —
    never to invent a description. Worth grading across several threads before changing the prompt.
  - **Why 14 rounds missed it:** the AI lens runs on a headless machine whose Chromium has no WebGPU
    adapter, so `generate()` could never run and every lens correctly reported "generated-summary
    quality could not be graded". The gap was known and stated every round; it was never closed until
    a WebGPU-capable browser was actually attached.
  - **Process lesson (mine):** I ran `page.screenshot()` throughout and read NONE of the images,
    asserting behaviour from DOM text alone. That hid two things at once — a broken step in my own
    script (a `/start/i` selector matched the "Startups" chip instead of "Skip", so onboarding was
    never dismissed and I nearly reported it as dismissed) and this grounding defect. The
    screenshot-first rule the briefs impose on the lenses applies to the primary agent too.

- **2026-07-25 (developer-reported, handled under golden rule #8 — SERVE-TIME self-reinforcement: reading
  a story promoted THAT story to the top of the feed):**
  - **The report.** "I clicked an item ranked a few positions down, read it, closed it, went back — and
    it was now #1." Unexpected and useless: the most prominent slot is filled with the one thing the
    reader has just finished with.
  - **Handled through the lenses, not hand-patched.** Named the CLASS first — *an action's own signal
    feeding back into the ranking of the thing acted upon* — folded it into `ai-ml.md` (SELF-REINFORCEMENT:
    the serve-time counterpart of the training-time leakage check it already had; grade it as a
    BEFORE/AFTER on POSITION, not on score internals) and `usability.md` (RETURN-TRIP STABILITY: note the
    order, open something not at the top, spend real time, come back, compare). Neither fold names the
    surface or the cause.
  - **Detector PROVEN on the pre-fix state** (rule #8 step 4, discharged this time). A fresh AI lens,
    told only to grade ranking behaviour across a session, **independently rediscovered it**: *"Engaging
    with a story promotes that story to the top of your own feed (serve-time self-reinforcement)"*, with
    a clean fixture (24 stories, identical age and comment count, unique domain/author each, so the
    baseline order is strictly by points):

    | interaction | start | after | climb |
    |---|---|---|---|
    | discussion stay (9.3s) | 10 | **2** | +8 |
    | discussion stay (9.3s) | 18 | **9** | +9 |
    | save | 12 | **1** | +11 |
    | glance (2s, control) | 10 | 10 | 0 (correctly no credit) |

  - **Root cause** (validated against the code before fixing): `interactions.ts` sums every event —
    including the acted-on item's own — into the domain/author totals; `perItem[]` records each item's
    own contribution but was consumed **only** by training's `looAffinities`. `features.ts`
    `computeFeatures` then read the un-adjusted totals for that same item, and `onEngagement`
    invalidates `['affinities']`, so the live feed re-scored in place and the story climbed.
  - **Fix.** Moved leave-one-out into `computeFeatures`, so it applies to EVERY caller — the scorer, the
    "Why #N?" explainer, and training alike. The training-only copy was **removed**: keeping both
    subtracted twice (caught immediately by `trainlabeltest`, which went to −0.58 instead of 0). One
    place, no drift, and the explainer cannot disagree with the rank it explains.
  - **The invariant that keeps it useful:** affinity still ACCRUES and still TRANSFERS — only
    self-promotion stops. Guarded in `feedstabilitytest`: the engaged story gets 0 domain and 0 author
    affinity from its own events, a SIBLING on the same domain still gets 0.58, an unrelated domain is
    untouched, and the story no longer counts itself toward the "often" habit threshold. Verified
    pre-fix-FAILS / post-fix-PASSES, and re-checked against the LENS'S own matrix (all three climbs now
    0, control unchanged). Gate green 48/0/0.
  - *Note:* this is the third variant of one idea — leave-one-out at TRAINING (c12), the pool-relative
    reference for DISPLAY (c12), and now leave-one-out at SERVE. The first fix should have prompted the
    question "where else is an item scored against data it produced?" — it did not, and the answer sat
    unasked for two rounds.

---

## c3r14 — fixes applied (2026-07-25)

Round 14's seven lenses reported **0 BLOCKER, 5 HIGH, ~19 MEDIUM**. What follows is what was
validated against the code and fixed, with each finding's ORIGIN recorded so the
self-inflicted-regression rate stays measurable.

### HIGH

- **[O1 · OSS] Five untracked files were already imported by tracked code** — `useModalBehavior.ts`,
  `hn/topComment.ts`, `useScrollTop.ts`, `topcommenttest.mjs`, `switchtest.mjs`. The next public push
  would have shipped 12 dangling imports and broken the Pages build. **Fixed** by staging everything;
  `git status --porcelain | grep -c '^??'` is now **0**. *Origin: pre-existing (working-tree hazard,
  not committed code).*

- **[A1 · AI] The learned ranker was inert for DISCOVERY — weight collapsed onto affinity features
  that are identically 0 for any unfamiliar source.** Root cause validated as the lens's mechanism
  (b): `trainPairwise` ran gradient descent on RAW feature differences with one shared learning rate
  and one shared L2, which is not scale-invariant — large-scale features take big steps and soak up
  the weight, small-scale ones are starved AND taxed harder by L2. Domain/author affinity is large
  when the source is familiar and exactly 0 when it is not; the content features that can *transfer*
  to a new source are small-scale. So the fit concentrated weight on features that are structurally
  0 for every new source.
  **Fix:** standardise each feature's scale for the fit, then fold the scale back into the returned
  weights (`w = w'/s`) so they still apply to RAW features. The external contract is unchanged —
  `scoreItem`, Platt calibration and the "Why #N?" contributions all keep consuming raw values, so
  the reconciliation fixed earlier this cycle still holds — and only the optimisation geometry
  changes. Dividing by a positive scale preserves sign, so the `w >= 0` projection is unaffected.
  **Measured on the lens's own matrix** (`c3r14_ai_ranker3.mjs`, nSrc ∈ {2,3,4,6,12} × popularity-gap,
  all 7 arms):

  | metric | lens reported | after fix |
  |---|---|---|
  | discovery odds-ratio | 1.21 | **16.9 – 22.2** |
  | held-out AUC | — | **0.986** |
  | on-taste mean rank @ default w=0.8 | 27.5 (no lift) | **5.3 – 6.8** |
  | on-taste stories in top 6 | 0 in top 12 | **4 of 6** |

  The familiar-source control the report required (`c3r14_ai_familiar.mjs`) did **not** regress
  (mean rank 9.5 → 3.5; meanP familiar 0.9983 vs sports 0.0373), and the personalization proof is
  36/36. *Origin: pre-existing.* Mechanism (a) was already closed by the c13 serve-time
  leave-one-out fix (`looAffinities` removed); mechanism (c) — no IDF/term-specificity in
  `termAffinity` — is **deferred**: it is a quality improvement, not a cause of the reported defect,
  which the measurement above shows is resolved (on-taste pool termAffinity 0.207 vs 0.027).

- **[P1 · perf] In-thread search rendered an uncapped match list** — already fixed earlier this cycle
  (`MIN_QUERY = 2`, `MAX_RENDERED_MATCHES = 50`, overflow disclosed). Verified present, no action.

- **[P2 · perf] Every engagement re-rendered the whole For-You list twice.** `explainItem` builds a
  fresh object per call and was invoked inline while building `cards`, so every card got a new
  `explain` prop identity on every recompute — and `cards` recomputes on any engagement. That
  defeated `memo(StoryCard)` for the entire list (~272ms render / ~281ms blocked on For You vs ~17ms
  and 0ms on Top, whose branch already reuses the module-level `NO_REASONS` for exactly this reason).
  **Fix:** build the explanations in their own memo keyed on `[isForYou, ranked, rankCtx,
  activeModel]` — deliberately *not* the visibility inputs — so a hidden/visible/readSnapshot change
  hands back identical objects and untouched cards bail out. *Origin: incomplete-sibling — the same
  defect class as the already-fixed `NO_REASONS` one, left in place on the other prop.*

### MEDIUM

- **[P3] `Comment` was not memoized**, so changing the comment Sort re-rendered all 251 mounted nodes
  (~400ms in one ~450ms long task) despite referentially stable props. Memoized via a
  `CommentImpl` + `memo()` split so the recursive call also goes through the wrapper. Local
  `collapsed`/`repliesOpen` state is preserved (memo does not reset state) and `revealIds` still
  propagates because its identity changes when updated. *Origin: pre-existing.*

- **[U1] Returning from a discussion discarded both the scroll position and every page loaded.**
  Paging depth lived in a `useState` inside `useFeed`, which React Router unmounts on navigation
  (90 cards / scrollY 17404 → 25 cards / scrollY 0). Added `lib/feedSession.ts`: per-feed-kind
  depth + scroll, module-scoped for the life of the page, deliberately **not** persisted. An explicit
  Refresh clears it (a new list should not strand you 90 cards deep). *Origin: pre-existing.*

- **[B1] `unsave` did not reverse `save` in ANY derivation.** `save` was added unconditionally to
  `strong`, so an undone save kept full affinity, kept its domain in the engaged counts, and stayed a
  permanent training POSITIVE — mis-clicking the small Save icon and undoing it taught the ranker
  forever. `unsave` was also missing from `ENGAGEMENT_TYPES`, so the live-update wiring never fired.
  **Fix:** mirror the existing hide/unhide pattern exactly — latest-timestamp `saveTs`/`unsaveTs`
  (order-independent), `unsave` added to `ENGAGEMENT_TYPES`, and the weight changed −1 → **−2** so the
  pair cancels to 0 instead of leaving a permanent +1. A `read + save + unsave` item correctly stays
  engaged on its read. *Origin: pre-existing.*

- **[U4] "Show 39 replies" revealed 4.** The label used `countDescendants` (whole subtree) while the
  click mounts only direct children, each re-collapsing if its own subtree is large — off by up to
  10×. **Fix:** one `repliesLabel(direct, total)` helper — "4 replies · 39 in thread" — applied to
  **all six** label sites (expand pill + its aria-label, Hide + its aria-label, collapsed badge,
  "Continue this thread"). *Origin: pre-existing.*

- **[X1] The story-card action row overflowed the page** at 320px + Large text with an AI backend
  configured (5 buttons, 257px into a 307px card, +21px) in **9 of 14 layouts**. The `flex-wrap`
  remedy already existed but was scoped to `[data-layout='newspaper']` only. Hoisted onto
  `.sc-actions` itself, since wrappability is a property of the row, not of one layout. *Origin:
  incomplete-sibling.*

- **[X2] The keyboard-shortcuts dialog had no max-height and no scroll** — the only one of the app's
  seven modals with neither, while `useModalBehavior` sets `body{overflow:hidden}`. In every landscape
  phone orientation its bottom was unreachable (+28 to +156px), and what got cut off was the
  "everything is also reachable with Tab/Shift+Tab + Enter" accessibility escape hatch. Given the same
  `max-h-[85vh] overflow-y-auto` clamp as its six siblings. *Origin: pre-existing.*

- **[U3] "Reading text size" scaled everything except the feed headline.** `.sc-title` was pinned to
  `text-[15px]`, so at Large the grey top-comment preview rendered *larger* than the story title above
  it. Converted the reading surfaces to rem (`0.9375rem`/`0.8125rem` — byte-identical at the `md`
  default): the story title, the top-comment preview, and the extracted article body in
  `ArticleReader` (the longest-form reading surface, also px-pinned). The remaining 10–11px values are
  badges and micro-labels — deliberate non-scaling chrome — and were left alone. *Origin:
  pre-existing.*

- **[B3] The profile Stories/Comments toggle silently reverted the user's choice** when the activity
  fetch landed, and again on any refetch (including Settings → Data's global invalidate). Made the
  default a one-shot seed keyed by profile id, so a different user still re-seeds. *Origin:
  pre-existing.*

- **[B6] `TYPE_LABEL` lagged the `InteractionType` union**, so the "signals recorded" transparency
  dialog showed raw identifiers (`unsave · 1`, `unhide · 1`) to anyone who un-saved a story or hit
  Undo. Retyped as an exhaustive `Record<InteractionType, string>` so a new type cannot compile
  without a label; a `labelFor()` helper keeps the runtime fallback for rows predating a rename.
  *Origin: pre-existing.*

- **[O2/O3/O4]** — the model-weight download, read-aloud's network voices, and the Settings privacy
  copy were all already corrected earlier this cycle. Verified present in `SECURITY.md:22-29` and
  `Settings.tsx`, no action.

- **[U2] A discussion you genuinely read was not recorded if you ended the session by closing the
  tab.** The dwell was written only in a React effect cleanup, which does not run on unload — so a
  12s read then closing the tab produced `{read:0, dwell:0}`, while the identical read followed by an
  in-app "Back to feed" produced `{read:1, dwell:1}`. That inverts the app's own rule, under which a
  bare article click with no dwell at all still counts as read. **Fix:** flush on `pagehide` and on
  `visibilitychange`→hidden (the only one reliable on mobile) as well as on unmount, with
  `trackDiscussionDwell` now returning whether it actually recorded so exactly one event is written
  per visit. Guarding on *recorded* rather than *flushed* means a short glance under `BOUNCE_MS` does
  not consume the one chance — the reader can come back, keep reading, and still have the real read
  counted. *Note:* the ARTICLE path is deliberately NOT flushed on hide, because for an article
  opened in a new tab, going hidden is the START of the read, not the end — flushing there would
  record ~0ms. That case is genuinely unrecoverable without a beacon. *Origin: pre-existing.*

- **[X4] The Personalize (⋯) menu never handled the bottom of the viewport.** It is absolutely
  positioned below its trigger, so opening one near the fold left 22px of a 186px menu on screen —
  12% on phones, 25% at 1280x800, in all 39 layout × viewport cells. A horizontal clamp already
  existed; the vertical sibling had never been written. Extended the same `useLayoutEffect` to lift
  the menu by however much hangs below the fold, bounded by the room above. *Origin:
  incomplete-sibling.*

- **[B2] The `compact` layout hid the top-comment preview in CSS but still fetched it** — the element
  was mounted and `display:none`, so each card still paid up to `MAX_KIDS=5` firebase requests for a
  comment nobody could see (~125 wasted requests per 25-card page, again on every Load-more).
  `compact` is the default layout of the terminal and cyberpunk DESIGNS, so a user who only picked a
  colour scheme silently paid it — while the feed header correctly told them the feature was
  unavailable there. Folded the same `effectiveLayout(...) === 'compact'` check the header already
  makes into the query's `enabled`, read from prefs so it stays reactive to a runtime layout change.
  *Origin: pre-existing.*

- **[A3] `selectKeyComments` violated the shared scorer's contract**, passing `countDescendants(n)`
  where `commentSubstanceScore` documents and is calibrated for DIRECT replies (`REPLY_WEIGHT` 70
  against `LEN_CAP` 200). Subtree size was therefore worth up to ~14 length-caps, making it 86-94% of
  a comment's score: on live threads the first four comments handed to the summary model were four
  consecutive links of one off-topic tangent, and on a hostile tree the single insightful comment was
  not selected at all. Now passes `n.children.length`. Depth already penalises sitting deep in a
  chain; subtree size should not additionally promote every link of it. *Origin: pre-existing — and
  the same class as a defect the comment block above it claims was already fixed (it was fixed on the
  length axis and reopened on the engagement axis).*

- **[A6] The comment block over that scorer contradicted itself** — its first paragraph asserted the
  two selectors were "NOT identical scorers" with different constants (cap 400 / reply 60), which
  described a length-dominated copy that had already been deleted, while the second half correctly
  described the shared scorer the code actually calls. A maintainer reading only the first paragraph
  would believe divergent constants were intentional. Deleted the stale half and stated the one
  genuine difference (the depth penalty). *Origin: pre-existing.*

- **[O6] No third-party attribution file** — the one real legal gap. Four bundled runtime deps are
  Apache-2.0 (`@huggingface/transformers`, `@mlc-ai/web-llm`, `dexie`, `dexie-react-hooks`), whose
  section 4(d) requires propagating an upstream NOTICE, and `dompurify` is dual-licensed so the
  elected option must be stated. Added `THIRD_PARTY_NOTICES.md`, **generated** by
  `scripts/gen-notices.mjs` from package.json's `dependencies` (devDependencies excluded — they are
  not redistributed, so axe-core's MPL-2.0 never reaches a user). Generated rather than hand-written
  because an attribution list is exactly the kind of file that silently goes stale after a dependency
  bump — and `gen-notices.mjs --check` is now a step in the `static` tier, so the gate fails if it
  drifts. Linked from the README. *Origin: pre-existing.*

- **[D1] `--subtle` (the deliberately faint DECORATIVE token) was carrying INFORMATIVE text on
  raised surfaces** — sub-AA in 17 of 31 designs, worst measured 3.80. Converted the informative
  instances to `muted` (which is contrast-normalised against surface AND surface-2) and left
  `subtle` for genuine decoration, exactly as the report recommended — the token was NOT darkened
  globally, because that would erase the distinction it exists for. Sites: story metadata + the
  meta sub-row, the collapsed reply pill's repliers preview, the Settings->Data per-category stat
  and description (read immediately before an irreversible Delete), the kbd chips in the sidebar
  and keyboard-help, and the reader-proxy fallback ordinals.

  **The more important half was the guard.** `themecontrasttest` checked TOKEN pairs, so it could
  prove `--subtle` is legible where `--subtle` is *supposed* to be used but could never see which
  token a COMPONENT actually chose — it reported a clean sweep while this entire class shipped.
  Added a RENDERED-DOM pass: walk the real leaf text nodes across three routes (feed, settings,
  discussion) in all 31 designs x both modes, composite the true background by walking ancestors,
  and grade each element against its own WCAG bar (4.5, or 3.0 for large text), skipping separators
  and single glyphs. Verified **pre-fix FAILS / post-fix PASSES**: 102 failing cells across 6
  distinct texts, worst 3.80 — reproducing the lens's measured number exactly — then 0 after.

  Three defects in the guard itself had to be fixed first, and all three are the same shape as the
  `NaN`-passes-silently bug already recorded here — *a check that computes a WRONG number is worse
  than no check, because it sends you fixing something that isn't broken while hiding what is*:
  1. **Unparseable colors fell back to white.** Tailwind emits `oklab(... / 0.15)` for `bg-accent/15`,
     which an `rgb()`-only regex cannot read; treating unreadable as "no background" made the walk
     fall through to white, fabricating a 1.01 ratio on a perfectly legible control in dark themes.
     Now resolved via a 1x1 canvas (handles oklab/oklch/color()/named/hex), and an unresolvable
     color is REPORTED rather than skipped.
  2. **Alpha compositing mixed premultiplied and straight alpha** — exact for opaque backgrounds,
     nonsense for any tint.
  3. **Mid-transition sampling.** Controls carry `transition-colors`, so measuring right after a
     theme flip paired the OLD theme's foreground with the NEW theme's background. Transitions are
     now disabled for the pass (deterministic; a sleep would be slower and still racy).

  *Coverage note:* the rendered pass sees three routes in their DEFAULT state, so it does not yet
  reach `:hover`, an open dialog, or a collapsed reply pill — five of the six fixed sites were found
  by the lens, not by the guard. Extending it to drive those states is the obvious next step.
  *Origin: pre-existing.*

- **[U5 + A2, remaining sub-items] Two sentences in the "Inside the learned model" panel were
  conditioned on something other than what they claimed.** (i) The "mostly-positive features can
  still land below 50%" clause was gated on the USER'S overall engagement rate rather than the
  DISPLAYED estimate, so a balanced or avid reader saw it printed beside a ~95% prediction —
  explaining an outcome that was not on screen — while the readers who did see a low estimate got no
  explanation. Now gated on the displayed value. (ii) The "each bar below … they add up to it"
  promise was unconditional, so a story with all-neutral features rendered that sentence, a dangling
  colon, and then "All features are neutral for this story." Now rendered only when bars exist.
  Guarded in `personalizeliveupdatetest`. The earlier sub-items of this finding (the absolute-vs-pool
  framing, the always-rendered Baseline bar, and the unclamped true engagement rate) were fixed
  earlier in the cycle. *Origin: pre-existing.*

### Open, routed back through the lenses (NOT fixed directly — golden rule #8)

- **The small local model fabricates specifics.** With the webgpu tier working, three real threads
  were graded end-to-end. One TL;DR was accurate; one added an unsupported verdict ("indicating a
  step backward"); and one — a rocket-launch thread — confidently invented a rocket NAME, a
  valuation and a development timeline that appear nowhere in its input. Separately, on a thread
  whose commenters were joking that a "Cookbook" might be a literal recipe book, the model repeated
  the joke as fact, because it cannot distinguish a joke from a claim.
  **Not patched here.** Per rule #8 the interesting question is not "reword the prompt" but *why no
  lens caught it*, and the answer is structural: `ai-ml.md` §1 (OUTPUT QUALITY — its highest-value
  section) requires a real model, the lens runs headless with no GPU adapter, and the brief offered a
  mock escape hatch — so §1 has effectively never executed while the lens reported confidently on
  everything else. **Fixed the detector instead:** §1 now tells the lens to attach to a WebGPU
  browser via a `CDP_URL` supplied in the appendix, to state a zero-real-generations round as a
  finding at the TOP of its report, and to grade FABRICATION explicitly — locate every proper noun,
  number and date in the input, and report anything it cannot find. Also to flag unsupported
  editorializing and joke-as-fact. The prompt/model change waits for the lens to rediscover this
  independently, which is the point.

### The webgpu tier had rotted to the point of testing nothing

`modeltest` only runs where a real WebGPU adapter exists, so CI never runs it and the drift went
unnoticed. It went **2 errors → 0**, but the interesting part is what the failures actually were:

- **Neither original "failure" was an app defect.** "No loading spinner" and "no Article text link"
  were both missing PRECONDITIONS: the summary was cached from a previous run (so there was no
  loading phase to observe), and the article-text link is deliberately gated on the `fetchArticleText`
  opt-in, which the harness never enabled. Measured directly: the link is absent with the pref off and
  present with it on — the app was right both times.
- **The stale-cache trap was the real find.** This tier runs against a PERSISTENT profile, so on every
  run after the first the "is the generated text degenerate?" assertions graded a string cached by an
  earlier run. Both generation steps now clear the summary cache first and **assert it is empty**, so
  the text being graded came from a real model call in this run.
- **A 10-minute hang caused by prose matching.** The status poll used
  `getByText(/loading|ready|error|…/)` scoped to a section — which matches the privacy disclosure's
  "**down**loading AI model weights". With the reader-proxy toggle on, the harness locked onto that
  paragraph and burned its full deadline, then reported a wall of privacy copy as the "LLM status".
  Added a `data-model-status` hook and targeted the element; the model now reaches ready in **4s**.
- **A silent crash that leaked a tab.** The run vanished during the concurrency step with an empty log
  and left an `/item` tab open in the user's browser. Added a watchdog that names the step it died on,
  and bounded the concurrency generations in-page so a deadlock is *reported* rather than hung on.
- **An apparent z-index defect that was not one.** The TL;DR click failed with "`<p class='line-clamp-2
  …'>` intercepts pointer events", which reads exactly like the documented `.sc-tldr` stacking bug.
  Measured instead: with the card settled, `elementFromPoint` at every action button returns the button
  and there is an 8px gap. The real cause is **async layout shift** — the lazily-fetched top-comment
  preview lands and pushes the action row out from under the click. Added `waitForStableCard`.
- The harness also leaked `fetchArticleText: true` into the persistent profile (my probe did it first,
  and my own fix would have done it every run); it now restores the pref, and third-party proxy/favicon
  console errors no longer fail the run — a reader proxy returning 401 is the case the fallback chain
  exists for. Console errors now record their URL, because "Failed to load resource: … 401" with no
  origin is undiagnosable.

*Origin of the harness issues: pre-existing rot, except the `fetchArticleText` leak
(**new-from-my-fix**, caught and fixed in the same round).*

---

## c3r15 — round 15 (2026-07-25)

Seven lenses ran against a preview built from HEAD. Totals: **1 BLOCKER, 8 HIGH, ~15 MEDIUM**. Two
of the HIGHs are **self-inflicted regressions from this same cycle's A1 fix**, which is the most
useful thing the round produced.

### The A1 standardisation regressed the ranker — caught by the bug lens, missed by the AI lens

**[HIGH, self-inflicted] The learned reranker collapsed into a one-feature step function.** The
scale fold-back (`w = w'/s`) measures `s` on the TRAINING-PAIR spread but applies the weights to raw
SERVE-time features whose range is fixed by the feature definition (~±1). Serve-time leave-one-out —
the c13 fix — makes `domainAffinity` near-CONSTANT across training pairs (most history is one item
per domain, so removing the item's own contribution zeroes it), giving an RMS ≈ 0.001 and a ~1000×
fold-back. So **my A1 fix collided with the c13 LOO fix**, and the `1e-6` floor only guarded the
exactly-constant case, not the near-constant one.

Reproduced with the lens's own probe on live HN data across 5 engagement rates: max weight
**553–595** standardised vs **0.07–1.5** plain, 4 of 5 cells inflated 400–8000×, P(engage) snapping
0→1 across a 0.04-wide slice. That is *worse* than the single-feature domination A1 was written to
fix.

**Fix:** floor the scale at a meaningful fraction of the feature's declared range
(`SCALE_FLOOR = 0.1`, capping amplification at 10×) rather than storing a transform — which would
have broken the raw-feature contract every call site depends on, including the "Why #N?"
reconciliation fixed earlier this cycle. Verified against BOTH lenses' matrices, which is the point:
max weight **0.43–13.2** and Platt `a` positive in all 5 live cells, AND A1's discovery result
intact (odds-ratio 16.9–185, AUC 0.986, on-taste mean rank 27.5 → 5.3–6.8).

**[MEDIUM, pre-existing] Calibration could erase the whole model.** `Math.max(a, 0)` multiplied every
weight by zero whenever Platt's slope came out ≤ 0, so `rankerTrained` stayed false forever and the
reranker reported "still learning" with no diagnostic and no way for the reader to escape by using
the app more. A degenerate `a` only means the PROBABILITY calibration failed; `wRank` is still a
valid, sign-constrained ranking direction. Now falls back to the uncalibrated weights.

**Why the AI lens missed it, and the lesson.** The AI lens measured the same change and reported it
"holding" with an unfamiliar-slice **AUC of 1.00**. That number was not evidence of health — it is
the *signature* of the step function: a saturated binary score separates a synthetic fixture
perfectly. The bug lens caught it because it trained on **live HN data at realistic engagement
rates** instead of a synthetic taste. Folded into `ai-ml.md`: a near-perfect AUC on a small fixture
must be treated as a symptom to investigate, not a pass.

### The rule-#8 process worked

The AI lens **independently rediscovered the summary fabrication** that was routed back to it last
round (it found the same invented rocket identity, plus invented commenters on a zero-comment story
and 5-of-7 successful prompt injections) — without being told it existed. That is the success test
the rule sets: the same developer report, made again, is now caught by a lens first.

### Also fixed this round

- **[HIGH usability / LOW bug] Three surfaces told a reader who had read 40 stories to "read a few
  stories".** `rankerTrained` is a THREE-part gate but the sidebar, Settings and the "Why #N?" panel
  each re-derived their message from only the first two, so the degenerate-model case got advice that
  could not possibly help. Added `rankerGate(model)` returning WHICH clause failed
  (`no-model` / `too-few-samples` / `too-few-positives` / `degenerate` / `trained`); `rankerTrained`
  is now defined in terms of it, and all three surfaces phrase the actual reason. *This is the third
  time this exact concept drifted across surfaces — hence a named helper rather than another
  hand-written condition.*

### Guards added (each verified pre-fix-FAILS / post-fix-PASSES)

`rankergatetest` gained a weight-band check, a saturation check, a calibration-never-erases invariant,
and a gate-clause check. Two things had to be fixed in the guard itself before it was worth anything:

- **The first fixture was vacuous** — a near-constant feature with no signal does not reproduce the
  bug, because the fit gives it ~0 weight and 0 × 500 is still 0. The fixture must be near-constant
  **and** aligned with the label (which is exactly what LOO produces). With that, it reproduces the
  live number: maxW **344–559** unfloored vs **2.7–3.2** floored.
- **The first threshold could not fail** — `extreme < n` let 20-of-50 saturated pass. Re-set to half
  the pool after measuring both states (14/50 healthy, 50/50 broken), so it discriminates with margin
  rather than being tuned to just-pass current behaviour.

*Origins: the scale fold-back and its guard gaps are **new-from-my-fix**; the Platt zeroing, the gate
messaging and the fabrication findings are **pre-existing**.*

### c3r15 HIGH remediation (all HIGHs + the BLOCKER closed)

- **[BLOCKER · OSS] Internal names in public files.** Two internal product names shipped
  (`AGENTS.md`, `review/README.md`), and on review the *scrub-pattern lists themselves* were the
  larger leak: a checklist that spells out internal hostnames, group paths and bug/CL formats
  identifies the employer from the list alone. Both fixed, and the concrete patterns moved to the
  gitignored local notes. Guarded by **`scripts/leakcheck.mjs`**, a `static`-tier step that reads the
  pattern list from the gitignored notes (so the guard cannot leak them either).

  **This paragraph originally said "closed for good", and that was wrong.** The next round's OSS lens
  found the leak still in HEAD and in 7 unpushed commits: the guard graded only WORKING-TREE bytes and
  the scrub had been left staged, so it reported clean while `git push` would have published the leak.
  The confident wording also actively suppressed the instinct to check history. The guard now grades
  the working tree, HEAD, every unpushed commit tree AND every unpushed commit message, refuses to
  pass silently where no pattern list exists, and skips digest lines so a lockfile hash cannot
  masquerade as a hit. First run surfaced 26 false positives
  — short pattern entries matching inside longer ordinary words, and one that is an everyday English
  verb — fixed with word boundaries and by pruning those entries, because *a guard that cries wolf
  gets muted rather than fixed*. (Naming the offending entries here would republish exactly what the
  list is kept private to avoid; they are recorded in the gitignored notes instead.)

- **[HIGH · UI/UX] Extracted article text had no long-token guard** — +453px page overflow at 320px
  on the discussion Article tab, and silent clipping (no wrap, no ellipsis, no scroll) in the card
  overlay at every viewport including desktop. Extracted text routinely carries bare URLs and hashes,
  which `break-words` will not break; both sites now use `[overflow-wrap:anywhere]`.

- **[HIGH · design] The rendered-DOM contrast pass was grading almost nothing.** Its `{}` API mock
  rendered zero story cards and zero comments, so it graded ~12 nodes on the feed and ~11 on a
  discussion — page chrome — while reporting a clean sweep across 31 designs. Gave it a realistic
  fixture (25 stories, 8-comment trees) and added an assertion that the pass actually graded content
  per route, so an empty fixture can never look like a pass again: now **133 / 152 / 56** nodes, still
  clean. Also fixed the two `--subtle` siblings the lens found that the guard cannot reach without an
  imported account (`HnAccount` stat labels, `CachedModels` size read before Remove).

- **[HIGH · usability, MEDIUM · UI/UX] The text-size axis was defeated by layout CSS.** The component
  fix was real, but **8 of 14 layouts** re-pinned `.sc-title` in px, and in `list`/`newspaper` the grey
  preview then rendered LARGER than the headline at Large. All converted to rem; guarded in
  `layouttest` by asserting the EFFECT (headline grows md→lg) in every layout — verified pre-fix-fails
  by re-pinning one layout. *Same class as the `.sc-actions` finding: a component-level fix is not
  done until the layout overrides agree with it.*

- **[HIGH · AI] A zero-content story invented its own commenters.** With no comments, no article and
  no self text, the model filled the template rather than declining — a real story produced a summary
  quoting "John Smith", "Jane Doe" and "Bob Johnson" directly above the app's own "Based on no
  readable content". The instruction not to invent was already in the system prompt; a 1B model does
  not obey a policy sentence when the format demands content. Now the model is **not called at all**
  in that state and an honest line is shown instead (uncached, since content arrives later).

- **[HIGH · AI] Prompt injection — mitigated, measured, and honestly disclosed.** Untrusted text is
  now fenced with an explicit boundary and **defanged** deterministically (`neutralizeInjection`):
  output-format markers, role labels, fence terminators and direct imperatives are broken, while the
  comment's own words survive so it remains summarisable. Verified in the REQUEST by `llmcachetest`.
  **But measured against the real model, this is not sufficient**: re-running the lens's own battery,
  the fabricated-article case improved (the invented NBER funding and Meta endorsement disappeared)
  while template-impersonation still put the attacker's sentence in the Gist. A probe confirmed the
  defences reach the request — so this is a model-capability limit, not an implementation gap.
  Rather than claim a fix, the residual risk is now stated where it matters: a shared
  "AI-generated · may be inaccurate" caveat on **every** summary surface (one component, so it cannot
  drift), and a SECURITY.md section explaining that summaries derive from untrusted content, what is
  mitigated, what is not, and that the blast radius is a misleading summary rather than code
  execution.

- **[HIGH · performance] One straggling item multiplied first paint 5×.** The feed paints when the
  whole item pool settles, so TTFC is set by the slowest item — against the generic 10s deadline a
  single hung request stretched 1.4s into 10.4s. Items (unlike lists and trees) have a tolerated-gap
  fallback: `getItems` filters nulls and the card is simply absent. Gave item fetches their own 4s
  deadline; guarded in `feederrortest` with a never-answering item — TTFC **4.5s** and 11 of 12 cards
  still paint.

Every guard added here was checked in both directions. Three of them were **vacuous on the first
attempt** — a fixture that did not reproduce the bug, a threshold that could not fail, and a
region-slice that matched the harness's own template — which is itself the recurring lesson: a new
guard is not evidence until it has been seen to fail.

---

## Developer-reported: "item lists change and shift position in the same session"

Handled through the rule-#8 process rather than patched directly. The value of a developer report is
that it identifies a **blind detector**, and c3r15's usability lens had in fact reported
"return-trip order/scroll stability — verified clean" in the same round the defect was live.

**1. The class.** *In-session list mutation*: a list reorders, resizes or shifts underneath someone
who is reading it, as a consequence of background work or of an incidental interaction rather than an
explicit act. Two distinct mechanisms turned out to sit under one symptom — re-ranking (list order)
and reflow (pixel position).

**2. Why the lens missed it.** Its stability check was framed around the RETURN TRIP — navigate away,
come back, is the order intact. That passes while a continuous session is being reshuffled. Deferred
work also takes tens of seconds to land, so a quick scripted pass finishes before anything moves.

**3. Brief upgrades (no mechanism spoilers).** `usability.md` gained "Does the list hold still while
you are READING it?" — record the order and the pixel position of a story a few screens down, behave
like a reader for a realistic stretch, and check it is still there; only an explicit act may reorder;
wait out deferred work; a *correct* reordering still fails the bar; and watch the softer pixel version
(late content pushing your target down). `bug-correctness.md` gained "Stability invariants (a correct
list can still be a broken one)" — enumerate what can invalidate an ordering and ask whether it can
fire while the user is looking, check the app is self-consistent where it has already declared a
stability policy, and distinguish *stable* from *frozen*.

**4. Detector proven on the PRE-FIX build.** A fresh read-only usability lens, told nothing about the
report, independently found it: *"the feed keeps re-flowing for ~2s after first paint — late
top-comment previews move cards down in 5 staged jumps, net up to +478px for card 8; the story you're
reaching for slides away."* It also surfaced a **new HIGH in the same class** that nobody had reported:
in `compact`, hovering a row inflates it 27px→127px and pushes every row below down ~100px, so the
pointer travelling toward a story lands on a different one — 9 of 9 matrix cells, reaching anyone who
merely picked the terminal or cyberpunk design.

**5. Fixes.**

- **Hover must not resize the hovered row.** `compact` revealed its actions in flow; they are now an
  overlay pinned to the row — reachable, out of flow, zero height change. Guarded in `layouttest`
  (verified 15px pre-fix → 0px post-fix, with a companion assertion that the actions are still
  revealed, so the guard cannot be satisfied by simply hiding them).
- **Late previews must not push the feed around.** The preview slot is now reserved from first paint
  (the story's comment count says one is coming) and the placeholder shares ONE `min-height` with the
  real preview — hand-matching two heights drifted 24px on the first attempt, which was the same
  defect again. Guarded in `topcommenttest` with deliberately slow comment fetches: **+478px → 3px**.
- **Engagement must not re-sort the list under the reader.** Scores stay live — the "warming up"
  banner, the sidebar counts and "Why #N?" must all reflect what you just did — but the ORDER of items
  already on screen is now pinned for the session, with new items appended and the pin cleared by an
  explicit Refresh or tab switch. This is the read-hide snapshot's principle (decide at load, never
  yank mid-session) finally applied to ordering as well as membership; the two policies had been
  contradicting each other in the same view.

**6. The guard for that last one was VACUOUS twice before it was real** — worth recording, because it
is now the fourth time this session. Version one asserted "the order didn't change" with a fixture
whose engagement never moved the ranking, so it passed happily with the fix bypassed. Version two
tried to re-derive a ranking context in-page and threw. Version three asserts the contract through the
app's own machinery — in-session order unchanged, **and a reload DOES reorder**, the second half
serving as the precondition that makes the first half mean something. Verified pre-fix-fails
(`306,304,303,302,301` → `301,306,304,303,302` in-session) and post-fix-passes.

Also fixed from that lens run: the third and final "clicks, saves, hides" sibling (`Settings.tsx:236`),
which the RankExplainDialog comment had itself flagged as still un-fixed.

---

## c3r16 — round 16 (certification attempt; NOT clean)

Seven lenses against a build from HEAD: **3 BLOCKER, 4 HIGH, ~19 MEDIUM**, so this round did not
certify. Three findings were regressions from the previous round's own fixes, which is the part worth
recording.

### Self-inflicted by c3r15's fixes

- **[HIGH usability] The session order pin silenced "Tune ranking".** Dragging a weight changed the
  score and moved **0 of 25** cards while two strings promised the feed "re-ranks live"; a filter
  round-trip left the order permanently scrambled (24/25). **[MEDIUM bug] The pin was also a
  component-local `useRef`**, so the core reading loop (feed → discussion → back) discarded the very
  thing it existed to preserve. *A stability mechanism must not freeze the controls whose whole job is
  to restructure what is being stabilised.* Fixed by moving the pin to module scope (like paging
  depth) and keying it on a **ranking-intent fingerprint** — weights, filters, follows, applied model
  — so deliberate changes re-order at once and incidental activity does not. Guarded three ways: the
  order holds under engagement, yields to a weight change, and survives the reading loop.

- **[BLOCKER OSS] The internal-reference scrub was staged but never committed.** See the correction
  above. `origin/main` was verified clean, so nothing already public was affected; the 62 unpushed
  commits were squashed into one clean commit after confirming the tree hash was byte-identical
  before and after the reset.

### Other findings fixed

- **[HIGH UI/UX] Global shortcuts stayed live behind every modal** — `j`/`k` scrolled the page under a
  dialog that had already set `body{overflow:hidden}`, `l` unmounted it, and **`s` silently saved a
  story the reader could not see**, its toast hidden behind the overlay. Shortcuts are now inert while
  any `[aria-modal]` is open; Escape still closes, and they resume afterwards.
- **[BLOCKER AI] Summaries put invented opinions in named real users' mouths** — including HN's
  moderator made to state a position on encryption backdoors, on 4 of 4 runs. This is the one AI
  defect no caveat covers: the others degrade into a summary a reader can discount, this one ascribes
  a fabricated position to a real, identifiable person under their handle. The prompt no longer asks
  for names, and `sanitizeAttributions` enforces it deterministically after generation — a handle may
  only be credited if it actually authored one of the supplied comments; anything else becomes "a
  commenter", while a handle merely mentioned in passing is left alone.
- **[HIGH AI] The "nothing to summarize" gate fired only at ZERO comments**, so a single junk comment
  still produced an invented discussion (four fabricated quotes from a one-comment thread). Now gated
  on actual substance.
- **[HIGH AI] Self-reinforcement at serve time** — leave-one-out had landed on behavioural affinity but
  not the content profile, so an engaged story scored highly for resembling itself (rank 5→1). Now
  excluded from its own profile when serving as well as when training.
- **[HIGH bug] The prompt fence covered comments and article text but not the post body or title** —
  the one field a submitter fully controls reached the model raw, carrying exactly the three vectors
  the defang exists to strip.

### Accepted, not fixed — the one residual BLOCKER-severity risk

**Prompt injection still succeeds** against the fence + defang: a hostile comment can still dictate a
card TL;DR. Measured rather than assumed, and a probe confirmed the defences do reach the request — so
this is a capability limit of a 1B on-device model, not an implementation gap. What DOES hold: false
attribution is now prevented, untrusted text is delimited and defanged, a thin thread is never sent,
output renders as plain text (no script, no data access), the feature is opt-in behind a large
deliberate download, and every summary carries a visible caveat plus a SECURITY.md section stating
exactly this. Recorded as an accepted residual risk rather than quietly downgraded.
