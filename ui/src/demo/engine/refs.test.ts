import { expect, test } from 'vitest';
import { MemFs } from './memfs';
import { compareBytes, parsePackedRefs, readRefFiles } from './refs';

const [A, B, C] = ['a'.repeat(40), 'b'.repeat(40), 'c'.repeat(40)];

test('byte order puts "-" before "/", as packed-refs and gix do', () => {
  expect(['refs/heads/a/b', 'refs/heads/a-c', 'refs/heads/a'].sort(compareBytes)).toEqual(['refs/heads/a', 'refs/heads/a-c', 'refs/heads/a/b']);
  expect(compareBytes('é', 'z')).toBeGreaterThan(0);
});

test('packed refs: peeled lines and the header skipped', () => {
  expect([...parsePackedRefs(`# pack-refs with: peeled fully-peeled sorted \n${A} refs/heads/main\n${B} refs/tags/v1\n^${C}\n`)]).toEqual([['refs/heads/main', A], ['refs/tags/v1', B]]);
});

test('loose refs win over packed ones; symbolic refs keep their target; byte order', () => {
  const fs = new MemFs();
  fs.mkdirpSync('/g/refs/heads/a');
  fs.mkdirpSync('/g/refs/remotes/origin');
  fs.writeFileSync('/g/packed-refs', `${A} refs/heads/a-c\n${A} refs/heads/main\n`);
  fs.writeFileSync('/g/refs/heads/main', `${B}\n`);
  fs.writeFileSync('/g/refs/heads/a/b', `${C}\n`);
  fs.writeFileSync('/g/refs/remotes/origin/HEAD', 'ref: refs/remotes/origin/main\n');
  fs.writeFileSync('/g/refs/heads/junk', 'not a ref\n');
  fs.writeFileSync('/g/HEAD', 'ref: refs/heads/main\n');
  expect(readRefFiles(fs, '/g')).toEqual([
    { full: 'refs/heads/a-c', symref: null, oid: A },
    { full: 'refs/heads/a/b', symref: null, oid: C },
    { full: 'refs/heads/main', symref: null, oid: B },
    { full: 'refs/remotes/origin/HEAD', symref: 'refs/remotes/origin/main', oid: null },
  ]);
  expect(readRefFiles(new MemFs(), '/none')).toEqual([]);
});
