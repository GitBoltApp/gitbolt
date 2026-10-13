import { describe, expect, it } from 'vitest';
import { classify } from './classify';

const SHA = '3f2a9c1d4e5b6a7980c1d2e3f4a5b6c7d8e9f001';
const GL = { host: 'gitlab.example.test', project: 'harbor/tools/dock', forge: 'gitlab' } as const;
const GH = { host: 'github.com', project: 'octo-org/dock', forge: 'github' } as const;

describe('classify', () => {
  it('reads commit hashes of 7 to 40 hex characters, trimmed', () => {
    expect(classify('  3f2a9c1\n')).toEqual({ kind: 'commit', sha: '3f2a9c1', ref: '3f2a9c1', loose: false });
    expect(classify('1234567')).toMatchObject({ kind: 'commit', loose: true });
    expect(classify('defaced')).toMatchObject({ kind: 'commit', loose: true });
    expect(classify(SHA.toUpperCase())).toMatchObject({ kind: 'commit', sha: SHA });
    expect(classify(`commit ${SHA}`)).toMatchObject({ kind: 'commit', sha: SHA });
    expect(classify(`commit ${SHA} (HEAD -> main, origin/main)`)).toMatchObject({ kind: 'commit', sha: SHA });
    expect(classify('3f2a9c')).toMatchObject({ kind: 'path', loose: true });
    expect(classify(`${SHA}0`)).not.toMatchObject({ kind: 'commit' });
  });

  it('reads GitLab MR URLs, whatever follows the number', () => {
    for (const tail of ['', '/', '/diffs', '#note_123', '/diffs#note_9', '?tab=commits']) {
      expect(classify(`https://gitlab.example.test/harbor/tools/dock/-/merge_requests/12${tail}`))
        .toEqual({ kind: 'mr', number: 12, url: `https://gitlab.example.test/harbor/tools/dock/-/merge_requests/12${tail}`, at: GL, project: GL.project, sigil: null });
    }
  });

  it('reads GitHub PR URLs', () => {
    for (const tail of ['', '/files', '/commits', '#issuecomment-5']) {
      expect(classify(`https://github.com/octo-org/dock/pull/7${tail}`)).toMatchObject({ kind: 'mr', number: 7, at: GH });
    }
    expect(classify('https://GitHub.com/octo-org/dock/pull/7')).toMatchObject({ at: GH });
  });

  it("reads an MR's commit as the commit", () => {
    expect(classify(`https://gitlab.example.test/harbor/tools/dock/-/merge_requests/12/diffs?commit_id=${SHA}`)).toMatchObject({ kind: 'forgeCommit', sha: SHA, at: GL });
    expect(classify(`https://github.com/octo-org/dock/pull/7/commits/${SHA}`)).toMatchObject({ kind: 'forgeCommit', sha: SHA, at: GH });
  });

  it('reads short MR references', () => {
    expect(classify('!12')).toEqual({ kind: 'mr', number: 12, url: null, at: null, project: null, sigil: '!' });
    expect(classify('#7')).toMatchObject({ kind: 'mr', number: 7, sigil: '#' });
    expect(classify('harbor/other!12')).toMatchObject({ kind: 'mr', number: 12, project: 'harbor/other', sigil: '!' });
    expect(classify('!12a').kind).not.toBe('mr');
  });

  it('reads commit pages', () => {
    expect(classify(`https://gitlab.example.test/harbor/tools/dock/-/commit/${SHA}`)).toMatchObject({ kind: 'forgeCommit', sha: SHA, at: GL });
    expect(classify(`https://github.com/octo-org/dock/commit/${SHA.slice(0, 7).toUpperCase()}/`)).toMatchObject({ kind: 'forgeCommit', sha: SHA.slice(0, 7), at: GH });
  });

  it('reads file pages with their lines, decoded', () => {
    expect(classify('https://gitlab.example.test/harbor/tools/dock/-/blob/main/src/a%20b.php#L12-20'))
      .toMatchObject({ kind: 'forgeFile', refPath: ['main', 'src', 'a b.php'], lines: { start: 12, end: 20 }, at: GL });
    expect(classify('https://github.com/octo-org/dock/blob/feature/x/README.md#L20-L12'))
      .toMatchObject({ kind: 'forgeFile', refPath: ['feature', 'x', 'README.md'], lines: { start: 12, end: 20 } });
    expect(classify('https://github.com/octo-org/dock/blob/main/a.txt?plain=1#L3')).toMatchObject({ lines: { start: 3, end: 3 } });
    expect(classify('https://github.com/octo-org/dock/blob/main/a.txt')).toMatchObject({ lines: null });
  });

  it('ignores other URLs', () => {
    for (const u of ['https://github.com/octo-org/dock', 'https://github.com/octo-org/dock/issues/3', 'https://gitlab.example.test/harbor/-/issues/2', 'mailto:a@example.test', 'ftp://example.test/x', 'https://']) {
      expect(classify(u)).toEqual({ kind: 'none' });
    }
  });

  it('reads relative paths with lines', () => {
    expect(classify('src/app.php')).toEqual({ kind: 'path', path: 'src/app.php', absolute: false, lines: null, loose: false, ref: 'src/app.php' });
    expect(classify('src/app.php:12')).toMatchObject({ path: 'src/app.php', lines: { start: 12, end: 12 }, ref: null });
    expect(classify('src/app.php:12-20')).toMatchObject({ lines: { start: 12, end: 20 } });
    expect(classify('src/app.php:20-12')).toMatchObject({ lines: { start: 12, end: 20 } });
    expect(classify('src/app.php:12:5')).toMatchObject({ path: 'src/app.php', lines: { start: 12, end: 12 } });
    expect(classify('src/app.php#L12')).toMatchObject({ lines: { start: 12, end: 12 } });
    expect(classify('src/app.php#L12-L20')).toMatchObject({ lines: { start: 12, end: 20 } });
    expect(classify('./src//lib/../app.php')).toMatchObject({ path: 'src/app.php' });
    expect(classify('src/')).toMatchObject({ path: 'src', loose: false });
    expect(classify('../outside.txt')).toEqual({ kind: 'none' });
    expect(classify('README')).toMatchObject({ kind: 'path', loose: true, ref: 'README' });
    expect(classify('Makefile:12')).toMatchObject({ kind: 'path', path: 'Makefile', lines: { start: 12, end: 12 }, loose: true });
    expect(classify('app.php')).toMatchObject({ kind: 'path', loose: true });
  });

  it('reads absolute and Windows paths', () => {
    expect(classify('/home/ada/harbor/src/a.ts:4')).toMatchObject({ path: '/home/ada/harbor/src/a.ts', absolute: true, lines: { start: 4, end: 4 } });
    expect(classify('/home/ada/My Repo/a.ts')).toMatchObject({ path: '/home/ada/My Repo/a.ts', absolute: true });
    expect(classify('c:\\Users\\ada\\harbor\\src\\a.ts')).toMatchObject({ path: 'C:/Users/ada/harbor/src/a.ts', absolute: true, lines: null });
    expect(classify('C:\\Users\\ada\\harbor\\src\\a.ts:12-14')).toMatchObject({ path: 'C:/Users/ada/harbor/src/a.ts', lines: { start: 12, end: 14 } });
    expect(classify('C:/x/a.ts:3:9')).toMatchObject({ path: 'C:/x/a.ts', lines: { start: 3, end: 3 } });
    expect(classify('src\\a.ts')).toMatchObject({ path: 'src/a.ts', absolute: false });
    expect(classify('\\\\server\\share\\a.ts')).toMatchObject({ path: '//server/share/a.ts', absolute: true });
    expect(classify('file:///home/ada/harbor/a%20b.ts')).toMatchObject({ path: '/home/ada/harbor/a b.ts', absolute: true });
    expect(classify('file:///C:/x/a.ts')).toMatchObject({ path: 'C:/x/a.ts', absolute: true });
  });

  it('reads ref names', () => {
    expect(classify('main')).toMatchObject({ kind: 'path', loose: true, ref: 'main' });
    expect(classify('origin/feature/x')).toMatchObject({ kind: 'path', ref: 'origin/feature/x' });
    expect(classify('feature..x')).toMatchObject({ ref: null });
  });

  it('ignores sentences, empty text and text too long to be a target', () => {
    expect(classify('fix the bug in src/a.ts')).toEqual({ kind: 'none' });
    expect(classify('   \n \n')).toEqual({ kind: 'none' });
    expect(classify(`src/${'a'.repeat(5000)}`)).toEqual({ kind: 'none' });
  });

  it('takes the first non-empty line only if it names something alone', () => {
    expect(classify(`\n  ${SHA}\nsecond line\n`)).toMatchObject({ kind: 'commit', sha: SHA });
    expect(classify('a sentence here\nsrc/a.ts')).toEqual({ kind: 'none' });
  });
});
