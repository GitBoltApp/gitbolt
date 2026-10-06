/** "Match sizes" (image diff): the old image drawn at the new one's size, so a resized image's
 * swipe, onion skin and difference compare the same pixels. Sizes are the images' natural sizes,
 * or an SVG's rendered (intrinsic) size. */
export interface Size { w: number; h: number }
/** Where the old image sits in the new one's box, in the new image's pixels. */
export interface Rect { x: number; y: number; w: number; h: number }

/** How far apart two aspect ratios may be and still count as a pure resize. */
export const ASPECT_TOLERANCE = 0.01;

/** Whether the toggle applies: both sizes known, and not the same. */
export const sizesDiffer = (a: Size | null | undefined, b: Size | null | undefined): boolean => !!a && !!b && (a.w !== b.w || a.h !== b.h);

/** Aspect ratios within `ASPECT_TOLERANCE` of each other. */
export function aspectsMatch(a: Size, b: Size): boolean {
  if (a.w <= 0 || a.h <= 0 || b.w <= 0 || b.h <= 0) return false;
  return Math.abs((a.w / a.h) / (b.w / b.h) - 1) <= ASPECT_TOLERANCE;
}

/** The toggle's default: on for a pure resize, off for anything else (a crop, another image). */
export const defaultMatch = (a: Size | null | undefined, b: Size | null | undefined): boolean => sizesDiffer(a, b) && aspectsMatch(a!, b!);

/** The factor that takes the old image to the new one's size: the `contain` fit's. */
export const matchScale = (old: Size, neu: Size): number => Math.min(neu.w / old.w, neu.h / old.h);

/** The old image's place in the new one's box: the whole box for a pure resize, otherwise fitted
 * inside it (`contain`) and centred, the rest left as letterbox. */
export function matchedRect(old: Size, neu: Size): Rect {
  if (aspectsMatch(old, neu)) return { x: 0, y: 0, w: neu.w, h: neu.h };
  const s = matchScale(old, neu);
  const w = old.w * s;
  const h = old.h * s;
  return { x: (neu.w - w) / 2, y: (neu.h - h) / 2, w, h };
}

/** The user's pick per file key, for this session (like `useSlowMarkdown`'s per-file memory). */
const picks = new Map<string, boolean>();
export const rememberedMatch = (key: string | undefined): boolean | undefined => (key === undefined ? undefined : picks.get(key));
export function rememberMatch(key: string | undefined, on: boolean): void {
  if (key !== undefined) picks.set(key, on);
}
