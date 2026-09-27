use gix::ObjectId;
use serde::Serialize;
use ts_rs::TS;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum NodeKind {
    Commit,
    Merge,
    Stash,
    Wip,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Parent {
    Row(u32),
    Outside(ObjectId),
}

#[derive(Debug, Clone)]
pub struct LayoutNode {
    pub parents: Vec<Parent>,
    pub kind: NodeKind,
    pub pinned: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Half {
    Top = 0,
    Bottom = 1,
    Full = 2,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Segment {
    pub from_lane: u16,
    pub to_lane: u16,
    pub half: Half,
    pub color: u8,
    pub dashed: bool,
}

const MAX_PACKED_LANE: u16 = 1023;
pub const LANE_COLORS: u8 = 10;

impl Segment {
    pub fn pack(self) -> u32 {
        let from = u32::from(self.from_lane.min(MAX_PACKED_LANE));
        let to = u32::from(self.to_lane.min(MAX_PACKED_LANE));
        from | (to << 10) | ((self.half as u32) << 20) | (u32::from(self.color & 0xf) << 22) | (u32::from(self.dashed) << 26)
    }

    pub fn unpack(v: u32) -> Self {
        let half = match (v >> 20) & 0x3 {
            0 => Half::Top,
            1 => Half::Bottom,
            _ => Half::Full,
        };
        Segment {
            from_lane: (v & 0x3ff) as u16,
            to_lane: ((v >> 10) & 0x3ff) as u16,
            half,
            color: ((v >> 22) & 0xf) as u8,
            dashed: (v >> 26) & 1 == 1,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GraphRow {
    pub lane: u16,
    pub color: u8,
    pub segments: Vec<Segment>,
}

#[derive(Debug, Clone)]
pub struct Layout {
    pub rows: Vec<GraphRow>,
    pub max_lanes: u16,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Wait {
    Row(u32),
    Outside(ObjectId),
}

#[derive(Clone, Copy)]
struct Lane {
    wait: Wait,
    dashed: bool,
}

fn color_of(lane: usize) -> u8 {
    (lane % usize::from(LANE_COLORS)) as u8
}

fn first_free(lanes: &[Option<Lane>], min: usize) -> usize {
    (min..lanes.len()).find(|&i| lanes[i].is_none()).unwrap_or(lanes.len().max(min))
}

/// Rows must be in display order with every parent row below its children.
///
/// Invariant: the pinned nodes form a single first-parent chain (each pinned commit's
/// first parent is the next pinned commit, down to the root or an outside parent). The
/// first-parent binding below debug-asserts this: a pinned commit's own lane must be free,
/// or already waiting for that same parent, when it binds its first parent.
pub fn layout(nodes: &[LayoutNode]) -> Layout {
    let min_free = usize::from(nodes.iter().any(|n| n.pinned)); // lane 0 is reserved for the pinned trunk
    let mut lanes: Vec<Option<Lane>> = Vec::new();
    let mut rows = Vec::with_capacity(nodes.len());
    let mut max_lanes = 0usize;

    for (r, node) in nodes.iter().enumerate() {
        let me = Wait::Row(r as u32);
        let waiting: Vec<usize> = lanes
            .iter()
            .enumerate()
            .filter_map(|(i, l)| matches!(l, Some(l) if l.wait == me).then_some(i))
            .collect();
        let lane = if node.pinned {
            0
        } else if let Some(&w) = waiting.first() {
            w
        } else {
            first_free(&lanes, min_free)
        };
        if lanes.len() <= lane {
            lanes.resize(lane + 1, None);
        }

        let mut segments = Vec::new();
        for (i, l) in lanes.iter().enumerate() {
            let Some(l) = l else { continue };
            let (to, half) = if l.wait == me { (lane, Half::Top) } else { (i, Half::Full) };
            segments.push(Segment { from_lane: i as u16, to_lane: to as u16, half, color: color_of(i), dashed: l.dashed });
        }
        for &i in &waiting {
            lanes[i] = None;
        }

        let dashed = node.kind == NodeKind::Wip;
        for (k, parent) in node.parents.iter().enumerate() {
            let wait = match *parent {
                Parent::Row(p) => Wait::Row(p),
                Parent::Outside(id) => Wait::Outside(id),
            };
            let target = if k == 0 {
                debug_assert!(
                    lanes.get(lane).copied().flatten().is_none_or(|l| l.wait == wait),
                    "lane {lane} already waits for a different parent; pinned nodes must form one first-parent chain"
                );
                lane
            } else if let Some(j) = lanes.iter().position(|l| matches!(l, Some(l) if l.wait == wait && !l.dashed)) {
                // A solid merge line never joins a dashed WIP lane that happens to be
                // waiting on the same parent: it opens or reuses its own lane instead, and
                // the two converge at the parent node via separate Top curves.
                j
            } else {
                first_free(&lanes, min_free)
            };
            if lanes.len() <= target {
                lanes.resize(target + 1, None);
            }
            if lanes[target].is_none() {
                lanes[target] = Some(Lane { wait, dashed });
            }
            segments.push(Segment { from_lane: lane as u16, to_lane: target as u16, half: Half::Bottom, color: color_of(target), dashed });
        }

        max_lanes = max_lanes.max(lanes.len());
        while matches!(lanes.last(), Some(None)) {
            lanes.pop();
        }
        rows.push(GraphRow { lane: lane as u16, color: color_of(lane), segments });
    }
    Layout { rows, max_lanes: max_lanes as u16 }
}
