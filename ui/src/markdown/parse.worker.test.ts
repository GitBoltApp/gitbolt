import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ParseReply, ParseRequest } from './parse.worker';

const sent: ParseReply[] = [];
vi.stubGlobal('postMessage', (m: ParseReply) => { sent.push(m); });
await import('./parse.worker');
const handle = (globalThis as unknown as { onmessage: (e: { data: ParseRequest }) => Promise<void> }).onmessage;

afterEach(() => { vi.restoreAllMocks(); sent.length = 0; });

describe('the parse worker (5C diffs)', () => {
  it('replies with the diff in chunks', async () => {
    await handle({ data: { id: 1, kind: 'diff', old: 'Run it once.\n', text: 'Run it twice.\n', flavor: 'github' } });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ id: 1, last: true });
  });

  it("replies too large when the diff's time budget runs out (R14)", async () => {
    let t = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => (t += 1000));
    await handle({ data: { id: 2, kind: 'diff', old: 'Run it once.\n', text: 'Run it twice.\n', flavor: 'github' } });
    expect(sent).toEqual([{ id: 2, error: 'too large', tooLarge: true }]);
  });
});
