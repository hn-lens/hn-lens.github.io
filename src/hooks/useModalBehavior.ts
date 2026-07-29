import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * The behaviour that `role="dialog" aria-modal="true"` PROMISES but the attribute does not
 * implement. Declaring a node modal tells assistive tech that the rest of the page is inert; the
 * browser does nothing to enforce it. Without this hook the app's dialogs were modal in name only:
 *
 *  - the page kept SCROLLING behind the overlay (wheel/touch over the backdrop scrolled the feed,
 *    so dismissing the dialog left the reader somewhere else entirely — lost place, no undo), and
 *  - Tab immediately walked OUT of the dialog into the hidden page behind it, so keyboard and
 *    screen-reader users could focus controls they cannot see and never cycle back.
 *
 * Every `aria-modal` surface shares one implementation here so they cannot drift apart (they were
 * seven independent hand-rolled dialogs with no shared primitive, which is exactly why none had it).
 * Escape handling deliberately stays with each dialog rather than here, so a dialog that already
 * binds it does not close twice. `Onboarding` binds none, so Escape does not dismiss the first-run
 * modal; "Skip" does.
 *
 * `active` MUST be false whenever the dialog is not rendered — see the guard in the effect.
 */
export function useModalBehavior(
  ref: RefObject<HTMLElement | null>,
  active = true,
  // Opt-in initial focus target. A dialog with a STICKY header and a separate scroll BODY must focus
  // the body, or the natural first-focusable (a header close button) is outside the scroller and
  // ArrowDown/PageDown/End/Space scroll nothing — the content below the fold is keyboard-unreachable.
  // Give the scroll body tabIndex={-1} and pass its ref. Omitted callers keep first-focusable focus.
  initialFocusRef?: RefObject<HTMLElement | null>
): void {
  // Keep the restore target stable across re-renders.
  const restoreRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    // Hooks run even when the component early-returns null, so a dialog that is merely MOUNTED
    // (not shown) must not lock the page. Callers whose dialog can be closed pass `active`.
    if (!active) return;
    const node = ref.current;
    restoreRef.current = (document.activeElement as HTMLElement | null) ?? null;

    // --- background scroll lock (compensate for the scrollbar so the page doesn't shift) ---
    const body = document.body;
    const prevOverflow = body.style.overflow;
    const prevPadding = body.style.paddingRight;
    const gap = window.innerWidth - document.documentElement.clientWidth;
    body.style.overflow = 'hidden';
    if (gap > 0) body.style.paddingRight = `${gap}px`;

    // --- focus containment ---
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || !node) return;
      const items = Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetWidth > 0 || el.offsetHeight > 0 || el === document.activeElement
      );
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement as HTMLElement | null;
      const outside = !active || !node.contains(active);
      // `idx === -1` covers focus sitting on a container INSIDE the dialog that is not itself in the
      // tab order — e.g. the tabIndex={-1} scroll body an empty SignalsDialog/HiddenDialog focuses
      // initially. Without handling it, the first Tab fell through to the page behind the overlay.
      const idx = active ? items.indexOf(active) : -1;
      if (e.shiftKey && (outside || idx <= 0)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (outside || idx === -1 || idx === items.length - 1)) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);

    // Move focus into the dialog so the very first Tab is already contained. An explicit target (the
    // scroll body of a sticky-header dialog) wins, so arrow-key scrolling works from the start.
    if (node && !node.contains(document.activeElement)) {
      const target = initialFocusRef?.current ?? node.querySelector<HTMLElement>(FOCUSABLE) ?? node;
      target.focus?.();
    }

    return () => {
      body.style.overflow = prevOverflow;
      body.style.paddingRight = prevPadding;
      document.removeEventListener('keydown', onKey, true);
      restoreRef.current?.focus?.();
    };
  }, [ref, active, initialFocusRef]);
}
