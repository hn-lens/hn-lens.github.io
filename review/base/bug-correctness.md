# Lens: BUG / CORRECTNESS

Read `_common.md` first. You are the bug/correctness lens. Report to the path in the appendix
(e.g. `/tmp/<round>_bug.md`).

## Your job

Exhaustively **discover every behavioral discrepancy** between what the app does and what it should
do, and **root-cause each to `file:line`**. You are neutral and factual. The appendix gives you the
**expected-behavior spec** (derived from the product's purpose and its documented rules, written as
a uniform list). You verify each item against the running app; you are NEVER told where a bug is or
which items are suspect — treat every item equally and assume nothing.

## Method (this is how bugs actually get found here)

- **Seed known local state** via `window.__hnlens` (events, prefs, saved/hidden, a trained model)
  and assert the **exact** expected output **and the negative** (the thing that should NOT happen).
- **Drive the real user paths**, not just the convenient one: open a discussion from a feed CARD
  (not only via a direct `/item` URL); read-then-bounce; mute-then-search; toggle a privacy setting
  then COUNT the network calls; reload / close-reopen for persistence. Bugs hide on the path a real
  user takes.
- **Test the DISPLAY/surface, not just the underlying function.** A data-derived display can call
  the wrong helper and pass a function-level test while the surface is wrong.
- **Cross features.** The interaction between two individually-correct features is where bugs live
  (import × read-state; read × dwell; hidden × read-history; empty × outage; a filter × each feed
  AND search).
