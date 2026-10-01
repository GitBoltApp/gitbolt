import type { AppEvent } from './gen/AppEvent';
import type { GbError } from './gen/GbError';
import type { Request } from './gen/Request';

export type EventHandler = (ev: AppEvent) => void;
export interface Transport {
  call(req: Request): Promise<unknown>;
  /** Backend events (spec §4.3). Returns an unsubscribe function. */
  subscribe(h: EventHandler): () => void;
}

/** Must match `gitbolt_core::events::TAURI_EVENT`. */
export const TAURI_EVENT = 'gb:event';

/** Hands `ev` to every handler; one that throws is logged and never starves the others. */
export function deliver(handlers: Iterable<EventHandler>, ev: AppEvent): void {
  for (const h of handlers) {
    try {
      h(ev);
    } catch (e) {
      console.error(`backend event ${ev.type}: a handler threw`, e);
    }
  }
}

interface Pending { resolve: (v: unknown) => void; reject: (e: unknown) => void }

/** The harness socket: replies (`{id, ok|err}`, in any order) and event frames (`{event}`). */
export function wsTransport(url: string, socketFactory: (url: string) => WebSocket = (u) => new WebSocket(u), onClosed?: () => void): Transport {
  let nextId = 1;
  const pending = new Map<number, Pending>();
  const handlers = new Set<EventHandler>();
  const queue: string[] = [];
  const socket = socketFactory(url);
  const closeError: GbError = { kind: 'Io', message: 'harness connection closed', commandId: null, stderr: null };
  socket.onopen = () => { for (const m of queue.splice(0)) socket.send(m); };
  socket.onmessage = (e: MessageEvent) => {
    try {
      const msg = JSON.parse(String(e.data)) as { id?: number; ok?: unknown; err?: unknown; event?: AppEvent };
      if (msg.event !== undefined) {
        deliver(handlers, msg.event);
        return;
      }
      const p = pending.get(msg.id as number);
      if (!p) return;
      pending.delete(msg.id as number);
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
    subscribe(h) {
      handlers.add(h);
      return () => { handlers.delete(h); };
    },
  };
}

/** The app: the `api` command, and every backend event as the Tauri event `gb:event`. */
function tauriTransport(): Transport {
  const handlers = new Set<EventHandler>();
  let listening: Promise<unknown> | undefined;
  return {
    call: async (req) => (await import('@tauri-apps/api/core')).invoke('api', { req }),
    subscribe(h) {
      handlers.add(h);
      // One listener for the app's lifetime; handlers come and go. A failed listen isn't kept,
      // so the next subscribe tries again.
      listening ??= import('@tauri-apps/api/event')
        .then(({ listen }) => listen<AppEvent>(TAURI_EVENT, (e) => { deliver(handlers, e.payload); }))
        .catch((e: unknown) => {
          console.error(`couldn't listen for ${TAURI_EVENT}`, e);
          listening = undefined;
        });
      return () => { handlers.delete(h); };
    },
  };
}

export const inTauri = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export function createTransport(onClosed?: () => void): Transport {
  if (inTauri()) return tauriTransport();
  return wsTransport(import.meta.env.VITE_GITBOLT_HARNESS ?? 'ws://127.0.0.1:7433/ws', undefined, onClosed);
}

/**
 * Puts `text` on the system clipboard. The browser's own clipboard first, in the app too (H19):
 * it's the path the embedded browser's right-click -> Copy takes, which reaches other apps in the
 * real window. The app's clipboard plugin (arboard, an X11 client of its own) only when the
 * browser refuses (no user activation, the window not focused).
 */
export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch (e) {
    if (!inTauri()) throw e;
    const { writeText } = await import('@tauri-apps/plugin-clipboard-manager');
    await writeText(text);
  }
}
