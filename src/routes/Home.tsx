import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ArrowLeft, ChevronDown, ChevronRight, SlidersHorizontal } from 'lucide-react';
import FeedTabs from '../components/layout/FeedTabs';
import Feed from '../components/feed/Feed';
import SearchResults from '../components/feed/SearchResults';
import Sidebar from '../components/layout/Sidebar';
import WeightSliders from '../components/ranking/WeightSliders';
import { usePrefs } from '../lib/prefs';
import { effectiveLayout } from '../lib/themes';
import type { FeedKind } from '../types';

const VALID: FeedKind[] = ['foryou', 'top', 'new', 'best', 'ask', 'show', 'job', 'read'];

export default function Home() {
  const [params, setParams] = useSearchParams();
  const defaultFeed = usePrefs((s) => s.defaultFeed);
  const layout = usePrefs((s) => s.layout);
  const themeName = usePrefs((s) => s.themeName);
  const [mobileTune, setMobileTune] = useState(false);
  // The `zen` layout hides the sidebar (where Tune lives) at ALL widths, so the
  // otherwise-mobile-only Tune disclosure must show on desktop too under zen.
  const sidebarHidden = effectiveLayout(themeName, layout) === 'zen';

  const q = (params.get('q') ?? '').trim();
  const feedParam = params.get('feed') as FeedKind | null;
  const feed: FeedKind = feedParam && VALID.includes(feedParam) ? feedParam : defaultFeed;

  const setFeed = (k: FeedKind) => {
    const p = new URLSearchParams(params);
    p.delete('q');
    if (k === defaultFeed) p.delete('feed');
    else p.set('feed', k);
    setParams(p);
  };

  return (
    <main className="app-main mx-auto max-w-6xl px-3 py-4 sm:px-4">
      <h1 className="sr-only">HN Lens — {q ? `Search: ${q}` : feed} feed</h1>
      <div className="app-grid grid gap-6 lg:grid-cols-[1fr_300px]">
        <div className="app-content min-w-0">
          {q ? (
            <button
              type="button"
              onClick={() => {
                const p = new URLSearchParams(params);
                p.delete('q');
                setParams(p);
              }}
              className="inline-flex items-center gap-1.5 text-sm font-medium text-accent hover:underline"
            >
              <ArrowLeft className="size-4" /> Back to feed
            </button>
          ) : (
            <FeedTabs value={feed} onSelect={setFeed} />
          )}

          {/* Mobile-only Tune ranking (desktop has it in the sidebar, which is hidden on
              small screens). Keeps personalization reachable on a phone. */}
          {!q && feed === 'foryou' && (
            <div className={sidebarHidden ? 'mt-3' : 'mt-3 lg:hidden'}>
              <button
                type="button"
                onClick={() => setMobileTune((v) => !v)}
                aria-expanded={mobileTune}
                className="flex w-full items-center gap-2 rounded-xl border border-border bg-surface px-3 py-2 text-sm font-semibold"
              >
                <SlidersHorizontal className="size-4 text-accent" /> Tune ranking
                {mobileTune ? (
                  <ChevronDown className="ml-auto size-4 text-subtle" />
                ) : (
                  <ChevronRight className="ml-auto size-4 text-subtle" />
                )}
              </button>
              {mobileTune && (
                <div className="mt-2 rounded-xl border border-border bg-surface p-4">
                  <WeightSliders />
                </div>
              )}
            </div>
          )}

          <div className="mt-4">
            {q ? (
              <SearchResults query={q} />
            ) : (
              <Feed kind={feed} showRank={feed === 'foryou'} />
            )}
          </div>
        </div>
        <Sidebar feed={feed} searching={!!q} />
      </div>
    </main>
  );
}
