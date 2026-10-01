import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ConfirmDialog, confirmAction } from './ConfirmDialog';

describe('ConfirmDialog (K68)', () => {
  const ask = () => confirmAction({ title: 'Delete the profile “Work”?', body: 'Gone for good.', confirmLabel: 'Delete profile', danger: true });

  it('resolves true only on the confirm button; Cancel takes the initial focus', async () => {
    render(<ConfirmDialog />);
    let answer!: Promise<boolean>;
    act(() => { answer = ask(); });
    expect(screen.getByRole('alertdialog', { name: 'Delete the profile “Work”?' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Delete profile' })).toHaveClass('danger');
    fireEvent.click(screen.getByRole('button', { name: 'Delete profile' }));
    await expect(answer).resolves.toBe(true);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('Cancel, Esc and a backdrop press all resolve false', async () => {
    render(<ConfirmDialog />);
    let a!: Promise<boolean>;
    act(() => { a = ask(); });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await expect(a).resolves.toBe(false);

    act(() => { a = ask(); });
    fireEvent.keyDown(window, { key: 'Escape' });
    await expect(a).resolves.toBe(false);

    act(() => { a = ask(); });
    fireEvent.pointerDown(document.querySelector('.modal-backdrop')!);
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
