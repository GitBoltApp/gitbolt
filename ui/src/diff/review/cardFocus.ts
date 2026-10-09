import { useRef, type FocusEvent } from 'react';

/**
 * Whether the keyboard is in a review card: it took focus there and hasn't moved it elsewhere.
 * A control the card loses (an edit closing, a thread folding, the card going) then hands the
 * keyboard on, rather than leaving it on the page (`<body>`, where the next Esc closes the diff).
 * A focused control that's removed may fire no blur, or one with no `relatedTarget`: only a move
 * to another element counts as leaving. `props` go on the card's root.
 */
export function useCardFocus() {
  const inside = useRef(false);
  const props = {
    onFocus: () => { inside.current = true; },
    onBlur: (e: FocusEvent<HTMLElement>) => { if (e.relatedTarget instanceof Node && !e.currentTarget.contains(e.relatedTarget)) inside.current = false; },
  };
  /** The keyboard was in the card, and is now nowhere. */
  const dropped = () => inside.current && (document.activeElement === null || document.activeElement === document.body);
  return { props, dropped };
}