- **Two paths that answer the same user question must AGREE (folded in from findings).** When two
  pieces of code independently derive the same concept — e.g. `getReadItemIds` (the Read tab) vs.
  `buildTrainingSamples` (the ranker) both answer "did the user read this"; or a display helper vs.
  the store — seed one known state and assert BOTH give the consistent answer, and that any rule
  (dwell-awareness, MONOTONICITY: "once read, stays read") holds in BOTH. These parallel derivations
  drift apart over time; that drift produced multiple rounds' correctness bugs.
  - **Enumerate EVERY surface that reflects one concept, and check them all — AND check the concept
    has the SAME number of parts everywhere.** A gate/threshold/state shown in several places is a
    recurring trap: when the logic is fixed in one surface, the others get missed. Concrete example
    that keeps recurring here — "is the learned ranker active?" has surfaced in at least SEVEN places
    across separate rounds: scoring, the sidebar copy, the "Why #N?" explainer, the For-You "warming
    up" banner, the ranking-weights "Learned reranker" slider inactive-hint, AND the Settings
    "Learned reranker" STATUS line + its "Retrain now" result message. The true gate is TWO-part —
    `useLearnedRanker` (the toggle) AND `rankerTrained(model)` (enough samples AND enough positives),
    i.e. useFeed's `activeModel = useLearnedRanker ? model : undefined`. A surface can get ONE part
    right and silently miss the other (the slider hint checked `rankerTrained` but ignored the
    toggle). Two under-checked shapes: (1) COUNT / STATUS DISPLAYS are surfaces too — a "Trained on N
    examples" line that shows a raw count without the gate reads as "active" while the reranker is
    dormant (the previous round only verified the feed gate-surfaces agree and missed the two Settings
    displays). (2) The whole gate, not just the threshold. Grep every reader of the concept
    (`model.n`, `model.pos`, `useLearnedRanker`, the gate constants); seed BOTH edge cases (enough
    samples but too few positives; trained but toggled off) and verify ALL surfaces — feed gates AND
    count/status text — agree. Do the same for any other multi-surface / multi-part concept you find.
  - **A REVERSAL event must be honored by EVERY derivation of the event it reverses (folded in from
    findings — a MEDIUM).** An append-only user action (e.g. `hide`) can feed SEVERAL independent
    derivations — an affinity SUM, a training LABEL, a content-profile disliked SET — and its UNDO
    (`unhide`) has to neutralize ALL of them, not just the one you happened to fix. A round fixed only
    the affinity reversal; the label and the disliked-content set still treated the un-hidden story as
    disliked, so it stayed buried and never re-entered training as a positive — a partial fix caught
    the VERY NEXT round (same shape as the multi-surface-gate recurrence, but for an event's parallel
    derivations rather than display surfaces). Hunt it: grep every reader of the original event type
    (`e.type === 'hide'`) and confirm each also handles the reversal (`'unhide'`) symmetrically; seed
    action→undo and assert the item is byte-identical to never-acted in ALL derivations (affinity net
    ~0, back in the label-positive set, absent from the disliked-content set). **A derivation is not
    only STORED data — it includes the LIVE-UPDATE WIRING.** If the reversal event type isn't in the
    engagement/invalidation trigger set (here `ENGAGEMENT_TYPES`, which fires `onEngagement` → query
    invalidation), the recomputed value is correct but the FEED keeps serving the STALE cache, so the
    un-done item stays visibly wrong (e.g. buried by the un-cancelled downvote) until a manual
    Refresh/reload. Drive the reversal WITHOUT a reload and assert it takes effect live — i.e. the
    reversal fires the same live-update path the forward action does, not just that a re-fetched value
    would be right.
  - **A shared helper with ORDER-DEPENDENT internal logic must be order-INDEPENDENT, or every caller's
    input order must be verified (folded in — a real MEDIUM, self-inflicted by a prior fix).** When
    the parallel derivations are unified through ONE shared helper (the good fix), watch for a helper
    whose logic depends on INPUT ORDER (e.g. a reduce that resolves hide-then-unhide by "a later event
    wins", assuming chronological order) being fed DIFFERENT orderings by different callers — here
    `computeAffinities` fed events NEWEST-first while `buildTrainingSamples`/`getEngagedItemIds` fed
    them oldest-first, so the SAME shared classifier returned opposite results and a read→hid→un-hid
    item was mis-classified in ONE derivation only. Seed the identical events in BOTH orders and assert
    the helper returns the same result; the robust fix makes the helper order-independent (decide by
    comparing latest timestamps, not by mutate-during-iteration). Beware: adding a shared helper to a
    caller that slices its events differently can silently REINTRODUCE the very drift the unification
    removed.
  - **A guard placed at the WRONG GRANULARITY leaves the hole open (folded in — a real defect found
    after two rounds had already "unified" this very concept).** Check the granularity a rule is
    enforced at against the granularity it is APPLIED at: here the qualifying test was per-ITEM ("is
    this item engaged?") while the credit it gated was per-EVENT, so once an item qualified ONCE, every
    later event of that type was credited too — and a repeat action that should be neutral or negative
    (re-opening a story you already read, then bouncing straight back) accumulated POSITIVE weight,
    inverting the very signal the rule existed to protect. Hunt it by driving the SAME entity through
    the action REPEATEDLY and asserting the derived value converges rather than accumulating: N repeats
    of a no-value action must not move the number monotonically. Also check the over-correction (a
    genuine repeat that SHOULD count still counts) and that the result is independent of event order.
  - **A CACHE KEY THAT ENCODES A SHAPE INSTEAD OF THE CONTENT serves stale data (folded in — a real
    HIGH).** When a query/memo is keyed on a derived scalar (a COUNT, a length, a page number) rather
    than the data itself, any change that alters CONTENT without altering that scalar is invisible:
    the cache happily returns the previous value. This hides behind an invalidation that looks
    correct — the upstream list DID refresh, the consumer just never re-read it. Hunt it by mutating
    a collection in place (reorder it; append past a slice boundary so the visible slice's LENGTH is
    unchanged) and asserting the RENDERED surface updates. Two amplifiers to check: a "keep previous
    data" placeholder makes the stale value look intentional, and a disabled refetch-on-focus removes
    the accidental rescue, so there may be NO in-place recovery at all. Cross-check any surface that
    has a SECOND derivation of the same concept (a sidebar panel, a count) — they will visibly
    disagree on screen, which is the strongest possible evidence.
  - **TRAIN/SERVE PARITY: a feature must be computed the SAME way when the model is FITTED as when it
    is APPLIED (folded in — a real skew).** Enumerate every feature-construction call site and diff
    their options: if the serving path enriches a feature from a source the training path omits (or
    vice-versa), the model learns a weight against one distribution and applies it to another, silently
    mis-scaling that feature — and any calibrated probability derived from it — with NO visible error.
    This hides especially well behind a default-off toggle (it only skews for users who enabled it).
    Grade it by computing the same item's feature vector through BOTH paths and comparing element-wise;
    they must match except for deliberate, documented differences (e.g. leave-one-out at training).
- **An ENUMERATED list of cases is a defect generator — check every LEVEL of each family.** A
  hand-listed set (block tags to separate, event types to credit, categories to delete, prefixes to
  purge) is only as good as its last edit, and the dangerous shape is a family that is PARTLY
  present: the container is listed but its children are not (`table`/`tr` without `td`/`th`, `dl`
  without `dt`/`dd`), so most inputs look fine and the richer real-world ones fuse or drop. Derive
  the list where possible; where you can't, feed input that exercises each level of every family.
- **Test against REALISTIC data.** When you mock an API, match the REAL response shape — verify with
  a live `fetch` when a behavior depends on the data (e.g. a job post carries a constant `score:1`;
  a story's fields; a comment tree's structure). A fixture that diverges from reality green-lights
  live-only bugs and fabricates fake ones. This is the single most important discipline for this
  lens.
  - **HTML-shape realism specifically.** HN titles/bodies/comments are HTML with MULTIPLE block
    elements (`<p>`, `<pre>`, `<li>`) and inline `<a>` links. A text-extraction helper that flattens
    via `textContent` **drops block boundaries** — `<p>a</p><p>b</p>` → "ab", a trailing `<a>` fuses
    onto the next word — so any fixture with a SINGLE `<p>` and no link passes while real content
    mashes (seen live: `…window98-html-css-jshttps://github.com/…`). This corrupts every consumer of
    the extracted text (feed previews, the thread gist, the LLM input). When a behavior renders
    extracted text, mock a comment/body with ≥2 blocks AND a link, and assert a SPACE survives the
    boundary (read the element's `textContent`, not `body.innerText`, so a CSS line-clamp can't hide
    the tail). Sharper still: the fix is a tag-ENUMERATED separator list
    (`p,div,li,br,a,blockquote,pre,tr,h1..h6`), so it can be INCOMPLETE — a block type NOT in the list
    still mashes even after the `<p>` case is fixed (`<pre>` code blocks fused onto the next paragraph
    one round AFTER `<p>` was fixed). Mock EACH block type the app actually renders — `<pre>`,
    `<blockquote>`, `<li>`, a heading — not just `<p>`+`<a>`, and assert a space survives each boundary;
    a class-complete fixture is the only thing that catches "the separator list is missing tag X."
    **The fixture must also match the real DOCUMENT SHAPE, not just contain the right tags:** real HN
    comments START with a BARE text node (the first paragraph is NOT wrapped in `<p>`), and an
    APPEND-only separator (`n.append(sep)`) separates a block from what FOLLOWS it but NOT what
    PRECEDES it — so the leading-bare-text → first-block boundary (present in EVERY real comment)
    mashed while a fixture that STARTS with `<p>` passed. Mock a comment that starts with bare text
    directly abutting the first block (no trailing space) and assert the space survives; the robust fix
    inserts the separator on BOTH sides (beforebegin+afterend). **And a shared text helper has a
    WHITESPACE CONTRACT** — `stripHtml` COLLAPSES newlines to spaces, `htmlToText` PRESERVES them as
    line breaks — so a consumer that `.split('\n')` the output of the COLLAPSING one gets a silent
    no-op (here a per-line quote filter that then dropped a whole quote-then-respond comment). When you
    touch or audit a shared text organ, check EVERY consumer's whitespace assumption against the helper
    it actually calls. **And when you FIX one consumer of a shared anti-pattern, fix EVERY sibling in
    the SAME change (folded in — a MEDIUM that recurred):** a prior round fixed `ThreadGist.clean`'s
    `stripHtml().split('\n')` quote-drop but left the IDENTICAL bug in `llm.ts`'s `cleanComment`
    (feeding every AI summary/TL;DR/Ask), so the same defect shipped in the sibling. Grep the repo for
    the exact anti-pattern (`stripHtml(...).split('\n')`, or whatever the shared misuse is) and confirm
    ZERO remaining consumers before calling it fixed — a fix that greens the one surface you noticed is
    not a fix of the class.
- **Robustness**: invalid/hostile inputs (bad item id, unknown user, `javascript:`/`data:` URLs),
  outage vs. legitimately-empty (they must look different), missing fields, no white-screen/no-crash
  guarantees, and that destructive actions are undoable where promised.
- **Outage ≠ empty, INCLUDING OFFLINE (fold in from findings).** Every list, search, and profile must
  show a distinct error+Retry on a failed fetch — never "Nothing to show"/"No results"/"User not
  found", and never a result COUNT above the error. Test OFFLINE specifically (`context.setOffline`):
  queries must FAIL fast into the error state, not pause silently (the default `networkMode` pauses
  while `navigator.onLine` is false, so `isError` never fires and the surface falls through to its
  empty branch). Also test a lazy route whose JS CHUNK can't be fetched offline: it must show a
  graceful message and recover on navigation, not a raw "Failed to fetch dynamically imported module"
  that persists across nav.
- **A per-type DELETE / purge must cover EVERY key a feature writes (folded in from findings).** When a
  feature persists several key families (a summary writes `sum:` AND `usersum:`; article text writes
  `atext:` AND the derived `aterms:` memo; comments write `topc:`/`cterms:`), a "Delete X" that removes
  only the primary prefix leaves ORPHANED data that still feeds ranking or shows a stale count — and
  `'usersum:'.startsWith('sum:')` is FALSE, so a prefix filter silently misses siblings. Grep every kv
  prefix a feature writes, and assert the category's delete (and its COUNT) covers all of them; seed
  each derived key, delete the category, and confirm ZERO survivors.
- **PARTIAL-failure resilience (folded in from findings).** A feature that aggregates several
  independent sources with `Promise.all` fails ENTIRELY when ONE source fails — even though the others
  returned usable data. Find these: grep for `Promise.all(` on multi-source fetches (e.g. the For-You
  candidate pool blends top+best+new; context/enrichment fans out) and simulate a PARTIAL outage (mock
  ONE source to 5xx, the rest OK, and clear caches). The feature should degrade gracefully on the
  survivors and only show its error state on a TOTAL outage (all sources down) — `Promise.allSettled`
  is the usual fix. This is distinct from the all-or-nothing outage-vs-empty check above.
- **Deferred-state / duplicate-DOM-id races (folded in from findings — a HIGH).** A UI action that
  toggles a view gated on `useDeferredValue` (or any deferred/low-priority state) does NOT unmount the
  old view synchronously — so a handler that then acts on a `setTimeout`/`requestAnimationFrame`
  (scroll, focus, measure, `getElementById`) can fire BEFORE the deferred view swaps, hitting the STALE
  view. Worse when two views render the SAME DOM id (e.g. flat search results and the thread both use
  `id="comment-N"`): `getElementById` resolves the wrong (about-to-unmount) node, and the action
  silently no-ops. Concrete miss: the in-thread search "In thread" jump cleared the (deferred) query
  then rAF-scrolled — landing on the stale search-result card, leaving the user at the top with the
  target off-screen (0/5). Hunt it: for any "jump/scroll/focus after a search-clear or view-toggle"
  path, drive it REPEATEDLY (timing races are flaky — the bug lands 0/5 or 2/3, so single-shot passes
  hide it) and assert the target is actually IN VIEW afterward (its `getBoundingClientRect().top` within
  the viewport), not merely that the handler ran. The fix pattern is to act in an effect keyed on the
  deferred value (after the swap commits), and to avoid duplicate ids across sibling views.

## The REVERSAL class (proven — three separate finds in one round; sweep for it every time)

A recurring shape in this codebase: **the forward action is handled and its UNDO is forgotten.** The
forward path is what gets designed, demoed and tested; the reversal is an afterthought bolted on
later, so it lands in some derivations and not others. Three independent instances surfaced in a
single round — `unsave` did not reverse `save` in ANY of five derivations (while `unhide`/`hide` had
already been fixed to cancel exactly), and the "signals recorded" label map listed every forward
action but neither reversal.

So do this explicitly, do not wait to stumble on it. **Enumerate every user action that has an undo**
(save/unsave, hide/unhide, follow/unfollow domain, follow/unfollow user, expand/collapse, mute/unmute,
import/re-import) and for EACH one prove the round trip is a true no-op:

- Do X, snapshot **every** derived value (affinity numbers, engaged set, training label, counts,
  content profile, what each SURFACE displays). Undo X. Snapshot again. Compare against
  never-having-done-X — byte-identical, or report the delta.
- Check the undo fires the same live-update wiring the forward action does (is it in the engagement
  set? do the derived queries invalidate?), or the UI keeps showing the pre-undo value until reload.
- Check the two weights CANCEL rather than merely discount: a +2/−1 pair leaves a permanent +1 for an
  action the user explicitly took back.
- Check every hand-maintained map/list/switch that mentions the forward action also mentions the
  reversal (labels, enums, weight tables). Prefer reporting the loose typing that ALLOWED the gap
  (`Record<string, …>` where an exhaustive `Record<Union, …>` would not compile) over the one missing
  entry.

Also check that a reversal does not over-reach: undoing a save must not un-do an unrelated genuine
read of the same story.

## Stability invariants (a correct list can still be a broken one)

Most of this brief asks whether a value is RIGHT. This section asks whether it holds STILL. A derived
list can be recomputed perfectly correctly and still be a defect if it changes underneath someone who
is using it.

For every list and position-bearing surface, establish what is allowed to change it and when, then
test that nothing else does:

- Identify every input feeding the ordering or membership of a list, and every code path that
  invalidates or recomputes those inputs. For each, ask: **can this fire while the user is looking at
  the list?** Background/deferred work and event-driven recomputation are the ones to look for; they
  are invisible to a snapshot test.
- Check the app is CONSISTENT with itself. Where a codebase has deliberately made one thing stable
  within a session (a snapshot taken once, a value deliberately not invalidated), that is a stated
  policy — and a sibling surface that recomputes live contradicts it. Cite both and report the
  contradiction, not just the symptom: a project can reasonably choose either policy, but not both
  in the same view.
- Distinguish *stable* from *frozen*. Refusing to ever update is also a defect (stale data with no
  way to refresh). The property to verify is that updates happen at a boundary the user causes or can
  predict — not that they never happen.

Report these as correctness findings with the invalidating path cited at `file:line`, like any other
bug.

## Coverage expectations

Walk the ENTIRE expected-behavior spec in the appendix, item by item, plus anything you notice from
first principles that the spec didn't think to list. For each behavior, prove BOTH that it happens
when it should and that it doesn't when it shouldn't.

## Reporting

- Severity-ranked (BLOCKER/HIGH/MEDIUM/LOW). Each: **expected vs. actual**, the exact repro (seeded
  state + steps/script), and the **root cause (`file:line`)** — read the source to confirm the cause,
  don't guess.
- **Finding NO correctness bugs after a genuinely exhaustive, realistic, adversarial pass is a
  valid and expected outcome — say so plainly. Do NOT invent issues.** But if the pass felt easy,
  you didn't push hard enough: add hostile inputs, cross more features, and use realistic data.
- Note any place where an existing test passes only because its fixture is unrealistic — that's a
  latent bug waiting to ship.
