# Lens: UI/UX STRESS ("break the app")

> **What may change in this file.** It states EXPECTED END RESULTS (authority: `review/SPEC.md`) and
> MEASUREMENT VALIDITY — how to observe something without producing a false negative. It must NOT
> accumulate a checklist of past bugs, a named suspicion, or anything that tells you where to look:
> that biases the lens away from first-principles discovery and makes each round's finding count a
> function of this file's growth rather than of the product's state. **Deleting such an entry is
> always allowed and never needs justification.** This file changes only in an INSTRUMENT-ONLY
> interval, never alongside a `src/` change (AGENTS.md rule 7a, enforced by the gate).

Read `_common.md` first. You are the UI/UX stress lens. Report to the path in the appendix
(e.g. `/tmp/<round>_uiux.md`).

## Your job

A creative, adversarial **"break the app"** pass over the visual/interaction layer. Your job is to
FIND layout, overflow, scrollbar, stacking, interaction, AND **visual-rendering** glitches. If you
find nothing, you were not adversarial enough — escalate. (Real, reproduced glitches only — no
speculation.)

**Your PRIMARY method is to LOOK at the actual rendered UI in screenshots — for EVERY page and EVERY
element.** You are not a DOM auditor; you are an eye. Metrics (`scrollWidth`, `getBoundingClientRect`,
computed style) are a SUPPLEMENT you use to quantify and confirm what you SEE — they are NEVER a
substitute for looking, and they are blind to a whole class of defects (a control that is on-screen,
correctly sized, and passes contrast can still render *malformed*). A `page.evaluate` that returns
"no overflow" does NOT mean the page looks right. **You must screenshot it and read the pixels.**

## Method — SCREENSHOT-FIRST visual review of EVERY surface & element (MANDATORY — this is the lens)

Do this systematically; it is the core of the job, not an afterthought:

1. **Enumerate EVERY surface and visit each one.** At minimum: the home feed on **every feed tab**
   (For You, Top, New, Best, Ask, Show, Jobs, Read); a **discussion page** (`/item/:id`); a **user
   profile** (`/user/:id`); **Settings** (every section); **Search** results; **Saved**; and every
   **overlay/menu/dialog** (Why #N?, View request, Edit prompt, Signals, Hidden, Keyboard help,
   Onboarding, the extracted-article overlay, the Personalize ⋯ card menu). Miss no surface.
2. **On each surface, screenshot the full view AND zoom into every element cluster** — capture tight
   crops (Playwright element screenshots, or a small viewport) so individual controls are big enough
   to judge. Cover, on a story card alone: favicon, index/rank, meta row (domain/time/links), title,
   "why" chips, the TL;DR block + its action buttons, any inline preview, and the full action row
   (every icon button). Then the top nav (feed tabs, the theme/design/layout dropdowns), the feed
   header (Updated / Refresh / any toggles/switches), the sidebar (every panel + control), and the
   comments UI (thread lines, collapse/"N replies" pills, the sort/segmented control, badges).
3. **Judge each element's rendered FORM by eye**, not just its box: is it well-shaped, aligned,
   correctly proportioned, with the right fill / border / thumb / knob / icon, in a correct
   **on/off · checked/unchecked · hover · focus · disabled · selected** state? A **switch must look
   like a switch** (visible track, correctly-placed thumb, unambiguous on vs off); a **segmented
   control must show its separate segments AND which is active**; a checkbox/radio/slider must look
   like itself; an icon must actually be present. **"This doesn't look right" IS a finding**, even
   when every metric passes — capture it, describe what's wrong, and root-cause it.
4. **Enumerate the interactive controls from the DOM at runtime** (`[role=switch]`, `[role=checkbox]`,
   `[role=radio]`, `[role=slider]`, `input`, `select`, buttons + segmented groups, pills) so EVERY
   element — including newly-added ones — is covered automatically. **Never work from a hand-kept list
   of "the controls to check"** — that is exactly how a new control (a feed-header switch) slipped
   through unreviewed. If it renders on a page, it gets looked at.
5. **Repeat across the matrix** (below): several designs in BOTH light and dark, and multiple layouts
   and viewports. Custom-styled controls (switch/toggle, checkbox, radio, range slider, select) are
   the **highest-risk** because their native appearance is replaced by hand-written CSS that silently
   breaks per theme/mode — screenshot them in a low-contrast light theme AND an OLED dark theme.

## Device matrix (realistic heights — never oversized canvases)

