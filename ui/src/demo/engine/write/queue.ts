// The per-repository write queue and lock (write/queue.rs, spec #2 §3.6): queued writes run one at a
// time in click order, and each change is announced (`queueChanged`); immediate writes (stage,
// discards, saves) take the lock directly. A failure stops the items queued behind it until Resume
// or Clear. The moves each item made carry the `expect` of the items behind it forward. A background
// fetch isn't an item: it runs only while the queue is idle, and an enqueue cancels it.
import type { Expect } from '../../../api/gen/Expect';
import type { GbError } from '../../../api/gen/GbError';
import type { OpKind } from '../../../api/gen/OpKind';
import type { QueueItem } from '../../../api/gen/QueueItem';
import type { QueueStatePayload } from '../../../api/gen/QueueStatePayload';
import type { QueueStop } from '../../../api/gen/QueueStop';
import { gbError } from '../errors';
import type { RefMove } from './refs';

export interface QueueTicket {
  id: number;
  /** How many items had finished when it joined: the moves from then on are carried for it. */
  seq: number;
}

export class WriteQueue {
  private readonly announce: (s: QueueStatePayload) => void;
  private next = 0;
  private finished = 0;
  private running: QueueItem | null = null;
  private queued: QueueItem[] = [];
  private stopped: QueueStop | null = null;
  /** Removed (×), cleared or cancelled while queued: their `turn` is Cancelled, with this message. */
  private readonly dropped = new Map<number, string>();
  /** The moves finished items made, stamped with when they finished (for `carry`). */
  private moves: [number, RefMove][] = [];
  private waiters: (() => void)[] = [];
  /** The background fetch running now: its cancel. */
  private background: (() => void) | null = null;
  private tail: Promise<void> = Promise.resolve();

  constructor(announce: (s: QueueStatePayload) => void) {
    this.announce = announce;
  }

  state(): QueueStatePayload {
    return { running: this.running && { ...this.running }, queued: this.queued.map((i) => ({ ...i })), stopped: this.stopped && { ...this.stopped } };
  }

  /** Announces the state and wakes every waiting turn. */
  private changed(): void {
    this.announce(this.state());
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f();
  }

  enqueue(label: string, kind: OpKind, op: number): QueueTicket {
    const id = ++this.next;
    this.queued.push({ id, label, kind, op });
    // Fetch is idempotent; the next interval retries it (§3.6).
    this.background?.();
    this.changed();
    return { id, seq: this.finished };
  }

  /** The item leaves before its turn (its request failed first). */
  drop(t: QueueTicket): void {
    this.queued = this.queued.filter((i) => i.id !== t.id);
    this.dropped.delete(t.id);
    this.changed();
  }

  /** Waits until the item is at the front, nothing runs, the queue isn't stopped and no background
   *  fetch is still stopping; then it runs
   *  (announced) and `started` is called (the core's `opStarted` comes before the lock). The slot and the
   *  write lock are separate steps: the caller takes the lock with `lock()` when it is ready (a pull's
   *  transfer runs in between, holding the slot only). */
  async turn(t: QueueTicket, started?: () => void): Promise<{ lock: () => Promise<() => void>; carry: (e: Expect) => Expect }> {
    for (;;) {
      const why = this.dropped.get(t.id);
      if (why !== undefined) {
        this.dropped.delete(t.id);
        throw gbError('Cancelled', why);
      }
      if (this.queued[0]?.id === t.id && this.running === null && this.stopped === null && this.background === null) {
        this.running = this.queued.shift()!;
        this.announce(this.state());
        started?.();
        return { lock: () => this.lock(), carry: (e) => this.carry(t.seq, e) };
      }
      await new Promise<void>((r) => this.waiters.push(r));
    }
  }

  /** The write lock (a promise chain, FIFO): resolves with its release. */
  async lock(): Promise<() => void> {
    let release!: () => void;
    const next = new Promise<void>((r) => (release = r));
    const prev = this.tail;
    this.tail = prev.then(() => next);
    await prev;
    return release;
  }

  /** `Slot::carry`: an expected oid an earlier item moved from becomes the oid it moved to; anything
   *  else is an outside change, so preflight says RefMoved. */
  private carry(seq: number, e: Expect): Expect {
    const out: Expect = { head: e.head ?? null, refs: { ...(e.refs ?? {}) } };
    for (const [at, m] of this.moves) {
      if (at < seq) continue;
      if (m.name === 'HEAD') {
        if (out.head === m.old) out.head = m.new;
      } else if (Object.hasOwn(out.refs, m.name) && out.refs[m.name] === m.old) out.refs[m.name] = m.new;
    }
    return out;
  }

  /** The running item is done: a failure (not a Cancel) stops the items queued behind it; with none
   *  queued, the queue stays open. `moves` (HEAD's included when its oid moved) are carried for them. */
  finish(failure: GbError | null, moves: RefMove[]): void {
    const at = this.finished++;
    for (const m of moves) this.moves.push([at, m]);
    const item = this.running;
    this.running = null;
    if (failure && failure.kind !== 'Cancelled' && item && this.queued.length > 0) this.stopped = { label: item.label, message: failure.message };
    // Nobody left to carry for.
    if (this.queued.length === 0) this.moves = [];
    this.changed();
  }

  /** A queued item's ×; false if it isn't queued (running, done or unknown). */
  remove(id: number, why = 'Removed from the queue'): boolean {
    const at = this.queued.findIndex((i) => i.id === id);
    if (at < 0) return false;
    this.queued.splice(at, 1);
    this.dropped.set(id, why);
    this.changed();
    return true;
  }

  /** Its op's Cancel while it waits (`Ticket::cancel_on`): it leaves the queue, and nothing stops. */
  cancel(id: number): boolean {
    return this.remove(id, 'Cancelled');
  }

  /** A background fetch's turn (`try_background`): only while nothing runs or waits, one at a time;
   *  `cancel` runs when an item is enqueued meanwhile. Null when the queue is busy. */
  tryBackground(cancel: () => void): { end(): void } | null {
    if (this.running !== null || this.queued.length > 0 || this.background !== null) return null;
    this.background = cancel;
    return {
      end: () => {
        this.background = null;
        this.changed();
      },
    };
  }

  resume(): void {
    this.stopped = null;
    this.changed();
  }

  clear(): void {
    for (const i of this.queued) this.dropped.set(i.id, 'Removed from the queue');
    this.queued = [];
    this.stopped = null;
    this.changed();
  }
}
