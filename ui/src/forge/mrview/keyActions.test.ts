import { describe, expect, it, vi } from 'vitest';
import { actionForCombo, getAction, runAction } from '../../app/actions';
import { lend } from '../../app/lent';
import { activeTabWith } from '../../app/testShell';
import './keyActions';

describe('the MR/PR view keys: Ctrl+Shift+A approve, Ctrl+Shift+M merge, Ctrl+Shift+O open in browser', () => {
  it('run what the open view lends, and take no key without one', () => {
    activeTabWith();
    for (const k of ['Ctrl+Shift+A', 'Ctrl+Shift+M', 'Ctrl+Shift+O']) expect(actionForCombo(k), k).toBeUndefined();
    const approve = vi.fn();
    const off = lend('mr.approve', 't', approve);
    expect(actionForCombo('Ctrl+Shift+A')?.id).toBe('mr.approve');
    runAction('mr.approve');
    expect(approve).toHaveBeenCalledOnce();
    off();
  });

  it('not while typing a comment', () => {
    document.body.innerHTML = '<textarea id="t"></textarea>';
    expect(getAction('mr.merge')!.yieldsTo!(document.getElementById('t'))).toBe(true);
  });
});
