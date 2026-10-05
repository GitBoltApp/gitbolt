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
