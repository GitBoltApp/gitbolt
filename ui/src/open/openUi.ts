import { create } from 'zustand';

/** `file.clone` asks the Open tab `focusClone` to focus its URL field (`CloneForm`). */
export const useOpenUi = create<{ focusClone: string | null; requestClone(tabId: string): void; consume(): void }>((set) => ({
  focusClone: null,
  requestClone: (tabId) => set({ focusClone: tabId }),
  consume: () => set({ focusClone: null }),
}));
