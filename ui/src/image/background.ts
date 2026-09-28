import { create } from 'zustand';

/**
 * What an image diff shows behind transparent pixels (H30): the checkerboard (default), black,
 * white, or a mid-grey (#808080, where both light and dark artwork stay visible). The
 * difference view keeps its black canvas whatever the pick.
 */
export type ImageBackground = 'checker' | 'black' | 'white' | 'grey';
export const IMAGE_BACKGROUNDS: { id: ImageBackground; label: string }[] = [
  { id: 'checker', label: 'Checkerboard background' },
  { id: 'black', label: 'Black background' },
  { id: 'white', label: 'White background' },
  { id: 'grey', label: 'Grey background' },
];
export const IMAGE_BACKGROUND_STORAGE_KEY = 'gitbolt.imageBackground.v1';

const isBackground = (v: unknown): v is ImageBackground => IMAGE_BACKGROUNDS.some((b) => b.id === v);

/** THE persistence seam for the image background: localStorage until plan 1C's settings store.
 * Guarded: blocked or full storage keeps the pick for the window's life. */
export const imageBackgroundPersistence = {
  load(): ImageBackground {
    try {
      const raw = globalThis.localStorage.getItem(IMAGE_BACKGROUND_STORAGE_KEY);
      return isBackground(raw) ? raw : 'checker';
    } catch {
      return 'checker';
    }
  },
  save(b: ImageBackground): void {
    try {
      globalThis.localStorage.setItem(IMAGE_BACKGROUND_STORAGE_KEY, b);
    } catch {
      // In memory only.
    }
  },
};

export const useImageBackground = create<{ background: ImageBackground; set(b: ImageBackground): void }>((set) => ({
  background: imageBackgroundPersistence.load(),
  set: (background) => {
    imageBackgroundPersistence.save(background);
    set({ background });
  },
}));
