import { describe, expect, test } from 'vitest';
import { annotationOf, decodeText, parseCommitObject, parseSignature, parseTagObject, subject } from './objects';

const P1 = '1'.repeat(40);
const P2 = '2'.repeat(40);
const enc = (s: string) => new TextEncoder().encode(s);
const raw = (extra: string, msg: string) => enc(`tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904\nparent ${P1}\nparent ${P2}\nauthor Mara Q. Quill <mara@example.com> 1700000000 +0100\ncommitter Tobias Fenn <tobias@example.com> 1700000600 -0500\n${extra}\n${msg}`);

describe('parseCommitObject (commit::parse_commit)', () => {
  test('headers and the whole message', () => {
    const c = parseCommitObject('a'.repeat(40), raw('', 'Fix the thing\n\nLonger explanation\n'));
    expect(c).toEqual({ id: 'a'.repeat(40), parents: [P1, P2], authorName: 'Mara Q. Quill', authorEmail: 'mara@example.com', authorTime: 1700000000, committerTime: 1700000600, message: 'Fix the thing\n\nLonger explanation\n' });
  });

  test('skips multi-line headers (a signature)', () => {
    const c = parseCommitObject('a'.repeat(40), raw('gpgsig -----BEGIN PGP SIGNATURE-----\n iQEz\n -----END PGP SIGNATURE-----\n', 'Signed\n'));
    expect([c.parents.length, c.message]).toEqual([2, 'Signed\n']);
  });

  test('no message, and a message that is not UTF-8 reads as Latin-1', () => {
    expect(parseCommitObject('a'.repeat(40), enc(`tree x\nauthor A <a@example.com> 1 +0000\ncommitter A <a@example.com> 1 +0000`)).message).toBe('');
    expect(decodeText(new Uint8Array([0x63, 0x61, 0x66, 0xe9]))).toBe('café');
    expect(decodeText(enc('﻿bom'))).toBe('﻿bom');
  });
});

test('parseSignature (commit::parse_signature)', () => {
  expect(parseSignature('Mara Quill <mara@example.com> 1700000000 +0000')).toEqual({ name: 'Mara Quill', email: 'mara@example.com', time: 1700000000 });
  expect(parseSignature('No Email')).toEqual({ name: 'No Email', email: '', time: 0 });
  expect(parseSignature('A <a@example.com> notatime +0000').time).toBe(0);
  expect(parseSignature('A <a@example.com> 12x +0000').time).toBe(0);
});

describe('tags (refs::read_tag, annotation_of)', () => {
  test('a tag object, its signature left out', () => {
    const t = parseTagObject(enc(`object ${P1}\ntype commit\ntag v1.0\ntagger Mara Quill <mara@example.com> 1700000000 +0000\n\nRelease 1.0\n\nNotes\n-----BEGIN PGP SIGNATURE-----\nxyz\n-----END PGP SIGNATURE-----\n`));
    expect(t).toEqual({ object: P1, type: 'commit', tagger: { name: 'Mara Quill', time: 1700000000 }, message: 'Release 1.0\n\nNotes\n' });
    expect(annotationOf(t)).toEqual({ message: 'Release 1.0\n\nNotes', truncated: false, tagger: 'Mara Quill', time: 1700000000 });
  });

  test('ten lines at most, two thousand characters at most', () => {
    const lines = Array.from({ length: 14 }, (_, i) => `line ${i + 1}`);
    const a = annotationOf({ object: P1, type: 'commit', tagger: null, message: lines.join('\n') });
    expect(a).toEqual({ message: lines.slice(0, 10).join('\n'), truncated: true, tagger: null, time: 0 });
    expect(annotationOf({ object: P1, type: 'commit', tagger: null, message: `${lines.slice(0, 10).join('\n')}\n\n  \n` }).truncated).toBe(false);
    const long = annotationOf({ object: P1, type: 'commit', tagger: { name: ' ', time: 5 }, message: 'é'.repeat(2500) });
    expect([[...long.message].length, long.truncated, long.tagger]).toEqual([2000, true, null]);
  });
});

test('subject (shelldata::subject): the first paragraph on one line', () => {
  expect(subject('\n\nFirst line\nsecond line\r\n\r\nbody')).toBe('First line second line');
  expect(subject('Only\n')).toBe('Only');
  expect(subject('a\r\nb\n\nc')).toBe('a b');
});

test('a legacy encoding header decodes the name and message in its charset (commit::decode_with)', () => {
  const sjis = new Uint8Array([0x93, 0xfa, 0x96, 0x7b]); // 日本 in Shift_JIS
  const head = enc(`tree x\nencoding Shift_JIS\nauthor `);
  const tail = enc(` <a@example.com> 1 +0000\ncommitter A <a@example.com> 1 +0000\n\n`);
  const body = new Uint8Array([...head, ...sjis, ...tail, ...sjis]);
  const c = parseCommitObject('a'.repeat(40), body);
  expect([c.authorName, c.message]).toEqual(['日本', '日本']);
  const bad = new Uint8Array([...enc('tree x\nencoding no-such-charset\nauthor A <a@example.com> 1 +0000\n\n'), 0xe9]);
  expect(parseCommitObject('a'.repeat(40), bad).message).toBe('é');
});

test('tag annotation keeps a BOM and reads lossy UTF-8 (refs::read_tag)', () => {
  const t = parseTagObject(enc(`object ${P1}\ntype commit\ntag v2\ntagger A <a@example.com> 1 +0000\n\n﻿hi\n`));
  expect(t.message).toBe('﻿hi\n');
  expect(annotationOf(t).message).toBe('﻿hi');
});

test('an SSH armor is stripped from a tag message, and a mid-line armor is kept', () => {
  const ssh = parseTagObject(enc(`object ${P1}\ntype commit\ntag v3\n\nRelease\n-----BEGIN SSH SIGNATURE-----\nxyz\n-----END SSH SIGNATURE-----\n`));
  expect(ssh.message).toBe('Release\n');
  const mid = parseTagObject(enc(`object ${P1}\ntype commit\ntag v3\n\nSee -----BEGIN PGP SIGNATURE----- inline\n`));
  expect(mid.message).toBe('See -----BEGIN PGP SIGNATURE----- inline\n');
});

test('the last armor at a line start is the one stripped', () => {
  const t = parseTagObject(enc(`object ${P1}\ntype commit\ntag v3\n\nA\n-----BEGIN PGP SIGNATURE-----\nx\n-----BEGIN SSH SIGNATURE-----\ny\n`));
  expect(t.message).toBe('A\n-----BEGIN PGP SIGNATURE-----\nx\n');
});

test('a parent that is not an object id is a GbError of kind Other', () => {
  let thrown: unknown;
  try {
    parseCommitObject('a'.repeat(40), enc('tree x\nparent zzz\nauthor A <a@example.com> 1 +0000\ncommitter A <a@example.com> 1 +0000\n\nmsg'));
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toEqual(expect.objectContaining({ kind: 'Other' }));
  expect((thrown as { message: string }).message).toContain('zzz');
});

test('a signature time past 2^53 (or not an i64) reads as 0', () => {
  expect(parseSignature('A <a@example.com> 99999999999999999999 +0000').time).toBe(0);
  expect(parseSignature('A <a@example.com> 9007199254740993 +0000').time).toBe(0);
});
