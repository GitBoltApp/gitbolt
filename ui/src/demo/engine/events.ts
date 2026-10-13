// The demo's backend events (AppEvent), delivered as the core's arrive: after the reply that
// caused them, never inside it.
import type { AppEvent } from '../../api/gen/AppEvent';
import { deliver, type EventHandler } from '../../api/transport';

export interface EventBus {
  emit(ev: AppEvent): void;
  subscribe(h: EventHandler): () => void;
}

export function createEventBus(): EventBus {
  const handlers = new Set<EventHandler>();
  return {
    emit(ev) {
      queueMicrotask(() => { deliver(handlers, ev); });
    },
    subscribe(h) {
      handlers.add(h);
      return () => { handlers.delete(h); };
    },
  };
}
