// ---------- Hacker News (Firebase API) ----------

export type HnItemType = 'story' | 'comment' | 'job' | 'poll' | 'pollopt';

export interface HnItem {
  id: number;
  type?: HnItemType;
  by?: string;
  time?: number; // unix seconds
  text?: string; // HTML
  dead?: boolean;
  deleted?: boolean;
  parent?: number;
  poll?: number;
  kids?: number[];
  url?: string;
  score?: number;
  title?: string; // HTML
  parts?: number[];
  descendants?: number;
}

export interface HnUser {
  id: string;
  created: number;
  karma: number;
  about?: string;
  submitted?: number[];
}

// ---------- Algolia HN Search API ----------

export interface AlgoliaComment {
  id: number;
  created_at_i: number;
  author: string | null;
  text: string | null;
  parent_id: number | null;
  story_id: number | null;
  points: number | null;
  type: string;
  children: AlgoliaComment[];
}

export interface AlgoliaItem {
  id: number;
  created_at_i: number;
  author: string | null;
  title: string | null;
  url: string | null;
  text: string | null;
  points: number | null;
  parent_id: number | null;
  story_id: number | null;
  children: AlgoliaComment[];
  type: string;
}

export interface AlgoliaHit {
  objectID: string;
  title?: string;
  url?: string;
  author?: string;
  points?: number;
  num_comments?: number;
  created_at_i?: number;
  story_text?: string;
  comment_text?: string;
  story_id?: number;
  story_title?: string;
  story_url?: string;
  _tags?: string[];
}

export interface AlgoliaSearchResult {
  hits: AlgoliaHit[];
  nbHits: number;
  page: number;
  nbPages: number;
  hitsPerPage: number;
}

// ---------- App ----------

export type FeedKind = 'foryou' | 'top' | 'new' | 'best' | 'ask' | 'show' | 'job' | 'read';
// The AI summary types, each with its own configurable system instruction + user template.
export type PromptKind = 'tldr' | 'thread' | 'ask' | 'user';

export interface RankWeights {
  popularity: number; // HN score
  recency: number; // freshness
  discussion: number; // comment volume/velocity
  affinity: number; // followed/muted domains & authors + learned affinity
  relevance: number; // embedding similarity to your reading profile
  learned: number; // logistic model probability
}

export interface RankedStory {
  item: HnItem;
  score: number;
  reasons: string[]; // "why recommended"
}

export type InteractionType =
  | 'impression'
  | 'open_link'
  | 'open_comments'
  | 'save'
  | 'unsave'
  | 'hide'
  | 'unhide'
  | 'upvote_out'
  | 'summarize'
  | 'search'
  | 'dwell';

export interface InteractionEvent {
  id?: number;
  ts: number;
  type: InteractionType;
  itemId?: number;
  domain?: string;
  author?: string;
  value?: number; // e.g. dwell ms
  meta?: Record<string, unknown>;
}

export type Theme = 'light' | 'dark';
export type TextSize = 'sm' | 'md' | 'lg';

// The cloud LLM providers a user can bring their own API key for.
export type CloudProvider = 'gemini' | 'openai' | 'anthropic';
// The LLM backend for AI summaries: on-device WebLLM, or a BYO-key cloud provider.
export type LlmProvider = 'local' | CloudProvider;

export interface Prefs {
  theme: Theme; // light/dark MODE axis (binary toggle — no "system")
  themeName: string; // which of the 31 visual designs (the DESIGN axis; see lib/themes.ts)
  layout: string; // structural layout id, or 'auto' to follow the design's default (LAYOUT axis)
  textSize: TextSize; // reading text scale (root font-size) — independent of design/layout
  defaultFeed: FeedKind;
  weights: RankWeights;
  followedDomains: string[];
  mutedDomains: string[];
  followedUsers: string[];
  mutedUsers: string[];
  keywordsBoost: string[];
  keywordsMute: string[];
  minPoints: number;
  showAiSummaries: boolean;
  embeddingsEnabled: boolean;
  embeddingModel: string;
  llmEnabled: boolean;
  llmModel: string;
  // Which LLM backs the AI summaries: the on-device WebLLM ('local', default) or a
  // cloud provider you supply your OWN API key for. Cloud providers don't need WebGPU
  // and are much faster/stronger, but send the summary content + your key directly to
  // the provider from your browser (opt-in; key stored locally). See CLOUD_PROVIDERS.
  llmProvider: LlmProvider;
  // Per-provider API keys (stored locally in this browser only). Empty when unset.
  apiKeys: Record<CloudProvider, string>;
  // Per-provider chosen model id (empty ⇒ the provider's default). Populated by querying
  // the provider's model list once a key is set, so the user picks from what THEIR key
  // can actually access.
  cloudModels: Record<CloudProvider, string>;
  // AI prompt overrides per summary type: an editable SYSTEM instruction AND an editable
  // USER-message TEMPLATE (with {placeholders} for the data — the whole instruction is
  // configurable, not just the system line). Empty string on either ⇒ use the built-in default.
  prompts: Record<PromptKind, { system: string; user: string }>;
  useLearnedRanker: boolean;
  hnUsername: string;
  // Opt-in (default off): fetch linked ARTICLE body text via free reader proxies
  // so real page content feeds ranking. Trades away the strict no-backend/privacy
  // guarantee — the URLs you read are sent to whichever free proxy answers.
  fetchArticleText: boolean;
  // Whether the first-run onboarding (pick interests) has been shown/dismissed.
  hasOnboarded: boolean;
  // Hide already-read stories from For You. The hidden set starts EMPTY and changes only when
  // the reader presses Refresh (lib/readSweep). Reading, navigating and reloading never alter it,
  // so nothing is yanked out from under the reader. Default on.
  hideReadInFeed: boolean;
  // Load story favicons from Google's public favicon service (default on). Turn OFF for
  // strict privacy — favicons then render as letter monograms only, so no story domains
  // are ever sent to that service.
  remoteFavicons: boolean;
  // Show the single best comment inline under each story card so you can read the standout
  // take without opening the thread (default ON). Toggled from the switch in the feed header
  // (not Settings). The comment is lazy-fetched when a card scrolls into view + cached; uses
  // HN's own CORS API (no privacy tradeoff like the reader proxy).
  showTopComments: boolean;
}
