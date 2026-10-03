import { contrastRatio } from '../theme/contrast';
import { THEME_IDS, THEMES } from '../theme/themes';
import { describe, expect, it, vi } from 'vitest';
import { ariaChecked, createCheckBox } from './checkBox';

describe("the merge tool's checkbox (UX round 2)", () => {
  it('is a real checkbox: role, label, aria-checked true/false/mixed', () => {
    const onToggle = vi.fn();
    const box = createCheckBox('Take conflict 1 from Incoming', 'incoming', onToggle);
    expect(box.el.getAttribute('role')).toBe('checkbox');
    expect(box.el.getAttribute('aria-label')).toBe('Take conflict 1 from Incoming');
    expect(box.el.getAttribute('aria-checked')).toBe('false');
    expect(box.el.classList.contains('merge-check-incoming')).toBe(true);
    box.set('some');
    expect(box.el.getAttribute('aria-checked')).toBe('mixed');
    box.set('all');
    expect(box.el.getAttribute('aria-checked')).toBe('true');
    box.el.click();
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(ariaChecked('none')).toBe('false');
  });
});

describe('tick contrast', () => {
  // Every theme: its tick (themes.ts tickOn) on each side's fill. 4.5:1 where the palette allows it;
  // never under WCAG 1.4.11's 3:1 for a graphic.
  const cases = THEME_IDS.flatMap((id) => (['conflict-ours', 'conflict-theirs'] as const).map((side) => [id, side] as const));
  it.each(cases)('%s: the tick on %s reads', (id, side) => {
    const c = THEMES[id].colors;
    expect(contrastRatio(c[`${side}-tick`], c[side])).toBeGreaterThanOrEqual(id === 'default-dark' ? 4.5 : 3);
  });
});
