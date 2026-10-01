import { inTauri } from '../api/transport';
import type { ImageSource } from './sources';

/** The image as PNG bytes: drawn to a canvas at its natural size (an SVG at its intrinsic size,
 * K81), since clipboards generally want image/png whatever the file's own format. */
export async function imagePng(src: ImageSource): Promise<Blob> {
  const img = new Image();
  img.src = src.url;
  await img.decode();
  const w = src.intrinsic?.w ?? img.naturalWidth;
  const h = src.intrinsic?.h ?? img.naturalHeight;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w));
  canvas.height = Math.max(1, Math.round(h));
  canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode the image'))), 'image/png'));
}

/** Puts the image on the system clipboard as PNG. The browser's own clipboard first (as `copyText`
 * does, H19); the app's clipboard plugin only when the browser refuses. */
export async function copyImage(src: ImageSource): Promise<void> {
  const png = imagePng(src);
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
  } catch (e) {
    if (!inTauri()) throw e;
    // Raw PNG bytes need tauri's `image-png` feature to be decoded; RGBA pixels don't.
    const { writeImage } = await import('@tauri-apps/plugin-clipboard-manager');
    const { Image: TauriImage } = await import('@tauri-apps/api/image');
    const bmp = await createImageBitmap(await png);
    const canvas = document.createElement('canvas');
    canvas.width = bmp.width;
    canvas.height = bmp.height;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(bmp, 0, 0);
    const { data } = ctx.getImageData(0, 0, bmp.width, bmp.height);
    await writeImage(await TauriImage.new(new Uint8Array(data.buffer), bmp.width, bmp.height));
  }
}
