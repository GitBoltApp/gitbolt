//! Orbital's tables (CSV/TSV): cells retuned by balance commits.

use super::corpus::tune;
use crate::media::rng::Rng;
use std::collections::BTreeSet;

pub struct CellTune {
    pub text: String,
    pub row: String,
    pub column: String,
    pub old: String,
    pub new: String,
}

pub fn delimiter(path: &str) -> Option<char> {
    if path.ends_with(".csv") {
        Some(',')
    } else if path.ends_with(".tsv") {
        Some('\t')
    } else {
        None
    }
}

fn rows(text: &str, delim: char) -> (Vec<String>, Vec<Vec<String>>) {
    let mut lines = text.lines();
    let header: Vec<String> = lines.next().unwrap_or("").split(delim).map(str::to_string).collect();
    let body = lines.map(|l| l.split(delim).map(str::to_string).collect()).collect();
    (header, body)
}

fn join(header: &[String], body: &[Vec<String>], delim: char) -> String {
    let d = delim.to_string();
    std::iter::once(header.join(&d)).chain(body.iter().map(|r| r.join(&d))).map(|l| l + "\n").collect()
}

/// The row's display name: its `name` column when there is one, else its first.
fn label(header: &[String], row: &[String]) -> String {
    let i = header.iter().position(|h| h == "name" || h == "class" || h == "item").unwrap_or(0);
    row.get(i).cloned().unwrap_or_default()
}

fn numeric(s: &str) -> bool {
    s.replace('_', "").parse::<f64>().is_ok() && !s.contains(['e', 'n', 'i'])
}

fn value(s: &str) -> f64 {
    s.replace('_', "").parse::<f64>().unwrap_or(0.0)
}

/// Scales one cell. A fraction (a chance, a volatility) stays a fraction, nothing drops to zero,
/// and a cell with a design value stays within a factor of 1.5 of it: it goes the other way when
/// this way would break one of those.
fn set_at(header: &[String], mut body: Vec<Vec<String>>, delim: char, r: usize, c: usize, factor: f64, design: Option<f64>) -> Option<CellTune> {
    let old = body.get(r)?.get(c)?.clone();
    if !numeric(&old) {
        return None;
    }
    let mut new = tune(&old, factor);
    let strays = |n: &str| design.is_some_and(|d| d != 0.0 && !(1.0 / 1.5..=1.5).contains(&(value(n) / d)));
    if (old.contains('.') && value(&old) <= 1.0 && value(&new) > 1.0) || strays(&new) || value(&new) == 0.0 {
        new = tune(&old, 1.0 / factor);
    }
    body[r][c] = new.clone();
    Some(CellTune { text: join(header, &body, delim), row: label(header, &body[r]), column: header[c].clone(), old, new })
}

pub fn set_cell(text: &str, delim: char, row: &str, column: &str, factor: f64) -> Option<CellTune> {
    let (header, body) = rows(text, delim);
    let c = header.iter().position(|h| h == column)?;
    let r = body.iter().position(|cells| cells.first().map(String::as_str) == Some(row))?;
    set_at(&header, body, delim, r, c, factor, None)
}

/// A random non-zero cell of a column that's numeric all the way down, scaled up or down.
pub fn tune_cell(text: &str, delim: char, rng: &mut Rng) -> Option<CellTune> {
    tune_cell_near(text, text, delim, &BTreeSet::new(), rng)
}

/// `tune_cell`, keeping the cell near its value in `design` (the table as written): balance
/// passes nudge numbers, they don't walk them off. A row `held` names (by its first cell or its
/// name) keeps its numbers: a test holds them.
pub fn tune_cell_near(text: &str, design: &str, delim: char, held: &BTreeSet<String>, rng: &mut Rng) -> Option<CellTune> {
    let (header, body) = rows(text, delim);
    let numeric_column = |c: usize| !body.is_empty() && body.iter().all(|r| r.get(c).is_some_and(|v| numeric(v)));
    // A zero (a planet at the origin, a belt's mass) isn't a balance number, and a small count
    // (a loot minimum of 1) would only step by one.
    let cells: Vec<(usize, usize)> = (1..header.len())
        .filter(|&c| numeric_column(c))
        .flat_map(|c| (0..body.len()).map(move |r| (r, c)))
        .filter(|&(r, _)| !body[r].first().is_some_and(|id| held.contains(id)) && !held.contains(&label(&header, &body[r])))
        .filter(|&(r, c)| {
            let v = &body[r][c];
            value(v) != 0.0 && (v.contains('.') || value(v).abs() >= 5.0)
        })
        .collect();
    if cells.is_empty() {
        return None;
    }
    let (r, c) = *rng.pick(&cells);
    let (dh, db) = rows(design, delim);
    let design = dh.iter().position(|h| *h == header[c]).and_then(|dc| db.get(r).filter(|row| row.first() == body[r].first()).or_else(|| db.iter().find(|row| row.first() == body[r].first()))?.get(dc)).map(|v| value(v));
    let factor = f64::from(if rng.chance(0.5) { rng.range_f(1.05, 1.25) } else { rng.range_f(0.8, 0.95) });
    set_at(&header, body, delim, r, c, factor, design)
}

