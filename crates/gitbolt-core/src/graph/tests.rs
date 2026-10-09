use super::*;
use gix::ObjectId;
use std::collections::HashMap;

/// `spec` rows are (name, parent names). Names starting with `wip`/`stash` set the node kind.
/// Parents not in `spec` become `Outside`.
/// A distinct id per outside parent name, so different outside parents never share a lane's
/// home, lock or takeover state.
fn outside_id(name: &str) -> ObjectId {
    let mut b = [0xAAu8; 20];
    for (i, c) in name.bytes().take(20).enumerate() {
        b[i] = c;
    }
    ObjectId::from_bytes_or_panic(&b)
}

/// Rows get descending committer times (row 0 newest), as in the real display order.
fn build(spec: &[(&str, &[&str])], pinned: &[&str]) -> Vec<LayoutNode> {
    build_pair(spec, pinned, &[])
}

/// `build` with a pinned pair: `pinned` in lane 0, `second` in lane 1.
fn build_pair(spec: &[(&str, &[&str])], pinned: &[&str], second: &[&str]) -> Vec<LayoutNode> {
    let index: HashMap<&str, usize> = spec.iter().enumerate().map(|(i, (n, _))| (*n, i)).collect();
    spec.iter()
        .enumerate()
        .map(|(row, (name, parents))| LayoutNode {
            parents: parents
                .iter()
                .map(|p| index.get(p).map(|&i| Parent::Row(i as u32)).unwrap_or_else(|| Parent::Outside(outside_id(p))))
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
            pinned: if pinned.contains(name) {
                Some(0)
            } else if second.contains(name) {
                Some(1)
            } else {
                None
            },
            time: (spec.len() - row) as i64,
        })
        .collect()
}

/// The pinned lanes' reservations (`layout`'s `reserved`): in these tests lane 0 is reserved
/// whenever any row is pinned to it (the app passes the pinned-ref choice instead), lane 1
/// through its chain's last row.
fn reserves_trunk(nodes: &[LayoutNode]) -> Vec<u32> {
    let mut reserved = Vec::new();
    if nodes.iter().any(|n| n.pinned == Some(0)) {
        reserved.push(u32::MAX);
        if let Some(last) = nodes.iter().rposition(|n| n.pinned == Some(1)) {
            reserved.push(last as u32);
        }
    }
    reserved
}

