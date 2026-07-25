import { useRef } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Link } from 'react-router-dom';
import { EyeOff, X } from 'lucide-react';
import { db } from '../lib/db';
import { unhideItem } from '../hooks/useLocalData';
import { stripHtml } from '../lib/html';
import { safeUrl } from '../lib/time';

// Per-item un-hide viewer: lists the stories you've hidden ("Not interested"), newest first,
// each with an Unhide button — so recovering ONE hidden story doesn't require clearing them
// all (the only prior option if you missed the Undo toast).
import { useModalBehavior } from '../hooks/useModalBehavior';

export default function HiddenDialog({ onClose }: { onClose: () => void }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalBehavior(dialogRef);
  const rows = useLiveQuery(
    async () => {
      const hidden = await db.hidden.orderBy('ts').reverse().toArray();
      const items = await db.items.bulkGet(hidden.map((h) => h.id));
      return hidden.map((h, i) => ({ id: h.id, item: items[i]?.item }));
    },
    [],
    [] as { id: number; item?: { title?: string; url?: string; by?: string } }[]
  );

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      ref={dialogRef}
      tabIndex={-1}
      aria-label="Hidden stories"
    >
      <div
        className="hidden-dialog flex max-h-[85vh] w-full min-w-0 max-w-2xl flex-col rounded-xl border border-border bg-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <EyeOff className="size-4" /> Hidden stories ({rows.length})
          </h2>
          <button type="button" onClick={onClose} aria-label="Close" className="text-subtle hover:text-fg">
            <X className="size-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {rows.length === 0 ? (
            <p className="text-sm text-muted">No hidden stories. Marking a story “Not interested” lists it here so you can undo it.</p>
          ) : (
            <ul className="space-y-1.5">
              {rows.map((r) => {
                const title = r.item ? stripHtml(r.item.title ?? '') || `Story #${r.id}` : `Story #${r.id}`;
                const href = r.item ? safeUrl(r.item.url) : '';
                return (
                  <li key={r.id} className="flex items-center gap-2 text-sm">
                    {href ? (
                      <a href={href} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate hover:text-accent">
                        {title}
                      </a>
                    ) : (
                      <Link to={`/item/${r.id}`} className="min-w-0 flex-1 truncate hover:text-accent">
                        {title}
                      </Link>
                    )}
                    <button
                      type="button"
                      onClick={() => unhideItem(r.id, r.item)}
                      className="shrink-0 rounded-md border border-edge px-2 py-1 text-xs text-muted hover:bg-surface-2 hover:text-fg"
                    >
                      Unhide
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