/// `saves/sample.orbsave`, a save file to look at in the hex view. The layout is the one in
/// `core/save.txt`'s module docs for that format version (a `u32` version, then from 2 the
/// creation time, fuel and hull, from 3 the open contracts), little-endian, with an IEEE CRC-32
/// of everything before it on the end.
pub fn orbsave(version: u16) -> Vec<u8> {
    let mut b = b"ORBS".to_vec();
    b.extend_from_slice(&u32::from(version).to_le_bytes());
    if version >= 2 {
        // 2024-03-18 09:30:00 UTC, the day the save format moved to 2.
        b.extend_from_slice(&1_710_754_200u64.to_le_bytes());
    }
    b.extend_from_slice(&(48_000 + 21_600 * u64::from(version)).to_le_bytes());
    b.extend_from_slice(&(4_120.5f32 + 990.0 * f32::from(version)).to_le_bytes());
    for v in [1_240.0f32, -380.5, 3.18, 0.42, 5.0] {
        b.extend_from_slice(&v.to_le_bytes());
    }
    if version >= 2 {
        for v in [62.0f32, 90.0] {
            b.extend_from_slice(&v.to_le_bytes());
        }
    }
    let cargo: &[(u8, f32)] = match version {
        1 => &[(0, 6.0), (3, 12.0)],
        2 => &[(1, 4.0), (3, 12.0), (4, 2.0)],
        _ => &[(2, 10.0), (3, 8.0), (4, 2.0), (1, 1.0)],
    };
    for slot in 0..12 {
        let (id, tonnes) = cargo.get(slot).copied().unwrap_or((255, 0.0));
        b.push(id);
        b.extend_from_slice(&tonnes.to_le_bytes());
    }
    if version >= 3 {
        // (good, tonnes, destination station, reward, ticks left)
        let contracts: [(u8, f32, u32, f32, u32); 2] =
            [(3, 8.0, 3, 2_400.0, 20_400), (4, 2.0, 1, 900.0, 12_000)];
        b.extend_from_slice(&(contracts.len() as u32).to_le_bytes());
        for (good, tonnes, station, reward, ticks) in contracts {
            b.push(good);
            b.extend_from_slice(&tonnes.to_le_bytes());
            b.extend_from_slice(&station.to_le_bytes());
            b.extend_from_slice(&reward.to_le_bytes());
            b.extend_from_slice(&ticks.to_le_bytes());
        }
    }
    let crc = crate::media::png::crc32(&b);
    b.extend_from_slice(&crc.to_le_bytes());
    b
}

#[cfg(test)]
mod tests {
    use super::*;

    const TABLE: &str = "id,name,price,mass\nfuel_cells,Fuel cells,84,1.0\nice,Water ice,12,2.0\n";

    #[test]
    fn set_cell_changes_one_cell_by_row_id_and_column() {
        let t = set_cell(TABLE, ',', "fuel_cells", "price", 1.25).unwrap();
        assert_eq!(t.text, "id,name,price,mass\nfuel_cells,Fuel cells,105,1.0\nice,Water ice,12,2.0\n");
        assert_eq!((t.row.as_str(), t.column.as_str(), t.old.as_str(), t.new.as_str()), ("Fuel cells", "price", "84", "105"));
        assert!(set_cell(TABLE, ',', "nope", "price", 1.1).is_none());
    }

