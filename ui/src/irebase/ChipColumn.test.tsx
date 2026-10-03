import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fromPlan, setActions } from './model';
import { RebaseEditor } from './RebaseEditor';
import { NO_PREDICTION, editState, sessionOf, setSession } from './session';
import { oid, plan } from './testPlan';

vi.mock('./predict', async (orig) => ({ ...(await orig<typeof import('./predict')>()), usePrediction: () => {} }));
const ctx = { tabId: 't1', repoId: 1, worktree: '/r' };
function show() {
  setSession('t1', { ctx, opened: { branch: 'topic', base: 'main' }, state: fromPlan(plan()), prediction: NO_PREDICTION, moved: null, editing: null });
  render(<RebaseEditor tabId="t1" props={{}} close={() => {}} />);
}
const row = (c: string) => document.querySelector(`[data-irebase-row][data-oid="${oid(c)}"]`) as HTMLElement;
const chipsOn = (c: string) => [...row(c).querySelectorAll('.irebase-chip')].map((el) => el.textContent);
const chip = (name: string) => [...document.querySelectorAll<HTMLElement>('[data-irebase-row] .irebase-chip')].find((el) => el.textContent === name)!;
afterEach(() => setSession('t1', undefined));

describe('the chip column (spec #3 §4.1)', () => {
  it('shows each chip on its row, the rebased branch on the top row', () => {
    show();
    expect(chipsOn('e')).toEqual(['topic']);
    expect(chipsOn('b')).toEqual(['x']);
    expect(chipsOn('d')).toEqual(['y']);
  });

  it('a dragged chip moves its branch to the row it is dropped on', () => {
    show();
    fireEvent.dragStart(chip('x'));
    fireEvent.dragOver(row('d'));
    expect(row('d').classList.contains('chip-over')).toBe(true);
    fireEvent.drop(row('d'));
    expect(sessionOf('t1')!.state.chips.find((c) => c.branch === 'x')!.at).toBe(oid('d'));
    expect(chipsOn('d')).toEqual(['x', 'y']);
  });

  it('the rebased chip moves down when the top rows are dropped; it and a locked chip have no ×', () => {
    show();
    act(() => editState('t1', (s) => setActions(s, [oid('e')], 'drop')));
    expect(chipsOn('d')).toContain('topic');
    expect(chip('topic').getAttribute('draggable')).not.toBe('true');
    expect(chip('y').getAttribute('draggable')).not.toBe('true');
    expect(row('d').querySelectorAll('[aria-label^="Delete"]').length).toBe(0);
  });

  it('× strikes a chip out ("will be deleted"); × again restores it', () => {
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Delete x when the rebase completes' }));
    expect(chip('x').classList.contains('is-deleted')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Keep x' }));
    expect(chip('x').classList.contains('is-deleted')).toBe(false);
  });

  it('+ adds a branch at a row; a taken name says why', () => {
    show();
    fireEvent.click(row('c').querySelector('[aria-label="Add a branch here"]')!);
    const input = screen.getByRole('textbox', { name: 'New branch name' });
    fireEvent.change(input, { target: { value: 'x' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByText('x already exists')).toBeTruthy();
    fireEvent.change(input, { target: { value: 'feature/new' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(chipsOn('c')).toEqual(['feature/new']);
  });
});
