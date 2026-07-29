import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import './index.css';
import App from './App.tsx';
import ErrorBoundary from './components/ErrorBoundary.tsx';
import { pruneCaches } from './lib/db';
import { usePrefs } from './lib/prefs';
import { queryClient } from './lib/query';
import { initDwellTracking } from './lib/dwell';
import { initAutoTrain } from './lib/ranking/autotrain';
import { loadModel } from './lib/ranking/logistic';
import { getReadItemIds, onEngagement } from './lib/interactions';
import { getReadSweep, seedReadSweepForLoad } from './lib/readSweep';
import { probeWebgpu } from './lib/models/registry';
// Ranking/personalization internals — lightweight app modules already in the
// main bundle. Imported here (statically, no extra chunk) purely so the proof
// harness can drive the REAL code via window.__hnlens (see below).
import * as dbMod from './lib/db';
import * as interactionsMod from './lib/interactions';
import * as clientMod from './lib/hn/client';
import * as trainMod from './lib/ranking/train';
import * as logisticMod from './lib/ranking/logistic';
import * as featuresMod from './lib/ranking/features';
import * as strategiesMod from './lib/ranking/strategies';
import * as contentMod from './lib/ranking/content';
import * as autotrainMod from './lib/ranking/autotrain';
import * as articleMod from './lib/hn/article';
import * as registryMod from './lib/models/registry';
import * as themesMod from './lib/themes';

// Best-effort cache cleanup on startup (non-blocking).
void pruneCaches();
// Probe for a real GPU adapter (not just the API) so AI controls only appear when
// the GPU can actually run them.
void probeWebgpu();

// Lightweight hooks for the offline eval + proof harnesses (scripts/evaltest.mjs,
// scripts/personalization-proof.mjs). Lazy — no effect on normal use, and the heavy
// ML libs (llm/embeddings) still only load when their loader is actually called.
(window as unknown as Record<string, unknown>).__hnlens = {
  // Heavy ML libs stay lazy — only loaded when their loader is actually called.
  llm: () => import('./lib/models/llm'),
  cloud: () => import('./lib/models/cloud'), // BYO cloud-LLM clients — for UI harnesses
  algolia: () => import('./lib/hn/algolia'),
  embeddings: () => import('./lib/models/embeddings'),
  // Ranking/personalization internals: let the proof harness drive the REAL
  // training, affinity, feature and scoring code (not a reimplementation).
  db: () => dbMod,
  interactions: () => interactionsMod,
  client: () => clientMod,
  train: () => trainMod,
  logistic: () => logisticMod,
  features: () => featuresMod,
  strategies: () => strategiesMod,
  topComment: () => import('./lib/hn/topComment'),
  html: () => import('./lib/html'),
  content: () => contentMod,
  autotrain: () => autotrainMod,
  article: () => articleMod,
  registry: () => registryMod, // model status store (WebGPU state) — for UI harnesses
  themes: () => themesMod, // THEME_IDS / LAYOUT_IDS — for the theme-contrast harness
  feedSession: () => import('./lib/feedSession'), // session stubs/pins — for harnesses
  localData: () => import('./hooks/useLocalData'), // hide/unhide/save plain fns — for harnesses
  prefs: usePrefs,
};

// The read sweep for For You's "hide already-read stories" (hideReadInFeed) — design #4 (see
// lib/readSweep.ts). On every FRESH PAGE LOAD (new tab OR reload) we recompute it from reading
// history so arriving fresh shows fresh stories. This is safe here where the earlier per-load
// snapshot was not, because: it is computed AFTER the history query resolves (no seed-vs-history
// race); useFeed GATES For You's first paint on this primed query (readSnapshotQ), so read items are
// gone from the first frame — no flash, no shift; and it is announced + reversible ("N already-read
// hidden · Undo") and lands at the top of a re-rendered feed, not mid-scroll. It does NOT touch the
// pinned order or paging depth (kept across a reload), and it runs once per page load — an in-session
// read is never swept out from under the reader. useFeed reads this primed cache (staleTime/gcTime
// Infinity, never refetched), so a tab switch does not re-seed; only Refresh re-sweeps (applyReadSweep).
void queryClient.prefetchQuery({
  queryKey: ['readSnapshot'],
  queryFn: async () => {
    if (!usePrefs.getState().hideReadInFeed) return getReadSweep();
    const readIds = await getReadItemIds(1000);
    seedReadSweepForLoad(readIds); // write sessionStorage so peekReadSweep in useFeed agrees
    return readIds;
  },
  staleTime: Infinity,
  gcTime: Infinity,
});

// Prime the learned-reranker model into the shared ['ranker'] cache at startup so every
// surface that shows the trained count — the For You sidebar progress, Settings, and the
// "Why #N?" dialog — reflects the SAME stored model from first paint (the sidebar query
// uses staleTime: Infinity, so a returning user shouldn't briefly see "0/12 · still
// learning" while Settings already shows the trained model). autotrain keeps it fresh.
void queryClient.prefetchQuery({ queryKey: ['ranker'], queryFn: loadModel });

// Close the learning loop: record read-time and keep the model auto-trained.
initDwellTracking();
initAutoTrain();
// Reading/engaging should promptly update the event-derived surfaces WITHOUT a page
// reload: the Read tab + sidebar "recently read" (['readIds']/['recentRead']), the
// signals counter (['eventCount']), AND For You's event-derived ranking inputs — the
// behavioural affinities (['affinities']) and content signals (['content', …],
// relevance/term-affinity). Folding those in on engagement is what makes reading a few
// stories actually personalize the feed in-session: the "warming up" banner clears, the
// ranking incorporates the new domain/author/content signals, and "Why #N?" reflects the
// recorded engagement instead of falsely reporting "no personal signals yet".
//
// We deliberately do NOT invalidate ['readSnapshot'] here: the sweep is fixed for the duration of a
// page load, so a story read in THIS sitting is never yanked out from under the reader. It is
// recomputed on the next FRESH LOAD (new tab or reload, seeded above) and by an explicit Refresh
// (applyReadSweep) — those are the only moments it changes. (Do NOT add a ['readSnapshot']
// invalidation on engagement — a per-read recompute is the mid-session-yank dead-end documented in
// AGENTS.md and lib/readSweep.ts.)
onEngagement(() => {
  queryClient.invalidateQueries({ queryKey: ['readIds'] });
  queryClient.invalidateQueries({ queryKey: ['recentRead'] });
  queryClient.invalidateQueries({ queryKey: ['eventCount'] });
  queryClient.invalidateQueries({ queryKey: ['affinities'] });
  queryClient.invalidateQueries({ queryKey: ['content'] });
});

// The APP owns scroll restoration, so the browser must not also try.
//
// 'manual' is only correct while something actually restores, and for a while nothing did — this
// line said 'manual', the per-feed restore it pointed at had been deleted, and Feed.tsx claimed the
// browser handled it. All three were false and the reader was thrown to the top on every
// navigation.
//
// There is now no app-side restore at all: arriving at a feed scrolls to the top (Feed.tsx).
// `manual` still matters, because the browser's own restoration would otherwise reapply a stale
// offset on reload and fight that.
//
// `scripts/feedcontinuitytest.mjs` holds this to the whole excursion x position matrix.
if ('scrollRestoration' in history) history.scrollRestoration = 'manual';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <HashRouter>
          <App />
        </HashRouter>
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>
);
