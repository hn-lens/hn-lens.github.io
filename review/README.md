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
review/SPEC.md  +  <base/_common.md>  +  <base/{lens}.md>  +  CURRENT STATE appendix
```

`review/SPEC.md` (added c3r24) is the AUTHORITY on intended behaviour and is durable — it changes
when the product changes, not every round. It exists because lenses previously had no tie-breaker:
when a comment claimed "X cannot happen" and X demonstrably happened, a lens had to GUESS whether the
code or the comment was wrong, and guessing "code" produces a false HIGH. One did, on ranking
normalisation that was working exactly as designed. Every finding now carries a classification —
CODE-WRONG / COMMENT-WRONG / SPEC-GAP / SPEC-WRONG — so the primary is never left guessing which side
to change.

Keep the spec and the appendix DISTINCT: the spec is durable intent, the appendix is this round's
volatile facts. Anything that belongs in both belongs in the spec.

The **CURRENT STATE appendix** is rebuilt every round from the live repo and injects only the
volatile facts:

1. **Running app URL** (the `vite preview`, rebuilt from HEAD before the round) and the **repo path**.
2. **`window.__hnlens` surface** actually exposed this round (grep `src/main.tsx`).
3. **What CHANGED since the previous round** — a diff, not a re-statement of the product. Durable
   behaviour belongs in `SPEC.md`; the appendix says what moved (`git log` + the fix batch), so each
   lens knows where the fresh risk is. If you find yourself restating intended behaviour here, put it
   in the spec instead — that is the file with authority.
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

---

## c3r17 — round 17 (certification attempt; NOT clean)

Seven lenses against a build from HEAD: **1 BLOCKER, 8 HIGH, ~19 MEDIUM**. The headline is not the
count but its composition — **five of the nine blocker/high findings were created or left half-done
by round 16's own fixes.** Three consecutive rounds have now each been made un-clean primarily by the
previous round's remediation, and that rate is not improving. It is the single most important signal
this loop has produced: at this maturity the dominant defect source is no longer the original code,
it is the repair.

### Self-inflicted by c3r16's fixes

- **[HIGH AI] The attribution sanitiser corrupted the text of essentially every summary.** c3r16 added
  `sanitizeAttributions` to stop the model putting invented opinions in named users' mouths. It
  matched *any* word appearing before a reporting verb — including the very noun the prompt asks the
  model to use — so real summaries came out reading "A A commenter…". Measured at **10 of 12 real
  summaries corrupted, with zero true positives**: the guard did no good and constant harm. Fixed by
  requiring handle shape, excluding common sentence subjects, and widening it to the output shapes it
  had missed. *A deterministic post-processor over model prose must be evaluated on real generations
  for false positives before it ships — correctness on the attack case says nothing about the 99% of
  ordinary output it also rewrites.*
- **[HIGH AI] The same hardening landed on one of three generation paths.** The thread summary got the
  fence, the sanitiser and the truncation refusal; "Ask this discussion" and the persona summary got
  none of them. Fixed by routing all three through the same handling. *An enumerate-the-siblings step
  is in the fix discipline precisely for this, and it was skipped.*
- **[HIGH bug] A background auto-retrain re-sorted For You under the reader ~15 s after they read
  anything** — story 309 jumping position 10 → 1 with no user action. c3r15 introduced the session
  order pin and c3r16 keyed it on a ranking-intent fingerprint; a retrain landing was still counted as
  a deliberate ranking change, which is the exact scenario `useFeed.ts` names in its own comment as
  the thing being prevented. Fixed by excluding the retrain from the intent fingerprint. *The code
  documented the invariant and still violated it; a comment is not a test.*
- **[BLOCKER OSS] Two shipped files named entries of the deliberately-private scrub list.** The whole
  design is that the list identifies the employer, so it lives only in gitignored notes — and then the
  round-15 changelog and the guard's own comments spelled out pruned entries while explaining why
  pruning was needed. Fixed by describing the pruning without naming what was pruned. *Writing up a
  privacy mechanism is itself a surface that mechanism has to cover.*
- **[HIGH OSS] The leak guard was fail-open.** c3r16 rewrote it to grade committed history, which was
  a real improvement, but `gitOut` collapsed success, "no match" and hard error into one empty string.
  Since `git grep` exits 1 for no-match and ≥2 for a malformed pattern, **an invalid pattern silently
  disabled all history checking and still printed a green line** — the same shape of silent-pass
  failure the rewrite existed to remove.

### Other findings fixed

- **[HIGH usability] On a phone the `compact` layout killed all four per-card actions.** Save, Not
  interested, Personalize and "Why #N?" were dead: a hover overlay revealed them, and sticky hover on
  touch moved them between `touchstart` and `click`. Scoped the overlay to `@media (hover: hover)`.
- **[HIGH usability] In `compact`, the TL;DR button really called the model and then rendered
  nothing** — the full cost, none of the answer. Now shows the summary where it is requested.
- **[HIGH design] Placeholder text was Tailwind's default `currentColor @ 50%`: sub-AA in 55 of 62
  design×mode cells, worst 2.39:1** — and Settings renders the default AI prompts *exclusively* as
  placeholder, so the least legible text in the app was the text a user most needs to read before
  editing it. Now uses the AA-normalised token.
- **[HIGH perf] Every comment-sort switch re-ran DOMPurify over every rendered comment** — 0.3 s
  desktop, 1.2–1.5 s on a mid-range phone, for an interaction that changes no comment text. Fixed by
  caching sanitisation. *The first attempt measured zero improvement: `stripHtml` called DOMPurify
  directly and bypassed the new cache. Count the primitive — a cache existing does not mean it is on
  the path.*

### The remediation claim was itself wrong

After the round-17 fix commit this log was going to record "all BLOCKERs and HIGHs closed". That was
false: **OSS H1 was only half-fixed** — the scrub-list naming (B1) was addressed, the fail-open guard
was not. It was found by re-reading the finding while preparing round 18, not by any check, which is
the same class of error as the c3r16 "staged but never committed" correction. The guard has since
been rewritten to close all five of its sub-gaps, each proven against the previous version in an
isolated throwaway repo (old: `clean`, exit 0 — new: loud failure) with a passing control:

- fails loudly on any git error, and validates the pattern compiles in **both** engines up front (the
  working-tree half is a JS `RegExp`, the history half is POSIX ERE — a pattern can be valid in one
  and rejected by the other);
- grades **all** history rather than only unpushed commits, since a leak becomes permanent the moment
  it is pushed and already-public commits were the one case excluded;
- grades every commit's **author/committer identity**, and the identity is now pinned repo-locally
  rather than inherited from a managed workstation's global config;
- drops its own self-exemption, because an exempt file is an unexamined path;
- states in the success line exactly what was examined, so "clean" can never read as broader than the
  check performed.

`--require-notes` is now actually wired: the gate passes it outside CI, so a renamed or lost notes
file fails the build instead of printing a warning nobody reads. The notes' prose-only scan targets
were moved into the fenced block, since the guard reads the fence and nothing else — anything
prescribed only in prose is by construction never enforced.

*Governing invariant, now stated in the script: it must never print "clean" about something it did
not examine — a missing pattern list, a git error and an out-of-range commit must each be visibly
distinct from a pass.*

---

## c3r18 — round 18 (certification attempt; NOT clean)

Seven lenses against a build from HEAD: **1 BLOCKER, 8 HIGH, ~30 MEDIUM/LOW**. The verifier pass
found something no individual lens could: **five separate instances of a comment asserting behaviour
the code does not implement.** That class has now produced seven instances across rounds and is the
most productive defect type this loop has, because a comment is what a reviewer reads *instead of*
checking. `review/base/_common.md` now makes auditing claims-in-code an explicit target for every
lens.

### Self-inflicted, again — and one of them by the round-17 guard itself

- **[HIGH OSS] The leak guard was blind to 6 of 7 realistic renderings of its most person-identifying
  pattern.** Round 17 wrapped the whole 26-way alternation in one `\b(…)\b`. A leading `\b` requires
  a word character BEFORE the match, so the one alternative starting with `@` could only ever fire
  when glued to a name — backticked (this repo's own doc style), bulleted, parenthesised, after a
  space, at line start and inside JSON all sailed through. The positive control written for it
  tested the single rendering that worked. Fixed with per-alternative boundaries, ONE constructed
  pattern driving both engines (they had silently diverged: JS had boundaries, `git grep` did not),
  and a **startup self-test that synthesises a sample for every entry and fails loudly if any entry
  cannot fire in either engine**. Also narrowed the digest exemption from whole-LINE to the digest
  RUN (a lockfile line carries a hash AND a resolved URL) and started grading untracked files.
- **[HIGH AI + HIGH bug, found independently by two lenses] `askThread()` had ZERO callers.** The
  wrapper carrying the attribution hardening — whose own comment reads "when one output path is
  hardened, every sibling that reaches the same model with the same data has to be as well" — was
  never called, because the Ask UI used the raw `generate()` primitive. On the same thread the
  summary rewrote a fabricated `"<handle> says…"` while Ask published it verbatim. The thin-input
  refusal and the sanitiser were likewise missing from the persona summary, which invented a
  two-paragraph cybersecurity biography for a REAL, named account whose entire activity was the word
  "same" — and cached it.
- **[MEDIUM AI + MEDIUM bug] The round-17 attribution sanitiser scored precision 0.00 AND recall
  0.00** on 28 real on-device summaries: it mangled prose on `but`, `also`, `and`, `had`, `its`,
  `treat`, `already` (twice manufacturing a second speaker), destroyed 3 of 3 topic-labelled bullets,
  and caught neither genuine fabrication — because 64% of the model's real ascriptions are
  capitalised and the rule explicitly skipped those.

The fix for the last two is structural rather than another patch. Output hygiene was applied BY
CONVENTION at each call site, which is why a new surface arrived unprotected three rounds running.
There is now a **`scripts/aiguardtest.mjs`** with two halves: a STRUCTURAL check that fails the build
if any file under `src/components` or `src/routes` reaches past the hardened wrappers to `generate`,
and a BEHAVIOURAL check that each path actually refuses thin input and rewrites false attribution.
Verified 9 of 13 failing before the fix and all passing after — and note the split earned its keep
immediately: `askThread`'s *behaviour* passed pre-fix (the wrapper was correct), so only the
structural half could see that the UI bypassed it.

The sanitiser was rewritten to anchor on POSITION (an attribution slot: start of text, bullet or
sentence) rather than on a vocabulary deny-list, which can never be complete. Its corpus is the
lens's own measured output — 7 prose false positives and 2 missed fabrications before, 0 and 0 after
— and it carries a **documented, tested known-miss**: a capitalised purely-alphabetic fabrication
("Kalsu says X") is indistinguishable from a topic heading ("Performance claims X"), so it is
deliberately left alone rather than corrupting real summaries.

### Other findings fixed

- **[HIGH perf] `SANITIZE_CACHE_MAX = 4000` sat inside the range of real threads.** Rendering is a
  cyclic scan, LRU's worst case, so the hit rate does not degrade — it collapses: 4,000 distinct
  bodies gave 100% at 0.6ms, 4,100 gave **0% at 1,042ms**. On a real 4,383-comment thread that was
  12.8s to open on a throttled phone, three to four times worse than the uncached code the cache
  replaced. Raised to 20,000, an order of magnitude above the largest thread HN has had.
- **[HIGH perf] `ThreadGist` re-derived its whole digest in the render body**, so toggling its own
  disclosure — which changes no data — cost 4,382 full HTML parses on a large thread. Memoised.
- **[HIGH UI/UX] "Tap ⋯ again to close" muted an author.** The clamp comment promised to flip the
  menu above its trigger; the code only nudged, sliding the menu OVER the ⋯ button. An item sat under
  the tap point in 22 of 55 cells, and 4 of 5 touch cells actually mutated mutes/follows. The flip is
  now implemented, and the fallback nudge is bounded so it can never rise past the trigger.
- **[MEDIUM UI/UX] `mobiletest` seeded Large text with `set({textSize})`**, which never writes
  `data-textsize` — so both checks named "at 320px + Large text" ran at the default size and could
  not fail. Now uses `setTextSize()` AND asserts the precondition, because a guard that silently
  tests the wrong state is worse than no guard. (Line ~225 of the same file already did it right.)

---

## c3r18b — the reported defect, and the detector that should have caught it

A developer reported: *"I read an item, came back, it was gone from For You, and I clicked what I
thought was that item — it was a different story that had moved into that position."*

Per the rule, this was NOT fixed directly. The question is which detector was blind.

**The class:** the list a reader returns to must be the list they left — same membership, same order,
same scroll offset — and any change must be visible and reversible. Position is an implicit contract
the reader acts on. The mis-click is the failure; the disappearance was only its cause.

**Why the lens missed it.** The usability brief tested *stability while sitting still* and graded it
clean, truthfully: nothing moved under a motionless reader. What no lens ever did was the composite a
real reader performs — **aim at an item, leave, come back, act, and check the click landed on the
thing you aimed at.** Worse, the brief's own bar licensed the failure: it said only an explicit act
"(Refresh, switching tab, changing a ranking or filter control, **reloading**)" may reorder or remove
items, so reload-triggered removal was permitted by definition and never questioned.

**The brief now carries an aim-and-act protocol** scored by IDENTITY across every excursion type,
with the rule that a permitted change still fails if it is silent, and that a disappearance must
answer three questions: did anything tell me, can I tell where it went, can I get it back.

**The detector was proven before anything was fixed.** A fresh read-only lens, told only to execute
its brief, independently reproduced the reported defect — **35 of 45 cells missed (78%)** — and found
a mechanism nobody had identified: past the three-minute list TTL, HN's own churn re-sorts the plain
feeds, so 10 of 25 cards moved on live Top with nothing added or removed.

### Root causes (four, compounding)

1. `main.tsx` set `scrollRestoration='manual'` while the app-side restore it cited had been deleted —
   the two files justified each other in a circle.
2. `FeedTabs` centred the active tab with `scrollIntoView({block:'nearest'})`; several screens down
   the tab strip is off-screen, so "centre this horizontally" scrolled the PAGE to the top.
3. The pinned order was module-scope (lost on reload) and For-You-only, so reloads re-ranked and the
   plain feeds had no stabilisation at all.
4. Read stories were swept on every page LOAD, so the story just read vanished and everything below
   it moved up a card.

### Fixes

Scroll is restored by **ANCHOR** — which card was at the top and by how much — not by pixel offset.
Offsets failed four times before, always the same way: the recorder kept sampling while the list
unmounted and the document collapsed, so a real 1245 became 37. An anchor cannot fail that way,
because a collapsing list has no cards to sample. Three guards keep it honest: no sample without
cards, none while the document is shrinking, and a debounce so a navigation-induced jump to the top
is cancelled by the effect being torn down first. A settling loop holds the anchor while late content
changes the height above it.

The pinned order is persisted and applies to **every** browsing feed; Refresh clears it and shows
HN's true current order. Read stories are swept **only** by an explicit Refresh, which reports how
many it took and offers Undo.

Measured on the lens's own matrix: **0/9 → 9/9** on For You desktop, and 9/9 on For You phone, Top
desktop and Top phone; Top past the TTL went from 10 cards moved to 0.

### Three self-inflicted regressions, all caught by the gate

Worth recording, because the loop's whole thesis is that repairs cause defects: adding a comment
block deleted an early return and **emptied the Read tab**; `readtest` still encoded the old
contract; and `clearReadSweep()` was documented as "used when reading history is deleted" and wired
to nothing — an eighth instance of the claim class, written the same day the class was named.

### Still open

The seeded-profile reload cell: the target is now PRESENT (it was gone) but still shifts one position
when two candidates genuinely leave the pool.

---

## c3r18c/d — two more developer reports, both routed through the detectors first

Two defects were reported directly while round 18's fixes were landing. Neither was fixed on sight;
both went through the rule — name the class, find the blind detector, upgrade it, PROVE it on the
pre-fix build, then fix. Both detectors rediscovered their defect unaided, and one of them found
something nobody had asked about.

### c3r18c — "scroll to the top, refresh, and the page moves down"

**The class:** a continuity mechanism must be an IDENTITY at its boundary conditions. Restoring
"where I was" has to be a no-op when the reader was already at the natural default.

**Why the lens was blind, and it was my own fault:** the aim-and-act protocol added hours earlier
says to pick a target *"several screens down"*. By construction it never exercises scrollY 0. The
brief now sweeps position as a matrix — very top / one screen / several screens / very bottom — and
states the strict rule at the top: **if there was nothing to restore, restoring must do nothing.**
It also names the tell-tale shape, a consistent downward jump of roughly the height of the chrome
above the list, which is a restore computing from the wrong origin.

**Proof before fix:** the upgraded lens reported `TOP_RETURN deltaPx:157, hit 0/3` against
`firstAbsTop:157` — the exact signature — while every other position measured `deltaPx:0`.

**Root cause:** at the top the anchor is `{first card, dy 0}`, and restoring it scrolls the first
CARD to the viewport top, which is 157px below the top of the PAGE.

Fixing it took four attempts and is worth recording, because three of them were wrong in
instructive ways. Clearing the anchor at the top helped but was RACY (1 run in 4 kept a stale
anchor, because clearing depends on a scroll EVENT and arriving at the top does not reliably fire
one). Refusing to restore a top anchor made the restore idempotent but did not help when the anchor
was stale rather than top. Adding a `pagehide` sample fixed it — and adding a sample in the React
CLEANUP alongside it broke tab-switch and discussion restore **5 runs out of 5**, because cleanup
runs while the list is unmounting and the document is collapsing. That is the identical failure that
defeated the four historical attempts at scroll restoration, reintroduced within a day of writing
the comment warning about it. `pagehide` is safe; cleanup is not. Seven consecutive green runs
followed.

### c3r18d — "the toolbar wraps onto two rows and looks terrible"

**The class:** a control row that wraps while leaving a line mostly empty is a layout defect **even
though nothing overflows**. Every overflow guard here measures `scrollWidth - clientWidth`, which is
**0** in this case, so the entire existing suite was structurally blind to it.

The brief now measures row SHAPE: bucket a row's children by vertical centre to count real rows,
then flag TWO distinct failures that look identical but need opposite fixes — **(a)** it wrapped
although the content would fit (a greedy `flex-1` spacer, or a cluster that can only move as a
block), and **(b)** it wrapped at an ordinary desktop width because the row is simply over-stuffed
and something has to get shorter. Reporting only one of the two misdiagnoses the other.

**Proof before fix:** 12 of 13 swept widths flagged, `2 rows, 54% / 45%`, page overflow 0 at every
one. The fixture had to be made *harder* first: headless has no WebGPU, so without a seeded prior
visit and a cloud key the toolbar renders two controls lighter than a real reader's and the failing
band disappears entirely.

Fixed by slimming the row — "Most replies" → "Replies", the decorative word "comments" dropped below
`xl`, tool labels icon-only below `lg` — giving one row from 600px up. `wrapqualitytest` now holds
it. Making the labels conditional immediately produced an a11y regression (icon-only buttons with no
accessible name), caught by the gate and fixed with explicit `aria-label`s.

### The duplicate-name pattern

Collapsing four blocks into one row created **three** pairs of controls sharing an accessible name
in a single sitting: toolbar *Summary* vs panel *Summarize*, toolbar *Ask* vs submit *Ask*, and the
hide toast's *Undo* vs the placeholder's *Undo*. Each surfaced as a strict-mode failure in a harness
rather than as a design review finding. Renamed to Summary/Summarize, Ask/Send and Undo/Restore —
noun for the thing, verb for the act.

---

## c3r19 — round 19 (certification attempt; NOT clean)

Seven read-only lenses, run against the post-c3r18d tree. **The bug lens found 2 HIGH, 3 MEDIUM,
3 LOW and an 8-item claim-audit cluster; the AI lens found 5 HIGH.** Not a clean round, so this is a
change round and cannot certify itself — c3r20 follows.

### What each lens found, and what was done

**OSS release (H1, H2, 4 MEDIUM).** Nine untracked files — including `src/lib/session.ts`,
`src/lib/readSweep.ts` and `src/components/ui/Logo.tsx` — were already imported by tracked code, so
the next commit would have broken the public build. Staged. `logo_design.md`, a spent
"Target Audience: Coding Agent" brief, was removed rather than published (same category as
`public/mocks/`). `scripts/gen-assets.mjs` still drew the RETIRED mark, so re-running it would have
silently reverted the brand: it now renders from `public/icon.svg`, the single drawing. Rename
finished in `CONTRIBUTING.md` + `.github/`; `LEAKCHECK_OPTIONAL=1` documented for public clones.

**leakcheck grew three holes of its own, all closed and all proven.** `git ls-files` QUOTES
non-ASCII paths, so those files threw on read and were skipped *silently while still being counted
in the "clean" total* — a file could be published unread by the guard that cleared it. Now `-z`, and
an unreadable listed path is a hard failure. Committed BINARIES matching the pattern were dropped
entirely by the tree scan. Fixing that immediately produced a FALSE POSITIVE on a regenerated PNG
(four bytes of pixel data spelling a pattern), so binaries are now scanned `strings`-style, with the
resulting recall gap stated in the source rather than glossed. Proven by an 8-check unit proof plus
an end-to-end proof that plants a leak under a quoted filename and confirms the real script fails.

**Performance (2 HIGH, 2 MEDIUM).** The in-thread search index was built on EVERY discussion open —
a DOMPurify sanitize plus a DOM walk per comment — so readers who never search paid for all of it,
ahead of the comments they were waiting for. Now built on first search: **1601 → 401 parses** on
open. New `searchindextest` (9 checks; 3 fail pre-fix). For the sanitize LRU cliff, every eviction
policy was *simulated* rather than argued: LRU, FIFO and drop-oldest-half all collapse to **0%** hit
rate on a cyclic scan, and only refusing to insert degrades gracefully. LRU was kept deliberately,
the comment's false "order of magnitude to spare" (it was 4.4x) replaced with the measured boundary
— ~18 largest threads OPENED, but only 4 SEARCHED — and that residual pinned by an assertion so it
cannot drift unnoticed. `db.seen`, the one uncapped table and one that is read into a Map on the
feed's critical path, is now capped.

**Usability (HIGH-3 + MEDIUMs).** Clicking the site name on a card re-sorted 14 of 25 visible cards
and carried the reader **2,026px** from what they were reading, announced only as "Following X".
Root cause: a card-level TEACH was treated as a request for a new ranking. The precedent was already
in the file — a background retrain is deliberately excluded from `rankIntent` for exactly this
reason — so follow/mute joined it. The first attempt re-armed the anchor restore and made it WORSE
(it replays a possibly-stale anchor, teleporting the reader 1,200px); the hold now pins the reader's
live on-screen position. Lens's own real-click probes: **Δ−2026 → Δ0, 14/25 → 0/25 moved, target
HIT** on all three controls. The dismissal placeholder now keeps the replaced card's measured
height, so the row no longer collapses 86–147px in 10 of 14 layouts (**0px shift in every layout**).
The "About topics you read about" chip now carries the same guard as the soft block twelve lines
below it, so it cannot credit a signal that contributed 0.00. The `?` help gained an "On a
discussion page" section, because `s`/`l`/`a` are rebound there and a flat list could only be wrong.

**UI/UX stress (1 HIGH, MEDIUMs).** The five-control action row measured 188px inside a 178px card
in `grid`/`masonry` at three columns, so "Open on HN" dropped alone onto a second line at 20% fill —
on every card, reachable purely by choosing the Emerald or Claymorphism colour scheme. Wrapping
cannot fix a row that is too wide, so inside that breakpoint the gaps close and the targets trim to
32px: **0 of 126 desktop cells wrap** (was 84). Keyboard focus rings were clipped to a sliver by
three `overflow` ancestors — every feed tab, every `by <author>` link, and the discussion tools —
and are now drawn inward inside those containers, clip-proof by construction.

**Design & theme.** `Logo.tsx` claimed the mark "respects the contrast normalisation those tokens
are guaranteed to satisfy" while its faintest tier aliased `--border`, which the codebase itself
documents as a deliberately sub-3:1 hairline. Re-aliased to `--edge` (the >=3:1 non-text token),
which makes the claim true rather than softening it. The tray header no longer borrows
`.bg-surface`, whose neumorphic treatment in bento/clay painted a raised shadow inside a bordered
panel.

**AI/ML (5 HIGH).** The attribution guard enforced MEMBERSHIP ("did this person comment here") while
its own comment promised AUTHORSHIP ("never let a summary attribute a claim to a person who did not
make it") — and 11 of 21 named attributions in real generations (52%) were wrong in exactly the gap
between the two. Attribution now requires EVIDENCE: the claim beside a handle must share distinctive
words with what that handle actually wrote, or the point survives and the name is dropped. The
`**handle**:` bullet — markdown's own way of labelling a bullet, and the shape the model actually
emits — was not matched at all. The persona summary invented a biography for a named person on
ADEQUATE input, so it is now checked for groundedness in that person's own activity. `looksTruncated`
tested only the final character and passed a truncation ending `Overall, "simonw"`, which was then
cached and re-served forever; it now asks whether a sentence was completed. Finally, the learned
ranker was INERT in a realistic noisy history — spread 0.011 against popularity's 0.49, unreachable
at any slider setting — because the term's authority was proportional to how separable the history
happened to be, varying **145x** between readers. The pool's own dispersion now sets the scale, the
floor slides with the fit's held-out AUC (recorded on the model) so a chance-level model stays quiet,
and the explainer consumes the same transform — the reconciliation the lens predicted would break
did break, and is fixed and guarded.

**Claim audit (8 items).** All eight false statements corrected, including one (`useFeed.ts` "or a
tab switch clears the pin") that had been reported in an EARLIER round and survived into this one.
Three said `localStorage` where the code uses `sessionStorage` — the store whose lifetime semantics
are the entire basis of the session model. `html.ts` claimed three sites had been factored together
"so they cannot drift again" when only two had: `ThreadGist` kept a byte-identical private copy,
which is now deleted in favour of the shared `commentToText`. `departedRef` was computed, stored and
never returned, so three comments promised a notice no surface could show; it is now rendered.

### New guards (all proven pre-fix-FAILS / post-fix-PASSES)

`searchindextest` (9) · `gisttest` jump-behind-a-collapse-pill (5) · `feedcontinuitytest` teach-does-
not-move-the-reader (4) + engagement-cost (2) · `discussionviewtest` tool dismissal / focus / empty
tray (8) · `aiguardtest` authorship + persona groundedness + truncation (17) · `rankergatetest`
scale invariants + earned authority (8). `feedstabilitytest`'s stale "a RELOAD does re-order"
precondition — which asserted the very behaviour a previous round removed — was replaced with a
three-state contract (in-session holds / reload holds / Refresh re-orders).

**Gate: 54/54 green** (up from 53 with the new harness). Nothing committed.

### Documented residuals (not regressions)

Searching 5 of the largest threads in one tab still crosses the sanitize cap (asserted, so the
boundary stays honest). Dismissing 5 stories inside one viewport fills it with placeholders until
the next Refresh — the alternative is the yank the placeholder exists to prevent. A capitalised,
purely-alphabetic fabricated handle remains indistinguishable from a topic heading when it is NOT on
the allow-list. Prompt injection on the 1B on-device model remains an accepted residual.

---

## c3r20 — round 20 (certification attempt; NOT clean) — IN PROGRESS

Seven lenses. **Not clean:** bug 1 HIGH / 6 MEDIUM / 4 LOW + 12 false claims; usability 1 HIGH /
5 MEDIUM; UI-UX 1 HIGH / 3 MEDIUM; design 1 MEDIUM; AI 2 HIGH / 4 MEDIUM; perf 1 HIGH / 3 MEDIUM;
OSS 1 HIGH / 6 MEDIUM. Several are SELF-INFLICTED by round 19 — recorded as such, because the
self-inflicted rate is the number that says whether the loop is working.

### Fixed so far in this round

| origin | finding | fix |
|---|---|---|
| new-from-my-fix | **OSS H1** — the pre-push leak hook was staged mode `100644`, which git silently refuses to run, and `core.hooksPath` was unset. Its own comment called it "the last line of defence"; it was disarmed twice over. | mode `100755`, `core.hooksPath` set |
| pre-existing | **OSS M1/M2** — leakcheck never examined the **index** (exactly what `git commit` publishes) or **path names**. A leak staged and then edited out of the working copy was invisible. | both scanned; the summary line now states them |
| new-from-my-fix | **Bug M1** — dismissal placeholders survived Refresh forever: `startNewSession()` was the only thing that cleared them and had **zero callers**, so its "Called by an explicit Refresh" doc was false. | folded into `resetFeedPosition`; the dead function deleted |
| new-from-my-fix | **Bug M2** — the placeholder's height lived in a ref, so a RELOAD (which continues the session) collapsed it and lost 86–103px — the exact jump it exists to prevent, on the one navigation the model calls safe. | height persisted beside the id in `sessionStorage` |
| new-from-my-fix | **Bug M3 / AI MEDIUM** — "Why #N?" bars stopped summing to the row beside them (5/20 cards, 22/60 at max slider). The outer table pays its rounding residual to its largest row, which once the slider is raised IS the learned row, so the bars were reconciled against a figure no longer displayed. | reconcile the outer table FIRST, then target the bars at the displayed figure. **0/60 now** |
| new-from-my-fix | **AI HIGH-1** — authority was uncorrelated with skill. Flooring the divisor bounds only a model whose predictions barely vary; an OVERFIT fit sails past it. On 20 seeded no-signal histories the learned term reached a spread of 1.29 against popularity's 0.46 and moved cards up to 39 places. | skill (AUC, averaged over 3 strided folds and **discounted by its own standard error**) now scales AMPLITUDE, bounding both ends. Measured: no-signal spread 1.29 → **0.26**, and **0/20 seeds** where learned outweighs popularity. Verified across three regimes — separable 48.8→10.5, noisy 48.3→33.1, **unlearnable correctly inert** 49.8→50.5 |
| incomplete-sibling | **AI HIGH-2** — the attribution guard rewrote **3 of 20** realistic fabrication shapes. It only understood `<name> <verb>`, so "According to X", "Per X", "As X puts it", "X's position is", a "— X" byline, and half the reporting verbs walked through, and survivors are cached. | verbless shapes added, verb list extended, `User X` prefix handled, numbered bullets covered. **16/20 caught, 7/7 miscredits, 3/3 true attributions preserved, 6/6 prose untouched** |
| pre-existing | **Perf HIGH** — the item pool ran at concurrency 32 on the stated reasoning that the host speaks HTTP/2. It negotiates **HTTP/1.1**, capped at 6 connections, so 26 of every 32 requests queued *while their own deadline ran*; a third aborted before dispatch and For You silently ranked 57–70 candidates instead of 90. | concurrency 6 — no throughput lost, because 6 was what ran anyway — and the false claim replaced |

**Gate: 54/54 green** after each batch.

### Still open in this round

Bug H1 (the new `departed` notice renders ~7ms then vanishes), M4 (gist scorer), M5 (a complete
bullet-ending summary is classed truncated and never cached), M6 (whole article pages in the
sanitize LRU), and 12 false claims. Usability HIGH-1 (the reserved top-comment skeleton collapses
when no preview materialises, freezing the anchor recorder's collapse guard) + 5 MEDIUM. UI/UX F1
(the action row still orphans at 320px on the DEFAULT layout, and my own fix comment says
"5 x 32 = 160px" while the code writes `2rem` = 36px under large text), F2–F4. Design MEDIUM
(Settings section nav selected state never reaches 3:1). AI MEDIUMs. Perf MEDIUMs. OSS MEDIUMs
(symlinks, brand logos, the ListenButton privacy claim contradicting three shipped files,
SECURITY.md's "no patched version", THIRD_PARTY_NOTICES coverage).

---

## Process v2 — convergence mode (adopted 2026-07-26, mid-round-20)

Rounds 16–20 all failed to converge. The diagnosis is not that the lenses are too strict: measured
across round 20, **8 of the 15 findings worked through were created by round 19's own fixes** (OSS
H1, Bug H1/M1/M2/M3/M5, AI HIGH-1, UI-UX F1's false px claim). A loop producing roughly one new
finding per fix cannot terminate, whatever the review side does.

Four mechanisms produced those regressions, each with evidence from the session:

1. **Guards written AFTER the fix encode what was done, not what should be true.** `searchindextest`'s
   "running a search builds the index" check passed while the search never ran (wrong selector, and
   the threshold was already satisfied by the open). The bullet-truncation exemption was asserted
   `false` in a guard while the exemption was inert.
2. **Explanatory comments are the largest single defect source.** Nearly all 12 of round 20's false
   claims are prose written to explain a fix.
3. **Sibling enumeration was asserted rather than performed.** `explain` object identity was fixed
   while `reasons` — the adjacent prop, same shape, same file — was not.
4. **Features were added during fix rounds.** The `departed` notice was new capability introduced
   while fixing a claim audit; it was a HIGH in the next round.

### Rules now in force

1. **No narrative comments in source during a fix.** Reasoning lives here. Code states only what is
   mechanically true.
2. **Feature freeze** until a round converges. Defect removal only.
3. **Failing test first**, written from the lens's own words, before touching code.
4. **Batches of ~5**, then gate, then a diff-scoped read-only pass over only those changes.

Plus: **prefer deletion** over building something better, and **record every finding's origin**.

### Termination (changed)

"Zero findings" was unreachable by construction. A round now CONVERGES when:

- zero BLOCKER/HIGH, and
- zero self-inflicted regressions, and
- every MEDIUM either fixed or explicitly accepted in writing with a rationale.

The self-inflicted rate is the signal that says whether the process is working.

### c3r20 batch 1 (first batch under Process v2)

Four findings taken: delete the `departed` notice (Bug H1); remove the read-sweep seed; the
story-card action-row wrap (UI-UX F1); the Settings section-nav selected state (Design MEDIUM).

**Deletions rather than repairs, per the new rule.** The `departed` notice was a feature added
during a fix round, was on screen for 7ms, and accumulated into a ref inside a `useMemo` (unsound —
a memo may recompute, and each recomputation re-added the same departures). It was removed, along
with `holdOrder`'s now-pointless `{ list, departed }` wrapper. The read-sweep SEED was likewise
removed rather than repaired: `getReadSweep(currentlyRead)` wrote the hidden set on its first call,
so the outcome depended on whether the Dexie read query had resolved when that call happened —
which made the first load of a session race any early write of read history. That is what made
`readtest` fail in the gate while passing standalone, four times. The set now starts empty; the
accepted cost is that an established reader sees their read stories once more until they Refresh.

**The diff-scoped pass earned its place immediately.** Against a batch of four, it found:

- **HIGH** — the seeding still existed in a SECOND place (`useFeed.ts` `readSnapshot` queryFn), and
  `dataUsage.ts` fires a bare `invalidateQueries()`, so deleting any unrelated data category re-ran
  it: 3 read stories vanished with no notice and no Undo.
- **HIGH** — the new `flex-wrap: nowrap` was layout-agnostic and broke `newspaper` (47px page
  overflow at 320px, "Open on HN" clipped away). Two further attempts were needed because
  `:not([data-layout='newspaper'])` matches `body`; it needs `html:not(...)`.
- **MEDIUM ×4** — an orphaned comment for the deleted ref, `holdOrder`'s doc still promising a count,
  the one-field wrapper, a `> *` selector hitting the Personalize wrapper span rather than the
  button, and six places still describing the removed seeding (including `types.ts`, the pref's own
  definition, and `AGENTS.md`).

All fixed within the batch. **Under the old process every one of these would have surfaced as a
round-21 "new-from-my-fix" finding.** Two pre-existing harness races were also fixed: the
`hnaccounttest` import-label read (1 failure in 2 runs) and `uitest`'s Read-tab check, which
accepted only one of the tab's three valid empty states.

Gate 54/54.

### c3r20 batch 2

Five findings: the collapsing top-comment slot (Usability HIGH-1); the ⋯ menu stranded by a rotate
(UI-UX F2); the `^`-anchored role-label defang (AI MEDIUM); leakcheck following symlinks (OSS LOW-1);
and `uitest`'s Read-tab check, which matched empty-state PROSE and so failed on the one state its
list did not name.

**Usability HIGH-1** had two halves. Cards reserve ~65px for a lazily-fetched top-comment preview,
and when the fetch settled with nothing usable the slot was REMOVED — so cards below the reader
jumped −65px while they sat still. Worse, the anchor recorder skips sampling while the document is
>200px below its high-water mark, and that mark never ratcheted down, so after ~3 collapses the
recorder froze for the session: a reload landed 400px away at a 30% no-preview rate and 1,200px away
at 60%. The slot is now held (an invisible spacer), and the watermark follows the page down.
Measured after: document height constant, anchor offset 0, reload restores the same story at 0%,
30% and 60%.

**The ⋯ menu** was being re-clamped on resize, but after a rotate the card has usually moved to a
different column, so there is no correct position to clamp to (measured 0% visible, 3/3, no
self-heal). It closes instead.

**The read sweep's guard was position-fragile.** `feedcontinuitytest`'s teach check picked "the
first `.sc-meta button` on the card at (640,150)", which on a text post is the author control, not
the domain chip — so batch 1's height changes silently moved it onto a card where the click recorded
nothing. It now finds the chip by its Follow/Unfollow title, and compares the followed set against a
snapshot taken before the click (the chip toggles, so "non-empty" was the wrong assertion).

**The diff-scoped pass again found two HIGH in the batch**, both of them a fix that did one half:

- `leakcheck`'s symlink fix covered the WORKING TREE only. `git grep` does not search mode-120000
  blobs, so a symlink leak that was committed and then deleted from the tree still reported clean —
  while the summary line claimed it had examined every commit. Committed symlink targets are now
  read via `ls-tree` + `cat-file`.
- The role-label defang replaced `^`-anchoring with an allow-list of preceding characters, which
  missed backticks, brackets, punctuation, smart quotes and — worst — `**system:**`, the exact
  markdown-bold impersonation shape the function's own docstring names. It now uses a negative
  lookbehind for `\w`, which covers every shape while leaving `filesystem:` and `12:30` alone.

It also found **four false comments**, three of them created by this batch adding a correct comment
BELOW the stale one instead of replacing it — so a reader met the false claim first. That is rule 1
being violated in the same session it was adopted; all four were deleted rather than rewritten.
And it found that the only existing role-label assertion (`llmcachetest`) was itself `^`-anchored,
so it passed identically before and after the fix — a guard mirroring the bug it was meant to catch.
Both the payload and the assertion are now mid-line.

Gate 54/54.

---

## Two developer reports, both routed through rule #8

Neither was fixed directly. Each was diagnosed as a CLASS, traced to the lens that should have
caught it, that lens's brief was upgraded, and the upgraded detector was PROVEN to rediscover the
defect on the unfixed build before any code changed.

### Report 1 — "the favicon is not very readable compared to the logo"

**Class:** a brand asset validated only at the size and background it was AUTHORED at, never at its
smallest RENDERED size on the surface it lands on. The favicon is drawn by browser chrome, outside
the app DOM, so no lens that drives the page could ever see it — and when the icons were regenerated
in c3r20 they were inspected at 220px.

**Lens:** design & theme. Its matrix is design × light/dark × layout *of the running app*; brand
assets were not in it at any point. Brief gained section **1c — brand assets at their rendered
size**: rasterize each shipped asset at 16/32/180/192/512, composite over BOTH browser chromes,
count how many elements survive, and compare against the in-app rendering of the same mark.

**The detector then found the real cause, which was not the one reported.** Not size — palette.
Four of the mark's six elements were **1.30–1.77:1** on their own tile at EVERY size, 512px
included, and the tile was **1.02:1** against dark chrome. The proof it was not a size problem: the
same artwork drawn from tokens in-app at 24px was more legible than the shipped favicon at 32px.

**Fixed** by inverting to a light tile (`#F4F6FA`) with a darkened glyph: elements below the 3:1
floor **4 → 0** (outer 3.72, inner 9.46, accent 4.51). Those are AUTHORED hex ratios, not painted
pixels — c3r25 measured the outer tier at 1.32–1.80:1 once rasterised at 16–32px, because it is a
16-unit bar in a 512 viewBox. SPEC §7 exempts logotypes, so this is recorded, not reopened. Both chromes now have a high-contrast
element — in light chrome the glyph (7.81 / 3.72 / 3.07 against the strip), in dark chrome the tile
(14.88). The detector also found a **duplicate source**: `favicon.svg` was a byte-identical copy of
`icon.svg` with nothing keeping them in sync, while `gen-assets.mjs` read one and the browser
rendered the other — so recolouring would have shipped a tab icon disagreeing with every raster.
`favicon.svg` is deleted; `index.html` and the manifest point at `icon.svg`.

