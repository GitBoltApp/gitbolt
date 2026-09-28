import { describe, expect, it } from 'vitest';
import { isCloseFileKey, matchesLetter } from './keys';

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

describe('isCloseFileKey', () => {
  it('is Ctrl+W alone, on any layout', () => {
    expect(isCloseFileKey(ev('w', 'KeyW'))).toBe(true);
    expect(isCloseFileKey(ev('ц', 'KeyW'))).toBe(true);
    for (const mods of [{ shiftKey: true }, { altKey: true }, { metaKey: true }, { ctrlKey: false }]) expect(isCloseFileKey(ev('w', 'KeyW', mods))).toBe(false);
  });
});
