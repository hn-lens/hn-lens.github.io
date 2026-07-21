import { create } from 'zustand';

interface UiStore {
  commentsId: number | null;
  openComments: (id: number) => void;
  closeComments: () => void;
}

export const useUi = create<UiStore>((set) => ({
  commentsId: null,
  openComments: (id) => set({ commentsId: id }),
  closeComments: () => set({ commentsId: null }),
}));
