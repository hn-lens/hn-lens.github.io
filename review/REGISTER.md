# Defect register

The enumerated, persistent list of known defects. **Convergence is defined over this file**, not over
"whatever the lenses say next time" (AGENTS.md rule 7, TERMINATION).

Why it exists: every round used to produce a fresh list, so nothing was ever closed as a *set* and the
same items were re-litigated round after round. A finding that appears only because a detector got
sharper is logged here once as `pre-existing`, triaged once, and not re-argued.

**Status values:** `open` · `fixed` (with the guard that now protects it) · `accepted` (with a written
rationale — an accepted MEDIUM does not block convergence).

**A round converges when**, measured against an unchanged instrument: zero `open` BLOCKER/HIGH, zero
self-inflicted findings, and every MEDIUM either `fixed` or `accepted`.

| id | sev | status | class | summary | guard / rationale |
|----|-----|--------|-------|---------|-------------------|
| R-01 | HIGH | open | CODE-WRONG | Every dependency-bump PR fails the gate on `third-party notices up to date` (the notices carry a Version column a bot cannot regenerate). Now that publishing waits on the gate, a merged bump silently stops deploys instead of showing a red X. | needs: notices regenerated automatically, or the check made bump-tolerant |
| R-02 | MEDIUM | open | CODE-WRONG | The "Not interested" fix corrected the habit COUNT but not the affinity SUM: a rejected story can still leave +2.0–2.5 of positive domain affinity, and a different story from that domain returns to rank 1. | `reasonstest` asserts only the count and the chip |
| R-03 | MEDIUM | open | SPEC-GAP | Regime-dependent discovery failure: with a taste concentrated on few domains, saturated affinity features out-vote the content feature and no slider setting moves a position. Affinity is double-counted (own blend term + three learned features). | — |
| R-04 | MEDIUM | open | CODE-WRONG | `hover:opacity-90` composites both fill and label toward the page background, dropping primary-button labels below AA in 28 of 62 design×mode cells (worst 3.89). 9 call sites; 0/62 fail at rest. | `themecontrasttest` has no hover pass |
| R-05 | MEDIUM | open | SPEC-GAP | Searching a discussion silently discards every subtree the reader had expanded (66 visible → 43) on all three clear paths; the filter unmounts the thread and expansion lives in per-comment local state. | — |
| R-06 | MEDIUM | open | DOCS | `README.md`, `SECURITY.md` and the build skill still describe the pre-gate push→publish flow; `ci.yml` appears in no shipped doc. | — |
| R-07 | LOW | open | CODE-WRONG | Markdown headings are silently flattened by `mdLite` — the sibling of the bullet-marker fix; SPEC §5.2 names headings. | — |
| R-08 | LOW | open | CODE-WRONG | An absent item on `/item/:id` renders as an outage that retries forever, because the route cannot distinguish "failed" from "does not exist" the way `getItems` now can. | — |
| R-09 | LOW | open | CODE-WRONG | The results `Clear` control also closes an unrelated open tool. | — |
| R-10 | LOW | open | COMMENT-WRONG | Five stale breakpoint numbers in the discussion-toolbar comments (`@xl/@lg/@md/@sm/@xs` vs the actual `@lg/@md/@sm/@xs/@3xs`). | — |
| R-11 | MEDIUM | accepted | SPEC-GAP | `releasegatecheck.mjs` asserts that specific known-dangerous regressions are absent; it does not evaluate the `if:` expression, so a semantic rewrite that keeps the substrings could pass. | Accepted: it is documented as a known-regression check, not a proof. A semantic check needs a YAML+expression evaluator, which is a larger piece of work than the risk justifies today. |
| R-12 | LOW | accepted | SPEC-GAP | Discussion toolbar leaves an empty centre below ~400px once Search folds. | Accepted in `review/SPEC.md` §11 with scope: an empty centre ABOVE ~400px, a second row, or a control folding out of priority order remains a finding. |
| R-13 | LOW | open | SPEC-GAP | The performance lens was not run in the last confirming round — a coverage gap, not a finding. | run it next round |
