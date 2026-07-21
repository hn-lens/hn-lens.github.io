import { useEffect, useState } from 'react';

const SHORTCUTS: Array<[string, string]> = [
  ['j / k', 'Next / previous story (or comment)'],
  ['h / l', 'Previous / next feed tab'],
  ['Tab / ⇧Tab', 'Move focus anywhere (sidebar, controls, links)'],
  ['o  or  Enter', 'Open story / collapse the comment'],
  ['c', 'Open comments / collapse the comment'],
  ['s', 'Save / unsave the story'],
  ['g', 'Jump to the top'],
  ['/', 'Focus search'],
  ['?', 'Toggle this help'],
  ['Esc', 'Close drawer / help'],
];

// j/k navigate the CURRENT list: comments when a thread is open (drawer or /item),
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

export default function KeyboardShortcuts() {
  const [helpOpen, setHelpOpen] = useState(false);

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

      switch (e.key) {
        case '/':
          e.preventDefault();
          document.querySelector<HTMLInputElement>('input[type="search"]')?.focus();
          break;
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
          else clickIn(el, 'button[aria-label="Open comments"]');
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
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard shortcuts"
    >
      <div
        className="w-full max-w-sm rounded-xl border border-border bg-surface p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
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
        <p className="mt-3 text-xs text-subtle">
          Everything is also reachable with <kbd className="rounded border border-border bg-surface-2 px-1 text-[10px]">Tab</kbd> / <kbd className="rounded border border-border bg-surface-2 px-1 text-[10px]">⇧Tab</kbd> + <kbd className="rounded border border-border bg-surface-2 px-1 text-[10px]">Enter</kbd>.
        </p>
      </div>
    </div>
  );
}
