export interface SvgSize { w: number; h: number }

const UNIT_PX: Record<string, number> = { '': 1, px: 1, pt: 4 / 3, pc: 16, in: 96, cm: 96 / 2.54, mm: 96 / 25.4, q: 96 / 101.6 };

/** An absolute CSS length in px; null for a percentage, a relative unit or garbage. */
function lengthPx(v: string | null | undefined): number | null {
  const m = /^\s*([+]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s*([a-z%]*)\s*$/i.exec(v ?? '');
  const f = m ? UNIT_PX[m[2].toLowerCase()] : undefined;
  if (!m || f === undefined) return null;
  const n = Number(m[1]) * f;
  return n > 0 && Number.isFinite(n) ? n : null;
}

/**
 * An SVG's intrinsic size, as a browser would give a standalone image: absolute width and height
 * on the root win; otherwise the viewBox's own size (one given length scales the other by the
 * viewBox ratio). Percentages and relative units count as absent. Null when nothing determines a
 * size: the caller keeps the browser's default (150×150).
 */
export function svgIntrinsicSize(text: string): SvgSize | null {
  const tag = /<svg\b((?:"[^"]*"|'[^']*'|[^>"'])*)>/i.exec(text.replace(/<!--[\s\S]*?-->/g, ''));
  if (!tag) return null;
  const attr = (name: string) => new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(tag[1])?.slice(1).find((x) => x !== undefined) ?? null;
  const vb = (attr('viewBox') ?? '').trim().split(/[\s,]+/).map(Number);
  const box = vb.length === 4 && vb.every(Number.isFinite) && vb[2] > 0 && vb[3] > 0 ? { w: vb[2], h: vb[3] } : null;
  const w = lengthPx(attr('width'));
  const h = lengthPx(attr('height'));
  if (w && h) return { w, h };
  if (!box) return null;
  if (w) return { w, h: (w * box.h) / box.w };
  if (h) return { w: (h * box.w) / box.h, h };
  return box;
}