Test across, at minimum:
- Desktop: 1280×800 and 1440×900.
- **Mobile emulation WITH TOUCH** (`browser.newContext({ hasTouch:true, isMobile:true, viewport })`):
  390×844, 360×780, 320×568. Emulating touch matters — headless overlay scrollbars have 0 thickness
  and hide scrollbar bugs unless you emulate a real touch device and inspect computed styles.
- Tablet: 820×1180 (portrait) and 1180×820 (landscape).
- **Cramped heights**: 768, 700, 640 — this is where sticky/overflow bottoms become unreachable.

Drive across **all layouts** (`window.__hnlens.themes().LAYOUT_IDS`) and several designs (light AND
dark); a glitch often appears only in a specific layout×design×mode×viewport combination (e.g. a
multi-column layout that is the default for some design, on a phone; a switch that only breaks in dark
mode).

## Touch-target sweep: ENUMERATE every interactive element, never sample the buttons (folded in)

Under real touch emulation every interactive element must meet the ~44px minimum tap target. Two
consecutive rounds each surfaced exactly ONE control below the minimum while its neighbours in the
same row were correct — found one at a time, because each pass eyeballed the obvious buttons.
Sampling finds one per round forever; enumeration finds them all in a single pass.

Do it exhaustively, per container, with touch emulation on:

1. Query EVERY interactive node in the surface, not just `<button>`:
   `button, a[href], input, select, textarea, [role="button"], [role="menuitem"], [tabindex]:not([tabindex="-1"])`.
   The recurring miss is the NON-button element — a text/search `<input>` at 34px while every sibling
   button in its row is 44px, or a menu row that is an `<a>`.
2. Measure each with `getBoundingClientRect()` and report every element under the minimum with its
   accessible name, tag and measured height/width, as ONE table — not as one finding per control.
3. Repeat for each control cluster the product has (discussion toolbar and its overflow menu,
   story-card action row and its menu, feed tabs, sidebar, settings rows, dialogs). A sizing rule
   applied to a container is normally applied by a SELECTOR LIST, and a selector list is exactly
   where one element type gets forgotten.
4. Flag the INVERSE too: a control that receives touch sizing on a FINE pointer (a mouse), inflating
   desktop rows. Sizing must key off pointer capability, not viewport width — a narrow desktop window
   is not a touch device.

## Defect classes to hunt (screenshot the symptom, then measure it)

- **Malformed / broken-looking controls (screenshot it — metrics are blind).** Per the method above:
  a toggle/switch with a miscolored, mis-sized, off-center, or missing track/thumb (so it doesn't read
  as a switch or its state is ambiguous); a segmented control that looks like one blob; a
  checkbox/radio/slider whose custom CSS half-applied; a button with broken shape/padding; a missing
  icon glyph. On-screen + correctly-sized + AA-contrast does NOT imply well-rendered. This is the
  highest-value class you own and the easiest to miss with a metric-only pass.
