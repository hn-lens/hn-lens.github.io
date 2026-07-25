import { useRef, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useModalBehavior } from '../hooks/useModalBehavior';
import { Braces, PencilLine, RotateCw, X } from 'lucide-react';
import type { ChatMessage } from '../lib/models/llm';
import type { PromptKind } from '../types';
import { usePrefs } from '../lib/prefs';
import { DEFAULT_PROMPTS, PROMPT_META } from '../lib/models/prompts';

// Transparency + control row shown under every AI summary (card TL;DR, thread summary, user
// persona), for BOTH local and cloud LLMs: refresh the cached output, view the EXACT request
// sent to the model, and EDIT THE PROMPT IN PLACE (both the system instruction and the
// user-message template) then re-run — without leaving the page.
export default function SummaryActions({
  request,
  onRefresh,
  refreshing,
  kind,
}: {
  request: ChatMessage[];
  onRefresh: () => void;
  refreshing?: boolean;
  kind: PromptKind;
}) {
  const [showReq, setShowReq] = useState(false);
  const [showEdit, setShowEdit] = useState(false);
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
      <button type="button" onClick={() => setShowEdit(true)} className="inline-flex items-center gap-1 hover:text-fg">
        <PencilLine className="size-3.5" /> Edit prompt
      </button>
      {/* One caveat, on every AI summary surface, because this row is the single shared component.
          Two measured reasons it belongs here rather than only in a doc: on ordinary threads the
          small on-device model attaches unsupported specifics to real stories (an invented product
          name, a figure that appears nowhere in its input), and comment text is untrusted input the
          model can be steered by — a comment imitating the summary's own format can put its words
          in the summary's mouth. Both are mitigated (untrusted text is fenced and defanged, an
          empty thread is never sent to the model) and neither is eliminated at this model size, so
          say so where the output is actually read. */}
      <span
        className="text-muted/80"
        title="AI summaries are generated from the story and its comments. Small models can state things the source doesn't support, and comment text can influence the result — check anything important against the discussion itself."
      >
        AI-generated · may be inaccurate
      </span>
      {showReq && <RequestDialog request={request} onClose={() => setShowReq(false)} />}
      {showEdit && (
        <PromptEditorDialog
          kind={kind}
          onClose={() => setShowEdit(false)}
          onSaved={() => {
            setShowEdit(false);
            onRefresh(); // re-run with the edited prompt so the effect is immediate
          }}
        />
      )}
    </div>
  );
}

export function RequestDialog({ request, onClose }: { request: ChatMessage[]; onClose: () => void }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalBehavior(dialogRef);
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
      ref={dialogRef}
      tabIndex={-1}
    >
      <div
        className="flex max-h-[85vh] w-full min-w-0 max-w-2xl flex-col rounded-xl border border-border bg-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 border-b border-border p-4">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold">Request sent to the model</h2>
            <p className="mt-0.5 text-xs text-subtle">The exact messages sent to the model.</p>
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

// In-place editor for BOTH prompt parts (system instruction + user-message template) of one
// summary type. "Save & re-run" persists to prefs and regenerates so the effect is immediate.
function PromptEditorDialog({ kind, onClose, onSaved }: { kind: PromptKind; onClose: () => void; onSaved: () => void }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalBehavior(dialogRef);
  const prompts = usePrefs((s) => s.prompts);
  const setPrefs = usePrefs((s) => s.set);
  const [system, setSystem] = useState(prompts[kind].system);
  const [user, setUser] = useState(prompts[kind].user);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const save = () => {
    setPrefs({ prompts: { ...prompts, [kind]: { system, user } } });
    onSaved();
  };

  return createPortal(
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Edit prompt"
      ref={dialogRef}
      tabIndex={-1}
    >
      <div className="flex max-h-[88vh] w-full min-w-0 max-w-2xl flex-col rounded-xl border border-border bg-surface shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between gap-3 border-b border-border p-4">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold">Edit the {PROMPT_META[kind].label} prompt</h2>
            <p className="mt-0.5 text-xs text-subtle">Both parts are sent to the model. Blank = use the built-in default. Save re-runs it.</p>
          </div>
          <button type="button" aria-label="Close" onClick={onClose} className="shrink-0 rounded-lg p-1 text-muted hover:bg-surface-2 hover:text-fg">
            <X className="size-4" />
          </button>
        </div>
        <div className="space-y-3 overflow-y-auto p-4">
          <label className="block space-y-1">
            <span className="text-xs font-medium text-muted">System instruction</span>
            <textarea
              rows={3}
              value={system}
              placeholder={DEFAULT_PROMPTS[kind].system}
              onChange={(e) => setSystem(e.target.value)}
              className="w-full resize-y rounded-lg border border-edge bg-surface-2 px-3 py-2 text-xs outline-none focus:border-accent"
            />
          </label>
          <label className="block space-y-1">
            <span className="text-xs font-medium text-muted">User-message template</span>
            <textarea
              rows={8}
              value={user}
              placeholder={DEFAULT_PROMPTS[kind].user}
              onChange={(e) => setUser(e.target.value)}
              className="w-full resize-y rounded-lg border border-edge bg-surface-2 px-3 py-2 font-mono text-[11px] leading-relaxed outline-none focus:border-accent"
            />
            <span className="block text-[11px] text-subtle">
              Placeholders (filled with the story data):{' '}
              {PROMPT_META[kind].placeholders.map((p) => (
                <code key={p} className="mr-1 rounded bg-surface-2 px-1 py-0.5">{p}</code>
              ))}
            </span>
          </label>
        </div>
        <div className="flex items-center justify-between gap-2 border-t border-border p-4">
          <button
            type="button"
            onClick={() => {
              setSystem('');
              setUser('');
            }}
            className="text-xs text-muted hover:text-fg"
          >
            Reset to defaults
          </button>
          <div className="flex items-center gap-2">
            <button type="button" onClick={onClose} className="rounded-lg border border-edge px-3 py-1.5 text-sm hover:bg-surface-2">
              Cancel
            </button>
            <button type="button" onClick={save} className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg hover:opacity-90">
              Save &amp; re-run
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
