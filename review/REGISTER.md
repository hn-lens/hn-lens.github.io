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
| R-01 | HIGH | fixed | CODE-WRONG | Every dependency-bump PR fails the gate on `third-party notices up to date` (the notices carry a Version column a bot cannot regenerate). Now that publishing waits on the gate, a merged bump silently stops deploys instead of showing a red X. | `gen-notices.mjs` emits only the attribution-relevant facts (package set, license, homepage, upstream NOTICE, model catalog), so a version bump leaves the file identical and `--check` stays byte-exact. `noticesbumptest` asserts both halves: a version-only bump of every package passes; added / removed / relicensed / changed-NOTICE still fail. |
| R-02 | MEDIUM | fixed | CODE-WRONG | The "Not interested" fix corrected the habit COUNT but not the affinity SUM: a rejected story can still leave +2.0–2.5 of positive domain affinity, and a different story from that domain returns to rank 1. | A currently-hidden item's domain/author contribution is REPLACED by one rejection (`SIGNAL_WEIGHT.hide`, stated once), not offset by it; `perItem` moves with it so the leave-one-out agrees. `reasonstest` m6 asserts the SUM and the sibling's ranking feature for read-twice / saved-and-read (5 checks FAILED pre-fix), the opposite case (hide→UNDO restores the never-hidden totals exactly — demonstrated to fail against a build that ignores the unhide resolution), and both event orderings. `feedstabilitytest`'s "a hide WITHOUT undo stays negative" control rules out neutralising instead. |
| R-03 | MEDIUM | open | SPEC-GAP | Regime-dependent discovery failure: with a taste concentrated on few domains, saturated affinity features out-vote the content feature and no slider setting moves a position. Affinity is double-counted (own blend term + three learned features). | — |
| R-04 | MEDIUM | open | CODE-WRONG | `hover:opacity-90` composites both fill and label toward the page background, dropping primary-button labels below AA in 28 of 62 design×mode cells (worst 3.89). 9 call sites; 0/62 fail at rest. | `themecontrasttest` has no hover pass |
| R-05 | MEDIUM | open | SPEC-GAP | Searching a discussion silently discards every subtree the reader had expanded (66 visible → 43) on all three clear paths; the filter unmounts the thread and expansion lives in per-comment local state. | — |
| R-06 | MEDIUM | open | DOCS | `README.md`, `SECURITY.md` and the build skill still describe the pre-gate push→publish flow; `ci.yml` appears in no shipped doc. | — |
| R-07 | LOW | fixed | CODE-WRONG | Markdown headings are silently flattened by `mdLite` — the sibling of the bullet-marker fix; SPEC §5.2 names headings. | `mdLite` did emit `<h3>`–`<h6>`; preflight resets `h1..h6` to `font-size/font-weight: inherit`, so an `<h4>` rendered at 14px/400 above a 14px/400 paragraph with the `#` characters already consumed. Restored in `.md-body` only (never `.hn-html`), sized per level. `aiguardtest` F2 grades the RENDERED size/weight against the paragraph (FAILED pre-fix), asserts the HN-comment container is unchanged, and sweeps every other `mdLite` construct (link, quote, rule, emphasis, bold, code, ordinals) for survival. |
| R-08 | LOW | open | CODE-WRONG | An absent item on `/item/:id` renders as an outage that retries forever, because the route cannot distinguish "failed" from "does not exist" the way `getItems` now can. | — |
| R-09 | LOW | open | CODE-WRONG | The results `Clear` control also closes an unrelated open tool. | — |
| R-10 | LOW | open | COMMENT-WRONG | Five stale breakpoint numbers in the discussion-toolbar comments (`@xl/@lg/@md/@sm/@xs` vs the actual `@lg/@md/@sm/@xs/@3xs`). | — |
| R-11 | MEDIUM | accepted | SPEC-GAP | `releasegatecheck.mjs` asserts that specific known-dangerous regressions are absent; it does not evaluate the `if:` expression, so a semantic rewrite that keeps the substrings could pass. | Accepted: it is documented as a known-regression check, not a proof. A semantic check needs a YAML+expression evaluator, which is a larger piece of work than the risk justifies today. |
| R-12 | LOW | accepted | SPEC-GAP | Discussion toolbar leaves an empty centre below ~400px once Search folds. | Accepted in `review/SPEC.md` §11 with scope: an empty centre ABOVE ~400px, a second row, or a control folding out of priority order remains a finding. |
| R-13 | LOW | open | SPEC-GAP | The performance lens was not run in the last confirming round — a coverage gap, not a finding. | run it next round |
| R-14 | HIGH | fixed | CODE-WRONG | The convergence gate resolved its baseline commit unconditionally, but `actions/checkout` clones shallow so that commit is absent on a runner. The check errored, CI went red, and publishing was skipped silently — R-01's exact class, introduced by the fix interval that added it. Caught on the first push. | Skips under `CI`, and skips (not fails) on an unreachable baseline; all three paths verified |
| R-15 | MEDIUM | accepted | SPEC-GAP | A red CI on main for ANY reason skips the deploy with no in-repo notification. | Accepted by the maintainer: GitHub already emails on workflow failure, so a second channel would add noise, not signal. R-01 and R-14 removed the two causes that were likely to fire routinely. |
| R-16 | LOW | open | CODE-WRONG | An item whose events carried TWO different domains (its URL changed between events) charges the rejection to one of them twice and leaves the other holding credit from a rejected story. `perItem.dw` sums across domains while `rec.domain` is one last-writer-wins key. Narrow trigger; escalated from a read-only skew to a write into global totals by the affinity-floor change. | needs per-domain accrual in `perItem` |
| R-17 | LOW | open | CODE-WRONG | `mdLite` maps `####`/`#####`/`######` all to `<h6>`, so three markdown levels render identically. Models realistically emit at most `###`. | — |
| R-18 | LOW | open | CODE-WRONG | Nested bullets are flattened: `^\s*[-*]\s+` discards indentation so a sub-item becomes a sibling. Text survives, hierarchy does not. | — |
| R-19 | LOW | open | SPEC-GAP | The card TL;DR and persona summary render model output as plain text rather than through `mdLite`, so markdown reaches the reader as literal characters — visible, not deleted, but inconsistent across the four summary surfaces. | — |
