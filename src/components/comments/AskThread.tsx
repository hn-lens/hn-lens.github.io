import { useState } from 'react';
import { Braces, MessageCircleQuestion } from 'lucide-react';
import { usePrefs } from '../../lib/prefs';
import { useModelStore } from '../../lib/models/registry';
import { mdLite } from '../../lib/html';
import { Spinner } from '../ui/primitives';
import { RequestDialog } from '../SummaryActions';
import type { ChatMessage } from '../../lib/models/llm';
import type { AlgoliaItem, HnItem } from '../../types';

// "Ask this discussion": grounded Q&A over a thread. The reader types a question and the
// selected model (local WebLLM or a BYO cloud provider) answers using ONLY the thread's top
// comments (+ cached article text when the reader proxy is on, + HN self-text) — attributing
// points to commenters and admitting when the thread doesn't cover it. Renders only when AI
// is active; the call site gates on the SAME aiSummaryActive as the summary block, so there
// is no redundant "set up AI" CTA here (ThreadSummary shows that when AI is off).
export default function AskThread({ story, tree }: { story: HnItem; tree: AlgoliaItem }) {
  const llmModel = usePrefs((s) => s.llmModel);
  const fetchArticleText = usePrefs((s) => s.fetchArticleText);
  const llmState = useModelStore((s) => s.llm);
  const [question, setQuestion] = useState('');
  const [asked, setAsked] = useState('');
  const [answer, setAnswer] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [request, setRequest] = useState<ChatMessage[]>([]);
  const [showReq, setShowReq] = useState(false);

  const run = async (q: string) => {
    const query = q.trim();
    if (!query || loading) return;
    setAsked(query);
    setLoading(true);
    setAnswer('');
    try {
      const { buildAskMessages, selectKeyComments, generate } = await import('../../lib/models/llm');
      // Cloud providers have big context windows — feed them far more of the thread.
      const isCloud = usePrefs.getState().llmProvider !== 'local';
      const comments = selectKeyComments(tree?.children ?? [], isCloud ? 40 : 16);
      let article = '';
      if (fetchArticleText) {
        const { getCachedArticle } = await import('../../lib/hn/article');
        article = (await getCachedArticle(story.id))?.text ?? '';
      }
      const messages = buildAskMessages({
        question: query,
        title: story.title ?? '',
        url: story.url,
        selftext: story.text,
        comments,
        article,
        large: isCloud,
      });
      setRequest(messages);
      const res = await generate(llmModel, messages, { onToken: setAnswer, maxTokens: 600, temperature: 0.3 });
      setAnswer(res);
    } catch (err) {
      setAnswer(`Couldn't answer: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <form
      className="rounded-xl border border-border bg-surface p-3"
      onSubmit={(e) => {
        e.preventDefault();
        void run(question);
      }}
    >
      <label htmlFor="ask-thread" className="mb-1.5 flex items-center gap-1.5 text-sm font-medium text-fg">
        <MessageCircleQuestion className="size-4 text-accent" /> Ask this discussion
      </label>
      <div className="flex gap-2">
        <input
          id="ask-thread"
          type="text"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="e.g. What are the main objections?"
          className="min-w-0 flex-1 rounded-lg border border-edge bg-surface-2 px-2.5 py-1.5 text-sm outline-none focus:border-accent"
        />
        <button
          type="submit"
          disabled={loading || !question.trim()}
          className="shrink-0 rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg hover:opacity-90 disabled:opacity-50"
        >
          Ask
        </button>
      </div>

      {llmState.status === 'loading' && (
        <div className="mt-2 flex items-center gap-2 text-xs text-muted">
          <Spinner /> {llmState.message}
        </div>
      )}

      {answer !== null && (
        <div className="mt-2 border-t border-border pt-2">
          <p className="mb-1 text-xs text-subtle">
            <span className="font-medium text-fg">Q:</span> {asked}
          </p>
          <div
            className="hn-html text-sm text-fg/90"
            dangerouslySetInnerHTML={{ __html: mdLite(answer || (loading ? '…' : '')) }}
          />
          {!loading && answer && (
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
              {request.length > 0 && (
                <button type="button" onClick={() => setShowReq(true)} className="inline-flex items-center gap-1 hover:text-fg">
                  <Braces className="size-3.5" /> View request
                </button>
              )}
              <span className="text-subtle">
                Answered from this thread&apos;s top comments{fetchArticleText ? ' + article text' : ''} — verify against the source.
              </span>
            </div>
          )}
        </div>
      )}
      {showReq && <RequestDialog request={request} onClose={() => setShowReq(false)} />}
    </form>
  );
}
