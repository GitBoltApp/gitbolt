import { create } from 'zustand';

/** What the image viewer shows: the URL the inline image or video already loaded (a `data:` or
 * object URL: never fetched again), and where it lives on the web, for "Open in browser". */
export interface LightboxItem {
  kind: 'image' | 'video';
  url: string;
  alt: string;
  browserUrl: string | null;
}

interface LightboxState {
  item: LightboxItem | null;
  open(item: LightboxItem): void;
  close(): void;
}

export const useLightbox = create<LightboxState>((set) => ({
  item: null,
  open: (item) => set({ item }),
  close: () => set({ item: null }),
}));

export const openLightbox = (item: LightboxItem): void => useLightbox.getState().open(item);