### Report 2 — "read a discussion to the bottom, went back, ended at the bottom of the feed"

**Class:** a skipped restore treated as "do nothing", which equals "go to the top" only when the
page is ALREADY at the top. On an in-app return React Router keeps the window offset, so the reader
inherits the offset of the page they left. `Feed.tsx` stated the false premise in a comment: *"if
the remembered position was the top, restoring can only ever mean 'do nothing'."*

**Lens:** usability's aim-and-act sweep — which had run this exact excursion in c3r21 and reported
16/16 hits. It varied the feed position and the excursion TYPE, but never **how far the reader
scrolled inside the excursion**; with a short discussion the inherited offset is ~0 and "do nothing"
is indistinguishable from correct. Brief now requires reading at least one excursion of every type
to its END, calls out the top-start cell as the highest-yield in the matrix, and states the general
rule: *whenever a restore is skipped, ask what the position will be if it is skipped.*

**Proven pre-fix:** the upgraded detector independently reproduced it — 0 → **4,032px** on Top,
0 → **12,405px** on a 372-comment thread, 8/8 — and found three more in the same class, including
the "Hacker Lens" wordmark (`<Link to="/">`, 0 hit / 8 miss) the reporter had also used.

**Fixed and guarded.** The no-anchor branch now scrolls to the top; `dy` is no longer clamped to
`>= 0` (which could not express "the card started below the viewport top" and snapped every near-top
start to exactly 157px, the chrome height). New guard in `feedcontinuitytest`, proven pre-fix
**y=8147 on the wrong story** / post-fix **y=0 on the right one**.

