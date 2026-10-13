import { describe, expect, it } from 'vitest';
import { MODE_EXEC, MODE_FILE, MODE_LINK } from './trees';
import { checkRelative, gitmodules, isDotgit, nestedHead, parseGitmodules, pathKind, safeJoin, untrackedFiles, worktreeFile } from './worktree';
import { makeTestRepo } from './testkit';

describe('worktree files', () => {
  it('refuses paths that leave the worktree or reach .git, in any spelling', () => {
    for (const bad of ['', '../x', '/etc/passwd', '.git/config', 'docs/../../x', 'docs/', 'docs//m.txt', 'docs/./m.txt', '.GIT/config', '.git./config', '.git /config', 'GIT~1/config', '.g\u200Cit/config', 'a\0b']) {
      expect(() => checkRelative(bad), bad).toThrowError(expect.objectContaining({ kind: 'InvalidInput' }));
    }
    expect(() => checkRelative('.gitignore-like.txt')).not.toThrow();
    expect(isDotgit('.Git')).toBe(true);
  });

  it('reads files, links and exec bits; a symlinked folder may not lead outside', async () => {
    const t = await makeTestRepo();
    await t.write('a.txt', 'hello\n');
    await t.write('run.sh', 'echo\n', { exec: true });
    await t.link('link.txt', 'a.txt');
    await t.write('docs/m.txt', 'm\n');
    await t.link('d', 'docs');
    await t.link('escape', '/demo');
    await t.link('x', '.git');
    expect(await worktreeFile(t.repo, t.dir, 'a.txt')).toMatchObject({ mode: MODE_FILE, oid: 'ce013625030ba8dba906f756967f9e9ca394464a', size: 6 });
    expect((await worktreeFile(t.repo, t.dir, 'run.sh'))?.mode).toBe(MODE_EXEC);
    const link = await worktreeFile(t.repo, t.dir, 'link.txt');
    expect([link?.mode, new TextDecoder().decode(link?.bytes)]).toEqual([MODE_LINK, 'a.txt']);
    expect(await safeJoin(t.repo, t.dir, 'd/m.txt')).toBe(`${t.dir}/docs/m.txt`);
    await expect(safeJoin(t.repo, t.dir, 'escape/x')).rejects.toMatchObject({ kind: 'InvalidInput' });
    await expect(safeJoin(t.repo, t.dir, 'x/config')).rejects.toMatchObject({ kind: 'InvalidInput' });
    await expect(safeJoin(t.repo, t.dir, 'nope/x.txt')).rejects.toMatchObject({ kind: 'NotFound' });
    expect(await worktreeFile(t.repo, t.dir, 'nope/x.txt')).toBeNull();
    expect(await worktreeFile(t.repo, t.dir, 'docs')).toBeNull();
    expect([await pathKind(t.repo, t.dir, 'docs'), await pathKind(t.repo, t.dir, 'a.txt'), await pathKind(t.repo, t.dir, 'gone')]).toEqual(['dir', 'file', null]);
  });

  it('lists untracked files one by one, skipping ignored ones and .git', async () => {
    const t = await makeTestRepo();
    await t.write('.gitignore', 'build/\n*.log\n');
    await t.write('tracked.txt', 't\n');
    await t.commit('Base');
    await t.write('new/deep/b.txt', 'b\n');
    await t.write('new/a.txt', 'a\n');
    await t.write('debug.log', 'x\n');
    await t.write('build/out.bin', 'x\n');
    expect(await untrackedFiles(t.repo, t.dir, new Set(['.gitignore', 'tracked.txt']))).toEqual(['new/a.txt', 'new/deep/b.txt']);
  });

  it('refuses symlink chains and loops that escape', async () => {
    const t = await makeTestRepo();
    await t.link('b', '.git');
    await t.link('a', 'b/refs');
    t.memfs.mkdirpSync('/outside/dir');
    await t.link('o', '/outside');
    await t.link('c', 'o/dir');
    await t.link('l1', 'l2');
    await t.link('l2', 'l1');
    for (const rel of ['a/heads', 'c/x', 'l1/x']) await expect(safeJoin(t.repo, t.dir, rel), rel).rejects.toMatchObject({ kind: 'InvalidInput' });
  });

  it('matches git for nested ignores, negation, folder patterns and info/exclude', async () => {
    const t = await makeTestRepo();
    await t.write('.gitignore', '*.log\nbuild/\n');
    await t.write('sub/.gitignore', '!x.log\n');
    await t.write('.git/info/exclude', 'secret.txt\n');
    await t.write('sub/x.log', 'x\n');
    await t.write('sub/y.log', 'y\n');
    await t.write('build/a.txt', 'a\n');
    await t.write('secret.txt', 's\n');
    await t.write('keep.txt', 'k\n');
    expect(await untrackedFiles(t.repo, t.dir, new Set())).toEqual(['.gitignore', 'keep.txt', 'sub/.gitignore', 'sub/x.log']);
  });

  it('parses .gitmodules and finds a submodule checkout HEAD', async () => {
    expect(parseGitmodules('[submodule "parser"]\n\tpath = libs/parser\n\turl = ../parser-src\n[core]\n\tx = 1\n')).toEqual([{ name: 'parser', path: 'libs/parser', url: '../parser-src' }]);
    expect(parseGitmodules('[Submodule "a"] # c\n\tPath = "x y"\n\turl = u # c\n[submodule.b]\n\tpath = "q\\"r\\\\s" ; c\n[submodule "c"]\n\tpath = "k#1"\n')).toEqual([
      { name: 'a', path: 'x y', url: 'u' },
      { name: 'b', path: 'q"r\\s', url: null },
      { name: 'c', path: 'k#1', url: null },
    ]);
    const t = await makeTestRepo();
    await t.write('.gitmodules', '[submodule "parser"]\n\tpath = libs/parser\n');
    expect(await gitmodules(t.repo, t.dir)).toEqual([{ name: 'parser', path: 'libs/parser', url: null }]);
    expect(await nestedHead(t.repo, t.dir, 'libs/parser')).toBeNull();
    const head = 'c'.repeat(40);
    t.memfs.mkdirpSync(`${t.dir}/libs/parser/.git`);
    t.memfs.writeFileSync(`${t.dir}/libs/parser/.git/HEAD`, `${head}\n`);
    expect(await nestedHead(t.repo, t.dir, 'libs/parser')).toBe(head);
  });
});
