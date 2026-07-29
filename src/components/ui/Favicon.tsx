import { useState } from 'react';
import { MessageSquare } from 'lucide-react';
import { faviconUrl } from '../../lib/time';
import { cn } from '../../lib/cn';
import { usePrefs } from '../../lib/prefs';

const BOX = 'grid shrink-0 place-items-center overflow-hidden rounded-lg border border-border';

/**
 * `compact` is the inline variant used beside a headline (the discussion header) rather than as a
 * card's leading tile. It exists so that surface can share THIS component: it previously hand-rolled
 * a bare `<img src={faviconUrl(...)}>`, which inherited none of the behaviour here — no letter
 * monogram, so a domain whose favicon 404s or loads slowly rendered a broken-image glyph or a blank
 * gap, and no fade. The privacy gate was duplicated there correctly, but duplicating it was itself
 * the risk: it is one edit away from the two copies disagreeing about whether a request goes out.
 */
export default function Favicon({
  domain,
  isText,
  dim,
  compact,
}: {
  domain: string;
  isText: boolean;
  dim?: boolean;
  compact?: boolean;
}) {
  const [loaded, setLoaded] = useState(false);
  const remoteFavicons = usePrefs((s) => s.remoteFavicons);
  const box = cn(BOX, compact ? 'size-5 rounded' : 'size-9');
  const glyph = compact ? 'text-[9px]' : 'text-xs';

  if (isText || !domain) {
    return (
      <div className={cn(box, 'bg-accent/10', dim && 'opacity-60')}>
        <MessageSquare className={cn(compact ? 'size-3' : 'size-4', 'text-accent')} />
      </div>
    );
  }

  // Privacy mode: render a letter monogram only, with NO request to the remote favicon
  // service — so the domains of stories you view are never sent off-device.
  if (!remoteFavicons) {
    return (
      <div className={cn(box, 'bg-white dark:bg-neutral-200', dim && 'opacity-60')}>
        <span className={cn(glyph, 'font-bold uppercase text-neutral-500 dark:text-neutral-600')}>{domain[0]}</span>
      </div>
    );
  }

  // Letter monogram shows immediately (and stays if the favicon 404s / is slow);
  // the real favicon fades in over it once loaded. No blank boxes ever.
  // Softer than pure white in dark mode.
  return (
    <div className={cn(box, 'relative bg-white dark:bg-neutral-200', dim && 'opacity-60')}>
      <span
        className={cn(
          'absolute font-bold uppercase text-neutral-500 dark:text-neutral-600',
          glyph,
          loaded && 'opacity-0'
        )}
      >
        {domain[0]}
      </span>
      <img
        src={faviconUrl(domain, 64)}
        alt=""
        loading="lazy"
        className={cn(
          'relative object-contain transition-opacity',
          compact ? 'size-3.5' : 'size-5',
          !loaded && 'opacity-0'
        )}
        onLoad={() => setLoaded(true)}
        onError={() => setLoaded(false)}
      />
    </div>
  );
}
