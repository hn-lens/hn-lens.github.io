import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { EMBEDDING_MODELS, LLM_MODELS } from './models/catalog';
import {
  DEFAULT_LAYOUT_PREF,
  DEFAULT_THEME_ID,
  effectiveLayout,
  isValidLayoutPref,
  isValidThemeId,
} from './themes';
import type { CloudProvider, FeedKind, LlmProvider, Prefs, RankWeights, Theme } from '../types';

const LLM_PROVIDERS: LlmProvider[] = ['local', 'gemini', 'openai', 'anthropic'];

/** Whether a cloud LLM provider is selected AND has an API key — i.e. AI summaries can
 *  run without WebGPU / a local model download. Light + pure (safe to call in render). */
export function hasCloudKey(p: Pick<Prefs, 'llmProvider' | 'apiKeys'>): boolean {
  return p.llmProvider !== 'local' && !!p.apiKeys?.[p.llmProvider]?.trim();
}

export const DEFAULT_WEIGHTS: RankWeights = {
  popularity: 1.0,
  recency: 1.0,
  discussion: 0.6,
  affinity: 1.4,
  relevance: 1.2,
  learned: 0.8,
};

const DEFAULT_PREFS: Prefs = {
  theme: 'light',
  themeName: DEFAULT_THEME_ID,
  layout: DEFAULT_LAYOUT_PREF,
  defaultFeed: 'foryou',
  weights: DEFAULT_WEIGHTS,
  followedDomains: [],
  mutedDomains: [],
  followedUsers: [],
  mutedUsers: [],
  keywordsBoost: [],
  keywordsMute: [],
  minPoints: 0,
  showAiSummaries: true,
  embeddingsEnabled: false,
  embeddingModel: 'Xenova/all-MiniLM-L6-v2',
  llmEnabled: false,
  llmModel: 'Llama-3.2-1B-Instruct-q4f16_1-MLC',
  llmProvider: 'local',
  apiKeys: { gemini: '', openai: '', anthropic: '' },
  cloudModels: { gemini: '', openai: '', anthropic: '' },
  systemPrompts: { tldr: '', thread: '' },
  useLearnedRanker: true,
  hnUsername: '',
  fetchArticleText: false,
  hasOnboarded: false,
  hideReadInFeed: true,
  remoteFavicons: true,
};

function toggle(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

export function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle('dark', theme === 'dark');
  try {
    localStorage.setItem('hn:theme', theme);
  } catch {
    // ignore storage errors
  }
}

// One-time system preference, used only to seed the default for brand-new users /
// migrating away from the old "system" (null) value. After that it's a manual toggle.
function systemTheme(): Theme {
  return typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}

// Apply the visual DESIGN (one of the 20) by setting data-theme on <html>. The CSS
// in index.css keys every design off [data-theme='<id>'] (and its .dark variant);
// 'reader' has no such block and falls back to :root/.dark, which is correct.
export function applyThemeName(name: string): void {
  const id = isValidThemeId(name) ? name : DEFAULT_THEME_ID;
  document.documentElement.dataset.theme = id;
}

// Apply the structural LAYOUT by setting data-layout on <html>. The layout pref may
// be 'auto' (follow the design's default) — effectiveLayout() resolves that against
// the current design, so this must be re-run whenever EITHER the layout OR the
// design changes.
export function applyLayout(themeName: string, layoutPref: string): void {
  document.documentElement.dataset.layout = effectiveLayout(themeName, layoutPref);
}

interface PrefsStore extends Prefs {
  set: (p: Partial<Prefs>) => void;
  setWeights: (w: Partial<RankWeights>) => void;
  setTheme: (t: Theme) => void;
  toggleTheme: () => void;
  setThemeName: (name: string) => void;
  setLayout: (layout: string) => void;
  setDefaultFeed: (f: FeedKind) => void;
  toggleFollowDomain: (d: string) => void;
  toggleMuteDomain: (d: string) => void;
  toggleFollowUser: (u: string) => void;
  toggleMuteUser: (u: string) => void;
  reset: () => void;
}

