//! Deterministic xorshift64* — every packet decision the wire makes draws from
//! a seedable stream, so a scenario run is reproducible given the same packet
//! arrival order (the wire is wall-clock threaded, so order is statistical:
//! same seed = same *behavior distribution*, exactly reproducible in the
//! single-threaded decision function checked by `ygg-sim m0`).

pub struct Rng {
    s: u64,
}

impl Rng {
    pub fn new(seed: u64) -> Rng {
        Rng {
            s: if seed == 0 { 0x9E37_79B9_7F4A_7C15 } else { seed },
        }
    }

    pub fn next_u64(&mut self) -> u64 {
        let mut x = self.s;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.s = x;
        x.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }

    /// uniform [0, 1)
    pub fn next_f64(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 / (1u64 << 53) as f64
    }

    /// true with probability p
    pub fn chance(&mut self, p: f64) -> bool {
        self.next_f64() < p
    }

    /// uniform integer in [lo, hi] inclusive
    pub fn range_i64(&mut self, lo: i64, hi: i64) -> i64 {
        if hi <= lo {
            return lo;
        }
        lo + (self.next_u64() % ((hi - lo + 1) as u64)) as i64
    }

    pub fn fill_bytes(&mut self, out: &mut [u8]) {
        for chunk in out.chunks_mut(8) {
            let v = self.next_u64().to_le_bytes();
            chunk.copy_from_slice(&v[..chunk.len()]);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_seed_same_stream() {
        let mut a = Rng::new(1234);
        let mut b = Rng::new(1234);
        for _ in 0..1000 {
            assert_eq!(a.next_u64(), b.next_u64());
        }
    }

    #[test]
    fn zero_seed_stable() {
        let mut a = Rng::new(0);
        let mut b = Rng::new(0);
        assert_eq!(a.next_u64(), b.next_u64());
    }
}
