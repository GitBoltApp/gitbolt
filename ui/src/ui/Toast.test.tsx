import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerKeys } from './keyRouter';
import { Toast } from './Toast';
import { useToast } from './toastStore';

describe('Toast', () => {
  afterEach(() => act(() => useToast.getState().dismiss()));

  it('warnings and toasts with links go to the top; plain notices stay at the bottom', () => {
    render(<Toast />);
    act(() => useToast.getState().show('Copied'));
    expect(screen.getByRole('status')).not.toHaveClass('toast-top');
    act(() => useToast.getState().show('Failed', { action: { label: 'Retry', run: () => {} } }));
    expect(screen.getByRole('status')).toHaveClass('toast-top');
    act(() => useToast.getState().show('Careful', { tone: 'warning' }));
    expect(screen.getByRole('alert')).toHaveClass('toast-top');
  });

  it("a top toast goes below an open flyout's title bar it would cover (an MR view's header)", () => {
    const rect = (left: number, top: number, width: number, height: number) => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
    const head = document.createElement('header');
    head.className = 'flyout-head';
    document.body.append(head);
    const spy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return this === head ? rect(240, 78, 560, 40) : rect(550, 96, 300, 30);
    });
    try {
      render(<Toast />);
      act(() => useToast.getState().show('Applied the suggestion', { action: { label: 'Undo', run: () => {} } }));
      expect(screen.getByRole('status').style.getPropertyValue('--toast-below')).toBe('126px');
      // Clear of it sideways (a narrow flyout): it stays where it was.
      spy.mockImplementation(function (this: HTMLElement) { return this === head ? rect(240, 78, 200, 40) : rect(550, 96, 300, 30); });
      act(() => useToast.getState().show('Applied another', { action: { label: 'Undo', run: () => {} } }));
      expect(screen.getByRole('status').style.getPropertyValue('--toast-below')).toBe('0px');
    } finally {
      spy.mockRestore();
      head.remove();
    }
  });

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

  it('Esc dismisses a sticky toast; a modal (menu layer) takes Esc first; a plain toast ignores it', () => {
    render(<Toast />);
    act(() => useToast.getState().show('Plain'));
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(useToast.getState().message).toBe('Plain');
    act(() => useToast.getState().show('Problem', { tone: 'warning', sticky: true }));
    const off = registerKeys('menu', () => 'handled');
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(useToast.getState().message).toBe('Problem');
    off();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(useToast.getState().message).toBeNull();
  });
});
