import { describe, expect, it, vi } from 'vitest';
import { actionForCombo, getAction } from '../app/actions';
import { lend } from '../app/lent';
import { activeTabWith } from '../app/testShell';
import './keyActions';

const at = (html: string) => { document.body.innerHTML = html; return document.getElementById('t'); };

describe('Ctrl+Enter: Commit', () => {
  it('runs the commit box of the active tab, while it shows', () => {
    activeTabWith();
    expect(actionForCombo('Ctrl+Enter')).toBeUndefined();
    const fn = vi.fn();
    const off = lend('commit.commit', 't', fn);
    expect(actionForCombo('Ctrl+Enter')?.id).toBe('commit.commit');
    off();
  });

  it('leaves Ctrl+Enter to text boxes, the editable working copy and dialogs', () => {
    const yields = getAction('commit.commit')!.yieldsTo!;
    expect(yields(at('<textarea id="t"></textarea>'))).toBe(true);
    expect(yields(at('<div data-editable="true"><div class="monaco-editor"><textarea id="t"></textarea></div></div>'))).toBe(true);
    expect(yields(at('<div role="dialog"><button id="t"></button></div>'))).toBe(true);
    expect(yields(at('<div class="monaco-editor"><textarea id="t"></textarea></div>'))).toBe(false);
    expect(yields(at('<div class="file-list" tabindex="0" id="t"></div>'))).toBe(false);
  });
});
