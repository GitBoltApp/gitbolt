import * as git from 'isomorphic-git';
import { expect, test, vi } from 'vitest';
import { scrubIndexStat } from '../../../scripts/pack-demo.mjs';
import { refreshIndexStat } from './gitindex';
import { MemFs } from './memfs';

const INDEX = '/r/.git/index';

/** A repository with a file, an executable, a symlink and a deep file committed, its index as a
 * bundle carries it (stat data zeroed). */
async function scrubbed() {
  const fs = new MemFs();
  fs.mkdirpSync('/r/src/deep');
  await git.init({ fs, dir: '/r' });
  fs.writeFileSync('/r/a.txt', 'alpha\n');
  fs.writeFileSync('/r/run.sh', '#!/bin/sh\n', { mode: 0o755 });
  fs.symlinkSync('a.txt', '/r/link');
  fs.writeFileSync('/r/src/deep/b.txt', 'beta\n');
  for (const filepath of ['a.txt', 'run.sh', 'link', 'src/deep/b.txt']) await git.add({ fs, dir: '/r', filepath });
  await git.commit({ fs, dir: '/r', message: 'Start\n', author: { name: 'Mara Quill', email: 'mara@example.com', timestamp: 1_700_000_000, timezoneOffset: 0 } });
  fs.writeFileSync(INDEX, scrubIndexStat(fs.readFileSync(INDEX) as Uint8Array));
  return fs;
}

const reads = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map((c) => c[0]).filter((p) => typeof p === 'string' && !p.includes('/.git/'));

test('refreshes the stat data of unchanged entries only, and nothing else', async () => {
  const fs = await scrubbed();
  const before = fs.readFileSync(INDEX) as Uint8Array;
  fs.writeFileSync('/r/src/deep/b.txt', 'BETA\n'); // same size, new content
  fs.writeFileSync('/r/run.sh', '#!/bin/sh\n', { mode: 0o644 }); // same content, lost its exec bit
  expect(await refreshIndexStat(fs, '/r', INDEX)).toBe(2);
  const after = fs.readFileSync(INDEX) as Uint8Array;
  expect(Buffer.from(scrubIndexStat(after)).equals(Buffer.from(before))).toBe(true);

  const spy = vi.spyOn(fs.promises, 'readFile');
  expect(await git.statusMatrix({ fs, dir: '/r', refresh: false })).toEqual([
    ['a.txt', 1, 1, 1],
    ['link', 1, 1, 1],
    ['run.sh', 1, 1, 1], // isomorphic-git's status compares contents only
    ['src/deep/b.txt', 1, 2, 1],
  ]);
  expect(reads(spy).sort()).toEqual(['/r/run.sh', '/r/src/deep/b.txt']);
});

/** Each entry's bytes and stage, in index order. */
function entries(index: Uint8Array): { stage: number; bytes: Buffer }[] {
  const b = Buffer.from(index);
  const out = [];
  for (let i = 0, o = 12; i < b.readUInt32BE(8); i++) {
    const len = Math.ceil((b.indexOf(0, o + 62) - o + 1) / 8) * 8;
    out.push({ stage: (b.readUInt16BE(o + 60) >> 12) & 3, bytes: b.subarray(o, o + len) });
    o += len;
  }
  return out;
}

test("a conflict's stages stay byte for byte, even when the file matches one of them", async () => {
  const fs = new MemFs();
  fs.mkdirpSync('/r');
  await git.init({ fs, dir: '/r', defaultBranch: 'main' });
  const author = { name: 'Mara Quill', email: 'mara@example.com', timestamp: 1_700_000_000, timezoneOffset: 0 };
  const commit = async (files: Record<string, string>, message: string) => {
    for (const [name, text] of Object.entries(files)) {
      fs.writeFileSync(`/r/${name}`, text);
      await git.add({ fs, dir: '/r', filepath: name });
    }
    await git.commit({ fs, dir: '/r', message, author });
  };
  await commit({ 'a.txt': 'base\n', 'b.txt': 'beta\n' }, 'Base\n');
  await git.branch({ fs, dir: '/r', ref: 'other' });
  await commit({ 'a.txt': 'ours\n' }, 'Ours\n');
  await git.checkout({ fs, dir: '/r', ref: 'other' });
  await commit({ 'a.txt': 'theirs\n' }, 'Theirs\n');
  await git.checkout({ fs, dir: '/r', ref: 'main' });
  await expect(git.merge({ fs, dir: '/r', theirs: 'other', abortOnConflict: false, author })).rejects.toMatchObject({ code: 'MergeConflictError' });
  fs.writeFileSync(INDEX, scrubIndexStat(fs.readFileSync(INDEX) as Uint8Array));
  // The conflicted file back as ours (stage 2): a refresh that ignored stages would take it.
  fs.writeFileSync('/r/a.txt', 'ours\n');
  const before = fs.readFileSync(INDEX) as Uint8Array;
  expect(entries(before).map((e) => e.stage)).toEqual([1, 2, 3, 0]);

  expect(await refreshIndexStat(fs, '/r', INDEX)).toBe(1);
  const after = fs.readFileSync(INDEX) as Uint8Array;
  const stages = (index: Uint8Array) => entries(index).filter((e) => e.stage > 0).map((e) => e.bytes.toString('hex'));
  expect(stages(after)).toEqual(stages(before));
  expect(Buffer.from(scrubIndexStat(after)).equals(Buffer.from(before))).toBe(true);
  expect(await git.statusMatrix({ fs, dir: '/r', refresh: false })).toContainEqual(['b.txt', 1, 1, 1]);
});

test('leaves an index that is not version 2, or not there, alone', async () => {
  const fs = await scrubbed();
  const v3 = new Uint8Array(fs.readFileSync(INDEX) as Uint8Array);
  v3[7] = 3;
  fs.writeFileSync(INDEX, scrubIndexStat(v3)); // checksum redone: only the version is wrong
  const before = fs.readFileSync(INDEX) as Uint8Array;
  expect(await refreshIndexStat(fs, '/r', INDEX)).toBe(0);
  expect(fs.readFileSync(INDEX)).toEqual(before);
  // The same index as version 2 is refreshed.
  fs.writeFileSync(INDEX, scrubIndexStat(Object.assign(before, { 7: 2 })));
  expect(await refreshIndexStat(fs, '/r', INDEX)).toBe(4);
  expect(await refreshIndexStat(fs, '/r', '/r/.git/no-index')).toBe(0);
});

test('skips an entry whose file is gone', async () => {
  const fs = await scrubbed();
  fs.unlinkSync('/r/link');
  expect(await refreshIndexStat(fs, '/r', INDEX)).toBe(3);
});
