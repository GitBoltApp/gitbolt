//! SplitMix64: tiny, fast and the same on every platform. Every generated asset and the whole
//! history draw from one of these, so a build is repeatable byte for byte.

#[derive(Clone, Debug)]
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Rng {
        Rng(seed)
    }

    /// A stream for one named purpose ("asset:scout:2"): what else drew before doesn't change it,
    /// so adding an asset never repaints the others.
    pub fn named(seed: u64, name: &str) -> Rng {
        let mut h = seed ^ 0xCBF2_9CE4_8422_2325;
        for b in name.bytes() {
            h = (h ^ b as u64).wrapping_mul(0x0100_0000_01B3);
        }
        let mut r = Rng(h);
        r.next_u64();
        r
    }

    pub fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    pub fn below(&mut self, n: u64) -> u64 {
        assert!(n > 0, "below(0)");
        ((self.next_u64() as u128 * n as u128) >> 64) as u64
    }

    pub fn range(&mut self, lo: i64, hi: i64) -> i64 {
        assert!(lo < hi, "empty range {lo}..{hi}");
        lo + self.below((hi - lo) as u64) as i64
    }

    pub fn unit(&mut self) -> f32 {
        (self.next_u64() >> 40) as f32 / 16_777_216.0
    }

    pub fn range_f(&mut self, lo: f32, hi: f32) -> f32 {
        (lo + (hi - lo) * self.unit()).min(hi - f32::EPSILON * hi.abs().max(1.0))
    }

    pub fn chance(&mut self, p: f32) -> bool {
        self.unit() < p
    }

    pub fn pick<'a, T>(&mut self, items: &'a [T]) -> &'a T {
        &items[self.below(items.len() as u64) as usize]
    }

    pub fn shuffle<T>(&mut self, items: &mut [T]) {
        for i in (1..items.len()).rev() {
            let j = self.below(i as u64 + 1) as usize;
            items.swap(i, j);
        }
    }
}

/// A well-mixed hash of a lattice point, for noise.
pub fn hash2(seed: u64, x: i32, y: i32) -> u64 {
    Rng::new(seed ^ ((x as u32 as u64) << 32) ^ (y as u32 as u64)).next_u64()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splitmix_reference_value() {
        // SplitMix64's published first output for seed 0.
        assert_eq!(Rng::new(0).next_u64(), 0xE220_A839_7B1D_CDAF);
    }

    #[test]
    fn named_streams_are_stable_and_distinct() {
        let a: Vec<u64> = (0..4).map({ let mut r = Rng::named(7, "asset:scout:1"); move |_| r.next_u64() }).collect();
        let b: Vec<u64> = (0..4).map({ let mut r = Rng::named(7, "asset:scout:1"); move |_| r.next_u64() }).collect();
        let c: Vec<u64> = (0..4).map({ let mut r = Rng::named(7, "asset:scout:2"); move |_| r.next_u64() }).collect();
        assert_eq!(a, b);
        assert_ne!(a, c);
    }

    #[test]
    fn ranges_stay_in_bounds() {
        let mut r = Rng::new(42);
        for _ in 0..10_000 {
            assert!(r.below(7) < 7);
            let v = r.range(-3, 4);
            assert!((-3..4).contains(&v));
            let u = r.unit();
            assert!((0.0..1.0).contains(&u));
            let f = r.range_f(2.0, 3.0);
            assert!((2.0..3.0).contains(&f));
        }
    }

    #[test]
    fn shuffle_keeps_every_item() {
        let mut r = Rng::new(3);
        let mut v: Vec<u32> = (0..50).collect();
        r.shuffle(&mut v);
        assert_ne!(v, (0..50).collect::<Vec<_>>());
        v.sort();
        assert_eq!(v, (0..50).collect::<Vec<_>>());
    }
}
