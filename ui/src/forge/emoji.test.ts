import { describe, expect, it } from 'vitest';
import { emojify, loadEmoji } from './emoji';

describe('emoji shortcodes', () => {
  const map = { gear: '⚙️', books: '📚', '+1': '👍' };

  it('replaces known shortcodes and leaves unknown ones, and text without a map, as they are', () => {
    expect(emojify('feature :gear:', map)).toBe('feature ⚙️');
    expect(emojify(':books: docs :+1: :nope: 10:30', map)).toBe('📚 docs 👍 :nope: 10:30');
    expect(emojify('feature :gear:', null)).toBe('feature :gear:');
  });

  it("never reads the object prototype's names", () => {
    expect(emojify(':constructor: :toString: :__proto__:', map)).toBe(':constructor: :toString: :__proto__:');
  });

  it("loads GitHub's names (gemoji)", async () => {
    await loadEmoji();
    expect(emojify('feature :gear:, documentation :books:')).toBe('feature ⚙️, documentation 📚');
  });
});