**Still open:** the detector's HIGH-2 — a feed-TAB switch discards the reader's place (2,406 → 0)
because leaving a feed clears its own anchor. Two attempted fixes were reverted: gating the clear on
a recent user-scroll event blocked legitimate programmatic scroll-to-top, and the intermediate state
left a y=0 anchor surviving the Refresh that is supposed to release it. The anchor now survives the
switch (miss down from 2,402px to ~205px) but the cell is not correct. Carried forward rather than
traded for a regression.

Gate 54/54 throughout.

---

## c3r21 — round 21, then four developer-directed HIGH fixes (2026-07-27)

Seven lenses, then four independent validators that re-read every cited `file:line` and re-ran every
repro. **69 raw findings → 64 distinct; 0 FALSE**; 58 CONFIRMED, 6 PARTIAL. 4 HIGH / 15 MEDIUM after
validation. Three lens HIGHs were downgraded by validation (both OSS ones, and the "Why #N?" read
count); one lens HIGH had its **root cause misattributed** and the validator relocated it.

Ranked report: `/tmp/c3r21_RANKED.md`. Lens reports `/tmp/c3r21_{usability,uiux,design,ai,bug,perf,oss}.md`.

### The developer directed the resolution of all four HIGHs

Not routed through rule #8, because these were **product decisions**, not defect reports — the
developer chose what the product should guarantee. Recorded here because two of them delete
subsystems that several rounds of findings had been accreting around.

| # | Finding | Direction taken |
|---|---|---|
| H1 | Fabricated attributions survive the sanitiser (4–5 shapes; two lenses found partly-disjoint hole-lists) | **Stop correcting output entirely.** Guarantee the input instead; disclaim the output |
| H2 | Thin-input gate defeated by any non-empty body | Add a real substance floor |
| H3 | Auto-retrain freezes the tab 759ms at 1× / 3.9s at 4× | Retrain only after ≥30 new engagement events AND only while `document.hidden` |
| H4 | Scroll restore dead on any round trip through For You | **Delete the restore.** Arriving at a feed goes to the top |

### What was deleted, and why that is the fix

**333 lines from `llm.ts`** — `sanitizeAttributions` and its five branches, `looksLikeHandle`,
`looksLikeTopic`, `supports`, `claimTerms`, the four attribution regexes, `isGroundedIn`, and
`looksTruncated`. Three rounds running, the sanitiser was found with a new hole; "did the model say
something false" is not decidable and a regex over prose cannot make it so, and a partial sanitiser
advertises a guarantee it cannot keep. `isGroundedIn` went with it (which closes MEDIUM ai-M1 by
deletion rather than by wiring it to a second path). `looksTruncated` went too, at the developer's
choice — **accepted consequence: a truncated summary is now cached and re-served until refreshed.**

**~160 lines from `Feed.tsx` plus the whole anchor storage layer** — recorder, watermark, debounce,
`pagehide` sampling, restore, settling loop, `getFeedAnchor`/`setFeedAnchor`/`clearFeedAnchor`, the
`hn:anchor` session key, and `showingPrevious` (whose only consumer was the restore, so the H4 root
cause disappears with it). Paging depth and pinned order are KEPT.

### The replacement contract: the app vouches for the INPUT

Deleting the output guarantee makes the input guarantee load-bearing, so the same change had to make
it true. `commentsForPrompt` / `articleForPrompt` / `personaForPrompt` now decide what fits each
budget, and every provenance figure is counted from THOSE — measured 16 available → **9 sent**. The
refusal paths claim no sources at all, because nothing was sent. The disclaimer names attribution
explicitly and now also appears on Ask, which renders model text but does not use `SummaryActions`.

`aiguardtest` was rewritten from an output-hygiene guard into an **input**-hygiene guard.

### The diff-scoped pass paid for itself again — 6 HIGH, all self-inflicted

Run against only the eight changed files, before declaring the batch done:

- **The 30-event retrain gate was permanently unreachable.** `.limit(MIN_NEW_EVENTS * 8)` caps ROWS,
  not matches; most of the log is `impression`, which is not engagement, so the window filled with
  impressions and the count never cleared the floor — and `since` is pinned to the model's own
  training time, so the state never clears. Measured 200 engagements → counted 24 → skipped. Now
  bounded by MATCHES via `until`. **The guard could not see it either**: its fixture seeded only
  `open_link`. It now interleaves impressions 12:1.
- **Provenance was fixed for comments and not for its siblings** — article (3,000 words claimed vs
  451 sent) and persona (12 claimed vs 9 sent). Exactly the "fixed one instance of a class" failure
  the fix discipline exists to catch.
- **The disclaimer — the sole replacement for the deleted machinery — was unguarded and missing from
  Ask.** Both fixed; a build-breaking assertion now covers every surface that renders model text.
- Plus 9 false claims left by the deletions (`main.tsx` still described restoring "by ANCHOR";
  `AGENTS.md` still documented the recorder, `startNewSession()` and "the restore must be a NO-OP";
  `test.mjs`'s registry still cited "the sanitiser"), and a dead `reorderingUntil` ref.

### Two guards were vacuous and are now real

`llmcachetest`'s thin-thread fixture used an 11-character comment, which `collectComments` drops at
its 40-character minimum — so it re-tested the empty-thread case and **a full revert would have
passed it**. It now uses a >40-char junk comment and adds the scrap-of-self-text case. And the
`personalization-proof` auto-train assertion encoded the OLD contract; it now proves both halves
(does not run while visible, does run once hidden).

### One self-inflicted regression, caught and fixed inside the batch

Making the arrival scroll `instant` exposed a race the smooth animation had been masking: the offset
inherited from the route just left is applied against whatever height exists at that instant —
measured, **7149 clamped to 35 against an 835px document**, and stayed. A single `scrollTo` fired
before it and lost. The fix re-asserts the top until the list stops growing (1500ms) or the reader
takes over. **The invariant that fix assumes was written down and tested**: wheel → y=1500, End →
y=2495, undisturbed → y=0, all now permanent assertions in `feedcontinuitytest`.

### Folded into the briefs

`_common.md` gained both accepted design decisions, so no lens re-reports them. `ai-ml.md` gained the
full statement of what the product does and does not guarantee, and redirects the lens's effort onto
the four input obligations — with the note that a provenance line overstating by even one comment is
worth reporting, since it is now the only claim the product still makes about an AI summary.

**Gate: 55/55 green** (54 + the new `autotraingatetest`). Not committed.

---

## c3r21 MEDIUM remediation (2026-07-27) — 13 fixed, 2 accepted

Worked in four gated batches. Every fix has a guard; three guards were extended and three added
(`leakcheckselftest`, `dialogreachtest`, plus new sections in `aiguardtest`, `wrapqualitytest`,
`personalizeliveupdatetest`).

### Fixed

| # | Finding | Fix |
|---|---|---|
| M1 | Filtered first page dead-ends; qualifying stories unreachable | `Feed.tsx` auto-advances past a fully-filtered leading run and mounts the sentinel in the empty branch. Sidebar `recentRead` now draws from the full history, not a `limit*4` window, so the two read surfaces agree again. Repro: 0 → 30 cards reachable; Read tab 0 → 12 |
| M2 | Off-topic summary accepted and cached | Closed by DELETION in the earlier H1 batch (`isGroundedIn` removed with the rest of output correction) |
| M3 | Provenance not derived from what was sent | Closed in the H1 batch; article + persona siblings closed in the diff-scoped follow-up |
| M4 | `getCachedItems` one IndexedDB round-trip per id | Single `bulkGet` for the uncached remainder. **414ms → 49ms** at 2500 ids. Same fix applied to the two sibling loops in `useLocalData.ts` |
| M7 | Keyboard-help dialog unreachable by keyboard, no close control | Modal ref moved from the overlay to the scroll container + a real close button. Sibling `SignalsDialog`/`HiddenDialog` had the same defect (sticky header + separate scroll body) — fixed via a new opt-in `initialFocusRef` on `useModalBehavior`. All dialogs now KEYBOARD-SCROLLABLE |
| M8 | Discussion toolbar wraps badly on phones | Count+Sort became one cluster (no more orphan line at 6% fill) and the action cluster is right-pinned only at `sm+` (its line now starts at the left edge, not ~60% across). 3-row case eliminated; bar height down at every default-font phone width (320: 148→137, 360/390/440: 120→106) |
| M9 | "Restore" sends the story to the bottom | Un-hide the DB record BEFORE clearing the placeholder — the order the sibling toast-Undo path already used. Position preserved on all three paths |
| M10 | "Why #N?" labels the interaction count as "stories you've actually read" | Gate clauses split so each number matches its label; the too-few-positives clause says what is actually short. The false phrase is gone in all 4 cells |
| M11 | Pre-push leak hook armed by nothing | `prepare` script runs `scripts/arm-hooks.mjs`, so a fresh clone self-arms on `npm install`. No-ops outside a git worktree and never fails an install |
| M12 | Llama 3.2 licence unattributed | `gen-notices.mjs` now reads the model catalog and emits an AI-models section carrying "Built with Llama." **A catalog model with no license entry is a hard error**, so adding a model cannot silently ship it unattributed |
| M13 | Leak guard claims "all path names" but skips history | Added a one-command scan of every path ever added across all refs; summary states the real scope. Repro case B flipped MISS → CAUGHT with A and C still CAUGHT |
| M14 | `figure`/`details`/`thead` families missing from block-tag lists | Added to both extractors. Fixes fused text in the reader, the model input and the ranking term profile at once |
| M15 | Injection defang missed `model:` / `__Gist:__` | Added `model`, `tool`, `human` (the wire/transcript roles) and the `__…__` emphasis form. `ai` deliberately excluded — two characters, no provider uses it, collides with prose. Five false-positive controls asserted unchanged |

### Accepted, not fixed (with rationale)

- **M5 — For-You cold start (~1638ms to first card, 113 firebase requests).** Architectural: the
  ids-only HN API forces an N+1 over the candidate pool. The verified alternative is the Algolia
  `front_page` rewrite (1 request, 96KB, 642ms), which is a substantial change to the fetch layer and
  would invalidate the firebase-mocking hermetic harnesses that most of the suite is built on.
  Deferring is a deliberate trade: doing it immediately before a verification round would put the
  suite's own foundations in the same change as the thing being verified. Already a documented
  long-standing deferral in `AGENTS.md`; this round confirms the measurement rather than the fix.
- **M6 — returning from a discussion to a 90-card feed blocks one task.** Measured **73–111ms at 1×
  CPU** (473–801ms at 4×), i.e. roughly one dropped frame on real hardware, once, on return. The
  obvious remedies conflict with a decision taken earlier this round: paging depth is deliberately
  KEPT on return, so rendering the full depth is the intended behaviour. Virtualising the list is the
  real fix and is out of proportion to a one-off ~100ms cost. Accepted; revisit if the depth cap or
  the card count grows.

---

## c3r22 — verification round, then the three HIGHs it found (2026-07-27)

All seven lenses re-run against the remediated tree. **Five of the seven initially returned nothing**
— no report, no summary — and the batch tool still reported "7 succeeded". Only checking for the
files caught it; they were re-run with durable output paths. Treating a runner's success code as
evidence of work done would have shipped a 2-lens round as a full one.

Reports: `~/c3r22_reports/{usability,uiux,design,bug,perf}.md`, `/tmp/c3r22_{ai,oss}.md`.

### All three HIGHs were self-inflicted by the MEDIUM batch, and all three are now fixed

**H1 — a fully-filtered feed rendered a blank page.** Two lenses described OPPOSITE shapes (stalls
after one advance vs. pages the entire list), so I reproduced it myself and instrumented the
component rather than pick one. Ground truth: `hasMore:true, isFetching:false, filteredOutAll:true,
cards:0` — every condition for the advance was TRUE while it did nothing. The effect's deps returned
to an identical tuple after each advance, and `visible` — the thing it changes — was not among them,
so it fired at most once. With everything filtered, `hasMore` stays true forever, and the skeleton
branch was gated on it, so the reader sat on skeletons that never resolved.

The advance moved into `useFeed`, where `visible` lives and can be a dependency, and is **bounded**
(`MAX_AUTO_ADVANCE = 3`). The bound is not decoration: when no story can ever pass the filter, an
unbounded loop cannot terminate, and it was measured walking the whole list at 410 requests. Now:
all-filtered ends on the honest empty state (64 requests, bounded); a filtered run longer than one
page reaches the stories behind it; an unfiltered feed still stops at 25.

**H2 — the two read surfaces disagreed** (tab 0 / sidebar 6). Same paging root cause; fixed by H1
plus the earlier `recentRead` pool change. Verified: tab 12, sidebar 6, identical newest story, no
muted domain on either.

**H3 — non-feed routes inherited the feed's scroll offset.** `/settings` opened at y=3000 of a
6276px page. The arrival scroll from the H4 work was applied to `Feed.tsx` only — the same
fixed-one-instance-not-the-class failure the discipline exists to prevent. Now handled once at the
router level for every route, keyed on pathname so a feed-tab switch is not treated as an arrival.

### The guards were the weak link, again

The bug lens found that the dead-end guard I had written **structurally could not detect the stall it
claimed to cover**: its fixture had a filtered head of exactly 30, so one advance always sufficed. It
now uses a head longer than one page, asserts the all-filtered case terminates on the empty state
with no skeletons, bounds the request count, and keeps the unfiltered control.

Two of my new guard fixtures were also wrong in ways that produced misleading results — the read
harness's mock only serves ids 11–18 (so my seeded history rendered nothing and looked like an app
bug), and `idsFrom` sorts ascending (so "newest on both surfaces" compared the oldest). Both fixed;
neither was an app defect. A fixture that diverges from the harness it runs in invents defects as
readily as it hides them.

