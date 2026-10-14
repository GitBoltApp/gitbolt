//! The commit graph's pure pipeline (website demo spec §4.2): from plain data (the walked commits,
//! the refs, the worktrees and their WIP) to `GraphPayload`. No git access and no I/O: gitvolt-core
//! feeds it what gix reads, and the website demo (through gitvolt-graph-wasm) what isomorphic-git
//! reads, so both lay a repository out identically.

mod ascii;
mod assemble;
#[cfg(any(test, feature = "testing"))]
mod check;
mod input;
mod labels;
pub mod layout;
mod message;
mod message_refs;
mod oid;
mod payload;
mod pins;
mod walk;

pub use ascii::{render_ascii, AsciiRow};
pub use assemble::{assemble, build, graph_tips, walk_order};
#[cfg(any(test, feature = "testing"))]
pub use check::check_continuity;
pub use input::{CommitIn, ForkFacts, GraphInput, GraphRequest, HeadIn, RefIn, RefKind, RefsIn, StashIn, WorktreeIn};
pub use layout::{layout, GraphRow, Half, Layout, LayoutNode, LayoutState, NodeKind, Parent, Segment, LANE_COLORS};
pub use message::split_message;
pub use message_refs::{parse_message_refs, MAX_MESSAGE_REFS};
pub use oid::Oid;
pub use payload::{ForkDetection, ForkPayload, GraphPayload, GraphWorktree, HeadPayload, HostKind, InProgress, RefLabel, RemoteRefLabel, RowPayload, TagAnnotation, WipCounts, WipPayload};
pub use walk::{walk, walk_by_date, CommitMeta, WalkOptions, WalkResult};
