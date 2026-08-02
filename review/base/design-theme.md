# Lens: DESIGN & THEME (visual quality + contrast, full matrix)

> **What may change in this file.** It states EXPECTED END RESULTS (authority: `review/SPEC.md`) and
> MEASUREMENT VALIDITY — how to observe something without producing a false negative. It must NOT
> accumulate a checklist of past bugs, a named suspicion, or anything that tells you where to look:
> that biases the lens away from first-principles discovery and makes each round's finding count a
> function of this file's growth rather than of the product's state. **Deleting such an entry is
> always allowed and never needs justification.** This file changes only in an INSTRUMENT-ONLY
> interval, never alongside a `src/` change (AGENTS.md rule 7a, enforced by the gate).

Read `_common.md` first. You are the design & theme lens. Report to the path in the appendix
(e.g. `/tmp/<round>_design.md`).

## Your job

A **visual design & readability audit across the FULL theme × mode × layout matrix** — EVERY design
(`window.__hnlens.themes().THEME_IDS`) in BOTH light and dark, and every layout (`LAYOUT_IDS`).
Enumerate the ids at runtime so new designs/layouts are covered automatically; never hardcode the
list. You judge both measurable contrast and subjective visual quality.

## 1. Contrast — TWO independent axes (passing one does NOT imply the other)

Compute ratios **programmatically** (`getComputedStyle` + a WCAG contrast function you write; note
that `color-mix()`/`color()` tokens resolve to the `color(srgb …)` form — parse it, and THROW on
any color you can't parse so you never silently NaN-pass).

- **(a) TEXT contrast (WCAG AA: 4.5 normal, 3.0 large).** Every text element, on **every surface it
  can actually sit on** (page bg, card surface, and any raised/nested surface): body/muted/subtle
  text, headings, accent links, button LABELS, chips, badges, chart & treemap & SVG (network /
  mind-map) text, dialog text, sidebar. A token that's AA on one surface but used as text on another
  where it fails is a finding.
  - **Informative vs. decorative text — `subtle` is a DECORATIVE token (folded in from findings).**
    `--muted` is contrast-normalized to AA on surface/bg/surface-2; `--subtle` is intentionally
    fainter (often sub-AA on raised surfaces) and is only acceptable for DECORATION (separator glyphs,
    arrows). Flag any INFORMATIVE text — a caption a user must actually read, e.g. a summary's
    provenance line ("Based on article text …"), a stat, a status — that is drawn in `subtle` (or any
    faint token) on `surface-2`: it should use `muted`. Distinguish the two by role, and recommend the
    `subtle → muted` swap for informative text rather than darkening `subtle` globally.
- **(b) NON-TEXT / UI-COMPONENT contrast (WCAG 1.4.11, ≥3:1).** For EVERY interactive control
  (buttons, segmented toggles, switches, inputs, dropdowns, pills, the comment sort control) check
  the control's FILL and/or BORDER against the ADJACENT surface — is it visible AS a control, not
  melting into the page? For grouped/segmented controls, can you tell there are N SEPARATE segments
  AND which one is SELECTED? A control whose label is readable but whose body is invisible, or a
  two-segment toggle that looks like one blob, is a FAILURE — and this fails even in the default
  theme, so a text-only audit misses it.

The repo has an **automated contrast guard** (named in the appendix) that already enforces the
primary text pairs + a control-edge token across the whole matrix. Do NOT just re-run it — spend
your budget on what it does NOT compute: **any hardcoded (non-token) colour such as a chart or
progress-bar fill, badges/pills, hover/focus/disabled/SELECTED states, dialog surfaces, per-design
surface TREATMENTS that override a token, and any text-on-raised-surface pair the guard omits.**

**Recurring blind spot (folded in from findings — multiple rounds each found one more instance):**
the guard only sees SEMANTIC TOKENS (`--fg/--muted/--accent/--edge/…`). It does NOT see (a)
**hardcoded/literal Tailwind palette colors** — `text-amber-600`, `text-red-600`, `text-green-500`,
etc. used in warning boxes, delete buttons, error/status text, and the rank-explain bars — nor (b)
**accent-on-accent-tint badges** (`text-accent` on `bg-accent/10|15|20`). Both are a chronic AA gap.
Concretely: grep the components for `text-(amber|red|orange|yellow|green|blue)-\d` and for
`bg-accent/\d`, resolve each against its actual background across light+dark, and flag every
sub-AA one (the passing convention here is the `-800`/`-700` shade in light, `-200`/`-300` in dark).
If you find a real gap the guard misses, that's a high-value finding (it means the guard should be
extended — say which pair to add). **Note on `bg-accent/N`: the tint must be COMPOSITED over the
element's actual surface before measuring** — `text-accent` on `bg-accent/10` is a *distinct, lower*
pair than accent-on-surface (which the guard already guarantees), so measuring accent vs pure surface
passes and hides it. This pair recurs in BATCHES across rounds (one round flagged the reply-collapse
pill, the "N new" jump button, the story-card "why" chips, AND the sidebar interest chips at once),
so the durable fix is to teach the guard to compute `accent` vs `color-mix(accent 10–20%, surface)`
across the matrix — recommend that pair explicitly rather than re-finding the swarm by hand each round.

