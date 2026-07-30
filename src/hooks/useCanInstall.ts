import { useSyncExternalStore } from 'react';
import { canInstall, subscribeInstall } from '../lib/pwaInstall';

/** Live: whether the browser currently has an install prompt available for this app. */
export function useCanInstall(): boolean {
  return useSyncExternalStore(subscribeInstall, canInstall, () => false);
}
