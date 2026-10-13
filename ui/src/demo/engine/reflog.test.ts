import { expect, test } from 'vitest';
import { parseReflog } from './reflog';

test('parseReflog (reflog::read_reflog): newest first, names with spaces', () => {
  const [a, b, c] = ['1'.repeat(40), '2'.repeat(40), '3'.repeat(40)];
  const text = `${a} ${b} Mara Q Quill <mara@example.com> 1700000000 +0000\tOn main: one\n${b} ${c} Mara <mara@example.com> 1700000060 -0500\tOn main: two\r\n\ngarbage\n`;
  expect(parseReflog(text)).toEqual([
    { old: b, new: c, time: 1700000060, message: 'On main: two' },
    { old: a, new: b, time: 1700000000, message: 'On main: one' },
  ]);
  expect(parseReflog('')).toEqual([]);
});

test('a line whose time is not a safe integer is skipped', () => {
  const [a, b] = ['1'.repeat(40), '2'.repeat(40)];
  expect(parseReflog(`${a} ${b}\tno time field\n`)).toEqual([]);
  expect(parseReflog(`${a} ${b} Mara <mara@example.com> 99999999999999999999 +0000\tbig time\n`)).toEqual([]);
  expect(parseReflog(`${a} ${b} Mara <mara@example.com> 1700000000 +0000\tok\n`)).toEqual([{ old: a, new: b, time: 1700000000, message: 'ok' }]);
});
