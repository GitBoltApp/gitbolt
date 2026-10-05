import type { CSSProperties } from 'react';

/** Black or white, whichever reads better on `#rrggbb` (WCAG relative luminance, as GitHub picks it); undefined for anything else. */
export function chipText(color: string): string | undefined {
  const m = /^#?([0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return undefined;
  const lin = (i: number) => {
    const c = parseInt(m[1].slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * lin(0) + 0.7152 * lin(2) + 0.0722 * lin(4);
  return luminance > 0.4 ? '#000' : '#fff';
}

/** A forge label's colour reaches CSS as `--chip-color`, with `--chip-text` readable on it (the CSS itself uses tokens only). */
export const chipStyle = (color?: string | null): CSSProperties | undefined => {
  if (!color) return undefined;
  const text = chipText(color);
  return { '--chip-color': color, ...(text ? { '--chip-text': text } : {}) } as CSSProperties;
};