### Verification honesty

`/item` and `/user` arrivals could not be independently reconfirmed — my mock discussion pages were
only 800px tall, so "landed at 0" proves nothing there. `/settings` (6276px) is the decisive cell and
the fix is route-agnostic. Stated rather than glossed.

The gate then failed three times in a row with `ERR_CONNECTION_TIMED_OUT` to its own preview, on a
DIFFERENT test each time and with **zero** assertion failures — an environment condition (7124
established sockets, 38 SYN-SENT), not the code. Confirmed by running each victim standalone (all
pass) and finally by a clean run.

**Gate: 57/57 green.** Not committed. Four new scripts staged (`git add`) so `prepare` no longer
references untracked files — the BLOCKER the OSS lens found.

---

## c3r22 follow-up — the near-zero and low-risk batches (2026-07-27)

Ten of the fifteen open Tier 1–3 items, chosen by CHANGE CLASS rather than by tier. Every regression
this session came from one class — behavioural changes with async/state/timing interaction
(`showingPrevious`, the arrival scroll, the auto-advance effect, the `.limit()` retrain scan). None
came from prose, copy or single-attribute CSS. That line, not severity, decided what to take.

### Near-zero (text / copy / one attribute)

| # | Fix |
|---|---|
| 4 | The `until` comment claimed it "bounds the scan by MATCHES". It does not below the floor — which is the steady state the gate exists to detect. Says so now |
| 5 | **"interactions" → "examples"**, and its two siblings. My own M10 fix had adopted a word a comment 60 lines above explicitly forbids: most training rows are passive impressions, so naming deliberate actions overstates the data. Fixed a false label by introducing a rejected one |
| 1 | Notices prose no longer claims everything listed is redistributed — it now states the list is the dependency CLOSURE and names `sharp` as an example that never reaches the bundle, which is what `SECURITY.md` already said. Two shipped documents no longer contradict each other |
| 2 | "Built with Llama." added to the README |
| 15 | `/user/:id` not-found gained the `[overflow-wrap:anywhere]` its success-branch sibling already had |
| 12 | Follow chips gained `border-edge`. A 10%-alpha tint is 1.09–1.30:1 against the surface in 58 of 62 cells — clickable, not perceivable AS a control |
| 11 | "Why #N?" no longer names comment terms as a source when they are off |

### Llama attribution — narrowed after developer pushback

I had put it in the README and was heading for a Settings banner. The developer challenged that: does
it not only apply when Llama is actually loaded and generating? Correct, and the licence text agrees —
§1.b.i accepts **any one** of "website, user interface, blogpost, about page, **or product
documentation**". A global banner is not required, and most of the app has nothing to do with Llama.

Now conditional, next to the output it describes, via one predicate (`usesLlama`) that tests provider
AND model id. Both directions are defects: absent over Llama output under-attributes, and PRESENT
over a cloud provider's output is a FALSE attribution, which is worse. `LLM_MODELS` is a list built
to grow, so "on-device implies Llama" would rot silently. Guarded in `aiguardtest`.

### Low risk, each with the failing test written first

| # | Fix |
|---|---|
| 3 | A retrain that FAILS now consumes the rate limit. `lastTrainAt` advanced only after a successful `trainFromHistory()`, so a throwing retrain left the limiter untouched and the next tab-hide re-ran the whole scan. Writing the test also exposed a second defect: `retrainWarranted()` sat OUTSIDE the try, so a storage error escaped as an unhandled rejection (every caller uses `void runAutoTrain()`). Both fixed |
| 7 | A refusal no longer claims a backend. The thin-input path returns before any provider call but inherited the populated `sources`, so a refusal read "sent to Google Gemini" — measured 0 provider calls alongside that string |
| 6 | The two sidebar counters reconcile in visible copy. One climbs with every impression while the other sits still; the explanation existed only in a source comment |

### Two guards that would have passed while broken

**The retrain test's first form was inert.** It stubbed `train.trainFromHistory` on the module
namespace; `autotrain` imports it as a direct ESM binding, so the stub was never called (`calls: 0`)
and the run still reported "trained". Rewritten to induce a REAL failure by closing Dexie.

**The tint-only contrast detector reported 0 failures with the defect reintroduced — twice.** First
because the earlier passes leave the page on a discussion route, so it graded a sidebar that was not
rendered; a precondition asserting the chips are on screen now prevents that. Then because Tailwind v4
emits `oklab(… / 0.1)` for alpha-modified colours, which the rgb()/color(srgb) parser returned null
for — and a null fill was read as "no tint" and skipped. Colours are now resolved through a canvas,
which normalises any CSS form. Only after both fixes did it reproduce the design lens's independent
number exactly: **58 of 62 cells**. It fails pre-fix and passes post-fix; before that it was decoration.

That detector closes the structural gap behind #12: every earlier contrast check verified the `--edge`
TOKEN clears 3:1, never that a control USES it.

### Deliberately NOT taken

Four items whose change class is the one that has bitten me: fencing the story title (changes every
prompt and invalidates all caches), `articleLooksRelevant` across 4 more consumers (alters ranking and
embedding inputs), provenance from the rendered request (the prompt pipeline, where two sibling misses
already shipped), and the toolbar's second line at ≤414px (a `<select>` attempt made bar height worse,
159→233 at lg 320, and was reverted).

**Gate: 57/57 green.** Not committed.

---

## c3r23 follow-up — reverted the one verified HIGH (2026-07-27)

Round c3r23 reported 3 HIGH. Verified each before acting; only ONE survived.

| Reported | Verified |
|---|---|
| Ordered lists render with no numbers | **CONFIRMED HIGH — self-inflicted.** Reverted |
| Sentinel bypasses MAX_AUTO_ADVANCE (501 requests) | **MEDIUM, not HIGH.** Headline used `minPoints=1e6`; the slider maxes at 200. Measured: 1e6 → 104 (the cap works), 200 → 429, 120 → 94, 8/9 domains muted → 104, unfiltered → 94. Real, but a narrow band, self-terminating, bounded by list length. NOT fixed this pass |
| "Why #N?" figures never reconcile | **NOT REPRODUCED.** With a trained model (n=25, pos=9, gate "trained") the panel showed "0 of 12 examples" and a 0.00 learned bar — not the reported ~95%/+0.67. Either a different defect or an artifact of training directly without invalidating `['ranker']`. Eliminated one theory: `explainFor` reads a REF, so its empty dep array is not a stale closure. NOT fixed |

### The fix: revert, not CSS

`1. x` → `<ol><li>x</li></ol>` is the obviously-right change and was worse. `.hn-html` inherits the
Tailwind preflight reset `ol,ul,menu{list-style:none}`, so markers never paint — measured
`list-style-type: none`, `padding-left: 0px`, and the reader saw `"first pointsecond point"` where
before they saw `"1. first point2. second point"`. **The change deleted information.**

Restoring markers in CSS was rejected: `.hn-html` also renders every HN COMMENT body
(`Comment.tsx`, `CommentsView.tsx`, `User.tsx`), so it would change comment rendering app-wide —
far beyond the regression. Reverted instead, with the reasoning recorded at the site so the same
"obvious" change is not made again.

### The guard was the actual defect

`aiguardtest` asserted `/<ol>.*<li>first<\/li>/` — the markup was correct and the numbers were
invisible. It now renders into the real `.hn-html` container and asserts the RENDERED text contains
"1. first point", plus that any `<ol>` used actually paints markers. Both assertions fail against the
reverted-to-broken version (measured `seen` without ordinals, `marker: "none"`).

This is the third vacuous guard this session, and the rule it produces is narrow enough to be
followed: **if a fix changes rendered output, the guard asserts the rendered result — computed style
or displayed text — never the markup or data that produces it.**

Note the origin: B5 was rated **LOW** in the carried-forward bucket. Fixing a LOW created a HIGH.

**Gate: 57/57 green.** Not committed.

---

## c3r24 — the round that changed the review system (2026-07-27)

Seven lenses. Verdict **1 HIGH, 9 MEDIUM, 18 LOW** — and on verification the HIGH did not survive.
That makes c3r24 the first round in this sequence with **no self-inflicted HIGH**, which is the
convergence signal Process v2 defined. It is also the round that exposed a structural flaw in the
review system itself, so the system changed rather than the app.

### The false HIGH, and why it was structural

A lens proved that `learnedScale` — the pool-derived divisor on the learned term — changes final
item order. Two comments in `strategies.ts` asserted the opposite ("cannot reorder anything").
The lens rated the BEHAVIOUR a HIGH.

Verification: the behaviour is correct and intentional. `scale` divides the learned term only, so
compressing it relative to the unscaled popularity/recency/discussion terms is exactly how a taste
score is made worth a consistent amount across pools. The **comment** was wrong, not the code —
a LOW misfiled as a HIGH.

The lens was not careless. It had no authority to adjudicate against. Given a comment saying
"X cannot happen" and a demonstration that X happens, a lens must guess which is wrong, and
guessing "the code is wrong" is the expensive guess: it buys a fix cycle, and fixes are where this
codebase's defects now come from.

**A false comment does not merely fail to help. It manufactures findings.**

### What changed in the review system

1. **`review/SPEC.md` — new, and the authority.** Written from product intent, not derived from the
   code. Carries intended behaviour, accepted design decisions with rationale, accepted performance
   costs, and an explicit §10 "deliberately unspecified" list. §2.2 states that pool-relative
   ranking normalisation is intended, which is precisely the adjudication that was missing.
2. **`base/_common.md` — authority order + mandatory classification.** The old "two accepted design
   decisions" section is replaced by "THE SPEC IS THE AUTHORITY": SPEC > running app/`src` >
   everything else. Comments, `AGENTS.md`, tests and prior reports are demoted to **assertions under
   test** — none of them establishes intent. Every finding must now be tagged exactly one of
   **CODE-WRONG / COMMENT-WRONG / SPEC-GAP / SPEC-WRONG**, name the spec section it was adjudicated
   against (or "spec silent"), and a lens that cannot adjudicate must say so rather than pick a
   severity. Severity discipline added: rate the worst case reachable through the real UI.
3. **Deliverable format** carries the classification in each finding and in the verdict line.
4. **The CURRENT STATE appendix is now a diff**, not a restatement of behaviour — the spec holds the
   behaviour, so the appendix only says what changed since the last round.

### The fix that was itself the defect

The two false comments were corrected in place. That correction quoted the false claim and refuted
it beside itself — leaving a reader to parse the wrong thing and its retraction, in order, to reach
the truth. It also added six lines of narrative to the file, which is the category `AGENTS.md`
convergence rule #1 names as the largest defect source. Fixing a false comment by writing more
comment is not a fix.

Developer direction: **delete them** — "you cannot guarantee 100% accurate comments, can you?"

**122 lines of narrative comment removed from `strategies.ts` (602 → 480).** 113 comment lines
remain (23% of the file) in 4 blocks longer than four lines, the largest 23 lines. What survives is
intended to be mechanically true and short: the `(pull / z)` proportional attribution, the
requirement that the bars consume `ctx.learnedScale` rather than a literal, and the ordering
constraint that the outer score table reconciles before the model bars. Rationale now lives in
`SPEC.md §2.2`; the measurements are below.

**The purge was file-scoped, and that was a mistake.** It never grepped for the claim SHAPE across
`src/`, so `features.ts:25` kept "scales the term without ever reordering it" — verbatim the class
deleted next door. The AI and bug lenses both found it in c3r25 and both demonstrated the rank flip
rather than arguing it. This is fix-discipline rule (ii) — enumerate the siblings and fix them in
the SAME change, stating what you grepped — skipped, and it cost a round.

Three of the deleted blocks contained claims of the same unprovable class as the one that caused
this round's false HIGH — "re-centering is RANKING-NEUTRAL", "order-preserving WITHIN a pass",
"cannot reorder anything". Two of the three had already been patched with an amend-and-correct.
The class is the point: a comment asserting a global invariant about a numeric pipeline cannot be
kept true by review, so it should not be written.

**The rule: prefer deleting a comment to maintaining it. State only what is mechanically true, and
put rationale in the spec, where it is adjudicated.**

### Measurements relocated from the deleted comments

Preserved here because they are evidence for `SPEC.md §2.2`, not because the code needs them:

- Dividing the learned term by a constant made its dynamic range vary **145x** between histories.
  On a realistic noisy history (AUC 0.603) the pull spanned 0.011 against popularity's 0.49 — 2.2%
  of the smallest competing signal, moving the reader's taste group 1.7 places of 60. Unreachable
  through the UI: at the slider maximum it still spanned only 0.034 against 0.49.
- Unbounded authority produced the mirror failure. Across 20 seeded **no-signal** histories the
  learned term's spread was a median **1.29** against popularity's 0.35–0.49, moving cards up to
  **39 places of 60**. Held-out AUC on those same signal-free histories ranged **0.365–0.64**, which
  overlaps a genuinely weak but real model — so no threshold separates them, which is the argument
  for discounting AUC by its own standard error rather than cutting at a value.
- With the amplitude bounded, the learned spread on those histories holds at **~0.28** against
  popularity's ~0.46.
- Centring on the training base rate rather than the pool median printed a negative bar on **0 of
  20** unfamiliar candidates positive; a story the model knew nothing about read −0.675 of a nominal
  −1 while the tooltip promised "a typical story reads ~0".
- Bars rounded independently of the outer table disagreed with the displayed score on **5 of 20**
  cards; rows rounded independently of their total disagreed on **~28%**.

### Carried forward, not fixed

Unchanged by this round and still open: the infinite-scroll observer materialising most of the id
list at `minPoints=200` (429 requests — accepted in `SPEC.md §9`); story TITLE defanged but not
fenced; `articleLooksRelevant` applied in 1 of 5 consumers; provenance read from field-prep helpers
rather than the rendered request; the toolbar's second line at ≤414px; `.hn-html` not styling
bullets/headings/links in AI output (three lenses converged on this one); and the "Why #N?" panel
reconciliation MEDIUMs.

**Gate: 57/57 green** (comment-only removal; no behaviour change). Not committed.

---

## c3r25 comment/doc remediation (2026-07-28)

Scope: the developer asked for the COMMENT and DOC findings only — gather every one the seven
c3r25 lenses reported, verify each independently, fix the verified ones. 21 candidates gathered
across all seven reports; **19 verified, 2 refuted.**

### Two reported findings did NOT survive verification

| Reported | Verdict |
|---|---|
| **OSS M2** — committing the index as-is ships a 404 favicon, because `index.html` and `site.webmanifest` still reference the staged-for-deletion `public/favicon.svg` | **REFUTED on its key detail.** Neither file references `favicon.svg`. Both reference `./icon.svg` (staged as ADDED, present) plus PNGs that all exist. No 404. What survives is only "the index is behind the worktree" |
| **Bug L8, second half** — `initialFocusRef` "has no caller — every call site passes at most two arguments" | **FALSE.** `HiddenDialog.tsx:18` and `SignalsDialog.tsx:44` both pass three. The true residue is narrower: the two `SummaryActions` dialogs have the sticky-header shape the parameter exists for and don't pass it |

Bug L8's *first* half (Escape) verified and was fixed. This is the second round running where a
lens's headline was right and a supporting detail was wrong — validate before acting, every time.

### The guard, written first

`scripts/claimcheck.mjs` (new, wired into the **static** tier). A comment is an unverified
assertion, and one false comment in the ranking code has now cost two rounds: c3r24 rated intended
behaviour a HIGH because a comment said it was impossible, and c3r25 found the same claim alive in a
sibling file the c3r24 purge never grepped. The guard makes that class mechanically checkable:

1. **Forbidden claim shapes** — the "cannot / never / without ever reorder", "ranking-neutral",
   "order-preserving" family, which `SPEC.md §2.2` names as a defect by name.
2. **Numeric claims** — a number stated in prose that must equal a number in code (design count,
   amplitude floor), read from the source of truth at run time.

Both readers **throw** rather than skip if they cannot resolve their value, because a guard that
green-lights on an unevaluatable input is worse than no guard — the `themecontrasttest` NaN lesson.

Run against the pre-fix tree it failed with **5** findings: the 3 the lenses reported, plus
`strategies.ts:188` which no lens flagged, plus one false positive of its own (a `5 more designs`
section divider) that was fixed by anchoring the pattern before any source change.

The copy fixes got their own rendered-text assertions in `personalizeliveupdatetest` and
`weighthintstest` — **5 assertions, all proven failing pre-fix** against the real DOM.

### Fixed — source comments

| Site | Was | Now |
|---|---|---|
| `features.ts:25` | "scales the term without ever reordering it" | deleted — measured false, SPEC §2.2 |
| `features.ts:18` | `learnedCenter` called "DISPLAYED" | it centres the SCORE (`scoreItem` reads it) |
| `features.ts:29` | amplitude "0.15 at chance" | 0.2, matching `strategies.ts` |
| `strategies.ts:188` | "can never reorder against the model's own opinion" | deleted |
| `strategies.ts:9-11` | JSDoc duplicated verbatim from `:36-38`, above a type it does not describe | deleted |
| `content.ts:105` | profile-building "must not do live network I/O" | article terms are cache-only; COMMENT terms fetch up to 20 trees |
| `logistic.ts:177` | Platt gives "*calibrated* probabilities … meaningful" | fitted IN-SAMPLE; treat as a monotone rescaling, not a probability |
| `prefs.ts:104` | "one of the 20" designs | count dropped — 31, and now guarded |
| `Comment.tsx:41` | "Opens in a new tab", "Hacker News profile" | same-tab in-app `/user/:id` |
| `useModalBehavior.ts:19` | "Escape … they already own it" | `Onboarding` binds none; "Skip" dismisses it |
| `User.tsx:33` | "same gate the summary controls use elsewhere" | names the `showAiSummaries` difference and why |
| `topComment.ts:94` | failure and genuine-empty are "distinguishable" | they are not — `getItems` also drops dead/deleted |
| `index.css:1182` | washes "never touch text contrast" | they can — `list`/`compact` cards are transparent, and those are `geist`/`cyber` defaults |
| `index.css:1372` | claims it fixed a 6px sliver | rule was a proven no-op (`.sc-meta` is already `display:none`); **rule and claim both deleted** |
| `Logo.tsx:10`, `icon.svg:2` | tier contrast asserted as a property of the mark | the guarantee is on the TOKEN; thin tiers rasterise lower below ~32px |

