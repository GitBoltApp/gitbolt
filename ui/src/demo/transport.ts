// The UI's backend in the browser (website demo spec §4.1): each request runs its handler, typed
// against the generated Request union (a method without a handler fails `tsc`), on the demo's
// state. Replies and errors are copies, as if they had crossed a socket; errors are GbErrors.
import type { Request } from '../api/gen/Request';
import type { Transport } from '../api/transport';
import type { DemoContext } from './context';
import type { EventBus } from './engine/events';
import { asGbError } from './engine/errors';
import { recordRequest } from './log';
import type { DemoResults } from './results';

export type Method = Request['method'];
export type ParamsOf<M extends Method> = Extract<Request, { method: M }> extends { params: infer P } ? P : undefined;
export type ResultOf<M extends Method> = M extends keyof DemoResults ? DemoResults[M] : unknown;
export type Handler<M extends Method> = (params: ParamsOf<M>, ctx: DemoContext) => Promise<ResultOf<M>>;
/** Exhaustive: a method missing here fails `tsc`. */
export type HandlerTable = { [M in Method]: Handler<M> };

export interface DemoRuntime {
  ctx: DemoContext;
  bus: EventBus;
}

/** Calls made before `runtime` is ready (the manifest and the WebAssembly loading) wait for it;
 * if it fails, every call fails with its error. Each request is recorded (`log.ts`). */
export function createDemoTransport(runtime: Promise<DemoRuntime>, handlers: HandlerTable): Transport {
  // Its failure is each call's to report, never an unhandled rejection of its own.
  runtime.catch(() => undefined);
  return {
    async call(req) {
      const params = 'params' in req ? structuredClone(req.params) : undefined;
      const started = Date.now();
      const t0 = performance.now();
      try {
        const { ctx } = await runtime;
        const handler = handlers[req.method] as (params: unknown, ctx: DemoContext) => Promise<unknown>;
        const reply = structuredClone(await handler(params, ctx));
        recordRequest(req.method, params, started, performance.now() - t0, null);
        return reply;
      } catch (e) {
        const err = asGbError(e);
        recordRequest(req.method, params, started, performance.now() - t0, err);
        throw err;
      }
    },
    subscribe(h) {
      let off: (() => void) | null = null;
      let dropped = false;
      runtime.then(({ bus }) => { if (!dropped) off = bus.subscribe(h); }, () => undefined);
      return () => {
        dropped = true;
        off?.();
      };
    },
  };
}
