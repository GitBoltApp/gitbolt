import { describe, expect, it, vi } from 'vitest';
import type { BlobPayload } from '../api/gen/BlobPayload';
import type { DiffContentsPayload } from '../api/gen/DiffContentsPayload';

const api = vi.hoisted(() => ({ diffContents: vi.fn(), hexDump: vi.fn() }));
vi.mock('../api/client', async (actual) => ({ ...(await actual<typeof import('../api/client')>()), api }));
const { hexOf, hexSize, loadContents } = await import('./hexContents');

const side = (binary: boolean): BlobPayload => ({ size: 4, binary, encoding: '', eol: 'none', text: binary ? null : 'x', base64: null, hash: null });
const payload = (extra: Partial<DiffContentsPayload>): DiffContentsPayload => ({ old: side(true), new: side(true), tooLarge: false, eolOnly: false, image: false, ...extra });
const req = { path: 'a.bin', old: { kind: 'absent' as const }, new: { kind: 'absent' as const }, force: false };
const hex = { old: { size: 4, shown: 4, dump: 'ab' }, new: null, cap: 262144 };

describe('loadContents', () => {
  it('loads a binary\'s hex dumps with its contents; not a text file\'s, an image\'s or a large file\'s', async () => {
    api.hexDump.mockResolvedValue(hex);
    api.diffContents.mockResolvedValueOnce(payload({}));
    const bin = await loadContents(1, req);
    expect(hexOf(bin)).toEqual(hex);
    expect(hexSize(bin)).toBe(4);
    expect(api.hexDump).toHaveBeenCalledWith(1, req);
    for (const p of [payload({ old: side(false), new: side(false) }), payload({ image: true }), payload({ tooLarge: true })]) {
      api.hexDump.mockClear();
      api.diffContents.mockResolvedValueOnce(p);
      const c = await loadContents(1, req);
      expect(hexOf(c)).toBeNull();
      expect(api.hexDump).not.toHaveBeenCalled();
    }
  });
});
