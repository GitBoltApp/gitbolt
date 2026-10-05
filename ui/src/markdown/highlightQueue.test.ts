import { afterEach, describe, expect, it, vi } from 'vitest';

const shiki = vi.hoisted(() => ({ ensureGrammar: vi.fn(async (l: string) => (l === 'nope' ? null : l)), tokensFor: vi.fn(() => ({ lines: [] })) }));
vi.mock('../diff/monaco/shiki', () => shiki);
// The idle scheduler, driven by hand: each pending callback is one task.
const idle = vi.hoisted(() => ({ pending: [] as Array<() => void> }));
vi.mock('./idle', () => ({ whenIdle: (fn: () => void) => { idle.pending.push(fn); return () => {}; } }));
const { queueHighlight, SLICE_MS } = await import('./highlightQueue');

const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); };
async function runSlices(): Promise<number[]> {
  const per: number[] = [];
  while (idle.pending.length > 0) {
    const before = shiki.tokensFor.mock.calls.length;
    idle.pending.shift()!();
    await settle();
    per.push(shiki.tokensFor.mock.calls.length - before);
  }
  return per;
}

afterEach(() => { vi.restoreAllMocks(); shiki.tokensFor.mockClear(); });

describe('the highlight queue (ruling 21)', () => {
  it('tokenizes in idle slices of at most 25 ms, never every block in one task', async () => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    shiki.tokensFor.mockImplementation(() => { now += 10; return { lines: [] }; });
    const jobs = Array.from({ length: 10 }, (_, i) => queueHighlight(`b${i}`, 'ts'));
    const per = await runSlices();
    await Promise.all(jobs.map((j) => j.result));
    expect(SLICE_MS).toBe(25);
    expect(per.reduce((a, b) => a + b, 0)).toBe(10);
    expect(Math.max(...per)).toBeLessThanOrEqual(3);
  });

  it('a cancelled job never runs, and an unknown language resolves plain', async () => {
    const gone = queueHighlight('x', 'ts');
    gone.cancel();
    const unknown = queueHighlight('z', 'nope');
    await runSlices();
    expect(await unknown.result).toBeNull();
    expect(shiki.tokensFor).not.toHaveBeenCalled();
  });
});
