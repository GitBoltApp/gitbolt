type RGB = [number, number, number];

function parse(c: string): { rgb: RGB; a: number } {
  const hex = c.trim().match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return { rgb: [(n >> 16) & 255, (n >> 8) & 255, n & 255], a: 1 };
  }
  const m = c.trim().match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/i);
  if (m) return { rgb: [Number(m[1]), Number(m[2]), Number(m[3])], a: m[4] === undefined ? 1 : Number(m[4]) };
  throw new Error(`unsupported color: ${c}`);
}

const channel = (v: number) => {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const luminance = ([r, g, b]: RGB) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);

/** WCAG 2 contrast ratio of `fg` (composited if translucent) over the opaque `bg`. */
export function contrastRatio(fg: string, bg: string): number {
  const b = parse(bg);
  if (b.a !== 1) throw new Error(`background must be opaque: ${bg}`);
  const f = parse(fg);
  const mixed = f.rgb.map((v, i) => v * f.a + b.rgb[i] * (1 - f.a)) as RGB;
  const [hi, lo] = [luminance(mixed), luminance(b.rgb)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
