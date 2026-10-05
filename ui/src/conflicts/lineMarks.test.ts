import { describe, expect, it, vi } from 'vitest';
import { createHoverTracker, dimmed, regionMarks, resolveMarkColors } from './lineMarks';

const colors = { current: '#111111', incoming: '#222222', base: '#333333' };

describe('regionMarks', () => {
  it('colours each side in the minimap and the overview ruler', () => {
    expect(regionMarks(colors, 'current').minimap.color).toBe('#111111');
    expect(regionMarks(colors, 'incoming').overviewRuler.color).toBe('#222222');
  });
  it('shows a resolved output region dimmer than an unresolved one', () => {
    const un = regionMarks(colors, 'unresolved');
    const re = regionMarks(colors, 'resolved');
    expect(un.minimap.color).toBe('#333333');
    expect(re.minimap.color).toBe(dimmed('#333333'));
    expect(re.overviewRuler.color).not.toBe(un.overviewRuler.color);
  });
});

describe('resolveMarkColors', () => {
  it('reads the conflict tokens from the root', () => {
    document.documentElement.style.setProperty('--conflict-ours', '#010203');
    expect(resolveMarkColors().current).toBe('#010203');
  });
});

describe('createHoverTracker', () => {
  it('moves with the pointer, clears on leave, and fires only on a change', () => {
    const on = vi.fn();
    const t = createHoverTracker(on);
    t.move(3);
    t.move(3);
    expect(on).toHaveBeenCalledTimes(1);
    t.move(4);
    expect(t.current()).toBe(4);
    t.move(undefined);
    expect(t.current()).toBeNull();
    t.move(5);
    t.leave();
    expect(on).toHaveBeenLastCalledWith(null);
  });
});