### Fixed — docs and config

- **`ci.yml:11`** claimed CI runs the internal-reference check. It is a no-op on a runner (the
  pattern list is untracked, so it reports NOT RUN and exits 0). Reworded to say so, with an
  explicit "do not fix this by publishing the list".
- **`review/base/design-theme.md:108`** told a lens to grade `public/favicon.svg`, deleted this
  round → `public/icon.svg`.
- **`SPEC.md §8`** said "in full" and omitted two calls `SECURITY.md` discloses (model-weight
  download; read-aloud via a possibly-network system voice). Both added, and `SECURITY.md` is now
  named as the authoritative enumeration so the spec cannot silently drift ahead of what ships.
- **`SPEC.md §2.4`** gained the retraining contract, which was a genuine SPEC-GAP: retraining is a
  background task that runs only while the tab is hidden, "Retrain now" is the immediate path, and
  copy describing it must be true for a reader who never backgrounds the tab.
- **The leak guard's deny-list.** Three lists existed — the enforced fence (26 entries), a prose
  list in `DEV_LOCAL.md`, and a third hand-typed `git grep` in the pre-push section. Eight patterns
  were documented but never enforced, including the internal tool name that this repo has already
  been scrubbed of once. All eight folded into the fence (now **34**, `leakcheck` clean, so nothing
  is leaking today); the duplicate list and the hand-typed grep replaced by pointers to the fence and
  to `leakcheck.mjs`.

### Fixed — UI copy

Four strings promised the reranker "trains itself as you read" and one added "there's no manual
step", denying the only control that always works. Per the newly-written SPEC §2.4 the behaviour is
intended, so the copy is what was wrong: `Sidebar.tsx` ×2, `RankExplainDialog.tsx`,
`WeightSliders.tsx` → "retrains in the background" + "Retrain now" in Settings.
`Settings.tsx:227` pointed at a "For You sidebar" that does not exist at 390px or in `zen` → "the
Tune ranking panel on For You", which is rendered in every layout.

One assertion was **too broad and caught a true sentence**: the Why dialog also says "Position is
not re-sorted as you read", which is correct per SPEC §2.3. Narrowed to `trains?…as you read` and
re-verified against the old string, the new string and the true one before accepting.

### Deliberately NOT taken

Code-classified findings, out of the scope the developer set: the five bug MEDIUMs, `timeAgo`'s
five-day-early year, `htmlToText` anchor fusion, `AskThread`'s `llmProvider !== 'local'` test, the
dead `learnedById` plumbing, `Saved.tsx`'s `reasons={[]}`, the two `SummaryActions` dialogs that
don't pass `initialFocusRef`, and the `.sc-sub` element that actually shows through the compact
overlay (only its false comment was removed). `themecontrasttest`'s ring detector and alpha-dropping
`parseColor` are guard bugs, not comments, and remain open.

**Gate: 58/58 green** (57 + `claimcheck`). Not committed.

---

## c3r27 — the low-risk comment/doc/copy batch, and its own regressions (2026-07-28)

The developer scoped a batch to only those findings whose fix carries little regression risk:
text edits (comments, docstrings, docs, copy) plus three className/CSS changes that copy an existing
shipped twin. 21 candidates gathered from c3r26; **19 verified, 2 refuted** (OSS-M2's 404-favicon
claim — nothing references the deleted file; Bug-L8's "initialFocusRef has no caller" — two callers
pass it). One more was **discarded on validation**: `Settings.tsx:70` "interactions" is actually
correct (the gate counts all samples), so changing it would reduce accuracy.

### Fixed (all guarded, guards written first and proven to fail pre-fix)

- **Copy (SPEC §2.4):** removed the "trains itself as you browse/read" / "trains itself
  automatically" claims from every reranker surface (`Settings.tsx`, `RankExplainDialog` both the
  too-few-positives and OFF branches, `Sidebar`, `WeightSliders`) → "retrains in the background" +
  names "Retrain now". Guarded across Settings + all three Why-dialog branches + sidebar in
  `personalizeliveupdatetest` (3 new assertions, all failed pre-fix).
- **Two contrast twins:** HN-account follow chips gained `border border-edge` (guarded in
  `hnaccounttest`); the collapsed reply-pill repliers preview now inherits the pill colour instead of
  `text-muted` (guarded in `commenttest`). The design lens verified both complete across all 62
  design×mode cells.
- **Pluralisation:** "Read 1 comment" on the story card AND "1 comment" in the discussion header,
  guarded by a new `pluraltest.mjs` (both surfaces).
- **~12 source comments corrected/deleted** (`useFeed`, `content`, `logistic` AUC k-fold, `features`
  deleted-symbol, `interactions` save-reversible docstring, `index.css` logo + compact, etc.).
- **Docs/config:** `SPEC.md` §8/§2.4/§9, `ci.yml` gate description, the `THIRD_PARTY_NOTICES.md`
  generator preamble (regenerated, `--check` green), `package-lock.json` name field (name only —
  `resolved` URLs untouched), and the untracked notes prose.

### The regression report the developer asked for

The c3r27 review round found this batch introduced **1 HIGH + 1 genuinely-new false comment + 4
incomplete-sibling misses**, and — importantly — **zero behavioural regressions** (all seven lenses
confirmed behaviour intact; the two contrast twins verified complete; the copy verified correct and
consistent; ranker efficacy held). The self-inflicted defects, all now cleaned in the same turn:

1. **HIGH — `scripts/pluraltest.mjs` left untracked** while tracked `test.mjs` referenced it (public
   CI would go red). The IDENTICAL class as c3r26's untracked `claimcheck.mjs`. **Made the same
   mistake one round later.** Fixed: `git add`.
2. **A NEW false comment — `db.ts:94`.** The batch to remove false comments *added* one: a
   parenthetical claiming `hidden` is "not on this hot path", which is false (`useHiddenIds` →
   `db.hidden.toArray()` feeds the `cards` memo). Caught by 3 lenses. Deleted.
3. **Incomplete sibling sweeps** of this turn's own fixes: `autotrain.ts:60` still said "for seconds"
   (twin of the `:2` fix); `interactions.ts:312` `STRONG_ENGAGEMENT` comment still implied save is
   unconditional (twin of the `:331` docstring fix); `CommentsView.tsx:514` header still said "1
   comments" (cross-surface twin of the StoryCard pluralisation). All fixed; the plural guard was
   extended to the header and proven to fail pre-fix.

Accepted, not changed: `Settings.tsx:241` toggle label "(auto-trains)" — accurate (it does auto-train
in the background), so kept; the changelog's "on ANY surface" was the overstatement, corrected here.

**The through-line across c3r25→c3r27: the review side is sound; the fix side keeps shipping
incomplete sibling sweeps and the occasional new false comment.** Three rounds running, the
self-inflicted rate is dominated by "fixed one site, missed its twin." The mitigation that finally
bit this round: a metric-driven guard family (`claimcheck`, the extended contrast/copy/plural guards)
that catches the CLASS rather than the instance.

**Gate:** the main batch passed 59/59 green (run v20). After the regression-cleanup edits
(comment-only + the CommentsView header pluralisation + the extended plural guard), the static tier
passes green on every run and all changed + previously-flaked tests pass individually against the
stable preview, but a clean single full-gate run could not be captured this session: the gate's
ephemeral preview (port 4182) — and eventually the manual 4173 preview — repeatedly hit
`ERR_CONNECTION_TIMED_OUT` with ZERO assertion failures, the documented environmental socket-pressure
flake (3 more times this session, each at a different, unrelated test). Not committed.

---

## c3r28-fix batch + c3r29 (verify-all, fix-validated, re-review)

**c3r28 produced 2 MEDIUM + 15 LOW** (an earlier hand tally said 13 LOW; the accurate sum across the
seven lens reports is 15). Every finding was validated against source; the genuine, fixable ones were
fixed with fail-first regression guards for the behavioural ones, and the rest were accepted in
writing with a rationale.

**Fixed (10):**
- **ai-1 + ai-3** — `AskThread.tsx` gates the "Built with Llama" attribution AND the "AI-generated"
  caveat on `sent.sent`; `SummaryActions.tsx` gates its caveat on `ranModel` (matching the
  attribution). Guard: `refusalattrtest` extended to the Ask path + the caveat (proven to fail 3 pre-fix).
- **usability-1** — `query.ts` `networkMode:'always'`, so an offline query errors into the outage
  state instead of pausing into "User not found"/"No results". Guard: new `offlinetest` (drives the
  real app offline via `context.setOffline`; proven to fail 2 pre-fix, and a clean fail→pass shown by
  temporarily reverting the fix).
- **usability-2** — `User.tsx` success view gained the discussion page's "Back to feed" affordance.
- **usability-3** — the Compact-layout "Top comments" toggle is now `disabled` (was live-but-inert).
- **usability-4** — the "Why #N?" `(weight×value)` formula shows `contribution/weight` as the value
  (reconcileTo2dp had nudged the largest term's contribution). *[c3r29 found this is only a partial
  fix — see below.]*
- **ai-2** — the "moves the rank" copy is gated on `learnedMovesRank` (reconciled learned contribution
  ≥0.005); says "barely shifts its position" when the Learned weight is 0 or the pull rounds to zero.
- **design-1** — rank bars use `var(--bar-pos)`/`var(--bar-neg)` (a `color-mix(..., var(--fg))` in
  `index.css`) instead of hardcoded `#3fb950`/`#f85149`; c3r29's design lens measured both ≥4.33:1 vs
  every dialog surface across all 62 design×mode combos.
- **bug-1** — `App.tsx` comment corrected (a feed-tab switch scrolls to top; Feed.tsx owns it).
- **perf-2** — `topComment.ts:90` concurrency comment corrected to `2 cards × getItems-bound(3) = 6`.

**Accepted in writing (7):** design-2 + design-3 (decorative, SPEC §7); uiux-1 (unreachable — author
names are HN-API-sourced ≤15 chars, not unbounded input); usability-5 (the tall placeholder is the
SPEC-mandated no-yank slot, content already centered); perf-1 (article.ts is imported by StoryCard +
main.tsx too, so the lens's single-file dynamic-import is ineffective; full fix disproportionate for
26 KB); oss-1 + oss-2 (maintainer posture; oss-2 unfixable without rewriting protected `main`).

**Also this batch:** `mobiletest`'s rank-bar selector was decoupled from the (now-removed) hardcoded
colours — it selects the bars by their structural classes, assertion unchanged. **Gate: a clean full
standard run passed 64/0/0** (no 4182 flake this session).

**c3r29 (independent re-review, 7 read-only lenses) — 0 BLOCKER, 0 HIGH, 2 MEDIUM, 7 LOW** (down from
2M/15L; DESIGN and PERFORMANCE lenses both returned CLEAN, and all 10 fixes verified correct). The
round did NOT converge: **2 findings are self-inflicted by the c3r28-fix batch.**
- **MEDIUM (self-inflicted, incomplete sibling of ai-1/ai-3):** `AskThread.tsx` still shows the
  caveat/provenance/Llama over a generation ERROR (cloud 429/bad-key/5xx), because `sent.sent` means
  "a send was attempted / not a refusal", NOT "a model produced text" — it's true for a non-thin
  thread even when the call throws. `ThreadSummary` is safe (sets `sources=null` on error). Fix: also
  gate on "not errored".
- **MEDIUM (pre-existing, surfaced by the offline focus):** offline, the FIRST visit to a `React.lazy`
  route (discussion/Settings/Saved/profile) fails its JS-chunk import → `ErrorBoundary` shows raw
  "Failed to fetch dynamically imported module", never resets on navigation, and "Reload" is dead
  offline. `networkMode:'always'` fixed the DATA layer, not the CHUNK layer.
- **LOW (self-inflicted, from usability-4):** the "Why #N?" `(weight×value)` still reads 0.01 off the
  shown contribution when weight>1 and `contribution/weight` rounds up (e.g. 2.2×"1.00" beside
  "+2.19"), and the new comment claims exactness. The bars still sum to the score exactly. (Prefer
  deleting the redundant per-row formula.)
- **Other LOW (pre-existing/accepted):** offline search "0 results" header above the "Couldn't load
  results" error (SearchResults renders the count header unconditionally); a partial-cache offline
  feed reads as empty not outage; a sidebar reranker copy-consistency nit; a 320px Large-text Sort
  wrap (accepted defensive); oss-1 + oss-2 (accepted posture).

Design lens recommendation (not a finding): add `bar-pos`/`bar-neg` vs `surface` at ≥3:1 to
`themecontrasttest` so the new graphic-fill tokens can't regress silently. Nothing committed.

## Session-model (design #4) clarification + perf/tab-switch, and c3r31 (2026-07-29)

Developer-driven work this round: three requests + a developer-reported defect, then an independent
3-lens re-review of the changed surfaces.

**What changed in the app.**
- **Design #4 read-sweep triggers, made explicit.** The reader reported that stories "disappeared to
  Read on clicking the home icon". Investigated on the live app + a scripted probe: the home icon and
  ALL in-app navigation (tab switch, discussion open/close) do NOT sweep — only a fresh document load
  (reload / new tab) and the Refresh button do, and there is no load-time flash (the `isLoading` gate
  holds). Could not reproduce an in-app-nav sweep; the developer's likely trigger was a reload (which
  they confirmed SHOULD sweep) or a prior-session read surfacing when For-You first mounts. Locked the
  behaviour in with a new guard **`sessionsweeptest.mjs`** (in-session read stays visible across
  icon/tab/discussion; a reload sweeps) and made the trigger matrix explicit in `session.ts`, SPEC §4,
  and the AGENTS.md bullet.
- **Progressive For-You render (B1).** The candidate pool is materialised in waves — candidate ids →
  a fast first batch (~24, which paints) → the full ~90 pool. First content paints before the full
  pool (verified via CDP timing). Net first-paint win; the full-pool fetch cost is unchanged.
- **Tab-switch (B2).** `itemsQ.placeholderData` now keeps the previous data only within the SAME feed,
  so switching tabs shows the new tab's skeleton/own cache, never the previous tab's cards.
- **Refresh scope (forceRef).** `useFeed` is not remounted on a tab switch, so the Refresh
  force-network flag could bleed into a tab switched-to mid-refresh. Cleared synchronously on any kind
  change, so Refresh only ever force-fetches its own tab.
- **feedstabilitytest reload assertion.** It asserted the old design-#3 contract ("a reload changes
  nothing"). Instrumented dumps proved a reload keeps the pin/order and only re-applies the sweep, so
  it now asserts NO RE-SORT (relative order of surviving cards preserved) — still fails on a genuine
  re-sort, but allows the design-#4 membership change.
