use super::layout::{Half, NodeKind, Segment};
use std::collections::{HashMap, HashSet};

pub struct AsciiRow<'a> {
    pub lane: u16,
    pub kind: NodeKind,
    pub segments: &'a [Segment],
    pub label: &'a str,
}

/// Human-readable layout dump used by snapshot tests and debugging.
pub fn render_ascii(rows: &[AsciiRow<'_>], max_lanes: u16) -> String {
    let w = usize::from(max_lanes.max(1));
    let mut out = String::new();
    for row in rows {
        let l = usize::from(row.lane);

        let mut full_dashed: HashMap<usize, bool> = HashMap::new();
        let mut top_from: HashSet<usize> = HashSet::new();
        let mut bottom_to: HashSet<usize> = HashSet::new();
        for s in row.segments {
            match s.half {
                Half::Full => {
                    full_dashed.insert(usize::from(s.from_lane), s.dashed);
                }
                Half::Top => {
                    top_from.insert(usize::from(s.from_lane));
                }
                Half::Bottom => {
                    bottom_to.insert(usize::from(s.to_lane));
                }
            }
        }

        let mut cells = vec![' '; w];
        for (i, cell) in cells.iter_mut().enumerate() {
            if i == l {
                continue; // the node char is written after this loop, taking priority.
            }
            if let Some(&dashed) = full_dashed.get(&i) {
                *cell = if dashed { ':' } else { '|' };
                continue;
            }
            let has_top = top_from.contains(&i);
            let has_bottom = bottom_to.contains(&i);
            *cell = if has_top && has_bottom {
                'X'
            } else if has_top {
                if i > l { '/' } else { '\\' }
            } else if has_bottom {
                if i > l { '\\' } else { '/' }
            } else {
                ' '
            };
        }
        cells[l] = match row.kind {
            NodeKind::Commit => '*',
            NodeKind::Merge => 'M',
            NodeKind::Stash => 'S',
            NodeKind::Wip => 'W',
        };

        // A gap between adjacent cells, or a still-blank cell, is dashed if it lies inside
        // the horizontal span of any non-straight Top or Bottom segment in this row, so a
        // curve reads as continuous instead of leaving a blank hole. The gap span is closed
        // at the near end (the step off the node itself dashes); the cell span is open at
        // both ends (a cell that already holds a glyph — including the node's own lane and
        // the segment's far end — keeps it).
        let mut dash_gap = vec![false; w.saturating_sub(1)];
        let far_ends: Vec<usize> = row
            .segments
            .iter()
            .filter_map(|s| match s.half {
                Half::Top if usize::from(s.from_lane) != l => Some(usize::from(s.from_lane)),
                Half::Bottom if usize::from(s.to_lane) != l => Some(usize::from(s.to_lane)),
                _ => None,
            })
            .collect();
        for &x in &far_ends {
            let (lo, hi) = (l.min(x), l.max(x));
            for g in &mut dash_gap[lo..hi] {
                *g = true;
            }
            for cell in &mut cells[lo + 1..hi] {
                if *cell == ' ' {
                    *cell = '-';
                }
            }
        }

        let mut grid = String::with_capacity(2 * w - 1);
        for i in 0..w {
            grid.push(cells[i]);
            if i + 1 < w {
                grid.push(if dash_gap[i] { '-' } else { ' ' });
            }
        }

        let lanes_of = |half: Half, pick: fn(&Segment) -> u16| {
            row.segments
                .iter()
                .filter(|s| s.half == half && s.from_lane != s.to_lane)
                .map(|s| pick(s).to_string())
                .collect::<Vec<_>>()
        };
        let ins = lanes_of(Half::Top, |s| s.from_lane);
        let outs = lanes_of(Half::Bottom, |s| s.to_lane);
        let mut line = format!("{:<width$}  {}", grid.trim_end(), row.label, width = 2 * w - 1);
        if !ins.is_empty() {
            line.push_str(&format!(" in:{}", ins.join(",")));
        }
        if !outs.is_empty() {
            line.push_str(&format!(" out:{}", outs.join(",")));
        }
        out.push_str(line.trim_end());
        out.push('\n');
    }
    out
}
