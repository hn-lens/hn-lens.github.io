# Design — a self-ranking, quality-measured reader-proxy layer

Status: **proposal + first implementation** (see `src/lib/hn/proxy.ts`). Independent of the GitHub feed,
but the same layer powers any proxied fetch (article text today; trending/other later).

---

## 1. Problem

The reader proxy (`article.ts`, opt-in `fetchArticleText`) fetches linked-article HTML through a
fixed 3-proxy chain (AllOrigins → cors.eu.org → codetabs), accepts the first response ≥200 chars,
and moves on. Two problems observed:

1. **Fragility** — free proxies rot; on a given day only some answer, and *which* ones is
   **per-user-environment** (network, IP reputation, geo, rate-limit). A fixed order is wrong for
   most users. We cannot pick the order for them — quality must be measured **on the client**.
2. **Bad content accepted** — the only acceptance test is "≥200 chars", so garbled or boilerplate
   bodies get cached and fed to summaries + ranking. We need to **measure content quality**, and to
   tell **proxy faults apart from our own parsing faults**.

### 1a. What the failures actually are (measured on real HN URLs)

A two-stage diagnosis of real top-HN article URLs (fetch raw via a working proxy → inspect bytes →
run our extraction) found:

- **Common case = CLEAN** (6/7 sampled): server-rendered blogs/news; our `htmlToText` extracts them
  fine. The parser is not the main problem.
- **"Jibberish" = CHARSET.** A Shift-JIS page (`aozora.gr.jp`) came back **38% Unicode
  replacement chars** — because `fetch().text()` assumes UTF-8 and the page isn't. This is **our
  bug**, not the proxy's, and it's fixable: honor the charset (Content-Type header + `<meta charset>`)
  by decoding the bytes with the right `TextDecoder`.
- **"Missed essential content" = JS-RENDERED / paywalled SOURCE.** `x.com` (46 chars of `<p>`
  prose in 245 KB), `vercel.com/blog` (275 chars): the body is rendered by JS and simply **isn't in
  the HTML** a CORS proxy returns. **No HTML parser can recover this** — it needs a rendering reader
  service, or the page is skipped. `nytimes` = paywalled teaser only.
- **Blocked** (`bloomberg`, `reuters`): anti-bot wall → the proxy can't get the bytes at all.

Conclusion: the acceptance test must (a) detect charset and transcode, (b) score content quality,
and (c) **attribute** a failure to proxy / our-parser / JS-source so we know what to fix.

---

## 2. Two deliverables

### Deliverable A — an expanded CANDIDATE proxy list (client ranks it)

Reputable, free, zero-setup (no key/signup), CORS-enabled. We ship the *candidates*; each browser
learns which work for it.

| Proxy | Build | Shape | Constraints | Notes |
|---|---|---|---|---|
| AllOrigins (raw) | `api.allorigins.win/raw?url={enc}` | raw | ~20/min; 200s even on target error → must validate | open-source *(current)* |
| AllOrigins (get) | `api.allorigins.win/get?url={enc}` | JSON `{contents,status}` | exposes target status | open-source |
| cors.eu.org | `cors.eu.org/{url}` | raw | — | *(current)* |
| codetabs | `api.codetabs.com/v1/proxy/?quest={url}` | raw | intermittent | *(current)* |
| corsproxy.io | `corsproxy.io/?url={enc}` | raw | **free for `*.github.io`+localhost** (=us); 60/min; Origin-gated | works in-browser |
| corsfix | `proxy.corsfix.com/?{url}` | raw | free local/github.io; 60/min; Origin-gated; SSRF-guarded | — |
| everyorigin | `everyorigin.org/get?url={enc}` | JSON `{contents}` | new open-source AllOrigins clone | — |
| CF worker demo | `test.cors.workers.dev/?{url}` | raw | public demo of `cloudflare-cors-anywhere` | open-source utility |
| cors.lol | `api.cors.lol/?url={enc}` | raw | low free rate limit | lower priority |
| thingproxy | `thingproxy.freeboard.io/fetch/{url}` | raw | **100 KB cap** → small pages only | size-guard it |

Two shapes to handle: **raw** vs **JSON-wrapped** (`.contents`). Excluded (not zero-setup): `cors.sh`
(API key), `cors-anywhere.herokuapp` (manual demo-enable).

**Adjacent classes worth adding later** (bend the "no key" bar, but higher-value):
- **Reader/extraction service** (Jina `r.jina.ai/{url}`) — returns clean *rendered* text → fixes both
  CORS *and* the JS-source + parse-quality problems in one shot. Moved to keyed/rate-limited, so it's
  opt-in-with-key, not zero-setup.
- **Archive** (`web.archive.org/web/2id_/{url}`) — CORS, reputable, a fallback source.
- **Self-hosted Cloudflare Worker** — most reliable + private (we control it, no third party sees
  URLs); one-time deploy for us, zero-setup for users.

### Deliverable B — client-side quality tracking + adaptive ranking

