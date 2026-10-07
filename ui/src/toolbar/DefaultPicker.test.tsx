import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DefaultPicker } from './DefaultPicker';

const options = [
  { value: 'fetchAll', label: 'Fetch All' },
  { value: 'pullFfOrMerge', label: 'Pull (fast-forward if possible)' },
  { value: 'pullFfOnly', label: 'Pull (fast-forward only)' },
  { value: 'pullRebase', label: 'Pull (rebase)' },
];

describe('the default picker (spec #2 §12.1)', () => {
  it('shows the heading and radio rows; a pick sets the default and closes without running', () => {
    const set = vi.fn();
    const close = vi.fn();
    render(<DefaultPicker picker={{ title: 'Select a default pull/fetch operation to execute when clicking this button', options, useValue: () => 'fetchAll', set }} anchor={document.body} onClose={close} />);
    expect(screen.getByText('Select a default pull/fetch operation to execute when clicking this button')).toBeInTheDocument();
    expect(screen.getByRole('menuitemradio', { name: 'Fetch All' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Pull (rebase)' }));
    expect(set).toHaveBeenCalledWith('pullRebase');
    expect(close).toHaveBeenCalled();
  });

  it('↓ and Enter pick from the keyboard; Esc closes', () => {
    const set = vi.fn();
    const close = vi.fn();
    render(<DefaultPicker picker={{ title: 'T', options, useValue: () => 'fetchAll', set }} anchor={document.body} onClose={close} />);
    const menu = screen.getByRole('menu');
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    fireEvent.keyDown(menu, { key: 'Enter' });
    expect(set).toHaveBeenCalledWith('pullFfOrMerge');
    fireEvent.keyDown(menu, { key: 'Escape' });
    expect(close).toHaveBeenCalled();
  });

  it('a press on the caret that opened it (under the backdrop) closes it, and its click does not reopen it', () => {
    const close = vi.fn();
    const reopen = vi.fn();
    const caret = document.createElement('button');
    caret.getBoundingClientRect = () => new DOMRect(10, 10, 20, 20);
    caret.addEventListener('click', reopen);
    document.body.append(caret);
    const { container } = render(<DefaultPicker picker={{ title: 'T', options, useValue: () => 'fetchAll', set: vi.fn() }} anchor={caret} onClose={close} />);
    const backdrop = container.querySelector('.tb-default-picker-backdrop') as HTMLElement;
    fireEvent.pointerDown(backdrop, { clientX: 15, clientY: 15 });
    fireEvent.pointerUp(backdrop, { clientX: 15, clientY: 15 });
    fireEvent.click(caret, { clientX: 15, clientY: 15 });
    expect(close).toHaveBeenCalledOnce();
    expect(reopen).not.toHaveBeenCalled();
    caret.remove();
  });
});
