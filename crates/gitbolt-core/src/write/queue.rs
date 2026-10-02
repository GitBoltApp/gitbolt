//! The action queue (spec #2 §3.6) and the write lock (§3.5).
//!
//! One per repository, keyed by its canonical common dir, and shared by every tab and worktree
//! of it, since refs and stashes are shared. User writes run one at a time, in click order: an
//! item is never dropped, merged with another, or overtaken by a later one. A failure stops
//! the items queued behind it (a Cancel stops nothing); they stay listed until Resume (each
//! re-resolves when it runs) or Clear. A background fetch isn't an item: it runs only when the queue is idle, and enqueuing a
//! user op cancels it. Immediate writes (stage, discards, …) skip the queue and take `lock` directly.

use crate::error::{GbError, GbErrorKind};
use crate::events::OpKind;
use crate::journal::RefMove;
use crate::write::types::{Expect, QueueItem, QueueStatePayload, QueueStop};
use std::collections::{BTreeSet, HashSet, VecDeque};
use std::sync::{Arc, Mutex, MutexGuard};
use tokio_util::sync::CancellationToken;

/// A repository's write lock and action queue (spec #2 §3.5, §3.6).
///
/// For the pipeline built on this (T9):
/// - under the lock, a write that holds the watcher (`RepoWatcher::hold`) calls `absorb` as late
///   as possible, after its last git command, and always refreshes after the write, whatever
///   the outcome;
/// - the journal's `recover()` runs once per process, at a repository's first open, never while
///   a write holds this lock, and never on a live owner's pending entry (another instance's
///   write in flight).
pub(crate) struct RepoWrites {
    /// Taken by every write for its local phases (a network transfer runs outside it).
    pub(crate) lock: tokio::sync::Mutex<()>,
    pub(crate) queue: WriteQueue,
    /// The open repo ids sharing this common dir (one per tab's worktree, Deviation 4).
    ids: Arc<Mutex<BTreeSet<u32>>>,
    /// Writes waiting in `acquire` for `lock`.
    waiting: std::sync::atomic::AtomicUsize,
}

/// Counts a waiter out of `RepoWrites::waiting` however its wait ends.
struct Waiting<'a>(&'a std::sync::atomic::AtomicUsize);

impl Drop for Waiting<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
    }
}

impl RepoWrites {
    /// Takes the write lock (FIFO), counted in `waiting` while it waits.
    pub(crate) async fn acquire(&self) -> tokio::sync::MutexGuard<'_, ()> {
        self.waiting.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let _counted = Waiting(&self.waiting);
        self.lock.lock().await
    }

    /// How many writes wait for the lock (tests wait on it instead of on the clock).
    #[cfg(test)]
    pub(crate) fn waiting(&self) -> usize {
        self.waiting.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// `emit(id, state)` announces a change to every open id.
    pub(crate) fn new(emit: impl Fn(u32, &QueueStatePayload) + Send + Sync + 'static) -> Self {
        let ids: Arc<Mutex<BTreeSet<u32>>> = Arc::default();
        let to = ids.clone();
        let queue = WriteQueue::new(Box::new(move |s| {
            for id in to.lock().unwrap_or_else(|e| e.into_inner()).iter() {
                emit(*id, s);
            }
        }));
        Self { lock: tokio::sync::Mutex::new(()), queue, ids, waiting: Default::default() }
    }

    pub(crate) fn add_id(&self, id: u32) {
        self.ids.lock().unwrap_or_else(|e| e.into_inner()).insert(id);
    }

    pub(crate) fn ids(&self) -> Vec<u32> {
        self.ids.lock().unwrap_or_else(|e| e.into_inner()).iter().copied().collect()
    }
}

type OnChange = Box<dyn Fn(&QueueStatePayload) + Send + Sync>;

pub(crate) struct WriteQueue {
    inner: Mutex<Inner>,
    wake: tokio::sync::Notify,
    on_change: OnChange,
}

struct Item {
    id: u64,
    label: String,
    kind: OpKind,
    op: u64,
}

#[derive(Default)]
struct Inner {
    next: u64,
    queued: VecDeque<Item>,
    running: Option<Item>,
    stopped: Option<QueueStop>,
    /// Removed (×) or cleared while queued: their `turn` returns Cancelled.
    dropped: HashSet<u64>,
    background: Option<CancellationToken>,
    /// The ref moves finished items made, stamped with when they finished (for `carry`).
    moves: Vec<(u64, RefMove)>,
    finished: u64,
}