**A THIRD guard blind spot — a control that draws the DECORATIVE `border-border` token instead of the
control-grade `border-edge` (folded in from findings, a MEDIUM):** the guard verifies the `--edge`
TOKEN exists at ≥3:1, but NOT that interactive controls actually USE it. A form field (text input,
`<select>`, textarea) or a bordered secondary button drawn with `border-border` (the ~1.1–1.6:1
decorative hairline meant for card/section OUTLINES) fails WCAG 1.4.11 (≥3:1) AS a control while the
token-existence guard stays green — a fillless text field is delineated ONLY by that border. This bit
58/62 combos in one round (the shared `Select` + `TagEditor` input primitives + the HN-username input +
several secondary buttons). Hunt it: grep components for `border border-border`, and for EACH decide
is-this-an-interactive-control (input/select/textarea/[role=switch]/bordered button → needs
`border-edge`) vs a card/section/dialog/divider CONTAINER (correctly keeps the subtle `border-border`);
measure the RENDERED control's border vs its surface. The durable guard (now recommended/added): a
rendered-control-border test that walks every `input/select/textarea`/bordered control and asserts its
border ≥3:1 vs surface — the ONLY thing that catches "the control drew the wrong token." **A FOURTH
facet of the same blind spot — a TINTED palette border on a control (folded in from findings):** a
bordered control can also draw a *semi-transparent palette* border (`border-accent/40`,
`border-red-500/40`) instead of `border-border` — visible in the default theme but often <3:1 once
composited over its surface. Two gaps compound: the rendered-control-border guard, if it walks only
`input/select/textarea`, never sees BUTTONS at all; and a tinted border must be COMPOSITED over the
surface before measuring (exactly like `bg-accent/N` text). **This is now GUARDED** — `switchtest`
walks bordered `<button>`s/`[role=button]` too and composites each `/N`-alpha border over its surface
before the ≥3:1 assertion, and the 5 flagged controls were moved to `border-edge`. So don't re-hunt
the five known buttons; instead confirm any NEW bordered control uses `border-edge` (not
`border-<palette>/N`), and grep `border-(accent|[a-z]+-\d+)/\d` on interactive controls for any the
guard's page coverage doesn't reach (e.g. a bordered button that only appears on `/item` or a profile).

**Triage accent-on-tint by role (so severity is proportionate):** `text-accent` on a `bg-accent/N`
tint is lower-contrast than accent-on-surface and often dips below AA in light themes. A **primary /
larger text** use (a nav label, an active-tab label ≥14px, body text) failing AA is a real MEDIUM —
fix it (move the accent to the border/tint, which is non-text and only needs 3:1, and use `--fg` for
the label). A **tiny (≤12px) decorative micro-badge** whose signal is redundant (an "OP"/"new" flag
next to the author/count, an interest chip next to the follow list) is a borderline decorative motif —
report it WITH the measured ratio, but treat it as LOW and check the per-round appendix: if it's
already listed as an ACCEPTED product decision, don't re-flag it (measured-and-accepted ≠ a new
finding). Escalate only if it got WORSE or a NEW instance appeared.

## 2. Visual quality (beyond raw ratios)

Judge the craft: visual hierarchy, spacing/rhythm, alignment, whether each design's "language"
(glass / neumorphic / flat / serif / mono / dotted-grid etc.) actually reads and looks intentional,
whether the accent feels deliberate, and whether the data-viz (bars, treemap, word cloud, network,
mind map) is legible AND attractive in both modes. Call out designs that look broken, muddy, or
low-effort.

## 1c. BRAND ASSETS AT THEIR RENDERED SIZE, on the surface they actually land on

Everything above tests the running DOM. The project also ships GRAPHICS THAT RENDER OUTSIDE IT —
`public/icon.svg`, `favicon-32.png`, `apple-touch-icon.png`, `icon-192/512.png`, `og.png`, and
the `<Logo>` mark they derive from. No amount of in-app sweeping can see them, because the browser
draws the tab icon, the OS draws the home-screen icon, and a third-party site draws the OG card.

Grade each shipped asset AT THE SIZE IT IS ACTUALLY DRAWN, not at the size it was authored:

- **16px and 32px** (browser tab, bookmark bar). Rasterize and LOOK at it, upscaled with nearest-
  neighbour so you judge the real pixels. Ask the only question that matters: is the mark still
  identifiable, or has it collapsed into a blob? Measure the contrast of its foreground detail
  against its own background, and count how many of its distinct elements survive.
- **On BOTH browser chromes.** A tab strip is near-white in a light OS theme and near-black in a
  dark one. An asset whose own background is dark disappears into dark chrome; one that is
  transparent inherits whatever is behind it. Composite the asset over both and grade both.
- **180 / 192 / 512px** (iOS home screen, Android, PWA install) — these are masked and shown on an
  arbitrary wallpaper; a transparent or near-background-coloured fill is a defect there.
- **og.png at a social card's real display width** (~500px wide in a timeline).

