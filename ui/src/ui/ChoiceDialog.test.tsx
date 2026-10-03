import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArmLayer } from './arm/ArmLayer';
import { armClock, press, pressEnter } from './arm/armTesting';
import { askChoice, ChoiceDialog } from './ChoiceDialog';

describe('askChoice (spec #2 §12.2, §13.1)', () => {
  let clock: ReturnType<typeof armClock>;
  beforeEach(() => { clock = armClock(); });
  afterEach(() => clock.restore());

  it('resolves the picked choice and the checkbox, the primary choice focused first', async () => {
    render(<ChoiceDialog />);
    const p = askChoice({ title: 'main and origin/main have diverged (2 ahead, 3 behind).', body: 'Merging would conflict in 1 file.', choices: [{ id: 'rebase', label: 'Rebase', primary: true }, { id: 'merge', label: 'Merge' }], checkbox: { label: 'Also move 2 stacked branches', checked: true, detail: 'feature/a, feature/b' } });
    expect(await screen.findByRole('alertdialog')).toHaveTextContent('Merging would conflict in 1 file.');
    expect(screen.getByRole('button', { name: 'Rebase' })).toHaveFocus();
    fireEvent.click(screen.getByRole('checkbox', { name: /Also move 2 stacked branches/ }));
    clock.settle();
    press(screen.getByRole('button', { name: 'Rebase' }));
    await expect(p).resolves.toEqual({ choice: 'rebase', checked: false });
  });

  it('with no primary, the first enabled choice is focused', async () => {
    render(<ChoiceDialog />);
    const p = askChoice({ title: 't2', body: 'b', choices: [{ id: 'a', label: 'A', disabled: true }, { id: 'b', label: 'B' }] });
    expect(await screen.findByRole('button', { name: 'B' })).toHaveFocus();
    fireEvent.keyDown(window, { key: 'Escape' });
    await expect(p).resolves.toEqual({ choice: null, checked: false });
  });

  it('a risky choice arms in place before it goes (board G)', async () => {
    render(<><ChoiceDialog /><ArmLayer /></>);
    const rects = vi.spyOn(HTMLElement.prototype, 'getClientRects').mockImplementation(function (this: HTMLElement) {
      return (this.isConnected ? [new DOMRect(0, 0, 10, 10)] : []) as unknown as DOMRectList;
    });
    const p = askChoice({ title: 'origin/main has commits main doesn\'t have', body: 'b', choices: [{ id: 'pull', label: 'Pull', primary: true }, { id: 'force', label: 'Force push (with lease)', danger: true, arm: 'Click again to force push' }] });
    expect(await screen.findByRole('button', { name: 'Pull' })).toHaveFocus();
    clock.settle();
    press(screen.getByRole('button', { name: 'Force push (with lease)' }));
    const armed = document.querySelector('.arm-overlay')!;
    expect(armed).toHaveTextContent('Click again to force push');
    expect(screen.getByRole('alertdialog')).toHaveAttribute('aria-modal', 'true');
    // Pressing it is inside the popover: the popover stays.
    clock.settle();
    press(armed);
    await expect(p).resolves.toEqual({ choice: 'force', checked: false });
    rects.mockRestore();
  });

  it('a choice is a fresh gesture after it opened: not a held Enter, a double click or a press within the settle', async () => {
    render(<ChoiceDialog />);
    const p = askChoice({ title: 'Rebase main onto feature?', body: 'b', choices: [{ id: 'go', label: 'Rebase', primary: true }] });
    const go = await screen.findByRole('button', { name: 'Rebase' });
    // Within the settle: the click that started the action, repeated, picks nothing.
    press(go);
    clock.settle();
    // A held Enter: its repeat is cancelled at keydown, and a click it leaks doesn't pick.
    expect(fireEvent.keyDown(go, { key: 'Enter', repeat: true })).toBe(false);
    fireEvent.click(go, { detail: 0 });
    // A double click's second click.
    fireEvent.pointerDown(go);
    fireEvent.click(go, { detail: 2 });
    await Promise.resolve();
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    fireEvent.keyUp(go, { key: 'Enter' });
    pressEnter(go);
    await expect(p).resolves.toEqual({ choice: 'go', checked: false });
  });

  it('assistive technology activation (a click with no pointer and no key) picks once settled', async () => {
    render(<ChoiceDialog />);
    const p = askChoice({ title: 't', body: 'b', choices: [{ id: 'x', label: 'X', primary: true }] });
    const x = await screen.findByRole('button', { name: 'X' });
    clock.settle();
    fireEvent.click(x, { detail: 0 });
    await expect(p).resolves.toEqual({ choice: 'x', checked: false });
  });

  it('Cancel, Esc and a press outside resolve null', async () => {
    render(<ChoiceDialog />);
    const p = askChoice({ title: 't', body: 'b', choices: [{ id: 'x', label: 'X' }] });
    fireEvent.keyDown(await screen.findByRole('alertdialog'), { key: 'Escape' });
    await expect(p).resolves.toEqual({ choice: null, checked: false });
    const q = askChoice({ title: 't', body: 'b', choices: [{ id: 'x', label: 'X' }] });
    await screen.findByRole('alertdialog');
    fireEvent.pointerDown(document.body);
    await expect(q).resolves.toEqual({ choice: null, checked: false });
  });
});