- **Performance lens rewritten.** It had been rubber-stamping (an escape hatch — "a clean result is
  valid" — plus no budgets, no controlled throttle, no perceptual pass). Now it mandates a filled
  budget table on fixed CDP throttle profiles, a perceptual/transition pass (catches the wrong-tab
  flash class), and cold-start waterfall attribution; "it's architectural" no longer substitutes for a
  measured number.

**c3r31 (independent re-review of the changed surfaces — bug/correctness, performance, usability;
the other four lenses cover surfaces untouched this round). 0 BLOCKER, 0 HIGH, 0 CODE-WRONG.**
- **Fixed — stale read-sweep comment CLASS (LOW, COMMENT-WRONG, self-inflicted by design #4).** Several
  comments still said the sweep "changes ONLY on Refresh / reloading never alters it." Fixed the whole
  class in one change: `useFeed.ts` (×3 sweep + ×1 teaching), `readSweep.ts` `getReadSweep` doc,
  `Settings.tsx` copy, `AGENTS.md` (×2). The verifier caught siblings the bug lens missed (the Settings
  copy + the AGENTS.md bullet).
- **Fixed — stale teaching comment (LOW).** `Feed.tsx:54` + `useFeed.ts:385` said follow/mute is
  reachable from "the domain chip in the meta line"; `StoryCard.tsx:543` is a display-only `<span>` —
  teaching is only in the ⋯ menu. Corrected both. (Noted, NOT fixed: the `Feed.tsx` `livePos` comment's
  deeper premise — that a card teach re-orders the feed — is stale since follow/mute are absent from
  `rankIntent`; left for a dedicated review rather than a blind edit.)
- **Accepted (MEDIUM, perf, in writing — SPEC §9).** A concurrent switch to an UNVISITED tab during the
  cold-start pool fill can take ~2–6 s on a throttled profile (the background pool fetch uses the
  origin's connections). A facet of the accepted For-You N+1; the mitigation (lower the background
  pool's concurrency) slows the common case, so deferred. First paint is unaffected.
- **Deferred (usability LOWs, feature-freeze).** Refresh lacks a forewarning/scope hint; the read-sweep
  note is low-salience; no in-context link to the permanent "Hide read stories" toggle. All are UI
  additions; deferred to avoid new capability mid-convergence. DQ: scroll-to-top on return is the
  heaviest repeated friction but is SPEC §4-intended.

Gate: standard tier green (65/65) before the comment batch and re-run green after. Nothing committed.

## For-You cold-start: Algolia front_page rewrite (2026-07-29)

Acted on the two perf items from the c3r31 ranking (#1 concurrent-switch contention, #2 the
candidate-list N+1). Both had the same root: For You fetched three firebase lists (top/best/new) then
materialised ~90 candidates via a per-item N+1 — the list fetch dominated cold start and the
background pool fetch saturated the origin's connections (starving a concurrent tab switch).

**Change.** `getForYouCandidates` (client.ts) now fetches the pool from Algolia `search?tags=front_page`
in ONE request that returns fully-formed stories (mapped via the shared `hitToItem`, moved to
algolia.ts and reused by SearchResults). On any Algolia error OR empty result it falls back to the old
firebase blended pool, so resilience is unchanged and a total firebase outage still surfaces as Retry.
`useFeed` collapsed its three For-You pool queries (the c3r31 B1 progressive split) into one — a single
fast request needs no batching. Measured **~0.9 s to a fully-rendered feed / 1 request** vs the prior
~90 requests (0 firebase list fetches, 0 item N+1 on the fast path). Both #1 and #2 resolved; SPEC §9
updated (the N+1 accepted-cost and the concurrent-switch MEDIUM are gone).

**Why it was deferred, and how the test implication was handled.** The hermetic tests mock firebase;
switching For You to Algolia would starve them. The fallback-on-empty made this cheap: a test whose
Algolia `search` stub returns empty for `front_page` keeps exercising the firebase path unchanged, so
most For-You tests needed no edit. Only the two that return NON-empty `search` hits for a search
sub-test (`audit`, `themecontrasttest`) had to branch their mock to return empty for `front_page` (else
For You rendered the search hits). New guard `foryousourcetest` covers BOTH halves: the fast Algolia
path makes zero firebase list fetches; the fallback loads from firebase when Algolia is down.

Gate: standard tier green. The pre-rewrite checkpoint was committed locally (54c2adc); the rewrite
itself is not yet committed.

## c3r32 — full 7-lens review of the rewrite caught a `front_page` regression (2026-07-29)

Ran all seven read-only lenses (+ verifier) on the Algolia rewrite above. No BLOCKER, but the bug, AI,
usability, and design lenses INDEPENDENTLY caught a real regression the first cut introduced — and the
verifier confirmed it against source. `search?tags=front_page` is **~50% pinned "YC is hiring" job
posts** (verified live: 50/100, all `points:null`). Because `hitToItem` hardcoded `type:'story'` and a
job's `points` is `null`, they (a) flooded ~half the pool and (b) **bypassed the min-points filter**
(`typeof null !== 'number'` at features.ts) — so raising min-points stripped real stories and KEPT the
ads. Plus `front_page`'s relevance sort resurfaced months-old items (a stale tail), and `hitToItem`
dropped `children` (top-comment previews vanished from For You) and `story_text` (Ask/text bodies).

**Fix (one root cause: the query + the mapper).** Switched the pool query from `tags=front_page` to
**`tags=story` + a 3-day `created_at_i` recency filter** — verified live to return 90 fresh (≤3d),
points-ranked, **job-free** stories (jobs=0, nullPoints=0). Extended `hitToItem` to map
`children`→`kids` (restores previews), `story_text`→`text`, and derive `type` from `_tags` (+ a
defensive `type!=='job'` drop in `getForYouCandidates`). Re-measured: ~0.74 s to first card, 1 Algolia
pool request, 0 firebase lists, 0 job cards. `foryousourcetest` was hardened to assert the query shape,
job exclusion, kids/text mapping, and the min-points non-bypass — and in doing so exposed that its
OWN broad `page.route` catch-all had been shadowing the specific `/search/` mock (Playwright runs
matching routes last-registered-first), so the original guard was silently testing the fallback, not
the Algolia path; fixed the route order. `audit`/`themecontrasttest` mocks now discriminate the pool
query (no `query=`) from a user search (`query=`).

Other lens findings, dispositioned: the search surface now also gets top-comment previews (shared
`hitToItem` maps `kids`) — bounded by `previewburst`, accepted as a minor consistency improvement. The
perf lens's payload-trim (`attributesToHighlight=`) and the recency-max-user "no raw new-firehose"
nuance are documented follow-ups (LOW). OSS/UI-UX/design lenses were otherwise clean.

Gate: standard tier green (66/66) after the fix. Not yet committed.

## Offline / PWA — the app loads with the serving port down (2026-07-29)

Developer request: "even if the serving port is down, I can still run the app in my browser." The app
already had a manifest + icons but NO service worker, so a reload with the server down failed.

**Approach.** Hand-rolled a service worker via a small inline vite plugin (`offlineServiceWorker` in
`vite.config.ts`) rather than `vite-plugin-pwa` — the build is rolldown-vite v8 (plugin-compat risk),
and the codebase already hand-rolls build steps (inline.mjs, gen-notices.mjs). On every non-single-file
`vite build` the plugin scans the output and writes `dist/sw.js` precaching the shell + all JS/CSS/
icons/manifest (skipping `.map` and `.wasm` — the heavy opt-in AI wasm is runtime-cached). `index.html`
registers it over http(s) only, so it's a no-op on `file://` (the single-file build) and on the dev
server (no sw.js there). The SW: navigations → cached shell; same-origin assets → cache-first (+
runtime-cache lazy chunks/wasm); cross-origin (HN API, Algolia, favicons, model CDN) → straight to
network (no new destination, no caching of reader data). Critically, on activate it deletes ONLY its
own stale `hnlens-precache-*` caches, so the model-weight Cache-API stores (managed by storage.ts)
survive a redeploy.

**Verified** by `offlinepwatest`: serves `dist/` from a throwaway server, loads the app (SW installs +
controls + precaches), then STOPS the server and reloads — the app shell boots and the feed chrome
renders entirely from the SW cache (0 hits to the down server), and a seeded foreign model-weight cache
survives. Confirmed no interference with reload-based (readtest) or request-counting (favicontest)
tests. SPEC §8, AGENTS.md (Hard constraints) updated.

Gate: standard tier green. Not yet committed.

## c3r33 — 7-lens review of the offline/PWA + c3r32 work; a real SW bug fixed (2026-07-29)

Ran all seven lenses (+ verifier) on the offline SW + the c3r32 feed change. The headline lesson: on
the offline blank-page symptom, FOUR lenses (bug/usability/design) called it a "harness artifact",
and only the UIUX-STRESS lens correctly root-caused a REAL bug — the verifier independently
reproduced it against `vite preview` and confirmed the four were wrong. A reminder that a
comfortable "it's the test harness" explanation needs the same scrutiny as a defect.

**Fixed (verified, guarded):**
- **HIGH (offline blank page under `Vary: Origin`).** `vite preview` (and any host answering
  `Vary: Origin`) serves the crossorigin module scripts with a Vary that made the SW's
  `caches.match(req)` MISS offline → blank page. Fixed with `{ ignoreVary: true }` on all SW cache
  lookups (safe — assets are URL-keyed/content-hashed). `offlinepwatest` was upgraded to send
  `Vary: Origin` and proven to FAIL without the fix (blank, 19 hits to the down server) and pass with
  it. NOTE: GitHub Pages sends `Vary: Accept-Encoding`, not `Vary: Origin`, so production was NOT
  affected — but the dev/verify env (where the feature is tested) was, and the guard couldn't see it.
- **MEDIUM (precache shipped 6.5 MB of lazy AI JS).** The precache filter kept the WebLLM lib
  (5.9 MB) + Transformers.js (0.5 MB), downloading them for every first-time AI-off visitor —
  violating the "0 AI requests on landing" principle. Now excluded by a 500 KB size cap (runtime-
  cached on first AI use, like the wasm); precache dropped 30→28 assets, ~7.5 MB→~1 MB.
- **MEDIUM (comments outage-vs-empty).** A failed comment-tree fetch showed "No comments yet." over
  an outage (the SPEC §6 class the feed/search already handle). `fetchItemTree` gained a `strict`
  option; `useComments` uses it so `isError` fires; `CommentsView` shows an outage + Retry. Guarded
  by the new `commentsoutagetest`.
- **LOW (stale comments).** `useFeed.ts` still said "front_page" (c3r32 leftover; code uses
  `tags=story`); `types.ts` had the design-#3 sweep comment. Both corrected. `topComment.ts`'s
  "kids are best-first" comment now notes the Algolia feed's `children` are chronological.

**Reported as remaining (see the ranked list):** the offline UX could add an offline indicator /
reconnect-refetch / install prompt (SPEC-GAP enhancements); the RUNTIME cache isn't pruned (bounded
by browser quota / hashed names).

Gate: standard tier green (68/68 with the new guard). Committed after the gate.

### Follow-up: #1 (top-comment previews) FIXED (2026-07-29)

The one MEDIUM I had reported as an accepted tradeoff — For-You previews sampling the OLDEST comments
(Algolia `children` are chronological, not HN-ranked) — is now fixed rather than accepted. `getTopComments`
ranks the preview from the story's FIREBASE item (`getItem`, whose `kids` are HN-ranked), falling back
to the item's own kids if that fetch fails. On reflection the cost I'd cited ("the N+1") was overstated:
it's ONE bounded, cached, per-previewed-card firebase fetch (already the preview's model, throttled by
`PREVIEW_CARD_CONCURRENCY`), and a cache HIT (no request) for firebase-sourced feeds — not the pool
N+1. Guarded by `topcommentranktest` (a standout posted last, past the first 5 chronological kids, is
still surfaced; and a missing firebase story falls back to a preview). Gate green.

## c3r34 — offline UX + a developer-reported prompt-editor defect routed through the lenses (2026-07-29)

Two threads this round.

### Offline UX (the four remaining c3r33 usability MEDIUMs)
Built on top of the offline SW: (M1) a fixed, non-reflowing, debounced `OfflineNotice` indicator
driven by a new `useOnline()` hook; (M2) reconnect auto-recovery — a `main.tsx` `online` listener
refetches ERRORED active queries (debounced, no thundering herd) so a feed that errored offline
reloads itself on reconnect, `networkMode:'always'` kept; (M3) offline-aware outage copy + a shared
`OfflineOutageHint` (Saved/Read links) in the Feed/Search/CommentsView outage states; (M4) a
`beforeinstallprompt` capture (`pwaInstall.ts`) + a Settings "Offline & install" section. Guarded by
`offlineuxtest` (pre-fix 6-FAIL → post-fix 14-PASS). SPEC §8 + AGENTS updated.

### The `uitest` flake this surfaced (test-only)
Validating the top-comment fix, `uitest` failed on the hide step — a LIVE-API fragility, not a
regression: two real HN stories were both titled "Superlogical", so the title-based "hidden card is
gone" assertion was ambiguous. Rewrote it to assert by `data-id` (and to actually verify the
placeholder-stub behaviour). Also made the tab-loop + save-verify steps robust to live-API timing
(settle-poll + retry) — `uitest` is a live end-to-end tour and was flaking on slow/sparse feeds.

### Developer-reported: the "Edit prompt" affordance couldn't edit the current prompt (golden rule #8)
The developer reported that in the AI prompt editors you can only PARTIALLY see the current prompt
(box too small) and, once you start typing, it DISAPPEARS. Rather than hand-fix, applied rule #8:
- **Class:** an "Edit X" affordance that surfaces the current/effective value only as PLACEHOLDER
  text (real value = empty override), so the first keystroke erases the reference — you can only
  replace from scratch — compounded by an undersized box that clips the value.
- **Blind lens:** usability. Its affordance/dead-end/discoverability sweeps checked that a control
  OPENS, never that you can EDIT THE CURRENT VALUE. Upgraded `review/base/usability.md` with an
  **edit-fidelity sweep** (pre-fill? legible? incrementally editable without losing the reference?)
  and folded the undersized-box-clips-content half into `review/base/uiux-stress.md`.
- **Proved the detector:** ran the upgraded usability lens read-only on the PRE-FIX app; it
  INDEPENDENTLY rediscovered the defect (HIGH, both editors, `Settings.tsx` + `SummaryActions.tsx`,
  with the `value=override / placeholder=default` mechanism) without being told it existed.
- **Fixed both editors:** `prompts.ts` `effectivePromptPart()` (pre-fill the override-or-default as
  the real value) + `normalizePromptOverride()` (store `''` when equal to default, preserving
  empty=default); a shared `AutoTextarea` (`controls.tsx`) that grows to fit then scrolls; "Reset"
  refills the default; corrected the now-true "visible and editable" copy. Guarded by
  `promptedittest` (pre-fix 9-FAIL → post-fix 12-PASS). A fresh post-fix usability lens confirmed
  "both editors let a user read and edit the current prompt in place", and flagged the residual
  long-prompt clipping — which the `AutoTextarea` auto-grow then resolved (verified visually + in the
  guard's cap+scroll assertion).

### The 3 self-inflicted offline findings — FIXED under tightened discipline (2026-07-29)
The 6-lens c3r34 round found 3 real issues in this session's own offline work; all fixed with
invariant-first guards (pre-fix FAIL → post-fix PASS), then re-verified by fresh lenses (c3r34d):
- **HIGH — offline pill stole taps.** `pointer-events:none` (pure-status pill), guarded by an
  `elementFromPoint`-over-every-tab interception check. c3r34d confirmed no tap-steal.
- **HIGH — discussion story-outage didn't recover.** `useStory` made strict (throws on null → error
  state), so the reconnect refetch catches it and the branch shows Retry (`useItem.ts` +
  `CommentsView.tsx`). Guarded by an offline→reconnect story-recovery check.
- **MEDIUM — install listener too late.** `pwaInstall.ts` now imported at startup in `main.tsx`.
  Guarded by dispatching `beforeinstallprompt` on Home *before* Settings is ever opened.

### Follow-on fixes (c3r34d verification) — pill placement, copy over-claim, sibling gaps
c3r34d verified the 3 above but surfaced follow-ons (2 mine): **pill VISUAL occlusion** →
moved the indicator from a floating overlay INTO the TopNav as a compact chip (fixed-height nav → no
reflow; above the tab strip → no occlusion; guarded by an in-nav + no-reflow + no-intercept check);
**copy over-claim** — "discussions you've already opened are available offline" was false (the comment
tree isn't cached), corrected to "Saved and Read stories" in `OfflineOutageHint`/`Settings`/`README`;
**sibling gap** — the User-profile outage is now offline-aware like the others.

### c3r34e: a real PRE-EXISTING HIGH the copy fix exposed — For-You pool error leaked into every feed
Re-verifying the copy ("Read available offline"), the usability lens found Read genuinely broken
offline: `useFeed.ts:551` computed `isError = poolQ.isError || idsQ.isError || itemsQ.isError` for
ALL feed kinds, and a disabled query keeps its last error — so once For-You's shared pool query
(`['pool','foryou']`) errored offline, every other feed (Read/Top/…) inherited the outage even though
its own data was in IndexedDB. Fixed by scoping `isError` by kind, mirroring the `isLoading` branch
directly above it (For-You → `poolQ`; Read → `readIdsQ`/`itemsQ`; other → `idsQ`/`itemsQ`). Guarded
by `offlineuxtest`'s feed-isolation check (seed a cached read story, clear the list cache, error
For-You on a fresh offline reload, switch to Read → Read shows its card, not the pool outage;
demonstrated pre-fix FAIL → post-fix PASS). *Lesson: a fix's own copy claim ("Read works offline")
is a spec assertion — verifying it surfaced a latent cross-feed error-state leak; and a guard that
passes pre-fix is useless — I had to reproduce the true trigger (pool's FIRST run offline, no list
cache) before the guard could discriminate.*

## Nav chrome — developer-reported polish (2026-07-29)
Two developer-reported items on the top nav, both fixed + guarded + independently verified:
- **Theme/layout selectors were chopped + a 113px dead gap sat on the right.** The selects were
  capped at `max-w-[9rem]`/`max-w-[8rem]` + `truncate`, so labels like "Reader — calm & quiet
  (default)" showed as "Reader — cal…", and the search's own `max-w-md` cap left ~113px of unused
  space pooling on the right. Fix (per the developer's steer — widen what needs it, don't balloon the
  search): `lg:max-w-[13rem]` / `lg:max-w-[11rem]` on the two selects, so they show proper labels AND
  the freed space is consumed → the action icons reach the content edge. Search untouched.
- **Feed tabs now stick under the header.** The `TopNav` was already `sticky top-0`; the feed-tabs
  strip scrolled away. Wrapped `FeedTabs` in a `sticky top-14 z-20 bg-bg/90 backdrop-blur` container
  (below the header's z-30; Home-only, so no conflict with `/item`'s own sticky toolbar), so tabs stay
  reachable while scrolling a long feed. Sticky is in-flow → no reflow.

Guarded by `navchrometest` (selector width >=190px at lg+, nav gap <=24px, 0 horizontal overflow at
1280/1180/1024/768/375, and the feed tabs pinned below the header after a 1200px scroll — the pre-fix
metrics gap=113/themeW=144/tabsTop=-807 confirm it discriminates). Gate green (72). c3r34g UI/UX-stress
lens verified both across the device matrix: 0 BLOCKER/HIGH/MEDIUM (2 invisible LOW nitpicks).

## c3r35 — full 7-lens review + a contained fix batch (2026-07-29)
A full independent 7-lens round on the published state found **12 verified open issues (1 MEDIUM +
11 LOW)** + 3 accepted (top-comment previews, favicon, review-process docs). No BLOCKER/HIGH runtime
defect; gate green (72).

Fixed a **contained, low-regression-risk batch of 7** (6 planned + 1 bonus found while guarding):
- **MEDIUM — persona "About this user" provenance was dishonest** (`User.tsx`): the "Based on N
  stories + M comments" line rendered over a refusal (no model ran) and counted FETCHED activity, not
  what was SENT. Now gated on a real request (`summaryReq.length > 0`) and uses `res.counts` (the
  persona-budget-bounded sent count) — matching the other 3 AI surfaces. Corroborated by the AI + bug
  lenses (both independently).
- **BONUS (found while writing the guard) — persona summary lingered across users**: `/user/:id`
  re-uses the component, so viewing user A then B showed A's summary on B's page. Reset on `id` change.
- LOW: comment-tree offline outage now renders the shared `OfflineOutageHint` (last sibling gap);
  deleted dead `baseRateWord` export; `SignalsDialog` "(imported)" `--subtle`→`--muted` (AA);
  AI-prompt user-template textarea `text-[11px]`→`text-xs` (follows the reading-size axis);
  discussion-header username link gets `[overflow-wrap:anywhere]` (sibling consistency).

Guarded by `usertest` (persona provenance: pre-fix 2-FAIL → post-fix PASS — provenance earned +
counts SENT activity; a thin user refuses with NO "Based on" line; guards the rendered `User.tsx`
line the function-level `aiguardtest` never exercised).

**Deferred (higher regression risk / less contained):** `<mark>` search-highlight contrast (62-theme
matrix), "Why #N?" cross-section reconciliation, `article.ts` eager-import bundle cost, and the
marginal perf/cosmetic LOWs.

## c3r36 — re-review of the c3r35 batch + an A/B class-completion fix (2026-07-30)
Re-ran the 5 code-facing lenses against the published c3r35 build (e73393c). Zero BLOCKER/HIGH, but
**3 MEDIUM + ~7 LOW** — and *two of the three MEDIUMs were created by the c3r35 batch itself*, the
incomplete-fix signature this loop keeps hitting:
- **A — provenance-over-refusal was fixed on ONE surface, not the CLASS** (AI MEDIUM + bug LOW).
  c3r35 gated the *persona* summary's "Based on …" line on a real request, but the identical bug
  remained on the **card TL;DR** (`StoryCard.tsx`) and the **discussion thread** (`ThreadSummary.tsx`):
  `summarizeItem` returns `request:[]` on a too-thin refusal but a truthy *zeroed* `sources`, so
  `describeSources` rendered "Based on no readable content" beneath a refusal — a provenance claim for
  a request never made. The provenance-honesty CLASS is 4 surfaces (tldr / thread / ask / persona);
  Ask + persona were correct, tldr + thread were not.