Compare each against the IN-APP rendering of the same mark. A mark that reads well inline at 28px
on the page background but not at 16px in the tab is a defect, and the inline version is the proof
that the shape is fine and the SIZE/BACKGROUND treatment is not: detail that needs ~28px does not
survive 16px, and a mark drawn for a light page does not survive dark chrome.

Report per asset: rendered size, the surface composited against, the measured contrast, how many
elements remain distinguishable, and a screenshot.

## Method

Enumerate designs/layouts at runtime; for each design×mode compute the key foreground/background
pairs AND the control-fill/border-vs-surface pairs, collecting every sub-threshold datapoint.
**Screenshot the control clusters and LOOK at them** in a few representative themes — a low-contrast
light theme, an OLED dark theme, and the default — to confirm controls are findable, states
distinguishable, and **rendered correctly** (a switch looks like a switch; a segmented control shows
its segments + active state). **Enumerate the controls to screenshot from the DOM at runtime**
(`[role=switch]`, `[role=checkbox]`, `[role=slider]`, `input`, `select`, buttons + segmented groups,
pills) — do NOT work from a fixed hand-list, which goes stale and misses newly-added controls (that
gap let a new feed-header switch ship unreviewed). Downscale before reading.

## What to report

Per **(design, mode/layout)**: the element that's hard to READ or hard to SEE/find/tell-apart, with
the **measured ratio** and the responsible token (`index.css` / `themes.ts` `file:line`), plus
subjective visual-quality problems. Severity-rank; distinguish genuine failures from sub-0.5
decorative near-misses. Note which pairs the automated guard should additionally cover.

## Measurement validity — where this lens produces FALSE NEGATIVES

- **The TOKEN is fine; the COMPONENT picked the wrong one.** The automated guard checks token PAIRS,
  so it can only prove that `--subtle` is legible where `--subtle` is *supposed* to be used. It has
  no idea which token a given component actually chose, and this codebase deliberately keeps a faint
  DECORATIVE token (`--subtle`) alongside an AA-normalised informative one (`--muted`). The failure
  mode is a component reaching for the decorative token to render text the user must actually READ.
  Proven: informative text in `--subtle` on raised surfaces measured 3.80 against a 4.5 requirement
  in 17 of 31 designs while the guard reported everything green. So **measure what is PAINTED**, not
  what the palette declares: walk rendered leaf text nodes, composite the real background by walking
  ancestors, and grade each element. Then judge each failure by ROLE — is this text the user reads
  (a stat, a caption, a label, a nav item, a description before a destructive action), or is it a
  separator/glyph/ornament? Recommend moving informative instances to the AA-guaranteed token, and
  **do not** recommend darkening the decorative token globally: that erases a distinction the design
  system is deliberately making.

- **When you measure colors programmatically, prove the MEASUREMENT before trusting the number.**
  Three separate bugs in one measurement pass each produced confident, entirely fictional failures,
  and every one would have sent a reader off fixing something that was not broken:
  1. **Unparseable color silently treated as absent.** Tailwind emits `oklab(… / 0.15)` for an alpha
     tint like `bg-accent/15`; an `rgb()`-only parser cannot read it. If your background walk treats
     "unreadable" as "transparent" it falls through to a white default and fabricates ~1.0 ratios in
     dark themes. Resolve colors through a 1x1 canvas (handles oklab/oklch/color()/named/hex), and
     make an unresolvable color a REPORTED failure, never a skip.
  2. **Alpha compositing done wrong** — accumulate premultiplied and un-premultiply at the end.
     Mixing conventions is exact for opaque backgrounds and nonsense for every tint, so it looks
     correct in most cells.
  3. **Sampling mid-transition.** Controls carry `transition-colors`, so reading computed styles
     immediately after flipping the theme pairs the OLD foreground with the NEW background. Disable
     transitions (`*{transition:none!important}`) for the measurement pass.
  Sanity-check any ratio below ~1.5 by hand before reporting it: near-1.0 almost always means your
  measurement is broken, not that a shipped control is invisible.

- **A token-level audit CANNOT see a theme TREATMENT that overrides the token.** Palette tokens can
  all pass while a per-design surface rule (a neumorphic tile, a glass blur, a flat treatment) targets
  a Tailwind UTILITY that controls also use — e.g. `.bg-surface` is both a card fill and the fill of
  the shared control recipe — and erases their border. Measure RENDERED, COMPOSITED pixels per design,
  not token values, and specifically check the control BOUNDARY (border/fill vs the adjacent surface)
  in every design that ships a treatment. Note an un-layered theme block beats a `@layer utilities`
  rule regardless of specificity, so even `:focus` may not restore it.
- **`opacity-N` (and any ancestor opacity) DESTROYS a token's contrast guarantee.** A token proven
  AA by the automated guard is composited away by an opacity utility on the element or a parent, so
  the guard still passes while the rendered text fails. Flag opacity utilities on anything carrying
  TEXT; prefer a dimmer semantic token (which is itself guarded) over an opacity multiplier.
- When you rely on a colour-parsing helper, make it **throw on anything it cannot parse** — a helper
  that silently yields NaN turns every comparison into a false pass.