/// `layout()` plus a mandatory continuity check: no test may forget to verify that the
/// graph's lines never break or gap.
fn checked_layout(nodes: &[LayoutNode]) -> Layout {
    let l = layout(nodes, &reserves_trunk(nodes));
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

/// A diverged pinned pair: the local chain (`m1`) in lane 0, the remote's own commits (`o2`,
/// `o1`) in lane 1, both left of a newer branch `t`, which can't take lane 1 even above the
/// remote's tip. Below the remote's last commit lane 1 frees up: the tip `s` takes it.
#[test]
fn a_diverged_pair_pins_lanes_zero_and_one() {
    let spec: &[(&str, &[&str])] = &[("t", &["b"]), ("o2", &["o1"]), ("m1", &["b"]), ("o1", &["b"]), ("b", &["a"]), ("s", &["a"]), ("a", &[])];
    let nodes = build_pair(spec, &["m1", "b", "a"], &["o2", "o1"]);
    assert_eq!(reserves_trunk(&nodes), [u32::MAX, 3]);
    let l = checked_layout(&nodes);
    let lanes: Vec<u16> = l.rows.iter().map(|r| r.lane).collect();
    assert_eq!(lanes, [2, 1, 0, 1, 0, 1, 0]);
    assert_eq!(render(&l, &nodes, spec), "    *  t\n  * |  o2\n* | |  m1\n| * |  o1\n*-/-/  b in:1,2\n| *    s\n*-/    a in:1\n");
}

/// A pinned pair whose tips are one chain (behind or ahead): one pinned chain from the newer
/// tip, through the older one, all in lane 0; nothing is reserved past lane 0.
#[test]
fn a_pair_on_one_chain_shares_lane_zero() {
    let spec: &[(&str, &[&str])] = &[("f", &["o1"]), ("o2", &["o1"]), ("o1", &["m"]), ("m", &[])];
    let nodes = build(spec, &["o2", "o1", "m"]);
    assert_eq!(reserves_trunk(&nodes), [u32::MAX]);
    let lanes: Vec<u16> = checked_layout(&nodes).rows.iter().map(|r| r.lane).collect();
    assert_eq!(lanes, [1, 0, 0, 0]);
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

fn seg(from: u16, to: u16, half: Half) -> Segment {
    Segment { from_lane: from, to_lane: to, half, color: 0, dashed: false }
}

fn node(parents: Vec<Parent>) -> LayoutNode {
    LayoutNode { parents, kind: NodeKind::Commit, pinned: None, time: 0 }
}

#[test]
fn check_rejects_an_edge_that_lands_on_the_wrong_node() {
    // a's only parent is c (row 2), but its lane runs into b (row 1) instead. Every row
    // boundary matches, so only the per-edge rule can see it.
    let nodes = vec![node(vec![Parent::Row(2)]), node(vec![Parent::Outside(ObjectId::null(gix::hash::Kind::Sha1))]), node(vec![])];
    let lay = Layout {
        rows: vec![
            GraphRow { lane: 0, color: 0, segments: vec![seg(0, 0, Half::Bottom)] },
            GraphRow { lane: 0, color: 0, segments: vec![seg(0, 0, Half::Top), seg(0, 0, Half::Bottom)] },
            GraphRow { lane: 1, color: 1, segments: vec![seg(0, 0, Half::Full)] },
        ],
        max_lanes: 2,
    };
    let err = check_continuity(&lay, &nodes).expect_err("a's edge enters b, not its parent c");
    assert!(err.contains("row 0") && err.contains("parent row 2") && err.contains("row 1"), "{err}");
}

#[test]
fn check_rejects_an_outside_edge_that_enters_a_node() {
    let x = ObjectId::null(gix::hash::Kind::Sha1);
    let nodes = vec![node(vec![Parent::Outside(x)]), node(vec![Parent::Outside(x)])];
    let lay = Layout {
        rows: vec![
            GraphRow { lane: 0, color: 0, segments: vec![seg(0, 0, Half::Bottom)] },
            GraphRow { lane: 0, color: 0, segments: vec![seg(0, 0, Half::Top), seg(0, 0, Half::Bottom)] },
        ],
        max_lanes: 1,
    };
    let err = check_continuity(&lay, &nodes).expect_err("an Outside edge must not enter a node");
    assert!(err.contains("row 0") && err.contains("outside") && err.contains("row 1"), "{err}");
}

/// A tiny deterministic generator (Knuth's MMIX LCG), so the fuzz test needs no new dependency.
struct Lcg(u64);

impl Lcg {
    fn next(&mut self) -> u32 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        (self.0 >> 33) as u32
    }
    fn below(&mut self, n: u32) -> u32 {
        self.next() % n
    }
    fn chance(&mut self, percent: u32) -> bool {
        self.below(100) < percent
    }
}

/// A random history shaped like the ones `snapshot::assemble` builds: commits in display order
/// (every parent below its children) with merges, octopus merges, stashes (one parent, no
/// children), parents outside the window (a few shared ids, so lanes can share them), a pinned
/// first-parent chain from a random tip, the open worktree's WIP at row 0, and other WIP rows
/// stacked directly above their HEAD commit (the topmost WIP on the pinned tip pinned).
fn random_dag(seed: u64) -> Vec<LayoutNode> {
    let mut rng = Lcg(seed);
    let n = 1 + rng.below(40) as usize;
    let outside: Vec<ObjectId> = (0..3u8).map(|i| ObjectId::from_bytes_or_panic(&[i + 1; 20])).collect();
    let mut stash = vec![false; n];
    let mut parents: Vec<Vec<Parent>> = vec![Vec::new(); n];
    for i in (0..n).rev() {
        let below: Vec<usize> = (i + 1..n).filter(|&j| !stash[j]).collect();
        let count = match rng.below(100) {
            0..=4 => 0,
            5..=79 => 1,
            80..=93 => 2,
            _ => 3 + rng.below(2) as usize,
        };
        let mut ps: Vec<Parent> = Vec::new();
        for _ in 0..count {
            let p = if below.is_empty() || rng.chance(15) {
                Parent::Outside(outside[rng.below(3) as usize])
            } else {
                // Favor near parents, like real histories.
                let k = if rng.chance(60) { rng.below(below.len().min(4) as u32) } else { rng.below(below.len() as u32) };
                Parent::Row(below[k as usize] as u32)
            };
            if !ps.contains(&p) {
                ps.push(p);
            }
        }
        stash[i] = ps.len() == 1 && rng.chance(10);
        parents[i] = ps;
    }

    let mut pinned: Vec<Option<u16>> = vec![None; n];
    let tips: Vec<usize> = (0..n).filter(|&i| !stash[i]).collect();
    let tip = (!tips.is_empty() && rng.chance(70)).then(|| tips[rng.below(tips.len() as u32) as usize]);
    let mut cur = tip;
    while let Some(i) = cur {
        pinned[i] = Some(0);
        cur = match parents[i].first() {
            Some(Parent::Row(p)) => Some(*p as usize),
            _ => None,
        };
    }
    // Sometimes a diverged pair: a second tip off the trunk's chain pins its own first-parent
    // chain in lane 1, down to where it meets the trunk's.
    let off_trunk: Vec<usize> = tips.iter().copied().filter(|&i| pinned[i].is_none()).collect();
    let tip2 = (tip.is_some() && !off_trunk.is_empty() && rng.chance(50)).then(|| off_trunk[rng.below(off_trunk.len() as u32) as usize]);
    let mut cur = tip2;
    while let Some(i) = cur.filter(|&i| pinned[i].is_none()) {
        pinned[i] = Some(1);
        cur = match parents[i].first() {
            Some(Parent::Row(p)) => Some(*p as usize),
            _ => None,
        };
    }

    // The open worktree's WIP (sometimes) at row 0 on any commit, however far down; the other
    // worktrees' WIP rows docked directly above their HEAD commit. The topmost WIP on the pinned
    // tip is pinned.
    let current = (!tips.is_empty() && rng.chance(30)).then(|| tips[rng.below(tips.len() as u32) as usize]);
    let wips: Vec<usize> = (0..n).map(|i| if !stash[i] && rng.chance(8) { 1 + rng.below(2) as usize } else { 0 }).collect();
    let mut row_of = vec![0u32; n];
    let mut row = u32::from(current.is_some());
    for i in 0..n {
        row += wips[i] as u32;
        row_of[i] = row;
        row += 1;
    }
    let mut nodes = Vec::with_capacity(row as usize);
    let mut tip_wip_pinned = [false; 2];
    let mut wip_on = |i: usize, nodes: &mut Vec<LayoutNode>| {
        let lane = [tip, tip2].iter().position(|&t| t == Some(i)).filter(|&k| !tip_wip_pinned[k]);
        if let Some(k) = lane {
            tip_wip_pinned[k] = true;
        }
        nodes.push(LayoutNode { parents: vec![Parent::Row(row_of[i])], kind: NodeKind::Wip, pinned: lane.map(|k| k as u16), time: i64::MAX });
    };
    if let Some(c) = current {
        wip_on(c, &mut nodes);
    }
    for i in 0..n {
        for _ in 0..wips[i] {
            wip_on(i, &mut nodes);
        }
        let ps: Vec<Parent> = parents[i].iter().map(|p| match *p {
            Parent::Row(j) => Parent::Row(row_of[j as usize]),
            o => o,
        }).collect();
        let kind = if stash[i] { NodeKind::Stash } else if ps.len() > 1 { NodeKind::Merge } else { NodeKind::Commit };
        nodes.push(LayoutNode { parents: ps, kind, pinned: pinned[i], time: (n - i) as i64 });
    }
    nodes
}

#[test]
fn fuzz_random_dags_keep_every_line_continuous() {
    let mut kinds = [0usize; 4];
    let mut pinned_wip = 0usize;
    let mut pairs = 0usize;
    for seed in 1..=1000u64 {
        let nodes = random_dag(seed);
        for n in &nodes {
            kinds[n.kind as usize] += 1;
            pinned_wip += usize::from(n.pinned.is_some() && n.kind == NodeKind::Wip);
        }
        pairs += usize::from(nodes.iter().any(|n| n.pinned == Some(1)));
        let lay = layout(&nodes, &reserves_trunk(&nodes));
        if let Err(e) = check_continuity(&lay, &nodes) {
            panic!("seed {seed}: continuity violated: {e}");
        }
    }
    // The generator really exercises every node kind, pinned WIP rows and diverged pairs.
    assert!(kinds.iter().all(|&k| k > 0) && pinned_wip > 0, "node kinds generated: {kinds:?}, pinned WIP rows: {pinned_wip}");
    assert!(pairs > 100, "{pairs} diverged pairs");
}

// ---- K79: the column rule (home lane, lower-lane takeover, merge lock) ----

/// A commit lands in the lane of the first child that reached it, unless a later non-merge
/// first-parent child in a lower lane takes it over: `a` (lane 1) reaches `p` first, then `b`
/// (lane 0, freed by `y`) takes it over, so `p` lands in lane 0 and `a`'s lane curves in.
#[test]
fn a_lower_non_merge_first_parent_child_takes_over_the_home() {
    let spec: &[(&str, &[&str])] = &[("z", &["y"]), ("a", &["p"]), ("y", &[]), ("b", &["p"]), ("p", &[])];
    assert_eq!(ascii(spec, &[]), "*    z\n| *  a\n* |  y\n* |  b\n*-/  p in:1\n");
}

/// A merge never takes over a home: `f` (lane 1) reaches `t` first and the merge `m` (lane 0)
/// later. Before K79 `t` took the left-most waiting lane (0); now it stays in lane 1 and the
/// merge's line curves in from the left.
#[test]
fn a_merge_never_takes_over_its_first_parent() {
    let spec: &[(&str, &[&str])] = &[("z", &["y"]), ("f", &["t"]), ("y", &[]), ("m", &["t", "x"]), ("x", &["t"]), ("t", &[])];
    let nodes = build(spec, &[]);
    let l = checked_layout(&nodes);
    assert_eq!(l.rows[5].lane, 1, "t stays in the lane f reserved for it");
    insta::assert_snapshot!(render(&l, &nodes, spec));
}

/// A merge locks its parents: `m` (lane 1) claims `t` first, so the later fork `f` in lane 0
/// can't pull it left. This is the shape of the K79 screenshot: a trunk merge newer than the
/// branches forked under it.
#[test]
fn a_merge_child_locks_the_home_against_a_lower_fork() {
    let spec: &[(&str, &[&str])] = &[("o", &["q"]), ("m", &["t", "x"]), ("q", &[]), ("f", &["t"]), ("x", &["t"]), ("t", &[])];
    let nodes = build(spec, &[]);
    let l = checked_layout(&nodes);
    assert_eq!(l.rows[5].lane, 1, "t stays under its merge child m");
    assert_eq!(render(&l, &nodes, spec), "*      o\n| M-\\  m out:2\n* | |  q\n* | |  f\n| | *  x\n\\-*-/  t in:0,2\n");
}

/// A trunk of merges stays in one lane while the branches forked from each trunk commit come
/// and go on both sides of it.
#[test]
fn a_trunk_of_merges_stays_straight() {
    let spec: &[(&str, &[&str])] = &[
        ("z", &["y"]),
        ("m2", &["m1", "b2"]),
        ("y", &[]),
        ("f2", &["m1"]),
        ("b2", &["m1"]),
        ("m1", &["t", "b1"]),
        ("f1", &["t"]),
        ("b1", &["t"]),
        ("t", &[]),
    ];
    let nodes = build(spec, &[]);
    let l = checked_layout(&nodes);
    for r in [1, 5, 8] {
        assert_eq!(l.rows[r].lane, 1, "trunk row {r} ({}) stays in lane 1", spec[r].0);
    }
    insta::assert_snapshot!(render(&l, &nodes, spec));
}

/// The stash clause: a home set by a stash goes to a branch whose chain is newer than
/// the stash, even from a higher lane, so the branch's line stays straight.
#[test]
fn a_newer_branch_takes_a_commit_back_from_a_stash() {
    let spec: &[(&str, &[&str])] = &[("z", &["y"]), ("c2", &["c1"]), ("y", &[]), ("stash", &["p"]), ("c1", &["p"]), ("p", &[])];
    let l = checked_layout(&build(spec, &[]));
    assert_eq!(l.rows[3].lane, 0, "the stash sits in the freed lane 0");
    assert_eq!(l.rows[5].lane, 1, "p lands in the branch's lane, not the stash's");
}

/// A WIP row never takes over another commit's home (spec §8.6): `x` (lane 1) reaches `p`
/// first, the WIP docked on `p` sits in lane 0, and `p` stays in lane 1.
#[test]
fn a_wip_never_takes_over_a_home() {
    let spec: &[(&str, &[&str])] = &[("z", &["y"]), ("x", &["p"]), ("y", &[]), ("wip", &["p"]), ("p", &[])];
    let l = checked_layout(&build(spec, &[]));
    assert_eq!(l.rows[3].lane, 0);
    assert_eq!(l.rows[4].lane, 1, "p keeps the home x set");
}

/// A root commit frees its lane: `c` reuses lane 0.
#[test]
fn a_root_frees_its_lane_for_the_next_branch() {
    let spec: &[(&str, &[&str])] = &[("a", &["r"]), ("r", &[]), ("b", &["s"]), ("s", &[])];
    assert_eq!(ascii(spec, &[]), "*  a\n*  r\n*  b\n*  s\n");
}

/// Columns from the column rule, re-stated as a reference model with reservations and per-parent waiting
/// lists instead of a lane vector: a commit takes its reserved column, else the lowest free one;
/// a first-parent child in a lower column takes the reservation over unless a merge child has
/// locked it; a merge reserves new parents in the lowest free column. Plus the further rules:
/// a root frees its column, pinned rows in their pinned column (the others right of the
/// columns still reserved for pinned chains), a WIP row never takes a reservation over, and a
/// merge line never joins a dashed (WIP) waiting column.
fn reference_columns(nodes: &[LayoutNode], reserved: &[u32]) -> Vec<usize> {
    use std::collections::{HashMap, HashSet};
    #[derive(Clone, Copy)]
    struct Res {
        col: usize,
        stash: bool,
        newest: Option<i64>,
    }
    let take = |used: &mut HashSet<usize>, min: usize| {
        let c = (min..).find(|c| !used.contains(c)).unwrap();
        used.insert(c);
        c
    };
    let mut used = HashSet::new();
    let mut res: HashMap<Parent, Res> = HashMap::new();
    let mut waiters: HashMap<Parent, Vec<(usize, bool)>> = HashMap::new(); // (column, dashed)
    let mut merge_child: HashSet<Parent> = HashSet::new();
    let mut out = Vec::new();
    for (r, n) in nodes.iter().enumerate() {
        let me = Parent::Row(r as u32);
        let min = reserved.iter().take_while(|&&until| r as u32 <= until).count();
        for (c, _) in waiters.remove(&me).unwrap_or_default() {
            used.remove(&c);
        }
        let s = res.remove(&me);
        let col = match n.pinned {
            Some(k) => usize::from(k),
            None => s.map_or_else(|| take(&mut used, min), |s| s.col),
        };
        used.insert(col);
        let wip = n.kind == NodeKind::Wip;
        let stash = n.kind == NodeKind::Stash;
        for (k, &p) in n.parents.iter().enumerate() {
            if n.kind == NodeKind::Merge {
                merge_child.insert(p);
            }
            let w = waiters.entry(p).or_default();
            let line = if k == 0 {
                col
            } else if let Some(c) = res.get(&p).filter(|c| w.contains(&(c.col, false))) {
                c.col
            } else if let Some(&(c, _)) = w.iter().filter(|(_, dashed)| !dashed).min() {
                c
            } else {
                take(&mut used, min)
            };
            if !w.iter().any(|&(c, _)| c == line) {
                w.push((line, wip));
            }
            match res.get(&p).copied() {
                None => {
                    let newest = match s {
                        Some(s) if s.col == col => s.newest,
                        _ => Some(n.time),
                    };
                    res.insert(p, Res { col: line, stash, newest });
                }
                Some(c) if k == 0 && c.col != col && !wip && !merge_child.contains(&p) => {
                    let stash_steal = c.stash && !stash && matches!((s.and_then(|s| s.newest), c.newest), (Some(a), Some(b)) if a > b);
                    if c.col > col || stash_steal {
                        res.insert(p, Res { col, stash, newest: s.and_then(|s| s.newest) });
                    }
                }
                _ => {}
            }
        }
        if n.parents.is_empty() {
            used.remove(&col); // A root frees its column.
        }
        out.push(col);
    }
    out
}

/// Every commit lands in the column the reference model gives it, WIP rows and pinned trunks
/// included. Its seeds follow the continuity fuzz test's (`checked_layout` checks those too).
#[test]
fn columns_match_the_reference_model_on_random_histories() {
    let mut rows = 0;
    for seed in 1001..=2000u64 {
        let nodes = random_dag(seed);
        let l = checked_layout(&nodes);
        let lanes: Vec<usize> = l.rows.iter().map(|r| usize::from(r.lane)).collect();
        assert_eq!(lanes, reference_columns(&nodes, &reserves_trunk(&nodes)), "seed {seed}");
        rows += nodes.len();
    }
    assert!(rows > 10_000, "{rows} rows compared");
}

/// A stand-in id for a row beyond a window's end (what a commit-limited window sees there).
fn beyond(row: u32) -> ObjectId {
    let mut b = [0xEEu8; 20];
    b[..4].copy_from_slice(&row.to_le_bytes());
    ObjectId::from_bytes_or_panic(&b)
}

fn beyond_row(id: &ObjectId) -> Option<u32> {
    let b = id.as_bytes();
    (b[4..] == [0xEEu8; 16]).then(|| u32::from_le_bytes(b[..4].try_into().unwrap()))
}

/// Row `r` as a window ending at `end` sees it: parents at or past `end` are outside.
fn windowed(n: &LayoutNode, end: usize) -> LayoutNode {
    let parents = n.parents.iter().map(|p| match *p {
        Parent::Row(q) if q as usize >= end => Parent::Outside(beyond(q)),
        o => o,
    });
    LayoutNode { parents: parents.collect(), ..n.clone() }
}

/// `nodes` laid out `size` rows at a time from one `LayoutState`, as Load more would: each chunk
/// sees the parents past its end as outside, and before the next chunk the lanes waiting for
/// them are resolved to the now-loaded rows.
fn chunked(nodes: &[LayoutNode], size: usize) -> Vec<GraphRow> {
    let mut state = super::layout::LayoutState::new(&reserves_trunk(nodes));
    let mut rows = Vec::with_capacity(nodes.len());
    for start in (0..nodes.len()).step_by(size) {
        let end = (start + size).min(nodes.len());
        state.resolve_outside(|id| beyond_row(id).filter(|&r| (r as usize) < end));
        for (r, n) in nodes.iter().enumerate().take(end).skip(start) {
            rows.push(state.push(r as u32, &windowed(n, end)));
        }
    }
    rows
}

/// The continuation state is the lane vector: laying a history out in chunks of 1-9 rows (and
/// wave histories in larger chunks) gives exactly the single pass, homes, locks and all.
#[test]
fn chunked_layout_equals_the_single_pass() {
    for seed in 1..=1000u64 {
        let nodes = random_dag(seed);
        let whole = layout(&nodes, &reserves_trunk(&nodes)).rows;
        for size in 1..=9 {
            assert_eq!(chunked(&nodes, size), whole, "seed {seed}, chunks of {size}");
        }
    }
    for seed in 1..=10u64 {
        let nodes = wave_history(seed, 30);
        let whole = layout(&nodes, &[]).rows;
        for size in [1, 7, 50, 333] {
            assert_eq!(chunked(&nodes, size), whole, "wave seed {seed}, chunks of {size}");
        }
    }
}

/// With the trunk reservation passed in from the pinned-ref choice, a window cut at any row lays
/// out as the prefix of the whole history, even when the cut is above the pinned chain.
#[test]
fn a_truncated_window_is_the_prefix_of_the_whole() {
    let mut cut_above_pin = 0;
    for seed in 1..=1000u64 {
        let nodes = random_dag(seed);
        let reserve = reserves_trunk(&nodes);
        let whole = layout(&nodes, &reserve).rows;
        for k in 1..nodes.len() {
            let window: Vec<LayoutNode> = nodes[..k].iter().map(|n| windowed(n, k)).collect();
            cut_above_pin += usize::from(!reserve.is_empty() && reserves_trunk(&window).is_empty());
            assert_eq!(layout(&window, &reserve).rows[..], whole[..k], "seed {seed}, cut at {k}");
        }
    }
    assert!(cut_above_pin > 1000, "{cut_above_pin} cuts above the pinned chain");
}

/// The stash clause needs a newer chain: a branch whose chain is older than the stash leaves
/// `p` in the stash's lane.
#[test]
fn an_older_branch_leaves_a_commit_with_its_stash() {
    let spec: &[(&str, &[&str])] = &[("z", &["y"]), ("c2", &["c1"]), ("y", &[]), ("stash", &["p"]), ("c1", &["p"]), ("p", &[])];
    let mut nodes = build(spec, &[]);
    nodes[1].time = 0; // c2's chain is older than the stash (clock skew)
    let l = checked_layout(&nodes);
    assert_eq!(l.rows[3].lane, 0);
    assert_eq!(l.rows[5].lane, 0, "p stays in the stash's lane");
}

/// A merge child locks the stash's home too: the newer branch can't take `p` back.
#[test]
fn a_merge_child_blocks_the_stash_takeover() {
    let spec: &[(&str, &[&str])] = &[("z", &["y"]), ("c2", &["c1"]), ("y", &[]), ("stash", &["p"]), ("m", &["q", "p"]), ("c1", &["p"]), ("p", &[])];
    let l = checked_layout(&build(spec, &[]));
    assert_eq!(l.rows[3].lane, 0);
    assert_eq!(l.rows[6].lane, 0, "the merge locked p in the stash's lane");
}

/// Crossings: a Top or Bottom curve passing over a straight lane strictly between its ends.
fn crossings(l: &Layout) -> usize {
    l.rows
        .iter()
        .map(|row| {
            let fulls: Vec<u16> = row.segments.iter().filter(|s| s.half == Half::Full).map(|s| s.from_lane).collect();
            row.segments
                .iter()
                .filter(|s| s.half != Half::Full && s.from_lane != s.to_lane)
                .map(|s| fulls.iter().filter(|&&f| f > s.from_lane.min(s.to_lane) && f < s.from_lane.max(s.to_lane)).count())
                .sum::<usize>()
        })
        .sum()
}

/// A merge-heavy history like this repo's own: waves of 2-5 branches forked from the trunk's
/// tip, committed at interleaved times, then merged one by one into the trunk, with now and then
/// a plain trunk commit, plus a few open branches forked long ago and committed to last. Rows
/// are in committer-time order (every parent older than its child).
fn wave_history(seed: u64, waves: usize) -> Vec<LayoutNode> {
    let mut rng = Lcg(seed);
    let mut commits: Vec<(i64, Vec<usize>)> = vec![(0, vec![])]; // (time, parent ids); id = index
    let mut trunk = 0usize;
    let mut now = 0i64;
    let mut forks = Vec::new(); // trunk commits that open, still-unmerged branches fork from
    for wave in 0..waves {
        if wave % 8 == 4 {
            forks.push(trunk);
        }
        let (base, start) = (trunk, now);
        let mut tips = Vec::new();
        for _ in 0..2 + rng.below(4) {
            let mut tip = base;
            let mut t = start + 1 + i64::from(rng.below(20));
            for _ in 0..2 + rng.below(5) {
                commits.push((t, vec![tip]));
                tip = commits.len() - 1;
                t += 1 + i64::from(rng.below(15));
            }
            now = now.max(t);
            tips.push((t, tip));
        }
        tips.sort();
        for (_, tip) in tips {
            now += 1 + i64::from(rng.below(5));
            if rng.chance(20) {
                commits.push((now, vec![trunk]));
                trunk = commits.len() - 1;
                now += 1;
            }
            commits.push((now, vec![trunk, tip]));
            trunk = commits.len() - 1;
        }
    }
    // Open branches, newest of all, so their tips sit at the top in the left-most lanes (like
    // the lanes of a project in flight) and their lanes free up far down the history.
    for base in forks {
        let mut tip = base;
        for _ in 0..1 + rng.below(3) {
            now += 1;
            commits.push((now, vec![tip]));
            tip = commits.len() - 1;
        }
    }
    let mut order: Vec<usize> = (0..commits.len()).collect();
    order.sort_by_key(|&i| (std::cmp::Reverse(commits[i].0), std::cmp::Reverse(i)));
    let mut row_of = vec![0u32; commits.len()];
    for (r, &i) in order.iter().enumerate() {
        row_of[i] = r as u32;
    }
    order
        .iter()
        .map(|&i| {
            let parents: Vec<Parent> = commits[i].1.iter().map(|&p| Parent::Row(row_of[p])).collect();
            let kind = if parents.len() > 1 { NodeKind::Merge } else { NodeKind::Commit };
            LayoutNode { parents, kind, pinned: None, time: commits[i].0 }
        })
        .collect()
}

/// K79's point: on a merge-heavy history the trunk keeps its lane, so fewer curves cross lanes,
/// with no more lanes than before. The pre-K79 layout (left-most waiting lane) gave 8634
/// crossings and 185 summed max lanes on the same 20 histories.
#[test]
fn wave_history_crossings_regression() {
    let mut total = (0usize, 0usize);
    for seed in 1..=20u64 {
        let l = checked_layout(&wave_history(seed, 30));
        total.0 += crossings(&l);
        total.1 += usize::from(l.max_lanes);
    }
    assert_eq!(total, (7941, 185), "(crossings, summed max lanes) over 20 synthetic histories");
}
