# Security Policy

HN Lens is a **static, client-side** web app. It has no backend server and no database:
everything runs in your browser, and all data (reading history, settings, cached stories,
model weights) is stored locally in IndexedDB and localStorage. This keeps the security
surface small — there is no server to compromise and no shared user data.

## What data leaves your browser

Your reading activity, ranking, personalization, and models all run and stay on your device.
The app talks to the public Hacker News data APIs (`hacker-news.firebaseio.com`,
`hn.algolia.com`) for content, plus **one on-by-default enrichment call**, toggleable
in **Settings → Privacy**:

- **Story favicons** load from Google's public favicon service (`t*.gstatic.com/faviconV2`), so the
  domains of stories shown to you are visible to that service. Turn it off ("Load story favicons…") and the app renders letter monograms
  only and never contacts that service.

Two further calls happen only if you turn on a feature that needs them:

- **On-device AI model weights** — enabling the on-device model (or embeddings) downloads its
  weights once from the public model CDNs used by `@huggingface/transformers` and `@mlc-ai/web-llm`
  (`huggingface.co`, and `raw.githubusercontent.com` for some manifests). Your content is never
  sent — only the download itself touches the network, and the weights are then cached locally.
- **Read-aloud ("Listen")** — uses the browser's built-in `speechSynthesis`. On several platforms
  the default system voice is a **network** voice, so the text being read (an article body or a
  comment) may be sent to the OS/browser vendor by the platform, not by this app. Which voice is
  used is an OS/browser setting, outside HN Lens's control.

Two optional, **off-by-default** features send more data elsewhere only when *you* enable
them, and each is clearly labelled in Settings:

- **Linked-article text** — fetches article bodies through one of a few public CORS proxies
  (tried in a fallback chain, since free services rate-limit or go down) to feed the inline
  Article view, read-aloud (Listen), AI summaries, and ranking. Enabling it sends the URLs
  you engage with to whichever proxy answers.
- **Cloud LLM summaries** — if you supply your own API key for a cloud provider
  (Gemini / OpenAI / Anthropic), summary content and your key are sent to that provider.
  Keys are stored only in your browser's localStorage and are never committed or sent
  anywhere else.

## AI summaries are generated from untrusted content

When you enable AI summaries, the model is given the story, its comments, and (if you have turned on
linked-article text) the extracted page body. **All of that is text written by other people**, and a
comment can be crafted to influence the summary — for example by imitating the summary's own format
so its wording is repeated back as if it were the model's conclusion.

The app mitigates this: untrusted text is wrapped in an explicit boundary, content that impersonates
the output format or issues instructions to the model is defanged before being sent, and a story with
nothing to summarize is never sent at all. These raise the cost of manipulation but do not eliminate
it — a small on-device model cannot reliably tell data from instructions. Separately, small models
sometimes state specifics the source doesn't support.

So treat a summary as a reading aid, never as a source of fact: anything that matters should be
checked against the discussion itself, which is one click away. Every summary carries this caveat in
the UI, and "View request" shows the exact text that was sent to the model.

This is a content-trust property, not a code-execution one: summaries are rendered as plain text, so
an injected comment cannot execute script or reach your data — the worst case is a misleading
summary.

## Dependency advisories

`npm audit` currently reports **4 high-severity advisories against runtime dependencies**, and
Dependabot will surface them on this repository. Neither is reachable in the shipped app. Because
"open advisory, no fix available" is otherwise indistinguishable from "unmaintained", the reasoning
is recorded here rather than left for each reader to redo:

| Advisory | Package | Why it does not affect this app |
| --- | --- | --- |
| [GHSA-qwww-vcr4-c8h2](https://github.com/advisories/GHSA-qwww-vcr4-c8h2) — RSC-mode CSRF bypass | `react-router` (via `react-router-dom`) | The vulnerability is in React Server Components mode, which requires a server. HN Lens is a static client-side bundle using `HashRouter`; there is no server, no server action, and no RSC. |
| [GHSA-f88m-g3jw-g9cj](https://github.com/advisories/GHSA-f88m-g3jw-g9cj) — libvips CVEs (×4, counted as one advisory per package) | `sharp` (via `@huggingface/transformers`) | `sharp` is the **Node.js** image backend of Transformers.js. The browser build uses the WebGPU/WASM path; `sharp` is never imported into the bundle and has no native binary to run in a browser. |

Both have **no patched version available**, so they cannot be resolved by upgrading. The posture is
therefore to document rather than suppress: nothing is added to an ignore-list, so if either becomes
reachable — say the app ever gains a server-rendered mode — the advisory is still visible.

How to re-check after a dependency change:

```sh
npm audit --omit=dev          # advisories in code that actually ships
npm ls sharp react-router     # confirm why each is present
```

If a future advisory IS reachable, the fix is to upgrade or drop the dependency — not to extend this
table.

## Reporting a vulnerability

Please report security issues privately via GitHub's **"Report a vulnerability"** button
(Security → Advisories) on this repository rather than opening a public issue. Include
steps to reproduce and the affected version or commit. We'll acknowledge the report and
work on a fix; please allow a reasonable window before public disclosure.

## Supported versions

This is an actively-developed single-branch project; fixes land on `main` and deploy
automatically. Please report issues against the latest deployed version.
