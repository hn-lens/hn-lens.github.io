# Contributing to HN Lens

Thanks for your interest in improving HN Lens! It's a static, in-browser Hacker News
reader — no backend, everything runs client-side and deploys to GitHub Pages.

## Getting started

```bash
npm install
npm run dev      # http://localhost:5173
```

- Node 22+ is recommended (the CI build uses Node 22).
- A browser with **WebGPU** (recent Chrome/Edge) is needed to exercise the local LLM;
  embeddings fall back to WASM without it.

## Before you open a pull request

Run the full check suite and make sure it's green:

```bash
npm run verify
```

`verify` runs typecheck, lint, a production build, and the hermetic browser test harnesses
(behavioural, personalization, accessibility). For a faster inner loop use
`npm run test:quick`; `npm run test:full` adds visual, cross-browser, and model tests. Run
`node scripts/test.mjs --list` to see every tier.

## Guidelines

- **TypeScript is strict.** No `enum` and no constructor parameter properties
  (`erasableSyntaxOnly`); use `import type` for type-only imports. Unused locals/params
  fail the build.
- **Lint must be clean.** `oxlint` runs with zero warnings (it lints `scripts/` too).
- **Add a test for every feature or fix.** Coverage is by surface and interaction, not
  lines — every control and state should have a hermetic harness that seeds known state
  and asserts the exact expected outcome (and its negative). If you change a behaviour,
  extend or add the matching harness under `scripts/`.
- **Keep heavy ML libraries lazy.** `@huggingface/transformers` and `@mlc-ai/web-llm` are
  loaded only via dynamic `import()` so they stay out of the main bundle.
- **Local-first.** There is no backend; user data lives in IndexedDB and localStorage. One
  enrichment call is on by default and toggleable (story favicons); two are off by default
  (linked-article text fetch, cloud LLM summaries). All are clearly labelled in
  Settings → Privacy and disclosed in SECURITY.md — keep that list accurate when you add or
  change a network call.

## Commit messages

Write clear, present-tense messages that describe what the change does and why.

## Reporting bugs & requesting features

Open an issue with steps to reproduce (for bugs) or the use case (for features). For
security-sensitive reports, see [SECURITY.md](./SECURITY.md).
