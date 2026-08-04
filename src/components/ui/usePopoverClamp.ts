import { useLayoutEffect, useRef, type RefObject } from 'react';

/**
 * Keeps an open, absolutely-positioned popover inside the viewport on BOTH axes.
 *
 * Vertical placement picks a whole side and never partially lifts:
 * - below the anchor when the popover fits there,
 * - else flipped fully above the anchor when it fits there,
 * - else on whichever side has more room, capped to that room and scrolling internally.
 *
 * It never lifts partially to claw back bottom overflow: that slides the popover over its own
 * trigger, so the tap meant to dismiss it lands on a menu item instead.
 *
 * The usable band is bounded at the top by a pinned sticky/fixed header, not by the viewport edge:
 * the header paints above the popover, so anything placed underneath it is both invisible and
 * unhittable (`elementFromPoint` returns the header).
 *
 * On a viewport WIDTH change the popover is closed: the anchor has usually moved (a different
 * column, a different fold state), so no clamped position is correct. A HEIGHT-only change (mobile
 * URL bar, on-screen keyboard) re-places it instead of closing, because the anchor has not moved.
 *
 * Both popovers in the app use this.
 */
/** Bottom edge of a sticky/fixed header currently pinned to the top of the viewport, else 0. */
function pinnedHeaderBottom(): number {
  const h = document.querySelector('header');
  if (!h) return 0;
  const pos = getComputedStyle(h).position;
  if (pos !== 'sticky' && pos !== 'fixed') return 0;
  const r = h.getBoundingClientRect();
  return r.top <= 0.5 ? Math.max(0, r.bottom) : 0;
}
export function usePopoverClamp(
  open: boolean,
  contentRef: RefObject<HTMLElement | null>,
  anchorRef: RefObject<HTMLElement | null>,
  close: () => void,
  pad = 6,
): void {
  const closeRef = useRef(close);
  closeRef.current = close;

  useLayoutEffect(() => {
    const el = contentRef.current;
    if (!open || !el) return;

    const place = () => {
      // Re-placing rebuilds the height cap from scratch, and dropping the cap re-lays the element
      // out at full height, which makes the browser clamp scrollTop to 0. Carry the reader's
      // position across the recompute.
      const keepScroll = el.scrollTop;
      el.style.transform = 'none';
      el.style.maxHeight = '';
      el.style.overflowY = '';

      const vh = window.innerHeight;
      const vw = window.innerWidth;
      const gap = 4;
      const bandTop = pinnedHeaderBottom() + pad;
      const bandBottom = vh - pad;

      const natural = el.getBoundingClientRect();
      const anchor = anchorRef.current?.getBoundingClientRect() ?? null;

      let dx = 0;
      if (natural.left < pad) dx = pad - natural.left;
      else if (natural.right > vw - pad) dx = vw - pad - natural.right;

      let dy = 0;
      if (anchor) {
        // Measure "above the anchor" from a point inside the band. When the anchor itself has been
        // pushed below the fold (a height-only shrink re-places rather than closes), its raw top
        // would offer room that is off-screen, and the flip would land there.
        const anchorTop = Math.min(anchor.top, bandBottom);
        // Measure the room BELOW from inside the band too. Scrolling carries the popover's natural
        // top above the band — negative, once it is off the top of the screen — and measuring from
        // there reports more room than exists, so the "fits" branch leaves it parked on the header.
        const topInBand = Math.max(natural.top, bandTop);
        const roomBelow = bandBottom - topInBand;
        const roomAbove = anchorTop - gap - bandTop;
        if (natural.height <= roomBelow) {
          dy = topInBand - natural.top; // fits below, pushed down into the band if it was above it
        } else if (natural.height <= roomAbove) {
          dy = anchorTop - gap - natural.bottom; // flip fully above the anchor
        } else if (roomAbove > roomBelow) {
          el.style.maxHeight = `${Math.max(0, roomAbove)}px`;
          el.style.overflowY = 'auto';
          dy = bandTop - natural.top;
        } else {
          el.style.maxHeight = `${Math.max(0, roomBelow)}px`;
          el.style.overflowY = 'auto';
          dy = topInBand - natural.top;
        }
      } else if (natural.bottom > bandBottom) {
        el.style.maxHeight = `${Math.max(0, bandBottom - Math.max(natural.top, bandTop))}px`;
        el.style.overflowY = 'auto';
        dy = Math.min(0, bandTop - natural.top);
      }

      el.style.transform = dx || dy ? `translate(${dx}px, ${dy}px)` : 'none';
      if (el.style.overflowY === 'auto' && keepScroll) el.scrollTop = keepScroll;
    };

    place();

    let lastWidth = window.innerWidth;
    const onViewportChange = () => {
      if (window.innerWidth !== lastWidth) {
        lastWidth = window.innerWidth;
        closeRef.current();
        return;
      }
      place();
    };
    const onOrientation = () => closeRef.current();

    // Scrolling moves the anchor under a pinned header, so a placement computed at open time goes
    // stale: the popover keeps its transform and can end up painting over the header it was placed
    // to avoid. Re-place on scroll, coalesced to one frame.
    let queued = false;
    const onScroll = (e: Event) => {
      // Capture catches scroll events from ANY element, including the popover's own overflow when
      // it has been capped. Re-placing on those would fight the reader for the scrollbar.
      const target = e.target;
      if (target instanceof Node && el.contains(target)) return;
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        if (!contentRef.current) return;
        const a = anchorRef.current?.getBoundingClientRect();
        // Once the trigger has left the usable band entirely there is nothing to stay attached to,
        // and a popover pinned to the header outlives the row it belongs to.
        if (a && (a.bottom < pinnedHeaderBottom() || a.top > window.innerHeight)) {
          closeRef.current();
          return;
        }
        place();
      });
    };

    window.addEventListener('resize', onViewportChange);
    window.addEventListener('orientationchange', onOrientation);
    window.addEventListener('scroll', onScroll, { passive: true, capture: true });
    return () => {
      window.removeEventListener('resize', onViewportChange);
      window.removeEventListener('orientationchange', onOrientation);
      window.removeEventListener('scroll', onScroll, { capture: true });
    };
  }, [open, contentRef, anchorRef, pad]);
}
