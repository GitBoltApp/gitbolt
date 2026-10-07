//! GitBolt core: all git access, graph layout and the API surface. No Tauri dependency.

pub mod api;
pub mod askpass;
pub mod avatar;
pub mod blob;
pub mod commit;
pub mod details;
pub mod diagnostics;
pub mod diff;
pub mod error;
pub mod events;
pub mod find;
pub mod forge;
pub mod git;
pub mod logging;
pub mod instance;
pub mod journal;
pub mod graph;
pub mod hex;
pub mod history;
pub mod hunks;
pub mod in_progress;
pub mod links;
pub mod log;
pub mod message_refs;
pub mod netops;
pub mod open_copy;
pub mod ops;
pub mod openers;
pub mod paths;
pub mod payload;
pub mod platform;
pub mod random;
pub mod redact;
pub mod reflog;
pub mod refs;
pub mod remotes;
pub mod scan;
pub mod settings;
pub mod shelldata;
pub mod signature;
pub mod shellenv;
pub mod snapshot;
pub mod status;
pub mod tree;
pub mod updates;
pub mod walk;
pub mod watch;
pub mod worktree;
pub mod write;

#[cfg(any(test, feature = "testing"))]
pub mod testing;

/// Whether this build has the test-only API (the `testing` feature: `/test/*` routes, fixture
/// repositories). Only the harness turns it on, but a `cargo build --workspace` unifies it into
/// every crate there, `gitbolt-app` included; the app refuses to compile a release build with it.
pub const TESTING: bool = cfg!(feature = "testing");
