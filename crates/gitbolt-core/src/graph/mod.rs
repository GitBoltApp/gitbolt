//! The commit graph's lane layout: `gitbolt_graph`'s (crates/gitbolt-graph), re-exported, and the
//! conversions between gix's object ids and its own.

pub use gitbolt_graph::layout;
#[cfg(any(test, feature = "testing"))]
pub use gitbolt_graph::check_continuity;
pub use gitbolt_graph::{render_ascii, AsciiRow, GraphRow, Half, Layout, LayoutNode, NodeKind, Oid, Parent, Segment, LANE_COLORS};

/// gix's id as the graph crate's (SHA-1 only, as this gix build).
pub fn to_oid(id: gix::ObjectId) -> Oid {
    Oid::from_bytes_or_panic(id.as_bytes())
}

/// The graph crate's id as gix's.
pub fn to_gix(id: Oid) -> gix::ObjectId {
    gix::ObjectId::from_bytes_or_panic(&id.0)
}

#[cfg(test)]
mod tests;
