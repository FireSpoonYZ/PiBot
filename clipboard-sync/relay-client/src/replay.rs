use std::collections::HashMap;
use std::time::{Duration, Instant};

pub(crate) const DEFAULT_REPLAY_CAPACITY: usize = 1024;

#[derive(Clone, PartialEq, Eq, Hash)]
struct ReplayKey {
    from_device_id: String,
    nonce: [u8; 32],
}

#[derive(Clone, Copy)]
struct ReplayEntry {
    sent_at: u64,
    seen_mono: Instant,
}

/// Bounded in-memory replay suppression cache scoped to a running `Link`.
///
/// Entries store only `(from_device_id, nonce, sent_at, seen_mono)` — never
/// clipboard plaintext or ciphertext. Callers must insert only after payload
/// authentication succeeds. When at capacity after pruning expired entries,
/// insertion fails closed.
pub(crate) struct ReplayCache {
    capacity: usize,
    max_age_seconds: u64,
    mono_ttl: Duration,
    entries: HashMap<ReplayKey, ReplayEntry>,
}

impl ReplayCache {
    pub(crate) fn new(capacity: usize, max_age_seconds: u64) -> Self {
        let mono_ttl = Duration::from_secs(max_age_seconds.saturating_mul(2).saturating_add(1));
        Self {
            capacity,
            max_age_seconds,
            mono_ttl,
            entries: HashMap::new(),
        }
    }

    fn make_key(from_device_id: &str, nonce: &str) -> Option<ReplayKey> {
        let nonce_bytes: [u8; 32] = nonce.as_bytes().try_into().ok()?;
        Some(ReplayKey {
            from_device_id: from_device_id.to_owned(),
            nonce: nonce_bytes,
        })
    }

    /// Evicts entries only when both the monotonic TTL (`2 * MAX_AGE + 1s`)
    /// has elapsed and the entry's `sent_at` is outside the wall-clock
    /// acceptance window (`±MAX_AGE`).
    pub(crate) fn prune(&mut self, now_unix: u64, now_mono: Instant) {
        let max_age = self.max_age_seconds;
        let mono_ttl = self.mono_ttl;
        self.entries.retain(|_, entry| {
            let mono_expired = now_mono.saturating_duration_since(entry.seen_mono) >= mono_ttl;
            let clock_expired = now_unix.abs_diff(entry.sent_at) > max_age;
            !(mono_expired && clock_expired)
        });
    }

    pub(crate) fn contains(
        &mut self,
        from_device_id: &str,
        nonce: &str,
        now_unix: u64,
        now_mono: Instant,
    ) -> bool {
        self.prune(now_unix, now_mono);
        let Some(key) = Self::make_key(from_device_id, nonce) else {
            return true;
        };
        self.entries.contains_key(&key)
    }

    /// Records a cryptographically verified `(from_device_id, nonce)` entry.
    /// Returns `false` if it is a replay or if the cache is full (fail closed).
    pub(crate) fn insert_verified(
        &mut self,
        from_device_id: &str,
        nonce: &str,
        sent_at: u64,
        now_unix: u64,
        now_mono: Instant,
    ) -> bool {
        self.prune(now_unix, now_mono);
        let Some(key) = Self::make_key(from_device_id, nonce) else {
            return false;
        };
        if self.entries.contains_key(&key) {
            return false;
        }
        if self.entries.len() >= self.capacity {
            return false;
        }
        self.entries.insert(
            key,
            ReplayEntry {
                sent_at,
                seen_mono: now_mono,
            },
        );
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn nonce(fill: char) -> String {
        std::iter::repeat(fill).take(32).collect()
    }

    #[test]
    fn suppresses_replays_and_expires_only_when_both_clocks_advance() {
        let mut cache = ReplayCache::new(4, 30);
        let t0 = Instant::now();
        let unix0 = 1_700_000_000u64;
        let n1 = nonce('A');

        assert!(!cache.contains("peer-1", &n1, unix0, t0));
        assert!(cache.insert_verified("peer-1", &n1, unix0 + 20, unix0, t0));
        assert!(cache.contains("peer-1", &n1, unix0 + 10, t0 + Duration::from_secs(10)));
        assert!(!cache.insert_verified(
            "peer-1",
            &n1,
            unix0 + 20,
            unix0 + 10,
            t0 + Duration::from_secs(10)
        ));

        // Wall-clock moved past sent_at + 30, but monotonic TTL (61s) has NOT elapsed -> still retained
        assert!(cache.contains("peer-1", &n1, unix0 + 55, t0 + Duration::from_secs(55)));

        // Monotonic TTL (61s) elapsed, but wall-clock is still within ±30s of sent_at -> still retained
        assert!(cache.contains("peer-1", &n1, unix0 + 40, t0 + Duration::from_secs(61)));

        // Both monotonic TTL (61s) elapsed AND wall-clock outside ±30s of sent_at (unix0 + 51 > unix0 + 20 + 30) -> expired
        assert!(!cache.contains("peer-1", &n1, unix0 + 51, t0 + Duration::from_secs(61)));
    }

    #[test]
    fn fails_closed_at_capacity_and_recovers_after_expiry() {
        let mut cache = ReplayCache::new(2, 30);
        let t0 = Instant::now();
        let unix0 = 1_700_000_000u64;

        assert!(cache.insert_verified("peer-1", &nonce('A'), unix0, unix0, t0));
        assert!(cache.insert_verified("peer-1", &nonce('B'), unix0, unix0, t0));
        // Capacity reached -> must fail closed rather than evicting live entries
        assert!(!cache.insert_verified("peer-1", &nonce('C'), unix0, unix0, t0));
        assert!(cache.contains("peer-1", &nonce('A'), unix0, t0));
        assert!(cache.contains("peer-1", &nonce('B'), unix0, t0));

        // After expiry, capacity frees up cleanly
        let t1 = t0 + Duration::from_secs(61);
        let unix1 = unix0 + 61;
        assert!(cache.insert_verified("peer-1", &nonce('C'), unix1, unix1, t1));
    }
}
