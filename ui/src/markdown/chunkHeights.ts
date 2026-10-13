import { useEffect, useState } from 'react';

/** A learned height per character this close to the one in use is kept: no re-render for noise. */
const KEEP_WITHIN = 0.05;

/** The height per source character of the chunks laid out so far (their real heights over their
 * `gbChars`), or null with none. */
export function pxPerCharOf(laid: readonly { height: number; chars: number }[]): number | null {
  let height = 0;
  let chars = 0;
  for (const c of laid) {
    if (!(c.height > 0) || !(c.chars > 0)) continue;
    height += c.height;
    chars += c.chars;
  }
  return chars > 0 ? height / chars : null;
}

/**
 * A rendered diff's height per source character, learned from its chunks (`.md-chunk`, with
 * `data-chars`) in `body` as each is first laid out, for the rest's placeholders: `chunkHeightOf`'s
 * fixed factor is File View prose's, and a diff (both sides of a change, its marks, lists and short
 * lines) runs about twice as tall, so the scroll height, the ruler's marks and its slider were far
 * off until the view reached each chunk. A chunk tells it's laid out by its
 * `contentvisibilityautostatechange` (`skipped: false`); where that never fires (not Chromium),
 * the fixed factor stays. Null until a chunk has laid out.
 */
export function useLearnedPxPerChar(body: HTMLElement | null, on: boolean): number | null {
  const [px, setPx] = useState<number | null>(null);
  useEffect(() => {
    if (!on || !body) return;
    const laid = new Set<HTMLElement>();
    let frame = 0;
    // A frame later: the chunk is laid out at its real height by then.
    const learn = () => {
      frame = 0;
      const next = pxPerCharOf([...laid].filter((c) => c.isConnected).map((c) => ({ height: c.offsetHeight, chars: Number(c.dataset.chars) })));
      if (next !== null) setPx((was) => (was !== null && Math.abs(next - was) <= was * KEEP_WITHIN ? was : next));
    };
    const onState = (e: Event) => {
      const chunk = e.target as HTMLElement;
      if ((e as Event & { skipped?: boolean }).skipped !== false || !chunk.classList?.contains('md-chunk')) return;
      laid.add(chunk);
      if (!frame) frame = requestAnimationFrame(learn);
    };
    body.addEventListener('contentvisibilityautostatechange', onState, true);
    return () => {
      cancelAnimationFrame(frame);
      body.removeEventListener('contentvisibilityautostatechange', onState, true);
    };
  }, [body, on]);
  return on ? px : null;
}
