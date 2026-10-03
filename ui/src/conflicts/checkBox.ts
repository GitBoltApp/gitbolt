import type { CheckState, Side } from './model';

/**
 * The merge tool's own checkbox (UX round 2): a 14px rounded square, outlined in its side's
 * conflict colour, filled with a dark tick (`--conflict-*-tick`, >= 4.5:1 on the fill) when taken, a dash when partly taken. A real control:
 * a `button` with `role="checkbox"` and `aria-checked` (`mixed` for partly). Shared by the hunk
 * column (a DOM widget in Monaco's glyph margin, `createCheckBox`) and the panes' "Take all from
 * this side" (`MergeTool`'s `SideCheck`, same class and markup). Styles: mergeTool.css
 * `.merge-check`.
 */
export const ariaChecked = (s: CheckState): 'true' | 'false' | 'mixed' => (s === 'all' ? 'true' : s === 'some' ? 'mixed' : 'false');

/** The glyphs, both drawn; CSS shows the one `aria-checked` asks for. */
export const CHECK_GLYPH = '<svg viewBox="0 0 14 14" aria-hidden="true" focusable="false"><path class="merge-check-tick" d="M3.5 7.2l2.3 2.3 4.7-4.9"/><path class="merge-check-dash" d="M4 7h6"/></svg>';

/** A hunk's checkbox, for the glyph-margin widget. `set` paints its state. */
export function createCheckBox(label: string, side: Side, onToggle: () => void): { el: HTMLButtonElement; set: (s: CheckState) => void } {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = `merge-check merge-check-${side}`;
  el.setAttribute('role', 'checkbox');
  el.setAttribute('aria-checked', 'false');
  el.setAttribute('aria-label', label);
  el.innerHTML = CHECK_GLYPH;
  el.addEventListener('click', onToggle);
  return { el, set: (s) => el.setAttribute('aria-checked', ariaChecked(s)) };
}
