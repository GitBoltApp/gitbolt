// Every backend method's demo handler: the implemented ones by group (later tasks and plans add
// theirs here and remove them from PENDING), "Not in the demo", and a placeholder for the rest.
import { PENDING, type PendingMethod } from '../coverage';
import { notInDemo } from '../engine/errors';
import type { Handler, HandlerTable, Method } from '../transport';
import { graphHandlers } from './graph';
import { notInDemoHandlers } from './notInDemo';
import { READ_HANDLERS } from './reads';
import { repoHandlers } from './repo';

const PLACEHOLDER = Symbol('a demo handler still to write');

function pending<M extends Method>(method: M): Handler<M> {
  return Object.assign(async () => notInDemo(`${method} (not yet)`), { [PLACEHOLDER]: true });
}

export const isPending = (h: unknown): boolean => typeof h === 'function' && PLACEHOLDER in h;

const placeholders = Object.fromEntries(PENDING.map((m) => [m, pending(m)])) as { [M in PendingMethod]: Handler<M> };

export const HANDLERS: HandlerTable = { ...placeholders, ...notInDemoHandlers, ...repoHandlers, ...graphHandlers, ...READ_HANDLERS };
