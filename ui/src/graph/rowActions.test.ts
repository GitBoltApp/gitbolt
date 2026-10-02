import { describe, expect, it, vi } from 'vitest';
import type { RefLabel } from '../api/gen/RefLabel';
import type { RowPayload } from '../api/gen/RowPayload';
import type { RepoViewStore } from '../repo/store';
import { graphLabelDoubleClick, graphRowDoubleClick, registerGraphDoubleClick } from './rowActions';

const store = {} as RepoViewStore;
const row = { id: 'abc', kind: 'commit' } as RowPayload;
const label = { name: 'main', local: 'refs/heads/main' } as RefLabel;

describe('graph double-clicks (spec #2 §9.3, §11.2)', () => {
  it('runs the first handler that takes it', () => {
    const a = vi.fn(() => false);
    const b = vi.fn(() => true);
    const offA = registerGraphDoubleClick({ label: a });
    const offB = registerGraphDoubleClick({ label: b, row: () => true });
    expect(graphLabelDoubleClick(store, row, label)).toBe(true);
    expect(a).toHaveBeenCalledWith(store, row, label);
    expect(b).toHaveBeenCalled();
    expect(graphRowDoubleClick(store, row)).toBe(true);
    offA();
    offB();
    expect(graphLabelDoubleClick(store, row, label)).toBe(false);
  });
});
