import { describe, expect, it } from 'vitest';
import { wsTransport } from './transport';

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
});
