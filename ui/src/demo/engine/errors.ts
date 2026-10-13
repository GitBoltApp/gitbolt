// GbError values as the core makes them: the demo's handlers fail the way the backend does.
import type { GbError } from '../../api/gen/GbError';
import type { GbErrorKind } from '../../api/gen/GbErrorKind';
import { isGbError } from '../../errors/describe';

export function gbError(kind: GbErrorKind, message: string): GbError {
  return { kind, message, commandId: null, stderr: null };
}

export const NOT_IN_DEMO = 'Not in the demo: ';

/** What a browser can't do (spec §4.3, the "Not in the demo" tier): the UI shows the message. */
export function notInDemo(what: string): never {
  throw gbError('Other', `${NOT_IN_DEMO}${what}`);
}

/** Anything a handler threw, as the GbError a backend would have sent. */
export function asGbError(e: unknown): GbError {
  if (isGbError(e)) return e;
  return gbError('Other', e instanceof Error ? e.message : String(e));
}
