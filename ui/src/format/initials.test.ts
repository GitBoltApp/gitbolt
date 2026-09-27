import { expect, it } from 'vitest';
import { initials } from './initials';

it('takes the first letters of the first two words', () => {
  expect(initials('Ada Lovelace')).toBe('AL');
  expect(initials('grace')).toBe('G');
  expect(initials('  Linus   Benedict Torvalds ')).toBe('LB');
  expect(initials('')).toBe('?');
  expect(initials('Élodie Ünal')).toBe('ÉÜ');
});
