/** Multiplies RGB so small differences become visible, and forces every pixel opaque (spec §10.4). */
export function brighten(data: Uint8ClampedArray, factor = 4): void {
  for (let i = 0; i < data.length; i += 4) {
    data[i] *= factor;
    data[i + 1] *= factor;
    data[i + 2] *= factor;
    data[i + 3] = 255;
  }
}

/** Draws |a − b| (the canvas `difference` blend) on a black background, then brightens it by
 * `amplify` — the TRUE multiplier (K10 fix round 1): 1× is the raw, unamplified difference, and
 * the 1×–16× Amplify slider multiplies it up from there so near-identical images show where they
 * differ. The default is 4×, matching the look of the old fixed ×4 brighten. Re-run whenever
 * `amplify` changes (cheap: two small `drawImage` calls), independent of the transform that
 * zooms/pans the canvas element — pixelated rendering and zoom/pan are untouched either way. */
export function drawDifference(canvas: HTMLCanvasElement, a: HTMLImageElement | null, b: HTMLImageElement | null, w: number, h: number, amplify = 4): void {
  canvas.width = Math.max(1, w);
  canvas.height = Math.max(1, h);
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (a) ctx.drawImage(a, 0, 0);
  ctx.globalCompositeOperation = 'difference';
  if (b) ctx.drawImage(b, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  brighten(img.data, amplify);
  ctx.putImageData(img, 0, 0);
}
