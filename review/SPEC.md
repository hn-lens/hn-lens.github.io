# Hacker Lens — product specification

**This file is the AUTHORITY on intended behaviour.** It is owned by the maintainer and is written
from product intent, not derived from the code. Where the code, a comment, a test or a prior review
report disagrees with this file, **this file wins** — and the disagreement is a finding.

It exists because review lenses previously had no way to adjudicate. When a source comment said
"X cannot happen" and X demonstrably happened, a lens had to guess whether the CODE or the COMMENT
was wrong. Guessing "code" produces a false HIGH; that cost a full investigation on ranking
normalisation that turned out to be working as designed. A spec removes the guess.

> Maintainer note: this is a first draft assembled from long-standing product decisions. Anything
> here that is wrong is a **SPEC-WRONG** finding — report it, do not silently work around it.

---

## 1. What the product is

A **static, in-browser, personalised Hacker News reader**. No backend, no accounts, no telemetry.
All state is local (IndexedDB, `localStorage`, `sessionStorage`). It is published publicly and
deploys to GitHub Pages.

The reader is a regular daily HN user. They open it several times a day, skim a feed, read a handful
of stories and discussions, and expect it to get better at guessing what they want over time.

Three things it is deliberately NOT: a social client (it cannot post, vote or reply — HN has no CORS,
so those deep-link out), an AI product (AI is optional and off by default), and a completionist
reader (it does not try to show you everything).

---

## 2. Ranking — how the feed is ordered

### 2.1 The blend

For You scores each candidate as a weighted sum of independent signals: popularity, recency,
discussion volume, behavioural affinity (domain/author), embedding relevance, title/comment term
affinity, and a learned reranker term. The reader tunes the weights live.

### 2.2 Ranking is RELATIVE, on purpose — at two levels

**Level 1: position.** A story's rank is its position among the candidates fetched for that pass. A
larger pool moves it down. This is what ranking means and is not a defect.

**Level 2: the learned term's magnitude.** The learned reranker's contribution is normalised against
**the pool's own dispersion** of predicted log-odds, then scaled by the model's demonstrated skill
(held-out AUC discounted by its standard error). Consequences that are all INTENDED:

- The same story with the same model can receive a different learned boost in different pools.
- Because the other terms are not scaled, this can change the relative order of two stories that
  appear in both pools. **A model-favoured/crowd-cold story can lose to a crowd-favoured/model-cold
  story in a high-dispersion pool and win in a low-dispersion one.**
- A model that has learned nothing stays quiet; a model that discriminates earns influence.

The rationale is that "how much is this taste-score worth" is only answerable relative to the
alternatives. A p=0.90 among a pool of 0.5s is a standout; the same 0.90 among 0.97s is unremarkable.
Without normalisation, one realistic noisy history produced a learned spread that was 2.2% of the
smallest competing signal and no slider setting could reach it; applied unconditionally, the same
machinery handed full authority to models that had learned nothing.

**This is NOT a defect and must not be reported as one.** What IS a defect: any claim (in a comment,
doc or UI string) that pool composition cannot affect ordering.

### 2.3 In-session stability

Within a session the visible order is PINNED. Reading, opening a discussion, switching feed tab and
reloading must not re-order the list. Re-ordering happens on **Refresh**, which the UI states.

**Open question, deliberately unspecified:** whether extending the pool via *Load more* may change
the learned normalisation mid-session. If it does and the visible order shifts without a Refresh,
that is a defect (it breaks in-session stability). Verifying this is welcome.

### 2.4 Gating

The learned reranker applies only with enough samples AND enough positives. Below the gate the manual
blend ranks and every surface saying so must agree with every other one.

Retraining is a BACKGROUND task, by design: it runs only while the tab is hidden, after enough new
engagement events, and rate-limited. Training while the reader is looking at the feed would reorder
it under them. "Retrain now" in Settings is the immediate path, and it is the only one guaranteed to
work in a session where the reader never backgrounds the tab.

Any copy describing this must be true for a reader who stays in the tab all session. "It trains
itself as you read" is NOT — it is a defect under §10.

### 2.5 Explainability

Every For-You card offers a rank traceback. The numbers shown must reconcile with the score actually
used to rank: the per-signal contribution bars sum to the score. There is deliberately NO per-row
"weight × value" micro-formula — `reconcileTo2dp` nudges the largest term's contribution so the
rounded parts sum exactly, which a raw weight×value cannot always match, so showing it only invited a
contradiction. Explaining an inherently relative quantity in absolute terms is a presentation defect
even when the arithmetic is right.

---

## 3. Reading history

"Read" means the reader clicked through and **stayed** — opened the article and did not bounce, or
opened the discussion and stayed on it. Saving, summarising and upvoting are not reading. **Once
genuinely read, always read** — a later bounce never un-reads.

The Read tab and the sidebar "Recently read" derive from one definition and must always agree. The
Read tab is a HISTORY: a story marked "Not interested" still appears there. Global mutes and
min-points still apply to both.

---

## 4. Sessions and position

