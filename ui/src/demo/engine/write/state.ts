// What the demo's writes keep for the page's life: each worktree's journal and staging log, each
// repository's queue, and the ops (their ids and Cancel, the core's `OpRegistry`).
import type { AppEvent } from '../../../api/gen/AppEvent';
import type { RewriteKind } from '../../../api/gen/RewriteKind';
import type { ReadRepo } from '../read/seam';
import { recordRewrite } from '../seq/rewrites';
import { DEMO_IDENTITY } from './objects';
import { Journal } from './journal';
import { WriteQueue, type QueueTicket } from './queue';
import type { RefMove } from './refs';
import { StagingLog } from './staging';

/** The core's `rewrites::record`: after every write, a rewrite of a pushed branch records its lease
 *  and any move drops a mark it ended. Never throws. */
export type RewriteRecorder = (repo: ReadRepo, kind: RewriteKind | null, moves: RefMove[]) => Promise<void>;

interface LiveOp {
  cancelled: boolean;
  onCancel: (() => void)[];
  /** Its place in a queue while it waits. */
  waiting: { queue: WriteQueue; id: number } | null;
}

export class DemoWrites {
  private readonly journals = new Map<string, Journal>();
  private readonly logs = new Map<string, StagingLog>();
  private readonly queues = new Map<number, WriteQueue>();
  private ops = 0;
  private readonly live = new Map<number, LiveOp>();
  /** The rewrite marks (`seq/rewrites.ts`), recorded as the visitor. */
  recordRewrite: RewriteRecorder = (repo, kind, moves) => recordRewrite(repo, kind, moves, DEMO_IDENTITY.email);

  /** A new op, registered until `ended`. */
  nextOp(): number {
    const op = ++this.ops;
    this.live.set(op, { cancelled: false, onCancel: [], waiting: null });
    return op;
  }

  /** CancelOp: a queued op leaves its queue (its turn is Cancelled); a running one is told (its
   *  `onCancel`s run, once). False when no such op is registered (finished, or never was). */
  cancel(op: number): boolean {
    const o = this.live.get(op);
    if (!o) return false;
    if (o.waiting) o.waiting.queue.cancel(o.waiting.id);
    if (!o.cancelled) {
      o.cancelled = true;
      const fs = o.onCancel;
      o.onCancel = [];
      for (const f of fs) f();
    }
    return true;
  }

  cancelled(op: number): boolean {
    return this.live.get(op)?.cancelled ?? false;
  }

  /** `f` runs when the op is cancelled (at once if it is already). */
  onCancel(op: number, f: () => void): void {
    const o = this.live.get(op);
    if (!o) return;
    if (o.cancelled) f();
    else o.onCancel.push(f);
  }

  /** The op waits in `queue` as `ticket` until its turn; one cancelled already leaves at once (its
   *  turn is Cancelled, as the core's). */
  queued(op: number, queue: WriteQueue, ticket: QueueTicket): void {
    const o = this.live.get(op);
    if (!o) return;
    o.waiting = { queue, id: ticket.id };
    if (o.cancelled) queue.cancel(ticket.id);
  }

  /** The op finished (`opFinished`, or it never started): it's forgotten. */
  ended(op: number): void {
    this.live.delete(op);
  }

  /** By the worktree's root. */
  journal(root: string): Journal {
    let j = this.journals.get(root);
    if (!j) this.journals.set(root, (j = new Journal()));
    return j;
  }

  staging(root: string): StagingLog {
    let l = this.logs.get(root);
    if (!l) this.logs.set(root, (l = new StagingLog()));
    return l;
  }

  /** The repository's queue; its changes go out as `queueChanged`. */
  queue(repo: number, emit: (ev: AppEvent) => void): WriteQueue {
    let q = this.queues.get(repo);
    if (!q) this.queues.set(repo, (q = new WriteQueue((s) => emit({ type: 'queueChanged', repo, ...s }))));
    return q;
  }
}
