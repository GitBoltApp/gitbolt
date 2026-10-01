import { describe, expect, it } from 'vitest';
import type { FileListPayload } from '../api/gen/FileListPayload';
import { filesKey } from './services';
import { wipKey, WipLists, type WipSpec } from './wipLists';

/** Two tasks: a settled read stays joinable until the end of the task it settled in. */
const flush = async () => { for (let i = 0; i < 2; i++) await new Promise((r) => setTimeout(r, 0)); };
const list = (version?: string, path = 'a.txt'): FileListPayload => ({
  files: [{ path, oldPath: null, status: 'M', additions: 1, deletions: 0, old: { kind: 'absent' }, new: { kind: 'worktree', worktree: '/r' }, submodule: false }],
  added: 1, deleted: 0, ...(version === undefined ? {} : { version }),
});

/** A `WipLists` whose reads wait until the test answers them, in order. */
function setup() {
  const reads: { spec: WipSpec; answer: (l: FileListPayload) => void }[] = [];
  const wip = new WipLists((spec) => new Promise((answer) => reads.push({ spec, answer })));
  return { wip, reads };
}

const U = wipKey('/r', false), S = wipKey('/r', true);

describe('WipLists (K44)', () => {
  it('keys lists the way the store does', () => {
    expect(U).toBe(filesKey({ kind: 'wip', worktree: '/r', staged: false }));
  });

  it('holds versioned lists while watched, so the next read is a synchronous hit with no request', async () => {
    const { wip, reads } = setup();
    wip.setWatched(true);
    wip.prefetch(['/r']);
    expect(reads.map((r) => r.spec.staged)).toEqual([false, true]);
    reads[0].answer(list('v1'));
    reads[1].answer(list('v1', 's.txt'));
    await flush();
    expect(wip.peek(U)?.version).toBe('v1');
    expect(wip.peek(S)?.files[0].path).toBe('s.txt');
    await wip.get(U);
    wip.prefetch(['/r']);
    expect(reads).toHaveLength(2);
  });

  it('never holds an unversioned list (no trusted watcher) nor any list while unwatched', async () => {
    const { wip, reads } = setup();
    void wip.get(U);
    reads[0].answer(list('v1'));
    await flush();
    expect(wip.peek(U)).toBeUndefined();
    wip.prefetch(['/r']);
    expect(reads).toHaveLength(1);
    wip.setWatched(true);
    void wip.get(U);
    reads[1].answer(list());
    await flush();
    expect(wip.peek(U)).toBeUndefined();
  });

  it('a change drops what is held, and a read started before it is never held after it', async () => {
    const { wip, reads } = setup();
    wip.setWatched(true);
    const seen: string[][] = [];
    wip.subscribe((w) => seen.push([...w]));
    void wip.get(U);
    reads[0].answer(list('v1'));
    await flush();
    void wip.get(U); // hit
    expect(reads).toHaveLength(1);
    wip.changed(['/r'], { '/r': 'v2' });
    expect(wip.peek(U)).toBeUndefined();
    expect(seen).toEqual([['/r']]);
    const before = wip.get(U); // read 2, then another change lands while it's in flight
    wip.changed(['/r'], { '/r': 'v3' });
    const after = wip.get(U); // read 3: not joined to the older read
    expect(reads).toHaveLength(3);
    reads[1].answer(list('v2'));
    await before;
    expect(wip.peek(U)).toBeUndefined();
    reads[2].answer(list('v3'));
    expect((await after).version).toBe('v3');
    expect(wip.peek(U)?.version).toBe('v3');
  });

  it('a change announcing the version already held keeps it', async () => {
    const { wip, reads } = setup();
    wip.setWatched(true);
    wip.prefetch(['/r']);
    reads[0].answer(list('v2'));
    reads[1].answer(list('v2'));
    await flush();
    const seen: unknown[] = [];
    wip.subscribe((w) => seen.push(w));
    wip.changed(['/r'], { '/r': 'v2' });
    expect(wip.peek(U)?.version).toBe('v2');
    expect(seen).toEqual([]);
    wip.changed(['/r'], {}); // no version (a degraded watch): dropped
    expect(wip.peek(U)).toBeUndefined();
  });

  it('stopping the watch drops everything, including reads in flight', async () => {
    const { wip, reads } = setup();
    wip.setWatched(true);
    wip.prefetch(['/r', '/w']);
    reads[0].answer(list('v1'));
    await flush();
    expect(wip.peek(U)).toBeDefined();
    wip.setWatched(false);
    expect(wip.peek(U)).toBeUndefined();
    wip.setWatched(true);
    reads[2].answer(list('v1')); // '/w' unstaged, read before the stop
    await flush();
    expect(wip.peek(wipKey('/w', false))).toBeUndefined();
  });

  it('a worktree whose list or event comes without a version (a degraded watch) is not read ahead until a versioned event', async () => {
    const { wip, reads } = setup();
    wip.setWatched(true);
    wip.prefetch(['/r', '/w']);
    expect(reads).toHaveLength(4);
    reads[0].answer(list()); // '/r': no version
    reads[1].answer(list());
    reads[2].answer(list('v1')); // '/w': versioned
    reads[3].answer(list('v1'));
    await flush();
    wip.changed(['/r', '/w'], { '/w': 'v2' });
    wip.prefetch(['/r', '/w']);
    expect(reads.slice(4).map((r) => r.spec.worktree)).toEqual(['/w', '/w']);
    // An event with no version marks a worktree too, even one never read.
    wip.changed(['/x'], {});
    wip.prefetch(['/x']);
    expect(reads).toHaveLength(6);
    // A versioned event re-arms it.
    wip.changed(['/r'], { '/r': 'v5' });
    wip.prefetch(['/r']);
    expect(reads.slice(6).map((r) => r.spec.worktree)).toEqual(['/r', '/r']);
    // A selection still reads it on demand (not read ahead is all).
    void wip.get(wipKey('/x', false));
    expect(reads).toHaveLength(9);
    // A new watch starts afresh.
    wip.setWatched(false);
    wip.setWatched(true);
    wip.prefetch(['/x']);
    expect(reads).toHaveLength(11);
  });
});
