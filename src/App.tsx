import { Routes, Route } from 'react-router-dom';
import TopNav from './components/layout/TopNav';
import Home from './routes/Home';
import Item from './routes/Item';
import Settings from './routes/Settings';
import Saved from './routes/Saved';
import CommentsDrawer from './components/comments/CommentsDrawer';
import ScrollTop from './components/ui/ScrollTop';
import Toaster from './components/ui/Toaster';
import KeyboardShortcuts from './components/KeyboardShortcuts';
import Onboarding from './components/Onboarding';

export default function App() {
  return (
    <div className="min-h-svh bg-bg text-fg">
      <TopNav />
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/item/:id" element={<Item />} />
        <Route path="/saved" element={<Saved />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="*" element={<Home />} />
      </Routes>
      <CommentsDrawer />
      <ScrollTop />
      <Toaster />
      <KeyboardShortcuts />
      <Onboarding />
    </div>
  );
}
