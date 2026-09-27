import type { GbError } from './gen/GbError';
import type { Request } from './gen/Request';

export interface Transport { call(req: Request): Promise<unknown> }

interface Pending { resolve: (v: unknown) => void; reject: (e: unknown) => void }

export function wsTransport(url: string, socketFactory: (url: string) => WebSocket = (u) => new WebSocket(u), onClosed?: () => void): Transport {
  let nextId = 1;
  const pending = new Map<number, Pending>();
  const queue: string[] = [];
  const socket = socketFactory(url);
  const closeError: GbError = { kind: 'Io', message: 'harness connection closed', commandId: null, stderr: null };
  socket.onopen = () => { for (const m of queue.splice(0)) socket.send(m); };
  socket.onmessage = (e: MessageEvent) => {
    try {
      const msg = JSON.parse(String(e.data)) as { id: number; ok?: unknown; err?: unknown };
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if ('err' in msg && msg.err !== undefined) p.reject(msg.err);
      else p.resolve(msg.ok);
    } catch {
      // Ignore malformed frames
    }
  };
  socket.onclose = () => {
    for (const p of pending.values()) p.reject(closeError);
    pending.clear();
    queue.splice(0);
    onClosed?.();
  };
  return {
    call(req) {
      const id = nextId++;
      const text = JSON.stringify({ id, req });
      return new Promise((resolve, reject) => {
        if (socket.readyState >= 2) {
          reject(closeError);
          return;
        }
        pending.set(id, { resolve, reject });
        if (socket.readyState === 1) socket.send(text);
        else queue.push(text);
      });
    },
  };
}

const inTauri = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export function createTransport(onClosed?: () => void): Transport {
  if (inTauri()) {
    return { call: async (req) => (await import('@tauri-apps/api/core')).invoke('api', { req }) };
  }
  return wsTransport(import.meta.env.VITE_GITBOLT_HARNESS ?? 'ws://127.0.0.1:7433/ws', undefined, onClosed);
}

export async function copyText(text: string): Promise<void> {
  if (inTauri()) {
    const { writeText } = await import('@tauri-apps/plugin-clipboard-manager');
    await writeText(text);
  } else {
    await navigator.clipboard.writeText(text);
  }
}
