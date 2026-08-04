# Lens: DEVICE MATRIX (one page, every device, side by side)

> **What may change in this file.** It states EXPECTED END RESULTS (authority: `review/SPEC.md`) and
> MEASUREMENT VALIDITY — how to observe something without producing a false negative. It must NOT
> accumulate a checklist of past bugs, a named suspicion, or anything that tells you where to look:
> that biases the lens away from first-principles discovery and makes each round's finding count a
> function of this file's growth rather than of the product's state. **Deleting such an entry is
> always allowed and never needs justification.** This file changes only in an INSTRUMENT-ONLY
> interval, never alongside a `src/` change (AGENTS.md rule 7a, enforced by the gate).

Read `_common.md` first. Report to the path in the appendix (e.g. `/tmp/<round>_devicematrix.md`).

## Your job

You are handed the SAME page rendered at EVERY device size, and nothing else. You answer one open
question: **what is wrong with these pictures?**

This lens exists because it is structurally different from every other one, and that difference is
what makes it find things the others cannot:

- **You are blind on purpose.** You get images and a statement of what the page is FOR. You do not
  get the source, the diff, what changed recently, or anyone's hypothesis. You cannot confirm what
  you were told to confirm, because you were told nothing.
- **You see one page across all widths at once.** A per-width sweep asks "is this width broken?".
  Seeing eight together asks a better question: "which of these is the odd one out, and why?" Most
  responsive defects are only visible as a DIFFERENCE between sizes — a control that exists at one
  width and silently vanishes at another, a block that is proportionate at one size and a stamp at
  another, a gap that grows as the screen shrinks.
- **You judge the picture, not the DOM.** A page can pass every mechanical check — no overflow,
  contrast fine, nothing clipped by a measurement — and still look wrong. That residue is your
  entire subject.

## Method

1. Read every image you are given, in the order given, and look at the WHOLE frame each time: all
   four edges and corners, the header, the gaps between blocks, and the bottom of the frame. Defects
   cluster at edges, and the bottom of the frame is where "the content just stops" hides.
2. Then compare ACROSS sizes deliberately. For each element that matters, ask: is it present at
   every size? Does it keep its identity, or does it turn into something else? Does it grow with the
   frame, or stay a phone-sized object on a desktop? Does the space around it stay proportionate?
3. For anything you suspect, state the measurement you would need to be sure, and take it off the
   pixels if you can. Report the number.

## What counts as a defect here

Judge against the page's stated purpose. The recurring shapes worth naming, as CLASSES:

- **Something present at one size and absent at another**, with no announcement. If a control
  disappears as the screen narrows, the question is whether the reader can still reach the function
  at all, and whether anything tells them where it went.
- **Fixed-size content in a variable-size frame.** A block that is identical at 768 and at 1920 is a
  phone layout being shown on a desktop; judge how much of the frame it leaves doing nothing.
- **Text that is cut rather than shortened.** A hard clip mid-word reads as a typo or a bug; a
  deliberate truncation reads as intentional. Note which one you are looking at.
- **Space that is not doing work** — a dead gap inside a control row, a stranded element far from
  what it relates to, an empty band that appears at one width only.
- **Controls that do not look like controls**, or that look identical to inert text or to each
  other, or whose selected state is not visible.
- **Things sized for a mouse on a device driven by a thumb**, and things placed so close together
  that the wrong one gets hit.
- **Sibling elements styled inconsistently** — two controls doing the same kind of job that do not
  look related, or one row that does not follow the rhythm of the rows around it.
- **Hierarchy that contradicts importance** — the least useful thing on the page being the boldest.

## Measurement validity

- **Never read an image whose longest edge exceeds the limit stated in the appendix.** Read only the
  scaled copies you are pointed at. An oversized image is not merely skipped — on some clients it
  fails the whole message, losing the work.
- **A screenshot is evidence of rendering, not of behaviour.** You cannot see what a control does,
  whether a menu opens, or whether a value persists. Do not claim behaviour you did not observe;
  where an image makes you suspect a behavioural defect, say so as a QUESTION for another lens.
- **Distinguish "clipped" from "ellipsised" from "wrapped"** before reporting; they have different
  causes and different fixes.
- **Check that what you are looking at is real content.** A page that failed to load, or that is
  showing an empty state, is not a layout defect — say which state each image is in.
- **State the size(s) each finding applies to, and the size(s) where it does NOT.** A defect claimed
  at every width, when it only occurs at two, sends the fix in the wrong direction.

## Deliverable

Findings worst-first, each with: severity (BLOCKER / HIGH / MEDIUM / LOW), the affected device
size(s), the element, precisely what is wrong and where in the frame, and the measurement if you
took one. Say plainly when something is done well — a clean result is a real result. Do not
manufacture findings to appear thorough; this lens is graded on whether its findings survive
verification, not on how many it files.