Your POSITION in a feed — pinned order and paging depth — starts fresh on a new tab or on
**Refresh**, and continues across reading, opening a discussion, switching tab, and **reloading**
(a reload keeps your place; only a new tab or Refresh re-ranks/re-pages).

**Scroll position is deliberately NOT restored.** Arriving at any route lands at the TOP. Paging
depth and pinned order ARE kept, so the list is the one you left. Landing anywhere other than the
top — including inheriting the previous route's offset — is a defect, as is yanking a reader who has
started scrolling.

**For You hides already-read stories (the "read sweep", design #4). It is recomputed at EXACTLY three
boundaries and nowhere else:** a browser **reload**, opening a **new tab** (both are fresh document
loads), and the explicit **Refresh** button. Arriving fresh shows fresh stories: the sweep is
recomputed after the read-history query resolves, For You waits for it (so read items are gone from
the first frame, no flash), it is ANNOUNCED and reversible ("N already-read hidden · Undo"), it lands
at the top (no mid-scroll yank), and it KEEPS the pinned order + paging (a reload is not a re-rank).

**The sweep must NEVER change on in-app navigation** — the home icon, a feed-tab switch, or
opening/closing a discussion. Those CONTINUE the session; a story read this session must stay visible
until the next load or Refresh. Clicking the home icon to return to the feed is not a new session and
must not hide anything. (A story disappearing on mere in-app navigation is a defect; guarded by
`sessionsweeptest`.)

**Refresh is scoped to the current tab.** Pressing Refresh re-fetches only the feed it belongs to; it
must never force-refresh another tab (including a tab the reader switches to while a Refresh is still
in flight).

"Not interested" leaves a placeholder row rather than removing the row under the reader. Never on the
Read tab.

---

## 5. AI

Optional and off by default. Two backends: on-device (WebLLM, needs WebGPU) or a bring-your-own-key
cloud provider. Kinds: story TL;DR, thread summary, ask-the-thread, and an explicitly-triggered
profile persona summary.

### 5.1 The contract: the app guarantees the INPUT, not the OUTPUT

**The app makes NO correctness guarantee about what the model emits** — including invented specifics
and views attributed to a named commenter who never expressed them. Output is DISCLAIMED, not
corrected. A previous attempt to police it was deleted after three rounds of finding new holes;
"did the model say something false" is not decidable and a regex over prose cannot make it so.

Reporting model fabrication as a code defect is out of scope. What IS in scope, because it is
decidable:

1. **Thin input is refused** rather than sent to a model that will fill a template from nothing.
2. **Untrusted text is fenced and role labels defanged**, on every field a third party controls.
3. **Provenance, the caveat, and attribution are all earned by REAL MODEL OUTPUT** — every "based on
   N comments / + article text (~M words)", the "AI-generated · may be inaccurate" caveat, AND the
   Llama attribution appear only when a model actually PRODUCED the text. Two states produce no model
   output and so must carry NONE of them, on EVERY surface (TL;DR, thread, ask, persona): a **refusal**
   (thin input, never sent) and a **failed generation** (the call threw — a cloud rate-limit / bad
   key / 5xx, or an empty on-device result). Note the trap: "a send was attempted" is NOT "a model
   produced text" — a gate keyed on the former (e.g. AskThread's `sent.sent`) still shows provenance
   and the caveat over an ERROR, which is why the signal must be "produced text" (`sent.sent &&
   !errored`, or `request.length > 0` where the request is only set on success).
4. **The disclaimer is present** on every surface that renders model text (but not over non-model
   output — see 3).

### 5.2 Rendering of model output

Model output is markdown-ish and rendered by a deliberately minimal converter. The requirement is
that **information present in the model's text survives to the reader**. Ordinals, bullets, headings
and links must not be silently deleted by the conversion.

Currently ordinals survive as literal text (`1. point`) rather than as list markers, because the
shared `.hn-html` container inherits a preflight reset that suppresses list markers, and that
container is also used for HN comment bodies. Consistency across list types is desirable but
unspecified; **silent information loss is a defect**.

### 5.3 Attribution

"Built with Llama" appears where Llama Materials are actually in use — beside on-device Llama output
and in the README. It must NOT appear over a cloud provider's output, over a refusal, or over a
failed generation no model produced: a false attribution is worse than a missing one.

---

## 6. Filters and hiding

Muted domains/users/keywords and a minimum-points threshold are GLOBAL: every feed and search. Job
posts are exempt from min-points (real HN jobs carry a constant `score: 1`). Per-item Hide is
likewise global — except the two read surfaces, which are history.

A feed whose first page is entirely filtered must page through to the first showable page; when
everything is filtered it must terminate on an honest empty state attributing the emptiness to the
filters. An unfiltered feed must still stop at one page.

**An OUTAGE is not an empty result.** When a fetch FAILS — a 5xx, a network error, or the reader
being OFFLINE — every list, search, and profile shows a distinct error state with a Retry, never
"Nothing to show" / "No results" / "User not found" (which would blame the reader's filters or claim
the thing doesn't exist), and never a misleading result COUNT above that error. This holds offline
too: queries attempt the fetch and fail fast rather than pausing silently (`networkMode: 'always'`).
A lazy route whose JS chunk can't be fetched (typically offline) shows a graceful message and
recovers on navigation — not a raw "Failed to fetch dynamically imported module".

---

## 7. Appearance

Three independent axes: 31 designs, light/dark, 14 layouts. Components use semantic tokens only.

Text meets WCAG AA (4.5:1; 3:1 large) on every surface a token can be text on. Interactive controls
meet WCAG 1.4.11 (≥3:1) for their boundary against the adjacent surface, and a segmented control
makes "there are N segments and this one is selected" obvious. Decorative elements, disabled
controls and logotypes are exempt and are LOW at most.

---

## 8. Privacy

Everything is local except: the HN APIs (Firebase + Algolia); a remote favicon service (default on,
toggleable — off must make zero requests); an opt-in reader-proxy chain for article text; an
optional cloud LLM with the reader's own key; the one-time on-device model weight download
(`huggingface.co`), on first enable of embeddings or the local LLM; and read-aloud, whose default
system voice is a network voice on some platforms, so the text read can leave the device via the OS.
No telemetry, no analytics, no accounts.

`SECURITY.md` is the AUTHORITATIVE enumeration — it is what ships to readers. If this list and
`SECURITY.md` disagree, `SECURITY.md` is right and this section is stale.

**Offline.** The built (hosted) app registers a service worker (generated by `vite.config.ts`) that
precaches its OWN shell + code, so it loads even when the serving origin is down — a reload or new
tab works offline. The SW caches only same-origin app assets; every cross-origin data request (HN
APIs, favicon service, reader proxy, cloud LLM, model-weight CDN) is passed STRAIGHT to the network,
so the SW adds no network destination and never caches your reading data (that stays in IndexedDB /
the app's own Cache-API stores, which the SW never deletes). Fresh HN data therefore needs
connectivity; previously-loaded data and previously-downloaded model weights work offline. The
dev server and the `file://` single-file build have no SW (the single-file build is itself the
no-server option).

**Offline UX.** The app is connection-aware. (1) A fixed, non-reflowing indicator appears when the
browser goes offline (debounced against brief blips) and clears on reconnect — it must never push
list content down. (2) A feed/search/discussion that ERRORED while offline auto-recovers when
connectivity returns (the browser's `online` event refetches errored active queries) — no manual
Retry; `networkMode:'always'` stays, so an outage still reads as an outage (SPEC §6), never a fake
empty state. (3) Offline outage states say "You're offline" and point to content that IS available
offline (Saved + Read, both from IndexedDB), while keeping Retry as the primary action. (4) Because
the app is installable (`site.webmanifest`), Settings offers an "Install for offline reading"
affordance once the browser makes an install prompt available (absent otherwise / when already
installed); it adds no always-on network destination.

---

## 9. Performance — accepted costs

These are known, measured and accepted. Re-measuring is fine; re-reporting them as defects is not.
New information (a different trigger, a wider blast radius, a wrong root cause) is welcome.

- **For-You cold start**: the candidate pool is fetched in ONE Algolia request for RECENT STORIES
  (`tags=story` + a few-days `created_at_i` recency filter) that returns fully-formed stories, so there
  is no three-list firebase merge and no per-item N+1 — measured ~0.7–0.9 s to first card (1 pool
  request) vs the old ~90 requests. `tags=story` is used deliberately instead of `tags=front_page`:
  the front_page tag is ~half pinned "YC is hiring" job posts (un-rankable, and a null score slips
  past min-points), and its relevance sort resurfaces months-old items — `tags=story` + recency is
  job-free, fresh, and points-ranked. On an Algolia failure or empty result For You falls back to the
  firebase blended top/best/new pool (the old, slower path), so it stays resilient; a total firebase
  outage then still surfaces as the feed's Retry state. (Guarded by `foryousourcetest`.) The default-on
  top-comment previews (a separate, bounded, lazy feature) fetch per visible card as before; the
  comment-tree fetch on opening a discussion is unchanged.
- **Return from a discussion**: ~100 ms at 1× to re-render a full-depth feed.
- **Infinite scroll auto-fills** until the page exceeds the viewport or the id list is exhausted.
  Under a very restrictive filter this materialises much of the list (measured 429 requests at
  `minPoints=200`, the slider maximum, versus 94 unfiltered). Bounded and self-terminating.

---

## 10. Deliberately unspecified

Treat these as SPEC-GAPs. If behaviour here looks wrong, report it as a question, not a defect:

- Whether bulleted and numbered AI output should render with markers, and whether `.hn-html` should
  style lists at all given it is shared with HN comment bodies.
- Whether *Load more* may change the learned normalisation mid-session (see 2.3).
- Exact copy anywhere. Wording is a LOW unless it is factually false or contradicts another surface.
- Whether the shipped internal-process meta-docs (`review/`, `AGENTS.md`) should be published.
