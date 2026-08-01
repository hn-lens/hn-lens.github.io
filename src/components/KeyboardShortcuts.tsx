import { useEffect, useState, useRef} from 'react';

// SPLIT BY SURFACE, because three keys are rebound on a discussion page and a flat list could only
// ever be wrong about them. `CommentsView` takes `s`, `l` and `a` for its toolbar tools while
// `/item` is open, so a reader following the old flat help pressed `s` to save the story they were
// reading, got a Summary panel, and reasonably concluded the app had ignored them — with a Save
// control sitting in the header. `a` was the one keyboard-only feature and the help never mentioned
// it. Every row here must do what it says ON THE SURFACE IT IS LISTED UNDER.
const SHORTCUTS: Array<[string, string]> = [
  ['j / k', 'Next / previous story (or comment)'],
  ['[ / ]', 'Prev / next comment (skip replies)'],
  ['h / l', 'Previous / next feed tab'],
  ['Tab / ⇧Tab', 'Move focus anywhere (sidebar, controls, links)'],
  ['o  or  Enter', 'Open story / collapse the comment'],
  ['c', 'Open comments / collapse the comment'],
  ['s', 'Save / unsave the story'],
  ['g', 'Jump to the top'],
  ['/', 'Focus search'],
  ['?', 'Toggle this help'],
  ['Esc', 'Close this help'],
];

/** Keys that mean something DIFFERENT while a discussion (`/item/:id`) is open. */
const DISCUSSION_SHORTCUTS: Array<[string, string]> = [
  ['l', 'Find in this discussion'],
  ['s', 'Summary of this discussion'],
  ['a', 'Ask this discussion (needs AI configured)'],
];

// j/k navigate the CURRENT list: comments when a discussion page is open (/item),
// otherwise the feed cards. Everything else (sidebar cards, every control) is
// reachable with native Tab / Shift+Tab + Enter — that's the universal nav; the
// vim keys are accelerators on top of it.
function articles(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('article'));
}
function comments(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[id^="comment-"]'));
}
function navItems(): { items: HTMLElement[]; kind: 'comment' | 'story' } {
  const c = comments();
  return c.length ? { items: c, kind: 'comment' } : { items: articles(), kind: 'story' };
}

// Move to the previous/next feed tab. Works for any tab orientation (horizontal
// or the vertical rail) because it walks the tabs in DOM order.
function switchTab(dir: -1 | 1): void {
  const tabs = Array.from(document.querySelectorAll<HTMLElement>('.feed-tabs button'));
  if (!tabs.length) return;
  let cur = tabs.findIndex((b) => b.getAttribute('aria-current') === 'page');
  if (cur < 0) cur = 0;
  const next = Math.max(0, Math.min(cur + dir, tabs.length - 1));
  if (next !== cur) tabs[next].click();
}

import { X } from 'lucide-react';
import { useModalBehavior } from '../hooks/useModalBehavior';