A shared primitive every proxied fetch goes through; learns each proxy's quality **on the user's
machine** and reorders the chain. All persisted per-browser (`localStorage['hn:proxyhealth']`).

**Per-proxy health record:** `{ ok, fail, emaMs, qualityEma, lastOkTs, lastTs, streak, cooldownUntil }`
(decayed counts, EMA latency + content-quality, failure streak, circuit state).

**Ranking (recomputed per fetch):**
`score = 0.55·successRate(Laplace-smoothed) + 0.45·qualityEMA − 0.4·latencyNorm`. (The failure streak
drives the circuit-breaker below, not the score.) A proxy that returns *unusable* content fails
`validate`, so it sinks via the **reliability** term (recorded as a failure); the quality EMA — fed
only by *validated* successes — separates usable-but-thin proxies from clean ones.

- **Circuit-breaker:** after K consecutive fails, `cooldownUntil = now + exp-backoff`; skip while
  open; reset on success.
- **Decay + ε-exploration:** decay old ok/fail (half-life ~days) so last week's outage isn't
  permanent; with ~10% prob probe a cooled/low-ranked proxy to detect recovery; a new proxy gets an
  optimistic prior.
- **Per-proxy constraints:** unwrap JSON-shape proxies. A `sizeHint`/`maxBytes` hook exists to skip
  size-capped proxies for large targets, but no caller passes a hint yet, so `thingproxy`'s 100 KB cap
  is currently best-effort (see Known limitations).

