import { describe, expect, it } from 'vitest';
import { createFilePathError } from './createFile';

describe('createFilePathError (UX round 3 O.1)', () => {
  it('takes a relative path, new folders included', () => {
    for (const ok of ['a.txt', 'docs/new/notes.md', '.gitignore', '.github/workflows/ci.yml', 'my.git/x', 'a b/c d.txt']) expect(createFilePathError(ok), ok).toBeNull();
  });
  it('refuses an empty name, an absolute path, .., .git and malformed paths', () => {
    expect(createFilePathError('')).toBe('Enter a file name');
    expect(createFilePathError('   ')).toBe('Enter a file name');
    expect(createFilePathError('/etc/passwd')).toBe('Enter a path relative to the repository');
    expect(createFilePathError('C:/x')).toBe('Enter a path relative to the repository');
    expect(createFilePathError('../x')).toBe('The path can\'t leave the repository (..)');
    expect(createFilePathError('a/../../x')).toBe('The path can\'t leave the repository (..)');
    for (const g of ['.git/config', 'sub/.git/x', '.GIT/x', '.git./x', '.git']) expect(createFilePathError(g), g).toBe('Files can\'t be created in .git');
    expect(createFilePathError('docs/')).toBe('Enter a file name after the folder');
    expect(createFilePathError('a//b')).toBe('The path has an empty or "." folder');
    expect(createFilePathError('./a')).toBe('The path has an empty or "." folder');
    expect(createFilePathError('a\\b')).toBe('A file name can\'t contain \\ or NUL');
  });
});
