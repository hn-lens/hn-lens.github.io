# Lens: PERFORMANCE (latency + resource use)

> **What may change in this file.** It states EXPECTED END RESULTS (authority: `review/SPEC.md`) and
> MEASUREMENT VALIDITY — how to observe something without producing a false negative. It must NOT
> accumulate a checklist of past bugs, a named suspicion, or anything that tells you where to look:
> that biases the lens away from first-principles discovery and makes each round's finding count a
> function of this file's growth rather than of the product's state. **Deleting such an entry is
> always allowed and never needs justification.** This file changes only in an INSTRUMENT-ONLY
> interval, never alongside a `src/` change (AGENTS.md rule 7a, enforced by the gate).

Read `_common.md` first. You are the performance lens. Report to the path in the appendix
(e.g. `/tmp/<round>_perf.md`).

## Your job

**MEASURE, don't confirm.** For every interaction below you must produce a real number on a
**fixed, stated network+CPU profile**, compare it to a **budget**, and — where it misses — **attribute
the cost** to a specific cause (`file:line`). A report that concludes "the slowness is architectural
/ N+1 / already mitigated" WITHOUT a measured number against a budget and a breakdown of where the
time went is a FAILED run — that exact hand-wave is why this lens has rubber-stamped for rounds.

Two things this lens must catch that a request-count + time-to-first-content number structurally
CANNOT, so they get their own passes below:

1. **PERCEPTUAL / transition defects** — what the user SEES *during* a transition, not just at its
   endpoints. "You clicked Best and stared at Top's cards for a second" is invisible to a TTFC
   number; you find it by sampling the DOM/screen *mid-transition*.
2. **WHERE the time goes** — a single cold-start number is useless for deciding what to fix. Split
   the waterfall into its phases (candidate-LIST fetch vs per-item N+1 vs rank/paint) and report each,
   so an architectural cost is named and quantified rather than used as an excuse to stop.

## Controlled measurement is mandatory (this is what makes the numbers mean anything)

Live HN egress from this machine is wildly variable — the SAME cold start measured 1.1s and 9.6s on
two consecutive runs. An unthrottled "it felt fine" is worthless. So:

- **Throttle with CDP and STATE the profile.** Run every budget measurement on a **fixed** profile
  and print the constants you used. Use at least these two, plus an unthrottled baseline:

  ```js
  const client = await context.newCDPSession(page);
  // MID mobile (~Fast 4G) — the primary profile all budgets below are judged on:
  await client.send('Network.emulateNetworkConditions',
    { offline: false, latency: 150, downloadThroughput: 1.6*1024*1024/8, uploadThroughput: 750*1024/8 });
  await client.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  // SLOW (~Slow 4G): latency 400, downloadThroughput 400*1024/8, uploadThroughput 400*1024/8, CPU 4x
  ```

- **Cold start means COLD.** Before a cold-start measurement, clear the caches the app fills, then do
  a real document reload (a hash-only navigation is a no-op in this HashRouter app — it will NOT
  re-run anything):

  ```js
  await page.evaluate(async () => {
    sessionStorage.clear();                                  // pinned order / feed depth / read sweep
    if (indexedDB.databases) for (const d of await indexedDB.databases())
      await new Promise(r => { const q = indexedDB.deleteDatabase(d.name); q.onsuccess = q.onerror = q.onblocked = r; });
    if (window.caches) for (const k of await caches.keys()) await caches.delete(k);
  });                                                        // KEEP localStorage → prefs stay, no onboarding modal
  await page.reload({ waitUntil: 'commit' });
  ```

- **Count REAL content, not skeletons.** The loading skeleton reuses the `.story-card` class, so
  `document.querySelectorAll('.story-card').length` counts placeholders and will tell you cards
  "painted" seconds before any data arrived. A real card is one with title text:
  `[...document.querySelectorAll('.story-card')].filter(c => (c.querySelector('.sc-title')?.textContent||'').trim()).length`.
  Instrument milestones with a `MutationObserver` installed via `page.addInitScript` so it is armed
  before the app boots.

## The budgets (measure each on the MID profile; report value vs budget vs where-the-time-went)

