import { useEffect, useRef } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Maximize2, X } from 'lucide-react';
import { useUi } from '../../hooks/useUi';
import CommentsView from './CommentsView';

export default function CommentsDrawer() {
  const commentsId = useUi((s) => s.commentsId);
  const close = useUi((s) => s.closeComments);
  const open = commentsId !== null;
  const panelRef = useRef<HTMLElement>(null);
  const location = useLocation();

  // Close the drawer on any route change (e.g. browser back/forward) so its
  // backdrop can't trap the page behind it.
  useEffect(() => {
    close();
  }, [location.key, close]);

  useEffect(() => {
    if (!open) return;
    const prevFocus = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('keydown', onKey);
    // Lock body scroll, compensating for the scrollbar width to avoid layout shift.
    const sbw = window.innerWidth - document.documentElement.clientWidth;
    document.body.style.overflow = 'hidden';
    if (sbw > 0) document.body.style.paddingRight = `${sbw}px`;
    panelRef.current?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
      document.body.style.paddingRight = '';
      prevFocus?.focus?.();
    };
  }, [open, close]);

  return (
    <div
      className={`fixed inset-0 z-40 ${open ? '' : 'pointer-events-none'}`}
      aria-hidden={!open}
      // When closed, `inert` removes the (still-mounted, animating) drawer + its
      // buttons from the tab order + a11y tree — fixes axe "aria-hidden-focus".
      inert={!open}
    >
      <div
        onClick={close}
        className={`absolute inset-0 bg-black/40 transition-opacity ${open ? 'opacity-100' : 'opacity-0'}`}
      />
      <aside
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Discussion"
        tabIndex={-1}
        className={`absolute right-0 top-0 flex h-full w-full max-w-[560px] flex-col border-l border-border bg-bg shadow-2xl outline-none transition-transform duration-200 ${
          open ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
          <span className="text-sm font-medium text-muted">Discussion</span>
          <div className="flex items-center gap-1">
            {commentsId !== null && (
              <Link
                to={`/item/${commentsId}`}
                onClick={close}
                title="Open full page"
                className="rounded-lg px-2 py-1.5 text-muted hover:bg-surface-2 hover:text-fg"
              >
                <Maximize2 className="size-4" />
              </Link>
            )}
            <button
              type="button"
              onClick={close}
              title="Close"
              className="rounded-lg px-2 py-1.5 text-muted hover:bg-surface-2 hover:text-fg"
            >
              <X className="size-4" />
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto px-4 py-4">
          {commentsId !== null && <CommentsView key={commentsId} id={commentsId} />}
        </div>
      </aside>
    </div>
  );
}
