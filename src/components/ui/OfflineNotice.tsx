import { useEffect, useState } from 'react';
import { WifiOff } from 'lucide-react';
import { useOnline } from '../../hooks/useOnline';

const APPEAR_DELAY_MS = 600; // suppress brief connectivity blips

/**
 * Offline indicator. Rendered INSIDE the TopNav's fixed-height row (see TopNav), so it neither
 * reflows page content (the nav height is fixed) nor occludes the feed tabs / discussion toolbar
 * that sit below the nav. Appears after APPEAR_DELAY_MS offline; hides on reconnect.
 */
export default function OfflineNotice() {
  const online = useOnline();
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (online) {
      setShow(false);
      return;
    }
    const t = setTimeout(() => setShow(true), APPEAR_DELAY_MS);
    return () => clearTimeout(t);
  }, [online]);
  if (!show) return null;
  return (
    <span
      role="status"
      aria-live="polite"
      aria-label="You're offline"
      data-offline-indicator="true"
      title="You're offline — new content will load when you reconnect"
      className="inline-flex shrink-0 items-center gap-1 rounded-full border border-edge bg-surface-2 px-2 py-1 text-xs font-medium text-muted"
    >
      <WifiOff className="size-3.5" />
      <span className="hidden sm:inline">Offline</span>
    </span>
  );
}
