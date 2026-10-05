import { afterEach, describe, expect, it, vi } from 'vitest';
import { splitChunks } from './chunks';
import { chunkStream, resetChunkStreams } from './parseAsync';
import { parseMarkdown } from './parse';
import type { MdFlavor } from './types';

const big = Array.from({ length: 30 }, (_, i) => `## Part ${i}\n\n${'word '.repeat(400)}`).join('\n\n');

/** A worker that answers on the main thread, one message per chunk, each in its own task. */
class FakeWorker {
  static sent: Array<{ id: number; text: string; flavor: MdFlavor }> = [];
  static fail: 'message' | 'crash' | 'hang' | null = null;
  static made: FakeWorker[] = [];
  terminated = false;
  constructor() { FakeWorker.made.push(this); }
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  postMessage(m: { id: number; text: string; flavor: MdFlavor }) {
    FakeWorker.sent.push(m);
    if (FakeWorker.fail === 'crash') { setTimeout(() => this.onerror?.(new Event('error'))); return; }
    if (FakeWorker.fail === 'hang') return; // a parse that takes for ever
    if (FakeWorker.fail === 'message') { setTimeout(() => this.onmessage?.({ data: { id: m.id, error: 'boom' } } as MessageEvent)); return; }
    const chunks = splitChunks(parseMarkdown(m.text, m.flavor));
    chunks.forEach((chunk, index) => setTimeout(() => this.onmessage?.({ data: { id: m.id, index, chunk, last: index === chunks.length - 1 } } as MessageEvent), index));
  }
  terminate() { this.terminated = true; }
}

afterEach(() => { vi.unstubAllGlobals(); resetChunkStreams(); FakeWorker.sent = []; FakeWorker.made = []; FakeWorker.fail = null; });

describe('chunkStream (ruling 21)', () => {
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
