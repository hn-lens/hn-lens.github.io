import { setLlmStatus, webgpuAvailable } from './registry';
import { CLOUD_PROVIDER_INFO, cloudGenerate, cloudModelFor } from './cloud';
import { DEFAULT_SYSTEM } from './prompts';
import { usePrefs } from '../prefs';
import { stripHtml } from '../html';
import { kvGet, kvSet } from '../db';
import { fetchArticleBody } from '../hn/article';
import { fetchItemTree } from '../hn/algolia';
import type { AlgoliaComment, AlgoliaItem, HnItem } from '../../types';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface MLCEngine {
  chat: {
    completions: {
      create(opts: {
        messages: ChatMessage[];
        temperature?: number;
        max_tokens?: number;
        frequency_penalty?: number;
        presence_penalty?: number;
        stream?: boolean;
      }): Promise<AsyncIterable<{ choices: Array<{ delta?: { content?: string } }> }>>;
    };
  };
}

interface InitProgress {
  progress?: number;
  text?: string;
}

/** The effective system instruction for a summary type — the user's override, or the default. */
export function systemFor(kind: 'tldr' | 'thread'): string {
  const custom = usePrefs.getState().systemPrompts?.[kind]?.trim();
  return custom || DEFAULT_SYSTEM[kind];
}

/** Turn WebLLM's raw progress text into plain user-facing copy (with the one-time size). */
function friendlyLoadMessage(raw: string): string {
  if (/fetch|download/i.test(raw)) return 'Downloading the local AI model — one-time (~1 GB)';
  if (/load|gpu|shader|finish|wasm|cache/i.test(raw)) return 'Loading the model into your browser';
  return 'Preparing the local AI model';
}

let enginePromise: Promise<MLCEngine> | null = null;
let loadedModel = '';

export async function getEngine(model: string): Promise<MLCEngine> {
  if (!webgpuAvailable()) {
    setLlmStatus({ status: 'unsupported', progress: 0, message: 'WebGPU not available in this browser' });
    throw new Error('WebGPU not available');
  }
  if (enginePromise && loadedModel === model) return enginePromise;
  loadedModel = model;
  setLlmStatus({ status: 'loading', progress: 0, message: 'Preparing the local AI model…' });

  enginePromise = (async () => {
    const webllm = await import('@mlc-ai/web-llm');
    // Gemma 3 ships with both context_window_size and sliding_window_size set,
    // which WebLLM rejects. Override to a plain 4096-token context window.
    const chatOpts = /gemma-?3/i.test(model)
      ? { context_window_size: 4096, sliding_window_size: -1 }
      : undefined;
    const engine = await webllm.CreateMLCEngine(
      model,
      {
        initProgressCallback: (r: InitProgress) => {
          setLlmStatus({
            status: 'loading',
            progress: r.progress ?? 0,
            // WebLLM's raw text ("Fetching param cache[3/22]…") is jargon; map it to
            // plain language + the one-time size so the first summarize isn't confusing.
            message: friendlyLoadMessage(r.text ?? ''),
          });
        },
      },
      chatOpts
    );
    setLlmStatus({ status: 'ready', progress: 1, message: 'Ready' });
    return engine as unknown as MLCEngine;
  })();

  try {
    return await enginePromise;
  } catch (err) {
    enginePromise = null;
    setLlmStatus({ status: 'error', progress: 0, message: String(err) });
    throw err;
  }
}

// WebLLM runs on a SINGLE GPU context — two concurrent generations deadlock the
// engine (the exact "stuck at Summarizing…" bug when a card TL;DR and the thread
// summary fire together). Serialize every generation through one promise chain so
// requests queue instead of colliding.
let genQueue: Promise<unknown> = Promise.resolve();

