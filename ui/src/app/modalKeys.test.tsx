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

describe('useModalKeys: the dialog’s own keys', () => {
  function Viewer({ close, onKey }: { close: () => void; onKey: (e: KeyboardEvent) => boolean }) {
    const ref = useModalKeys<HTMLDivElement>(true, close, undefined, onKey);
    return <div ref={ref} role="dialog" aria-label="v"><button type="button">b</button></div>;
  }

  it('`onKey` sees each key first; one it takes is the dialog’s (default prevented), Esc still closes', () => {
    const close = vi.fn();
    const onKey = vi.fn((e: KeyboardEvent) => e.key === '+');
    render(<Viewer close={close} onKey={onKey} />);
    const b = screen.getByRole('button');
    expect(fireEvent.keyDown(b, { key: '+' })).toBe(false);
    expect(fireEvent.keyDown(b, { key: 'x' })).toBe(true);
    expect(onKey).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(b, { key: 'Escape' });
    expect(close).toHaveBeenCalledOnce();
  });
});