    #[test]
    fn tune_cell_picks_a_numeric_cell() {
        let mut rng = Rng::new(2);
        for _ in 0..20 {
            let t = tune_cell(TABLE, ',', &mut rng).unwrap();
            assert!(t.column == "price" || t.column == "mass", "{}", t.column);
            assert_ne!(t.old, t.new);
            assert_eq!(t.text.lines().count(), 3);
        }
        assert_eq!(delimiter("a/b.tsv"), Some('\t'));
        assert_eq!(delimiter("a/b.md"), None);
    }

    #[test]
    fn tune_cell_near_stays_close_to_the_design() {
        let mut rng = Rng::new(9);
        let mut text = TABLE.to_string();
        for _ in 0..200 {
            text = tune_cell_near(&text, TABLE, ',', &BTreeSet::new(), &mut rng).unwrap().text;
        }
        let price = |t: &str, row: usize| t.lines().nth(row).unwrap().split(',').nth(2).unwrap().parse::<f64>().unwrap();
        assert!((84.0 / 1.5..=84.0 * 1.5).contains(&price(&text, 1)), "{text}");
        assert!((12.0 / 1.5..=12.0 * 1.5).contains(&price(&text, 2)), "{text}");
    }

    #[test]
    fn tune_cell_skips_zeros_keeps_fractions_and_tunes_the_row_it_names() {
        let loot = "source\titem\tchance\tmin\nasteroid\tore\t0.95\t0\nasteroid\tice\t0.30\t0\n";
        let mut rng = Rng::new(5);
        for _ in 0..40 {
            let t = tune_cell(loot, '\t', &mut rng).unwrap();
            assert_eq!(t.column, "chance");
            assert!(t.new.parse::<f64>().unwrap() <= 1.0, "{}", t.new);
            let line = t.text.lines().find(|l| l.contains(&format!("\t{}\t", t.row))).unwrap();
            assert!(line.contains(&format!("\t{}\t", t.new)), "{line} for {}", t.row);
        }
    }

    #[test]
    fn tune_cell_near_leaves_alone_a_row_a_test_names() {
        let mut rng = Rng::new(3);
        for (held, tuned) in [("fuel_cells", "Water ice"), ("Water ice", "Fuel cells")] {
            let held = BTreeSet::from([held.to_string()]);
            for _ in 0..20 {
                assert_eq!(tune_cell_near(TABLE, TABLE, ',', &held, &mut rng).unwrap().row, tuned);
            }
        }
    }

    /// Reads a save the way `core/save.txt`'s `decode` does: the checksum, the magic, the version,
    /// then the fields in file order, and nothing left over.
    fn decode(bytes: &[u8]) -> (u32, u64, usize, usize) {
        let (body, tail) = bytes.split_at(bytes.len() - 4);
        assert_eq!(
            u32::from_le_bytes(tail.try_into().unwrap()),
            crate::media::png::crc32(body)
        );
        assert_eq!(&body[..4], b"ORBS");
        let mut at = 4;
        let mut take = |n: usize| {
            let s = &body[at..at + n];
            at += n;
            s.to_vec()
        };
        let version = u32::from_le_bytes(take(4).try_into().unwrap());
        assert!((1..=3).contains(&version));
        if version >= 2 {
            take(8);
        }
        let tick = u64::from_le_bytes(take(8).try_into().unwrap());
        take(4 + 5 * 4 + if version >= 2 { 8 } else { 0 });
        let mut filled = 0;
        for _ in 0..12 {
            let id = take(1)[0];
            let tonnes = f32::from_le_bytes(take(4).try_into().unwrap());
            if id != 255 {
                assert!(id <= 4 && tonnes > 0.0, "slot {id} {tonnes}");
                filled += 1;
            }
        }
        let mut contracts = 0;
        if version >= 3 {
            contracts = u32::from_le_bytes(take(4).try_into().unwrap()) as usize;
            take(contracts * 17);
        }
        assert_eq!(at, body.len(), "trailing bytes");
        (version, tick, filled, contracts)
    }

    #[test]
    fn save_files_grow_by_version_and_decode_by_the_corpus_rules() {
        let sizes: Vec<usize> = (1..=3).map(|v| orbsave(v).len()).collect();
        assert!(sizes[0] < sizes[1] && sizes[1] < sizes[2], "{sizes:?}");
        for v in 1..=3u16 {
            let (version, tick, filled, contracts) = decode(&orbsave(v));
            assert_eq!(version, u32::from(v));
            assert!(tick > 0 && filled >= 2);
            assert_eq!(contracts, if v == 3 { 2 } else { 0 });
        }
    }
}
