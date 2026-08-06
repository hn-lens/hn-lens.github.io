import { useState } from 'react';
import { Braces, MessageCircleQuestion } from 'lucide-react';
import { usePrefs, usesLlama } from '../../lib/prefs';
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
  const llama = usePrefs((s) => usesLlama(s));
  const fetchArticleText = usePrefs((s) => s.fetchArticleText);
  const llmState = useModelStore((s) => s.llm);
  const [question, setQuestion] = useState('');
  const [asked, setAsked] = useState('');
  const [answer, setAnswer] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [request, setRequest] = useState<ChatMessage[]>([]);
  const [showReq, setShowReq] = useState(false);
  // What actually reached the model. The pref only says whether article text was WANTED; whether
  // any was cached and sent is a different question, and the provenance line must state the latter.
  const [sent, setSent] = useState<{ comments: number; article: boolean; sent: boolean }>({ comments: 0, article: false, sent: false });
  // The generation THREW (a cloud rate-limit / bad key / 5xx). `sent.sent` only says a send was
  // attempted (not a refusal), so it stays true on an error — the provenance/caveat/attribution must
  // ALSO be off when the model produced no text, not just when the thread was too thin.
  const [errored, setErrored] = useState(false);

  const run = async (q: string) => {
    const query = q.trim();
    if (!query || loading) return;
    setAsked(query);
    setLoading(true);
    setAnswer('');
    setErrored(false);
    try {
      // MUST go through `askThread`, never `generate` directly: the thin-input refusal lives in that
      // wrapper, and calling the raw primitive here is how this surface once answered a zero-comment
      // thread by inventing the commenters.
      // `scripts/aiguardtest.mjs` fails the build if a component reaches for `generate` again.
      const { buildAskMessages, selectKeyComments, askThread } = await import('../../lib/models/llm');
      // Cloud providers have big context windows — feed them far more of the thread.
      const isCloud = usePrefs.getState().llmProvider !== 'local';
      const comments = selectKeyComments(tree?.children ?? [], isCloud ? 40 : 16);
      let article = '';
      if (fetchArticleText) {
        const { getCachedArticle, articleLooksRelevant } = await import('../../lib/hn/article');
        const text = (await getCachedArticle(story.id))?.text ?? '';
        // Drop an off-topic body (cookie-wall/paywall/unrelated page) so it isn't fed to the model
        // nor labelled "+ article text" — matches the guard the summary path applies.
        article = text && articleLooksRelevant(story.title ?? '', text) ? text : '';
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
      const { commentsForPrompt, tooThinToAnswer } = await import('../../lib/models/llm');
      // A thin thread is refused inside askThread without a model call, so nothing was sent and the
      // provenance line and request viewer must not appear.
      const willSend = !tooThinToAnswer({ comments, article, selftext: story.text });
      setSent({
        comments: willSend ? commentsForPrompt('ask', { comments, article, selftext: story.text, large: isCloud }).length : 0,
        article: willSend && !!article,
        sent: willSend,
      });
      const res = await askThread(llmModel, {
        question: query,
        title: story.title ?? '',
        url: story.url,
        selftext: story.text,
        comments,
        article,
        large: isCloud,
        onToken: setAnswer,
      });
      setAnswer(res);
    } catch (err) {
      setErrored(true);
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
          className="shrink-0 rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg hover:opacity-95 disabled:opacity-50"
        >
          {/* "Send", not "Ask": the toolbar tool that OPENS this panel is called Ask, and two
              controls with the same accessible name on one page is ambiguous both for a screen
              reader and for anyone told to "press Ask". */}
          Send
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
            className="hn-html md-body text-sm text-fg/90"
            dangerouslySetInnerHTML={{ __html: mdLite(answer || (loading ? '…' : '')) }}
          />
          {/* The provenance/caveat/attribution row is shown ONLY when a model actually produced this
              answer: sent.sent (not a thin-thread refusal) AND !errored (the call didn't throw). Over a
              refusal or a generation error the text is the app's own message, not model output, so none
              of this — including the "AI-generated" caveat and the Llama attribution — may appear. */}
          {!loading && answer && sent.sent && !errored && (
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
              {request.length > 0 && (
                <button type="button" onClick={() => setShowReq(true)} className="inline-flex items-center gap-1 hover:text-fg">
                  <Braces className="size-3.5" /> View request
                </button>
              )}
              <span className="text-muted">
                Answered from {sent.comments} top comment{sent.comments === 1 ? '' : 's'}
                {sent.article ? ' + article text' : ''} — verify against the source.
              </span>
              <span
                className="text-muted"
                title="Answers are written by a language model — a small on-device one unless you configured a cloud provider. It can state things the thread doesn't support, and it can attribute a view to a named commenter who never expressed it. Treat every claim, quote and attribution as unverified."
              >
                AI-generated · may be inaccurate, including who said what
              </span>
              {/* Same Llama attribution as SummaryActions — only over real on-device model output. */}
              {llama && (
                <a
                  href="https://github.com/meta-llama/llama-models/blob/main/models/llama3_2/LICENSE"
                  target="_blank"
                  rel="noreferrer"
                  className="text-muted hover:text-fg"
                  title="This answer was produced on your device by Meta's Llama 3.2, used under the Llama 3.2 Community License."
                >
                  · Built with Llama
                </a>
              )}
            </div>
          )}
        </div>
      )}
      {showReq && <RequestDialog request={request} onClose={() => setShowReq(false)} />}
    </form>
  );
}
