import { useState } from 'react';
import { MessageSquare } from 'lucide-react';
import { faviconUrl } from '../../lib/time';
import { cn } from '../../lib/cn';
import { usePrefs } from '../../lib/prefs';

const BOX = 'grid size-9 shrink-0 place-items-center overflow-hidden rounded-lg border border-border';

export default function Favicon({
  domain,
  isText,
  dim,
}: {
  domain: string;
  isText: boolean;
  dim?: boolean;
}) {
  const [loaded, setLoaded] = useState(false);
  const remoteFavicons = usePrefs((s) => s.remoteFavicons);

  if (isText || !domain) {
    return (
      <div className={cn(BOX, 'bg-accent/10', dim && 'opacity-60')}>
        <MessageSquare className="size-4 text-accent" />
      </div>
    );
  }

  // Privacy mode: render a letter monogram only, with NO request to the remote favicon
  // service — so the domains of stories you view are never sent off-device.
  if (!remoteFavicons) {
    return (
      <div className={cn(BOX, 'bg-white dark:bg-neutral-200', dim && 'opacity-60')}>
        <span className="text-xs font-bold uppercase text-neutral-500 dark:text-neutral-600">{domain[0]}</span>
      </div>
    );
  }

  // Letter monogram shows immediately (and stays if the favicon 404s / is slow);
  // the real favicon fades in over it once loaded. No blank boxes ever.
  // Softer than pure white in dark mode.
  return (
    <div className={cn(BOX, 'relative bg-white dark:bg-neutral-200', dim && 'opacity-60')}>
      <span
        className={cn(
          'absolute text-xs font-bold uppercase text-neutral-500 dark:text-neutral-600',
          loaded && 'opacity-0'
        )}
      >
        {domain[0]}
      </span>
      <img
        src={faviconUrl(domain, 64)}
        alt=""
        loading="lazy"
        className={cn('relative size-5 object-contain transition-opacity', !loaded && 'opacity-0')}
        onLoad={() => setLoaded(true)}
        onError={() => setLoaded(false)}
      />
    </div>
  );
}
