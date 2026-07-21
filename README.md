# HN Lens

A smarter, private Hacker News reader that runs entirely in your browser. It takes the
original Hacker News data and adds a personalized recommendation feed, custom ranking, a
better reading UI, and **local** AI (embeddings + an in-browser LLM) for summaries and
recommendations — with **no backend**. All your activity and models stay in your browser
(IndexedDB + localStorage), and it deploys as a static site to GitHub Pages.

## Features

- **For You feed** — re-ranks stories from your reading activity, follows, keyword
  interests, embedding similarity, and a locally-trained logistic reranker. Every card
  shows *why* it was recommended. One toggle away from the **original HN ordering**
  (Top / New / Best / Ask / Show / Jobs).
- **Local models, pluggable** — swap between:
  - **Embeddings** (Transformers.js, WebGPU/WASM) for similarity ranking & "more like this".
  - **LLM** (WebLLM, WebGPU) for story TL;DRs and discussion summaries.
  - **Learned reranker** — a logistic-regression model trained in-browser on your clicks,
    saves, and hides. Tree/linear model experimentation is designed to plug into the same
    `ModelProvider` interface.
- **Great comments UX** — full nested threads fetched in one request (Algolia), collapsible
  subtrees, "new since last visit" highlighting, sort by best/new/most-replies, AI thread
  summaries. Available as a slide-in drawer and a permalink page (`/item/:id`).
- **Full-text search** across all of HN (Algolia).
- **Local-first interactions** — save, hide, follow/mute domains & users, tunable ranking
  weights, dark/light themes. Real upvote/comment deep-link out to Hacker News.

## Data sources (both CORS-enabled, no key, browser-only)

- **Firebase API** (`hacker-news.firebaseio.com`) — live front-page/new/best/ask/show/job
  ordering + item and user data.
- **Algolia HN Search API** (`hn.algolia.com/api/v1`) — search, filtering, and whole nested
  comment trees in a single request.

Note: writes (upvote/comment/favorite) can't be done from a static app because
`news.ycombinator.com` has no CORS — those actions deep-link to HN. Everything else is local.

## Tech stack

React + TypeScript + Vite + Tailwind CSS · TanStack Query · Zustand · Dexie (IndexedDB) ·
Transformers.js · WebLLM. Heavy ML libraries are code-split and loaded only when enabled.

## Develop

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # production build to dist/
npm run preview  # preview the production build
```

Requires a browser with **WebGPU** (recent Chrome/Edge) to run the local LLM; embeddings
fall back to WASM without it.

## Deploy (GitHub Pages)

Pushing to `main` triggers `.github/workflows/deploy.yml`, which builds and publishes `dist/`
to GitHub Pages. In the repo settings, set **Pages → Build and deployment → Source: GitHub
Actions**. The app uses a hash router and relative asset base, so it works on any Pages URL
(user or project site) without extra configuration.

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md) for setup, the test
suite, and coding guidelines. For security reports, see [SECURITY.md](./SECURITY.md).

## License

[MIT](./LICENSE) © Jianling Zhong
