import { useEffect, useRef } from 'react';
import { trackForItem } from '../lib/interactions';
import type { HnItem } from '../types';

// One impression per item per session.
const impressed = new Set<number>();

export function useImpression<T extends HTMLElement>(item: HnItem) {
  const ref = useRef<T | null>(null);
  const itemRef = useRef(item);
  itemRef.current = item;

  useEffect(() => {
    const el = ref.current;
    const id = itemRef.current.id;
    if (!el || impressed.has(id)) return;

    let timer: number | undefined;
    const obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting && e.intersectionRatio >= 0.5) {
            timer = window.setTimeout(() => {
              if (!impressed.has(id)) {
                impressed.add(id);
                trackForItem('impression', itemRef.current);
              }
              obs.disconnect();
            }, 700);
          } else if (timer) {
            clearTimeout(timer);
            timer = undefined;
          }
        }
      },
      { threshold: [0, 0.5, 1] }
    );
    obs.observe(el);
    return () => {
      if (timer) clearTimeout(timer);
      obs.disconnect();
    };
  }, []);

  return ref;
}
