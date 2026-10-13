// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { mergeEditorOptions } from './editors';

describe('mergeEditorOptions', () => {
  it('turns the minimap and overview ruler on, as the diff view does', () => {
    for (const ro of [true, false]) {
      const o = mergeEditorOptions(ro, false, 13);
      expect(o.minimap.enabled).toBe(true);
      expect(o.renderOverviewRuler).toBe(true);
    }
  });
});

describe('syncScroll: the three editors scroll together', () => {
  type Change = { scrollTopChanged: boolean; scrollLeftChanged: boolean };
  /** An editor `height` px tall over `content` px of text, its scroll Monaco's (clamped, then an
   * event). */
  function fake(content: number, height = 100, width = 1000) {
    const cbs: ((e: Change) => void)[] = [];
    const ed = {
      top: 0,
      left: 0,
      onDidScrollChange: (cb: (e: Change) => void) => { cbs.push(cb); return { dispose() {} }; },
      getScrollTop: () => ed.top,
      getScrollLeft: () => ed.left,
      getScrollHeight: () => content,
      getLayoutInfo: () => ({ height }),
      setScrollTop: (t: number) => { const was = ed.top; ed.top = Math.max(0, Math.min(content - height, t)); if (ed.top !== was) for (const cb of cbs) cb({ scrollTopChanged: true, scrollLeftChanged: false }); },
      setScrollLeft: (l: number) => { const was = ed.left; ed.left = Math.max(0, Math.min(width, l)); if (ed.left !== was) for (const cb of cbs) cb({ scrollTopChanged: false, scrollLeftChanged: true }); },
    };
    return ed;
  }

  it('down: the same fraction of each one\'s range; sideways (a horizontal wheel): the same px', async () => {
    const { syncScroll } = await import('./editors');
    const [current, incoming, output] = [fake(300), fake(500), fake(200, 100, 50)];
    syncScroll([current, incoming, output]);
    current.setScrollTop(100); // half of its 200
    expect([incoming.top, output.top]).toEqual([200, 50]);
    incoming.setScrollLeft(120);
    expect([current.left, output.left]).toEqual([120, 50]); // the output's lines are shorter: clamped
    expect([current.top, incoming.top, output.top]).toEqual([100, 200, 50]); // sideways moves nothing down
  });

  it('quiet: a reveal places each editor itself', async () => {
    const { syncScroll } = await import('./editors');
    const [a, b] = [fake(300), fake(300)];
    const sync = syncScroll([a, b]);
    sync.quiet(() => { a.setScrollLeft(80); a.setScrollTop(50); });
    expect([b.left, b.top]).toEqual([0, 0]);
  });
});
