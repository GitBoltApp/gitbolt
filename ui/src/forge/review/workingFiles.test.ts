import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ diffContents: vi.fn() }));
vi.mock('../../api/client', () => ({ api, errorMessage: String }));

const { REREAD_MS, readAtGen, rereadNow, watchWorkingFiles, workingGen } = await import('./workingFiles');

const file = (text: string) => ({ old: null, new: { size: text.length, binary: false, encoding: 'UTF-8', eol: 'Lf', text, base64: null, hash: `h:${text}` }, tooLarge: false, eolOnly: false, image: false });
let changed: (wts: ReadonlySet<string>) => void = () => {};
const off = vi.fn();
const wip = { subscribe: vi.fn((l: (wts: ReadonlySet<string>) => void) => { changed = l; return off; }) };

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe("the Apply buttons' working-copy reads", () => {
  it('reads a file once per generation, whichever buttons ask', async () => {
    api.diffContents.mockResolvedValue(file('a\n'));
    const stop = [watchWorkingFiles('t', wip, '/r', vi.fn()), watchWorkingFiles('t', wip, '/r', vi.fn())];
    expect(wip.subscribe).toHaveBeenCalledTimes(1);
    const [x, y] = [readAtGen('t', 4, '/r', 'a.ts'), readAtGen('t', 4, '/r', 'a.ts')];
    expect(await x).toEqual({ text: 'a\n', base: 'h:a\n' });
    expect(await y).toEqual(await x);
    readAtGen('t', 4, '/r', 'b.ts');
    expect(api.diffContents).toHaveBeenCalledTimes(2);
    stop.forEach((s) => s());
    expect(off).toHaveBeenCalledTimes(1);
  });

  it('a burst of WIP changes is one new generation, once it settles; another worktree’s is none', () => {
    const listener = vi.fn();
    const stop = watchWorkingFiles('t', wip, '/r', listener);
    const gen = workingGen('t', '/r');
    for (let i = 0; i < 3; i++) {
      changed(new Set(['/r']));
      vi.advanceTimersByTime(REREAD_MS - 10);
    }
    expect(listener).not.toHaveBeenCalled();
    vi.advanceTimersByTime(10);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(workingGen('t', '/r')).toBeGreaterThan(gen);
    changed(new Set(['/r-other']));
    vi.advanceTimersByTime(REREAD_MS);
    expect(listener).toHaveBeenCalledTimes(1);
    // The button's own write: at once.
    rereadNow('t', '/r');
    expect(listener).toHaveBeenCalledTimes(2);
    stop();
  });

  it('a read still answering never stands for the next generation', async () => {
    let answer: (v: unknown) => void = () => {};
    api.diffContents.mockImplementationOnce(() => new Promise((ok) => { answer = ok; })).mockResolvedValueOnce(file('new\n'));
    const stop = watchWorkingFiles('t', wip, '/r', vi.fn());
    const old = readAtGen('t', 4, '/r', 'a.ts');
    rereadNow('t', '/r');
    const fresh = readAtGen('t', 4, '/r', 'a.ts');
    expect(fresh).not.toBe(old);
    answer(file('old\n'));
    expect((await fresh)?.text).toBe('new\n');
    expect((await old)?.text).toBe('old\n');
    stop();
  });
});
