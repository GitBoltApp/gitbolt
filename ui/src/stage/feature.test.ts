import { describe, expect, it } from 'vitest';
import { stagingKeyTarget } from './feature';

const el = (html: string, pick: string) => {
  document.body.innerHTML = html;
  return document.querySelector(pick);
};

describe('where Ctrl+Z is staging undo (spec #2 §7.6)', () => {
  it('in the diff view and the WIP file list, a read-only Monaco included', () => {
    expect(stagingKeyTarget(el('<section class="diff-panel"><div class="monaco-editor"><textarea id="t"></textarea></div></section>', '#t'))).toBe(true);
    expect(stagingKeyTarget(el('<div class="wip-sections"><div class="file-list" tabindex="0" id="l"></div></div>', '#l'))).toBe(true);
  });

  it('not while editing the working copy, in a text box, or anywhere else', () => {
    expect(stagingKeyTarget(el('<section class="diff-panel"><div data-editable="true"><div class="monaco-editor"><textarea id="t"></textarea></div></div></section>', '#t'))).toBe(false);
    expect(stagingKeyTarget(el('<div class="details-panel"><input id="i"></div>', '#i'))).toBe(false);
    expect(stagingKeyTarget(el('<div class="graph"><div id="g" tabindex="0"></div></div>', '#g'))).toBe(false);
  });
});
