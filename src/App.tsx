import { lazy, Suspense, useEffect, useRef } from 'react';
import { Routes, Route, useLocation, useSearchParams } from 'react-router-dom';
import TopNav from './components/layout/TopNav';
import Home from './routes/Home';
import ScrollTop from './components/ui/ScrollTop';
import Toaster from './components/ui/Toaster';
import KeyboardShortcuts from './components/KeyboardShortcuts';
import Onboarding from './components/Onboarding';

// Home stays eager (the landing route — lazy-loading it would delay first paint); the rest
// are code-split so a Home-only visitor doesn't download Item/Settings/User/Saved.
const Item = lazy(() => import('./routes/Item'));
const Saved = lazy(() => import('./routes/Saved'));
const User = lazy(() => import('./routes/User'));
const Settings = lazy(() => import('./routes/Settings'));

/**
 * Arriving at a new ROUTE starts at the top of it.
 *
 * `history.scrollRestoration` is 'manual' and React Router leaves the window offset exactly where
 * the previous route had it, so navigating from a scrolled feed carried that offset onto the
 * destination: measured, /settings opened at y=3000 of a 6294px page, and a re-opened discussion
 * landed past its own first comment. The feed has its own arrival handling (it must re-assert the
 * top while the list grows underneath it); this covers every other route, which was nothing.
 *
 * Keyed on pathname AND the search query `q` — search is a `?q=` change on the SAME path (Home), so
 * a pathname-only reset let it inherit the feed's offset and open below the results heading (SPEC §4:
 * a new arrival lands at the top). A feed-TAB switch (`?feed=`) is deliberately NOT in the deps:
 * Feed.tsx's own per-`kind` arrival effect already resets a tab switch to the top, so this
 * route-level effect needn't handle it. `q` is set on submit, not per keystroke, so this fires once
 * per search, not while typing. Does NOT fight a later deliberate scroll: a comment permalink's
 * `scrollIntoView` runs after its content loads, i.e. after this.
 */
function ScrollToTopOnRouteChange() {
  const { pathname } = useLocation();
  const [params] = useSearchParams();
  const q = params.get('q') ?? '';
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false; // a fresh load is already at the top; don't fight a deep link
      return;
    }
    // 'instant': `scroll-behavior: smooth` is global, and animating an arrival reads as drift.
    window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
  }, [pathname, q]);
  return null;
}

export default function App() {
  // No `bg-bg` on the root. `body` already paints var(--bg), so it was redundant — and because the
  // root is opaque and min-h-svh, it covered the whole viewport and painted OVER the body
  // background-image. That silently disabled the signature "atmosphere" treatment of five designs
  // (geist's dot grid, linear's dark glass glow, cyber's neon wash, sunset and candy's gradients),
  // so 16% of the design set shipped as plain palette swaps. Keep the root transparent and let
  // body own the page background.
  return (
    <div className="min-h-svh text-fg">
      <ScrollToTopOnRouteChange />
      <TopNav />
      <Suspense fallback={<div className="mx-auto max-w-5xl px-4 py-10 text-sm text-muted">Loading…</div>}>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/item/:id" element={<Item />} />
          <Route path="/saved" element={<Saved />} />
          <Route path="/user/:id" element={<User />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="*" element={<Home />} />
        </Routes>
      </Suspense>
      <ScrollTop />
      <Toaster />
      <KeyboardShortcuts />
      <Onboarding />
    </div>
  );
}
