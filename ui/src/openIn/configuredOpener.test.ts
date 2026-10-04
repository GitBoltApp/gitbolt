import { describe, expect, it } from 'vitest';
import { configuredOpenerId } from './configuredOpener';

const tab = (id: string, path: string) => ({ id, kind: 'repo' as const, path, alias: null });
const base = { tabs: [tab('t1', '/r/a'), tab('t2', '/r/b')], activeTab: 't1', repos: {}, editor: null };

describe('configuredOpenerId', () => {
  it('is null when nothing is chosen (the last used opener is the default then)', () => {
    expect(configuredOpenerId(base)).toBeNull();
  });
  it("uses the profile's editor: an opener's id, or custom", () => {
    expect(configuredOpenerId({ ...base, editor: { kind: 'opener', id: 'vscode' } })).toBe('vscode');
    expect(configuredOpenerId({ ...base, editor: { kind: 'custom', template: 'ed {file}' } })).toBe('custom');
  });
  it("the active repository's own setting wins over the profile's", () => {
    const repos = { '/r/a': { pin: null, columns: null, hiddenColumns: [], sidebarSort: {}, collapsed: [], mrFilter: null, editor: { kind: 'opener' as const, id: 'zed' } } };
    const p = { ...base, repos, editor: { kind: 'opener' as const, id: 'vscode' } };
    expect(configuredOpenerId(p)).toBe('zed');
    expect(configuredOpenerId({ ...p, activeTab: 't2' })).toBe('vscode');
  });
});
