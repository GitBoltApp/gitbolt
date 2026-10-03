import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fromPlan } from './model';
import { RebaseEditor } from './RebaseEditor';
import { NO_PREDICTION, editSession, sessionOf, setSession } from './session';
import { oid, plan } from './testPlan';

vi.mock('./predict', async (orig) => ({ ...(await orig<typeof import('./predict')>()), usePrediction: () => {} }));
const ctx = { tabId: 't1', repoId: 1, worktree: '/r' };
const show = (over = {}) => {
  setSession('t1', { ctx, opened: { branch: 'topic', base: 'main' }, state: fromPlan(plan(over)), prediction: NO_PREDICTION, moved: null, editing: null });
  return render(<RebaseEditor tabId="t1" props={{}} close={() => {}} />);
};
const row = (c: string) => document.querySelector(`[data-irebase-row][data-oid="${oid(c)}"]`) as HTMLElement;
const key = (k: string, mods: Partial<KeyboardEventInit> = {}) => act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...mods })); });
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
    key('Escape');
    expect(sessionOf('t1')).toBeUndefined();
  });
});