impl Inner {
    fn payload(&self) -> QueueStatePayload {
        let info = |i: &Item| QueueItem { id: i.id, label: i.label.clone(), kind: i.kind, op: i.op };
        QueueStatePayload { running: self.running.as_ref().map(info), queued: self.queued.iter().map(info).collect(), stopped: self.stopped.clone() }
    }
}

/// A place in the queue. Dropped before its turn (the request went away), it leaves the queue.
pub(crate) struct Ticket<'q> {
    q: &'q WriteQueue,
    id: u64,
    seq: u64,
    armed: bool,
    /// The op's cancel (`cancel_on`): cancelled while waiting, the item leaves the queue.
    cancel: Option<CancellationToken>,
}

impl Ticket<'_> {
    /// Cancelling `token` before this item's turn takes it out of the queue at once: its `turn`
    /// is `Cancelled` and nothing stops (a Cancel stops the rest only once the item runs).
    pub(crate) fn cancel_on(mut self, token: CancellationToken) -> Self {
        self.cancel = Some(token);
        self
    }
}

/// The running item's turn. `finish` it; a dropped unfinished slot counts as a failure.
pub(crate) struct Slot<'q> {
    q: &'q WriteQueue,
    #[allow(dead_code)] // nothing reads it yet (2B: the queue ops)
    pub(crate) id: u64,
    seq: u64,
    done: bool,
}

/// A background fetch's turn: only while the queue is idle.
pub(crate) struct BackgroundSlot<'q> {
    q: &'q WriteQueue,
}

impl WriteQueue {
    pub(crate) fn new(on_change: OnChange) -> Self {
        Self { inner: Mutex::default(), wake: tokio::sync::Notify::new(), on_change }
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Calls `f` under the lock, then announces the new state and wakes every waiter.
    /// `on_change` runs under the lock, so announcements arrive in the order the changes were
    /// made (a later state never lands before an earlier one). It must not touch the queue.
    fn change<T>(&self, f: impl FnOnce(&mut Inner) -> T) -> T {
        let out = {
            let mut g = self.lock();
            let out = f(&mut g);
            (self.on_change)(&g.payload());
            out
        };
        self.wake.notify_waiters();
        out
    }

    pub(crate) fn enqueue(&self, label: &str, kind: OpKind, op: u64) -> Ticket<'_> {
        let (id, seq) = self.change(|g| {
            g.next += 1;
            let id = g.next;
            g.queued.push_back(Item { id, label: label.to_string(), kind, op });
            if let Some(bg) = &g.background {
                // Fetch is idempotent; the next interval retries it (§3.6).
                bg.cancel();
            }
            (id, g.finished)
        });
        Ticket { q: self, id, seq, armed: true, cancel: None }
    }

    /// Waits until `ticket` is at the front, nothing runs, the queue isn't stopped and no
    /// background fetch is still stopping. `Cancelled` at once if the item is removed, cleared,
    /// or its `cancel_on` token is cancelled while it waits.
    pub(crate) async fn turn<'q>(&'q self, mut ticket: Ticket<'q>) -> Result<Slot<'q>, GbError> {
        loop {
            let notified = self.wake.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if ticket.cancel.as_ref().is_some_and(CancellationToken::is_cancelled) {
                // Still armed: dropping the ticket takes it out of the queue and announces it.
                return Err(GbError::new(GbErrorKind::Cancelled, "Cancelled"));
            }
            {
                let mut g = self.lock();
                if g.dropped.remove(&ticket.id) {
                    ticket.armed = false;
                    return Err(GbError::new(GbErrorKind::Cancelled, "Removed from the queue"));
                }
                let front = g.queued.front().is_some_and(|i| i.id == ticket.id);
                if front && g.running.is_none() && g.stopped.is_none() && g.background.is_none() {
                    let item = g.queued.pop_front().expect("front");
                    g.running = Some(item);
                    (self.on_change)(&g.payload());
                    drop(g);
                    ticket.armed = false;
                    return Ok(Slot { q: self, id: ticket.id, seq: ticket.seq, done: false });
                }
            }
            match ticket.cancel.clone() {
                Some(cancel) => {
                    tokio::select! {
                        () = &mut notified => {}
                        () = cancel.cancelled() => {}
                    }
                }
                None => notified.await,
            }
        }
    }

    pub(crate) fn state(&self) -> QueueStatePayload {
        self.lock().payload()
    }

    /// A queued item's ×. `false` if it isn't queued (running, done, or unknown).
    pub(crate) fn remove(&self, id: u64) -> bool {
        self.change(|g| match g.queued.iter().position(|i| i.id == id) {
            Some(at) => {
                g.queued.remove(at);
                g.dropped.insert(id);
                true
            }
            None => false,
        })
    }

