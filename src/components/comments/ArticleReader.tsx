import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { FileText } from 'lucide-react';
import { fetchArticleBody, getCachedArticle } from '../../lib/hn/article';
import { usePrefs } from '../../lib/prefs';
import { safeUrl } from '../../lib/time';
import ListenButton from './ListenButton';
import type { HnItem } from '../../types';

// The "Article" side of the HackerWeb-style dual-view on /item: shows the linked
// article's extracted text in a clean reading column (via the opt-in reader proxy),
// with a one-tap fallback to the original and a "Listen" control (platform text-to-speech; the voice
// may be a network voice on some platforms, so no locality claim is made for it).
// Reuses the exact cache/proxy the summary path uses (`getCachedArticle` /
// `fetchArticleBody`), so nothing is fetched twice.
export default function ArticleReader({ item }: { item: HnItem }) {
  const fetchArticleText = usePrefs((s) => s.fetchArticleText);
  const href = safeUrl(item.url);
  const q = useQuery({
    queryKey: ['articleText', item.id],
    queryFn: () => getCachedArticle(item.id),
    enabled: !!href,
  });
  const text = q.data?.text ?? '';

  // On demand: if the reader proxy is enabled and the text isn't cached yet, fetch it.
  // On success fetchArticleBody caches + invalidates ['articleText', id] (so `q` refreshes
  // with the text); on all-proxies-fail it RESOLVES with empty text WITHOUT throwing. We
  // therefore track the attempt explicitly so we can show a definitive "couldn't fetch"
  // state instead of an endless "Fetching…". One attempt at a time; Retry re-arms it.
  const [fetchStatus, setFetchStatus] = useState<'idle' | 'fetching' | 'failed'>('idle');
  const [attempt, setAttempt] = useState(0); // bump to retry a failed fetch
  useEffect(() => {
    // `fetchStatus` is deliberately NOT a dependency: setting it to 'fetching' below would
    // otherwise re-run this effect, whose cleanup cancels the in-flight fetch, stranding it
    // on 'fetching' forever (the resolving `.then` would be suppressed). `attempt` re-arms it.
    if (!(fetchArticleText && href && q.isSuccess && !text)) return;
    let cancelled = false;
    setFetchStatus('fetching');
    fetchArticleBody(item)
      .then((r) => {
        if (!cancelled) setFetchStatus(r.text ? 'idle' : 'failed');
      })
      .catch(() => {
        if (!cancelled) setFetchStatus('failed');
      });
    return () => {
      cancelled = true;
    };
  }, [fetchArticleText, href, q.isSuccess, text, item, attempt]);
  const retryFetch = () => setAttempt((n) => n + 1);

  if (!href) return <p className="text-sm text-muted">This post has no linked article.</p>;

  // Opt-in gate: reading the article inline uses the (privacy-sensitive) reader proxy.
  if (!fetchArticleText && !text) {
    return (
      <div className="rounded-lg border border-border bg-surface p-4 text-sm text-muted">
        <p className="flex items-center gap-2 font-medium text-fg">
          <FileText className="size-4" /> Read the article here
        </p>
        <p className="mt-1">
          Reading the linked article inline needs the opt-in reader proxy — it fetches the page through a
          free third-party service (the one non-local feature).
        </p>
        <div className="mt-2 flex flex-wrap gap-3">
          <Link to="/settings?section=article-text" className="text-accent hover:underline">
            Enable in Settings →
          </Link>
          <a href={href} target="_blank" rel="noreferrer" className="text-accent hover:underline">
            Open the original ↗
          </a>
        </div>
      </div>
    );
  }

  if (!text) {
    // All reader proxies failed (rate-limited / down / unextractable) — a REALISTIC state
    // the AGENTS notes free proxies "rot". Show a definitive failure with Retry + the
    // original link, so it never looks like it's loading forever.
    if (fetchStatus === 'failed') {
      return (
        <div className="rounded-lg border border-border bg-surface p-4 text-sm text-muted">
          <p className="flex items-center gap-2 font-medium text-fg">
            <FileText className="size-4" /> Couldn&apos;t fetch the article
          </p>
          <p className="mt-1">
            The free reader services couldn&apos;t retrieve this page (they&apos;re rate-limited or down).
            Retry, or read it at the source.
          </p>
          <div className="mt-2 flex flex-wrap gap-3">
            <button type="button" onClick={retryFetch} className="text-accent hover:underline">
              Retry
            </button>
            <a href={href} target="_blank" rel="noreferrer" className="text-accent hover:underline">
              Open the original ↗
            </a>
          </div>
        </div>
      );
    }
    return (
      <p className="text-sm text-muted" role="status">
        Fetching the article text… if it can&apos;t be extracted,{' '}
        <a href={href} target="_blank" rel="noreferrer" className="text-accent hover:underline">
          open the original ↗
        </a>
        .
      </p>
    );
  }

  return (
    <div className="mx-auto max-w-prose space-y-3">
      <div className="flex justify-end">
        <ListenButton text={text} />
      </div>
      {/* rem so the reading-text-size setting actually scales the extracted article body — this is
          the longest-form reading surface in the app, and a px size ignores that axis entirely.
          0.9375rem === 15px at the md default, so default rendering is unchanged. */}
      {/* overflow-wrap:anywhere because this is EXTRACTED text from an arbitrary page: it routinely
          contains unbroken tokens (bare URLs, hashes, minified fragments) far wider than a phone.
          Without it a single token pushed the whole PAGE 453px wide at 320px — normal `break-words`
          only breaks at permitted points, which a long URL does not offer. */}
      <div className="space-y-3 text-[0.9375rem] leading-relaxed text-fg/90 [overflow-wrap:anywhere]">
        {text.split('\n\n').map((para, i) => (
          <p key={i}>{para}</p>
        ))}
      </div>
      <p className="border-t border-border pt-2 text-xs text-subtle">
        Extracted article text{q.data?.proxy ? ` · via ${q.data.proxy}` : ''} ·{' '}
        <a href={href} target="_blank" rel="noreferrer" className="text-accent hover:underline">
          read the original ↗
        </a>
      </p>
    </div>
  );
}
