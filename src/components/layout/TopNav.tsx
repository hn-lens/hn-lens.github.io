import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import Logo from '../ui/Logo';
import OfflineNotice from '../ui/OfflineNotice';
import { ArrowUp, Bookmark, ExternalLink, Moon, Search, Settings, Sun } from 'lucide-react';
import { useTheme } from '../../hooks/useTheme';
import { usePrefs } from '../../lib/prefs';
import { LAYOUTS, THEMES } from '../../lib/themes';
import { IconButton } from '../ui/primitives';
import { scrollToTop, useScrolledPast } from '../../hooks/useScrollTop';

export default function TopNav() {
  const { isDark, toggle } = useTheme();
  const themeName = usePrefs((s) => s.themeName);
  const setThemeName = usePrefs((s) => s.setThemeName);
  const layout = usePrefs((s) => s.layout);
  const setLayout = usePrefs((s) => s.setLayout);
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const urlQ = params.get('q') ?? '';
  const [q, setQ] = useState(urlQ);
  // Phones get "back to top" HERE rather than as a floating FAB: this header is sticky, so the
  // control is always reachable and never sits in the tap layer over content (a bottom-anchored
  // FAB stole taps from comment authors / collapse chevrons / left-aligned layout controls — see
  // ScrollTop.tsx). Desktop keeps the FAB, which sits harmlessly in the empty side gutter.
  const scrolled = useScrolledPast(800);

  // Keep the box in sync with the URL (deep links, clearing, back/forward).
  useEffect(() => {
    setQ(urlQ);
  }, [urlQ]);

  const onSearch = (e: FormEvent) => {
    e.preventDefault();
    const term = q.trim();
    navigate(term ? `/?q=${encodeURIComponent(term)}` : '/');
  };

  return (
    <header className="sticky top-0 z-40 border-b border-border bg-bg/85 backdrop-blur">
      <div className="app-topbar mx-auto flex h-14 max-w-6xl items-center gap-1 px-1.5 sm:gap-3 sm:px-4">
        <Link to="/" className="flex shrink-0 items-center gap-2 font-semibold tracking-tight">
          <Logo className="size-6 shrink-0" />
          <span className="hidden sm:inline">Hacker Lens</span>
        </Link>

        <OfflineNotice />

        <form onSubmit={onSearch} className="relative ml-1 flex-1 sm:max-w-md">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-subtle" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            // Sized to fit the narrowest supported viewport. An input cannot ellipsise its own
            // placeholder, so anything longer is cut mid-word and reads as a typo rather than as
            // truncation; the accessible name below carries the full wording.
            placeholder="Search…"
            aria-label="Search Hacker News"
            type="search"
            className="w-full rounded-lg border border-edge bg-surface py-1.5 pl-8 pr-3 text-sm outline-none placeholder:text-subtle focus:border-accent focus:ring-1 focus:ring-ring"
          />
        </form>

        <nav aria-label="Primary" className="flex items-center gap-0.5">
          <select
            value={themeName}
            aria-label="Theme design"
            title="Switch theme design"
            onChange={(e) => setThemeName(e.target.value)}
            className="hidden max-w-[9rem] truncate rounded-lg border border-edge bg-surface py-1.5 pl-2 pr-6 text-xs text-muted outline-none hover:text-fg focus:border-accent md:block lg:max-w-[15rem]"
          >
            {THEMES.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
          <select
            value={layout}
            aria-label="Layout"
            title="Switch layout (structure)"
            onChange={(e) => setLayout(e.target.value)}
            className="hidden max-w-[8rem] truncate rounded-lg border border-edge bg-surface py-1.5 pl-2 pr-6 text-xs text-muted outline-none hover:text-fg focus:border-accent lg:block lg:max-w-[13rem]"
          >
            {LAYOUTS.map((l) => (
              <option key={l.id} value={l.id}>
                {l.label}
              </option>
            ))}
          </select>
          {scrolled && (
            <span className="lg:hidden">
              <IconButton label="Scroll to top" onClick={scrollToTop}>
                <ArrowUp className="size-[18px]" />
              </IconButton>
            </span>
          )}
          <IconButton label="Saved items" onClick={() => navigate('/saved')}>
            <Bookmark className="size-[18px]" />
          </IconButton>
          <IconButton label="Settings & models" onClick={() => navigate('/settings')}>
            <Settings className="size-[18px]" />
          </IconButton>
          <IconButton label={isDark ? 'Switch to light mode' : 'Switch to dark mode'} onClick={toggle}>
            {isDark ? <Moon className="size-[18px]" /> : <Sun className="size-[18px]" />}
          </IconButton>
          <a
            href="https://news.ycombinator.com/"
            target="_blank"
            rel="noreferrer"
            title="Open original Hacker News"
            className="hidden rounded-lg px-2 py-1.5 text-muted transition-colors hover:bg-surface-2 hover:text-fg sm:inline-flex"
          >
            <ExternalLink className="size-[18px]" />
          </a>
        </nav>
      </div>
    </header>
  );
}
