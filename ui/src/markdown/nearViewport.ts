import { useEffect, useState, type RefObject } from 'react';

/** Whether `ref`'s element is within `margin` of the viewport, once (it stays true): code blocks
 * highlight and diagrams draw only where the reader is (ruling 21). Without IntersectionObserver
 * (jsdom), always. */
export function useNearViewport(ref: RefObject<Element | null>, margin = '800px'): boolean {
  const [near, setNear] = useState(() => typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    if (near || !ref.current) return;
    const io = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) { setNear(true); io.disconnect(); } }, { rootMargin: margin });
    io.observe(ref.current);
    return () => io.disconnect();
  }, [near, ref, margin]);
  return near;
}
