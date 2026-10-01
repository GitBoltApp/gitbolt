import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyText, createTransport, TAURI_EVENT, wsTransport } from './transport';

class FakeSocket {
  static last: FakeSocket;
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor() { FakeSocket.last = this; }
  send(s: string) { this.sent.push(s); }
  open() { this.readyState = 1; this.onopen?.(); }
  reply(obj: unknown) { this.onmessage?.({ data: JSON.stringify(obj) }); }
}

describe('wsTransport', () => {
  it('queues until open, correlates replies by id, rejects errors', async () => {
    const t = wsTransport('ws://x', () => new FakeSocket() as unknown as WebSocket);
    const a = t.call({ method: 'launchRepo' });
    const b = t.call({ method: 'commandLog' });
    const s = FakeSocket.last;
    expect(s.sent).toHaveLength(0);
    s.open();
    expect(s.sent.map((m) => JSON.parse(m).id)).toEqual([1, 2]);
    s.reply({ id: 2, ok: [] });
    s.reply({ id: 1, err: { kind: 'Other', message: 'boom', commandId: null, stderr: null } });
    await expect(b).resolves.toEqual([]);
    await expect(a).rejects.toMatchObject({ message: 'boom' });
  });
  it('closing the socket rejects pending calls with proper error', async () => {
    const t = wsTransport('ws://x', () => new FakeSocket() as unknown as WebSocket);
    const a = t.call({ method: 'launchRepo' });
    const b = t.call({ method: 'commandLog' });
    const s = FakeSocket.last;
    s.open();
    s.readyState = 2; // CLOSING
    s.onclose?.();
    await expect(a).rejects.toEqual({ kind: 'Io', message: 'harness connection closed', commandId: null, stderr: null });
    await expect(b).rejects.toEqual({ kind: 'Io', message: 'harness connection closed', commandId: null, stderr: null });
  });
  it('call made after socket closes rejects immediately', async () => {
    const t = wsTransport('ws://x', () => new FakeSocket() as unknown as WebSocket);
    const s = FakeSocket.last;
    s.open();
    s.readyState = 3; // CLOSED
    const c = t.call({ method: 'launchRepo' });
    await expect(c).rejects.toEqual({ kind: 'Io', message: 'harness connection closed', commandId: null, stderr: null });
  });
  it('onClosed callback is called when socket closes', async () => {
    let called = false;
    wsTransport('ws://x', () => new FakeSocket() as unknown as WebSocket, () => { called = true; });
    const s = FakeSocket.last;
    s.open();
    s.readyState = 3; // CLOSED
    s.onclose?.();
    expect(called).toBe(true);
  });
  it('sends messages immediately when socket is already open', async () => {
    const t = wsTransport('ws://x', () => new FakeSocket() as unknown as WebSocket);
    const s = FakeSocket.last;
    s.open();
    const p = t.call({ method: 'launchRepo' });
    expect(s.sent).toHaveLength(1);
    s.reply({ id: 1, ok: 'result' });
    await expect(p).resolves.toBe('result');
  });
  it('routes event frames to subscribers, not to pending calls', async () => {
    const t = wsTransport('ws://x', () => new FakeSocket() as unknown as WebSocket);
    const seen: unknown[] = [];
    const off = t.subscribe((ev) => seen.push(ev));
    const call = t.call({ method: 'commandLog' });
    const s = FakeSocket.last;
    s.open();
    s.reply({ event: { type: 'refsUpdated', repo: 3 } });
    s.reply({ id: 1, ok: [] });
    await expect(call).resolves.toEqual([]);
    expect(seen).toEqual([{ type: 'refsUpdated', repo: 3 }]);
    off();
    s.reply({ event: { type: 'refsUpdated', repo: 4 } });
    expect(seen).toHaveLength(1);
  });
  it('a subscriber that throws is logged and the others still get the event', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const t = wsTransport('ws://x', () => new FakeSocket() as unknown as WebSocket);
    const seen: unknown[] = [];
    t.subscribe(() => { throw new Error('bad subscriber'); });
    t.subscribe((ev) => seen.push(ev));
    FakeSocket.last.open();
    FakeSocket.last.reply({ event: { type: 'refsUpdated', repo: 3 } });
    expect(seen).toEqual([{ type: 'refsUpdated', repo: 3 }]);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});

const events = vi.hoisted(() => ({
  listen: vi.fn(),
  emit: undefined as undefined | ((payload: unknown) => void),
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: events.listen }));

describe('tauri transport', () => {
  const inApp = () => { (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}; };
  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    events.listen.mockReset();
  });
  const settle = () => new Promise((r) => setTimeout(r, 0));

  it('listens once for gb:event, isolates a throwing handler, and retries a failed listen', async () => {
    inApp();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    events.listen.mockRejectedValueOnce(new Error('not allowed'));
    events.listen.mockImplementation(async (name: string, cb: (e: { payload: unknown }) => void) => {
      expect(name).toBe(TAURI_EVENT);
      events.emit = (payload) => cb({ payload });
      return () => {};
    });
    const t = createTransport();
    t.subscribe(() => {});
    await settle();
    expect(events.listen).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalled();
    // The failed listen isn't cached: the next subscribe tries again.
    const seen: unknown[] = [];
    t.subscribe(() => { throw new Error('bad subscriber'); });
    t.subscribe((ev) => seen.push(ev));
    await settle();
    expect(events.listen).toHaveBeenCalledTimes(2);
    events.emit!({ type: 'refsUpdated', repo: 5 });
    expect(seen).toEqual([{ type: 'refsUpdated', repo: 5 }]);
    t.subscribe(() => {});
    await settle();
    expect(events.listen).toHaveBeenCalledTimes(2);
    error.mockRestore();
  });
});

const plugin = vi.hoisted(() => ({ writeText: vi.fn(async (_t: string) => {}) }));
vi.mock('@tauri-apps/plugin-clipboard-manager', () => plugin);

describe('copyText', () => {
  const clip = (impl: (t: string) => Promise<void>) => {
    const writeText = vi.fn(impl);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    return writeText;
  };
  const inApp = () => { (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}; };
  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    plugin.writeText.mockClear();
  });

  // H19: the browser's own clipboard first, in the app too: it's the path right-click -> Copy
  // takes, which works in the real window. The Tauri plugin (arboard) only when it refuses.
  it("uses the browser's clipboard, in the app too", async () => {
    inApp();
    const writeText = clip(async () => {});
    await copyText('abc');
    expect(writeText).toHaveBeenCalledWith('abc');
    expect(plugin.writeText).not.toHaveBeenCalled();
  });

  it("falls back to the app's clipboard plugin when the browser refuses", async () => {
    inApp();
    clip(async () => { throw new Error('NotAllowedError'); });
    await copyText('abc');
    expect(plugin.writeText).toHaveBeenCalledWith('abc');
  });

  it('outside the app, a refusal is the error', async () => {
    clip(async () => { throw new Error('NotAllowedError'); });
    await expect(copyText('abc')).rejects.toThrow('NotAllowedError');
    expect(plugin.writeText).not.toHaveBeenCalled();
  });
});
