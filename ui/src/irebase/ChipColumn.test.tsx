import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useMenu } from '../menu/menuStore';
import { registerMenu } from '../menu/registry';
import { chipCopyRows, type ChipTarget } from './chipMenu';
import { chipsShown, LIST_W, type ChipItem } from './ChipColumn';
import { fromPlan, setActions } from './model';
import { useChipDrag } from './chipDrag';
import { RebaseEditor } from './RebaseEditor';
import { NO_PREDICTION, editState, sessionOf, setSession } from './session';
import { oid, plan } from './testPlan';

vi.mock('./predict', async (orig) => ({ ...(await orig<typeof import('./predict')>()), usePrediction: () => {} }));
const ctx = { tabId: 't1', repoId: 1, worktree: '/r' };
function show(colors?: Record<string, number>) {
  setSession('t1', { ctx, opened: { branch: 'topic', base: 'main' }, state: fromPlan(plan()), prediction: NO_PREDICTION, moved: null, editing: null, colors });
  render(<RebaseEditor tabId="t1" props={{}} close={() => {}} />);
}
const row = (c: string) => document.querySelector(`[data-irebase-row][data-oid="${oid(c)}"]`) as HTMLElement;
const chipsOn = (c: string) => [...row(c).querySelectorAll('.irebase-chip')].map((el) => el.textContent);
const chip = (name: string) => [...document.querySelectorAll<HTMLElement>('[data-irebase-row] .irebase-chip')].find((el) => el.textContent === name)!;
const wraps = (c: string) => [...row(c).querySelectorAll('.irebase-chip-wrap')].map((el) => `${el.getAttribute('data-branch')}${el.classList.contains('is-deleted') ? ' (deleted)' : ''}`);
const x = (c: string, name: string) => row(c).querySelector<HTMLElement>(`.irebase-chip-wrap[data-branch="${name}"] .irebase-chip-x`)!;
/** jsdom has no layout: the row under the pointer is the one `elementFromPoint` is told. */
const pointAt = (el: Element | null) => { document.elementFromPoint = () => el; };
const pointer = (type: string, x: number, y: number) => act(() => { window.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y })); });
afterEach(() => { setSession('t1', undefined); useChipDrag.setState({ drag: null }); });