    pub(crate) fn resume(&self) {
        self.change(|g| g.stopped = None);
    }

    pub(crate) fn clear(&self) {
        self.change(|g| {
            let ids: Vec<u64> = g.queued.drain(..).map(|i| i.id).collect();
            g.dropped.extend(ids);
            g.stopped = None;
        });
    }

    pub(crate) fn try_background(&self, cancel: CancellationToken) -> Option<BackgroundSlot<'_>> {
        let mut g = self.lock();
        if g.running.is_some() || !g.queued.is_empty() || g.background.is_some() {
            return None;
        }
        g.background = Some(cancel);
        Some(BackgroundSlot { q: self })
    }
}

impl Drop for Ticket<'_> {
    fn drop(&mut self) {
        if self.armed {
            let id = self.id;
            self.q.change(|g| {
                g.queued.retain(|i| i.id != id);
                // Removed or cleared, then dropped without its `turn`: forget it.
                g.dropped.remove(&id);
            });
        }
    }
}

impl Slot<'_> {
    /// `expect` carried forward by the moves the items ahead of this one made since it was
    /// enqueued (§3.6). An expected oid an earlier item moved from becomes the oid it moved to;
    /// anything else is an outside change, so preflight says `RefMoved`.
    pub(crate) fn carry(&self, expect: &Expect) -> Expect {
        let g = self.q.lock();
        let mut out = expect.clone();
        for (_, m) in g.moves.iter().filter(|(at, _)| *at >= self.seq) {
            if m.name == "HEAD" {
                if out.head == m.old {
                    out.head = m.new.clone();
                }
            } else if let Some(want) = out.refs.get_mut(&m.name)
                && *want == m.old
            {
                *want = m.new.clone();
            }
        }
        out
    }

    /// Done. A `failure` stops the items queued behind it; with none queued, the queue stays
    /// open (there's nothing to protect), and a Cancel never stops it: it was a choice about this
    /// one item. `moves` are what it moved, for the items behind it (`carry`); include
    /// `RefMove { name: "HEAD", … }` when HEAD's oid moved.
    pub(crate) fn finish(mut self, failure: Option<&GbError>, moves: &[RefMove]) {
        self.done = true;
        let stop = failure.filter(|e| e.kind != GbErrorKind::Cancelled).map(|e| e.message.clone());
        self.end(stop, moves);
    }

    fn end(&self, stop: Option<String>, moves: &[RefMove]) {
        self.q.change(|g| {
            let at = g.finished;
            g.finished += 1;
            g.moves.extend(moves.iter().cloned().map(|m| (at, m)));
            let item = g.running.take();
            if let (Some(message), Some(item)) = (stop, item)
                && !g.queued.is_empty()
            {
                g.stopped = Some(QueueStop { label: item.label, message });
            }
            if g.queued.is_empty() {
                // Nobody left to carry for.
                g.moves.clear();
            }
        });
    }
}

impl Drop for Slot<'_> {
    fn drop(&mut self) {
        if !self.done {
            self.end(Some("Interrupted".into()), &[]);
        }
    }
}

