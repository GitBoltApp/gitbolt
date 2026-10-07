import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const goToChange = vi.hoisted(() => vi.fn());
vi.mock('./DiffToolbar', () => ({ goToChange }));

import { actionForCombo, getAction, runAction } from '../app/actions';
import { activeTabWith } from '../app/testShell';
import type { FileListPayload } from '../api/gen/FileListPayload';
import type { DiffSpec } from '../api/gen/DiffSpec';
import { useFileListPrefs } from '../files/fileListPrefs';
import type { DiffTarget, PanelContent } from '../repo/store';
import { useChangeKeys } from './changeKeys';
import { DEFAULT_DIFF_PREFS, useDiffPrefs } from './diffPrefs';
import { showSourceFor } from './markdownOverride';
import './keyActions';

const commitSpec: DiffSpec = { kind: 'commit', id: 'abc', parent: 0 } as unknown as DiffSpec;
const target = (path: string, view: 'diff' | 'file' = 'diff'): DiffTarget =>
  ({ key: `${JSON.stringify(commitSpec)}|${path}`, path, oldPath: null, status: 'M', old: { kind: 'absent' }, new: { kind: 'absent' }, view }) as DiffTarget;
const files = (...paths: string[]) => ({ files: paths.map((path) => ({ path, oldPath: null, status: 'M', additions: 1, deletions: 0, old: { kind: 'absent' }, new: { kind: 'absent' } })), added: 0, deleted: 0 }) as unknown as FileListPayload;

function open(diff: DiffTarget | null, panelFiles: string[] = []) {
  const store = activeTabWith();
  const panel = { selection: { kind: 'commit', index: 0, id: 'abc' }, parent: 0, details: { status: 'idle' }, message: { status: 'idle' }, sections: [{ title: null, spec: commitSpec, list: { status: 'ready', data: files(...panelFiles) } }] } as unknown as PanelContent;
  // `selection` too: the store's own updates rebuild `panel` from it (kept while its lists load).
  store.setState({ diff, panel, selection: panel.selection });
  return store;
}

beforeEach(() => {
  useDiffPrefs.setState({ prefs: DEFAULT_DIFF_PREFS });
  useFileListPrefs.setState({ mode: 'path', sort: 'path' } as never);
  goToChange.mockClear();
});

describe('diff view modes: Ctrl+Shift+1 / 2 / 3', () => {
  it('pick Hunk, Inline or Split while a diff is open', () => {
    open(target('a.txt'));
    expect(actionForCombo('Ctrl+Shift+3')?.id).toBe('diff.mode.split');
    runAction('diff.mode.split');
    expect(useDiffPrefs.getState().prefs.mode).toBe('split');
    runAction('diff.mode.hunk');
    expect(useDiffPrefs.getState().prefs.mode).toBe('hunk');
    expect(actionForCombo('Ctrl+Shift+2')?.id).toBe('diff.mode.inline');
  });

  it('not in File View, or with no file open', () => {
    open(target('a.txt', 'file'));
    expect(actionForCombo('Ctrl+Shift+1')).toBeUndefined();
    open(null);
    expect(actionForCombo('Ctrl+Shift+1')).toBeUndefined();
  });
});

describe('Source / Rendered: Ctrl+Shift+V', () => {
  it('toggles a Markdown file, the just-created file shown as Source included', () => {
    open(target('README.md', 'file'));
    expect(actionForCombo('Ctrl+Shift+V')?.id).toBe('diff.toggleRendered');
    runAction('diff.toggleRendered');
    expect(useDiffPrefs.getState().prefs.markdownView).toBe('source');
    runAction('diff.toggleRendered');
    expect(useDiffPrefs.getState().prefs.markdownView).toBe('rendered');
    showSourceFor('README.md');
    runAction('diff.toggleRendered');
    expect(useDiffPrefs.getState().prefs.markdownView).toBe('rendered');
  });

  it('only for Markdown, and not while typing (paste as plain text)', () => {
    open(target('a.txt'));
    expect(actionForCombo('Ctrl+Shift+V')).toBeUndefined();
    const yields = getAction('diff.toggleRendered')!.yieldsTo!;
    document.body.innerHTML = '<textarea id="t"></textarea>';
    expect(yields(document.getElementById('t'))).toBe(true);
  });
});

describe('next / previous change: F7 / Shift+F7', () => {
  it('are listed while a text diff is shown; useChangeKeys takes the keys themselves', async () => {
    open(target('a.txt'));
    expect(getAction('diff.nextChange')?.when?.()).toBe(false);
    function Shown() { useChangeKeys(true); return null; }
    const r = render(<Shown />);
    expect(runAction('diff.prevChange')).toBe(true);
    await vi.waitFor(() => expect(goToChange).toHaveBeenCalledWith('previous'));
    expect(actionForCombo('F7')).toBeUndefined();
    r.unmount();
    expect(getAction('diff.nextChange')?.when?.()).toBe(false);
  });
});

describe('next / previous file: F8 / Shift+F8', () => {
  it('open the next file in the panel, wrapping, in the same view', () => {
    const store = open(target('b.txt', 'file'), ['a.txt', 'b.txt', 'c.txt']);
    expect(actionForCombo('F8')?.id).toBe('diff.nextFile');
    runAction('diff.nextFile');
    expect(store.getState().diff).toMatchObject({ path: 'c.txt', view: 'file' });
    runAction('diff.nextFile');
    expect(store.getState().diff?.path).toBe('a.txt');
    runAction('diff.prevFile');
    expect(store.getState().diff?.path).toBe('c.txt');
  });

  it('with no file open, the first (or the last)', () => {
    const store = open(null, ['a.txt', 'b.txt']);
    runAction('diff.prevFile');
    expect(store.getState().diff?.path).toBe('b.txt');
  });
});