- **B — a cross-profile persona RACE** (bug MEDIUM). `User.tsx doSummary` wrote its result
  unconditionally on resolve; navigating from profile A to profile B while A's generation was still in
  flight landed A's summary on B. (The c3r35 reset-on-nav effect cleared a *completed* lingering
  summary but not an *in-flight* one.)
- **C — Retry stripped on a failed cloud summary** (usability MEDIUM) — DEFERRED (pre-existing, not
  from the batch; larger surface, taken next round per the ≤5-per-batch cap).

### The fix (A + B, class-complete)
- **A:** gated the provenance line on the real request on BOTH remaining surfaces — `StoryCard.tsx`
  (`tldrRequest.length > 0`) and `ThreadSummary.tsx` (`request.length > 0`). All 4 provenance surfaces
  now share one rule: show "Based on …" only when a model actually ran. Enumerated the class
  (`describeSources` render sites) → 4 surfaces, 2 already correct, 2 fixed, 0 remaining.
- **B:** a monotonic run-id in `User.tsx` — `summarySeq` is bumped on each `doSummary` AND on `id`
  navigation; every state write (onToken / result / catch / finally) is guarded by `live()` (seq
  unchanged), and the id-change effect also clears `summaryLoading`. A superseded generation is
  discarded, not written onto the new profile.

### Guards (fail-first: pre-fix FAIL → post-fix PASS, demonstrated on a scratch build)
- `usertest`: a new `raceuser` fixture (never summarized elsewhere → a genuine cache MISS, so the
  click starts a REAL in-flight generation) begins a summary, then navigates in-app to `thinuser`
  once the `generateContent` request is provably issued (`waitForRequest`, not a fixed sleep); asserts
  PERSONA_SUMMARY does NOT land on thinuser. Pre-fix FAIL (it landed) → post-fix PASS.
- `cloudllmtest` §12: a thin story (ONE short comment → the discussion toolbar + Summary tool render,
  but still below the summarize threshold) drives a refusal on BOTH the card TL;DR and the thread;
  asserts NO "Based on" line on either surface. Pre-fix 2-FAIL ("Based on no readable content" on
  both) → post-fix PASS. *Two test-only collisions fixed en route (each masqueraded as an app bug):*
  `THIN_ID` must avoid §9's `STORY_ID+1` item id (or §9's non-thin item wrongly got the empty tree
  and refused), and the Top feed is served from the **Dexie list cache** (`db.lists`) — cleared before
  the reload or the new `feedIds` never fetch.

*Lesson (the recurring one, now with a mechanism): a fix that touches ONE surface of a shared display
helper (`describeSources`) is an INCOMPLETE fix — enumerate every render site and fix the CLASS in one
change, with a guard that covers every surface. Two of three MEDIUMs this round were self-inflicted by
doing exactly the opposite; the self-inflicted rate is the convergence signal (see "Convergence" below).*

## Convergence — how this loop terminates (and why it hasn't yet)
**Literal "zero findings" is unreachable, by the project's own rule** — any thorough lens always
finds *something*, so a clean-of-everything round will never certify the app. Chasing it is why
rounds 16–20 all "failed". The correct target is **CONVERGED / SHIPPABLE**, defined precisely and
measurably:
1. **zero BLOCKER/HIGH**, and
2. **zero SELF-INFLICTED regressions** in the round (no finding traceable to the previous batch), and
3. **every MEDIUM either fixed or accepted in writing** with a rationale, and
4. **LOWs triaged** to a written accepted-backlog (not chased).

**Why we haven't converged is not the review side — it's the FIX side.** Measured: c3r36 found 3
MEDIUM, and **2 of the 3 were created by the c3r35 batch** (persona-only provenance fix left the tldr
+ thread siblings; the reset-on-nav effect left the in-flight race). A loop that produces ~1 new
finding per fix *cannot* terminate. So the single number that matters is the **self-inflicted rate**,
and the whole discipline exists to drive it to 0:
- **Fix by CLASS, not instance.** Before any fix, grep the shared helper's every call/render site,
  state how many you found, fix them all in one change, and write ONE guard that covers every surface.
  (A-fix this round: `describeSources` → 4 surfaces; 2 were already right, 2 fixed, 0 left.)
- **Prefer DELETION over addition.** New capability spawns new findings (the `departed` notice became
  a HIGH the next round). Removing the wrong thing (a false comment, a dead export, a broken notice)
  is usually the correct minimal fix.
- **Write the failing guard FIRST, from the lens's words** — pre-fix-must-FAIL, post-fix-must-PASS,
  demonstrated on a scratch build. A guard written after the fix encodes the patch, not the invariant.
- **Cap the batch (~5), gate, then a diff-scoped read-only pass over ONLY the changed surfaces**,
  before taking the next batch. Fixing fifteen things and gating once is how regressions slip in.
- **No narrative comments in source** — they were the single largest defect category (12 false
  claims in one round). Reasoning goes here, in this audited file.

**Termination test:** the same developer report, made again later, is caught by a lens first (golden
rule #8); and a full round returns **0 BLOCKER/HIGH + 0 self-inflicted + every MEDIUM resolved**.
That round — not "0 findings" — is what certifies the ship.

**Path from here (c3r36 → converged):** after this A/B batch, the remaining verified backlog is
pre-existing (NOT self-inflicted): **C** (Retry stripped on a failed cloud summary, MEDIUM) plus a
handful of LOWs (`<mark>` 62-theme contrast, "Why #N?" reconciliation, `article.ts` eager import,
cosmetic near-misses). Next batch: fix **C by class** + ≤4 LOWs, gate, diff-scoped pass, re-review.
When a round comes back with only accepted-LOWs and **zero self-inflicted findings**, it has
converged → ship.

### c3r36 independent verify of the A/B batch + the c3r36b follow-on (2026-07-30)
An independent, read-only agent (neutral spec, NOT told what changed) re-derived the 4 summary
surfaces itself and confirmed **rules 1–4 conform on all four** (basis line + attribution appear only
when a model ran; persona per-profile race guarded) — **0 self-inflicted regressions** from the A/B
batch. It surfaced two tightly-related items, taken as the **c3r36b** batch (≤5, class-scoped):
- **C (MEDIUM, pre-existing) — a FAILED generation stripped the retry.** On a transient provider
  error the surface showed "Could not summarize… try again" but the retry control was gone (`Refresh`
  lived in `SummaryActions`, which the error branch suppressed). Persona was a true dead-end (the
  "Summarize" button is also gone once `summary` holds the error). Class = card + persona + thread
  (Ask was already fine — its input is persistent).
- **§E#1 (LOW) — a REFUSAL still showed Refresh/Edit** on card + persona (thread/ask already hid them);
  "Edit prompt" over a thin refusal is inoperative (the refusal short-circuits before any prompt runs).
- **Test-gap (material)** — the `SummaryActions` `ranModel` attribution gate was untested on the two
  surfaces that actually render it over a refusal (card, persona).

**Root-cause fix — ONE 3-state model for the controls row on all surfaces** (`StoryCard`, `User`,
`ThreadSummary`; Ask already conformed): SUCCESS (`request` sent) → basis + full controls; ERROR
(`/^Could not/`) → keep **Refresh** only (request is empty, so View-request/caveat/Llama stay off, no
basis); REFUSAL (thin, no request, not an error) → hide the row. This closes **C** and **§E#1** together
and makes the attribution-over-refusal test-gap **moot by construction** (no `SummaryActions` over a
refusal). Also reset `request`/`sources` at the start of each generation so a prior success can't leak
a stale request into an error render. Plus the **zero-part LOW**: the persona basis omits a 0 part
("Based on 12 comments", not "…0 recent stories + 12 comments"), still the SENT counts.

**Guards (fail-first, demonstrated on the live pre-fix build → post-fix):** `cloudllmtest §12` (card
refusal hides the row) + new `§13` (card + thread error keep Refresh, no basis/caveat) and `usertest`
(persona refusal hides the row; persona error keeps Refresh) — 5 new discriminating assertions, all
FAIL pre-fix → PASS post-fix, via a `geminiFail` 500 toggle + a fresh never-summarized `erroruser`.

**Accepted in writing (LOW/nit, not fixed):** §E#2 — the card prepends the accent "TL;DR" label even
over a refusal/error ("**TL;DR** Not enough to summarize yet…"). Deferred deliberately: hiding it
correctly requires distinguishing the streaming phase (where the prefix SHOULD show) from a settled
refusal, for the lowest value in the set; the refusal text itself is honest. Revisit if a lens
re-raises it.

*Lesson: an independent verifier that must DISCOVER the surfaces (not be handed them) is what catches
"the guard covers 2 of the 4 places" — and the cleanest close of a test-gap is often a root-cause code
change that makes the gap moot, not another assertion. C + §E#1 were two faces of the same missing
3-state model.*

## c3r37 — full 7-lens round on the c3r36b build (b427189): CONVERGED (2026-07-30)
First full 7-lens round since the two AI-summary batches. Gate green (72). Tally across all seven
read-only lenses: **BLOCKER 0 · HIGH 0 · MEDIUM 1 · LOW 10**, and — the signal that matters —
**0 self-inflicted** (nothing traceable to the c3r36 / c3r36b batches; the bug/correctness lens came
back fully CLEAN, and the performance lens measured that `memo(StoryCard)` still holds — 0 ms
Save-toggle at 75 cards — so the controls-row rework added no re-render regression).

This meets the **TERMINATION** criteria (see Convergence above): 0 BLOCKER/HIGH, 0 self-inflicted, the
one MEDIUM accepted in writing, LOWs triaged. The round CONVERGES.

**The 1 MEDIUM — ACCEPTED IN WRITING (architectural, pre-existing, not a convergence blocker):**
opening a mid/large discussion misses the 2.5 s budget (82-comment thread ≈ 2650 ms, 436-comment ≈
4052 ms to first comment) because the whole comment tree is fetched as one payload and rendered
all-at-once (each comment a DOMPurify parse on first paint); there is NO N+1 (firebase = 1 request).
The fix is progressive / virtualized comment rendering — a dedicated, sizeable change, not a contained
batch item. Accepted for a future dedicated effort; small/medium threads (the common case) are within
budget.

**The 10 LOWs — triaged backlog (validated against source where actionable):**
- *Contained + worth a small future batch:* (a) `computeAffinities` counts a read-then-**hidden**
  story in `domainCounts`/`authorCounts`, so an "often" habit chip can cite a story marked "Not
  interested" (AI lens; `interactions.ts` — gate the tally on the current `hidden` set, carefully vs
  the leave-one-out `rec.counted` subtraction). (b) `HnAccount` **hover** states use
  `text-accent`-on-`bg-accent/10` which is sub-AA in ~32/62 theme×mode cells (design lens;
  `HnAccount.tsx:163,198` — use `text-fg` like every other tint sibling + extend `themecontrasttest`).
- *Nits / niche / accepted:* onboarding "Get started" is a no-op when 0 interests selected
  (usability); `SignalsDialog` metadata truncates at 320px+Large with no `title` tooltip (uiux); the
  16px brand icon collapses toward its accent bar (design, SPEC §7 caps logos at LOW); first-ever cold
  start 2873 ms + `article.ts` on the critical path + first-engagement 40–170 ms re-score (perf, all
  documented/architectural); the shipped meta-docs disclose the private dev process + `leakcheck` has
  no secret-SHAPE detection (OSS — a maintainer ship/scrub decision + a guard-hardening idea, no live
  leak; tree + all 15 commits verified secret-free).
- *Re-confirmed accepted (not re-fixed):* the card "TL;DR" accent prefix over a refusal/error
  (streaming-vs-settled distinction).

*Lesson: convergence is measurable and was reached — the round's own numbers (0 self-inflicted, the
only MEDIUM pre-existing + architectural) are what certify it, not "0 findings". The remaining backlog
is a deliberate, written triage, not an open wound.*

---

## c3r38-dev — developer-reported: the discussion toolbar wraps to two ragged rows on narrow screens (2026-07-30)

**The report (with an annotated screenshot):** on a ~498px window the discussion toolbar splits into
two rows — `count · Sort` on row 1 (~63% full) and `⋯tools · N new` on row 2 (~34% full) — with big
empty gaps in both, and the note "some elements can collapse or remove when space is tight."

**This is a RECURRENCE of the c3r18d class**, and the recurrence is the lesson. c3r18d "fixed" the
same toolbar wrap by *slimming the row* (Most replies→Replies, drop "comments" below xl, icon-only
tool labels) — which bought one row **only from ~600px up** and explicitly ACCEPTED sub-600 wrapping
as "wraps well". The new defect lives in that accepted band (~460–540px) and only appears when the
**"N new" catch-up button is present** (max-content). So "slim it for desktop, wrap well on phones"
was never a fix for the class — the class is "too many controls for the width," and the app already
had the right answer (the story-card action row's container-query overflow into a ⋯ menu). The
toolbar was simply the outlier that still wrapped.

**Which lens should have caught it, and why it didn't (golden rule #8).** The UI/UX-stress lens DID
drive this surface and CERTIFIED it "clean / not the empty-space defect" — a false negative, worse
than a gap. Two compounding causes, both proven:
1. **Incomplete state:** its harness had no unread comments, so the "N new" button — the element that
   tips the row ragged — never rendered. Its own `disc-toolbar-600/768` captures have no "new" button
   and one row; the reporter's screenshot has "58 new" and two ragged rows.
2. **Skipped band + convenient fill:** it measured "row-1 82–95% full" only at phone widths (320–390),
   and treated the ~460–540 band as "intended wrap" without measuring fill there (row 2 = 34%). The
   old `wrapqualitytest` had the same holes — its width sweep stepped 600→500→430 and it EXCUSED any
   sub-768 wrap as "genuinely can't fit."

**Brief upgraded first (`base/uiux-stress.md`), then proven, then fixed:**
- Added a **"Render the MAX-CONTENT state before judging ANY row"** section (populate the "N new"
  button via a seeded prior visit, Ask via a cloud key, long model names/usernames/counts).
- Width sweep rewritten to **≤40px steps over the whole 320–1440 range**, explicitly including the
  440–720 band the old list skipped.
- **Fill% is the threshold, not the width label:** any wrapped row < ~70% full is a defect at EVERY
  width — deleted the "fine on a phone" escape hatch.
- A **"not-a-defect" verdict now carries the same proof burden** as a finding (max-content state +
  measured fill%), and reachability ("everything's still reachable") may NOT downgrade a ragged wrap.

**Proof before fix.** A fresh UI/UX lens, given only the upgraded brief and a neutral appendix (no
mention of the toolbar), INDEPENDENTLY rediscovered it on the unchanged build — it seeded the "60 new"
button + a cloud key, swept 320–800, tabulated fill% (row 2 ~34–40%), quoted the new fill rule, and
flagged the outlier-vs-⋯-menu inconsistency (it rated it LOW-borderline on reachability grounds,
which the severity clause now forbids). And the rewritten `wrapqualitytest` FAILS pre-fix (2 rows at
320–540, no folding, no menu) and PASSES post-fix.

**The fix.** `CommentsView` wraps the toolbar in `@container/tb` and folds overflow into the ⋯ menu:
**tools (Search/Summary/Ask) first** (below `@xl`≈576px CQ), then the **Sort control** (below ~500px
CQ), so it is ONE row at every width 320–1440 (verified across the 31 themes; `terminal`/mono widest).
`MenuItem` was extracted to `ui/primitives` so the card and toolbar share one component; only one of
{inline tools, menu} is in the DOM at a time, so no duplicate accessible names. `wrapqualitytest` now
asserts one row at every width, the tools-before-sort fold order, and that the ⋯ menu holds every
folded control.

*Lesson: a "fix" that treats the symptom for one width range (slim the row for desktop) and accepts
the failure elsewhere (wrap on phones) is not a fix for the class — it just relocates it. The class
here was solved once already on the story card; the toolbar should have adopted the same overflow
pattern. And a lens that certifies a row "clean" without rendering its busiest state is producing
false negatives — the max-content rule is now mandatory.*

---

## c3r38-dev-2 — the toolbar redesign, co-designed with the maintainer via mockups (2026-07-31)

The c3r38-dev fix (fold whole controls into ⋯) was correct-by-the-guard but the maintainer, driving
the real build, rejected it on **look**, across several rounds of feedback that the lenses had not
been measuring:
1. "full width yet collapsing already" — at the *capped* reading column (`max-w-3xl`, ~734px CQ) the
   tools were icon-only with a huge center gap; there was room for labels.
2. "empty space is empty space no matter where it is" — a **hug-content** variant (bar shrinks to fit,
   leftover beside it) was rejected: relocating the gap is not removing it.
3. "sort should stay flat as long as possible; Replies especially" then "sort is MORE important than
   search" — an explicit control-**priority** the briefs never encoded.
4. "this is weird — search disappears then reappears" — the first attempt was **non-monotonic**.

**Root cause of the churn:** the review lenses measure *overflow, wrap, and contrast* but had **no
notion of a control-priority order or of monotonic degradation**, and no way to capture the
maintainer's aesthetic constraint ("no visible empty space anywhere, at any width"). So each fix
satisfied the guard and failed the eye.

**What resolved it:** iterating the redesign as **self-contained HTML mockups served from
`public/mocks/`** (drag-to-resize live + fixed-width snapshots), screenshotted and sent to the
maintainer, until approved — *before* touching React. The mockup immediately caught two things a
guard would not have surfaced early: a `flex: 1 1 auto` search box uses its *content* width as its
flex-basis and wraps (must be `flex: 1 1 0`), and the exact fold thresholds per theme.

**The shipped design:** full-width bar; **Summary/Ask fold first**, the flat **Sort degrades 4→2→⇅
toggle** (full options always in ⋯), the **Search is a flex-fill inline filter** that fills leftover
space then moves to ⋯ last; monotonic (controls only ever simplify). Search changed from a tray tool
to a persistent inline `input`, which rippled into 4 harnesses (they drove the old "Search" button) —
all updated to drive the inline box. Guarded by `wrapqualitytest` (one row 320–1440 × {default, mono};
the 4→2→1 degradation order; Summary/Ask-first, Search-last fold; ⋯ holds every folded control).

**Lens upgrade this produced (folded into `review/base/uiux-stress.md` / `usability.md`):** a control
ROW with N>2 controls in a fixed-width container must be judged for (a) monotonic degradation — as
width drops, controls only simplify, never reappear; (b) zero visible empty space at every width —
"the gap is on the page not the bar" is not a defense; and (c) an explicit, documented control-
priority order (what degrades/folds first vs last). *Lesson: guards catch wrap and overflow; they do
not catch "looks sparse / folds in a jarring order / relocates the gap". For a non-trivial responsive
control cluster, a hosted MOCKUP reviewed by the maintainer is the right tool before building, and the
priority order + monotonicity + no-empty-space rules belong in the lens briefs so a future round can
measure them.*

## c3r39 — header touch-target root-cause + full 7-lens review (2026-07-31)

**Developer report → root cause.** "Narrowing the window increases the discussion-header vertical
space even though no line wraps." Root cause: a width-gated touch rule — `index.css` gave the
header/comment/card action controls a 44px `min-height` inside `@media (max-width: 1023px)`, so a
NARROW DESKTOP window (a mouse, not a phone) got phone-sized tap targets, ballooning the meta row
16px→44px with no wrapping. Fix: gate touch sizing on actual touch capability (`@media (pointer:
coarse)`), matching the existing `.seg-act` rule — desktop stays compact at every width, real touch
devices keep 44px. Header spacing also tightened (title→meta 6px, meta→pill 8px). Per golden rule #8
the design/uiux briefs were upgraded with a "vertical space grows on a narrow desktop with no wrap"
detection directive and the fix was proven; guarded by `mobiletest` (narrow-desktop fine-pointer stays
compact) + the `hasTouch` touch-target assertions.

**7-lens outcome: 0 BLOCKER, 0 HIGH; OSS = READY for public GitHub.** Design&theme CLEAN; performance
within budget; AI ranker beats the popularity baseline. All findings were 4 MEDIUM + LOWs on the new
discussion toolbar.

**Fixed (test-first + gated):**
- M1 `l` opened a duplicate tray search over the inline box → focuses the inline box.
- M2 "N new"/gist jump during an active search navigated away to a permalink → clears the filter and
  lands in the thread (`jumpToComment` defers via `pendingJump` when searching).
- M3 the toolbar's own controls (Sort, ⋯, "N new") skipped the 44px touch target → added to the
  `pointer: coarse` block.
- M4 below ~400px the folded-search row left a dead trailing gap → right actions pin (`ml-auto`).
- L1 `/` focused the global nav search on /item → prefers the inline discussion search.
- L2 the narrow ⇅ sort toggle only flipped Newest/Replies → cycles all four sorts.
- L3 "Ask" fed an off-topic proxy page (paywall/cookie-wall) to the model labelled "+ article text" →
  applies the shared `articleLooksRelevant` guard (moved to `hn/article` so summaries, Ask, and the
  ranking path can share one definition). VALIDATED-AND-PARTIALLY-REJECTED: the guard was deliberately
  NOT applied to the ranking path (`content.ts`) — an off-topic page's terms rarely match the liked
  profile, and the title↔body heuristic false-drops a legit vague-title article (the train/serve
  parity fixture proved it). Applied only the correct half.
- L4 (COMMENT-WRONG) `feedcontinuitytest`'s comment claimed the fix made engage-cost "not scale with
  the list" → corrected: the re-rank (computeForYou + re-render of the cards whose rank actually
  changes) is inherent to live personalization and DOES scale; the identity fixes only remove the
  churn of UNCHANGED cards.

