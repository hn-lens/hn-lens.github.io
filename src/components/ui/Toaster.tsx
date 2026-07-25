import { useToast } from '../../hooks/useToast';

export default function Toaster() {
  const toasts = useToast((s) => s.toasts);
  const dismiss = useToast((s) => s.dismiss);

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex flex-col items-center gap-2 px-4">
      {toasts.map((t) => (
        <div
          key={t.id}
          role="status"
          data-testid="toast"
          // pointer-events-NONE on the card, auto only on its buttons below.
          //
          // The whole card was interactive so that Undo would work, which also made it swallow every
          // tap landing on it for the 4s it is visible — proved A/B on a phone: a control under the
          // toast opened 1/1 times without it and 0/1 with it. The floating scroll-to-top button was
          // taken out of the phone tap layer for exactly this reason; the toast, which appears after
          // every hide and save precisely when the reader is still tapping, was left in it.
          className="pointer-events-none flex items-center gap-3 rounded-lg border border-border bg-surface px-3.5 py-2 text-sm shadow-lg"
        >
          <span className="text-fg">{t.message}</span>
          {t.actionLabel && (
            <button
              // Interactive even though the card is not (see above).
              type="button"
              onClick={() => {
                t.onAction?.();
                dismiss(t.id);
              }}
              className="pointer-events-auto font-medium text-accent hover:underline"
            >
              {t.actionLabel}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
