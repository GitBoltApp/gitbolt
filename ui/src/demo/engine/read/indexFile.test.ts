import { describe, expect, it } from 'vitest';
import { parseIndex, readIndex, serializeIndex, statMatches, type IndexEntry } from './indexFile';
import { MODE_EXEC, MODE_FILE, MODE_GITLINK } from './trees';
import { makeTestRepo, setIndex } from './testkit';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

describe('index file', () => {
  it('reads the index isomorphic-git writes', async () => {
    const t = await makeTestRepo();
    await t.write('z.txt', 'z\n');
    await t.write('dir/run.sh', 'run\n', { exec: true });
    await t.commit('First');
    const entries = await readIndex(t.repo, t.repo.gitdir);
    expect(entries.map((e) => [e.path, e.mode, e.stage])).toEqual([['dir/run.sh', MODE_EXEC, 0], ['z.txt', MODE_FILE, 0]]);
    expect(entries[1].oid).toMatch(/^[0-9a-f]{40}$/);
    const st = t.memfs.lstatSync(`${t.dir}/z.txt`);
    expect(entries[1].stat).toMatchObject({ mtimeS: Math.floor(st.mtimeMs / 1000), mtimeNs: (st.mtimeMs % 1000) * 1e6, ino: st.ino, size: 2, ctimeS: Math.floor(st.ctimeMs / 1000), uid: st.uid, gid: st.gid, dev: st.dev });
  });

  it('round-trips full stat data and intent-to-add (a version 3 index only then)', async () => {
    const stat = { mtimeS: 1000, mtimeNs: 5, ino: 7, size: 12, ctimeS: 999, ctimeNs: 6, dev: 1, uid: 2, gid: 3 };
    const v2 = await serializeIndex([{ path: 'a.txt', mode: MODE_FILE, oid: A, stage: 0, stat }]);
    expect(new DataView(v2.buffer).getUint32(4)).toBe(2);
    expect(parseIndex(v2)).toEqual([{ path: 'a.txt', mode: MODE_FILE, oid: A, stage: 0, stat }]);
    const v3 = await serializeIndex([{ path: 'b.txt', mode: MODE_FILE, oid: B, stage: 0, intentToAdd: true }, { path: 'a.txt', mode: MODE_FILE, oid: A, stage: 0 }]);
    expect(new DataView(v3.buffer).getUint32(4)).toBe(3);
    expect(parseIndex(v3).map((e) => [e.path, e.intentToAdd ?? false])).toEqual([['a.txt', false], ['b.txt', true]]);
  });

  it("passes git's stat check only for an entry whose file is unchanged and older than the index", () => {
    const e: IndexEntry = { path: 'a.txt', mode: MODE_FILE, oid: A, stage: 0, stat: { mtimeS: 1000, mtimeNs: 500_000_000, ino: 7, size: 12 } };
    const st = (over: object = {}) => ({ mode: 0o100644, size: 12, mtimeMs: 1_000_500, ino: 7, isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false, ...over });
    const later = 1_002_000;
    expect(statMatches(e, st(), later)).toBe(true);
    expect(statMatches(e, st(), 1_000_501)).toBe(true);
    // Racily clean: the index was written in the file's own tick (or before it), so the content decides.
    expect(statMatches(e, st(), 1_000_500)).toBe(false);
    expect(statMatches(e, st(), 999_000)).toBe(false);
    for (const over of [{ size: 13 }, { mtimeMs: 1_000_501 }, { ino: 8 }, { mode: 0o100755 }, { isFile: () => false, isSymbolicLink: () => true }, { mtimeMs: undefined }]) {
      expect(statMatches(e, st(over), later)).toBe(false);
    }
    expect(statMatches({ ...e, stat: undefined }, st(), later)).toBe(false);
    expect(statMatches(e, st(), null)).toBe(false);
  });

  it('round-trips conflict stages, gitlinks and non-ASCII paths through the writer', async () => {
    const entries = [
      { path: 'c.txt', mode: MODE_FILE, oid: B, stage: 3 },
      { path: 'c.txt', mode: MODE_FILE, oid: A, stage: 2 },
      { path: 'dir with space/ünï.txt', mode: MODE_FILE, oid: A, stage: 0 },
      { path: 'libs/parser', mode: MODE_GITLINK, oid: B, stage: 0 },
    ];
    const parsed = parseIndex(await serializeIndex(entries));
    expect(parsed.map((e) => [e.path, e.stage, e.oid])).toEqual([['c.txt', 2, A], ['c.txt', 3, B], ['dir with space/ünï.txt', 0, A], ['libs/parser', 0, B]]);
    expect(parsed[3].mode).toBe(MODE_GITLINK);
  });

  it('is empty without an index, and refuses version 4', async () => {
    const t = await makeTestRepo();
    expect(await readIndex(t.repo, t.repo.gitdir)).toEqual([]);
    const v4 = await serializeIndex([]);
    v4[7] = 4;
    expect(() => parseIndex(v4)).toThrowError(expect.objectContaining({ kind: 'Other' }));
    await setIndex(t, [{ path: 'x', mode: MODE_FILE, oid: A, stage: 0 }]);
    expect((await readIndex(t.repo, t.repo.gitdir)).map((e) => e.path)).toEqual(['x']);
  });

  it('parses v3 extended flags and long names', async () => {
    const long = 'n'.repeat(0x1000);
    const v2 = await serializeIndex([{ path: 'a', mode: MODE_FILE, oid: A, stage: 0 }, { path: long, mode: MODE_FILE, oid: B, stage: 0 }]);
    expect(parseIndex(v2).map((e) => e.path)).toEqual(['a', long]);
    // Rebuild as v3: entry 'a' gains the extended-flags bit and two extra bytes (72 bytes with padding).
    const body = v2.subarray(0, v2.length - 20);
    const v3 = new Uint8Array(body.length + 8);
    v3.set(body.subarray(0, 12 + 62));
    v3.set(body.subarray(12 + 64), 12 + 72); // the rest, after 'a''s old 64 bytes
    v3.set([97], 12 + 64); // the name moves past the two extended bytes
    new DataView(v3.buffer).setUint32(4, 3);
    new DataView(v3.buffer).setUint16(12 + 60, 0x4000 | 1);
    expect(parseIndex(v3).map((e) => e.path)).toEqual(['a', long]);
  });

  it('refuses a truncated index', () => {
    const bad = new Uint8Array(12 + 62 + 3);
    bad.set([68, 73, 82, 67, 0, 0, 0, 2, 0, 0, 0, 1]);
    bad.fill(1, 12 + 62);
    expect(() => parseIndex(bad)).toThrowError(expect.objectContaining({ kind: 'Other' }));
  });
});
