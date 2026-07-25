import { useQuery, useQueryClient } from '@tanstack/react-query';
import { HardDrive, Loader2, RotateCw, Trash2 } from 'lucide-react';
import { getStorageReport, removeCachedModel, formatBytes } from '../lib/models/storage';
import type { CachedModel } from '../lib/models/storage';
import { useState } from 'react';

export default function CachedModels() {
  const qc = useQueryClient();
  const [busy, setBusy] = useState('');
  // staleTime 0 → always rescan on mount, so a just-downloaded model shows up.
  const q = useQuery({ queryKey: ['modelCache'], queryFn: getStorageReport, staleTime: 0 });
  const report = q.data;

  const remove = async (m: CachedModel) => {
    setBusy(m.id);
    try {
      await removeCachedModel(m);
      await qc.invalidateQueries({ queryKey: ['modelCache'] });
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="space-y-2.5">
      <div className="flex items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-xs text-muted">
          <HardDrive className="size-3.5" />
          {report && report.usage > 0
            ? `${formatBytes(report.usage)} of browser storage used${report.quota ? ` of ~${formatBytes(report.quota)}` : ''}`
            : 'Downloaded models are cached in your browser.'}
        </p>
        <button
          type="button"
          onClick={() => qc.invalidateQueries({ queryKey: ['modelCache'] })}
          className="inline-flex items-center gap-1 rounded-lg border border-edge px-2 py-1 text-xs text-muted hover:bg-surface-2"
        >
          <RotateCw className="size-3.5" /> Refresh
        </button>
      </div>

      {q.isLoading && (
        <p className="flex items-center gap-2 text-xs text-muted">
          <Loader2 className="size-3.5 animate-spin" /> Scanning cache…
        </p>
      )}

      {report && !report.supported && (
        <p className="text-xs text-subtle">Cache inspection isn&apos;t available in this context.</p>
      )}

      {report && report.supported && report.models.length === 0 && !q.isLoading && (
        <p className="text-xs text-subtle">
          No models cached yet. They download on first use (LLM ~0.9 GB, embeddings ~25–90 MB).
        </p>
      )}

      {report?.models.map((m) => (
        <div
          key={m.id}
          className="flex items-center justify-between gap-3 rounded-lg border border-border bg-surface-2 px-3 py-2"
        >
          <div className="min-w-0">
            <div className="truncate text-sm font-medium" title={m.id}>
              {m.label}
            </div>
            {/* `muted`: this is the model SIZE, read immediately before deciding to Remove — informative
                text on surface-2, not decoration. */}
            <div className="text-xs text-muted">
              {m.kind === 'llm' ? 'LLM' : 'Embeddings'} · {formatBytes(m.bytes)}
            </div>
          </div>
          <button
            type="button"
            onClick={() => remove(m)}
            disabled={busy === m.id}
            aria-label={`Remove cached model ${m.label}`}
            className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-edge px-2.5 py-1.5 text-xs text-red-800 hover:bg-red-500/10 disabled:opacity-60 dark:text-red-200"
          >
            {busy === m.id ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
            Remove
          </button>
        </div>
      ))}

      {report && report.otherBytes > 1024 * 1024 && (
        <p className="text-xs text-subtle">
          + {formatBytes(report.otherBytes)} of other cached data (app assets, etc.).
        </p>
      )}
    </div>
  );
}
