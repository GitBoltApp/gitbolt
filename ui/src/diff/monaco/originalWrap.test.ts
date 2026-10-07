import { describe, expect, it, vi } from 'vitest';
import { keepOriginalWrap } from './originalWrap';

const OPTION = 154 as Parameters<typeof keepOriginalWrap>[1];

function editor(width: number, override2: 'off' | 'on' | 'inherit') {
  let listener: (() => void) | null = null;
  const ed = {
    width,
    override2,
    getLayoutInfo: () => ({ width: ed.width }),
    getOption: () => ed.override2,
    updateOptions: vi.fn((o: { wordWrapOverride2?: 'off' | 'on' | 'inherit' }) => { if (o.wordWrapOverride2) ed.override2 = o.wordWrapOverride2; }),
    onDidLayoutChange: (l: () => void) => { listener = l; return { dispose: () => { listener = null; } }; },
    layout: () => listener?.(),
  };
  return ed;
}

describe('keepOriginalWrap: the left side of a split diff wraps like the right', () => {
  it("clears Monaco's leftover inline-mode override once the original side is shown again", () => {
    const ed = editor(400, 'off');
    keepOriginalWrap(ed as never, OPTION);
    ed.layout();
    expect(ed.updateOptions).toHaveBeenCalledWith({ wordWrapOverride2: 'inherit' });
    expect(ed.override2).toBe('inherit');
  });

  it('leaves the hidden original editor of an inline diff alone', () => {
    const ed = editor(0, 'off');
    keepOriginalWrap(ed as never, OPTION);
    ed.layout();
    expect(ed.updateOptions).not.toHaveBeenCalled();
  });

  it('does nothing when there is no override to clear', () => {
    const ed = editor(400, 'inherit');
    keepOriginalWrap(ed as never, OPTION);
    ed.layout();
    expect(ed.updateOptions).not.toHaveBeenCalled();
  });
});