export const usePrefs = create<PrefsStore>()(
  persist(
    (set, get) => ({
      ...DEFAULT_PREFS,
      set: (p) => set(p),
      setWeights: (w) => set((s) => ({ weights: { ...s.weights, ...w } })),
      setTheme: (t) => {
        applyTheme(t);
        set({ theme: t });
      },
      toggleTheme: () => {
        const t: Theme = get().theme === 'dark' ? 'light' : 'dark';
        applyTheme(t);
        set({ theme: t });
      },
      setThemeName: (name) => {
        applyThemeName(name);
        applyLayout(name, get().layout); // 'auto' layout depends on the design
        set({ themeName: name });
      },
      setLayout: (layout) => {
        applyLayout(get().themeName, layout);
        set({ layout });
      },
      setDefaultFeed: (f) => set({ defaultFeed: f }),
      toggleFollowDomain: (d) =>
        set((s) => ({
          followedDomains: toggle(s.followedDomains, d),
          mutedDomains: s.mutedDomains.filter((x) => x !== d),
        })),
      toggleMuteDomain: (d) =>
        set((s) => ({
          mutedDomains: toggle(s.mutedDomains, d),
          followedDomains: s.followedDomains.filter((x) => x !== d),
        })),
      toggleFollowUser: (u) =>
        set((s) => ({
          followedUsers: toggle(s.followedUsers, u),
          mutedUsers: s.mutedUsers.filter((x) => x !== u),
        })),
      toggleMuteUser: (u) =>
        set((s) => ({
          mutedUsers: toggle(s.mutedUsers, u),
          followedUsers: s.followedUsers.filter((x) => x !== u),
        })),
      reset: () => {
        // Re-apply the visual axes to the DOM, not just the store — otherwise the page
        // keeps the old design/dark-mode/layout until a reload even though Settings
        // shows the defaults.
        applyTheme(DEFAULT_PREFS.theme);
        applyThemeName(DEFAULT_PREFS.themeName);
        applyLayout(DEFAULT_PREFS.themeName, DEFAULT_PREFS.layout);
        set({ ...DEFAULT_PREFS });
      },
    }),
    {
      name: 'hn:prefs',
      // Persist only data fields, not the action functions.
      partialize: (s): Prefs => ({
        theme: s.theme,
        themeName: s.themeName,
        layout: s.layout,
        defaultFeed: s.defaultFeed,
        weights: s.weights,
        followedDomains: s.followedDomains,
        mutedDomains: s.mutedDomains,
        followedUsers: s.followedUsers,
        mutedUsers: s.mutedUsers,
        keywordsBoost: s.keywordsBoost,
        keywordsMute: s.keywordsMute,
        minPoints: s.minPoints,
        showAiSummaries: s.showAiSummaries,
        embeddingsEnabled: s.embeddingsEnabled,
        embeddingModel: s.embeddingModel,
        llmEnabled: s.llmEnabled,
        llmModel: s.llmModel,
        llmProvider: s.llmProvider,
        apiKeys: s.apiKeys,
        cloudModels: s.cloudModels,
        systemPrompts: s.systemPrompts,
        useLearnedRanker: s.useLearnedRanker,
        hnUsername: s.hnUsername,
        fetchArticleText: s.fetchArticleText,
        hasOnboarded: s.hasOnboarded,
        hideReadInFeed: s.hideReadInFeed,
        remoteFavicons: s.remoteFavicons,
      }),
      onRehydrateStorage: () => (state) => {
        if (!state) {
          applyTheme(systemTheme()); // seed new users from their OS preference once
          applyThemeName(DEFAULT_THEME_ID);
          applyLayout(DEFAULT_THEME_ID, DEFAULT_LAYOUT_PREF);
          return;
        }
        // Migrate the old "system" (null) mode to a concrete light/dark once.
        const theme: Theme = state.theme === 'light' || state.theme === 'dark' ? state.theme : systemTheme();
        if (theme !== state.theme) state.theme = theme;
        applyTheme(theme);
        applyThemeName(state.themeName);
        applyLayout(state.themeName, state.layout);
        // Migrate away from models that are no longer offered (e.g. an old
        // default like Gemma 3 or SmolLM2 that produced poor output). Runs on
        // every load so removing a model from the catalog auto-heals stale prefs.
        queueMicrotask(() => {
          const patch: Partial<Prefs> = {};
          if (!LLM_MODELS.some((m) => m.id === state.llmModel)) {
            patch.llmModel = DEFAULT_PREFS.llmModel;
          }
          if (!EMBEDDING_MODELS.some((m) => m.value === state.embeddingModel)) {
            patch.embeddingModel = DEFAULT_PREFS.embeddingModel;
          }
          if (!isValidThemeId(state.themeName)) {
            patch.themeName = DEFAULT_THEME_ID;
            applyThemeName(DEFAULT_THEME_ID);
          }
          if (!isValidLayoutPref(state.layout)) {
            patch.layout = DEFAULT_LAYOUT_PREF;
            applyLayout(patch.themeName ?? state.themeName, DEFAULT_LAYOUT_PREF);
          }
          // Heal an invalid/legacy LLM provider and ensure the api-key map exists with
          // all provider slots (so a partial persisted object can't crash the picker).
          if (!LLM_PROVIDERS.includes(state.llmProvider)) patch.llmProvider = 'local';
          const keys = (state.apiKeys ?? {}) as Partial<Record<CloudProvider, string>>;
          if (typeof keys.gemini !== 'string' || typeof keys.openai !== 'string' || typeof keys.anthropic !== 'string') {
            patch.apiKeys = { gemini: keys.gemini ?? '', openai: keys.openai ?? '', anthropic: keys.anthropic ?? '' };
          }
          const models = (state.cloudModels ?? {}) as Partial<Record<CloudProvider, string>>;
          if (typeof models.gemini !== 'string' || typeof models.openai !== 'string' || typeof models.anthropic !== 'string') {
            patch.cloudModels = { gemini: models.gemini ?? '', openai: models.openai ?? '', anthropic: models.anthropic ?? '' };
          }
          const sys = (state.systemPrompts ?? {}) as Partial<{ tldr: string; thread: string }>;
          if (typeof sys.tldr !== 'string' || typeof sys.thread !== 'string') {
            patch.systemPrompts = { tldr: sys.tldr ?? '', thread: sys.thread ?? '' };
          }
          if (Object.keys(patch).length) usePrefs.setState(patch);
        });
      },
    }
  )
);
