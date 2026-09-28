import { expect, it } from 'vitest';
import { SHORT_SHA_LEN, shortSha } from './sha';

const ID = '0123456789abcdef0123456789abcdef01234567';

it('one short-SHA length app-wide: 6 hex characters (feedback H15)', () => {
  expect(SHORT_SHA_LEN).toBe(6);
  expect(shortSha(ID)).toBe('012345');
});

it('leaves an already-short id as it is', () => {
  expect(shortSha('abc')).toBe('abc');
});
