import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { Braces, RotateCw, SlidersHorizontal, X } from 'lucide-react';
import type { ChatMessage } from '../lib/models/llm';

// Transparency + control row shown under every AI summary (card TL;DR + thread summary),
// for BOTH local and cloud LLMs: refresh the cached output, view the EXACT request sent to
// the model, and jump to Settings to edit the system instruction.
export default function SummaryActions({
  request,
  onRefresh,
  refreshing,
}: {
  request: ChatMessage[];
  onRefresh: () => void;
  refreshing?: boolean;
}) {
  const [showReq, setShowReq] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
      <button type="button" onClick={onRefresh} disabled={refreshing} className="inline-flex items-center gap-1 hover:text-fg disabled:opacity-60">
        <RotateCw className={refreshing ? 'size-3.5 animate-spin' : 'size-3.5'} /> Refresh
      </button>
      {request.length > 0 && (
        <button type="button" onClick={() => setShowReq(true)} className="inline-flex items-center gap-1 hover:text-fg">
          <Braces className="size-3.5" /> View request
        </button>
      )}
      <Link to="/settings?section=ai-prompts" className="inline-flex items-center gap-1 hover:text-fg">
        <SlidersHorizontal className="size-3.5" /> Edit system instruction
      </Link>
      {showReq && <RequestDialog request={request} onClose={() => setShowReq(false)} />}
    </div>
  );
}

function RequestDialog({ request, onClose }: { request: ChatMessage[]; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="LLM request"
    >
      <div
        className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-xl border border-border bg-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 border-b border-border p-4">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold">Request sent to the model</h2>
            <p className="mt-0.5 text-xs text-subtle">The exact messages this summary was generated from.</p>
          </div>
          <button type="button" aria-label="Close" onClick={onClose} className="shrink-0 rounded-lg p-1 text-muted hover:bg-surface-2 hover:text-fg">
            <X className="size-4" />
          </button>
        </div>
        <div className="space-y-3 overflow-y-auto p-4">
          {request.map((m, i) => (
            <div key={i}>
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-subtle">{m.role}</div>
              <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-surface-2 p-2.5 text-[11px] leading-relaxed text-fg/90">
                {m.content}
              </pre>
            </div>
          ))}
        </div>
      </div>
    </div>,
    document.body
  );
}