**Accepted in writing (LOW, with rationale):**
- L5 comment Sort (~123ms) / Tune slider (~102–159ms) exceed the 100ms local-control budget ONLY
  under an artificial 4× CPU throttle; unthrottled they are a few ms. Accepted.
- L6 `article.ts` (~8KB gz, off-by-default reader-proxy feature) sits on the cold-start critical path.
  Negligible; accepted.
- L7 `themecontrasttest`'s /item fixture seeds no OP badge / "new" comment / collapsed-reply pill, so
  those accent tints aren't render-measured (the underlying TOKENS are guarded across all 62 combos and
  the design lens confirmed the rendered controls pass this round). Accepted as a documented follow-up:
  the render-walk's "expand every `aria-expanded=false`" step clicks the reply pill away before
  measurement, so a clean fixture change is risk-prone across 62 combos for a gap with no actual defect.
- OSS dev-process disclosure in `AGENTS.md`/`review/*` is an accepted maintainer decision (SPEC §10).

## c3r40 — CONFIRMING round certifying the c3r39 fixes (2026-07-31)

Ran all 7 lenses read-only against the rebuilt HEAD. Outcome: **0 BLOCKER, 0 HIGH; OSS still READY.**
The value of a confirming round — it caught **3 SELF-INFLICTED regressions** from the c3r39 fixes
(none were visible from inside the change round), plus one pre-existing perf MEDIUM. All 3 self-
inflicted defects are fixed + guarded:
- **SR1 (MEDIUM, from the L1 fix)** `/` became a DEAD KEY on a narrow discussion. `KeyboardShortcuts`
  preferred `.disc-tb-bar input[type="search"]` but — unlike the sibling `l` handler — omitted the
  `offsetParent` visibility check, so it targeted the folded (display:none) inline box and the `??`
  fallback to the global search never ran. Fixed with the same visibility check; guarded by
  `discussionviewtest` F3b (narrow-width `/` focuses the visible global search). The classic
  sibling-inconsistency the fix discipline warns about — the `l` fix was right, `/` copied it wrong.
- **SR2 (MEDIUM, from the M4 fix)** the "…" overflow menu clipped ~21px off the LEFT edge at ≤340px.
  M4's `ml-auto` pinned the ⋯ trigger to the column's right edge, so the right-anchored `w-56` menu
  spilled left — and unlike the story-card ⋯ menu it had no viewport clamp. Added a `useLayoutEffect`
  horizontal clamp; guarded by `wrapqualitytest` (menu fully on-screen at 320px).
- **SR3 (LOW, from the L3 move)** the `articleLooksRelevant` doc-comment was orphaned in `llm.ts`
  after the function moved to `hn/article`. Deleted.

**Accepted in writing (LOW/pre-existing, with rationale):**
- Perf MEDIUM (PRE-EXISTING, not a c3r39 regression): the non-AI `ThreadGist` HTML-parses the whole
  comment tree once when the Summary tray is opened (~220ms unthrottled / ~954ms@4×CPU on a 659-comment
  thread). Already memoized (not per-render) and deferred to tray-open; a cheaper scoring proxy would
  alter the gist's comment ranking on a fallback path. Documented follow-up.
- Pre-existing LOWs: duplicate accessible name "Article" (external link vs the Discussion|Article
  view-tab, disambiguated by role/icon); the "…" menu uses `border-border` + `shadow-xl` like every
  app dropdown (delineated, not a WCAG failure).

*Lesson: a change round never certifies itself — the confirming round found 3 regressions the change
round could not. Two were sibling-inconsistencies (a fix applied correctly in one place, copied
without its guard into a sibling): the `offsetParent` check present in `l` but missing in `/`, and the
viewport clamp present on the story-card menu but missing on the discussion menu. Enumerate the
siblings of every fix.*

## c3r41 — CERTIFYING round + CI-flake hardening (2026-08-01)

Ran all 7 lenses against the batch-4 build. **0 BLOCKER, 0 HIGH; OSS still READY**; self-inflicted
rate down again (c3r40: 3 → c3r41: 2, both LOW). Resolved:
- **SR-B (LOW, self-inflicted from the c3r40 clamp):** the discussion "…" menu clamp comment claimed
  parity with the story-card menu but omitted its resize/orientation-close listener, so the menu could
  drift off-screen if the viewport changed WHILE OPEN. Added the listener (real parity). Guarded by
  `wrapqualitytest` (menu closes on resize while open).
- **Inline-search touch target (LOW):** the discussion search `<input>` was 34px on touch while every
  sibling was 44px (the c3r39 touch pass missed the input). Added it to the `pointer: coarse` block;
  `wrapqualitytest` touch check now includes it.
- **gitignore hygiene (LOW):** throwaway `scripts/_*.mjs` review-probe scripts are now ignored.

**Accepted in writing (with rationale):**
- **Center-gap MEDIUM** (≤400px, after Search folds): a genuine tension between two rules — "Search
  folds to … LAST" (approved in mock v4) vs "no visible empty space at any width". At the narrowest
  the Search flex-filler can't stay inline without overflowing the one-row constraint, so folding it
  is unavoidable and the resulting count-left / actions-right layout is a standard mobile pattern.
  Maintainer decision: accept for now. (Follow-up option: lower the fold threshold to keep Search
  inline on more phones, folding only at the true extreme.)
- **SR-A (LOW):** on a narrow discussion `/` focuses the global search while `l` opens the in-thread
  tray. `/` is the app-wide "focus search" shortcut; falling back to the global search when the inline
  box has folded is reasonable, and `l` remains the discussion-specific search. Unifying them would
  couple the global handler to the tray state.
- The 2-button Sort degrade showing no selected segment for Default/Oldest (recoverable via "…").

**CI-flake hardening (the failing GitHub CI, `npm run verify` on the slow hosted runner):** the CI was
red intermittently — NOT on any product code, but on two timing races the slow runner exposed that a
fast dev machine hides. (1) `offlineuxtest` M3 switched feeds while offline, but the app prefetches
adjacent tabs and keepPreviousData held the prior feed's data, so the new feed's outage never rendered
→ now it loads the uncached feed FRESH via reload (empty cache; SW serves the shell; the list fetch
aborts → outage). (2) `audit`'s Read-tab check resolved on a transient "Nothing to show" before the
async Dexie read-ids query populated → now it waits for the seeded read item to actually render.
*Lesson: a harness that waits for "some content OR the empty state" races an async data source — wait
for the SPECIFIC expected element, and drive outage states from a FRESH load, not a keepPreviousData
tab-switch.*

## c3r42 — full 7-lens round on b8b1984, then two fix batches (2026-08-02)

**Brief upgrades first (golden rule #8).** The developer report "the GitHub release action is failing"
was treated as evidence a LENS was blind, not as a work order. Three base prompts and the spec were
upgraded BEFORE the round:
- `base/oss-release.md` — audited workflow YAML statically but never checked whether the workflow
  actually PASSES. Every lens tests the local preview and the local gate, and both were green while
  public CI was red. Now requires inspecting real run history (read-only `gh`), reporting failures,
  INTERMITTENCY, the local-green/hosted-red shape, and whether the deployed page boots.
- `base/uiux-stress.md` — had NO touch-target directive at all, yet two consecutive rounds each found
  exactly one undersized control. Now requires ENUMERATING every interactive element type (inputs and
  links included), per cluster, reported as one table.
- `base/_common.md` — added the partial-parity claim shape: a comment claiming parity with a named
  sibling asserts EVERY behaviour of the referent.
- `SPEC.md` §11 — records the accepted narrow-width toolbar centre gap with its exact scope.

Both new detectors fired immediately: the touch enumeration and the parity audit produced the #1 and
#3 findings of the round.

**Round outcome: 1 HIGH, 9 MEDIUM verified.** The "…" overflow menu having no VERTICAL clamp was
found independently by THREE lenses. The OSS lens found public CI red on 11 of 16 runs on main, with
deploy not gated on CI — 11 commits published over a red gate — and traced the local-green/hosted-red
divergence to the repo bundling no fonts, so width-sensitive assertions measure differently on the
runner. (Verified: 11 failures / 5 successes; the failures were `wrapqualitytest` x3, `audit` x2,
`offlineuxtest` x1 — the earlier CI "fix" had closed only two of the three.)

**Batch 1** — menu vertical clamp (HIGH), deploy gated on CI, touch-target siblings, "Not interested"
counted as positive engagement, `closeTool` wiping the search filter.
- The two popovers had TWO divergent clamp implementations, one claiming parity with the other. They
  now share ONE hook (`ui/usePopoverClamp.ts`), so parity is structural rather than copied.
- `hide` was the unhandled sibling of `unsave` in the withdrawn-engagement cleanup. First attempt
  re-derived "hidden" locally and was ORDER-DEPENDENT — caught by `feedstabilitytest`, which the file's
  own comment predicted. Replaced by consuming `classifyEngagement`'s `hidden` set, the declared
  single source of truth.

**Two diff-scoped passes then found SIX self-inflicted defects in batch 1** — the strongest argument
yet for check (iv):
- **BLOCKER**: the new `workflow_run` deploy trigger let a FORK PULL REQUEST publish. CI also runs on
  `pull_request`, the `branches` filter matches the TRIGGERING run's head branch, and a fork's default
  branch is `main` — so a PR from `fork:main` would have been built and published from a job holding
  `pages: write`. Now requires `event == 'push'` AND a matching `head_repository`.
- **HIGH**: a flipped-up menu slid UNDER the sticky TopNav (z-30 vs z-20) — measured top 26px against a
  57px nav, `elementFromPoint` returning the header. The vertical algorithm was rewritten to pick a
  whole side (below / fully above / larger side capped and scrolling) and to treat the pinned header's
  bottom as the top of the usable band. It never partially lifts, which is what put a menu ITEM under
  the dismissal tap.
- **HIGH**: the `closeTool` fix re-introduced the stranded-filter bug below 400px. The real invariant is
  not about which tool owns the query — it is that a filtered thread must always offer a VISIBLE way
  out. A Clear control now lives on the RESULTS, so it holds on every route (tool switch, resize,
  rotate), and Escape clears a filter that outlived its input.
- Plus: a height-only re-place could put the menu below the fold; the release-gate check overclaimed;
  guards under-covered (the menu sweep ran with no `hasTouch`, the profile leg rendered "User not
  found" and measured nothing, and one `check()` was dropped so its sweep computed offenders and never
  asserted them).

**Batch 2** — preview requests continuing after cards unmount (now consume React Query's AbortSignal;
new `previewcanceltest`), the "Why #N?" panel printing a signed value for a signal that contributes
nothing until the learned model trains, `getItems` turning a total item-endpoint outage into a
confident "0" with no Retry, the search `<mark>` failing AA, Chrome's theme-blind search-cancel glyph,
and `mdLite` emitting bullets that rendered with no markers (scoped to a new `.md-body`, leaving HN
comment bodies alone per SPEC §10).

*Lessons.* (1) A probe can be VACUOUS: the first "Not interested" guard passed pre-fix because a
value-less `dwell` contributes 0, so the story never entered the tally being tested — the finding was
real and the probe was wrong. Always confirm a new guard FAILS before the fix. (2) A bounding box is
not a hit test: two of the worst defects this round were fully "inside the viewport" and still
unreachable. (3) Fixing a stranding bug per-ROUTE invites the next route; anchor the affordance to the
STATE (the results) instead.

## c3r43 — CONFIRMING round on the c3r42 fix batch (2026-08-02): NOT converged

Six lenses (perf not run this round — recorded as a gap). Outcome: **0 BLOCKER, 2 HIGH, 10 MEDIUM**,
and a **self-inflicted count of ~13** — sharply UP from c3r41's 2. The cause is not the review side:
this round changed 27 files, and the measured relationship between batch size and self-inflicted
defects is the same one CONVERGENCE MODE was written for. The ~5-finding cap was respected per batch
but three batches ran back-to-back before a full round, which is effectively one large batch.

**Confirmed sound under adversarial re-testing** (the substance of the c3r42 work held): the shared
`usePopoverClamp` across 96 hit-tested layout x viewport cells; `.seg-btn`/`input[type=search]` truly
44px app-wide; `.md-body` bullet scoping (markers painted in 62/62, HN comment bodies untouched);
`mark` now AA in 62/62 (worst 5.15, was 3.92); `classifyEngagement` byte-identical across event
orderings with all five derivations agreeing; the deploy gate's automatic path — fork-PR,
dispatch-triggered CI, red/cancelled CI, tag push, stale commit and skipped-`needs` all correctly
closed. The design lens also closed the c3r41-accepted OP/"new"/reply-pill follow-up (AA in 62/62).

**Fixed in this batch:**
- **HIGH (OSS)** three NEW files were untracked while already imported by tracked files — a
  non-atomic commit would have failed `tsc -b` and broken the public build. Now tracked.
- **MEDIUM (bug)** the new "Escape clears a filter with no tool open" branch was INERT: the keydown
  effect was not keyed on `query`, so the listener held a stale value — the handler could not see the
  exact case it was written for. Guarded by `discussionviewtest` F8 (pre-fix FAIL demonstrated).
- **MEDIUM (bug)** a profile printed "Stories (0) · Comments (0)" directly above its own outage
  error, which SPEC §6 forbids. Counts are now omitted while the activity fetch is failing.
- **MEDIUM (uiux)** the results `Clear` control — added so a filter always has a visible way out —
  was itself 26px on touch among 44px neighbours.
- Four false comments introduced by the previous batch (a width-conditional rule the code does not
  implement, "enumerating finds them all" above a two-selector list, an overstated claim about what a
  negative term-overlap means, and a gate check that claimed to prove publishing safe when it checks
  for specific known regressions).

**Still open — carried, not fixed:**
- **HIGH (OSS)** every dependency-bump PR fails the gate on `third-party notices up to date`
  (the notices carry a Version column a bot cannot regenerate); now that deploy is gated on CI, a
  merged bump would silently stop publishing rather than just showing a red X.
- **MEDIUM** the "Not interested" fix corrected the habit COUNT but not the affinity SUM, so a
  rejected story can still leave +2.0–2.5 of positive domain affinity (AI lens F1, measured).
- **MEDIUM** regime-dependent discovery failure: with a taste concentrated on few domains, saturated
  affinity features out-vote content and no slider setting moves a position (AI lens F2).
- **MEDIUM** `hover:opacity-90` drops primary-button labels below AA in 28/62 cells (design M1).
- **MEDIUM** searching a discussion discards every subtree the reader had expanded (usability).
- **MEDIUM** `releasegatecheck` is a known-regression check, not a proof (now documented as such);
  7 of 8 semantic mutations still pass it.
- **MEDIUM** docs still describe the pre-gate push→publish flow.
- Plus LOWs: markdown headings flattened (sibling of the bullet fix), absent item on `/item/:id`
  retries forever, the results Clear also closes an unrelated open tool, stale breakpoint numbers.

*Lesson (the important one).* Three sequential fix batches before a confirming round behaved like one
oversized batch and produced the worst self-inflicted rate yet measured. The cap that matters is not
findings-per-batch, it is **changes between independent confirmations**. Next round: one batch, then a
full round, then stop — regardless of how many findings are outstanding.
