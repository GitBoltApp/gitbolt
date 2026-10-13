import { describe, expect, it } from 'vitest';
import { cachedObject, filterConfigured, lfsPatterns, lfsTracked, parsePointer, topPatterns, usesLfs } from './lfs';
import { makeTestRepo } from './testkit';

const OID = 'a'.repeat(64);
const pointer = (size = 12345) => new TextEncoder().encode(`version https://git-lfs.github.com/spec/v1\noid sha256:${OID}\nsize ${size}\n`);

describe('lfs', () => {
  it('parses pointers strictly', () => {
    expect(parsePointer(pointer())).toEqual({ oid: OID, size: 12345 });
    expect(parsePointer(new TextEncoder().encode('version https://hawser.github.com/spec/v1\noid sha256:' + OID + '\nsize 1\n'))).toEqual({ oid: OID, size: 1 });
    expect(parsePointer(new TextEncoder().encode('version https://git-lfs.github.com/spec/v1\noid sha256:4d7a\nsize 1\n'))).toBeNull();
    expect(parsePointer(new TextEncoder().encode('version https://git-lfs.github.com/spec/v1\noid sha256:' + OID + '\n'))).toBeNull();
    expect(parsePointer(new TextEncoder().encode('hello\n'))).toBeNull();
    expect(parsePointer(new Uint8Array(2000).fill(0x61))).toBeNull();
  });

  it('reads patterns, the store and the repository\'s use of LFS', async () => {
    expect(lfsPatterns('# c\n*.png filter=lfs diff=lfs merge=lfs -text\n*.md text\n  *.psd filter=lfs\n')).toEqual(['*.png', '*.psd']);
    const t = await makeTestRepo();
    await t.write('README.md', 'hi\n');
    await t.commit('Plain');
    expect(await usesLfs(t.repo)).toBe(false);
    await t.write('.gitattributes', '*.png filter=lfs diff=lfs merge=lfs -text\n');
    await t.commit('Track art');
    expect(await usesLfs(t.repo)).toBe(true);
    expect(await topPatterns(t.repo, t.dir)).toEqual(['*.png']);
    expect(await lfsTracked(t.repo, t.dir, ['art/cover.png', 'README.md'])).toEqual(['art/cover.png']);
    await expect(lfsTracked(t.repo, t.dir, ['../x'])).rejects.toMatchObject({ kind: 'InvalidInput' });
    expect(await filterConfigured(t.repo)).toBe(false);
    expect(await cachedObject(t.repo, { oid: OID, size: 3 })).toBeNull();
    await t.write(`.git/lfs/objects/aa/aa/${OID}`, 'abc');
    expect(await cachedObject(t.repo, { oid: OID, size: 3 })).toBe(`${t.dir}/.git/lfs/objects/aa/aa/${OID}`);
    expect(await cachedObject(t.repo, { oid: OID, size: 4 })).toBeNull();
  });
});