| interaction | budget (MID) | how to measure |
| --- | --- | --- |
| Default feed (For You) cold start — **first real card** | ≤ 2.5s | cold-clear + instrumented reload; first `.sc-title`-bearing card |
| For You — **feed settled** (final card count stable) | ≤ 4s | same run; when the real-card count stops growing |
| **Tab switch to an ALREADY-VISITED feed** | ≤ 300ms | visit Best, switch away, switch back; time to its cards |
| **Tab switch to an UNVISITED feed — first real card** | ≤ 2s | fresh visit to a second HN-list feed |
| **Open a discussion** (cold `/item` deep-link) — first comment | ≤ 2.5s | cold-clear, deep-link, time to first `.comment-body`; assert NO item N+1 |
| **Dialog / local control** (Why #N?, viz switch, comment Sort, Tune sliders) | ≤ 100ms | click → visible change; no network |
| **AI summary** — time to first visible progress (spinner/token) | report it | with a mocked cloud key (see appendix) so it's deterministic |

A miss is a finding. But a PASS you did not measure on a stated profile is ALSO a failed lens — fill
every row with a number or an explicit "could not measure because …".

### Attribute the cold-start waterfall (do NOT report one lump number)

For You cold start, break the time into phases and give each a number, via
`PerformanceObserver({type:'resource', buffered:true})` filtered to `firebaseio.com`:

- **candidate-LIST fetch** — `topstories`/`beststories`/`newstories.json` (the ids-only lists that
  `getForYouCandidateIds` merges). Measured at 1.1s–9.6s and it is usually the DOMINANT phase.
- **per-item N+1** — the `/v0/item/<id>.json` fan-out. Note the first-batch vs full-pool split (the
  feed paints a fast first batch, then fills the rest — verify first content really does precede the
  full pool; if it doesn't, the progressive gate is broken).
- **rank + paint** — the gap between data-ready and cards-on-screen.

Name which phase dominates. If it is architectural (e.g. the multi-list merge, the ids-only API's
N+1), say so AND quantify the user cost AND point at the `file:line` — "architectural" is a
description, not a dismissal. The spec's accepted-cost list is the authority on what is *deliberately*
accepted; a cost not listed there is fair game even if it looks structural.

## The PERCEPTUAL / transition pass (its own section in your report)

Endpoints looking right does not mean the transition looked right. For each transition below, sample
the visible first-card title (or a screenshot) every ~75ms across the whole load window and report the
SEQUENCE of what was on screen — then judge whether any frame showed the wrong or stale thing.

- **Tab switch between two HN-list feeds** (e.g. Best → New — both go through the same items query):
  record Best's first-card title, switch to New, and assert that once New is the selected tab **no
  sampled frame still shows Best's content** (a skeleton is fine; the previous feed's cards are not).
  This is the "I clicked Best and was still looking at Top" defect; a stale-placeholder policy that
  keeps the previous query's data across a *different* query is the usual cause — read the feed hook's
  `placeholderData`.
- **Feed Refresh** — does the current list get yanked/reordered under you, or replaced cleanly?
- **AI summary generation** — is there immediate visible progress, or a dead pause then a pop-in? Does
  an empty/blank summary block ever render (it must become a visible error, never a blank)?
- Capture 2–3 screenshots of the worst transition for the report (downscale per `_common.md`).

## Resource use (keep measuring these)

- **Bundle / initial load.** Chunk sizes from `dist/assets` (`ls -la`, `du`). Confirm the heavy ML
  libs (embeddings + WebLLM + wasm) are **lazy** (0 requests on landing) and routes are code-split off
  the feed. Flag anything heavy on the critical path.
- **Per-render cost of a default-on CARD feature.** For anything that renders on EVERY card by default
  (favicons, inline previews), measure **bytes fetched per rendered element**, not just request count
  — a card that pulls a whole nested resource (an entire comment tree) to show one line is a large
  hidden cost that multiplies across a page. Confirm it uses the cheapest sufficient source and is
  lazy + cached.
- **Wasted work.** Re-entering a feed refetching needlessly (staleTime)? A periodic tick or parent
  re-render churning the whole list (are list items memoized)? Redundant/duplicate in-flight fetches?
- **Bounded & cached external calls.** Article/context/summary fetches timeout-bounded, cached, deduped?
  Any unbounded background network (e.g. training that fetches)?
- **Memory.** Heap (`performance.memory`) after load and after churning ~6–8 tab switches — a leak?
  IndexedDB growth — is the event log / caches capped?

## Rules

- Don't count **opt-in / off-by-default** features (reader proxy, related news) as always-on cost; DO
  measure default-on ones (e.g. remote favicons) and note they're toggleable.
- When you propose an optimization, note the **tradeoff it introduces** — a perf win that regresses
  correctness or console-cleanliness can be net-negative. (Real example: hitting the faviconV2
  endpoint directly to skip the s2/favicons 301 saves a redirect but 404s on domains with no favicon →
  console-error spam; the cached redirect was the lesser evil. State the cost; the naive fix is not
  free.)
- **A clean result is only valid if EVERY budget row above was measured on a stated profile and met,
  with the numbers (and transition screenshots) shown.** "No findings" with an empty budget table, or
  with "it's architectural" in place of a number, is a failed run, not a clean one.

## What to report

The **budget table filled in** (interaction | measured value | profile | budget | pass/fail | where
the time went), then the **perceptual-pass sequence** for each transition, then severity-ranked
findings — each with the concrete cost, the profile + script it was measured on, and the cause
(`file:line`). Keep **architectural tradeoffs** (named, quantified, mitigation noted) separate from
**fixable inefficiencies / regressions**. Leave your probe scripts on disk and give their paths.
