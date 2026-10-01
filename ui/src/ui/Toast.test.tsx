import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Toast } from './Toast';
import { useToast } from './toast';

describe('Toast', () => {
  afterEach(() => act(() => useToast.getState().dismiss()));

  it('keeps the single `action` working', () => {
    const run = vi.fn();
    render(<Toast />);
    act(() => useToast.getState().show('Fetch failed', { action: { label: 'Activity log', run } }));
    fireEvent.click(screen.getByRole('button', { name: 'Activity log' }));
    expect(run).toHaveBeenCalledOnce();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('shows `actions` in order after `action`, and any of them dismisses it (R12)', () => {
    const a = vi.fn();
    const b = vi.fn();
    render(<Toast />);
    act(() => useToast.getState().show('Not found: x', { actions: [{ label: 'Copy error', run: a }, { label: 'Details', run: b }] }));
    const buttons = screen.getAllByRole('button');
    expect(buttons.map((x) => x.textContent)).toEqual(['Copy error', 'Details']);
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    expect(b).toHaveBeenCalledOnce();
    expect(a).not.toHaveBeenCalled();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('a plain show clears the previous actions', () => {
    render(<Toast />);
    act(() => useToast.getState().show('a', { actions: [{ label: 'Details', run: () => {} }] }));
    act(() => useToast.getState().show('Copied'));
    expect(screen.queryByRole('button')).toBeNull();
  });
});
