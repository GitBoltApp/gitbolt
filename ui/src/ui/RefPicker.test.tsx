import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { registerKeys } from './keyRouter';
import { RefPicker, type PickItem } from './RefPicker';

const ITEMS: PickItem[] = [
  { id: 'main', label: 'main', current: true }, { id: 'feature/login', label: 'feature/login' }, { id: 'hotfix', label: 'hotfix' },
];
const picker = (over: Partial<Parameters<typeof RefPicker>[0]> = {}) =>
  render(<RefPicker anchor={new DOMRect(0, 0, 100, 20)} placeholder="Find a branch" items={ITEMS} onPick={vi.fn()} onClose={vi.fn()} {...over} />);
const input = () => screen.getByPlaceholderText('Find a branch');
const selected = () => screen.getAllByRole('option').filter((o) => o.getAttribute('aria-selected') === 'true').map((o) => o.textContent);

describe('RefPicker', () => {
  it('filters by substring and picks with the keyboard', () => {
    const onPick = vi.fn();
    picker({ onPick });
    fireEvent.change(input(), { target: { value: 'LOG' } });
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['feature/login']);
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: 'feature/login' }));
  });

  it('starts on the current item; ↑/↓ move, clamped at both ends', () => {
    picker();
    expect(input()).toHaveFocus();
    expect(selected()).toEqual(['main']);
    fireEvent.keyDown(input(), { key: 'ArrowDown' });
    fireEvent.keyDown(input(), { key: 'ArrowDown' });
    fireEvent.keyDown(input(), { key: 'ArrowDown' });
    expect(selected()).toEqual(['hotfix']);
    fireEvent.keyDown(input(), { key: 'ArrowUp' });
    expect(selected()).toEqual(['feature/login']);
    expect(input()).toHaveAttribute('aria-activedescendant', screen.getAllByRole('option')[1].id);
  });

  it('starts on the current item wherever it is in the list', () => {
    picker({ items: [ITEMS[1], ITEMS[2], ITEMS[0]] });
    expect(selected()).toEqual(['main']);
  });

  it('says so when nothing matches, and Enter then picks nothing', () => {
    const onPick = vi.fn();
    picker({ onPick });
    fireEvent.change(input(), { target: { value: 'zzz' } });
    expect(screen.getByText('No matches')).toBeInTheDocument();
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(onPick).not.toHaveBeenCalled();
  });

  it('owns the keyboard in the key router\'s menu layer: Esc closes it, and never reaches the app (J4)', () => {
    const onClose = vi.fn();
    const app = vi.fn(() => 'handled' as const);
    const off = registerKeys('app', app);
    picker({ onClose });
    fireEvent.keyDown(input(), { key: 'w', ctrlKey: true });
    fireEvent.keyDown(input(), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(app).not.toHaveBeenCalled();
    off();
  });

  it('a click picks; a press outside closes, but not one on the element that opened it', () => {
    const onPick = vi.fn();
    const onClose = vi.fn();
    const opener = document.createElement('button');
    document.body.append(opener);
    picker({ onPick, onClose, ignore: opener });
    fireEvent.pointerDown(opener);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.pointerDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText('hotfix'));
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: 'hotfix' }));
    opener.remove();
  });
});
