//! A git object id as 20 bytes: SHA-1, the only kind GitBolt's gix build reads.

use serde::{de, Deserialize, Deserializer, Serialize, Serializer};
use std::fmt;

#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Default)]
pub struct Oid(pub [u8; 20]);

impl Oid {
    /// All zeros: git's "no object".
    pub const NULL: Oid = Oid([0; 20]);

    /// 40 hex digits, either case; `None` for anything else.
    pub fn from_hex(s: &str) -> Option<Oid> {
        let b = s.as_bytes();
        if b.len() != 40 {
            return None;
        }
        let mut out = [0u8; 20];
        for (i, byte) in out.iter_mut().enumerate() {
            let hi = (b[2 * i] as char).to_digit(16)?;
            let lo = (b[2 * i + 1] as char).to_digit(16)?;
            *byte = (hi * 16 + lo) as u8;
        }
        Some(Oid(out))
    }

    /// From a 20-byte slice, as gix's `ObjectId::from_bytes_or_panic`.
    pub fn from_bytes_or_panic(b: &[u8]) -> Oid {
        Oid(b.try_into().expect("an object id is 20 bytes"))
    }

    pub fn is_null(&self) -> bool {
        *self == Oid::NULL
    }
}

impl fmt::Display for Oid {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        for b in self.0 {
            write!(f, "{b:02x}")?;
        }
        Ok(())
    }
}

impl fmt::Debug for Oid {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(self, f)
    }
}

impl Serialize for Oid {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.collect_str(self)
    }
}

impl<'de> Deserialize<'de> for Oid {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let s = String::deserialize(d)?;
        Oid::from_hex(&s).ok_or_else(|| de::Error::custom(format!("not a 40-hex object id: {s:?}")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const HEX: &str = "0123456789abcdef0123456789abcdef01234567";

    #[test]
    fn hex_round_trips_lowercase() {
        let id = Oid::from_hex(HEX).unwrap();
        assert_eq!(id.to_string(), HEX);
        assert_eq!(Oid::from_hex(&HEX.to_uppercase()), Some(id), "either case reads");
        assert_eq!(format!("{id:?}"), HEX);
    }

    #[test]
    fn rejects_anything_but_40_hex_digits() {
        assert_eq!(Oid::from_hex(&HEX[..39]), None);
        assert_eq!(Oid::from_hex(&format!("{HEX}0")), None);
        assert_eq!(Oid::from_hex(&HEX.replace('a', "g")), None);
        assert_eq!(Oid::from_hex(""), None);
    }

    #[test]
    fn null_bytes_and_order() {
        assert!(Oid::NULL.is_null());
        assert_eq!(Oid::from_bytes_or_panic(&[7; 20]), Oid([7; 20]));
        assert!(Oid([1; 20]) < Oid([2; 20]), "ordered by bytes, as gix's ObjectId");
    }

    #[test]
    fn serde_is_a_hex_string() {
        let id = Oid::from_hex(HEX).unwrap();
        assert_eq!(serde_json::to_string(&id).unwrap(), format!("\"{HEX}\""));
        assert_eq!(serde_json::from_str::<Oid>(&format!("\"{HEX}\"")).unwrap(), id);
        assert!(serde_json::from_str::<Oid>("\"nope\"").is_err());
    }
}
