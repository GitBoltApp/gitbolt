import { describe, expect, it, vi } from 'vitest';
import { swallowGestureClick } from './swallowClick';

describe('swallowGestureClick', () => {
  it('eats the click of the gesture, before any handler under it, and only that one', () => {
    const btn = document.createElement('button');
    const onClick = vi.fn();
    btn.addEventListener('click', onClick);
    document.body.append(btn);
    swallowGestureClick((e) => e.target === btn);
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(onClick).not.toHaveBeenCalled();
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onClick).toHaveBeenCalledOnce();
    btn.remove();
  });

  it('a press that never clicks does not swallow a later click', async () => {
    const btn = document.createElement('button');
    const onClick = vi.fn();
    btn.addEventListener('click', onClick);
    document.body.append(btn);
    swallowGestureClick(() => true);
    window.dispatchEvent(new Event('pointerup'));
    await new Promise((r) => setTimeout(r, 5));
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onClick).toHaveBeenCalledOnce();
    btn.remove();
  });
});
