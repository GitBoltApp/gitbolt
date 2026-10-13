import { describe, expect, it } from 'vitest';
import { blameFile, blameRuns } from './blame';
import { latin1 } from './bytes';
import { readCommit } from './commitText';
import { diffLines, splitLines } from './lineDiff';
import { ADA, GRACE, makeTestRepo, mergeRepo, storyRepo, type TestRepo } from './testkit';
import { entryAt, readBlobBytes } from './trees';

/** Each final line's commit message, in order. */
async function perLine(t: TestRepo, rev: string, path: string): Promise<string[]> {
  const b = await blameFile(t.repo, rev, path);
  const out: string[] = [];
  for (const h of b.hunks) for (let i = 0; i < h.lines; i++) out.push(b.commits.find((c) => c.sha === h.sha)!.summary);
  return out;
}

const spans = async (t: TestRepo, rev: string, path: string) => (await blameFile(t.repo, rev, path)).hunks.map((h) => [h.start, h.lines]);

describe('blame', () => {
  it('groups lines by the commit that last changed them, through a rename', async () => {
    const { t, middle, head } = await storyRepo();
    const b = await blameFile(t.repo, head, 'src/story.txt');
    const summary = (sha: string) => b.commits.find((c) => c.sha === sha)!.summary;
    expect(b.hunks.map((h) => [summary(h.sha), h.start, h.lines])).toEqual([
      ['Sharpen the opening', 1, 1],
      ['Start the story', 2, 1],
      ['Add the middle', 3, 2],
      ['Start the story', 5, 1],
      ['Move the story under src', 6, 1],
      ['Start the story', 7, 2],
    ]);
    expect(b.commits.map((c) => c.summary)).toEqual(['Sharpen the opening', 'Start the story', 'Add the middle', 'Move the story under src']);
    const start = b.commits.find((c) => c.summary === 'Start the story')!;
    expect(start).toMatchObject({ author: 'Ada Lovelace', email: 'ada@example.com', boundary: true });
    expect(start.time).toBeGreaterThan(0);
    expect(b.commits.find((c) => c.summary === 'Add the middle')!.boundary).toBe(false);
    expect(await spans(t, middle, 'story.txt')).toEqual([[1, 2], [3, 2], [5, 4]]);
    await expect(blameFile(t.repo, head, 'nope.txt')).rejects.toMatchObject({ kind: 'Other', message: `no such path nope.txt in ${head}` });
    await expect(blameFile(t.repo, head, 'src')).rejects.toMatchObject({ kind: 'Other' });
  });

  it('follows each parent of a merge', async () => {
    const { t, base, main, side, merge } = await mergeRepo();
    const b = await blameFile(t.repo, merge, 'f');
    expect(b.hunks.map((h) => [h.sha, h.start, h.lines])).toEqual([[base, 1, 1], [main, 2, 1], [side, 3, 1]]);
  });

  it('hands every line to a parent with the same blob, even the second', async () => {
    const t = await makeTestRepo();
    await t.write('f', 'a\n');
    const base = await t.commit('base');
    await t.write('f', 'a\nb\n');
    const main = await t.commit('main');
    await t.branch('side', base);
    await t.checkout('side');
    await t.write('f', 'x\na\nb\n');
    await t.commit('side');
    const side = await t.rev('side');
    await t.checkout('main');
    await t.write('f', 'x\na\nb\n');
    const merge = await t.commit('merge', ADA, { parents: [main, side] });
    // `b` matches main's line 2, but side has the same blob: git gives side all three.
    expect(await perLine(t, merge, 'f')).toEqual(['side', 'base', 'side']);
  });

  it("prefers a parent's same file at the same path to an earlier parent's rename of it", async () => {
    const t = await makeTestRepo();
    await t.write('f', 'end');
    const base = await t.commit('base');
    await t.remove('f');
    await t.write('g', 'x\n');
    await t.commit('other');
    await t.write('g', 'end');
    const edit = await t.commit('edit');
    await t.remove('g');
    await t.write('f', 'end');
    // The first parent's g is the same blob (through a rename), but base has it as f.
    const merge = await t.commit('merge', ADA, { parents: [edit, base] });
    expect((await blameFile(t.repo, merge, 'f')).hunks).toEqual([{ sha: base, start: 1, lines: 1 }]);
  });

  it('passes a line that reaches a merge by two paths to the right parent both times', async () => {
    const t = await makeTestRepo();
    const at = async (msg: string, text: string, parents: string[]) => {
      await t.write('f', text);
      return t.commit(msg, ADA, { parents });
    };
    const p1 = await at('P1', 'l2\n', []);
    const p2 = await at('P2', 'l0\nl1\n', []);
    const x = await at('X', 'l0\nl1\nl2\nl3\n', [p1, p2]);
    await t.write('other', 'o\n');
    const c1 = await at('C1', 'l0\nl1\nl2\nl3\n', [x]);
    const c2 = await at('C2', 'u\nl1\n', [x]);
    // X's l1 arrives twice: in all of X's lines (through C1) and alone (through C2). P1 keeps only
    // l2, so what's left for P2 isn't in line order any more.
    const h = await at('H', 'l0\nl1\nl2\nl3\nu\nl1\n', [c1, c2]);
    expect(await perLine(t, h, 'f')).toEqual(['P2', 'P2', 'P1', 'X', 'C2', 'P2']);
  });

  it('repeated lines are each blamed once', async () => {
    const t = await makeTestRepo();
    await t.write('r.txt', '}\n}\n');
    const one = await t.commit('One', ADA);
    await t.write('r.txt', '}\n}\n}\n}\n');
    const two = await t.commit('Two', GRACE);
    const b = await blameFile(t.repo, two, 'r.txt');
    expect(b.hunks.map((h) => [h.sha, h.start, h.lines])).toEqual([[one, 1, 2], [two, 3, 2]]);
    expect(b.commits.map((c) => c.sha)).toEqual([one, two]);
    // A repeated line both versions share is passed on once, not to each copy.
    await t.write('r.txt', '}\nx\n}\n}\n}\n');
    const three = await t.commit('Three', ADA);
    expect(await perLine(t, three, 'r.txt')).toEqual(['One', 'Three', 'One', 'Two', 'Two']);
  });

  it('follows a rename only from a deleted file, whatever else was added', async () => {
    const t = await makeTestRepo();
    const ten = Array.from({ length: 10 }, (_, i) => `line ${i + 1}\n`).join('');
    await t.write('a.txt', ten);
    await t.write('dir/f', ten.replace('line 1\n', 'dir 1\n'));
    await t.commit('add');
    await t.remove('a.txt');
    await t.write('b.txt', ten);
    await t.write('c.txt', ten); // b.txt and c.txt both come from a.txt
    await t.remove('dir/f');
    t.memfs.rmdirSync(`${t.dir}/dir`);
    await t.write('dir', ten.replace('line 1\n', 'dir 1\n')); // a folder replaced by a file follows dir/f
    const moved = await t.commit('move');
    expect(await perLine(t, moved, 'b.txt')).toEqual(Array(10).fill('add'));
    expect(await perLine(t, moved, 'c.txt')).toEqual(Array(10).fill('add'));
    expect(await perLine(t, moved, 'dir')).toEqual(Array(10).fill('add'));
    await t.write('copy.txt', ten); // a copy: b.txt is kept
    const copied = await t.commit('copy');
    expect(await perLine(t, copied, 'copy.txt')).toEqual(Array(10).fill('copy'));
  });

  it("doesn't carry lines across a change of kind (symlink and regular file)", async () => {
    const t = await makeTestRepo();
    await t.write('l', 'target\nb\n');
    await t.commit('file');
    await t.remove('l');
    await t.link('l', 'target\nc');
    const head = await t.commit('link');
    expect(await perLine(t, head, 'l')).toEqual(['link', 'link']);
    // A type change is no rename destination, even with a deleted file to pair with.
    const ten = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}\n`).join('');
    await t.write('old.txt', ten(10));
    await t.commit('old');
    await t.remove('old.txt');
    await t.remove('l');
    await t.write('l', ten(11));
    const typed = await t.commit('typed');
    expect(await perLine(t, typed, 'l')).toEqual(Array(11).fill('typed'));
  });

  it('compares lines byte for byte: CRLF and a missing final newline', async () => {
    const t = await makeTestRepo();
    await t.write('f', 'a\nb\nc');
    await t.commit('one');
    await t.write('f', 'a\nb\r\nc\n');
    const head = await t.commit('two');
    expect(await perLine(t, head, 'f')).toEqual(['one', 'two', 'two']);
    await t.write('f', 'a\nb\r\nc\nd');
    const more = await t.commit('three');
    expect(await perLine(t, more, 'f')).toEqual(['one', 'two', 'two', 'three']);
  });

  it('blames what came back after the file was emptied or deleted on its return', async () => {
    const t = await makeTestRepo();
    await t.write('f', 'a\nb\n');
    await t.write('g', 'a\nb\n');
    await t.commit('one');
    await t.write('f', '');
    await t.remove('g');
    const empty = await t.commit('gone');
    expect((await blameFile(t.repo, empty, 'f')).hunks).toEqual([]);
    await t.write('f', 'a\nb\n');
    await t.write('g', 'a\nb\n');
    const back = await t.commit('back');
    expect(await perLine(t, back, 'f')).toEqual(['back', 'back']);
    expect(await perLine(t, back, 'g')).toEqual(['back', 'back']);
  });

  it('keeps runs of one commit apart unless their lines continue each other there', async () => {
    const t = await makeTestRepo();
    await t.write('f', 'a\nb\nc\nd\n');
    const one = await t.commit('one');
    await t.write('f', 'a\nd\n');
    const two = await t.commit('two');
    const b = await blameFile(t.repo, two, 'f');
    expect(b.hunks).toEqual([{ sha: one, start: 1, lines: 1 }, { sha: one, start: 2, lines: 1 }]);
    expect(b.commits).toHaveLength(1);
    // A moved block: the diff keeps the lines that stayed, as git's does.
    await t.write('f', '1\n2\n3\n4\n5\n6\n7\n8\n');
    await t.commit('eight');
    await t.write('f', '5\n6\n7\n8\n1\n2\n3\n4\n');
    const moved = await t.commit('moved');
    expect(await perLine(t, moved, 'f')).toEqual([...Array(4).fill('eight'), ...Array(4).fill('moved')]);
  });

  it('gives every line exactly one commit, one that has that line there (property)', async () => {
    let seed = 0x5eed;
    const rand = (n: number) => {
      seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
      return seed % n;
    };
    const alphabet = ['}\n', '{\n', '\n', 'a\n', 'b\n', '  x\n', 'end'];
    const t = await makeTestRepo();
    const history: string[] = [];
    const versions: string[][] = [];
    let lines: string[] = [];
    for (let k = 0; k < 40; k++) {
      lines = lines.filter((l) => l.endsWith('\n'));
      // A merge takes a run of lines from an older commit's version.
      const other = k > 2 && rand(4) === 0 ? rand(k - 1) : -1;
      if (other >= 0) {
        const theirs = versions[other].filter((l) => l.endsWith('\n'));
        const from = rand(theirs.length + 1);
        lines.splice(rand(lines.length + 1), 0, ...theirs.slice(from, from + 1 + rand(6)));
      }
      for (let e = 1 + rand(4); e > 0; e--) {
        const at = rand(lines.length + 1);
        const op = rand(3);
        if (op === 0 && lines.length > 0) lines.splice(at, 1 + rand(3));
        else lines.splice(at, op === 1 ? 1 : 0, ...Array.from({ length: 1 + rand(3) }, () => alphabet[rand(alphabet.length - 1)]));
      }
      if (rand(5) === 0) lines.push(alphabet[alphabet.length - 1]);
      await t.write('p.txt', lines.join(''));
      versions.push([...lines]);
      history.push(await t.commit(`c${k}`, ADA, { parents: other >= 0 ? [history[k - 1], history[other]] : undefined }));
    }
    const fileAt = async (commit: string) => {
      const e = await entryAt(t.repo, (await readCommit(t.repo, commit)).tree, 'p.txt');
      return e ? splitLines(latin1(await readBlobBytes(t.repo, e.oid))) : null;
    };
    const merges = (await Promise.all(history.map((id) => readCommit(t.repo, id)))).filter((c) => c.parents.length > 1).length;
    expect(merges).toBeGreaterThan(3);
    const blamed = new Set<string>();
    for (const rev of history) {
      const final = (await fileAt(rev))!;
      const runs = await blameRuns(t.repo, rev, 'p.txt');
      expect(runs.reduce((n, r) => (expect(r.final).toBe(n), n + r.count), 0)).toBe(final.length);
      for (const r of runs) {
        blamed.add(r.commit);
        const there = (await fileAt(r.commit))!;
        const parentFiles = await Promise.all(r.parsed.parents.map(fileAt));
        for (let i = 0; i < r.count; i++) {
          expect(there[r.at + i]).toBe(final[r.final + i]);
          // ...and the commit changed it: no parent's version kept that line.
          for (const pf of parentFiles) {
            if (!pf) continue;
            const kept = diffLines(pf, there).every((e) => r.at + i < e.newStart || r.at + i >= e.newEnd);
            expect(kept).toBe(false);
          }
        }
      }
    }
    expect(blamed.size).toBeGreaterThan(20);
  });
});