**Two-stage content-quality scorer** (this *is* the fetch's `validate()`), returning a 0..1 quality +
an attribution:

- **Stage 1 — raw bytes (blames the PROXY):** decode with the correct charset first; then measure
  replacement-char/mojibake ratio, known blocker-page markers (`"Just a moment"`, `"Attention
  Required"`, `captcha`, `"Access Denied"`), byte length, completeness.
- **Stage 2 — extraction (blames OUR PARSER or the SOURCE):** extracted length ≥ floor, stopword
  density in a human range (real prose ≈ 35–50%; a nav dump ≈ low), title↔body term overlap
  (`articleLooksRelevant`), and **prose-present-in-raw-HTML** (total `<p>` text) to separate the two
  sub-cases.

**Attribution → what to fix:**
- Stage 1 fail (bad bytes) → **proxy**; deprioritize, try next.
- Stage 1 ok, Stage 2 fail, **raw HTML had prose** → **our parser** (fixable). Tracked as a global
  parse-failure counter across proxies (independent of any one proxy).
- Stage 1 ok, Stage 2 fail, **raw HTML had no prose** → **JS-rendered source** (needs a reader
  service; unrecoverable by HTML parsing).
- Encoding-mojibake → **charset** (our transcode should have handled it; if a proxy strips the
  charset header/meta, note it against that proxy).

**Feed quality back:** only a *validated* body is cached + fed to summaries/ranking (a jibberish or
JS-source body is never cached), and its quality updates the proxy's EMA. The termAffinity ranking
therefore only ever sees good bodies.

**Diagnostics:** `Settings → Data → Fetch diagnostics` shows per-proxy `tries · ok% · avg ms · avg
quality`, plus the global `parse-stage failures (raw had content): N` — so a user (or we) can *see*
whether jibberish is the proxy or us. A "reset proxy health" button clears the store.

---

## 3. Implementation

- **`src/lib/hn/proxy.ts`** (new): `PROXIES` (the expanded list, with `kind: 'raw'|'json'`,
  `maxBytes?`), the health store (`load/save/recordOutcome/rankProxies/snapshot/reset`), the
  charset-aware decode, `scoreContent(raw, extracted, {title})` → `{quality, attribution, stage1,
  stage2}`, and `proxiedFetch(url, {validate, sizeHint?, timeoutMs?})` → `{ok, text, proxy, quality,
  attribution}`. Keeps the existing 8 s per-attempt `AbortController` bound.
- **`src/lib/hn/article.ts`**: `fetchArticleBody` calls `proxiedFetch` with a `validate` built from
  `scoreContent` + `articleLooksRelevant`; caches `{text, proxy, quality}`; re-exports `READER_PROXIES`
  (as `PROXIES`) for the Settings list. **Charset fix lands here** (arrayBuffer + detected TextDecoder).
- **Ranking:** unchanged surface — it already consumes cached bodies; the win is that only
  quality-passing bodies are cached now.
- **`scripts/proxytest.mjs`** (new, standard tier): hermetic — mock several proxies with scripted
  latency/failure/invalid-200/mojibake/JS-source bodies; assert the ranker prefers fast+reliable+
  high-quality, fails over, opens+recovers a circuit, persists order across reload, skips a
  size-capped proxy for a big target, and that the scorer attributes each failure class correctly
  (proxy-encoding / proxy-blocked / js-source / parser / clean). Privacy rule: zero proxy requests
  when `fetchArticleText` is off.

## 4. Phasing

- **Phase 1 (this cut):** `proxy.ts` (expanded list + health-ranked chain + circuit/decay/ε +
  charset decode + two-stage scorer + quality-gated caching) + `article.ts` refactor + `proxytest`.
- **Phase 2:** Settings "Fetch diagnostics" panel + reset button.
- **Phase 3:** reader-service (Jina, keyed) + archive fallback + optional self-hosted worker for the
  JS-source/blocked cases the current route can't recover.

## 4a. Known limitations (accepted backlog from an independent review)

The self-tuning ranker (Laplace reliability + quality EMA + latency, circuit-breaker with a recovery
probe when every circuit is open, decay clamped so a future timestamp can't inflate counts), the
charset decoder, the language-aware content scorer, and the privacy posture were independently
reviewed and verified sound. These lower-severity items are accepted as backlog rather than fixed in
this cut:

- **Blocker detection is precision-over-recall (deliberate; a perfect HTML-only classifier is
  impossible — a crafted page can mimic an article).** A page is `proxy-error` only when an unambiguous
  challenge fingerprint (CF/Incapsula boilerplate + hCaptcha/reCAPTCHA/PerimeterX/Datadome/Cloudflare
  markers) co-occurs with **no usable article text** (`textLen < minText`). The `textLen` gate is the
  hard guarantee: a real article (usable text) can NEVER be classified `proxy-error`, even when it
  DISCUSSES bot-walls (the perennial HN anti-bot / 403 / accessibility / vendor-teardown genre) — so a
  legit page can never poison every proxy's health (the worst failure). The cost: a *contentful* blocker
  (full boilerplate, no fingerprint-with-empty-body) is served as low-quality `thin`. That residual is
  contained: the reader sees it's boilerplate, summaries refuse it via `articleLooksRelevant`, and the
  RANKING term-affinity path drops it too — `cachedArticleTerms` is gated on `looksLikeBlocker(text)`
  (blocker fingerprints in the cached body), NOT on title↔body relevance. Gating ranking on relevance
  was rejected: it would false-drop a legit *vague-title* article (neutral title, on-topic body), which
  the train/serve-parity test protects. Mirrors the deleted output-sanitiser: guarantee only what is
  keepable and testable.
- **Reader-overlay vs summary relevance.** The reader overlay shows a body scored `thin` (overlap ≥ 0.15)
  that the AI-summary path would refuse (`articleLooksRelevant`, overlap ≥ 0.25); the two surfaces can
  disagree on the same body. Unifying the reader threshold is a behaviour decision deferred to its own
  interval. `titleOverlap`'s tokenizer is ASCII-only, so a Latin article whose title diverges from its
  body can still be graded `thin` (the body is still delivered); non-Latin bodies are not demoted (the
  overlap clause is gated on Latin text).
- **ε-recovery is passive.** A cooled proxy re-admitted by the ε-probe is sorted at its (low) score, so
  it is only actually contacted when the chain above it fails; recovery is detected, not actively
  probed. Mitigated by the all-circuits-open fallback and by clearing the streak once evidence decays.
- **`parser` vs `js-source` attribution is advisory, not exact.** `proseInRaw` counts all `<p>` text
  (including nav/footer chrome) and ignores prose in `<div>`/`<article>`, so the "whose fault" label
  can be wrong on chrome-heavy or non-`<p>` pages. It is diagnostic only — it does not affect
  accept/reject or ranking — so it is not a correctness blocker.
- **EMA terms don't decay.** `emaMs`/`qualityEma` keep their last value while `ok`/`fail` decay toward
  neutral; a long-idle proxy can carry a stale latency/quality belief until it is next tried.
- **`<meta charset>` peek is the first 2 KB, and a bogus header label wins over it.** A charset declared
  after a large pre-`<head>` banner is missed; and if the Content-Type header carries an unusable charset
  label, decoding falls straight to UTF-8 rather than retrying the `<meta>` label. Both are rare (a server
  emitting a garbage header label while a correct meta exists).
- **`rankProxies` size-filter has no empty fallback.** If a `sizeHint` filtered out every candidate the
  chain would be empty; latent only — the shipped list has one `maxBytes` and no caller passes a hint.
- **`thingproxy` truncation.** Its 100 KB cap is best-effort until a caller passes a `sizeHint`; a
  >100 KB article routed to it (only if every other proxy fails) may be truncated but is usually still
  usable.

## 5. Open questions

1. Include the Origin-gated proxies (corsproxy.io/corsfix) in the default list even though a script
   can't verify them? (Yes — we deploy to github.io, their free origin; the client will confirm.)
2. Charset detection depth — header + `<meta charset>` covers the aozora case; do we also want a
   byte-order/statistical sniff for pages that lie? (Start with header+meta.)
3. Trust: every proxy sees the fetched URL + content. Keep the whole thing under the existing opt-in
   disclosure; prefer open-source/first-party (worker) operators when we expand.
</content>
