import { Link } from 'react-router-dom';
import { useOnline } from '../../hooks/useOnline';

/**
 * Secondary line for outage states: when offline, points the reader at content that IS available
 * offline (Saved + Read, both served from IndexedDB). Renders nothing when online.
 */
export default function OfflineOutageHint() {
  const online = useOnline();
  if (online) return null;
  return (
    <p data-offline-hint="true" className="mt-2 text-xs text-muted">
      Your{' '}
      <Link to="/saved" className="text-accent hover:underline">
        Saved
      </Link>{' '}
      and{' '}
      <Link to="/?feed=read" className="text-accent hover:underline">
        Read
      </Link>{' '}
      stories are available offline.
    </p>
  );
}
