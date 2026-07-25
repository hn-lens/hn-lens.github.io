import { useEffect, useState, useRef} from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { X } from 'lucide-react';
import { db } from '../lib/db';
import { timeAgo } from '../lib/time';
import type { InteractionEvent, InteractionType } from '../types';

// Human labels for the raw event types stored in db.events.
//
// EXHAUSTIVE Record<InteractionType, …> rather than Record<string, …>: as a loose string map it
// silently lagged the union, so this transparency dialog showed raw identifiers ("unsave · 1",
// "unhide · 1") to anyone who un-saved a story or hit Undo on "Not interested" — the classic gap
// where the forward action is listed and its reversal is forgotten. It also listed `search`, which
// is never emitted. Exhaustive typing means a new InteractionType cannot compile without a label.
const TYPE_LABEL: Record<InteractionType, string> = {
  open_link: 'Opened article',
  open_comments: 'Opened discussion',
  impression: 'Seen in feed',
  save: 'Saved',
  unsave: 'Removed from saved',
  hide: 'Not interested',
  unhide: 'Undid “not interested”',
  follow_domain: 'Followed site',
  unfollow_domain: 'Unfollowed site',
  follow_user: 'Followed user',
  unfollow_user: 'Unfollowed user',
  upvote_out: 'Opened on HN',
  summarize: 'Summarized',
  dwell: 'Read time',
  search: 'Searched',
};

/** Label for a stored event type. Rows come from IndexedDB, so the value is `string` at runtime and
 * could predate a type rename — fall back to the raw id rather than rendering "undefined". */
function labelFor(t: string): string {
  return TYPE_LABEL[t as InteractionType] ?? t;
}

// The count in Settings ("N signals recorded") is data ABOUT the user — clicking it should
// show exactly what those signals are, not be a dead end. This lists the real db.events rows
// (type, item, domain/author, when) so nothing about the local profile is hidden.
import { useModalBehavior } from '../hooks/useModalBehavior';

export default function SignalsDialog({ onClose }: { onClose: () => void }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalBehavior(dialogRef);
  const [events, setEvents] = useState<InteractionEvent[] | null>(null);
  const [counts, setCounts] = useState<Array<[string, number]>>([]);
  const [total, setTotal] = useState(0);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    void (async () => {
      setTotal(await db.events.count());
      const rows = await db.events.orderBy('ts').reverse().limit(500).toArray();
      const byType = new Map<string, number>();
      for (const e of rows) byType.set(e.type, (byType.get(e.type) ?? 0) + 1);
      setCounts([...byType.entries()].sort((a, b) => b[1] - a[1]));
      setEvents(rows);
    })();
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      ref={dialogRef}
      tabIndex={-1}
      aria-label="Recorded signals"
    >
      <div
        className="flex max-h-[85vh] w-full min-w-0 max-w-2xl flex-col rounded-xl border border-border bg-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b border-border p-4">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold">Signals recorded locally</h2>
            <p className="mt-0.5 text-xs text-subtle">
              Everything HN Lens has learned from your activity — stored only in this browser. Delete these (by
              type, or all) in{' '}
              <Link to="/settings?section=data" onClick={onClose} className="text-accent hover:underline">
                Settings → Data
              </Link>
              .
            </p>
          </div>
          <button type="button" aria-label="Close" onClick={onClose} className="shrink-0 rounded-lg p-1 text-muted hover:bg-surface-2 hover:text-fg">
            <X className="size-4" />
          </button>
        </div>

        {counts.length > 0 && (
          <div className="flex flex-wrap gap-1.5 border-b border-border p-3">
            {counts.map(([t, n]) => (
              <span key={t} className="rounded-full bg-surface-2 px-2 py-0.5 text-xs text-muted">
                {labelFor(t)} · <span className="font-medium text-fg">{n}</span>
              </span>
            ))}
          </div>
        )}

        <div className="overflow-y-auto p-2">
          {events === null && <p className="p-3 text-sm text-muted">Loading…</p>}
          {events !== null && events.length === 0 && <p className="p-3 text-sm text-muted">No signals recorded yet.</p>}
          {events?.map((e, i) => (
            <div key={e.id ?? i} className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs hover:bg-surface-2">
              {/* The label may shrink; the PAYLOAD may not. A fixed w-28 (126px at Large) plus a
                  shrink-0 time column left the middle absorbing the whole squeeze — at 320px only
                  48px of a needed 197px remained, so the item, domain, @author and dwell that are
                  the dialog's entire reason to exist were truncated away on every phone. */}
              <span className="w-20 min-w-0 shrink truncate font-medium text-fg sm:w-28 sm:shrink-0">{labelFor(e.type)}</span>
              <span className="min-w-0 flex-1 truncate text-muted">
                {e.itemId ? (
                  <Link to={`/item/${e.itemId}`} onClick={onClose} className="text-accent hover:underline">
                    #{e.itemId}
                  </Link>
                ) : (
                  <span className="text-subtle">—</span>
                )}
                {e.domain && <span className="ml-1.5 text-subtle">{e.domain}</span>}
                {e.author && <span className="ml-1.5 text-subtle">@{e.author}</span>}
                {e.type === 'dwell' && typeof e.value === 'number' && (
                  <span className="ml-1.5 text-subtle">{Math.round(e.value / 1000)}s</span>
                )}
                {e.meta?.source === 'hn_import' ? <span className="ml-1.5 text-subtle">(imported)</span> : null}
              </span>
              <span className="shrink-0 text-subtle">{timeAgo(Math.floor(e.ts / 1000))}</span>
            </div>
          ))}
          {events !== null && total > events.length && (
            <p className="p-3 text-xs text-subtle">Showing the {events.length.toLocaleString()} most recent of {total.toLocaleString()} signals.</p>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
