import { ArrowUp } from 'lucide-react';
import { useLocation } from 'react-router-dom';
import { scrollToTop, useScrolledPast } from '../../hooks/useScrollTop';
import { cn } from '../../lib/cn';

export default function ScrollTop() {
  // Routes whose content is FULL-WIDTH, so there is no gutter for a floating control to live in.
  const { pathname } = useLocation();
  const wideRoute = /^\/(settings|saved|user)/.test(pathname);
  const show = useScrolledPast(800);

  if (!show) return null;
  return (
    <button
      type="button"
      aria-label="Scroll to top"
      onClick={scrollToTop}
      // Shown only at `lg+` (`hidden lg:grid`) — the gate must match the invariant it relies on: a
      // free gutter beside the centred column exists only once the sidebar appears at `lg`. Gating
      // at `sm` put the FAB straight over full-width content from 640-1023px (including real touch
      // tablets in portrait), which is the same tap-stealing defect in a different range. A fixed FAB lives in the TAP LAYER: at sm+ it sits in the
      // empty gutter beside the centered content column and collides with nothing, but on a phone
      // the content is full-width, so SOME control is always underneath it. Anchoring it
      // bottom-right stole taps from right-aligned Settings actions; moving it bottom-LEFT merely
      // relocated the collision onto the comment gutter (author links, collapse chevrons) and the
      // left-aligned layouts — measured topmost over real controls in 5 of 14 layouts, and a tap
      // 1000px into a thread threw the reader back to the top with no undo. Treating the SIDE as
      // the problem cannot work; the fix is to keep the overlay out of the phone tap layer
      // entirely. Phones get the same action from the sticky TopNav (never covers content), plus
      // the `g` keyboard shortcut.
      // The `lg:` gate assumes a gutter beside a centred column — true on the feed, false on the
      // full-width routes, where the FAB lands ON right-aligned controls. At 1024-1090px it was the
      // topmost element over 12 Settings controls including 5 destructive Delete buttons, so a tap
      // meant to delete a data category scrolled the page instead (or worse, the reverse). Gate on
      // the ROUTE as well as the breakpoint: those routes are short and already have the TopNav
      // control plus the `g` shortcut.
      className={cn(
        'fixed bottom-5 right-5 z-20 hidden size-11 place-items-center rounded-full border border-edge bg-surface text-muted shadow-lg transition-colors hover:text-fg',
        !wideRoute && 'lg:grid'
      )}
    >
      <ArrowUp className="size-5" />
    </button>
  );
}
