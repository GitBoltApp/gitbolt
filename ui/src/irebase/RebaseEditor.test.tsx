import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fromPlan } from './model';
import { RebaseEditor } from './RebaseEditor';
import { NO_PREDICTION, editSession, editState, sessionOf, setSession } from './session';
import { reset } from './model';
import { oid, plan } from './testPlan';
import type { GraphPayload } from '../api/gen/GraphPayload';
import type { RowPayload } from '../api/gen/RowPayload';
import { useTabViews } from '../app/tabStores';
import { createRepoViewStore } from '../repo/store';
import { fakeServices } from '../repo/testServices';

vi.mock('./predict', async (orig) => ({ ...(await orig<typeof import('./predict')>()), usePrediction: () => {} }));
const ctx = { tabId: 't1', repoId: 1, worktree: '/r' };
const show = (over = {}) => {
  setSession('t1', { ctx, opened: { branch: 'topic', base: 'main' }, state: fromPlan(plan(over)), prediction: NO_PREDICTION, moved: null, editing: null });
  return render(<RebaseEditor tabId="t1" props={{}} close={() => {}} />);
};
const row = (c: string) => document.querySelector(`[data-irebase-row][data-oid="${oid(c)}"]`) as HTMLElement;
const key = (k: string, mods: Partial<KeyboardEventInit> = {}) => act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...mods })); });
const order = () => sessionOf('t1')!.state.rows.map((r) => r.summary).join('');
const move = (y: number) => act(() => { window.dispatchEvent(new MouseEvent('pointermove', { clientY: y })); });
const up = (y: number) => act(() => { window.dispatchEvent(new MouseEvent('pointerup', { clientY: y })); });
afterEach(() => setSession('t1', undefined));

