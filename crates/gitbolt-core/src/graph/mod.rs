//! The commit graph's lane layout.

mod ascii;
#[cfg(any(test, feature = "testing"))]
mod check;
mod layout;

pub use ascii::{render_ascii, AsciiRow};
#[cfg(any(test, feature = "testing"))]
pub use check::check_continuity;
pub use layout::{layout, GraphRow, Half, Layout, LayoutNode, NodeKind, Parent, Segment, LANE_COLORS};

#[cfg(test)]
mod tests;