- **Horizontal PAGE overflow**: `document.documentElement.scrollWidth - clientWidth`. Report the px
   delta and the offending element. Try long unbreakable title tokens and long search queries.
 - **Undersized input/textarea clips its OWN content (vertical, folded in c3r34).** A `<textarea>`/
   `<input>` whose fixed height (`rows=`) is smaller than the value it holds CLIPS that value — the
   text is cut mid-line by the box's bottom edge, forcing the user to scroll a tiny box to read it.
   Screenshot every content-bearing field that holds a REAL multi-line value (especially the AI prompt
   editors — the SummaryActions "Edit prompt" dialog and Settings → "AI prompts (advanced)", both the
   system instruction AND the user template) and confirm the value is readable without scrolling a
   2–3-row box; a several-sentence prompt in a `rows={2}`/`rows={3}` textarea is a finding. (Pairs with
   the usability lens's edit-fidelity sweep, which owns the placeholder-as-current-value half.)
- **The `min-w-0` overflow class (recurring here — folded in from findings, keeps reappearing):**
  ANY flex/grid child with `w-full` / `flex-1` / `flex-shrink:0` but no `min-w-0` takes its automatic
  min-width = min-content, so on a narrow viewport it can EXCEED the screen and push controls off.
  Instances found across rounds: a **dialog card** whose close **[X]** ends up off-screen; a
  single-column **grid card**; an **input+button row** (a `flex-1` text input with no `min-w-0`
  shoved the "Add" button off-screen — Settings TagEditor); a **meta row** pinned `flex-shrink:0`
  whose truncate-able child had no shrink budget (compact layout). So check BOTH dialogs AND ordinary
  flex rows: open EVERY dialog/modal (Signals, Hidden, View-request, Edit-prompt, Why #N?, Keyboard
  help, Onboarding, article-text overlay) at **320px** with real content (card fits + close on-screen
  via `getBoundingClientRect().right` vs `innerWidth`), AND scan every page (Settings especially, with
  its input rows) + drive **grid/magazine/bento/compact** layouts at 320px for horizontal PAGE
  overflow. Multiply EVERY overflow check by the **"Large" reading-text size** (`prefs.textSize='lg'`)
  — it inflates min-content and is what exposed most of these (they're clean at `md`).
  - **Fixed REM-width columns starve their flex sibling under Large text (folded in from findings — a
    MEDIUM):** a row of fixed rem-width side columns (e.g. a `w-44` label + a `w-24` value) around a
    `flex-1` middle (a bar/chart) inflates BOTH side columns under `textSize='lg'` (they're rem-based)
    while the container is pinned to the viewport — so the `flex-1` middle is squeezed to **0px** (the
    bar/chart VANISHES) and, if a side column's content can't wrap, it spills past the modal edge.
    Low-vision users (Large text IS the a11y accommodation) on a common phone width (≤360) are exactly
    who hits it. The RankExplain "Why #N?" contribution bars did this (bars 0px at ≤360+lg, value
    formula clipped at 320+lg). Test every multi-column row INSIDE a dialog at 320px × Large text: the
    flex middle must keep a non-zero width (give it a `min-w`), and the side columns must shrink/
    truncate or drop non-essential content below a breakpoint — fixed rem widths that can't shrink are
    the tell. (Guard-authoring caveat: measure the SCROLL CONTAINER's overflow, not every descendant —
    a `truncate`d label legitimately clips its own content, `scrollWidth>clientWidth`, and false-
    positives a naive descendant sweep.)
- **The long-unbreakable-token class (distinct from `min-w-0` — folded in from findings):** every
  text element that renders USER CONTENT (story titles, comment/username text, word-cloud terms,
  domains) needs `overflow-wrap:anywhere` (or `break-words`) or a single ~40-char token (a
  snake_case identifier, a long URL, a CJK run) overflows the whole page. The feed already guards
  this (`.sc-title`, `.hn-html`); the traps are the surfaces that DON'T reuse those classes — the
  discussion `<h1>` overflowed because it hand-rolled its own text styling — any surface that does
  the same is a candidate. For each user-content text element, feed a ~44-char unbreakable token at
  320px and assert no page overflow; cross-check that the SAME title wraps on the feed card but not
  on the discussion page (that inconsistency is the tell). **Enumerate EVERY user-content text node on
  a surface, not just the headline:** guarding one leaves its siblings exposed — after the discussion
  `<h1>` was fixed, its SIBLING **domain meta line** on the same header still overflowed at 320px
  (the feed card truncates that domain; the discussion header didn't). When you fix one text element
  on a header/row, sweep the domain/author/byline/meta nodes beside it in the same pass.
  - **`line-clamp`/`overflow:hidden` MASKS this — so the UNCLAMPED sibling is the real risk (folded in
    from findings):** a text `<p>` with `line-clamp-N` (which sets `overflow:hidden`) CLIPS a long token
    and never forces page overflow, so it looks safe; its sibling that shows FULL text (no clamp) is the
    one that overflows. Concretely: the card's clamped top-comment preview was safe, but the UNCLAMPED
    card TL;DR `<p>` (full summary text) overflowed +501px at 320. So don't assume "the sibling next to
    a clamped-safe element is also safe" — the ones to break-token-test are the NON-clamped full-text
    nodes (summaries, gist bodies, profile text). (Note: this means a test must render that full-text
    node to catch it — a clamped fixture hides the bug.)
  - **SVG sub-case (a page-overflow guard CANNOT catch this):** `<text>` labels in SVGs can't wrap —
    a long value CLIPS past the fixed `viewBox` with NO page scroll, so `scrollWidth` checks miss it
    entirely. Check each SVG text label is TRUNCATED to fit its available viewBox room (with the full
    value in a `<title>`), and note inconsistency between sibling SVGs.
- **Unwanted/visible scrollbars on strips** (feed-tabs, any horizontal rail): inspect computed
  `overflow`/`scrollbar-width` and the offsetHeight−clientHeight gap; confirm on a real touch
  context — AND look at the screenshot (an overlay scrollbar is invisible to metrics but visible on a
  real device capture).
- **Clipped / occluded / off-screen content and popovers**: use `getBoundingClientRect` and
  `elementFromPoint`, AND screenshot. Open every menu/dropdown/dialog — especially when its trigger is
  low in the viewport or inside a narrow column — and confirm it's fully on-screen AND topmost (not
  painted under a later element).
- **Unreachable sticky/overflow bottoms** at cramped heights (sidebar, dialogs): confirm the last
  child is reachable by scrolling within its container.
- **Z-index/stacking, text truncation/overlap, misalignment, missing focus-visible rings** — all of
  which you catch by LOOKING at the capture.

## Hostile interaction & races

Drive every control, then break the sequencing: rapid-toggle a control; change theme/layout/design
mid-interaction (menu open, dialog open, summary streaming); click the same control twice; submit
while busy (button AND Enter); resize 320↔1440 while something is open; collapse-then-filter;
out-of-range/negative/huge/regex-special inputs. **Screenshot the result of each hostile sequence** —
a broken intermediate state only shows in the capture. Watch the **console for real errors** across
the whole run (ignore benign favicon/resource 404s) and report any.

## What to report

Severity-ranked glitches. Each: the exact **device + viewport + layout/design/mode**, the repro
steps, **the screenshot** (the primary evidence) PLUS any measured numbers (scrollWidth delta,
bounding rect, computed style, `elementFromPoint` result), and the root cause (`file:line` — usually
an `index.css` layout/`data-layout`/control block or a component's positioning/markup). Include a
**"surfaces × elements I screenshotted and visually judged fine"** matrix so the primary sees the
breadth of the visual review — a report that only lists metrics and no visual inspection of controls
is incomplete for this lens.

## Measurement validity — where this lens produces FALSE NEGATIVES

- **A remedy SCOPED to one layout/theme/route, for a property that belongs to the COMPONENT.** When
  you find a fix already in the codebase written as `[data-layout='x'] .thing { … }` or
  `[data-theme='y'] …`, ask what the rule is actually compensating for. If the answer is a property
  of `.thing` itself (it cannot wrap; it has no scroll clamp; it does not flip at a viewport edge),
  then every OTHER layout/theme still has the bug and the narrow selector is evidence someone hit it
  once and patched only where they saw it. Proven twice in one round: `.sc-actions` had
  `flex-wrap: wrap` scoped to `newspaper` while overflowing the page in **9 of 14** layouts at
  320px + Large text, and the ⋯ menu had a horizontal viewport clamp but no vertical one, leaving
  12-25% of the menu on screen in **all 39** layout × viewport cells. Grep the stylesheet for
  layout- and theme-scoped rules, and for each one re-test the same interaction across the whole
  matrix.

- **The one surface that skipped the shared treatment.** Where the app has N instances of a pattern
  (dialogs, segmented controls, switches, empty states), enumerate ALL N and diff their
  implementations rather than sampling. The odd one out is the bug: of seven `aria-modal` surfaces,
  six had `max-h-[..vh]` + `overflow-y-auto` and one had neither, so its bottom was unreachable in
  every landscape phone orientation — and what it cut off was the accessibility escape-hatch text.
  Report the DIVERGENCE, and prefer recommending the shared shell over patching the outlier.

- **Text pinned to px on a reading surface, while the app has a text-size axis.** The reading-text
  setting scales the ROOT font size, so only rem-based text follows it. Grep for `text-[\d+px]` and
  classify each hit: badges and micro-labels are legitimately fixed chrome, but any surface the user
  READS (headline, comment body, preview, extracted article) must be rem or the setting lies. The
  giveaway is a hierarchy INVERSION at the largest step — a story headline rendering smaller than the
  grey preview beneath it, which is the exact opposite of what someone choosing "Large" asked for.

- **A FIXED overlay lives in the TAP LAYER, and no side is safe.** Any `position: fixed` control
  (FAB, toast, sticky bar) sits above whatever content scrolls under it. Hit-test it: at each phone
  width, scroll to several positions and call `document.elementFromPoint()` on the overlay's centre
  — if the topmost element is the overlay while a real control is beneath, a tap is silently stolen
  (and on a reader that can mean losing your place with no undo). Sweep EVERY layout, not one:
  gutters differ per layout, so moving the overlay to the other side just relocates the collision.
  Also `page.touchscreen.tap()` it for real, don't only hit-test.
- **`role="dialog" aria-modal="true"` DECLARES modality; the browser implements none of it.** For
  every dialog, verify the two behaviours the attribute only promises: background **scroll is
  locked** while it is open (and restored after), and **focus is contained** (press Tab ~20 times
  and assert `activeElement` is still inside). Watch for the inverse bug too — a dialog that is
  merely MOUNTED but not shown must NOT lock the page (hooks run even when a component early-returns
  null). A dialog with no focusable children can't receive focus at all unless its container is
  focusable.
- **A native `<select>` draws its own chevron INSIDE the content box.** A width-clamped select with
  symmetric padding renders the label *under* the arrow, and `text-overflow` computes to `clip`, so
  there isn't even an ellipsis. Measure the selected label's text width against the content box minus
  the arrow, for EVERY option, not just the default one.


## Render the MAX-CONTENT state before judging ANY row or cluster (folded in — this is the #1 miss)

A control row is only as good as its BUSIEST state, and most rows have OPTIONAL elements that appear
only in certain data/config states. Judging a row in its default (emptiest) state is how a ragged
two-row discussion toolbar shipped "clean": the harness had no unread comments, so the **"N new"
catch-up button never rendered**, and that button is exactly what tips the row into two ragged rows at
~498px. Before you screenshot/measure ANY cluster, enumerate its conditional elements and drive the
surface with ALL of them PRESENT (the max-content state). Known conditional elements to populate:

- **Discussion toolbar "N new" catch-up button** (`CommentsView.tsx`, gated on `newIds.length`): seed a
  prior visit so unread comments exist — load the app, `(await window.__hnlens.db()).db.seen.put({id,
  ts})` with `ts` (ms) older than most comments' `created_at_i` (sec), THEN open `/item/:id` (the mount
  reads the seen ts into `lastVisit`). Use a 2–3 digit count so the button is realistically wide
  ("58 new").
- **Summary / Ask buttons** in that toolbar (gated on `hasCloudKey || (llmEnabled && webgpu ok)`): set a
  mocked cloud key in prefs so both render (headless has no WebGPU).
- **Reader / cloud-model `<select>`** showing a LONG model name (the widest option), not the default.
- **Story-card meta**: a long HN username (up to 15 chars) + 3–4-digit score & comment counts.
- Any other element gated on data/config/state on the surface you're judging.

A row that is clean empty but ragged/overflowing once its conditional elements render is a DEFECT, and
"I didn't see it" because the state wasn't populated is not a pass — populate the state.

## Wrapping QUALITY, not just overflow

Every overflow check in this repo measures `scrollWidth - clientWidth`. That number is **0** for one
of the ugliest layout failures the app can produce: a control row that *wraps* — pushing half its
contents onto a second line and leaving the first line two-thirds empty — while the page itself fits
perfectly. Nothing overflows, so every guard reports clean, and the result still looks broken.

So measure the SHAPE of every multi-control row, not just whether the page scrolls sideways:

1. For each control row (the discussion toolbar, story-card action rows, the feed header, filter
   rows, dialog button rows), group its children by their `getBoundingClientRect().top` to get the
   actual number of RENDERED rows.
2. For each rendered row, compute the fill ratio: summed child width (plus gaps) over the
   container's inner width.
3. Flag TWO distinct failures, which look identical to a user but need opposite fixes:
   - **(a) It wrapped although it would fit.** Sum the children's widths plus gaps; if the total is
     less than the container's inner width and it STILL rendered on two rows, that is a layout bug —
     typically a greedy `flex-1` spacer eating the slack, or a cluster that can only move as a block.
   - **(b) It wrapped at an ordinary desktop width (>= 768px).** Here the content genuinely does not
     fit, and no amount of re-arranging helps: the row is over-stuffed and something has to get
     shorter (an abbreviated label, a word dropped, labels reduced to icons at mid widths).
   Reporting only (a) misses the more common case, and reporting only (b) misdiagnoses it — say
   which one you measured, and give the numbers (`total 827px into 718px` is the actionable form).
4. Sweep this across widths in **small (≤40px) steps over the WHOLE 320–1440 range** — do NOT jump
   between round breakpoints. The old example list (1440,1280,1150,1024,900,820,768,600,430,390)
   itself **STEPS OVER the ~440–560 band**, and a real ragged-wrap toolbar defect lived at ~498px (a
   narrow desktop window / large-phone-landscape / small tablet) — exactly in the skipped gap. Include
   720,680,640,600,560,520,480,440 explicitly. These failures live in the narrow band right where a
   cluster stops fitting, and testing only at round breakpoints steps straight over it.

Report the width band in which the bad wrap occurs and the fill ratio of the offending row, e.g.
"at 460-520px the toolbar wraps to 2 rows with row 1 63% full and row 2 34% full". **The threshold is
FILL%, not the width label:** a wrap where ANY resulting row is < ~70% full is a defect at EVERY width,
phone included — do NOT wave it away as "fine on a phone" (that exact rationalization certified a real
ragged two-row toolbar as clean). A wrap is only acceptable when each row is genuinely full, or the
content truly cannot fit and every row is packed tight.

**A "clean / intended wrap / not-a-defect" verdict carries the SAME proof burden as a finding:** you
must show (i) the row rendered in its MAX-CONTENT state (see the section above) AND (ii) the measured
fill% at the width where it wraps. A "clean" call reached from an incomplete state (a conditional
element such as the "N new" button missing) is a FALSE NEGATIVE — worse than not looking, because it
actively clears a real defect.

**Consistency cross-check:** if one control cluster collapses overflow into a menu when tight (e.g. the
story-card action row's container-query overflow into the ⋯ menu) while a SIBLING cluster (the
discussion toolbar) instead wraps raggedly, flag the inconsistency — the app has already chosen a
pattern for "too many controls for the width," and the outlier should adopt it. **Do NOT downgrade
such a ragged wrap to LOW because "everything is still reachable" — reachability is a SEPARATE axis
from wrap-quality.** A sub-~70%-fill ragged wrap that ignores an overflow pattern the app already uses
elsewhere is a real layout defect (treat as at least MEDIUM); the two-tap reachability of the wrapped
controls neither causes nor excuses the ragged shape.

Related, and worth checking in the same pass: when a row *does* legitimately wrap, does it wrap into
a sensible shape (balanced, aligned, grouped by function), or does one stray control end up alone on
a line? A single orphaned control is the same defect in a milder form.

## Responsive control clusters: monotonicity, no-empty-space, and a priority order (folded in)

For a control ROW with more than ~2 controls in a FIXED-WIDTH container (the discussion toolbar is the
canonical case: count · Sort · Search · Summary · Ask · N-new in a `max-w-3xl` column), `scrollWidth`
and even the fill-ratio checks above are NOT enough. Sweep the whole width range and grade three more
things that a guard does not catch but the eye does — all three shipped as defects here across
successive rounds:

1. **Monotonic degradation.** As the width DROPS, controls may only ever get SIMPLER — shrink, drop a
   label, degrade to fewer buttons, or move into "…". A control that DISAPPEARS at one width and
   REAPPEARS at a narrower one (observed: Search folded 470–560 then came back <470) is a defect; it
   reads as a glitch while resizing. Verify each control's presence is a monotonic function of width.
2. **No visible empty space at ANY width — wherever it is.** "The gap is on the page, not inside the
   bar" is NOT a defense (a hug-content bar that leaves space beside it was rejected for exactly this).
   The row must fill its width at every size: either a flex FILLER control (e.g. a search input) grows
   to eat the slack, or a control STRETCHES to fill when its neighbour folds. A fixed cluster pinned to
   one edge with a dead center/trailing gap is the defect — measure it at wide AND intermediate widths,
   not just where it wraps.
3. **An explicit, documented control-priority order.** When controls must give up space, WHICH goes
   first is a product decision, not an accident — and the maintainer has one (here: Summary/Ask fold
   first; the flat Sort degrades 4→2→1 but its full options stay reachable in "…"; Search is the flex
   filler that yields last; count + "N new" never fold). If the implementation folds them in a
   different order, or drops a control the maintainer considers important (Sort/"Replies") before a
   less-important one, flag it. Read the current-state appendix / `AGENTS.md` for the intended order.

And the process note this class earns: for a NON-TRIVIAL responsive control cluster, the right first
step is a **hosted mockup** (self-contained HTML in `public/mocks/`, drag-to-resize + fixed snapshots)
reviewed by the maintainer BEFORE the React change — the mockup surfaces "looks sparse / folds in a
jarring order / relocates the gap" that no automated guard will, and catches CSS traps early (a
`flex: 1 1 auto` filler wraps on its content width; use `flex: 1 1 0`).