export async function generate(
  model: string,
  messages: ChatMessage[],
  opts?: { onToken?: (full: string) => void; temperature?: number; maxTokens?: number }
): Promise<string> {
  // Cloud provider (BYO key): call the provider's API directly — no WebGPU, no local
  // model, and no genQueue serialization (independent HTTP calls can run concurrently).
  const prefs = usePrefs.getState();
  if (prefs.llmProvider !== 'local') {
    const key = prefs.apiKeys?.[prefs.llmProvider]?.trim();
    const info = CLOUD_PROVIDER_INFO[prefs.llmProvider];
    if (!key) {
      setLlmStatus({ status: 'error', progress: 0, message: `No ${info.label} API key set` });
      throw new Error(`No ${info.label} API key set`);
    }
    setLlmStatus({ status: 'loading', progress: 0.6, message: `Asking ${info.label}…` });
    try {
      const cloudModel = cloudModelFor(prefs.llmProvider, prefs.cloudModels?.[prefs.llmProvider]);
      const text = await cloudGenerate(prefs.llmProvider, key, cloudModel, messages, {
        temperature: opts?.temperature,
        // Cloud models (esp. "thinking" ones like gemini-2.5-flash) spend output tokens on
        // reasoning, so the small local-model caps (80 for a TL;DR, 600 for a thread) would
        // be consumed by thinking and return empty/truncated text. Cloud has no GPU cost —
        // give it generous headroom so the actual answer isn't starved.
        maxTokens: Math.max(opts?.maxTokens ?? 640, 4096),
      });
      setLlmStatus({ status: 'ready', progress: 1, message: 'Ready' });
      opts?.onToken?.(text);
      return text;
    } catch (err) {
      setLlmStatus({ status: 'error', progress: 0, message: String(err instanceof Error ? err.message : err) });
      throw err;
    }
  }

  const run = genQueue.then(async () => {
    const engine = await getEngine(model);
    const stream = await engine.chat.completions.create({
      messages,
      temperature: opts?.temperature ?? 0.5,
      max_tokens: opts?.maxTokens ?? 640,
      frequency_penalty: 0.4, // curb repetition loops on small models
      presence_penalty: 0.3,
      stream: true,
    });
    let full = '';
    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta?.content ?? '';
      if (delta) {
        full += delta;
        opts?.onToken?.(full);
      }
    }
    return full;
  });
  // Keep the chain alive even if this run rejects, so one failure can't wedge the queue.
  genQueue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

export function flattenTopComments(children: AlgoliaComment[], max = 40): string[] {
  const out: string[] = [];
  const walk = (nodes: AlgoliaComment[], depth: number) => {
    for (const n of nodes) {
      if (out.length >= max) return;
      const text = stripHtml(n.text);
      if (text) out.push(`${'  '.repeat(Math.min(depth, 4))}- ${n.author ?? 'anon'}: ${text.slice(0, 400)}`);
      if (n.children.length) walk(n.children, depth + 1);
    }
  };
  walk(children, 0);
  return out;
}

function countDescendants(c: AlgoliaComment): number {
  return c.children.reduce((n, ch) => n + 1 + countDescendants(ch), 0);
}

