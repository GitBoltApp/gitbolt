import { describe, expect, it } from 'vitest';
import { isEditableTarget, letterOf, matchesLetter } from './keys';

const ev = (key: string, code: string, mods: Partial<{ ctrlKey: boolean; altKey: boolean; metaKey: boolean; shiftKey: boolean }> = {}) => ({ key, code, ctrlKey: true, altKey: false, metaKey: false, shiftKey: false, ...mods });

describe('matchesLetter', () => {
  it('matches a Latin e.key by character (so Dvorak and AZERTY follow their layout)', () => {
    expect(matchesLetter(ev('w', 'Comma'), 'w')).toBe(true); // Dvorak W
    expect(matchesLetter(ev('W', 'KeyW'), 'w')).toBe(true); // Caps Lock
    expect(matchesLetter(ev('z', 'KeyW'), 'w')).toBe(false); // AZERTY: the KeyW position is Z
  });

  it('falls back to the key position for a non-Latin e.key (Cyrillic, Greek, …)', () => {
    expect(matchesLetter(ev('ц', 'KeyW'), 'w')).toBe(true); // Russian ЙЦУКЕН: ц on KeyW
    expect(matchesLetter(ev('с', 'KeyC'), 'c')).toBe(true); // Cyrillic es on KeyC
    expect(matchesLetter(ev('ц', 'KeyQ'), 'w')).toBe(false);
  });
});

// Ctrl+W itself (formerly `isCloseFileKey`) is a shortcut of the app's since plan 1C:
// app/shortcuts.test.ts names it, app/closeKeys.test.tsx dispatches it.
describe('letterOf', () => {
  it('reads the layout\'s letter, else the key position, else nothing', () => {
    expect(letterOf(ev('W', 'Comma'))).toBe('w'); // Dvorak, Caps Lock
    expect(letterOf(ev('ц', 'KeyW'))).toBe('w');
    expect(letterOf(ev('1', 'Digit1'))).toBeNull();
    expect(letterOf(ev('Tab', 'Tab'))).toBeNull();
  });
});

describe('isEditableTarget', () => {
  it('is true for text inputs, textareas, selects and contenteditable; false otherwise', () => {
    const mk = (html: string) => { const d = document.createElement('div'); d.innerHTML = html; return d.firstElementChild as HTMLElement; };
    expect(isEditableTarget(mk('<input>'))).toBe(true);
    expect(isEditableTarget(mk('<input type="text">'))).toBe(true);
    expect(isEditableTarget(mk('<textarea></textarea>'))).toBe(true);
    expect(isEditableTarget(mk('<input type="checkbox">'))).toBe(false);
    expect(isEditableTarget(mk('<button></button>'))).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });
});
