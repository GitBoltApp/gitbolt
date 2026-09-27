use super::*;
use gix::ObjectId;
use std::collections::HashMap;

/// `spec` rows are (name, parent names). Names starting with `wip`/`stash` set the node kind.
/// Parents not in `spec` become `Outside`.
fn build(spec: &[(&str, &[&str])], pinned: &[&str]) -> Vec<LayoutNode> {
    let index: HashMap<&str, usize> = spec.iter().enumerate().map(|(i, (n, _))| (*n, i)).collect();
    spec.iter()
        .map(|(name, parents)| LayoutNode {
            parents: parents
                .iter()
                .map(|p| index.get(p).map(|&i| Parent::Row(i as u32)).unwrap_or(Parent::Outside(ObjectId::null(gix::hash::Kind::Sha1))))
                .collect(),
            kind: if name.starts_with("wip") {
                NodeKind::Wip
            } else if name.starts_with("stash") {
                NodeKind::Stash
            } else if parents.len() > 1 {
                NodeKind::Merge
            } else {
                NodeKind::Commit
            },
            pinned: pinned.contains(name),
        })
        .collect()
}

/// `layout()` plus a mandatory continuity check: no test may forget to verify that the
/// graph's lines never break or gap.
fn checked_layout(nodes: &[LayoutNode]) -> Layout {
    let l = layout(nodes);
    if let Err(e) = check_continuity(&l, nodes) {
        panic!("continuity violated: {e}");
    }
    l
}

fn ascii(spec: &[(&str, &[&str])], pinned: &[&str]) -> String {
    let nodes = build(spec, pinned);
    let l = checked_layout(&nodes);
    let rows: Vec<AsciiRow> = l
        .rows
        .iter()
        .zip(&nodes)
        .zip(spec)
        .map(|((r, n), (name, _))| AsciiRow { lane: r.lane, kind: n.kind, segments: &r.segments, label: name })
        .collect();
    render_ascii(&rows, l.max_lanes)
}

#[test]
fn linear_history_uses_one_lane() {
    let out = ascii(&[("c3", &["c2"]), ("c2", &["c1"]), ("c1", &[])], &[]);
    assert_eq!(out, "*  c3\n*  c2\n*  c1\n");
}

#[test]
fn pinned_trunk_with_merged_feature() {
    // Row-by-row derivation of the curve rendering (lane L is the node's own lane):
    // row0 `m`  (L=0): lane1 has only a Bottom to 1 (branch-out) -> '\', i>L so span [0,1) dashes the gap -> "M-\"; out:1.
    // row1 `f1` (L=1): lane0 has a Full (straight) -> '|'; no non-straight segments -> "| *".
    // row2 `c2` (L=0): lane1 has a Full (straight) -> '|'; no non-straight segments -> "* |".
    // row3 `c1` (L=0): lane1 has only a Top from 1 (merge-in) -> '/', i>L so span [0,1) dashes the gap -> "*-/"; in:1.
    let spec: &[(&str, &[&str])] = &[("m", &["c2", "f1"]), ("f1", &["c1"]), ("c2", &["c1"]), ("c1", &[])];
    let out = ascii(spec, &["m", "c2", "c1"]);
    assert_eq!(out, "M-\\  m out:1\n| *  f1\n* |  c2\n*-/  c1 in:1\n");
}

#[test]
fn parallel_branches_merge_into_common_ancestor() {
    // Only the last row has a non-straight segment (`e`'s Top-in from lane1, a merge curve),
    // so it is the only row whose grid gains a curve: row-by-row, rows 0-3 are all straight
    // ('|' or blank) exactly as before; row4 `e` (L=0): lane1 has only a Top from 1 -> '/',
    // dashing the gap between lanes 0 and 1 -> "*-/"; in:1.
    let spec: &[(&str, &[&str])] = &[("a", &["c"]), ("b", &["d"]), ("c", &["e"]), ("d", &["e"]), ("e", &[])];
    assert_eq!(ascii(spec, &[]), "*    a\n| *  b\n* |  c\n| *  d\n*-/  e in:1\n");
}

fn render(l: &Layout, nodes: &[LayoutNode], spec: &[(&str, &[&str])]) -> String {
    let rows: Vec<AsciiRow> = l
        .rows
        .iter()
        .zip(nodes)
        .zip(spec)
        .map(|((r, n), (name, _))| AsciiRow { lane: r.lane, kind: n.kind, segments: &r.segments, label: name })
        .collect();
    render_ascii(&rows, l.max_lanes)
}