impl Drop for BackgroundSlot<'_> {
    fn drop(&mut self) {
        self.q.change(|g| g.background = None);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::time::Duration;

    fn queue() -> (Arc<WriteQueue>, Arc<Mutex<Vec<QueueStatePayload>>>) {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        (Arc::new(WriteQueue::new(Box::new(move |s: &QueueStatePayload| log.lock().unwrap().push(s.clone())))), seen)
    }

    fn token() -> CancellationToken {
        CancellationToken::new()
    }

    #[tokio::test]
    async fn items_run_in_click_order_and_a_second_push_is_queued_not_dropped() {
        let (q, _) = queue();
        let a = q.enqueue("push dev", OpKind::Push, 1);
        let b = q.enqueue("push dev", OpKind::Push, 2);
        let c = q.enqueue("commit \"x\"", OpKind::Commit, 3);
        assert_eq!(q.state().queued.iter().map(|i| i.op).collect::<Vec<_>>(), [1, 2, 3], "the second push is queued, not dropped");
        let order = Mutex::new(Vec::new());
        let run = |t, n: u64| {
            let (q, order) = (&q, &order);
            async move {
                let s = q.turn(t).await.unwrap();
                order.lock().unwrap().push(n);
                tokio::time::sleep(Duration::from_millis(20)).await;
                s.finish(None, &[]);
            }
        };
        // Polled in reverse: the queue alone decides the order.
        tokio::join!(run(c, 3), run(b, 2), run(a, 1));
        assert_eq!(*order.lock().unwrap(), [1, 2, 3]);
    }

    #[tokio::test]
    async fn removing_a_queued_item_cancels_only_it() {
        let (q, _) = queue();
        let a = q.enqueue("a", OpKind::Commit, 1);
        let b = q.enqueue("b", OpKind::Commit, 2);
        let c = q.enqueue("c", OpKind::Commit, 3);
        let sa = q.turn(a).await.unwrap();
        let b_id = q.state().queued[0].id;
        assert!(q.remove(b_id));
        assert!(!q.remove(b_id), "once");
        let s = q.state();
        assert_eq!(s.queued.iter().map(|i| i.op).collect::<Vec<_>>(), [3], "gone at once");
        assert_eq!(s.running.map(|i| i.op), Some(1), "the running one carries on");
        assert_eq!(q.turn(b).await.err().map(|e| e.kind), Some(GbErrorKind::Cancelled));
        assert!(q.state().stopped.is_none(), "a removal stops nothing");
        sa.finish(None, &[]);
        q.turn(c).await.unwrap().finish(None, &[]);
        assert!(q.lock().dropped.is_empty());
        // Removed, then dropped without its turn: nothing is left behind either.
        let d = q.enqueue("d", OpKind::Commit, 4);
        assert!(q.remove(q.state().queued[0].id));
        drop(d);
        assert!(q.lock().dropped.is_empty(), "no leak");
    }

    #[tokio::test]
    async fn a_waiter_cancelled_before_its_turn_leaves_at_once_and_stops_nothing() {
        let (q, seen) = queue();
        let a = q.enqueue("a", OpKind::Commit, 1);
        let cancel = token();
        let b = q.enqueue("fetch repo", OpKind::Fetch, 2).cancel_on(cancel.clone());
        let c = q.enqueue("c", OpKind::Commit, 3);
        let sa = q.turn(a).await.unwrap();
        let (b_turn, ()) = tokio::join!(q.turn(b), async {
            tokio::time::sleep(Duration::from_millis(50)).await;
            seen.lock().unwrap().clear();
            cancel.cancel();
        });
        assert_eq!(b_turn.err().map(|e| e.kind), Some(GbErrorKind::Cancelled), "no waiting for a's end");
        let s = q.state();
        assert_eq!(s.queued.iter().map(|i| i.op).collect::<Vec<_>>(), [3]);
        assert_eq!(s.running.map(|i| i.op), Some(1));
        assert!(s.stopped.is_none());
        assert_eq!(seen.lock().unwrap().last().map(|s| s.queued.len()), Some(1), "announced");
        sa.finish(None, &[]);
        q.turn(c).await.unwrap().finish(None, &[]);
        assert_eq!(q.state(), QueueStatePayload::default());
    }

    #[tokio::test]
    async fn a_failure_stops_the_rest_until_resume_and_clear_drops_them() {
        let (q, _) = queue();
        let a = q.enqueue("push dev", OpKind::Push, 1);
        let b = q.enqueue("b", OpKind::Commit, 2);
        let c = q.enqueue("c", OpKind::Commit, 3);
        q.turn(a).await.unwrap().finish(Some(&GbError::other("rejected")), &[]);
        let s = q.state();
        assert_eq!(s.stopped, Some(QueueStop { label: "push dev".into(), message: "rejected".into() }));
        assert_eq!(s.queued.len(), 2, "not run, still listed");
        let (b_turn, ()) = tokio::join!(q.turn(b), async {
            tokio::time::sleep(Duration::from_millis(100)).await;
            assert!(q.state().running.is_none(), "b waits while stopped");
            q.resume();
        });
        b_turn.unwrap().finish(None, &[]);
        q.turn(c).await.unwrap().finish(None, &[]);
        // Stopped again, then Clear drops what's behind.
        let e = q.enqueue("e", OpKind::Commit, 5);
        let d = q.enqueue("d", OpKind::Commit, 4);
        q.turn(e).await.unwrap().finish(Some(&GbError::other("hook failed")), &[]);
        assert_eq!(q.state().stopped.map(|s| s.label), Some("e".into()));
        q.clear();
        assert_eq!(q.turn(d).await.err().map(|e| e.kind), Some(GbErrorKind::Cancelled));
        assert_eq!(q.state(), QueueStatePayload::default());
    }

    /// Stop-on-failure protects what was queued behind the failed item: with nothing behind it,
    /// the queue stays open and the next action runs at once.
    #[tokio::test]
    async fn a_failure_with_nothing_queued_leaves_the_queue_open() {
        let (q, _) = queue();
        let a = q.enqueue("fetch repo", OpKind::Fetch, 1);
        q.turn(a).await.unwrap().finish(Some(&GbError::other("Could not resolve host")), &[]);
        assert_eq!(q.state(), QueueStatePayload::default(), "no Stopped chip");
        let b = q.enqueue("fetch repo", OpKind::Fetch, 2);
        tokio::time::timeout(Duration::from_secs(1), q.turn(b)).await.expect("runs at once").unwrap().finish(None, &[]);
    }

    /// A Cancel is a choice about the one item, not a failure: the items behind it run.
    #[tokio::test]
    async fn cancelling_the_running_item_lets_the_next_one_run() {
        let (q, _) = queue();
        let a = q.enqueue("push dev", OpKind::Push, 1);
        let b = q.enqueue("b", OpKind::Commit, 2);
        q.turn(a).await.unwrap().finish(Some(&GbError::new(GbErrorKind::Cancelled, "Cancelled")), &[]);
        assert!(q.state().stopped.is_none());
        tokio::time::timeout(Duration::from_secs(1), q.turn(b)).await.expect("runs at once").unwrap().finish(None, &[]);
    }

    #[tokio::test]
    async fn expect_is_carried_forward_by_the_moves_ahead_only() {
        let (q, _) = queue();
        let a = q.enqueue("commit", OpKind::Commit, 1);
        let b = q.enqueue("push", OpKind::Push, 2);
        let mv = |name: &str, old: &str, new: &str| RefMove { name: name.into(), old: Some(old.into()), new: Some(new.into()) };
        q.turn(a).await.unwrap().finish(None, &[mv("refs/heads/main", "x", "y"), mv("HEAD", "x", "y")]);
        let sb = q.turn(b).await.unwrap();
        let shown = Expect { head: Some("x".into()), refs: [("refs/heads/main".to_string(), Some("x".to_string())), ("refs/heads/other".to_string(), Some("z".to_string()))].into() };
        let carried = sb.carry(&shown);
        assert_eq!(carried.head.as_deref(), Some("y"));
        assert_eq!(carried.refs["refs/heads/main"].as_deref(), Some("y"), "the commit ahead moved it");
        assert_eq!(carried.refs["refs/heads/other"].as_deref(), Some("z"), "anything else stays: an outside move is RefMoved");
        sb.finish(None, &[]);
        // A later item enqueued after the commit ran sees no carry: what it was shown is current.
        let c = q.enqueue("c", OpKind::Commit, 3);
        assert_eq!(q.turn(c).await.unwrap().carry(&shown), shown);
    }

    #[tokio::test]
    async fn a_background_slot_runs_only_when_idle_and_an_enqueue_cancels_it() {
        let (q, _) = queue();
        let bg = token();
        let slot = q.try_background(bg.clone()).expect("idle");
        assert!(q.try_background(token()).is_none(), "one at a time");
        let a = q.enqueue("commit", OpKind::Commit, 1);
        assert!(bg.is_cancelled(), "a user op cancels the background fetch");
        let (a_turn, ()) = tokio::join!(q.turn(a), async {
            tokio::time::sleep(Duration::from_millis(100)).await;
            assert!(q.state().running.is_none(), "it waits until the fetch has stopped");
            drop(slot);
        });
        a_turn.unwrap().finish(None, &[]);
        let busy = q.enqueue("b", OpKind::Commit, 2);
        assert!(q.try_background(token()).is_none(), "not while anything is queued");
        q.turn(busy).await.unwrap().finish(None, &[]);
        assert!(q.try_background(token()).is_some());
    }

    #[tokio::test]
    async fn a_dropped_ticket_or_slot_never_blocks_the_queue() {
        let (q, _) = queue();
        let a = q.enqueue("a", OpKind::Commit, 1);
        let b = q.enqueue("b", OpKind::Commit, 2);
        let c = q.enqueue("c", OpKind::Commit, 3);
        drop(a);
        let sb = q.turn(b).await.unwrap();
        drop(sb);
        assert_eq!(q.state().stopped.map(|s| s.message), Some("Interrupted".into()), "a dropped running item counts as failed");
        drop(c);
    }

    #[tokio::test]
    async fn every_change_is_announced() {
        let (q, seen) = queue();
        let a = q.enqueue("a", OpKind::Commit, 1);
        q.turn(a).await.unwrap().finish(None, &[]);
        let states = seen.lock().unwrap().clone();
        assert_eq!(states.len(), 3, "queued, running, done");
        assert_eq!(states[0].queued.len(), 1);
        assert!(states[1].running.is_some());
        assert_eq!(states[2], QueueStatePayload::default());
    }
}
