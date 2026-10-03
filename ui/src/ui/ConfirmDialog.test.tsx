import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { armClock, press, pressEnter } from './arm/armTesting';
import { ConfirmDialog, confirmAction } from './ConfirmDialog';

describe('ConfirmDialog: the popover with no control to arm (K68, spec §ui confirms board H)', () => {
  let clock: ReturnType<typeof armClock>;
  beforeEach(() => { clock = armClock(); });
  afterEach(() => clock.restore());
  const ask = () => confirmAction({ title: 'Delete the profile “Work”?', body: 'Gone for good.', confirmLabel: 'Delete profile', arm: 'Click again to delete Work', danger: true }, null);

  it('resolves true only on the confirm button; the confirm button takes the initial focus', async () => {
    render(<ConfirmDialog />);
    let answer!: Promise<boolean>;
    act(() => { answer = ask(); });
    expect(screen.getByRole('alertdialog', { name: 'Delete the profile “Work”?' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete profile' })).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Delete profile' })).toHaveClass('danger');
    // Only a fresh press past the settle answers it.
    press(screen.getByRole('button', { name: 'Delete profile' }));
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    clock.settle();
    press(screen.getByRole('button', { name: 'Delete profile' }));
    await expect(answer).resolves.toBe(true);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('the focused confirm button is what Enter activates (a button click) and a non-danger one is green', async () => {
    render(<ConfirmDialog />);
    let a!: Promise<boolean>;
    act(() => { a = confirmAction({ title: 'Rebase?', body: 'b', confirmLabel: 'Rebase', arm: 'Click again to rebase' }, null); });
    const btn = screen.getByRole('button', { name: 'Rebase' });
    expect(btn).toHaveFocus();
    expect(btn).toHaveClass('positive');
    clock.settle();
    // A held Enter's repeat doesn't answer; a fresh Enter (its click, the browser's default) does.
    pressEnter(btn, true);
    expect(document.activeElement).toBe(btn);
    pressEnter(btn);
    await expect(a).resolves.toBe(true);
  });

  it('Cancel, Esc and a press outside all resolve false', async () => {
    render(<ConfirmDialog />);
    let a!: Promise<boolean>;
    act(() => { a = ask(); });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await expect(a).resolves.toBe(false);

    act(() => { a = ask(); });
    fireEvent.keyDown(window, { key: 'Escape' });
    await expect(a).resolves.toBe(false);

    act(() => { a = ask(); });
    fireEvent.pointerDown(document.body);
    await expect(a).resolves.toBe(false);
  });

  it('a newer question answers the older one with false', async () => {
    render(<ConfirmDialog />);
    let first!: Promise<boolean>;
    act(() => { first = ask(); });
    act(() => { void ask(); });
    await expect(first).resolves.toBe(false);
  });
});
