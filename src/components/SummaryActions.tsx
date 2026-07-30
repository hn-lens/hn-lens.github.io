import { useRef, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useModalBehavior } from '../hooks/useModalBehavior';
import { Braces, PencilLine, RotateCw, X } from 'lucide-react';
import type { ChatMessage } from '../lib/models/llm';
import type { PromptKind } from '../types';
import { usePrefs, usesLlama } from '../lib/prefs';
import { AutoTextarea } from './ui/controls';
import { DEFAULT_PROMPTS, PROMPT_META, effectivePromptPart, normalizePromptOverride } from '../lib/models/prompts';

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
  // Only when a model ACTUALLY ran. A thin-input refusal returns an empty `request` (no model call),
  // so keying the attribution off "a local provider is selected" alone printed "Built with Llama"
  // over text no Llama produced — a false attribution.
  const ranModel = request.length > 0;
  const llama = usePrefs((s) => usesLlama(s)) && ranModel;
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
          The app guarantees what goes IN — untrusted text is fenced and defanged, thin input is not
          sent, and the "based on" line counts what actually reached the model. It makes no
          guarantee about what comes OUT, including attribution: a small model can state
          unsupported specifics and can put a view in a named commenter's mouth. Say so where the
          output is actually read. Gated on `ranModel`: over a thin-input REFUSAL nothing was sent
          and the text is the app's own message, not AI output, so the caveat must stay off it. */}
      {ranModel && (
        <span
          // Full `--muted`, not `/80`. Dimming it voided the AA guarantee of the very token chosen for
          // legibility (sub-AA in 40 of 62 cells on cards), and made the accuracy caveat FAINTER than
          // the action labels beside it — the one line here that must not be easy to miss.
          className="text-muted"
          title="AI summaries are written by a language model — a small on-device one unless you configured a cloud provider. It can state things the source doesn't support, and it can attribute a view to a named commenter who never expressed it. Treat every claim, quote and attribution as unverified, and check anything important against the discussion itself."
        >
          AI-generated · may be inaccurate, including who said what
        </span>
      )}
      {/* Attribution required by the Llama 3.2 Community License, shown where Llama Materials are
          actually in use rather than as a global banner — most of this app has nothing to do with
          Llama, and the licence accepts any one of website / user interface / about page / product
          documentation (the README carries it too). Conditional via `usesLlama` so it never appears
          over cloud-provider output, which would be a false attribution. */}
      {llama && (
        <a
          href="https://github.com/meta-llama/llama-models/blob/main/models/llama3_2/LICENSE"
          target="_blank"
          rel="noreferrer"
          className="text-muted hover:text-fg"
          title="This summary was produced on your device by Meta's Llama 3.2, used under the Llama 3.2 Community License."
        >
          · Built with Llama
        </a>
      )}
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
            <p className="mt-0.5 text-xs text-muted">The exact messages sent to the model.</p>
          </div>
          <button type="button" aria-label="Close" onClick={onClose} className="shrink-0 rounded-lg p-1 text-muted hover:bg-surface-2 hover:text-fg">
            <X className="size-4" />
          </button>
        </div>
        <div className="space-y-3 overflow-y-auto p-4">
          {request.map((m, i) => (
            <div key={i}>
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">{m.role}</div>
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
  // Pre-fill with the EFFECTIVE prompt (override if set, else the default) so the current prompt is
  // visible and can be edited in place — not shown only as a placeholder that vanishes on the first
  // keystroke.
  const [system, setSystem] = useState(() => effectivePromptPart(kind, 'system', prompts));
  const [user, setUser] = useState(() => effectivePromptPart(kind, 'user', prompts));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const save = () => {
    // Store '' when the text is left exactly equal to the default, so the "empty = use default"
    // model is preserved and future default improvements still propagate.
    setPrefs({
      prompts: {
        ...prompts,
        [kind]: {
          system: normalizePromptOverride(kind, 'system', system),
          user: normalizePromptOverride(kind, 'user', user),
        },
      },
    });
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
            <p className="mt-0.5 text-xs text-muted">Both parts are sent to the model. Edit the current prompt in place; Reset restores the default. Save re-runs it.</p>
          </div>
          <button type="button" aria-label="Close" onClick={onClose} className="shrink-0 rounded-lg p-1 text-muted hover:bg-surface-2 hover:text-fg">
            <X className="size-4" />
          </button>
        </div>
        <div className="space-y-3 overflow-y-auto p-4">
          <label className="block space-y-1">
            <span className="text-xs font-medium text-muted">System instruction</span>
            <AutoTextarea
              rows={6}
              maxPx={320}
              value={system}
              onChange={(e) => setSystem(e.target.value)}
              className="w-full rounded-lg border border-edge bg-surface-2 px-3 py-2 text-xs outline-none focus:border-accent"
            />
          </label>
          <label className="block space-y-1">
            <span className="text-xs font-medium text-muted">User-message template</span>
            <AutoTextarea
              rows={8}
              maxPx={460}
              value={user}
              onChange={(e) => setUser(e.target.value)}
              className="w-full rounded-lg border border-edge bg-surface-2 px-3 py-2 font-mono text-[11px] leading-relaxed outline-none focus:border-accent"
            />
            <span className="block text-[11px] text-muted">
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
              setSystem(DEFAULT_PROMPTS[kind].system);
              setUser(DEFAULT_PROMPTS[kind].user);
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
