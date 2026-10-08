import { afterEach, describe, expect, it, vi } from 'vitest';
import { splitChunks } from './chunks';
import { diffChunks } from './diff/diffChunks';
import { chunkStream, diffChunkStream, resetChunkStreams } from './parseAsync';
import { parseMarkdown } from './parse';
import type { MdFlavor } from './types';

const big = Array.from({ length: 30 }, (_, i) => `## Part ${i}\n\n${'word '.repeat(400)}`).join('\n\n');

/** A worker that answers on the main thread, one message per chunk, each in its own task. */
class FakeWorker {
  static sent: Array<{ id: number; kind?: 'diff'; old?: string; text: string; flavor: MdFlavor }> = [];
  static fail: 'message' | 'crash' | 'hang' | 'tooLarge' | null = null;
  static made: FakeWorker[] = [];
  terminated = false;
  constructor() { FakeWorker.made.push(this); }
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  postMessage(m: { id: number; kind?: 'diff'; old?: string; text: string; flavor: MdFlavor }) {
    FakeWorker.sent.push(m);
    if (FakeWorker.fail === 'crash') { setTimeout(() => this.onerror?.(new Event('error'))); return; }
    if (FakeWorker.fail === 'hang') return; // a parse that takes for ever
    if (FakeWorker.fail === 'message') { setTimeout(() => this.onmessage?.({ data: { id: m.id, error: 'boom' } } as MessageEvent)); return; }
    if (FakeWorker.fail === 'tooLarge') { setTimeout(() => this.onmessage?.({ data: { id: m.id, error: 'too large', tooLarge: true } } as MessageEvent)); return; }
    const chunks = m.kind === 'diff' ? diffChunks(m.old!, m.text, m.flavor)! : splitChunks(parseMarkdown(m.text, m.flavor));
    chunks.forEach((chunk, index) => setTimeout(() => this.onmessage?.({ data: { id: m.id, index, chunk, last: index === chunks.length - 1 } } as MessageEvent), index));
  }
  terminate() { this.terminated = true; }
}

afterEach(() => { vi.unstubAllGlobals(); resetChunkStreams(); FakeWorker.sent = []; FakeWorker.made = []; FakeWorker.fail = null; });

describe('chunkStream (ruling 21)', () => {
  it('a file’s front matter: its own stream, asked of the worker, a table in the first chunk', async () => {
    const text = `---\nname: repo-tests\n---\n\n${big}`;
    const file = chunkStream(text, 'github', true);
    const body = chunkStream(text, 'github');
    expect(file).not.toBe(body);
    await vi.waitFor(() => expect(file.done && body.done).toBe(true));
    expect([file.chunks[0]!.children[0]!.type, body.chunks[0]!.children[0]!.type]).toEqual(['table', 'thematicBreak']);
    resetChunkStreams();
    vi.stubGlobal('Worker', FakeWorker);
    chunkStream(text, 'github', true);
    expect(FakeWorker.sent[0]).toMatchObject({ frontmatter: true });
  });

  it('parses off the main thread and streams one chunk per message, then keeps the result', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    const s = chunkStream(big, 'github');
    let updates = 0;
    s.subscribe(() => { updates++; });
    await vi.waitFor(() => expect(s.done).toBe(true));
    expect(s.chunks.length).toBeGreaterThan(1);
    expect(updates).toBe(s.chunks.length);
    expect(chunkStream(big, 'github')).toBe(s);
    expect(FakeWorker.sent).toHaveLength(1);
  });

  it('a parse abandoned mid-way (its last subscriber left) terminates its worker; the next parse gets a fresh one, and the half result is never served', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    FakeWorker.fail = 'hang';
    const s = chunkStream(big, 'github');
    const queued = chunkStream(`${big}\n\nqueued`, 'github'); // waiting behind it
    const off = s.subscribe(() => {});
    const keep = queued.subscribe(() => {});
    // A re-subscribe within the task (React's effects re-running) abandons nothing.
    off();
    const again = s.subscribe(() => {});
    await new Promise((r) => setTimeout(r, 5));
    expect(FakeWorker.made[0]!.terminated).toBe(false);
    again();
    await vi.waitFor(() => expect(FakeWorker.made[0]!.terminated).toBe(true));
    expect(FakeWorker.made).toHaveLength(2);
    // The queued parse starts again on the fresh worker; the abandoned one isn't cached.
    expect(FakeWorker.sent.at(-1)!.text).toBe(`${big}\n\nqueued`);
    FakeWorker.fail = null;
    const next = chunkStream(big, 'github');
    expect(next).not.toBe(s);
    expect(FakeWorker.made).toHaveLength(2);
    expect(FakeWorker.sent.at(-1)!.text).toBe(big);
    await vi.waitFor(() => expect(next.done && !next.failed).toBe(true));
    keep();
  });

  it('a parse error in the worker fails the stream (the body shows plain)', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    FakeWorker.fail = 'message';
    const s = chunkStream(big, 'github');
    await vi.waitFor(() => expect(s.failed).toBe(true));
  });

  it('once the worker has crashed, a long text is too large to render (never one long parse on the main thread); a short one parses there', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    FakeWorker.fail = 'crash';
    const crashed = chunkStream(big, 'github');
    await vi.waitFor(() => expect(crashed.done).toBe(true));
    expect(crashed.failed && crashed.tooLarge).toBe(true);
    expect(crashed.chunks).toHaveLength(0);
    const later = chunkStream(`${big}\n\nmore`, 'github');
    expect(later.tooLarge).toBe(true);
    const short = chunkStream('## Short\n\nText.', 'github');
    await vi.waitFor(() => expect(short.done).toBe(true));
    expect(short.failed).toBe(false);
    expect(short.chunks).toHaveLength(1);
  });

  it('with no Worker at all (jsdom), parses on the main thread in an idle callback', async () => {
    resetChunkStreams();
    vi.stubGlobal('Worker', undefined);
    const none = chunkStream(big, 'gitlab');
    expect(none.done).toBe(false);
    await vi.waitFor(() => expect(none.done).toBe(true));
  });
});

