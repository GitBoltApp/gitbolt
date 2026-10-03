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
