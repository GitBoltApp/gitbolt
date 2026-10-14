import { describe, expect, it } from 'vitest';
import { makeTestRepo } from '../read/testkit';
import { patchId } from './patchId';

describe('patchId', () => {
  it('matches the same change made elsewhere, whitespace and position aside', async () => {
    const t = await makeTestRepo();
    await t.write('a.txt', 'x\n'.repeat(5) + 'a b\n');
    const base = await t.commit('Base');
    await t.branch('other', base);
    await t.write('a.txt', 'x\n'.repeat(5) + 'a b\nnew  line\n');
    const one = await t.commit('Add a line');
    await t.checkout('other');
    await t.write('a.txt', 'top\n' + 'x\n'.repeat(5) + 'a b\nnew line\n');
    await t.commit('Shift everything down');
    await t.write('a.txt', 'top\n' + 'x\n'.repeat(5) + 'a b\nnew line\n');
    const shifted = await t.rev('other');
    expect(await patchId(t.repo, one)).not.toBeNull();
    // `shifted` changes the top line, so it isn't the same patch.
    expect(await patchId(t.repo, shifted)).not.toBe(await patchId(t.repo, one));
    await t.checkout('main');
    await t.branch('again', base);
    await t.checkout('again');
    await t.write('a.txt', 'x\n'.repeat(5) + 'a b\nnew line\n');
    const same = await t.commit('Add the line again');
    expect(await patchId(t.repo, same)).toBe(await patchId(t.repo, one));
  });

  it('is null for a merge', async () => {
    const t = await makeTestRepo();
    await t.write('a.txt', 'a\n');
    const base = await t.commit('Base');
    await t.write('b.txt', 'b\n');
    const b = await t.commit('B');
    const m = await t.commit('Merge', undefined, { parents: [b, base] });
    expect(await patchId(t.repo, m)).toBeNull();
  });

  // Each case as `git log --cherry-mark --left-right A...B` marked it on git 2.53 (Task 2 Step 1):
  // from one base, A makes a change; B optionally makes `prep` first, then its change.
  type Files = Record<string, string | Uint8Array | { exec: string } | null>;
  async function same(base: Files, a: Files, b: Files, prep?: Files): Promise<boolean> {
    const t = await makeTestRepo();
    const put = async (fs: Files) => {
      for (const [p, v] of Object.entries(fs)) {
        if (v === null) await t.remove(p);
        else if (typeof v === 'object' && 'exec' in v) await t.write(p, v.exec, { exec: true });
        else await t.write(p, v);
      }
    };
    await put(base);
    const root = await t.commit('Base');
    await t.branch('b', root);
    await put(a);
    const one = await t.commit('A');
    await t.checkout('b');
    if (prep) {
      await put(prep);
      await t.commit('Prep');
    }
    await put(b);
    const two = await t.commit('B');
    return (await patchId(t.repo, one)) === (await patchId(t.repo, two));
  }
  const X = 'x1\nx2\nx3\nx4\nx5\n';
  const Y = 'y1\ny2\ny3\ny4\ny5\n';

  it('counts the three lines of context around a change, not the ones further off', async () => {
    expect(await same({ f: `${X}a b\n` }, { f: `${X}a b\nnew line\n` }, { f: `${Y}a c\nnew line\n` }, { f: `${Y}a c\n` })).toBe(false);
    const six = 'l1\nl2\nl3\nl4\nl5\nl6\n';
    expect(await same({ f: six }, { f: `${six}new\n` }, { f: six.replace('l4', 'Z4') + 'new\n' }, { f: six.replace('l4', 'Z4') })).toBe(false);
    expect(await same({ f: six }, { f: `${six}new\n` }, { f: six.replace('l3', 'Z3') + 'new\n' }, { f: six.replace('l3', 'Z3') })).toBe(true);
    // Whitespace inside context lines doesn't count either.
    expect(await same({ f: `${X}a b\n` }, { f: `${X}a b\nnew line\n` }, { f: `${X}a  b\nnew line\n` }, { f: `${X}a  b\n` })).toBe(true);
  });

  it('counts a change of whitespace alone, but not where hunks split', async () => {
    const far = '.\n.\n.\n.\nc1\nc2\nc3\n';
    expect(await same({ f: `a b\n${X}${far}` }, { f: `a  b\n${X}${far}z\n` }, { f: `a b\n${X}${far}z\n` })).toBe(false);
    // Two hunks (seven lines apart) and one hunk (six apart) with the same lines in them.
    const p = 'p1\np2\np3\n';
    const q = 'q1\nq2\nq3\n';
    const g7 = 'g1\ng2\ng3\ng4\ng5\ng6\ng7\n';
    const g6 = 'g1\ng2\ng3\ng5\ng6\ng7\n';
    expect(await same({ f: `${p}${g7}${q}` }, { f: `${p}A\n${g7}B\n${q}` }, { f: `${p}A\n${g6}B\n${q}` }, { f: `${p}${g6}${q}` })).toBe(true);
    // The line's mark is hashed with its text: a context line `+z` reads as an added `z`.
    expect(await same({ f: 'q\n+z\n' }, { f: 'q\n+z\nnew\n' }, { f: 'q\nz\nnew\n' }, { f: 'q\n' })).toBe(true);
    // A missing final newline's marker doesn't count.
    expect(await same({ f: 'x\n' }, { f: 'x\ny' }, { f: 'x\ny\n' })).toBe(true);
    // Line breaks count as whitespace: the lines run together, a blank context line vanishes.
    expect(await same({ f: 'c1\n\nc2\n' }, { f: 'new\nc1\n\nc2\n' }, { f: 'new\nc1\nc2\n' }, { f: 'c1\nc2\n' })).toBe(true);
    expect(await same({ f: 'b\n' }, { f: 'a\nb\n' }, { f: 'ab\n' }, { f: '' })).toBe(true);
    // Tabs and CRs are whitespace; a form feed or vertical tab isn't.
    expect(await same({ f: 'x\n' }, { f: 'x\na\tb\r\n' }, { f: 'x\nab\n' })).toBe(true);
    expect(await same({ f: 'x\n' }, { f: 'x\na\fb\n' }, { f: 'x\nab\n' })).toBe(false);
    expect(await same({ f: 'x\n' }, { f: 'x\na\vb\n' }, { f: 'x\nab\n' })).toBe(false);
  });

  it('counts paths and mode changes, not an unchanged mode', async () => {
    expect(await same({ f: 'x\n' }, { f: 'x\ny\n' }, { f: { exec: 'x\ny\n' } }, { f: { exec: 'x\n' } })).toBe(true);
    expect(await same({ f: 'x\n' }, { f: 'x\ny\n' }, { f: { exec: 'x\ny\n' } })).toBe(false);
    expect(await same({ f: 'x\n' }, { g: 'g\n' }, { g: 'g\n' }, { g: '' })).toBe(false);
    expect(await same({ f: 'x\n' }, { g: 'g\n' }, { g: { exec: 'g\n' } })).toBe(false);
    expect(await same({ f: 'x\n' }, { f: null }, { f: '' })).toBe(false);
    expect(await same({ f: 'x\n' }, { f: 'x\ny\n' }, { h: 'x\ny\n' }, { h: 'x\n' })).toBe(false);
    // git strips whitespace from the path it hashes too.
    expect(await same({ f: 'x\n' }, { 'a b.txt': 'g\n' }, { 'ab.txt': 'g\n' })).toBe(true);
    expect(await same({ f: 'x\n' }, { 'a\tb': 'g\n' }, { ab: 'g\n' })).toBe(true);
    expect(await same({ f: 'x\n' }, { 'a\fb': 'g\n' }, { ab: 'g\n' })).toBe(false);
  });

  it('counts a binary file by its blobs', async () => {
    const bin = (s: string) => new Uint8Array([0, ...new TextEncoder().encode(s)]);
    expect(await same({ f: 'x\n' }, { b: bin('two') }, { b: bin('two') }, { z: 'z\n' })).toBe(true);
    expect(await same({ b: bin('one') }, { b: bin('two') }, { b: bin('two') }, { b: bin('three') })).toBe(false);
  });

  it('gives every empty change one id', async () => {
    const t = await makeTestRepo();
    await t.write('f', 'x\n');
    const base = await t.commit('Base');
    const a = await t.commit('Empty', undefined, { parents: [base] });
    await t.write('g', 'g\n');
    await t.commit('G');
    const b = await t.commit('Empty too');
    expect(await patchId(t.repo, a)).toBe(await patchId(t.repo, b));
  });
});
