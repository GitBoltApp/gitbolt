import { describe, expect, it } from 'vitest';
import { comboOf } from './shortcuts';

const ev = (init: Partial<KeyboardEvent> & { key: string; code?: string }) => ({ ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, code: '', ...init }) as KeyboardEvent;

describe('comboOf', () => {
  it('names Ctrl combinations', () => {
    expect(comboOf(ev({ key: 'T', code: 'KeyT', ctrlKey: true, shiftKey: true }))).toBe('Ctrl+Shift+T');
    expect(comboOf(ev({ key: 'ƒ', code: 'KeyF', ctrlKey: true, altKey: true }))).toBe('Ctrl+Alt+F');
    expect(comboOf(ev({ key: 'Tab', code: 'Tab', ctrlKey: true }))).toBe('Ctrl+Tab');
    expect(comboOf(ev({ key: 'Tab', code: 'Tab', ctrlKey: true, shiftKey: true }))).toBe('Ctrl+Shift+Tab');
    expect(comboOf(ev({ key: 'PageDown', code: 'PageDown', ctrlKey: true }))).toBe('Ctrl+PageDown');
    expect(comboOf(ev({ key: ',', code: 'Comma', ctrlKey: true }))).toBe('Ctrl+,');
    expect(comboOf(ev({ key: '!', code: 'Digit1', ctrlKey: true, shiftKey: true }))).toBe('Ctrl+Shift+1');
  });
  it('letters follow the layout, like 1B\'s matchesLetter: by character, else by key position', () => {
    expect(comboOf(ev({ key: 'w', code: 'Comma', ctrlKey: true }))).toBe('Ctrl+W'); // Dvorak W
    expect(comboOf(ev({ key: 'z', code: 'KeyW', ctrlKey: true }))).toBe('Ctrl+Z'); // AZERTY
    expect(comboOf(ev({ key: 'ц', code: 'KeyW', ctrlKey: true }))).toBe('Ctrl+W'); // Russian
  });
  it('ignores keys without Ctrl, with Meta, lone modifiers and IME composition', () => {
    expect(comboOf(ev({ key: 'w', code: 'KeyW' }))).toBe('');
    expect(comboOf(ev({ key: 'w', code: 'KeyW', ctrlKey: true, metaKey: true }))).toBe('');
    expect(comboOf(ev({ key: 'Control', code: 'ControlLeft', ctrlKey: true }))).toBe('');
    expect(comboOf(ev({ key: 'Shift', code: 'ShiftLeft', ctrlKey: true, shiftKey: true }))).toBe('');
    expect(comboOf(ev({ key: 'w', code: 'KeyW', ctrlKey: true, isComposing: true }))).toBe('');
  });
});
