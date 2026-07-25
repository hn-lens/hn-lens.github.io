# Lens: PERFORMANCE (latency + resource use)

Read `_common.md` first. You are the performance lens. Report to the path in the appendix
(e.g. `/tmp/<round>_perf.md`).

## Your job

Measure **latency** and **resource use** with real numbers, and — critically — **distinguish a
fundamental/architectural tradeoff from a fixable inefficiency.** A finding that just restates a
known, deliberately-accepted cost is low value; a finding that identifies avoidable waste (or a
regression) is high value. Report measured numbers, not impressions.

## What to measure (with method)

Use Playwright: count requests with `page.route` or `page.on('request')`; time with the
`performance` API / `page.evaluate`; read JS heap via `performance.memory`; read bundle sizes from
the built `dist/assets` (`ls -la`, `du`).

- **Bundle / initial load.** Chunk sizes; confirm the heavy ML libs (embeddings + WebLLM + wasm) are
  **lazy** (0 requests on landing) and routes are code-split off the feed. Flag anything heavy on the
  critical path that needn't be.
- **Cold start of the default landing feed.** Requests before the first content paints, and
  time-to-first-content. If the data layer forces an N+1, report the count + TTFC and say whether
  it's architectural (and already mitigated) or improvable.
- **Interaction latency**: feed tab switch, opening a discussion (cold deep-link should be minimal,
  no N+1), viz switches, search, opening dialogs.
- **Wasted work**: does re-entering a feed refetch needlessly (staleTime)? Does a periodic tick or a
  parent re-render churn the whole list (are list items memoized)? Redundant/duplicate in-flight
  fetches?
- **Bounded & cached external calls**: are article/context/summary fetches timeout-bounded, cached,
  and deduped? Any **unbounded background network** (e.g. training that fetches)?
- **Per-render data overhead of a default-on CARD feature.** For any feature that renders on EVERY
  feed card by default (favicons, inline comment/summary previews, …), measure **bytes fetched per
  rendered element**, not just request count — a card that downloads a whole nested resource (an
  entire comment tree, hundreds of KB) to show ONE line is a large hidden cost that multiplies across
  a feed page (tens of cards). Confirm it (a) uses the **cheapest sufficient data source** — a bounded
  item/field fetch, not the richest available (the full Algolia tree) — and (b) is lazy (fetches only
  as the card nears the viewport) and cached. The tell: open a feed page and watch the transfer size;
  a big number for a feature that shows a snippet is the smell.
- **Memory**: heap after load and after churning ~6–8 tab switches — is there a leak? IndexedDB
  growth — is the event log / caches capped?

## Rules

- Don't count **opt-in / off-by-default** features (reader proxy, related news) as always-on cost;
  do measure default-on ones (e.g. remote favicons) and note they're toggleable.
- Prefer live HN for realistic cold-start numbers; mock only when you need determinism, and keep the
  shape realistic.
- When you propose an optimization, note any **tradeoff it introduces** — a perf win that regresses
  correctness or console-cleanliness can be net-negative, so flag the cost AND the risk of the
  obvious fix. (Real example: hitting the faviconV2 endpoint directly to skip the s2/favicons 301
  saves a redirect, but faviconV2 404s on domains with no favicon → console-error spam; the cached
  redirect was the lesser evil. State the cost; don't assume the naive fix is free.)

## What to report

A table (**metric | value | severity**) plus severity-ranked findings, each with the concrete cost,
how you measured it, and the cause (`file:line`). Separate **architectural tradeoffs** (name them,
note the mitigation, don't re-litigate) from **fixable inefficiencies / regressions**. A clean
result — only the known architectural costs — is valid and expected; say so.
