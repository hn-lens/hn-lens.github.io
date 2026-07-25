import { lazy, Suspense } from 'react';
import { Routes, Route } from 'react-router-dom';
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

export default function App() {
  // No `bg-bg` on the root. `body` already paints var(--bg), so it was redundant — and because the
  // root is opaque and min-h-svh, it covered the whole viewport and painted OVER the body
  // background-image. That silently disabled the signature "atmosphere" treatment of five designs
  // (geist's dot grid, linear's dark glass glow, cyber's neon wash, sunset and candy's gradients),
  // so 16% of the design set shipped as plain palette swaps. Keep the root transparent and let
  // body own the page background.
  return (
    <div className="min-h-svh text-fg">
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