describe('the chip column (spec #3 §4.1)', () => {
  it('shows each chip on its row, the rebased branch on the top row', () => {
    show();
    expect(chipsOn('e')).toEqual(['topic']);
    expect(chipsOn('b')).toEqual(['x']);
    expect(chipsOn('d')).toEqual(['y']);
  });

  it('a chip dragged with the pointer (no HTML5 drag: CEF never delivers it) moves its branch to the row it is dropped on', () => {
    show();
    expect(chip('x').getAttribute('draggable')).toBeNull();
    fireEvent.pointerDown(chip('x'), { button: 0, clientX: 10, clientY: 100 });
    pointAt(row('d').querySelector('.irebase-summary'));
    pointer('pointermove', 12, 101); // under the threshold: still a click
    expect(useChipDrag.getState().drag).toBeNull();
    pointer('pointermove', 12, 40);
    expect(row('d').classList.contains('chip-over')).toBe(true);
    expect(document.querySelector('.irebase-chip-ghost')!.textContent).toBe('x');
    pointer('pointerup', 12, 40);
    expect(sessionOf('t1')!.state.chips.find((c) => c.branch === 'x')!.at).toBe(oid('d'));
    expect(chipsOn('d')).toEqual(['x', 'y']);
    expect(document.querySelector('.irebase-chip-ghost')).toBeNull();
    // The release's click isn't a row selection.
    fireEvent.click(row('d'));
    expect(sessionOf('t1')!.state.selected).toEqual([]);
  });

  it('Esc during a chip drag puts it back; a press on a chip starts no row drag', () => {
    show();
    fireEvent.pointerDown(chip('x'), { button: 0, clientX: 10, clientY: 100 });
    pointAt(row('d'));
    pointer('pointermove', 10, 40);
    expect(document.querySelector('.irebase-rows')!.classList.contains('dragging')).toBe(false);
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    pointer('pointerup', 10, 40);
    expect(sessionOf('t1')!.state.chips.find((c) => c.branch === 'x')!.at).toBe(oid('b'));
    expect(sessionOf('t1')).toBeDefined();
    // The release's click selects nothing; the next click does.
    fireEvent.click(row('d'));
    expect(sessionOf('t1')!.state.selected).toEqual([]);
    fireEvent.click(row('d'));
    expect(sessionOf('t1')!.state.selected).toEqual([oid('d')]);
  });

  it('a chip drag under way ends with the editor: no listener, no Esc of its own left behind', () => {
    show();
    fireEvent.pointerDown(chip('x'), { button: 0, clientX: 10, clientY: 100 });
    pointAt(row('d'));
    pointer('pointermove', 10, 40);
    expect(useChipDrag.getState().drag).not.toBeNull();
    const removed = vi.spyOn(window, 'removeEventListener');
    cleanup();
    expect(useChipDrag.getState().drag).toBeNull();
    expect(removed.mock.calls.map(([type]) => type)).toEqual(expect.arrayContaining(['pointermove', 'pointerup', 'pointercancel']));
    removed.mockRestore();
    pointer('pointerup', 10, 40);
    expect(sessionOf('t1')!.state.chips.find((c) => c.branch === 'x')!.at).toBe(oid('b'));
    // Esc is the app's again: it reaches the (gone) editor's layer, not a dead chip drag.
    const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    act(() => { window.dispatchEvent(esc); });
    expect(esc.defaultPrevented).toBe(false);
  });

  it('the rebased chip moves down when the top rows are dropped; it and a locked chip have no ×', () => {
    show();
    act(() => editState('t1', (s) => setActions(s, [oid('e')], 'drop')));
    expect(chipsOn('d')).toContain('topic');
    expect(chip('topic').classList.contains('is-free')).toBe(false);
    expect(chip('y').classList.contains('is-free')).toBe(false);
    expect(chip('x').classList.contains('is-free')).toBe(true);
    expect(row('d').querySelectorAll('[aria-label^="Delete"]').length).toBe(0);
  });

  it('× strikes a chip out ("will be deleted"); × again restores it', () => {
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Delete x when the rebase completes' }));
    expect(chip('x').classList.contains('is-deleted')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Keep x' }));
    expect(chip('x').classList.contains('is-deleted')).toBe(false);
  });

  it('two chips on one row are each deleted and restored on their own (UX R1.5)', () => {
    show();
    // A second free chip on x's row (b).
    fireEvent.click(row('b').querySelector('[aria-label="Add a branch here"]')!);
    const input = screen.getByRole('textbox', { name: 'New branch name' });
    fireEvent.change(input, { target: { value: 'z' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(wraps('b')).toEqual(['x', 'z']);
    fireEvent.click(x('b', 'x'));
    expect(wraps('b')).toEqual(['x (deleted)', 'z']);
    fireEvent.click(x('b', 'x'));
    fireEvent.click(x('b', 'z'));
    expect(wraps('b')).toEqual(['x']);
  });

  it('a deleted chip folded onto another\'s row (squash into it) is restored on its own, and the other deleted (UX R1.5)', () => {
    setSession('t1', { ctx, opened: { branch: 'topic', base: 'main' }, state: fromPlan(plan({ chips: [{ branch: 'x', at: oid('b'), locked: null }, { branch: 'w', at: oid('c'), locked: null }] })), prediction: NO_PREDICTION, moved: null, editing: null });
    render(<RebaseEditor tabId="t1" props={{}} close={() => {}} />);
    fireEvent.click(x('c', 'w'));
    act(() => editState('t1', (s) => setActions(s, [oid('c')], 'squash')));
    expect(wraps('b')).toEqual(['x', 'w (deleted)']);
    fireEvent.click(x('b', 'w'));
    expect(wraps('b')).toEqual(['x', 'w']);
    fireEvent.click(x('b', 'x'));
    expect(wraps('b')).toEqual(['x (deleted)', 'w']);
    fireEvent.click(x('b', 'w'));
    expect(wraps('b')).toEqual(['x (deleted)', 'w (deleted)']);
  });

  it('a chip carries its full name in place, an overlay with its controls; the tooltip says what it does (UX2 E.1)', () => {
    show();
    const wrap = row('b').querySelector('.irebase-chip-wrap')!;
    fireEvent.mouseEnter(wrap);
    expect(screen.getByRole('tooltip').textContent).toBe('Drag it to another commit to move it');
    // Shown whole, its name has nothing to expand.
    fireEvent.mouseEnter(chip('x'));
    expect(wrap.querySelector('.irebase-chip-expand')).toBeNull();
    // Ellipsized (jsdom has no layout: told so), it expands until the pointer leaves the chip.
    Object.defineProperty(chip('x'), 'scrollWidth', { value: 80, configurable: true });
    Object.defineProperty(chip('x'), 'clientWidth', { value: 40, configurable: true });
    fireEvent.mouseEnter(chip('x'));
    const full = wrap.querySelector('.irebase-chip-expand')!;
    expect(full.getAttribute('aria-hidden')).toBe('true');
    expect(full.querySelector('.irebase-chip-full-name')!.textContent).toBe('x');
    // The overlay's × is the chip's: it strikes the chip out.
    fireEvent.click(full.querySelector('.irebase-chip-full-x')!);
    expect(chip('x').classList.contains('is-deleted')).toBe(true);
    fireEvent.mouseLeave(wrap);
    expect(wrap.querySelector('.irebase-chip-expand')).toBeNull();
  });

  it('chips that don\'t fit at a readable width go behind "+N"; its click offers each hidden chip\'s menu (UX2 E.2)', () => {
    const names = ['feature/one', 'feature/two', 'stack/three', 'stack/four'];
    setSession('t1', { ctx, opened: { branch: 'topic', base: 'main' }, state: fromPlan(plan({ chips: names.map((branch) => ({ branch, at: oid('b'), locked: null })), branches: ['main', 'topic', ...names] })), prediction: NO_PREDICTION, moved: null, editing: null });
    render(<RebaseEditor tabId="t1" props={{}} close={() => {}} />);
    expect(chipsOn('b')).toEqual(['feature/one', 'feature/two']);
    const more = screen.getByRole('button', { name: '2 more: stack/three, stack/four' });
    expect(more.textContent).toBe('+2');
    // Its list: every chip of the row at its full name, each a chip (drag, ×, menu).
    expect([...row('b').querySelectorAll('.irebase-chips-all .irebase-chip-full-name')].map((el) => el.textContent)).toEqual(names);
    const off = registerMenu<ChipTarget, object>({ id: 'chip.test.copy', kind: 'chip', group: 'copy', order: 0, rows: chipCopyRows });
    fireEvent.click(more);
    off();
    const menu = useMenu.getState().rows ?? [];
    expect(menu.map((r) => (r.kind === 'submenu' ? r.label : r.kind))).toEqual(['stack/three', 'stack/four']);
    expect(menu.map((r) => (r.kind === 'submenu' ? r.rows.map((x) => (x.kind === 'action' ? x.tooltip : '')) : []))).toEqual([['Copy "stack/three"'], ['Copy "stack/four"']]);
    act(() => useMenu.getState().close());
    // Dragged from the list, a hidden chip moves.
    const four = row('b').querySelector<HTMLElement>('.irebase-chips-all [data-branch="stack/four"]')!;
    fireEvent.pointerDown(four, { button: 0, clientX: 10, clientY: 100 });
    pointAt(row('d'));
    pointer('pointermove', 10, 40);
    pointer('pointerup', 10, 40);
    expect(sessionOf('t1')!.state.chips.find((c) => c.branch === 'stack/four')!.at).toBe(oid('d'));
    expect(chipsOn('d')).toEqual(['stack/four']);
    fireEvent.click(row('d')); // the release's click: swallowed
    expect(sessionOf('t1')!.state.selected).toEqual([]);
    expect(screen.getByRole('button', { name: '1 more: stack/three' }).textContent).toBe('+1');
  });

  it('a chip takes its branch\'s graph lane colour from when the editor opened; others the default (UX R1.8)', () => {
    show({ x: 2, topic: 0 });
    const lane = (el: HTMLElement) => el.style.getPropertyValue('--chip-lane');
    expect(lane(chip('x'))).not.toBe('');
    expect(lane(chip('topic'))).not.toBe('');
    expect(lane(chip('x'))).not.toBe(lane(chip('topic')));
    expect(lane(chip('y'))).toBe('');
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

describe('the chip column\'s fit (UX2 E.2)', () => {
  const item = (branch: string, kind: ChipItem['kind'] = 'chip'): ChipItem => ({ branch, kind, color: undefined });
  it('shows every chip that fits at 6 characters; short names take their own width', () => {
    expect(chipsShown([item('topic', 'rebased'), item('feature/a')], LIST_W)).toBe(2);
    expect(chipsShown(['a', 'b', 'c', 'd', 'e'].map((n) => item(n)), LIST_W)).toBe(5);
  });
  it('the rest goes behind "+N"', () => {
    expect(chipsShown(['feature/a', 'feature/b', 'stack/x', 'stack/y'].map((n) => item(n)), LIST_W)).toBe(2);
    expect(chipsShown([item('topic', 'rebased'), ...['feature/a', 'feature/b', 'stack/x'].map((n) => item(n))], LIST_W)).toBe(2);
  });
});
