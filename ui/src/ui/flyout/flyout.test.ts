import { afterEach, describe, expect, it } from 'vitest';
import { closeFlyout, CENTER_KEEP, FLYOUT_W, flyoutOf, flyoutWidth, openFlyout, registerFlyout } from './flyout';

describe('flyoutWidth (spec #4 §5: about 560 px, resizable within bounds)', () => {
  it('is the default or the preferred width, within bounds', () => {
    expect(flyoutWidth(null, 1200)).toBe(FLYOUT_W.default);
    expect(flyoutWidth(400, 1200)).toBe(400);
    expect(flyoutWidth(100, 1200)).toBe(FLYOUT_W.min);
    expect(flyoutWidth(9999, 1200)).toBe(FLYOUT_W.max);
  });

  it(`leaves ${CENTER_KEEP} px of the center beside it, but never shrinks under its minimum while there's room`, () => {
    expect(flyoutWidth(null, 700)).toBe(700 - CENTER_KEEP);
    expect(flyoutWidth(null, 500)).toBe(FLYOUT_W.min);
    expect(flyoutWidth(null, 300)).toBe(300);
  });
});

describe('the flyout registry', () => {
  afterEach(() => closeFlyout('t'));

  it('opens one flyout per tab, the newest replacing the open one', () => {
    const off = registerFlyout('reg-a', () => null);
    const off2 = registerFlyout('reg-b', () => null);
    openFlyout('t', 'reg-a', { n: 1 });
    openFlyout('t', 'reg-b', { n: 2 });
    expect(flyoutOf('t')).toMatchObject({ kind: 'reg-b', props: { n: 2 } });
    expect(flyoutOf('u')).toBeNull();
    closeFlyout('t');
    expect(flyoutOf('t')).toBeNull();
    off();
    off2();
  });

  it('refuses an unknown kind and a second registration', () => {
    expect(() => openFlyout('t', 'nope', {})).toThrow('no flyout nope');
    const off = registerFlyout('reg-c', () => null);
    expect(() => registerFlyout('reg-c', () => null)).toThrow('flyout reg-c is already registered');
    off();
  });
});
