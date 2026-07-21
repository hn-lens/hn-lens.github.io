---
name: hnlens-build
description: >-
  Build, run, and deploy HN Lens (the static in-browser Hacker News reader in this repo).
  Use when installing deps, running the dev server or the production preview, producing the
  single-file file:// build, fixing the CI lockfile registry, or deploying to GitHub Pages.
---

# Building & running HN Lens

React 19 + TypeScript + Vite 8 + Tailwind v4. No backend. Everything below assumes the repo root.

## Install dependencies

```bash
npm install           # installs from package-lock
```

Adding a package: `npm install <pkg>` (runtime) or `npm install -D <pkg>` (dev). If your network
routes npm through a private mirror, see the CI lockfile note below — the committed lockfile must
stay on the public registry.

Playwright's browser (needed for tests) downloads from a CDN, not the npm registry:

```bash
npx playwright install chromium
```

### The ML libraries are lazy — keep them out of the main bundle

`@huggingface/transformers` and `@mlc-ai/web-llm` must only be reached through dynamic
`import()` (they are, inside `src/lib/models/embeddings.ts` and `llm.ts`). `vite.config.ts`
lists them in `optimizeDeps.exclude`. Never add a static `import` of them in the app path.

## Run

```bash
npm run dev        # Vite dev server, http://localhost:5173  (HMR; for iterating)
npm run build      # tsc -b && vite build  →  dist/  (multi-file, this is what deploys)
npm run preview    # serve the built dist/ over http, http://localhost:4173
```

Why a server at all: source is TS/JSX with bare imports — the browser can't run it raw, so dev
needs Vite. The built site is static, but ES modules + WASM + web workers are blocked over
`file://`, so it must be served over `http(s)` (preview locally, GitHub Pages in prod).

## Serving a preview FOR THE USER to examine (do this every time they ask to "run the server")

A plain `npm run preview` binds **localhost-only** — the user may not be able to reach it, and a
curl `HTTP 200` from the same box does NOT prove they can. "Started it" and "verified it works" are
different claims; only make the second. Two real mistakes made 2026-07-20: (a) bound localhost-only
and reported "running" off a same-host ping — user couldn't open it; (b) **switched ports across
turns (4173→4185→4190→4192)**, which **stranded GBs of per-origin browser data** (see the warning
below) the user couldn't remove.

**ALWAYS use the ONE canonical port `4173`** for the user-facing preview — never switch ports.

1. **Rebuild first** so it serves the latest code: `npm run build`.
2. **Start on port 4173, all interfaces**, as a **durable background job** (survives turns):
   `npx vite preview --port 4173 --strictPort --host`. `--host` prints a `Network:` URL and listens
   on `*` (dual-stack). If 4173 is held by a stale listener, free it (`lsof -tiTCP:4173 -sTCP:LISTEN
   | xargs kill`) rather than moving to a new port.
3. **Verify reachability EMPIRICALLY on every address a browser might use** — don't assume:
   `for u in http://127.0.0.1:4173/ http://localhost:4173/ 'http://[::1]:4173/'; do curl -s -o
   /dev/null -w "$u %{http_code}\n" "$u"; done` — all should be `200`. (IPv4 `127.0.0.1` vs IPv6
   `::1` mismatch is a classic "looks dead in the browser" cause.)
4. **Verify it serves the REAL app**, not just a ping: fetch `/` → confirm `<title>HN Lens …` +
   `<div id="root">`, then fetch the referenced `/assets/index-*.js` → `200` with a real size.
5. **Give the user the exact URL** `http://localhost:4173/` (localhost/127.0.0.1 are secure contexts,
   so the local-AI/WebGPU features work; a raw LAN IP is NOT a secure context — don't send them there
   for AI).
6. **Keep it alive** on 4173. After a rebuild the running preview serves the new `dist/` (no restart),
   but re-verify if unsure.

Never report "the server is running" off a bare start or a same-host ping alone — verify reachability
across addresses + real content, then hand over the `localhost:4173` URL.

> **WHY one fixed port matters — per-origin storage:** the app caches **model weights (GBs)** and all
> local data (IndexedDB, prefs) keyed by **origin** = `http://localhost:<port>`. Each port is a
> SEPARATE origin with its own storage. Switching ports (a) makes the user re-download models, and
> (b) **strands** the old port's GBs — the app on the new port can't see/remove them, and once that
> port's server is gone the user can't open the app there to clear them either. The only cleanups are
> re-serving the app on the old origin and using Settings → **Cached models → Remove**, or clearing
> that origin's site data in the browser (DevTools ▸ Application ▸ Clear site data, or
> `chrome://settings/content/all` → search `localhost`). Avoid the whole mess: **stay on 4173.**

## Single-file build (double-clickable, file://)

```bash
npm run build:single   # → dist-single/index.html  (everything inlined, ~0.5 MB)
open dist-single/index.html
```

`SINGLEFILE=1` aliases the ML libs to `src/lib/models/_stub_ml.ts` (WASM/workers can't run on
`file://`), then `scripts/inline.mjs` inlines JS+CSS into one HTML. The core reader + the pure-JS
logistic reranker work from the file; **embeddings/LLM are stubbed** there — they run on the
http/https build only.

## Deploy (GitHub Pages)

Pushing to `main` runs `.github/workflows/deploy.yml` (Node 22, `npm ci`, `vite build`, upload
`dist/`). In repo settings: **Pages → Source: GitHub Actions**. `base: './'` + HashRouter means it
works at any Pages path with no extra config.

### CI lockfile gotcha (important)

The committed `package-lock.json` must keep its `resolved` URLs on **`registry.npmjs.org`** — GitHub
runners can only reach the public registry, and the workflow also runs
`npm config set registry https://registry.npmjs.org`. If a network/proxy policy rewrites the
lockfile's `resolved` URLs to a private mirror when you regenerate it, regenerate it against the
public registry instead so it's written correctly in the first place:

```bash
npm config set registry https://registry.npmjs.org
rm -f package-lock.json && npm install
```

## Before handing work back

`npm run verify` (typecheck + lint + build + browser harnesses). See the **hnlens-testing** skill.
Rebuild both review artifacts if you changed the app: `npm run build` and `npm run build:single`.
Only commit/push when explicitly asked.