/// A genuinely interleaved history: `b`'s fork-lane (1) frees at `c` while `e`'s fork-lane
/// (2), opened one row earlier, is still open (waiting on `f`, not yet reached). Because the
/// trailing-`None` trim only pops from the *end* of the lane array, lane 2 being still open
/// blocks the pop and lane 1 survives as a genuine hole in the middle — which `g` then
/// reuses. (A sequential case, where the freed lane is always the rightmost one, would let
/// the trim shrink it away and never require reuse logic at all.)
///
/// Row-by-row trace: `a`(L0,parent d) opens lane0 straight to d. `b`(L1,parent c) opens
/// lane1. `e`(L2,parent f) opens lane2. `c`(L1, root) closes lane1 — a hole, since lane2
/// is still open. `g`(L1,parent d) reuses the lane1 hole. `f`(L2, root) closes lane2. `d`
/// (L0, root) receives two merge-ins: a straight one from `a` (lane0) and a curve from `g`
/// (lane1) — the only non-straight segment in the whole trace, giving `d`'s row its lone
/// curve; every other row is straight `|`/blank.
#[test]
fn interleaved_hole_reuse() {
    let spec: &[(&str, &[&str])] =
        &[("a", &["d"]), ("b", &["c"]), ("e", &["f"]), ("c", &[]), ("g", &["d"]), ("f", &[]), ("d", &[])];
    let nodes = build(spec, &[]);
    let l = checked_layout(&nodes);

    assert_eq!(l.rows[4].lane, 1, "g reuses the lane b freed at c, while e's lane was still open");
    assert_eq!(l.rows[0].lane, 0, "a");
    assert_eq!(l.rows[6].lane, 0, "d");
    assert_eq!(l.max_lanes, 3, "three lanes are simultaneously open at e's/c's row");

    assert_eq!(
        render(&l, &nodes, spec),
        "*      a\n| *    b\n| | *  e\n| * |  c\n| * |  g\n| | *  f\n*-/    d in:1\n"
    );
}

/// The same interleaved shape, but with the trunk root `d` pinned. Lane 0 is now reserved
/// for the trunk from the very first row, so every lane number shifts up by one (`a` opens
/// on lane1, not lane0) — but the hole-reuse mechanic is unaffected: `b`'s lane (now 2)
/// frees at `c` while `e`'s lane (now 3) is still open, and `g` reuses lane 2.
#[test]
fn interleaved_hole_reuse_with_pinned_trunk() {
    let spec: &[(&str, &[&str])] =
        &[("a", &["d"]), ("b", &["c"]), ("e", &["f"]), ("c", &[]), ("g", &["d"]), ("f", &[]), ("d", &[])];
    let nodes = build(spec, &["d"]);
    let l = checked_layout(&nodes);

    assert_eq!(l.rows[0].lane, 1, "lane 0 is reserved for the pinned trunk, so a starts on lane 1");
    assert_eq!(l.rows[4].lane, 2, "g reuses the lane b freed at c, shifted up by the reserved lane 0");
    assert_eq!(l.rows[6].lane, 0, "the pinned trunk root d is forced onto lane 0");
    assert_eq!(l.max_lanes, 4, "one more lane than the unpinned case, for the reserved trunk lane");
}

#[test]
fn freed_lanes_are_reused() {
    let spec: &[(&str, &[&str])] = &[("a", &["b"]), ("b", &[]), ("c", &["d"]), ("d", &[])];
    assert_eq!(ascii(spec, &[]), "*  a\n*  b\n*  c\n*  d\n");
}

#[test]
fn pinned_commits_own_lane_zero_even_when_a_feature_is_newer() {
    let spec: &[(&str, &[&str])] = &[("f2", &["f1"]), ("t2", &["t1"]), ("f1", &["t1"]), ("t1", &[])];
    let nodes = build(spec, &["t2", "t1"]);
    let l = checked_layout(&nodes);
    assert_eq!(l.rows[1].lane, 0);
    assert_eq!(l.rows[3].lane, 0);
    assert_ne!(l.rows[0].lane, 0, "unpinned tip must never take lane 0 when a trunk is pinned");
    assert_ne!(l.rows[2].lane, 0);
}

#[test]
fn wip_segments_are_dashed_until_the_head_commit() {
    let spec: &[(&str, &[&str])] = &[("wip", &["h"]), ("x", &["h"]), ("h", &[])];
    let l = checked_layout(&build(spec, &[]));
    assert!(l.rows[0].segments.iter().all(|s| s.dashed));
    let through = l.rows[1].segments.iter().find(|s| s.half == Half::Full).expect("wip lane passes row 1");
    assert!(through.dashed);
    let into_head = l.rows[2].segments.iter().filter(|s| s.half == Half::Top && s.dashed).count();
    assert_eq!(into_head, 1);
}

