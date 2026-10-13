import { describe, expect, it } from 'vitest';
import { normaliseResponse } from './normalise';

describe('golden normalisation', () => {
  it('digests large base64 and dumps as the generator does, and masks the git-lfs version', async () => {
    const big = 'A'.repeat(20_000);
    const out = (await normaliseResponse('diffContents', { new: { base64: big, text: big }, old: null, dropped: undefined })) as Record<string, unknown> & { new: { base64: string; text: string } };
    expect(out.new.base64).toMatch(/^sha256:[0-9a-f]{64}:20000$/);
    expect(out.new.text).toBe(big);
    expect('dropped' in out).toBe(false);
    expect(await normaliseResponse('diffContents', out)).toEqual(out);
    expect(await normaliseResponse('lfsStatus', { used: true, version: null })).toEqual({ used: true, version: '<git-lfs>' });
  });
});
