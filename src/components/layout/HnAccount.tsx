import { useState } from 'react';
import type { FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Check, CircleUser, DownloadCloud, Loader2, RefreshCw, Star } from 'lucide-react';
import { usePrefs } from '../../lib/prefs';
import { toast } from '../../hooks/useToast';
import { cn } from '../../lib/cn';
import { clearHnImport, countHnImport, fetchHnActivity, importHnHistory } from '../../lib/hn/userHistory';

export default function HnAccount() {
  const username = usePrefs((s) => s.hnUsername);
  const setPrefs = usePrefs((s) => s.set);
  const followedDomains = usePrefs((s) => s.followedDomains);
  const toggleFollowDomain = usePrefs((s) => s.toggleFollowDomain);
  const qc = useQueryClient();

  const [draft, setDraft] = useState('');
  const [importing, setImporting] = useState(false);
  const [importMsg, setImportMsg] = useState('');
  const [nameError, setNameError] = useState('');

  const activityQ = useQuery({
    queryKey: ['hnActivity', username],
    queryFn: () => fetchHnActivity(username),
    enabled: !!username,
    staleTime: 300_000,
  });

  const importedQ = useQuery({
    queryKey: ['hnImport', username],
    queryFn: countHnImport,
    enabled: !!username,
    staleTime: 5_000,
  });
  const importedCount = importedQ.data ?? 0;

  const connect = (e: FormEvent) => {
    e.preventDefault();
    const name = draft.trim();
    if (!name) return;
    // HN usernames are 2–15 chars: letters, digits, dash, underscore.
    if (!/^[a-zA-Z0-9_-]{2,15}$/.test(name)) {
      setNameError('Invalid HN username (2–15 chars: letters, digits, - or _).');
      return;
    }
    setNameError('');
    setPrefs({ hnUsername: name });
  };

  const disconnect = async () => {
    await clearHnImport();
    setPrefs({ hnUsername: '' });
    setImportMsg('');
    await qc.invalidateQueries();
  };

  const doImport = async () => {
    setImporting(true);
    setImportMsg('');
    try {
      const res = await importHnHistory(username);
      setImportMsg(`Imported ${res.stories} posts + ${res.commentedStories} discussions as signals.`);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['affinities'] }),
        qc.invalidateQueries({ queryKey: ['eventCount'] }),
        qc.invalidateQueries({ queryKey: ['hnImport'] }),
        qc.invalidateQueries({ queryKey: ['ranker'] }),
        qc.invalidateQueries({ queryKey: ['pool', 'foryou'] }),
      ]);
    } catch (err) {
      setImportMsg(`Import failed: ${String(err)}`);
    } finally {
      setImporting(false);
    }
  };

  if (!username) {
    return (
      <section className="rounded-xl border border-border bg-surface p-4">
        <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold">
          <CircleUser className="size-4 text-subtle" /> Your HN account
        </h2>
        <p className="mb-2 text-xs text-muted">
          Connect your Hacker News username to fold your posts &amp; comments into your
          personalization — and to track your activity here.
        </p>
        <form onSubmit={connect} className="flex gap-2">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="HN username"
            className="min-w-0 flex-1 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-sm outline-none focus:border-accent"
          />
          <button
            type="submit"
            className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg hover:opacity-90"
          >
            Connect
          </button>
        </form>
        {nameError && <p className="mt-1.5 text-xs text-red-600 dark:text-red-400">{nameError}</p>}
      </section>
    );
  }

  const a = activityQ.data;

  return (
    <section className="rounded-xl border border-border bg-surface p-4">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <CircleUser className="size-4 text-accent" />
          <a
            href={`https://news.ycombinator.com/user?id=${encodeURIComponent(username)}`}
            target="_blank"
            rel="noreferrer"
            className="hover:text-accent hover:underline"
          >
            {username}
          </a>
        </h2>
        <button
          type="button"
          onClick={disconnect}
          className="text-xs text-subtle hover:text-fg"
        >
          Disconnect
        </button>
      </div>

      {activityQ.isLoading && <p className="text-xs text-muted">Loading activity…</p>}
      {activityQ.isFetched && !a && (
        <p className="text-xs text-muted">No public activity found for “{username}”.</p>
      )}

      {a && (
        <>
          <div className="grid grid-cols-3 gap-2 text-center">
            <Stat label="karma" value={a.karma} />
            <Stat label="posts" value={a.storyCount} />
            <Stat label="comments" value={a.commentCount} />
          </div>

          {a.topDomains.length > 0 && (
            <div className="mt-3">
              <p className="mb-1 text-xs text-subtle">You post most from · tap to follow</p>
              <div className="flex flex-wrap gap-1.5">
                {a.topDomains.map((d) => {
                  const followed = followedDomains.includes(d);
                  return (
                    <button
                      key={d}
                      type="button"
                      onClick={() => {
                        toggleFollowDomain(d);
                        toast(
                          followed
                            ? { message: `Unfollowed ${d}` }
                            : { message: `Following ${d}`, actionLabel: 'Undo', onAction: () => toggleFollowDomain(d) }
                        );
                      }}
                      title={followed ? `Unfollow ${d}` : `Follow ${d}`}
                      className={cn(
                        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs',
                        followed
                          ? 'bg-accent/15 text-accent'
                          : 'bg-surface-2 text-muted hover:bg-accent/10 hover:text-accent'
                      )}
                    >
                      {followed && <Star className="size-3 fill-accent text-accent" />}
                      {d}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {a.recentStories.length > 0 && (
            <div className="mt-3">
              <p className="mb-1 text-xs text-subtle">Recent posts</p>
              <ul className="space-y-1">
                {a.recentStories.map((s) => (
                  <li key={s.id}>
                    <Link
                      to={`/item/${s.id}`}
                      className="line-clamp-1 text-xs text-muted hover:text-accent"
                      title={s.title}
                    >
                      {s.title}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <button
            type="button"
            onClick={doImport}
            disabled={importing}
            className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg border border-accent/40 px-3 py-2 text-xs font-medium text-accent hover:bg-accent/10 disabled:opacity-60"
          >
            {importing ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : importedCount > 0 ? (
              <RefreshCw className="size-3.5" />
            ) : (
              <DownloadCloud className="size-3.5" />
            )}
            {importing
              ? 'Importing…'
              : importedCount > 0
                ? 'Re-import to sync new activity'
                : 'Use my history to personalize'}
          </button>
          {importMsg ? (
            <p className="mt-1.5 text-xs text-muted">{importMsg}</p>
          ) : (
            importedCount > 0 && (
              <p className="mt-1.5 flex items-center gap-1 text-xs text-up">
                <Check className="size-3.5" /> {importedCount.toLocaleString()} of your posts &amp; discussions are
                personalizing your feed.
              </p>
            )
          )}
        </>
      )}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg bg-surface-2 py-1.5">
      <div className="text-sm font-semibold tabular-nums">{value.toLocaleString()}</div>
      <div className="text-[10px] uppercase tracking-wide text-subtle">{label}</div>
    </div>
  );
}
