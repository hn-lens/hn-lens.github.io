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
  prefs: usePrefs,
};

// LOAD-TIME SNAPSHOT for For You's "hide already-read stories" (hideReadInFeed).
// Captured ONCE here at app startup — unconditionally (regardless of the landing
// feed or the pref), so it reflects exactly what was read at page load. useFeed reads
// this primed cache (staleTime/gcTime Infinity ⇒ never refetched/evicted) and only
// APPLIES it when hideReadInFeed is on. Capturing at load (not lazily on first For-You
// mount / first toggle) is what makes it stable in-session: a story read MID-SESSION
// is not in the snapshot, so it's never yanked out of For You; toggling the pref just
// shows/hides this same fixed set; and it's identical whether or not For You is the
// landing feed. A browser refresh re-runs this, so newly-read stories drop out then.
void queryClient.prefetchQuery({
  queryKey: ['readSnapshot'],
  queryFn: () => getReadItemIds(1000),
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
// We deliberately do NOT invalidate ['readSnapshot'] here: that snapshot is fixed for the
// session (see above) so in-session reads aren't yanked out of For You. It recomputes on a
// full page reload (or an explicit "clear reading history" in DataManager, which
// invalidates all keys). (Do not add a ['readSnapshot'] invalidation on engagement — that
// re-introduces the mid-session-yank dead-end documented in AGENTS.md.)
onEngagement(() => {
  queryClient.invalidateQueries({ queryKey: ['readIds'] });
  queryClient.invalidateQueries({ queryKey: ['recentRead'] });
  queryClient.invalidateQueries({ queryKey: ['eventCount'] });
  queryClient.invalidateQueries({ queryKey: ['affinities'] });
  queryClient.invalidateQueries({ queryKey: ['content'] });
});

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
