//! Orbital's two years: civil dates, milestones, and when each person is at work.

use super::people::Person;
use crate::media::rng::Rng;

/// Days since 1970-01-01 (Howard Hinnant's days_from_civil).
pub const fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = ((m + 9) % 12) as i64;
    let doy = (153 * mp + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

pub const fn unix(y: i64, m: u32, d: u32, h: u32, min: u32) -> i64 {
    days_from_civil(y, m, d) * 86_400 + h as i64 * 3_600 + min as i64 * 60
}

pub const START: i64 = unix(2024, 10, 7, 8, 0);
pub const END: i64 = unix(2026, 10, 9, 18, 0);
pub const MILESTONES: u32 = 40;

pub fn milestone_start(m: u32) -> i64 {
    START + (END - START) * (m as i64 - 1) / MILESTONES as i64
}

pub fn weekday(t: i64, tz_minutes: i32) -> u32 {
    ((t + tz_minutes as i64 * 60).div_euclid(86_400) + 3).rem_euclid(7) as u32
}

pub fn next_work_time(p: &Person, t: i64, rng: &mut Rng) -> i64 {
    let off = p.tz_minutes as i64 * 60;
    let (start, end) = (p.hours.0 as i64 * 3_600, p.hours.1 as i64 * 3_600);
    let mut local = t + off;
    loop {
        let day = local.div_euclid(86_400);
        let sec = local.rem_euclid(86_400);
        let works = (day + 3).rem_euclid(7) < 5 || rng.chance(p.weekend);
        if works && sec < end {
            let at = if sec < start { day * 86_400 + start + rng.below(2_700) as i64 } else { local };
            return at - off;
        }
        local = (day + 1) * 86_400;
    }
}

pub fn after(p: &Person, t: i64, hours: (u32, u32), rng: &mut Rng) -> i64 {
    let gap = rng.range(hours.0 as i64 * 3_600, hours.1 as i64 * 3_600 + 1);
    next_work_time(p, t + gap, rng)
}

pub fn civil(t: i64) -> (i64, u32, u32) {
    let z = t.div_euclid(86_400) + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

pub fn iso_date(t: i64) -> String {
    let (y, m, d) = civil(t);
    format!("{y:04}-{m:02}-{d:02}")
}

pub fn iso_datetime(t: i64) -> String {
    let s = t.rem_euclid(86_400);
    format!("{}T{:02}:{:02}:{:02}Z", iso_date(t), s / 3_600, s % 3_600 / 60, s % 60)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::orbital::people::{Person, Role};

    const TEST: Person = Person { handle: "t", name: "T", email: "t@example.com", tz_minutes: -300, hours: (9, 17), weekend: 0.0, role: Role::Tools };

    #[test]
    fn civil_dates_round_trip() {
        assert_eq!(unix(2024, 10, 7, 0, 0), 1_728_259_200);
        assert_eq!(weekday(unix(2024, 10, 7, 12, 0), 0), 0, "a Monday");
        assert_eq!(iso_date(START), "2024-10-07");
        assert_eq!(iso_date(END), "2026-10-09");
        assert_eq!(iso_datetime(unix(2025, 3, 14, 9, 12)), "2025-03-14T09:12:00Z");
        assert_eq!(civil(unix(2028, 2, 29, 23, 59)), (2028, 2, 29));
        assert_eq!(milestone_start(1), START);
        assert_eq!(milestone_start(41), END);
    }

    #[test]
    fn work_happens_in_working_hours_on_weekdays() {
        let mut rng = Rng::new(4);
        let mut t = START;
        for _ in 0..2_000 {
            let w = next_work_time(&TEST, t, &mut rng);
            assert!(w >= t);
            let local = w + TEST.tz_minutes as i64 * 60;
            let hour = local.rem_euclid(86_400) / 3_600;
            assert!((9..17).contains(&hour), "{}", iso_datetime(w));
            assert!(weekday(w, TEST.tz_minutes) < 5);
            t = w + rng.range(600, 40_000);
        }
    }

    #[test]
    fn after_moves_forward_by_the_gap() {
        let mut rng = Rng::new(1);
        let t = unix(2025, 1, 7, 15, 0);
        let a = after(&TEST, t, (2, 3), &mut rng);
        assert!(a >= t + 2 * 3_600);
    }
}