/// `m`'s second parent (`h`) would, without the fix, find the WIP's dashed lane already
/// waiting on `h` and land its solid Bottom segment there — a solid merge line silently
/// sharing a dashed WIP lane. The layout must instead open a separate lane for it, so the
/// two converge at `h` via separate Top curves (one dashed, one solid).
#[test]
fn merge_second_parent_avoids_wip_dashed_lane() {
    let spec: &[(&str, &[&str])] = &[("wip", &["h"]), ("m", &["x", "h"]), ("x", &["h"]), ("h", &[])];
    let l = checked_layout(&build(spec, &[]));

    assert!(l.rows[0].segments.iter().all(|s| s.dashed), "wip's own outgoing segment is dashed");
    let wip_lane = l.rows[0].lane;

    let m_bottoms: Vec<_> = l.rows[1].segments.iter().filter(|s| s.half == Half::Bottom).collect();
    assert_eq!(m_bottoms.len(), 2, "m has two parents, so two Bottom segments");
    assert!(m_bottoms.iter().all(|s| !s.dashed), "a solid merge line never inherits the WIP's dash");
    assert!(m_bottoms.iter().all(|s| s.to_lane != wip_lane), "m's parents must not land on the WIP's own lane");

    // h's row: three separate Top curves converge (one dashed, from the WIP; two solid).
    let h_tops: Vec<_> = l.rows[3].segments.iter().filter(|s| s.half == Half::Top).collect();
    assert_eq!(h_tops.len(), 3);
    assert_eq!(h_tops.iter().filter(|s| s.dashed).count(), 1, "only the WIP's line into h is dashed");
}

#[test]
fn outside_parents_run_to_the_bottom() {
    let spec: &[(&str, &[&str])] = &[("a", &["missing"]), ("b", &[])];
    let l = checked_layout(&build(spec, &[]));
    assert!(l.rows[1].segments.iter().any(|s| s.half == Half::Full && s.from_lane == 0), "lane of `a` continues past `b`");
    assert_eq!(l.rows[1].lane, 1);
}

#[test]
fn colors_follow_lanes() {
    let spec: &[(&str, &[&str])] = &[("a", &["c"]), ("b", &["c"]), ("c", &[])];
    let l = checked_layout(&build(spec, &[]));
    assert_eq!(l.rows[1].lane, 1);
    assert_eq!(l.rows[1].color, 1);
    let merge_in = l.rows[2].segments.iter().find(|s| s.half == Half::Top && s.from_lane == 1).unwrap();
    assert_eq!(merge_in.color, 1, "merge-in curve keeps the color of the lane it comes from");
}

#[test]
fn bottom_out_colour_matches_target_lane() {
    let spec: &[(&str, &[&str])] = &[("m", &["c2", "f1"]), ("f1", &["c1"]), ("c2", &["c1"]), ("c1", &[])];
    let l = checked_layout(&build(spec, &["m", "c2", "c1"]));
    let branch_out = l.rows[0]
        .segments
        .iter()
        .find(|s| s.half == Half::Bottom && s.from_lane != s.to_lane)
        .expect("m branches out into f1's lane");
    assert_eq!(branch_out.color, (branch_out.to_lane as u8) % LANE_COLORS, "branch-out colour follows its target lane");
}

#[test]
fn pack_roundtrip() {
    let s = Segment { from_lane: 1023, to_lane: 7, half: Half::Full, color: 9, dashed: true };
    assert_eq!(Segment::unpack(s.pack()), s);
    let t = Segment { from_lane: 0, to_lane: 0, half: Half::Top, color: 0, dashed: false };
    assert_eq!(t.pack(), 0);
}

#[test]
fn pack_golden_values() {
    let s = Segment { from_lane: 1, to_lane: 2, half: Half::Bottom, color: 3, dashed: true };
    assert_eq!(s.pack(), 1 | 2 << 10 | 1 << 20 | 3 << 22 | 1 << 26);
    assert_eq!(s.pack(), 0x04d00801, "Task 11's TS decoder test reuses this literal");

    let clamped = Segment { from_lane: 2000, to_lane: 0, half: Half::Top, color: 0, dashed: false };
    assert_eq!(Segment::unpack(clamped.pack()).from_lane, 1023, "from_lane is clamped to the 10-bit field's max");

    let masked = Segment { from_lane: 0, to_lane: 0, half: Half::Top, color: 0x1f, dashed: false };
    assert_eq!(Segment::unpack(masked.pack()).color, 0xf, "color is masked to its 4-bit field");
}

#[test]
fn snapshot_criss_cross_octopus_stash_and_wip() {
    let spec: &[(&str, &[&str])] = &[
        ("wip", &["m2"]),
        ("stash", &["m2"]),
        ("m2", &["t3", "b2"]),
        ("o", &["t3", "a1", "b1"]),
        ("t3", &["t2"]),
        ("b2", &["a1", "b1"]),
        ("a1", &["t2"]),
        ("b1", &["t2"]),
        ("t2", &["t1"]),
        ("t1", &["root-parent-outside"]),
    ];
    insta::assert_snapshot!(ascii(spec, &["m2", "t3", "t2", "t1"]));
}
