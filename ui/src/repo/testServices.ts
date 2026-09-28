// Shared test doubles for `RepoServices`: import these instead of re-creating the block in
// every store/component test. Test-only; nothing in the app imports this module.
import type { CommitMessageCache } from '../api/commitMessages';
import type { CommitMessage } from '../api/gen/CommitMessage';
import type { RemotePayload } from '../api/gen/RemotePayload';
import { Loader } from '../data/loader';
import { Lru } from '../data/lru';
import type { RepoServices } from './services';

/** A loader whose loads never settle. */
export const idle = <V,>(): Loader<V> => new Loader<V>(() => new Promise<V>(() => {}), new Lru<string, V>(1));

/** A message cache whose loads never settle. */
export const idleMessages = (): CommitMessageCache => ({ capacity: 0, peek: () => undefined, get: () => new Promise<CommitMessage>(() => {}) });

/** `remotes()` and `remotesSnapshot()`, wired the way `createServices` wires them, from any
 * `fetch` a test gives `remotes:` in its overrides (else one that never settles): the snapshot
 * fills in once `fetch` resolves, whichever test drives it (a resolved array, a held promise a
 * test answers later, …). */
function wireRemotes(fetch: () => Promise<RemotePayload[]>): Pick<RepoServices, 'remotes' | 'remotesSnapshot'> {
  let pending: Promise<RemotePayload[]> | undefined;
  let snapshot: RemotePayload[] | null = null;
  return {
    remotes: () => (pending ??= fetch().then((r) => (snapshot = r)).catch((e: unknown) => {
      pending = undefined;
      throw e;
    })),
    remotesSnapshot: () => snapshot,
  };
}

/** `RepoServices` whose loads never settle, with any member replaced by `overrides`. */
export function fakeServices(overrides: Partial<RepoServices> = {}): RepoServices {
  return {
    details: idle(),
    files: idle(),
    contents: idle(),
    signature: idle(),
    treeFiles: idle(),
    messages: idleMessages(),
    ...wireRemotes(async () => []),
    ...overrides,
    ...(overrides.remotes && !overrides.remotesSnapshot ? wireRemotes(overrides.remotes) : {}),
  };
}

/**
 * `RepoServices` that record every fetch as `"<kind> <key>"` in `calls` (kinds: `details`,
 * `files`, `contents`, `signature`, `tree`, `message`) and hold it until the test settles it with
 * `resolve(call, value)` or `reject(call, error)`. Loaders run up to 8 fetches at once.
 */
export function recordingServices(overrides: Partial<RepoServices> = {}) {
  const calls: string[] = [];
  const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
  const fetch = <V,>(kind: string, key: string) => new Promise<V>((resolve, reject) => {
    calls.push(`${kind} ${key}`);
    pending.set(`${kind} ${key}`, { resolve: resolve as (v: unknown) => void, reject });
  });
  const mk = <V,>(kind: string) => new Loader<V>((key) => fetch<V>(kind, key), new Lru<string, V>(50), 8);
  const messageLoader = mk<CommitMessage>('message');
  const messages: CommitMessageCache = { capacity: 50, peek: (id) => messageLoader.peek(id), get: (id) => messageLoader.get(id) };
  const services: RepoServices = {
    details: mk('details'),
    files: mk('files'),
    contents: mk('contents'),
    signature: mk('signature'),
    treeFiles: mk('tree'),
    messages,
    ...wireRemotes(async () => []),
    ...overrides,
    ...(overrides.remotes && !overrides.remotesSnapshot ? wireRemotes(overrides.remotes) : {}),
  };
  const settle = (call: string) => {
    const p = pending.get(call);
    if (!p) throw new Error(`no pending call "${call}"; calls so far: ${calls.join(', ')}`);
    pending.delete(call);
    return p;
  };
  return {
    services,
    calls,
    resolve: (call: string, v: unknown) => settle(call).resolve(v),
    reject: (call: string, e: unknown) => settle(call).reject(e),
  };
}
