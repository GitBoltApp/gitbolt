import { errorMessage } from '../api/client';
import { ICONS } from '../menu/icons';
import type { MenuRow } from '../menu/types';
import { useToast } from '../ui/toastStore';
import { copyImage } from './copyImage';
import type { ImageSource } from './sources';

export type ImageSide = 'old' | 'new';

/** The image context menu (K98). `sides`: the images on screen; `first`: the side right-clicked
 * (side-by-side) is listed first. One image alone is plain "Copy Image". */
export function imageMenuRows(sides: { old: ImageSource | null; new: ImageSource | null }, first: ImageSide = 'old', copy: (s: ImageSource) => Promise<void> = copyImage): MenuRow[] {
  const toast = useToast.getState().show;
  const row = (id: string, label: string, src: ImageSource): MenuRow => ({
    kind: 'action', id, label, icon: ICONS.copy, tooltip: `${label} to the clipboard as a PNG`,
    run: () => { copy(src).then(() => toast('Image copied'), (e: unknown) => toast(errorMessage(e))); },
  });
  if (sides.old && sides.new) {
    const rows = [row('copy-old', 'Copy Old Image', sides.old), row('copy-new', 'Copy New Image', sides.new)];
    return first === 'new' ? rows.reverse() : rows;
  }
  const only = sides.old ?? sides.new;
  return only ? [row('copy-image', 'Copy Image', only)] : [];
}
