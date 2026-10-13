import { describe, expect, test } from 'vitest';
import type { AppEvent } from '../api/gen/AppEvent';
import type { DemoContext } from './context';
import { createEventBus } from './engine/events';
import { gbError } from './engine/errors';
import { requestRecords } from './log';
import { createDemoTransport, type DemoRuntime, type HandlerTable } from './transport';

function runtime(): DemoRuntime {
  const bus = createEventBus();
  return { bus, ctx: { emit: (ev: AppEvent) => bus.emit(ev) } as DemoContext };
}
const table = (handlers: Partial<HandlerTable>) => handlers as HandlerTable;
const tick = () => new Promise((r) => setTimeout(r, 0));

test('each request is recorded, with its params and outcome', async () => {
  const before = requestRecords().length;
  const t = createDemoTransport(Promise.resolve(runtime()), table({ appInfo: async () => { throw new Error('boom'); }, peekRepo: async () => ({ remotes: [], branch: null }) }));
  await t.call({ method: 'peekRepo', params: { path: '/demo/basic' } });
  await t.call({ method: 'appInfo' }).catch(() => undefined);
  const [ok, failed] = requestRecords().slice(before);
  expect(ok).toMatchObject({ method: 'peekRepo', params: { path: '/demo/basic' }, error: null });
  expect(ok.durationMs).toBeGreaterThanOrEqual(0);
  expect(failed).toMatchObject({ method: 'appInfo', params: undefined, error: { kind: 'Other', message: 'boom' } });
});

describe('createDemoTransport', () => {
  test('calls made before the demo is ready wait for it', async () => {
    let ready: (rt: DemoRuntime) => void = () => {};
    const t = createDemoTransport(new Promise((r) => { ready = r; }), table({ appInfo: async () => ({ appVersion: '1', build: null, gitVersion: 'x', installKind: 'none', home: null }) }));
    const reply = t.call({ method: 'appInfo' });
    ready(runtime());
    expect(await reply).toMatchObject({ appVersion: '1' });
  });

  test('replies and params are copies, as across a socket', async () => {
    const shared = { remotes: [], branch: 'main' };
    let seen: unknown = null;
    const t = createDemoTransport(Promise.resolve(runtime()), table({ peekRepo: async (params) => { seen = params; return shared; } }));
    const params = { path: '/demo/basic' };
    const first = (await t.call({ method: 'peekRepo', params })) as typeof shared;
    first.branch = 'changed';
    expect(((await t.call({ method: 'peekRepo', params })) as typeof shared).branch).toBe('main');
    expect(seen).toEqual(params);
    expect(seen).not.toBe(params);
  });

  test('anything thrown arrives as a GbError', async () => {
    const t = createDemoTransport(Promise.resolve(runtime()), table({
      appInfo: async () => { throw new Error('boom'); },
      repoInfo: async () => { throw gbError('InvalidInput', 'no open repository with id 3'); },
    }));
    await expect(t.call({ method: 'appInfo' })).rejects.toEqual({ kind: 'Other', message: 'boom', commandId: null, stderr: null });
    await expect(t.call({ method: 'repoInfo', params: { repo: 3 } })).rejects.toMatchObject({ kind: 'InvalidInput' });
    const failed = createDemoTransport(Promise.reject(gbError('NotFound', "The demo's data is missing: manifest.json (404)")), table({}));
    await expect(failed.call({ method: 'loadState' })).rejects.toMatchObject({ kind: 'NotFound' });
  });

  test('events reach subscribers asynchronously, until they unsubscribe', async () => {
    const rt = runtime();
    const t = createDemoTransport(Promise.resolve(rt), table({}));
    const got: AppEvent[] = [];
    const off = t.subscribe((ev) => got.push(ev));
    await tick();
    rt.ctx.emit({ type: 'openRequested', path: '/demo/basic' });
    expect(got).toEqual([]);
    await tick();
    expect(got).toEqual([{ type: 'openRequested', path: '/demo/basic' }]);
    off();
    rt.ctx.emit({ type: 'openRequested', path: '/demo/basic' });
    await tick();
    expect(got).toHaveLength(1);
  });
});
