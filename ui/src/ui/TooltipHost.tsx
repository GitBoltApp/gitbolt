import { useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { isDismissKey, placeBelow, placeBeside } from './HoverTooltip';
import { useKeys } from './keyRouter';
import { hideTooltip, useTooltip } from './tooltipStore';
import './tooltip.css';

/**
 * The page's one imperative tooltip (`showTooltip`), mounted once next to the context menu.
 * It looks like `HoverTooltip`'s (the same class) and is placed the same way. A press, a scroll,
 * a resize or the window losing focus hides it.
 */
export function TooltipHost() {
  const tip = useTooltip((s) => s.tip);
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!tip || !el) return;
    const { width, height } = el.getBoundingClientRect();
    const { left, top } = tip.placement === 'below' ? placeBelow(tip.rect, { width, height }) : placeBeside(tip.rect, { width, height }, tip.placement);
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }, [tip]);
  useLayoutEffect(() => {
    if (!tip) return;
    const hide = () => hideTooltip();
    window.addEventListener('pointerdown', hide, true);
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    window.addEventListener('blur', hide);
    return () => {
      window.removeEventListener('pointerdown', hide, true);
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('resize', hide);
      window.removeEventListener('blur', hide);
    };
  }, [tip]);
  // Esc dismisses it, as a HoverTooltip's does (the key router's `tooltip` layer). Inside a menu
  // (its row tooltips) the menu, one layer up, takes the key first.
  useKeys('tooltip', (e) => {
    if (!isDismissKey(e)) return;
    hideTooltip();
    e.preventDefault();
    return 'handled';
  }, tip !== null);
  if (!tip) return null;
  return createPortal(<div ref={ref} role="tooltip" className="hover-tooltip" data-testid="menu-tooltip" style={{ left: -9999, top: -9999 }}>{tip.text}</div>, document.body);
}
