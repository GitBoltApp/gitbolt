//! Long-running operations (fetch, clone): ids, cancellation, and whether they may prompt.
//!
//! An op is registered for as long as its `OpGuard` lives. `cancelOp` cancels its token (git is
//! then killed as a process group, `GitCli::run`), and askpass looks the op up by the id in its
//! environment to decide whether a credential prompt may reach the user (spec §5.4).

use crate::events::OpKind;
use std::collections::HashMap;
use std::ops::Deref;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use tokio_util::sync::CancellationToken;

pub type OpId = u64;

pub struct OpEntry {
    pub id: OpId,
    pub kind: OpKind,
    pub repo: Option<u32>,
    /// User-started operations may prompt; GitBolt-started ones (background fetch) never do.
    pub interactive: bool,
    pub cancel: CancellationToken,
    /// Each `cancelOp` press, also once the op is cancelled: a write's autostash step, which a
    /// Cancel of the op itself doesn't stop, takes a press during it as Stop (spec #2 §6).
    pub stop_requested: tokio::sync::Notify,
    auth_denied: AtomicBool,
    prompt_cancelled: AtomicBool,
}

impl OpEntry {
    /// Askpass refused a prompt for this (non-interactive) op: its failure means "needs
    /// credentials", not an error to show.
    pub fn deny_auth(&self) {
        self.auth_denied.store(true, Ordering::SeqCst);
    }

    pub fn auth_denied(&self) -> bool {
        self.auth_denied.load(Ordering::SeqCst)
    }

    /// The user cancelled one of this op's credential prompts: git then fails with an auth
    /// error, which the op reports as cancelled, not failed.
    pub fn note_prompt_cancelled(&self) {
        self.prompt_cancelled.store(true, Ordering::SeqCst);
    }

    pub fn prompt_cancelled(&self) -> bool {
        self.prompt_cancelled.load(Ordering::SeqCst)
    }
}

pub struct OpRegistry {
    next: AtomicU64,
    ops: Mutex<HashMap<OpId, Arc<OpEntry>>>,
}

impl Default for OpRegistry {
    fn default() -> Self {
        Self { next: AtomicU64::new(1), ops: Mutex::new(HashMap::new()) }
    }
}

impl OpRegistry {
    fn ops(&self) -> MutexGuard<'_, HashMap<OpId, Arc<OpEntry>>> {
        // Nothing here can leave the map half-updated, so a poisoned lock is still consistent.
        self.ops.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Registers a new op; it stays registered until the returned guard is dropped.
    pub fn begin(self: &Arc<Self>, kind: OpKind, repo: Option<u32>, interactive: bool) -> OpGuard {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let entry = Arc::new(OpEntry { id, kind, repo, interactive, cancel: CancellationToken::new(), stop_requested: tokio::sync::Notify::new(), auth_denied: AtomicBool::new(false), prompt_cancelled: AtomicBool::new(false) });
        self.ops().insert(id, entry.clone());
        OpGuard { entry, registry: self.clone() }
    }

    /// Every registered op (a snapshot).
    pub fn running(&self) -> Vec<Arc<OpEntry>> {
        self.ops().values().cloned().collect()
    }

    pub fn get(&self, id: OpId) -> Option<Arc<OpEntry>> {
        self.ops().get(&id).cloned()
    }

    /// Cancels a running op; `false` when there's none with that id (finished, or never was).
    pub fn cancel(&self, id: OpId) -> bool {
        match self.get(id) {
            Some(e) => {
                e.cancel.cancel();
                e.stop_requested.notify_waiters();
                true
            }
            None => false,
        }
    }
}

/// Keeps an op registered while it runs.
pub struct OpGuard {
    entry: Arc<OpEntry>,
    registry: Arc<OpRegistry>,
}

impl Deref for OpGuard {
    type Target = OpEntry;
    fn deref(&self) -> &OpEntry {
        &self.entry
    }
}

impl Drop for OpGuard {
    /// Also cancels the op: if its future was dropped mid-flight (a caller gave up), anything
    /// still waiting on it, such as an askpass prompt and its modal, is released.
    fn drop(&mut self) {
        self.entry.cancel.cancel();
        self.registry.ops().remove(&self.entry.id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ops_register_cancel_and_unregister_on_drop() {
        let reg = Arc::new(OpRegistry::default());
        let a = reg.begin(OpKind::Fetch, Some(1), false);
        let b = reg.begin(OpKind::Clone, None, true);
        assert_ne!(a.id, b.id);
        assert!(a.id >= 1);
        assert!(!a.interactive && b.interactive);
        assert!(reg.cancel(b.id));
        assert!(b.cancel.is_cancelled());
        assert!(!a.auth_denied());
        a.deny_auth();
        assert!(reg.get(a.id).unwrap().auth_denied());
        let id = a.id;
        drop(a);
        assert!(reg.get(id).is_none());
        assert!(!reg.cancel(id));
    }

    /// A dropped op (its future dropped mid-flight) cancels its token, so whatever still waits on
    /// it (an askpass prompt and its modal) is released.
    #[test]
    fn dropping_the_guard_cancels_the_op() {
        let reg = Arc::new(OpRegistry::default());
        let op = reg.begin(OpKind::Fetch, None, true);
        let token = op.cancel.clone();
        let entry = reg.get(op.id).unwrap();
        assert!(!token.is_cancelled());
        drop(op);
        assert!(token.is_cancelled());
        assert!(entry.cancel.is_cancelled());
    }

    #[test]
    fn a_cancelled_prompt_is_remembered() {
        let reg = Arc::new(OpRegistry::default());
        let op = reg.begin(OpKind::Clone, None, true);
        assert!(!op.prompt_cancelled());
        reg.get(op.id).unwrap().note_prompt_cancelled();
        assert!(op.prompt_cancelled());
    }
}
