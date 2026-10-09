import { CircleHelp } from 'lucide-react';
import { describe, expect, it, vi } from 'vitest';
import type { Action } from '../../app/actions';
import { blockCommenter, setBlockCommenter, withBlockComment } from './blockComment';

const action = (when: boolean, keysBy?: string): Action => ({ id: 'x', label: 'Comment', group: 'View', icon: CircleHelp, tooltip: 'Comment on the line', when: () => when, run: vi.fn(), ...(keysBy ? { keysBy } : {}) });

describe('the comment key over a rendered diff (spec 2026-10-08 §3)', () => {
  it("runs the rendered diff's commenter while one is set, else the action's own", () => {
    const a = action(false);
    const wrapped = withBlockComment(a);
    expect(wrapped.when!()).toBe(false);
    const fn = vi.fn();
    const off = setBlockCommenter(fn);
    expect(wrapped.when!()).toBe(true);
    void wrapped.run();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(a.run).not.toHaveBeenCalled();
    off();
    expect(blockCommenter()).toBeNull();
  });

  it("the hidden editor's comment doesn't run while the rendered diff shows", () => {
    const a = action(true);
    const off = setBlockCommenter(vi.fn());
    void withBlockComment(a).run();
    expect(a.run).not.toHaveBeenCalled();
    off();
    void withBlockComment(a).run();
    expect(a.run).toHaveBeenCalledTimes(1);
  });

  it('a key the editor takes itself reaches the app while the rendered diff shows', () => {
    const wrapped = withBlockComment(action(true, 'diff/monaco'));
    expect(wrapped.keysBy).toBe('diff/monaco');
    const off = setBlockCommenter(vi.fn());
    expect(wrapped.keysBy).toBeUndefined();
    off();
  });

  it('a removal leaves a newer commenter in place', () => {
    const offA = setBlockCommenter(vi.fn());
    const b = vi.fn();
    const offB = setBlockCommenter(b);
    offA();
    expect(blockCommenter()).toBe(b);
    offB();
  });
});

describe("Plan 2's comment action", () => {
  it('review.comment runs the rendered diff\'s commenter while one is set', async () => {
    await import('../../app/features');
    const { getAction } = await import('../../app/actions');
    const fn = vi.fn();
    const off = setBlockCommenter(fn);
    expect(getAction('review.comment')?.when?.()).toBe(true);
    void getAction('review.comment')!.run();
    expect(fn).toHaveBeenCalledTimes(1);
    off();
  }, 60000);
});
