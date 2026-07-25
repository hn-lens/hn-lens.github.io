import { useEffect, useState } from 'react';

/** Have we scrolled far enough to offer "back to top"? Shared so the phone affordance in the sticky
 * TopNav and the desktop FAB use one threshold and can't drift apart. (Lives in its own module so
 * neither component file exports a non-component — that breaks fast refresh and trips oxlint.) */
export function useScrolledPast(px = 800): boolean {
  const [past, setPast] = useState(false);
  useEffect(() => {
    const onScroll = () => setPast(window.scrollY > px);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [px]);
  return past;
}

export function scrollToTop(): void {
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
