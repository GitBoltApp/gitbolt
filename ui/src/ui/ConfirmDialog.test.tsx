import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { armClock, press, pressEnter } from './arm/armTesting';
import type { ArmAnswer } from './arm/store';
import { ConfirmDialog, confirmAction, confirmWith } from './ConfirmDialog';

describe('ConfirmDialog: the popover with no control to arm (K68, spec §ui confirms board H)', () => {
  let clock: ReturnType<typeof armClock>;
  beforeEach(() => { clock = armClock(); });
  afterEach(() => clock.restore());
  const ask = () => confirmAction({ title: 'Delete the profile “Work”?', body: 'Gone for good.', confirmLabel: 'Delete profile', arm: 'Click again to delete Work', danger: true }, null);

  it('resolves true only on the confirm button; a destructive answer leaves the initial focus on Cancel', async () => {
    render(<ConfirmDialog />);
    let answer!: Promise<boolean>;
    act(() => { answer = ask(); });
    expect(screen.getByRole('alertdialog', { name: 'Delete the profile “Work”?' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
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

  it('compact (UX round 3): one right-aligned row, a quiet Cancel then the answer; the title alone when there is no body; an option is a checkbox that answers with its value', async () => {
    render(<ConfirmDialog />);
    let a!: Promise<ArmAnswer>;
    act(() => { a = confirmWith({ title: 'Rebase feature/c onto main?', confirmLabel: 'Rebase', arm: 'Click again to rebase feature/c onto main', option: { label: 'Also move 2 stacked branches', detail: 'feature/a, feature/b', checked: true } }, null); });
    const dialog = screen.getByRole('alertdialog', { name: 'Rebase feature/c onto main?' });
    expect(dialog.querySelectorAll('p')).toHaveLength(0);
    expect([...dialog.querySelectorAll('.modal-actions button')].map((b) => b.textContent)).toEqual(['Cancel', 'Rebase']);
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveClass('choice-cancel');
    expect(screen.getByRole('button', { name: 'Rebase' })).toHaveClass('primary', 'positive');
    const box = screen.getByRole('checkbox', { name: /Also move 2 stacked branches ?\(feature\/a, feature\/b\)/ });
    expect(box).toBeChecked();
    fireEvent.click(box);
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    clock.settle();
    press(screen.getByRole('button', { name: 'Rebase' }));
    await expect(a).resolves.toEqual({ ok: true, checked: false });
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