/** Clean a comment: strip HTML, drop quoted lines, collapse whitespace. */
function cleanComment(html: string | null): string {
  const text = stripHtml(html);
  return text
    .split('\n')
    .filter((l) => !/^\s*>/.test(l))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface CommentInfo {
  author: string;
  text: string;
  replies: number;
  depth: number;
  created: number;
}

/** Flatten + clean all comments worth considering (text length >= minLen). */
export function collectComments(children: AlgoliaComment[], minLen = 40): CommentInfo[] {
  const acc: CommentInfo[] = [];
  const walk = (nodes: AlgoliaComment[], depth: number) => {
    for (const n of nodes) {
      const text = cleanComment(n.text);
      if (text.length >= minLen) {
        acc.push({
          author: n.author ?? 'anon',
          text,
          replies: countDescendants(n),
          depth,
          created: n.created_at_i,
        });
      }
      if (n.children.length) walk(n.children, depth + 1);
    }
  };
  walk(children, 0);
  return acc;
}

export function formatComments(list: CommentInfo[]): string[] {
  return list.map((c) => `- ${c.author}: ${c.text.slice(0, 700)}`);
}

const keyScore = (c: CommentInfo) =>
  Math.min(c.text.length, 700) + c.replies * 45 - c.depth * 18;

/**
 * Pick the most substantive comments (favouring length + replies, penalising
 * depth), cleaned and ordered chronologically. Denser, higher-signal input
 * helps small models produce coherent summaries.
 */
export function selectKeyComments(children: AlgoliaComment[], max = 14): string[] {
  const acc = collectComments(children ?? []); // tolerate a malformed/empty tree (no children)
  acc.sort((a, b) => keyScore(b) - keyScore(a));
  const top = acc.slice(0, max);
  top.sort((a, b) => a.created - b.created);
  return formatComments(top);
}

/** Build the exact messages (system + user) for a THREAD summary — the "full request". */
export function buildThreadMessages(opts: {
  title: string;
  url?: string;
  selftext?: string;
  comments: string[];
  article?: string;
}): ChatMessage[] {
  const commentBlock = opts.comments.join('\n').slice(0, 6000);
  const articleBlock = opts.article
    ? `\nARTICLE TEXT (extracted from the linked page):\n${opts.article.slice(0, 3500)}\n`
    : '';
  // System instruction (customizable) + the structured task prompt. No fill-in template
  // that weak models echo. Verified clean on Llama 3.2 1B.
  return [
    { role: 'system', content: systemFor('thread') },
    {
      role: 'user',
      content: `Summarize this Hacker News post and its discussion for someone who hasn't read it. Use ONLY the ARTICLE and COMMENTS provided below — do not invent facts, numbers, or claims. Be specific and concise.

TITLE: ${opts.title}
${opts.url ? `LINK: ${opts.url}` : ''}${opts.selftext ? `\nPOST: ${stripHtml(opts.selftext).slice(0, 800)}` : ''}
${articleBlock}
COMMENTS:
${commentBlock}

Reply using this markdown structure, filling in real content (do not repeat these instructions):
**Gist:** two sentences on what the ${opts.article ? 'article' : 'post'} is about and why it is being discussed.
**What commenters say:**
- a specific point or claim, naming the commenter who made it
- another specific point
- another specific point
- another specific point
**Disagreement:** one sentence on the main split, or write "Little disagreement."`,
    },
  ];
}

/** Build the exact messages (system + user) for a card TL;DR — the "full request". */
export function buildTldrMessages(opts: {
  title: string;
  selftext?: string;
  comments?: string[];
  article?: string;
}): ChatMessage[] {
  const ctx = [
    opts.article ? `Article: ${opts.article.slice(0, 1600)}` : '',
    opts.comments?.length
      ? `Top comments:\n${opts.comments.slice(0, 12).join('\n').slice(0, 1800)}`
      : !opts.article && opts.selftext
        ? `Post text: ${stripHtml(opts.selftext).slice(0, 1200)}`
        : '',
  ]
    .filter(Boolean)
    .join('\n');
  return [
    { role: 'system', content: systemFor('tldr') },
    {
      role: 'user',
      content: `Write a single-sentence TL;DR (max 30 words) of this Hacker News item using the context below. Output only the sentence, no preamble or markdown.

Title: ${opts.title}
${ctx}`,
    },
  ];
}

export async function summarizeThread(
  model: string,
  opts: {
    title: string;
    url?: string;
    selftext?: string;
    comments: string[];
    article?: string;
    onToken?: (full: string) => void;
  }
): Promise<string> {
  return generate(model, buildThreadMessages(opts), { onToken: opts.onToken, maxTokens: 600, temperature: 0.35 });
}

export async function tldr(
  model: string,
  opts: {
    title: string;
    selftext?: string;
    comments?: string[];
    article?: string;
    onToken?: (full: string) => void;
  }
): Promise<string> {
  return generate(model, buildTldrMessages(opts), { temperature: 0.2, maxTokens: 80, onToken: opts.onToken });
}

// ── Source-aware, cached summary orchestrator ───────────────────────────────
// Gathers what the summary is based on (linked-article text via the reader proxy
// when enabled + top comments + HN self-text), records it so the UI can show it,
// and caches the result in IndexedDB so re-opening is instant.
export interface SummarySources {
  articleWords: number; // words of extracted article text fed in (0 = none)
  comments: number; // number of comments fed in
  selftext: boolean; // HN self/post text included
  articleAvailable: boolean; // has a URL but the reader proxy is OFF (hint to enable)
  articleProxy: string; // NAME of the proxy that fetched the article text ('' if none)
}

export interface SummaryResult {
  text: string;
  sources: SummarySources;
  cached: boolean;
  articleText: string; // the exact extracted article text used (for "view sources")
  request: ChatMessage[]; // the EXACT messages sent to the LLM (system + user) — "view request"
}

// Bump when the prompt/gathering logic OR the cached value SHAPE changes, to
// invalidate stale entries. v4: cache value is now the full {text,sources,articleText}
// object (was a bare string) and the key no longer includes comment count.
// v5: sources gained `articleProxy` (which proxy fetched the article text).
// v6: prompts now include a (customizable) system message; cache stores the `request`,
//     and the key includes a fingerprint of the system instruction (changing it re-summarizes).
export const SUMMARY_PROMPT_VER = 6;

function wordCount(s: string): number {
  return s ? s.trim().split(/\s+/).filter(Boolean).length : 0;
}

// Tiny stable string fingerprint (for keying the cache on the system instruction).
function fingerprint(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

// The IndexedDB cache key for a summary. Deliberately does NOT depend on the
// comment tree — so a cache HIT can be served WITHOUT fetching the whole comment
// tree first (that pre-work is what made a "cached" re-click slow). It keys on the
// article INTENT (the toggle) + a fingerprint of the SYSTEM INSTRUCTION (so editing the
// system prompt re-summarizes), not the fetched result — all knowable up front. Freshness
// for grown threads / toggled article text comes from "Regenerate" + the article flag.
export function summaryCacheKey(
  kind: 'thread' | 'tldr',
  itemId: number,
  model: string,
  fetchArticle: boolean,
  system = ''
): string {
  return `sum:${kind}:${itemId}:${model}:v${SUMMARY_PROMPT_VER}:a${fetchArticle ? 1 : 0}:s${fingerprint(system)}`;
}

interface CachedSummary {
  text: string;
  sources: SummarySources;
  articleText: string;
  request: ChatMessage[];
}

export async function summarizeItem(
  model: string,
  kind: 'thread' | 'tldr',
  item: HnItem,
  opts: { tree?: AlgoliaItem | null; fetchArticle: boolean; force?: boolean; onToken?: (full: string) => void }
): Promise<SummaryResult> {
  // Cache check FIRST — a hit returns instantly with NO network (no comment tree,
  // no article fetch, no model). This is the fix for "cached but still slow".
  // Key by the EFFECTIVE model: for a cloud provider that's "<provider>/<model>", so
  // switching provider (local → Gemini → …) re-summarizes instead of serving a summary
  // made by a different backend.
  const prefs = usePrefs.getState();
  const effModel =
    prefs.llmProvider === 'local'
      ? model
      : `${prefs.llmProvider}/${cloudModelFor(prefs.llmProvider, prefs.cloudModels?.[prefs.llmProvider])}`;
  const system = systemFor(kind);
  const key = summaryCacheKey(kind, item.id, effModel, opts.fetchArticle, system);
  if (!opts.force) {
    const hit = await kvGet<CachedSummary>(key);
    if (hit && typeof hit === 'object' && hit.text) {
      opts.onToken?.(hit.text);
      return { text: hit.text, sources: hit.sources, cached: true, articleText: hit.articleText ?? '', request: hit.request ?? [] };
    }
  }

  // MISS: gather the inputs (fetch the comment tree only now, if not supplied).
  const tree = opts.tree ?? (await fetchItemTree(item.id));
  const comments = tree ? selectKeyComments(tree.children, kind === 'thread' ? 16 : 10) : [];
  let articleText = '';
  let articleProxy = '';
  if (opts.fetchArticle && item.url) {
    try {
      const fetched = await fetchArticleBody(item);
      articleText = fetched.text;
      articleProxy = fetched.proxy;
    } catch {
      articleText = '';
    }
  }
  const sources: SummarySources = {
    articleWords: wordCount(articleText),
    comments: comments.length,
    selftext: !!item.text,
    articleAvailable: !!item.url && !opts.fetchArticle,
    articleProxy,
  };

  const title = stripHtml(item.title ?? '');
  // Build the EXACT request (system + user messages) so the UI can show it, then send it.
  const request =
    kind === 'thread'
      ? buildThreadMessages({ title, url: item.url, selftext: item.text, comments, article: articleText })
      : buildTldrMessages({ title, selftext: item.text, comments, article: articleText });
  const text = await generate(model, request, {
    onToken: opts.onToken,
    maxTokens: kind === 'thread' ? 600 : 80,
    temperature: kind === 'thread' ? 0.35 : 0.2,
  });

  const result: CachedSummary = { text, sources, articleText, request };
  if (text && !/^Could not/i.test(text)) await kvSet(key, result);
  return { ...result, cached: false };
}

// A short human-readable "based on" line for the summary UI.
export function describeSources(s: SummarySources): string {
  const parts: string[] = [];
  if (s.articleWords > 0) parts.push(`article text (~${s.articleWords.toLocaleString()} words)`);
  if (s.comments > 0) parts.push(`${s.comments} top comment${s.comments === 1 ? '' : 's'}`);
  if (s.selftext) parts.push('the HN post text');
  if (!parts.length) return 'no readable content';
  return parts.join(' + ');
}
