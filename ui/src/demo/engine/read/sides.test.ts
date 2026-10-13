import { describe, expect, it } from 'vitest';
import { bytesOf, lfsSideOf, resolve, resolveSource, sizeOf, submoduleText } from './sides';
import { makeTestRepo, writeNested } from './testkit';

const OID64 = 'b'.repeat(64);

describe('blob sides', () => {
  it('resolves objects, files at a commit, worktree files and links', async () => {
    const t = await makeTestRepo();
    await t.write('docs/a.txt', 'hello\n');
    const c = await t.commit('A');
    await t.link('link.txt', 'docs/a.txt');
    const atCommit = await resolveSource(t.repo, 'docs/a.txt', { kind: 'atCommit', commit: c });
    const r = (await resolve(t.repo, 'docs/a.txt', atCommit))!;
    expect(r.kind).toBe('blob');
    expect(await sizeOf(t.repo, r)).toBe(6);
    await expect(resolve(t.repo, 'nope.txt', atCommit)).rejects.toMatchObject({ kind: 'NotFound', message: `nope.txt does not exist at ${c}` });
    const wt = await resolveSource(t.repo, 'link.txt', { kind: 'worktree', worktree: t.dir });
    const link = (await resolve(t.repo, 'link.txt', wt))!;
    expect(link.kind).toBe('link');
    expect(new TextDecoder().decode((await bytesOf(t.repo, link, 100))!.bytes)).toBe('docs/a.txt');
    await expect(resolveSource(t.repo, '../x', { kind: 'worktree', worktree: t.dir })).rejects.toMatchObject({ kind: 'InvalidInput' });
    await expect(resolveSource(t.repo, 'a', { kind: 'object', oid: 'abc' })).rejects.toMatchObject({ kind: 'InvalidInput' });
    await expect(resolve(t.repo, 'docs', await resolveSource(t.repo, 'docs', { kind: 'worktree', worktree: t.dir }))).rejects.toMatchObject({ kind: 'InvalidInput', message: 'docs is not a file' });
    const file = (await resolve(t.repo, 'docs/a.txt', await resolveSource(t.repo, 'docs/a.txt', { kind: 'worktree', worktree: t.dir })))!;
    expect(await bytesOf(t.repo, file, 3)).toBeNull();
  });

  it('reads an LFS pointer as its stored file, or as missing', async () => {
    const t = await makeTestRepo();
    await t.write('.gitattributes', '*.png filter=lfs diff=lfs merge=lfs -text\n');
    await t.write('art/cover.png', `version https://git-lfs.github.com/spec/v1\noid sha256:${OID64}\nsize 4\n`);
    const c = await t.commit('Art');
    const side = await resolveSource(t.repo, 'art/cover.png', { kind: 'atCommit', commit: c });
    const missing = (await resolve(t.repo, 'art/cover.png', side))!;
    expect(missing.kind).toBe('lfsMissing');
    expect(lfsSideOf(missing)).toMatchObject({ oid: OID64, size: 4, downloaded: false });
    await t.write(`.git/lfs/objects/bb/bb/${OID64}`, new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
    const found = (await resolve(t.repo, 'art/cover.png', side))!;
    expect(found.kind).toBe('lfs');
    expect((await bytesOf(t.repo, found, 100))!.bytes[1]).toBe(0x50);
    expect(await sizeOf(t.repo, found)).toBe(4);
  });

  it('names a submodule commit and, when its repository has it, its subject', async () => {
    const t = await makeTestRepo();
    const head = await writeNested(t, 'libs/parser', 'parser', { 'p.txt': 'p\n' });
    await t.write('.gitmodules', '[submodule "parser"]\n\tpath = libs/parser\n');
    expect(await submoduleText(t.repo, 'libs/parser', head)).toBe(`Subproject commit ${head}\nStart parser\n`);
    expect(await submoduleText(t.repo, 'libs/parser', 'c'.repeat(40))).toBe(`Subproject commit ${'c'.repeat(40)}\n`);
    expect(await submoduleText(t.repo, 'libs/theme', head)).toBe(`Subproject commit ${head}\n`);
  });
});