export default function KeyboardShortcuts() {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  useModalBehavior(dialogRef, helpOpen);

  useEffect(() => {
    let index = -1;
    let lastKind: 'comment' | 'story' | null = null;

    const select = (i: number) => {
      const { items, kind } = navItems();
      if (!items.length) return;
      // When the nav context changes (feed cards ↔ open thread's comments), the old
      // index is meaningless — restart at the top instead of carrying it over (which
      // made the first `j` after opening a thread jump to comment N, not comment 0).
      if (kind !== lastKind) {
        lastKind = kind;
        index = -1;
        i = 0;
      }
      index = Math.max(0, Math.min(i, items.length - 1));
      document.querySelectorAll('.kbd-selected').forEach((el) => el.classList.remove('kbd-selected'));
      items[index].classList.add('kbd-selected');
      items[index].scrollIntoView({ block: 'center', behavior: 'smooth' });
    };
    const current = (): { el: HTMLElement | undefined; kind: 'comment' | 'story' } => {
      const { items, kind } = navItems();
      return { el: items[index], kind };
    };
    const clickIn = (el: HTMLElement | undefined, sel: string) =>
      el?.querySelector<HTMLElement>(sel)?.click();

    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      const typing =
        !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);

      if (e.key === 'Escape') {
        setHelpOpen(false);
        return;
      }
      if (typing) return;

      // A modal is open ⇒ the global shortcuts are OFF.
      //
      // They stayed live behind every dialog, defeating both protections `useModalBehavior` exists
      // to provide: `j`/`k` scrolled the page underneath a modal that had set body{overflow:hidden}
      // (0→1009px, and 0→2293px behind the help dialog), `l` switched feed tab and unmounted the
      // dialog from under the reader, `/` moved focus outside the supposedly focus-trapped surface —
      // and `s` silently SAVED a story the reader could not even see, with the toast hidden behind
      // the overlay. A shortcut that acts on content the user cannot see is acting without consent.
      // Escape is deliberately handled ABOVE this line: closing the dialog must always work.
      if (document.querySelector('[aria-modal="true"]')) return;

      switch (e.key) {
        case '/': {
          e.preventDefault();
          // Focus the inline discussion search when it's VISIBLE, else the global nav search. The
          // inline box folds into the "…" menu at the narrowest widths, where it is display:none but
          // STILL in the DOM — so check the rendered box (offsetParent), not mere presence, or `/`
          // would target a hidden input and no-op (matches the `l` handler's visibility check).
          const disc = document.querySelector<HTMLInputElement>('.disc-tb-bar input[type="search"]');
          (disc && disc.offsetParent !== null ? disc : document.querySelector<HTMLInputElement>('input[type="search"]'))?.focus();
          break;
        }
        case '?':
          setHelpOpen((v) => !v);
          break;
        case 'j':
          e.preventDefault();
          select(index + 1);
          break;
        case 'k':
          e.preventDefault();
          select(index < 0 ? 0 : index - 1);
          break;
        case '[':
        case ']': {
          // Depth-aware nav: jump to the next/previous comment at a depth <= the
          // current one, i.e. skip the current comment's whole subtree of replies.
          const { items, kind } = navItems();
          if (kind !== 'comment' || !items.length) break;
          e.preventDefault();
          const depthOf = (el?: HTMLElement) => Number(el?.dataset.depth ?? 0);
          const curDepth = index >= 0 ? depthOf(items[index]) : 0;
          const dir = e.key === ']' ? 1 : -1;
          for (let s = index + dir; s >= 0 && s < items.length; s += dir) {
            if (depthOf(items[s]) <= curDepth) {
              select(s);
              break;
            }
          }
          break;
        }
        case 'h':
          e.preventDefault();
          switchTab(-1);
          break;
        case 'l':
          e.preventDefault();
          switchTab(1);
          break;
        case 'g':
          e.preventDefault();
          window.scrollTo({ top: 0, behavior: 'smooth' });
          break;
        case 'o':
        case 'Enter': {
          const { el, kind } = current();
          if (kind === 'comment') clickIn(el, 'button[aria-label="Collapse comment"], button[aria-label="Expand comment"]');
          else clickIn(el, 'h3 a, h3 button');
          break;
        }
        case 'c': {
          const { el, kind } = current();
          if (kind === 'comment') clickIn(el, 'button[aria-label="Collapse comment"], button[aria-label="Expand comment"]');
          else clickIn(el, 'button[aria-label^="Open comments"]');
          break;
        }
        case 's': {
          const { el, kind } = current();
          if (kind === 'story') clickIn(el, 'button[aria-label="Save"], button[aria-label="Saved"]');
          break;
        }
        default:
          break;
      }
    };

    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  if (!helpOpen) return null;
  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4"
      onClick={() => setHelpOpen(false)}
    >
      {/* The DIALOG is the scroll container, not the overlay. `useModalBehavior` moves focus to the
          first focusable child (the close button below) — which lives inside this scrollable card, so
          ArrowDown / PageDown / End / Space and Tab all reach the content below the fold. When the
          ref sat on the overlay, focus landed on a non-scrollable element and a keyboard user could
          not reach the last rows (the "reachable with Tab" note) at all, though the wheel worked. */}
      <div
        className="relative max-h-[85vh] w-full min-w-0 max-w-sm overflow-y-auto rounded-xl border border-border bg-surface p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        ref={dialogRef}
        tabIndex={-1}
        aria-label="Keyboard shortcuts"
      >
        <button
          type="button"
          onClick={() => setHelpOpen(false)}
          aria-label="Close keyboard shortcuts"
          className="absolute right-3 top-3 rounded-md border border-edge p-1 text-muted hover:text-fg"
        >
          <X className="size-4" />
        </button>
        <h2 className="mb-3 text-sm font-semibold">Keyboard shortcuts</h2>
        <dl className="space-y-1.5 text-sm">
          {SHORTCUTS.map(([k, d]) => (
            <div key={k} className="flex items-center justify-between gap-4">
              <dt className="text-muted">{d}</dt>
              <dd>
                <kbd className="rounded border border-border bg-surface-2 px-1.5 py-0.5 text-xs">{k}</kbd>
              </dd>
            </div>
          ))}
        </dl>
        <h3 className="mb-2 mt-4 text-sm font-semibold">On a discussion page</h3>
        <p className="mb-2 text-xs text-muted">These three do something different while you have a discussion open:</p>
        <dl className="space-y-1.5 text-sm">
          {DISCUSSION_SHORTCUTS.map(([k, d]) => (
            <div key={`disc-${k}`} className="flex items-center justify-between gap-4">
              <dt className="text-muted">{d}</dt>
              <dd>
                <kbd className="rounded border border-border bg-surface-2 px-1.5 py-0.5 text-xs">{k}</kbd>
              </dd>
            </div>
          ))}
        </dl>
        <p className="mt-3 text-xs text-muted">
          Everything is also reachable with <kbd className="rounded border border-border bg-surface-2 px-1 text-[10px]">Tab</kbd> / <kbd className="rounded border border-border bg-surface-2 px-1 text-[10px]">⇧Tab</kbd> + <kbd className="rounded border border-border bg-surface-2 px-1 text-[10px]">Enter</kbd>.
        </p>
      </div>
    </div>
  );
}
