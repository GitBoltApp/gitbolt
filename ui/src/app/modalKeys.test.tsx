import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useModalKeys } from './modalKeys';

function Dialog({ close, toggle }: { close: () => void; toggle?: string }) {
  const ref = useModalKeys<HTMLDivElement>(true, close, toggle);
  return <div ref={ref} role="dialog" aria-label="d"><input aria-label="field" /></div>;
}

describe('useModalKeys: the opening shortcut toggles', () => {
  it('Ctrl+, closes a dialog opened with it; other chords and plain keys do not', () => {
    const close = vi.fn();
    render(<Dialog close={close} toggle="Ctrl+," />);
    const field = screen.getByLabelText('field');
    fireEvent.keyDown(field, { key: 'a', code: 'KeyA' });
    fireEvent.keyDown(field, { key: 'k', code: 'KeyK', ctrlKey: true });
    expect(close).not.toHaveBeenCalled();
    fireEvent.keyDown(field, { key: ',', code: 'Comma', ctrlKey: true });
    expect(close).toHaveBeenCalledOnce();
  });

  it('without a toggle chord, Ctrl+, does nothing', () => {
    const close = vi.fn();
    render(<Dialog close={close} />);
    fireEvent.keyDown(screen.getByLabelText('field'), { key: ',', code: 'Comma', ctrlKey: true });
    expect(close).not.toHaveBeenCalled();
  });
});
