import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, RotateCw, Trash2 } from 'lucide-react';
import { getDataBreakdown, clearDataCategory } from '../lib/dataUsage';
import type { DataCategory, DataCategoryId } from '../lib/dataUsage';
import { formatBytes } from '../lib/models/storage';

export default function DataManager() {
  const qc = useQueryClient();
  const [busy, setBusy] = useState<DataCategoryId | ''>('');
  const q = useQuery({ queryKey: ['dataBreakdown'], queryFn: getDataBreakdown, staleTime: 0 });
  const cats = q.data ?? [];

  const remove = async (c: DataCategory) => {
    if (!confirm(`Delete ${c.count.toLocaleString()} ${c.unit} — "${c.label}"? This can't be undone.`)) return;
    setBusy(c.id);
    try {
      await clearDataCategory(c.id);
      await qc.invalidateQueries({ queryKey: ['dataBreakdown'] });
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="space-y-2.5">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted">Delete individual kinds of local data (models are managed above).</p>
        <button
          type="button"
          onClick={() => qc.invalidateQueries({ queryKey: ['dataBreakdown'] })}
          className="inline-flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-xs text-muted hover:bg-surface-2"
        >
          <RotateCw className="size-3.5" /> Refresh
        </button>
      </div>

      {q.isLoading && (
        <p className="flex items-center gap-2 text-xs text-muted">
          <Loader2 className="size-3.5 animate-spin" /> Scanning local data…
        </p>
      )}

      {cats.map((c) => {
        const empty = c.count === 0;
        return (
          <div
            key={c.id}
            className="flex items-center justify-between gap-3 rounded-lg border border-border bg-surface-2 px-3 py-2"
          >
            <div className="min-w-0">
              <div className="text-sm font-medium">{c.label}</div>
              <div className="text-xs text-subtle">
                {empty ? 'none' : `${c.count.toLocaleString()} ${c.unit}`}
                {c.bytes > 0 ? ` · ${formatBytes(c.bytes)}` : ''} — {c.description}
              </div>
            </div>
            <button
              type="button"
              onClick={() => remove(c)}
              disabled={empty || busy === c.id}
              aria-label={`Delete ${c.label}`}
              className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-red-500/40 px-2.5 py-1.5 text-xs text-red-700 hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-40 dark:text-red-300"
            >
              {busy === c.id ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
              Delete
            </button>
          </div>
        );
      })}
    </div>
  );
}
