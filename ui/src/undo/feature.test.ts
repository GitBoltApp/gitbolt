import { act } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ undo: vi.fn(), redo: vi.fn(), journalState: vi.fn() }));
vi.mock('../api/client', () => ({ api, errorMessage: String, onEvent: () => () => {} }));
const confirm = vi.hoisted(() => ({ answer: true, asked: [] as Array<{ body: string }> }));
vi.mock('../ui/ConfirmDialog', () => ({ confirmAction: vi.fn(async (r: { body: string }) => { confirm.asked.push(r); return confirm.answer; }) }));
vi.mock('../app/tabStores', () => ({ tabView: () => undefined, tabStore: () => undefined }));

const { movedText, ownsUndo, undo } = await import('./feature');
const { applyJournalEvent, journalKey, useJournal } = await import('./store');
const { useToast } = await import('../ui/toast');

const ctx = { tabId: 't', repoId: 4, worktree: '/r' };
const top = { entry: 7, label: 'commit "Fix x"', kind: 'commit' as const };
const state = (over = {}) => ({ undo: top, redo: null, undoBlocked: null, redoBlocked: 'Nothing to redo', banners: [], ...over });
const wrap = (outcome: unknown) => ({ outcome, journal: state({ undo: null, undoBlocked: 'Nothing to undo' }), staging: { undo: null, redo: null, off: null }, wip: null });

describe('undo (spec #2 §5.4, §5.5)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    confirm.asked = [];
    useToast.getState().dismiss();
    act(() => useJournal.getState().set(4, '/r', state()));
  });

  it('undoes the shown entry, then offers Redo in a toast', async () => {
    api.undo.mockResolvedValueOnce(wrap({ status: 'done', label: 'commit "Fix x"' }));
    await undo(ctx);
    expect(api.undo).toHaveBeenCalledWith(4, '/r', 7, undefined, false);
    expect(useToast.getState().message).toBe('Undid commit "Fix x"');
    expect(useToast.getState().action?.label).toBe('Redo');
    expect(useJournal.getState().states[journalKey(4, '/r')].undo).toBeNull();
  });

  it('a branch that moved asks first, and Undo anyway sends the values it showed', async () => {
    const refs = [{ name: 'refs/heads/main', expected: '4d5e6f0000', actual: '1a2b3c0000', target: '7a8b9c0000', dropped: 2 }];
    api.undo.mockResolvedValueOnce(wrap({ status: 'moved', label: 'commit "Fix x"', refs })).mockResolvedValueOnce(wrap({ status: 'done', label: 'commit "Fix x"' }));
    await undo(ctx);
    expect(confirm.asked[0].body).toBe('main moved since commit "Fix x" (it\'s at 1a2b3c0, not 4d5e6f0). Undoing moves it to 7a8b9c0 and drops the 2 commits made since.');
    expect(api.undo).toHaveBeenLastCalledWith(4, '/r', 7, { 'refs/heads/main': '1a2b3c0000' }, false);
  });

  it('a second press while one is in flight sends nothing more', async () => {
    let answer!: (v: unknown) => void;
    api.undo.mockReturnValueOnce(new Promise((r) => { answer = r; }));
    const first = undo(ctx);
    await undo(ctx);
    expect(api.undo).toHaveBeenCalledTimes(1);
    answer(wrap({ status: 'done', label: 'commit "Fix x"' }));
    await first;
  });

  it('journalChanged keeps the store current', () => {
    const next = state({ undo: null, undoBlocked: 'Push can\'t be undone' });
    applyJournalEvent({ type: 'journalChanged', repo: 4, worktree: '/r', state: next });
    expect(useJournal.getState().states[journalKey(4, '/r')]).toEqual(next);
  });

  it('words the moved prompt for one commit and for a deletion', () => {
    expect(movedText('create branch x', [{ name: 'refs/heads/x', expected: 'aaaaaaa1', actual: 'bbbbbbb2', target: null, dropped: 1 }])).toBe('x moved since create branch x (it\'s at bbbbbbb, not aaaaaaa). Undoing deletes it and drops the 1 commit made since.');
  });

  it('leaves Ctrl+Z to text boxes, Monaco, the diff view and the WIP file list', () => {
    const el = (html: string, sel: string) => {
      document.body.innerHTML = html;
      return document.querySelector(sel);
    };
    expect(ownsUndo(el('<input>', 'input'))).toBe(true);
    expect(ownsUndo(el('<textarea></textarea>', 'textarea'))).toBe(true);
    expect(ownsUndo(el('<div class="monaco-editor"><span>x</span></div>', 'span'))).toBe(true);
    expect(ownsUndo(el('<div class="diff-panel"><button>b</button></div>', 'button'))).toBe(true);
    expect(ownsUndo(el('<div class="details-panel"><header data-testid="wip-header"></header><div class="file-list"><span>f</span></div></div>', 'span'))).toBe(true);
    expect(ownsUndo(el('<div role="grid" tabindex="0"></div>', '[role="grid"]'))).toBe(false);
    expect(ownsUndo(el('<div class="details-panel"><div class="file-list"><span>f</span></div></div>', 'span'))).toBe(false);
  });
});
