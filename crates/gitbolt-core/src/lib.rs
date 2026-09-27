//! GitBolt core: all git access, graph layout and the API surface. No Tauri dependency.

pub mod api;
pub mod commit;
pub mod error;
pub mod git;
pub mod graph;
pub mod log;
pub mod payload;
pub mod redact;
pub mod reflog;
pub mod refs;
pub mod remotes;
pub mod snapshot;
pub mod status;
pub mod walk;
pub mod worktree;

#[cfg(any(test, feature = "testing"))]
pub mod testing;
