import { create } from 'zustand';

export interface Toast {
  id: number;
  message: string;
  actionLabel?: string;
  onAction?: () => void;
}

interface ToastStore {
  toasts: Toast[];
  push: (t: Omit<Toast, 'id'>) => void;
  dismiss: (id: number) => void;
}

let seq = 1;

const MAX_TOASTS = 3; // never stack more than this at once
const TOAST_MS = 4000;

export const useToast = create<ToastStore>((set) => ({
  toasts: [],
  push: (t) => {
    const id = seq++;
    set((s) => {
      // Don't stack duplicate action-less toasts (e.g. tapping Save on several
      // stories all show "Saved") — that piled up and lingered. Toasts with an
      // action (e.g. Hide → Undo) are per-item, so they're never de-duped.
      const dup = !t.onAction && s.toasts.some((x) => !x.onAction && x.message === t.message);
      let next = dup ? s.toasts : [...s.toasts, { ...t, id }];
      if (next.length > MAX_TOASTS) next = next.slice(next.length - MAX_TOASTS); // cap concurrent
      return { toasts: next };
    });
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })), TOAST_MS);
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })),
}));

/** Fire a toast from anywhere (non-hook). */
export const toast = (t: Omit<Toast, 'id'>) => useToast.getState().push(t);