describe('the interactive rebase editor (spec #3 §4.1)', () => {
  it('shows the header, the rows newest first and the base as a read-only bottom row', () => {
    show({ merges: 2 });
    expect(screen.getByRole('heading', { name: 'Interactive Rebase' })).toBeTruthy();
    expect(screen.getByText(/Rebasing/).textContent).toBe('Rebasing topic onto main');
    expect(screen.getByRole('note').textContent).toContain('2 merge commits will be flattened into a straight line');
    expect([...document.querySelectorAll('[data-irebase-row]')].map((el) => el.getAttribute('data-oid'))).toEqual(['e', 'd', 'c', 'b', 'a'].map(oid));
    expect(document.querySelector('.irebase-base')!.textContent).toContain('Base');
  });

  it('letters set the selected rows\' action; Ctrl+↓ moves them; a folded row shows ↓', () => {
    show();
    fireEvent.click(row('c'));
    fireEvent.click(row('d'), { ctrlKey: true });
    key('s');
    expect(sessionOf('t1')!.state.rows.filter((r) => r.action === 'squash').map((r) => r.oid)).toEqual([oid('d'), oid('c')]);
    expect(row('d').classList.contains('is-folded')).toBe(true);
    key('ArrowDown', { ctrlKey: true });
    expect(sessionOf('t1')!.state.rows.map((r) => r.summary).join('')).toBe('EBDCA');
  });

  it('Start is disabled with the first problem as its reason', () => {
    show();
    fireEvent.click(row('a'));
    key('f');
    const start = screen.getByRole('button', { name: 'Start Rebase' });
    expect(start.getAttribute('aria-disabled')).toBe('true');
  });

  it('⚠ marks predicted conflicts; the note says when prediction is off', () => {
    show();
    act(() => editSession('t1', (s) => ({ ...s, prediction: { status: 'ready', byRow: { [oid('c')]: ['notes.txt'] }, first: oid('c'), note: null } })));
    expect(row('c').querySelector('[aria-label="Predicted conflict"]')).toBeTruthy();
    act(() => editSession('t1', (s) => ({ ...s, prediction: { status: 'off', byRow: {}, first: null, note: 'Prediction is off for ranges over 300 commits' } })));
    expect(screen.getByText('Prediction is off for ranges over 300 commits')).toBeTruthy();
  });

  it('Enter opens the message inline; Ctrl+Enter saves it and the row shows the edited dot', () => {
    show();
    fireEvent.click(row('b'));
    key('Enter');
    const summary = screen.getByRole('textbox', { name: 'Commit summary' }) as HTMLInputElement;
    expect(summary.value).toBe('B');
    fireEvent.change(summary, { target: { value: 'B, better' } });
    fireEvent.keyDown(summary, { key: 'Enter', ctrlKey: true });
    expect(sessionOf('t1')!.state.rows.find((r) => r.oid === oid('b'))!.edited).toBe('B, better\n');
    expect(row('b').querySelector('[aria-label="Message edited"]')).toBeTruthy();
  });

  it('RefMoved: the plan is out of date, with Reload', () => {
    show();
    act(() => editSession('t1', (s) => ({ ...s, moved: 'refs/heads/topic moved' })));
    expect(screen.getByRole('alert').textContent).toContain('The plan is out of date: refs/heads/topic moved.');
    expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy();
  });

  it('Esc during a row drag puts the row back and only that: the editor stays open', () => {
    show();
    const handle = row('d').querySelector('.irebase-handle')!;
    fireEvent.pointerDown(handle, { clientY: 0, pointerId: 1, button: 0 });
    act(() => { window.dispatchEvent(new MouseEvent('pointermove', { clientY: 40 })); });
    expect(document.querySelector('.irebase-rows')!.classList.contains('dragging')).toBe(true);
    key('Escape');
    expect(document.querySelector('.irebase-rows')!.classList.contains('dragging')).toBe(false);
    expect(sessionOf('t1')).toBeDefined();
    act(() => { window.dispatchEvent(new MouseEvent('pointerup', { clientY: 40 })); });
    expect(sessionOf('t1')!.state.rows.map((r) => r.summary).join('')).toBe('EDCBA');
    // The release's click selects nothing; the next click does.
    fireEvent.click(row('b'));
    expect(sessionOf('t1')!.state.selected).toEqual([]);
    fireEvent.click(row('b'));
    expect(sessionOf('t1')!.state.selected).toEqual([oid('b')]);
    key('Escape');
    expect(sessionOf('t1')).toBeUndefined();
  });

  it('a row drags from anywhere on it; a press without travel selects; its controls start no drag (UX R1.2)', () => {
    show();
    fireEvent.pointerDown(row('d').querySelector('.irebase-summary')!, { clientY: 0, pointerId: 1, button: 0 });
    move(2);
    expect(document.querySelector('.irebase-rows')!.classList.contains('dragging')).toBe(false);
    up(2);
    fireEvent.click(row('d').querySelector('.irebase-summary')!);
    expect(sessionOf('t1')!.state.selected).toEqual([oid('d')]);
    fireEvent.pointerDown(row('c').querySelector('.irebase-action button')!, { clientY: 0, pointerId: 1, button: 0 });
    move(40);
    expect(document.querySelector('.irebase-rows')!.classList.contains('dragging')).toBe(false);
    up(40);
    fireEvent.pointerDown(row('c').querySelector('[aria-label="Add a branch here"]')!, { clientY: 0, pointerId: 1, button: 0 });
    move(40);
    expect(document.querySelector('.irebase-rows')!.classList.contains('dragging')).toBe(false);
    up(40);
    fireEvent.pointerDown(row('c').querySelector('.avatar, .irebase-summary')!, { clientY: 0, pointerId: 1, button: 0 });
    move(40);
    expect(document.querySelector('.irebase-rows')!.classList.contains('dragging')).toBe(true);
    up(40);
    // The release's click isn't a selection.
    fireEvent.click(row('c'));
    expect(sessionOf('t1')!.state.selected).toEqual([oid('d')]);
  });

  it('the rebased branch\'s chip stays on the top row while the top commit is dragged down (UX R1.7)', () => {
    show();
    // jsdom has no layout: every row is 0 px, so any travel lands the row last.
    fireEvent.pointerDown(row('e').querySelector('.irebase-summary')!, { clientY: 0, pointerId: 1, button: 0 });
    move(40);
    expect(row('e').querySelector('.irebase-chip.is-rebased')).toBeNull();
    expect(row('d').querySelector('.irebase-chip.is-rebased')!.textContent).toBe('topic');
    up(40);
    fireEvent.click(row('e')); // the release's click, swallowed
    expect(order()).toBe('DCBAE');
    expect(row('d').querySelector('.irebase-chip.is-rebased')!.textContent).toBe('topic');
  });

  it('Undo / Redo (buttons and Ctrl+Z / Ctrl+Shift+Z) step through plan changes, Reset included; the selection is no step (UX R1.6)', () => {
    show();
    const undo = screen.getByRole('button', { name: 'Undo plan change' });
    const redo = screen.getByRole('button', { name: 'Redo plan change' });
    expect(undo.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(row('c'));
    expect(undo.getAttribute('aria-disabled')).toBe('true');
    key('d');
    key('ArrowDown', { ctrlKey: true });
    expect(order()).toBe('EDBCA');
    act(() => editState('t1', reset));
    expect(order()).toBe('EDCBA');
    key('z', { ctrlKey: true });
    expect(order()).toBe('EDBCA');
    fireEvent.click(undo);
    expect(order()).toBe('EDCBA');
    expect(sessionOf('t1')!.state.rows.find((r) => r.oid === oid('c'))!.action).toBe('drop');
    key('z', { ctrlKey: true });
    expect(sessionOf('t1')!.state.rows.find((r) => r.oid === oid('c'))!.action).toBe('pick');
    expect(undo.getAttribute('aria-disabled')).toBe('true');
    key('Z', { ctrlKey: true, shiftKey: true });
    expect(sessionOf('t1')!.state.rows.find((r) => r.oid === oid('c'))!.action).toBe('drop');
    fireEvent.click(redo);
    expect(order()).toBe('EDBCA');
    // A new change clears Redo; Undo leaves the selection as it is.
    fireEvent.click(row('a'));
    fireEvent.click(undo);
    expect(sessionOf('t1')!.state.selected).toEqual([oid('a')]);
    key('d');
    expect(redo.getAttribute('aria-disabled')).toBe('true');
  });

  it('Ctrl+Z in the message editor is the text box\'s own undo, not the plan\'s', () => {
    show();
    fireEvent.click(row('b'));
    key('d');
    key('Enter');
    const summary = screen.getByRole('textbox', { name: 'Commit summary' });
    fireEvent.keyDown(summary, { key: 'z', ctrlKey: true });
    expect(sessionOf('t1')!.state.rows.find((r) => r.oid === oid('b'))!.action).toBe('drop');
  });

  it('while a message editor is open, Undo / Redo are disabled ("Finish editing the message first") and its draft stays', () => {
    show();
    fireEvent.click(row('b'));
    key('d');
    key('Enter');
    const summary = screen.getByRole('textbox', { name: 'Commit summary' }) as HTMLInputElement;
    fireEvent.change(summary, { target: { value: 'B, draft' } });
    const undo = screen.getByRole('button', { name: 'Undo plan change' });
    const redo = screen.getByRole('button', { name: 'Redo plan change' });
    expect(undo.getAttribute('aria-disabled')).toBe('true');
    expect(redo.getAttribute('aria-disabled')).toBe('true');
    fireEvent.mouseEnter(undo);
    expect(screen.getByRole('tooltip').textContent).toBe('Finish editing the message first');
    fireEvent.click(undo);
    // Focus gone from the text box (on the body): Ctrl+Z still doesn't undo under the open editor.
    key('z', { ctrlKey: true });
    expect(sessionOf('t1')!.state.rows.find((r) => r.oid === oid('b'))!.action).toBe('drop');
    expect(sessionOf('t1')!.editing).toBe(oid('b'));
    expect((screen.getByRole('textbox', { name: 'Commit summary' }) as HTMLInputElement).value).toBe('B, draft');
    fireEvent.keyDown(summary, { key: 'Enter', ctrlKey: true });
    expect(undo.getAttribute('aria-disabled')).toBe('false');
  });

  it('UX R2.2: the selected row shows in the details panel (the tab\'s selection); the base row shows the base', () => {
    const grow = (c: string): RowPayload => ({ id: oid(c), kind: 'commit', lane: 0, color: 0, segments: [], summary: c, bodyFirstLine: '', authorName: 'Ada', authorEmail: 'ada@example.com', authorTime: 1, committerTime: 1, parents: [], mrRefs: [], wip: null });
    const graph: GraphPayload = { rows: ['e', 'd', 'c', 'b', 'a', '0'].map(grow), labels: [], maxLanes: 1, pinnedRef: null, head: { branch: 'refs/heads/topic', target: oid('e'), detached: false, unborn: false }, truncated: false, worktrees: [] };
    const store = createRepoViewStore(1, '/r', graph, fakeServices());
    useTabViews.setState({ views: { t1: { repo: 1, services: fakeServices(), store } } });
    const shown = () => { const sel = store.getState().selection; return sel.kind === 'commit' ? sel.id : sel.kind; };
    show();
    fireEvent.click(row('c'));
    expect(shown()).toBe(oid('c'));
    key('ArrowDown');
    expect(shown()).toBe(oid('b'));
    // A Ctrl+click adds a row: that one shows; a Shift range shows its far end.
    fireEvent.click(row('d'), { ctrlKey: true });
    expect(shown()).toBe(oid('d'));
    fireEvent.click(row('a'), { shiftKey: true });
    expect(shown()).toBe(oid('a'));
    const base = document.querySelector('.irebase-base')!;
    expect(base.getAttribute('aria-selected')).toBe('false');
    fireEvent.click(base);
    expect(shown()).toBe(oid('0'));
    expect(sessionOf('t1')!.state.selected).toEqual([]);
    expect(base.getAttribute('aria-selected')).toBe('true');
    fireEvent.click(row('e'));
    expect(shown()).toBe(oid('e'));
    expect(base.getAttribute('aria-selected')).toBe('false');
    useTabViews.setState({ views: {} });
  });
});