describe('diffChunkStream (5C)', () => {
  const edited = big.replace('Part 3', 'Part three');

  it('diffs two texts off the main thread, one stream per pair, with the change count on the first chunk', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    const s = diffChunkStream(big, edited, 'github');
    await vi.waitFor(() => expect(s.done).toBe(true));
    expect(FakeWorker.sent.at(-1)).toMatchObject({ kind: 'diff', old: big, text: edited, flavor: 'github' });
    expect(s.chunks.length).toBeGreaterThan(1);
    expect(s.chunks[0]!.data?.gbChanges).toBe(1);
    expect(diffChunkStream(big, edited, 'github')).toBe(s);
    expect(chunkStream(edited, 'github')).not.toBe(s);
    // Keyed by a hash of both texts: a same-length edit is another diff.
    expect(diffChunkStream(big, edited.replace('three', 'THREE'), 'github')).not.toBe(s);
  });

  it('fails as too large when the alignment gives up', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    FakeWorker.fail = 'tooLarge';
    const s = diffChunkStream(big, edited, 'github');
    await vi.waitFor(() => expect(s.done).toBe(true));
    expect(s.failed).toBe(true);
    expect(s.tooLarge).toBe(true);
  });

  it('without a worker, diffs in an idle callback on the main thread', async () => {
    const s = diffChunkStream(big, edited, 'github');
    await vi.waitFor(() => expect(s.done).toBe(true));
    expect(s.failed).toBe(false);
    expect(s.chunks[0]!.data?.gbChanges).toBe(1);
  });

  it('an abandoned diff terminates its worker like a parse; a diff queued behind it restarts on a fresh one, still a diff', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    FakeWorker.fail = 'hang';
    const s = diffChunkStream(big, edited, 'github');
    const queued = diffChunkStream(big, `${edited}\n\nqueued`, 'github');
    const keep = queued.subscribe(() => {});
    s.subscribe(() => {})();
    await vi.waitFor(() => expect(FakeWorker.made[0]!.terminated).toBe(true));
    expect(s.failed).toBe(true);
    expect(FakeWorker.made).toHaveLength(2);
    expect(FakeWorker.sent.at(-1)).toMatchObject({ kind: 'diff', old: big, text: `${edited}\n\nqueued` });
    FakeWorker.fail = null;
    const next = diffChunkStream(big, edited, 'github');
    expect(next).not.toBe(s);
    await vi.waitFor(() => expect(next.done && !next.failed).toBe(true));
    expect(next.chunks[0]!.data?.gbChanges).toBe(1);
    keep();
  });
});
