import { describe, expect, it } from 'vitest';
import { contentsHandlers, HEX_CAP } from './contents';
import { fakeCtx, makeTestRepo } from '../engine/read/testkit';
import { entryAt } from '../engine/read/trees';

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

async function repo() {
  const t = await makeTestRepo();
  await t.write('crlf.txt', 'first\r\nsecond\r\n');
  await t.write('logo.png', png);
  await t.write('data.bin', new Uint8Array([0x42, 0x49, 0x4e, 0, 1, 2]));
  await t.write('doc.pdf', '%PDF-1.4\n1 0 obj\n<<>>\nendobj\n');
  await t.write('big.txt', 'line of the big file\n'.repeat(110_000));
  await t.write('big.bin', new Uint8Array(3 * 1024 * 1024));
  const a = await t.commit('A');
  await t.write('crlf.txt', 'first\nsecond\n');
  const b = await t.commit('B');
  const blob = async (rev: string, path: string) => ({ kind: 'object' as const, oid: (await entryAt(t.repo, rev, path))!.oid });
  return { t, a, b, blob, ctx: fakeCtx(t.repo) };
}

describe('contents', () => {
  it('decodes text sides and flags a line-ending-only change', async () => {
    const { a, b, blob, ctx } = await repo();
    const c = await contentsHandlers.diffContents({ repo: 1, path: 'crlf.txt', old: await blob(a, 'crlf.txt'), new: await blob(b, 'crlf.txt'), force: false }, ctx);
    expect(c).toMatchObject({ eolOnly: true, tooLarge: false, image: false });
    expect(c.old).toMatchObject({ eol: 'crlf', encoding: 'UTF-8', binary: false, base64: null });
    expect(c.new?.hash).toMatch(/^[0-9a-f]{40}$/);
    expect('pdf' in c || 'lfs' in c || 'media' in c).toBe(false);
  });

  it('sends an image\'s and a PDF\'s bytes, never a plain binary\'s', async () => {
    const { a, blob, ctx } = await repo();
    const img = await contentsHandlers.diffContents({ repo: 1, path: 'logo.png', old: { kind: 'absent' }, new: await blob(a, 'logo.png'), force: false }, ctx);
    expect(img).toMatchObject({ image: true, old: null });
    expect(atob(img.new!.base64!).charCodeAt(1)).toBe(0x50);
    const bin = await contentsHandlers.diffContents({ repo: 1, path: 'data.bin', old: { kind: 'absent' }, new: await blob(a, 'data.bin'), force: false }, ctx);
    expect(bin.new).toMatchObject({ binary: true, base64: null, text: null, size: 6 });
    const pdf = await contentsHandlers.diffContents({ repo: 1, path: 'doc.pdf', old: { kind: 'absent' }, new: await blob(a, 'doc.pdf'), force: false }, ctx);
    expect(pdf).toMatchObject({ pdf: true });
    expect(pdf.new).toMatchObject({ binary: false });
    expect(atob(pdf.new!.base64!).startsWith('%PDF-')).toBe(true);
    const font = await contentsHandlers.diffContents({ repo: 1, path: 'fonts/x.ttf', old: { kind: 'absent' }, new: await blob(a, 'data.bin'), force: false }, ctx);
    expect(font).toMatchObject({ media: true, image: false });
    expect(font.new!.base64).not.toBeNull();
    const svg = await contentsHandlers.diffContents({ repo: 1, path: 'logo.svg', oldPath: 'logo.png', old: await blob(a, 'logo.png'), new: await blob(a, 'crlf.txt'), force: false }, ctx);
    expect(svg.image).toBe(true);
  });

  it('holds a large text side back until forced; a large binary shows as hex at once', async () => {
    const { a, blob, ctx } = await repo();
    const gated = await contentsHandlers.diffContents({ repo: 1, path: 'big.txt', old: { kind: 'absent' }, new: await blob(a, 'big.txt'), force: false }, ctx);
    expect(gated).toMatchObject({ tooLarge: true, old: null });
    expect(gated.new).toMatchObject({ text: null, hash: null, size: 21 * 110_000 });
    const forced = await contentsHandlers.diffContents({ repo: 1, path: 'big.txt', old: { kind: 'absent' }, new: await blob(a, 'big.txt'), force: true }, ctx);
    expect(forced.tooLarge).toBe(false);
    expect(forced.new!.text!.startsWith('line of the big file\n')).toBe(true);
    const bin = await contentsHandlers.diffContents({ repo: 1, path: 'big.bin', old: { kind: 'absent' }, new: await blob(a, 'big.bin'), force: false }, ctx);
    expect(bin.tooLarge).toBe(false);
    expect(bin.new).toMatchObject({ binary: true, text: null });
  });

  it('reads a worktree side, an untracked file and a missing path', async () => {
    const { t, ctx } = await repo();
    await t.write('notes.txt', 'untracked notes\n');
    const c = await contentsHandlers.diffContents({ repo: 1, path: 'notes.txt', old: { kind: 'absent' }, new: { kind: 'worktree', worktree: t.dir }, force: false }, ctx);
    expect(c.new).toMatchObject({ text: 'untracked notes\n', eol: 'lf' });
    await expect(contentsHandlers.diffContents({ repo: 1, path: 'gone.txt', old: { kind: 'absent' }, new: { kind: 'worktree', worktree: t.dir }, force: false }, ctx)).rejects.toMatchObject({ kind: 'NotFound' });
  });

  it('dumps hex sides, capped', async () => {
    const { a, blob, ctx } = await repo();
    const h = await contentsHandlers.hexDump({ repo: 1, path: 'data.bin', old: { kind: 'absent' }, new: await blob(a, 'data.bin') }, ctx);
    expect(h).toMatchObject({ old: null, cap: HEX_CAP, new: { size: 6, shown: 6 } });
    expect(h.new!.dump.startsWith('00000000  42 49 4e 00 01 02')).toBe(true);
    const big = await contentsHandlers.hexDump({ repo: 1, path: 'big.bin', old: { kind: 'absent' }, new: await blob(a, 'big.bin') }, ctx);
    expect(big.new).toMatchObject({ size: 3 * 1024 * 1024, shown: HEX_CAP });
    expect(big.new!.dump.split('\n').length - 1).toBe(HEX_CAP / 16);
  });

  it('marks a worktree LFS pointer file filtered, with its pointer', async () => {
    const { t, ctx } = await repo();
    await t.write('.gitattributes', '*.psd filter=lfs diff=lfs merge=lfs -text\n');
    await t.write('art.psd', `version https://git-lfs.github.com/spec/v1\noid sha256:${'a'.repeat(64)}\nsize 12345\n`);
    const c = await contentsHandlers.diffContents({ repo: 1, path: 'art.psd', old: { kind: 'absent' }, new: { kind: 'worktree', worktree: t.dir }, force: false }, ctx);
    expect(c.lfs).toBe(true);
    expect(c.new).toMatchObject({ filtered: true, size: 12345, text: null, lfs: { downloaded: false, size: 12345 } });
    expect(c.new!.hash).toMatch(/^[0-9a-f]{40}$/);
  });
});
