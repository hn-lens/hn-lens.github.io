import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, ChevronRight, Sparkles } from 'lucide-react';
import { hasCloudKey, usePrefs } from '../../lib/prefs';
import { useModelStore } from '../../lib/models/registry';
import { mdLite } from '../../lib/html';
import { safeUrl } from '../../lib/time';
import { Spinner } from '../ui/primitives';
import SummaryActions from '../SummaryActions';
import ListenButton from './ListenButton';
import type { ChatMessage, SummaryResult, SummarySources } from '../../lib/models/llm';
import type { AlgoliaItem, HnItem } from '../../types';

export default function ThreadSummary({ story, tree }: { story: HnItem; tree: AlgoliaItem }) {
  const llmEnabled = usePrefs((s) => s.llmEnabled);
  const showAiSummaries = usePrefs((s) => s.showAiSummaries);
  const llmModel = usePrefs((s) => s.llmModel);
  const fetchArticleText = usePrefs((s) => s.fetchArticleText);
  const llmProvider = usePrefs((s) => s.llmProvider);
  const apiKeys = usePrefs((s) => s.apiKeys);
  const llmState = useModelStore((s) => s.llm);
  const webgpu = useModelStore((s) => s.webgpu);
  // A cloud provider with a key runs the summary via HTTP — no WebGPU / local model.
  const cloud = hasCloudKey({ llmProvider, apiKeys });
  const [text, setText] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [sources, setSources] = useState<SummarySources | null>(null);
  const [sourceLine, setSourceLine] = useState('');
  const [articleText, setArticleText] = useState('');
  const [cached, setCached] = useState(false);
  const [showSources, setShowSources] = useState(false);
  const [request, setRequest] = useState<ChatMessage[]>([]);

  // The "Show AI summary controls in comments" setting hides all of this when off.
  if (!showAiSummaries) return null;

  // AI is off by default (local models are a large opt-in download). Rather than render
  // nothing — which made the marquee summary feature invisible on long threads — surface
  // a compact CTA so a reader can discover + enable it (local OR a cloud API key).
  if (!cloud && !llmEnabled) {
    return (
      <div className="rounded-xl border border-border bg-surface-2 p-3 text-xs text-muted">
        <span className="inline-flex items-center gap-1.5 font-medium text-fg">
          <Sparkles className="size-3.5 text-accent" /> Summarize or ask about this discussion
        </span>{' '}
        with a local on-device model, or your own cloud API key.{' '}
        <Link to="/settings?section=ai-summaries" className="font-medium text-accent hover:underline">
          Set up AI
        </Link>{' '}
        — local runs entirely in your browser; cloud sends content to the provider you choose.
      </div>
    );
  }

  // Only the LOCAL model needs WebGPU; a cloud provider works without it.
  if (!cloud && webgpu === 'unavailable') {
    return (
      <div className="rounded-xl border border-border bg-surface-2 p-3 text-xs text-muted">
        Local AI summaries need WebGPU (recent Chrome/Edge). This browser or GPU can&apos;t run it —{' '}
        <Link to="/settings?section=ai-summaries" className="text-accent hover:underline">
          use a cloud API key instead
        </Link>
        .
      </div>
    );
  }

  const run = async (force = false) => {
    setLoading(true);
    setText('');
    try {
      const { summarizeItem, describeSources, describeProvenance } = await import('../../lib/models/llm');
      const res: SummaryResult = await summarizeItem(llmModel, 'thread', story, {
        tree,
        fetchArticle: fetchArticleText,
        force,
        onToken: setText,
      });
      setText(res.text);
      setSources(res.sources);
      // Include WHICH backend produced it — the reader proxy was already disclosed here while the
      // on-device-vs-cloud fact, which matters more, was not. One shared describer, no local copy.
      {
        const prov = describeProvenance(res.sources);
        setSourceLine(describeSources(res.sources) + (prov ? ` · ${prov}` : ''));
      }
      setArticleText(res.articleText);
      setCached(res.cached);
      setRequest(res.request);
    } catch (err) {
      setText(`Could not summarize: ${err instanceof Error ? err.message : String(err)}`);
      setSources(null);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="rounded-xl border border-accent/30 bg-accent/5 p-3">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 text-sm font-medium text-accent">
          <Sparkles className="size-4" /> AI discussion summary
        </span>
        {text === null && (
          <button
            type="button"
            onClick={() => run(false)}
            className="rounded-lg bg-accent px-2.5 py-1 text-xs font-medium text-accent-fg hover:opacity-90"
          >
            Summarize
          </button>
        )}
      </div>

      {llmState.status === 'loading' && (
        <div className="mb-2">
          <div className="mb-1 flex items-center gap-2 text-xs text-muted">
            <Spinner /> {llmState.message}
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
            <div
              className="h-full bg-accent transition-all"
              style={{ width: `${Math.round(llmState.progress * 100)}%` }}
            />
          </div>
        </div>
      )}

      {text !== null && (
        <div className="hn-html text-sm text-fg/90" dangerouslySetInnerHTML={{ __html: mdLite(text || (loading ? '…' : '')) }} />
      )}

      {sources && !loading && (
        <div className="mt-2 border-t border-accent/20 pt-2 text-xs text-muted">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span>
              {/* `sourceLine` already ends with the provenance (backend + proxy) via
                  describeProvenance. This hand-rolled suffix was left behind when the card path was
                  refactored to the shared describer, so the line read "… · article via AllOrigins ·
                  via AllOrigins". */}
              Based on <span className="font-medium text-fg">{sourceLine}</span>
              {cached && <span className="ml-1 text-muted">· cached</span>}
            </span>
            {articleText && (
              <button
                type="button"
                onClick={() => setShowSources((v) => !v)}
                className="inline-flex items-center gap-0.5 text-accent hover:underline"
              >
                {showSources ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
                view extracted article text
              </button>
            )}
          </div>
          {sources.articleAvailable && (
            <p className="mt-1 text-muted">
              Only comments were used.{' '}
              <Link to="/settings?section=ai-summaries" className="text-accent hover:underline">
                Enable “Fetch linked-article text”
              </Link>{' '}
              for article-based summaries.
            </p>
          )}
          {showSources && articleText && (
            <div className="mt-1.5">
              {safeUrl(story.url) && (
                <p className="mb-1 text-[11px] text-muted">
                  Extracted from{' '}
                  <a
                    href={safeUrl(story.url)}
                    target="_blank"
                    rel="noreferrer"
                    className="break-all text-accent hover:underline"
                  >
                    {story.url}
                  </a>
                  {sources.articleProxy && <> · fetched via {sources.articleProxy}</>}
                </p>
              )}
              {/* rem, like the other two renderings of this same extracted text — it is reading
                  content, so the reading-size setting must scale it. 0.6875rem === 11px by default. */}
              <p className="max-h-48 overflow-auto whitespace-pre-wrap rounded-lg bg-surface-2 p-2 text-[0.6875rem] leading-relaxed text-muted">
                {articleText}
              </p>
            </div>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
            <SummaryActions request={request} onRefresh={() => run(true)} refreshing={loading} kind="thread" />
            <ListenButton text={text ?? ''} className="inline-flex items-center gap-1 text-xs text-muted hover:text-fg" />
          </div>
        </div>
      )}
    </div>
  );
}
