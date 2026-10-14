import { describe, expect, it } from 'vitest';
import { mergeTexts, type MergeStyle } from './mergeFile';

const L = { ours: 'ours', base: 'base', theirs: 'theirs' };
const merge = (b: string, o: string, t: string, style: MergeStyle = 'merge') => mergeTexts(b, o, t, style, L);

describe('mergeTexts', () => {
  it('merges edits apart cleanly, and identical edits too', () => {
    expect(merge('1\n2\n3\n4\n5\n', '1x\n2\n3\n4\n5\n', '1\n2\n3\n4\n5x\n')).toEqual({ text: '1x\n2\n3\n4\n5x\n', conflicts: 0 });
    expect(merge('1\n2\n3\n', '1\nX\n3\n', '1\nX\n3\n', 'diff3')).toEqual({ text: '1\nX\n3\n', conflicts: 0 });
  });

  it('refines a conflict to the lines that differ in merge style, and shows it whole with its base in diff3', () => {
    expect(merge('1\n2\n3\n', 'A\nB\nC\n', 'A\nX\nC\n')).toEqual({ text: 'A\n<<<<<<< ours\nB\n=======\nX\n>>>>>>> theirs\nC\n', conflicts: 1 });
    expect(merge('1\n2\n3\n', 'A\nB\nC\n', 'A\nX\nC\n', 'diff3').text).toBe('<<<<<<< ours\nA\nB\nC\n||||||| base\n1\n2\n3\n=======\nA\nX\nC\n>>>>>>> theirs\n');
  });

  it('joins conflicts three lines apart or apart by lines without letters or digits, never across a one-sided change', () => {
    expect(merge('a\nk1\nk2\nk3\nd\n', 'A\nk1\nk2\nk3\nD\n', 'X\nk1\nk2\nk3\nY\n').text).toBe('<<<<<<< ours\nA\nk1\nk2\nk3\nD\n=======\nX\nk1\nk2\nk3\nY\n>>>>>>> theirs\n');
    expect(merge('a\nk1\nk2\nk3\nk4\nd\n', 'A\nk1\nk2\nk3\nk4\nD\n', 'X\nk1\nk2\nk3\nk4\nY\n')).toEqual({ text: '<<<<<<< ours\nA\n=======\nX\n>>>>>>> theirs\nk1\nk2\nk3\nk4\n<<<<<<< ours\nD\n=======\nY\n>>>>>>> theirs\n', conflicts: 2 });
    expect(merge('a\n\n}\n\n}\nd\n', 'A\n\n}\n\n}\nD\n', 'X\n\n}\n\n}\nY\n').conflicts).toBe(1);
    expect(merge('1\n2\n3\n4\n5\n6\n', 'A\n2\nC\n4\nE\n6\n', 'X\n2\n3\n4\nY\n6\n').text).toBe('<<<<<<< ours\nA\n=======\nX\n>>>>>>> theirs\n2\nC\n4\n<<<<<<< ours\nE\n=======\nY\n>>>>>>> theirs\n6\n');
    expect(merge('a\nk1\nd\n', 'A\nk1\nD\n', 'X\nk1\nY\n', 'diff3').conflicts).toBe(2);
    // A change both sides made the same way is shared lines: it doesn't keep two conflicts apart.
    expect(merge('a\nk1\nm\nk2\nd\n', 'A\nk1\nM\nk2\nD\n', 'X\nk1\nM\nk2\nY\n')).toEqual({ text: '<<<<<<< ours\nA\nk1\nM\nk2\nD\n=======\nX\nk1\nM\nk2\nY\n>>>>>>> theirs\n', conflicts: 1 });
    expect(merge('a\nk1\nm\nk2\nd\n', 'A\nk1\nM\nk2\nD\n', 'X\nk1\nM\nk2\nY\n', 'diff3')).toEqual({ text: '<<<<<<< ours\nA\n||||||| base\na\n=======\nX\n>>>>>>> theirs\nk1\nM\nk2\n<<<<<<< ours\nD\n||||||| base\nd\n=======\nY\n>>>>>>> theirs\n', conflicts: 2 });
  });

  it("a side's last line without a newline ends before the marker (Review Focus 4)", () => {
    expect(merge('1\n2', '1\nO', '1\nT')).toEqual({ text: '1\n<<<<<<< ours\nO\n=======\nT\n>>>>>>> theirs\n', conflicts: 1 });
    expect(merge('1\n2\n', '1\n2', '1\n2\n3\n').conflicts).toBe(1);
  });

  it('CRLF sides keep their \\r byte for byte; the markers follow the base and the line before the conflict', () => {
    expect(merge('1\r\n2\r\n', '1\r\nO', '1\r\nT\r\n').text).toBe('1\r\n<<<<<<< ours\r\nO\r\n=======\r\nT\r\n>>>>>>> theirs\r\n');
    expect(merge('1\n2\r\n3\n', '1\nO\r\n3\n', '1\nT\r\n3\n').text).toBe('1\n<<<<<<< ours\nO\r\n=======\nT\r\n>>>>>>> theirs\n3\n');
    expect(merge('', 'O\r\n', 'T\r\n').text).toBe('<<<<<<< ours\nO\r\n=======\nT\r\n>>>>>>> theirs\n');
  });

  it("picks each conflict's marker ending from the line before it in ours and theirs, and the base's first line", () => {
    expect(merge('a\r\nb\n', 'a\r\nO\n', 'a\r\nT\n').text).toBe('a\r\n<<<<<<< ours\r\nO\n=======\r\nT\n>>>>>>> theirs\r\n');
    // Not the files' first lines: theirs starts with an LF line.
    expect(merge('x\r\nalpha\n', 'x\r\ndelta\nx\r\n', 'beta\nx\r\nk1\n').text).toBe('beta\nx\r\n<<<<<<< ours\r\ndelta\nx\r\n=======\r\nk1\n>>>>>>> theirs\r\n');
    // Refined: the sides' line before is the line they share.
    expect(merge('p\r\n1\n2\n', 'p\r\nA\nB\n', 'p\r\nA\nX\n').text).toBe('p\r\nA\n<<<<<<< ours\nB\n=======\nX\n>>>>>>> theirs\n');
    expect(merge('p\n1\n2\n', 'p\nA\r\nB\n', 'p\nA\r\nX\n').text).toBe('p\nA\r\n<<<<<<< ours\nB\n=======\nX\n>>>>>>> theirs\n');
    expect(merge('p\r\n1\n2\n3\n4\n5\n6\n7\n', 'p\r\nA\r\nB\nk1\nk2\nk3\nk4\nD\n', 'p\r\nA\r\nX\nk1\nk2\nk3\nk4\nY\n').text).toBe(
      'p\r\nA\r\n<<<<<<< ours\r\nB\n=======\r\nX\n>>>>>>> theirs\r\nk1\nk2\nk3\nk4\n<<<<<<< ours\nD\n=======\nY\n>>>>>>> theirs\n',
    );
    expect(merge('f\r\nP\n1\n2\n', 'f\r\nP\nA\r\nB\n', 'f\r\nP\nA\r\nX\n').text).toBe('f\r\nP\nA\r\n<<<<<<< ours\r\nB\n=======\r\nX\n>>>>>>> theirs\r\n');
    // The base's first line, not the line before the conflict.
    expect(merge('f\nP\r\nb\n', 'f\nP\r\nO\n', 'f\nP\r\nT\n').text).toBe('f\nP\r\n<<<<<<< ours\nO\n=======\nT\n>>>>>>> theirs\n');
    expect(merge('alpha\nk3\nk1\nx\r\n', 'alpha\nk3\nk1\nx\r\nx\r\n', 'alpha\nk3\nk1\nx\r\ndelta\n').text).toBe('alpha\nk3\nk1\nx\r\n<<<<<<< ours\nx\r\n=======\ndelta\n>>>>>>> theirs\n');
    // At the start of the file, a side that deleted its lines stands in with the line after.
    expect(merge('b\r\nz\r\n', 'z\r\n', 'T\r\nz\r\n').text).toBe('<<<<<<< ours\r\n=======\r\nT\r\n>>>>>>> theirs\r\nz\r\n');
    // An empty side, or a side's line without a newline, doesn't decide; the base's must be CRLF.
    expect(merge('b\r\nz\n', '', 'T\r\n').text).toBe('<<<<<<< ours\r\n=======\r\nT\r\n>>>>>>> theirs\r\n');
    expect(merge('b\r\nz\n', '', 'T\n').text).toBe('<<<<<<< ours\n=======\nT\n>>>>>>> theirs\n');
    expect(merge('b\r\n', 'O', 'T').text).toBe('<<<<<<< ours\r\nO\r\n=======\r\nT\r\n>>>>>>> theirs\r\n');
    expect(merge('b', 'O\r\n', 'T\r\n').text).toBe('<<<<<<< ours\nO\r\n=======\nT\r\n>>>>>>> theirs\n');
  });
});

describe('renderMerge', () => {
  it("writes an empty label after its space, as merge-file -L '' does", () => {
    expect(mergeTexts('1\n', 'A\n', 'B\n', 'diff3', { ours: '', base: '', theirs: '' }).text).toBe('<<<<<<< \nA\n||||||| \n1\n=======\nB\n>>>>>>> \n');
  });
});
