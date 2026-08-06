import { useCallback, useEffect, useRef, useState } from 'react';
import { Award, BookOpen, Briefcase, Clock, Flame, HelpCircle, Rocket, Sparkles } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '../../lib/cn';
import type { FeedKind } from '../../types';

const TABS: Array<{ kind: FeedKind; label: string; icon: LucideIcon }> = [
  { kind: 'foryou', label: 'For You', icon: Sparkles },
  { kind: 'top', label: 'Top', icon: Flame },
  { kind: 'new', label: 'New', icon: Clock },
  { kind: 'best', label: 'Best', icon: Award },
  { kind: 'ask', label: 'Ask', icon: HelpCircle },
  { kind: 'show', label: 'Show', icon: Rocket },
  { kind: 'job', label: 'Jobs', icon: Briefcase },
  { kind: 'read', label: 'Read', icon: BookOpen },
];

export default function FeedTabs({
  value,
  onSelect,
}: {
  value: FeedKind;
  onSelect: (k: FeedKind) => void;
}) {
  const activeRef = useRef<HTMLButtonElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // The fades are offset past this wrapper's own padding because the strip they cover scrolls
  // edge-to-edge: anchored to the wrapper they stopped short of it, leaving a band where a
  // half-scrolled tab was drawn at full strength against a hard vertical seam.
  // Edge fades hint that the tab strip scrolls — otherwise off-screen tabs (e.g.
  // "Read", last in the row) are invisible on a narrow/mobile viewport with no cue.
  // Only shown when actually scrollable, and hidden at each end so they never mask
  // the first/last tab. In the vertical `rail` layout there's no horizontal overflow,
  // so neither fade appears.
  const [edges, setEdges] = useState({ left: false, right: false });
  const updateEdges = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setEdges({
      left: el.scrollLeft > 4,
      right: el.scrollLeft + el.clientWidth < el.scrollWidth - 4,
    });
  }, []);

  // Centre the active tab HORIZONTALLY, by moving the strip's own scrollLeft — never with
  // `scrollIntoView`.
  //
  // `scrollIntoView({ block: 'nearest' })` reads as "do not move vertically", and it does not, as
  // long as the element is already on screen. Several screens down a feed the tab strip is NOT on
  // screen, so the browser scrolls the DOCUMENT up to reveal it — and switching tabs threw the
  // reader to the top of the page. A control whose job is horizontal must not be able to move the
  // vertical viewport at all, so this does the arithmetic itself and touches only the container.
  useEffect(() => {
    const strip = scrollRef.current;
    const tab = activeRef.current;
    if (!strip || !tab) return;
    const target = tab.offsetLeft - (strip.clientWidth - tab.offsetWidth) / 2;
    const max = strip.scrollWidth - strip.clientWidth;
    strip.scrollLeft = Math.max(0, Math.min(target, max));
  }, [value]);

  useEffect(() => {
    updateEdges();
    const el = scrollRef.current;
    if (!el) return;
    el.addEventListener('scroll', updateEdges, { passive: true });
    window.addEventListener('resize', updateEdges);
    return () => {
      el.removeEventListener('scroll', updateEdges);
      window.removeEventListener('resize', updateEdges);
    };
  }, [updateEdges]);

  return (
    <div className="relative">
      <div
        ref={scrollRef}
        className="feed-tabs no-scrollbar -mx-3 flex gap-1 overflow-x-auto px-3 sm:mx-0 sm:px-0"
      >
        {TABS.map(({ kind, label, icon: Icon }) => {
          const active = value === kind;
          return (
            <button
              key={kind}
              ref={active ? activeRef : undefined}
              type="button"
              aria-current={active ? 'page' : undefined}
              onClick={() => onSelect(kind)}
              className={cn(
                'inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm transition-colors',
                // Active state carries THREE cues: an accent border + a tinted fill + heavier
                // weight. The LABEL is `text-fg` (not accent) because accent-on-accent-tint fails
                // AA in many light themes. Selection is carried by the BORDER: the tint alone
                // measures 1.14-1.45 against the page, below the 3:1 a non-text cue needs.
                active
                  ? 'border-accent bg-accent/15 font-semibold text-fg'
                  : 'border-edge bg-surface font-medium text-muted hover:text-fg'
              )}
            >
              <Icon className="size-4" />
              {label}
            </button>
          );
        })}
      </div>
      {/* Narrow (24px) so the opaque end of the fade clears a FULLY-visible tab's text — a 44px fade
          bit ~20px into the last tab and dropped its trailing glyphs below AA. The negative inset
          keeps the fade reaching the true scroll edge (so a CLIPPED tab is still softened, not cut
          at a hard line), which is the seam behaviour this element exists for. */}
      {edges.left && (
        <div aria-hidden className="pointer-events-none absolute inset-y-0 -left-3 w-6 bg-gradient-to-r from-bg to-transparent sm:-left-4" />
      )}
      {edges.right && (
        <div aria-hidden className="pointer-events-none absolute inset-y-0 -right-3 w-6 bg-gradient-to-l from-bg to-transparent sm:-right-4" />
      )}
    </div>
  );
}
