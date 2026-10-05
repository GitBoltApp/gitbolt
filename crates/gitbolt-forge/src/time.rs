//! Forge timestamps (RFC 3339) and `Retry-After`, without a date library.

use std::time::{SystemTime, UNIX_EPOCH};

/// `Retry-After` is never believed past an hour.
pub const MAX_RETRY_AFTER_SECS: i64 = 3600;

pub fn unix_now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

/// `2026-10-04T12:00:00Z`, with an optional fraction and `Z` or a `±hh:mm` offset → unix seconds.
pub fn parse_rfc3339(s: &str) -> Option<i64> {
    let s = s.trim();
    let b = s.as_bytes();
    if b.len() < 19 || b[4] != b'-' || b[7] != b'-' || !matches!(b[10], b'T' | b't' | b' ') || b[13] != b':' || b[16] != b':' {
        return None;
    }
    let num = |from: usize, to: usize| s.get(from..to)?.parse::<i64>().ok();
    let (y, mo, d, h, mi, se) = (num(0, 4)?, num(5, 7)?, num(8, 10)?, num(11, 13)?, num(14, 16)?, num(17, 19)?);
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 23 || mi > 59 || se > 60 {
        return None;
    }
    let mut rest = &s[19..];
    if let Some(r) = rest.strip_prefix('.') {
        rest = r.trim_start_matches(|c: char| c.is_ascii_digit());
    }
    let offset = match rest {
        "" | "Z" | "z" => 0,
        _ => {
            let sign = match rest.as_bytes()[0] {
                b'+' => 1,
                b'-' => -1,
                _ => return None,
            };
            let (oh, om) = rest[1..].split_once(':')?;
            let (oh, om) = (oh.parse::<i64>().ok()?, om.parse::<i64>().ok()?);
            if !(0..=23).contains(&oh) || !(0..=59).contains(&om) {
                return None;
            }
            sign * (oh * 3600 + om * 60)
        }
    };
    Some(days_from_civil(y, mo, d) * 86_400 + h * 3600 + mi * 60 + se - offset)
}

/// Unix seconds → `2026-10-04T12:00:00Z`.
pub fn format_rfc3339(secs: i64) -> String {
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Howard Hinnant's `civil_from_days`.
    let z = days + 719_468;
    let era = (if z >= 0 { z } else { z - 146_096 }) / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

/// Days since 1970-01-01 (Howard Hinnant's `days_from_civil`).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = (if y >= 0 { y } else { y - 399 }) / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// `Retry-After`: seconds, or an HTTP date (its distance from `now`). Never negative.
pub fn retry_after_secs(v: &str, now: i64) -> Option<i64> {
    let v = v.trim();
    if let Ok(n) = v.parse::<i64>() {
        return Some(n.clamp(0, MAX_RETRY_AFTER_SECS));
    }
    if !v.is_empty() && v.trim_start_matches('-').bytes().all(|b| b.is_ascii_digit()) {
        return Some(if v.starts_with('-') { 0 } else { MAX_RETRY_AFTER_SECS });
    }
    let at = httpdate::parse_http_date(v).ok()?;
    let secs = at.duration_since(UNIX_EPOCH).ok()?.as_secs() as i64;
    Some(secs.saturating_sub(now).clamp(0, MAX_RETRY_AFTER_SECS))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_what_it_parses() {
        for t in ["1970-01-01T00:00:00Z", "2026-10-04T10:00:01Z", "2000-02-29T23:59:59Z", "2100-03-01T00:00:00Z"] {
            assert_eq!(format_rfc3339(parse_rfc3339(t).unwrap()), t);
        }
    }

    #[test]
    fn parses_the_timestamps_forges_send() {
        assert_eq!(parse_rfc3339("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_rfc3339("2026-10-04T12:00:00Z"), Some(1_791_115_200));
        assert_eq!(parse_rfc3339("2026-10-04T12:00:00.123Z"), Some(1_791_115_200));
        assert_eq!(parse_rfc3339("2026-10-04T14:00:00+02:00"), Some(1_791_115_200));
        assert_eq!(parse_rfc3339("2026-10-04T12:00:00.5-00:30"), Some(1_791_117_000));
        assert_eq!(parse_rfc3339("2024-02-29T23:59:59Z"), Some(1_709_251_199));
        assert_eq!(parse_rfc3339("2026-13-01T00:00:00Z"), None);
        assert_eq!(parse_rfc3339("yesterday"), None);
        assert_eq!(parse_rfc3339("2026-10-04T12:00:00+99:00"), None);
        assert_eq!(parse_rfc3339("2026-10-04T12:00:00+02:99"), None);
    }

    #[test]
    fn retry_after_is_seconds_or_an_http_date() {
        assert_eq!(retry_after_secs("120", 0), Some(120));
        assert_eq!(retry_after_secs("-5", 0), Some(0));
        assert_eq!(retry_after_secs("Wed, 21 Oct 2015 07:28:00 GMT", 1_445_412_400), Some(80));
        assert_eq!(retry_after_secs("soon", 0), None);
        assert_eq!(retry_after_secs("9223372036854775807", 0), Some(3600));
        assert_eq!(retry_after_secs("99999999999999999999999999", 0), Some(3600));
        assert_eq!(retry_after_secs("Wed, 21 Oct 2015 07:28:00 GMT", i64::MIN), Some(3600));
    }
}
