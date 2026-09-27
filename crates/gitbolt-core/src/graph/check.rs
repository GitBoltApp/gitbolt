//! Validates that a `Layout` never breaks or gaps a line: every lane that exits a row must
//! be exactly the lane that enters the next, with a matching dash state, except for a lane
//! whose parent lies outside the loaded window — that one legitimately runs off the bottom.
//! It also follows every parent edge down its lane and checks that it ends in exactly that
//! parent's node (or, for an outside parent, runs off the bottom without entering any node).

use super::layout::{GraphRow, Half, Layout, LayoutNode, Parent, Segment};
use std::collections::{HashMap, HashSet};

/// Checks that `layout`'s segments form unbroken lines from top to bottom.
///
/// Returns `Err` naming the row, lane and rule that failed on the first violation found.
pub fn check_continuity(layout: &Layout, nodes: &[LayoutNode]) -> Result<(), String> {
    if layout.rows.len() != nodes.len() {
        return Err(format!("row count {} does not match node count {}", layout.rows.len(), nodes.len()));
    }

    for (r, row) in layout.rows.iter().enumerate() {
        let l = row.lane;
        if l >= layout.max_lanes {
            return Err(format!("row {r}: node lane {l} is not < max_lanes {}", layout.max_lanes));
        }
        for s in &row.segments {
            for lane in [s.from_lane, s.to_lane] {
                if lane >= layout.max_lanes {
                    return Err(format!("row {r}: segment lane {lane} is not < max_lanes {}", layout.max_lanes));
                }
            }
            match s.half {
                Half::Top if s.to_lane != l => {
                    return Err(format!("row {r} lane {}: Top segment must land on the node's own lane {l}", s.to_lane));
                }
                Half::Bottom if s.from_lane != l => {
                    return Err(format!("row {r} lane {}: Bottom segment must originate at the node's own lane {l}", s.from_lane));
                }
                Half::Full if s.from_lane != s.to_lane => {
                    return Err(format!(
                        "row {r}: Full segment must have from_lane == to_lane (got {} -> {})",
                        s.from_lane, s.to_lane
                    ));
                }
                _ => {}
            }
        }

        let has_bottom = row.segments.iter().any(|s| s.half == Half::Bottom);
        if nodes[r].parents.is_empty() && has_bottom {
            return Err(format!("row {r} lane {l}: node has no parents but emits a Bottom segment"));
        }
        if !nodes[r].parents.is_empty() && !has_bottom {
            return Err(format!("row {r} lane {l}: node has parents but emits no Bottom segment"));
        }
    }

    // Builds a lane -> dashed map for a row's exit (or enter) set, erroring out instead of
    // silently overwriting when two segments disagree on a lane's dash state — that's the
    // same bug class as a solid merge line quietly landing on a dashed WIP lane.
    fn boundary_map(r: usize, side: &str, entries: impl Iterator<Item = (u16, bool)>) -> Result<HashMap<u16, bool>, String> {
        let mut m = HashMap::new();
        for (lane, dashed) in entries {
            match m.get(&lane) {
                Some(&existing) if existing != dashed => {
                    return Err(format!("row {r} lane {lane}: conflicting dash state in the {side} set (one segment dashed, another solid)"));
                }
                _ => {
                    m.insert(lane, dashed);
                }
            }
        }
        Ok(m)
    }
    // exit(r): lanes that leave the bottom of row r (branch-outs and straight pass-throughs).
    fn exit_of(r: usize, row: &GraphRow) -> Result<HashMap<u16, bool>, String> {
        boundary_map(
            r,
            "exit",
            row.segments.iter().filter_map(|s| match s.half {
                Half::Bottom => Some((s.to_lane, s.dashed)),
                Half::Full => Some((s.from_lane, s.dashed)),
                Half::Top => None,
            }),
        )
    }
    // enter(r): lanes that arrive at the top of row r (merge-ins and straight pass-throughs).
    fn enter_of(r: usize, row: &GraphRow) -> Result<HashMap<u16, bool>, String> {
        boundary_map(
            r,
            "enter",
            row.segments.iter().filter_map(|s| match s.half {
                Half::Top => Some((s.from_lane, s.dashed)),
                Half::Full => Some((s.from_lane, s.dashed)),
                Half::Bottom => None,
            }),
        )
    }

    let mut exits = Vec::with_capacity(layout.rows.len());
    let mut enters = Vec::with_capacity(layout.rows.len());
    for (r, row) in layout.rows.iter().enumerate() {
        exits.push(exit_of(r, row)?);
        enters.push(enter_of(r, row)?);
    }

    if let Some(enter0) = enters.first()
        && !enter0.is_empty()
    {
        return Err("row 0: enter set must be empty (nothing may flow into the top of the window)".to_string());
    }

    for r in 0..layout.rows.len().saturating_sub(1) {
        let exit = &exits[r];
        let enter = &enters[r + 1];
        let exit_lanes: HashSet<u16> = exit.keys().copied().collect();
        let enter_lanes: HashSet<u16> = enter.keys().copied().collect();
        if exit_lanes != enter_lanes {
            let mut e: Vec<_> = exit_lanes.iter().copied().collect();
            e.sort_unstable();
            let mut n: Vec<_> = enter_lanes.iter().copied().collect();
            n.sort_unstable();
            return Err(format!("row {r} -> {}: exit lanes {e:?} do not match enter lanes {n:?} (a line broke or gapped)", r + 1));
        }
        for (&lane, &dashed) in exit {
            if enter.get(&lane) != Some(&dashed) {
                return Err(format!("row {r} -> {}: lane {lane} changes dash state across the row boundary", r + 1));
            }
        }
    }

    // Per edge: every Bottom segment is one parent edge (in parent order). Following its lane
    // down must reach the parent's own row and nothing else: a Top into the node at exactly
    // that row. An `Outside` parent's lane must instead run to the last row without entering
    // any node. The boundary checks above only prove the lines are unbroken; this proves each
    // line ends at the right commit.
    //
    // One top-down sweep (linear in the segment count, so it stays cheap on a real repo's long
    // lanes): `open[lane]` holds the edges currently travelling down that lane, as
    // (origin row, parent). Several edges can share a lane when they wait on the same parent.
    let mut open: HashMap<u16, Vec<(usize, Parent)>> = HashMap::new();
    for (q, row) in layout.rows.iter().enumerate() {
        let tops: HashSet<u16> = row.segments.iter().filter(|s| s.half == Half::Top).map(|s| s.from_lane).collect();
        let fulls: HashSet<u16> = row.segments.iter().filter(|s| s.half == Half::Full).map(|s| s.from_lane).collect();
        let mut arrived = Vec::new();
        for (&lane, edges) in &open {
            if tops.contains(&lane) {
                for &(r, parent) in edges {
                    match parent {
                        Parent::Row(p) if p as usize == q => {}
                        Parent::Row(p) => return Err(format!("row {r}: the edge to parent row {p} on lane {lane} enters the node at row {q} instead")),
                        Parent::Outside(_) => return Err(format!("row {r}: the edge to an outside parent on lane {lane} enters the node at row {q}")),
                    }
                }
                arrived.push(lane);
            } else if !fulls.contains(&lane) {
                let (r, _) = edges[0];
                return Err(format!("row {r}: the edge on lane {lane} stops at row {q} without reaching its parent"));
            }
        }
        for lane in arrived {
            open.remove(&lane);
        }

        let bottoms: Vec<&Segment> = row.segments.iter().filter(|s| s.half == Half::Bottom).collect();
        if bottoms.len() != nodes[q].parents.len() {
            return Err(format!("row {q}: {} Bottom segments but {} parents", bottoms.len(), nodes[q].parents.len()));
        }
        for (&parent, seg) in nodes[q].parents.iter().zip(bottoms) {
            open.entry(seg.to_lane).or_default().push((q, parent));
        }
    }
    for (lane, edges) in &open {
        for &(r, parent) in edges {
            if let Parent::Row(p) = parent {
                return Err(format!("row {r}: the edge to parent row {p} on lane {lane} runs off the bottom of the window"));
            }
        }
    }

    Ok(())
}
