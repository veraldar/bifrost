//! Device credentials — the S1 auth seam, shared contract between the app
//! (mints / rotates / revokes) and the bridge (verifies). One JSON file, two
//! runtimes; the app is the only writer (atomic rename), the bridge only
//! ever reads. Both schemas the app has written are read here, in ONE file:
//!
//! v1 (camelCase, the tree's app / installer / rootlink-sim):
//!   { "devices": [ { "id", "name", "tokenHash", "created", "revoked",
//!                    "roots": ["mac-a", …] } ] }
//!   tokenHash = lowercase hex sha256 of a NON-expiring bearer token, no
//!   region. `roots` is the v4 TOKEN LAW allowlist (missing = local only).
//!
//! v2 (camelCase, pwa/lib/devices.ts — v0.9 pairing):
//!   { "version": 2, "killEpoch": n,
//!     "devices": [ { "id", "revoked",
//!                    "access": [ { "hash", "exp" (unix ms), "region" } ] } ] }
//!   Access tokens are short-lived and region-bound; the bridge also re-checks
//!   every LIVE peer (revocation / kill epoch / expiry) — see bridge.rs.
//!
//! A device may carry either credential (or, mid-migration, both). Raw tokens
//! never touch the file.

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use sha2::{Digest, Sha256};

pub fn hash_token(raw: &str) -> String {
    let d = Sha256::digest(raw.trim().as_bytes());
    d.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// `exp_ms` of a v1 credential: it never expires.
pub const NO_EXPIRY: u64 = u64::MAX;

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Deny {
    Missing,
    Invalid,
    Expired,
    Revoked,
    Region,
}

impl Deny {
    pub fn why(self) -> &'static str {
        match self {
            Deny::Missing => "missing",
            Deny::Invalid => "invalid",
            Deny::Expired => "expired",
            Deny::Revoked => "revoked",
            Deny::Region => "region",
        }
    }
    /// what the client must do next (same contract as the PWA middleware)
    pub fn reauth(self) -> &'static str {
        match self {
            Deny::Expired | Deny::Region => "refresh",
            _ => "pair",
        }
    }
}

#[derive(Debug, Clone)]
pub struct Grant {
    pub device: String,
    /// unix ms; NO_EXPIRY for a v1 credential
    pub exp_ms: u64,
    /// the region the grant was checked in
    pub region: String,
    /// v4 TOKEN LAW: the device's root allowlist (empty = local root only)
    pub roots: Vec<String>,
}

#[derive(Default)]
struct Snapshot {
    epoch: u64,
    /// device id → revoked
    revoked: HashMap<String, bool>,
    /// device id → v4 root allowlist claim
    roots: HashMap<String, Vec<String>>,
    /// v2 access hash → (device, exp ms, region)
    access: HashMap<String, (String, u64, String)>,
    /// v1 tokenHash → device
    v1: HashMap<String, String>,
}

pub struct TokenStore {
    path: PathBuf,
    cache: std::sync::Mutex<(Instant, Snapshot)>,
}

const RELOAD: Duration = Duration::from_millis(300);

impl TokenStore {
    pub fn open(path: impl Into<PathBuf>) -> TokenStore {
        TokenStore {
            path: path.into(),
            cache: std::sync::Mutex::new((Instant::now() - Duration::from_secs(3600), Snapshot::default())),
        }
    }

    fn with<T>(&self, f: impl FnOnce(&Snapshot) -> T) -> T {
        self.with_fresh(false, f)
    }

    fn with_fresh<T>(&self, force: bool, f: impl FnOnce(&Snapshot) -> T) -> T {
        let mut c = self.cache.lock().unwrap();
        if force || c.0.elapsed() > RELOAD {
            c.0 = Instant::now();
            c.1 = std::fs::read_to_string(&self.path)
                .ok()
                .and_then(|t| serde_json::from_str::<RegFile>(&t).ok())
                .map(|r| r.snapshot())
                .unwrap_or_default();
        }
        f(&c.1)
    }

    /// A live credential usable from `region`: a v2 access token (unexpired,
    /// issued in this region) or a v1 device token (no expiry, no region).
    /// A token minted milliseconds ago may postdate the cache: a miss
    /// re-reads the file once.
    pub fn check(&self, raw: &str, region: &str) -> Result<Grant, Deny> {
        match self.lookup(raw, region, false) {
            Err(Deny::Invalid) => self.lookup(raw, region, true),
            other => other,
        }
    }

    fn lookup(&self, raw: &str, region: &str, force: bool) -> Result<Grant, Deny> {
        let raw = raw.trim();
        if raw.len() < 16 {
            return Err(Deny::Missing);
        }
        let hash = hash_token(raw);
        self.with_fresh(force, |s| {
            let roots = |dev: &str| s.roots.get(dev).cloned().unwrap_or_default();
            if let Some((device, exp, reg)) = s.access.get(&hash) {
                if s.revoked.get(device).copied().unwrap_or(true) {
                    return Err(Deny::Revoked);
                }
                if *exp < now_ms() {
                    return Err(Deny::Expired);
                }
                if reg != region {
                    return Err(Deny::Region);
                }
                return Ok(Grant {
                    device: device.clone(),
                    exp_ms: *exp,
                    region: region.to_string(),
                    roots: roots(device),
                });
            }
            let device = s.v1.get(&hash).ok_or(Deny::Invalid)?;
            if s.revoked.get(device).copied().unwrap_or(true) {
                return Err(Deny::Revoked);
            }
            Ok(Grant {
                device: device.clone(),
                exp_ms: NO_EXPIRY,
                region: region.to_string(),
                roots: roots(device),
            })
        })
    }

    /// The device still exists and is not revoked.
    pub fn device_live(&self, id: &str) -> bool {
        self.with(|s| s.revoked.get(id) == Some(&false))
    }

    /// v4 root-link: the link-token `dev` claim names a device ID (never a
    /// bearer token) — it must be a known, unrevoked device. A device paired
    /// milliseconds ago may postdate the cache: a miss re-reads the file once
    /// (the same law as `check`).
    pub fn knows_dev(&self, id: &str) -> bool {
        self.device_live(id) || self.with_fresh(true, |s| s.revoked.get(id) == Some(&false))
    }

    pub fn kill_epoch(&self) -> u64 {
        self.with(|s| s.epoch)
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegFile {
    #[serde(default)]
    kill_epoch: u64,
    #[serde(default)]
    devices: Vec<DeviceEntry>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeviceEntry {
    /// v2 always writes it; v1 writers (devices.ts v1) did too — a v1 entry
    /// without one is keyed by its token hash
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    revoked: bool,
    /// v1 credential: non-expiring, region-free
    #[serde(default)]
    token_hash: Option<String>,
    /// v2 credentials: expiring, region-bound
    #[serde(default)]
    access: Vec<AccessEntry>,
    /// v4 TOKEN LAW: roots this device may name. Missing = local root only.
    #[serde(default)]
    roots: Vec<String>,
}

#[derive(serde::Deserialize)]
struct AccessEntry {
    hash: String,
    exp: u64,
    #[serde(default)]
    region: String,
}

impl RegFile {
    fn snapshot(self) -> Snapshot {
        let mut s = Snapshot { epoch: self.kill_epoch, ..Default::default() };
        for d in self.devices {
            let Some(id) = d.id.or_else(|| d.token_hash.as_ref().map(|h| format!("v1:{h}"))) else {
                continue;
            };
            s.revoked.insert(id.clone(), d.revoked);
            s.roots.insert(id.clone(), d.roots);
            if let Some(h) = d.token_hash {
                s.v1.insert(h.to_ascii_lowercase(), id.clone());
            }
            for a in d.access {
                s.access.insert(a.hash, (id.clone(), a.exp, a.region));
            }
        }
        s
    }
}

/// Extract bearer credentials from an Authorization header value.
pub fn bearer(header_value: &str) -> Option<&str> {
    let v = header_value.trim();
    v.strip_prefix("Bearer ")
        .or_else(|| v.strip_prefix("bearer "))
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store(json: serde_json::Value) -> (TokenStore, PathBuf) {
        let p = std::env::temp_dir().join(format!(
            "bfn-tokens-{}-{}.json",
            std::process::id(),
            hash_token(&json.to_string())
        ));
        std::fs::write(&p, json.to_string()).unwrap();
        (TokenStore::open(&p), p)
    }

    #[test]
    fn v1_camelcase_token_hash_validates_with_roots() {
        let raw = "bfnd-v1-test-token-value";
        let (t, p) = store(serde_json::json!({ "devices": [
            { "id": "dev_a", "name": "a", "tokenHash": hash_token(raw), "created": "now",
              "revoked": false, "roots": ["mac-a"] } ] }));
        let g = t.check(raw, "lan:10.0.0.0/24").expect("v1 token must validate");
        assert_eq!(g.device, "dev_a");
        assert_eq!(g.exp_ms, NO_EXPIRY);
        assert_eq!(g.roots, vec!["mac-a".to_string()]);
        assert!(t.knows_dev("dev_a"));
        assert_eq!(t.check("bfnd-not-a-real-token-value", "loopback").unwrap_err(), Deny::Invalid);
        let _ = std::fs::remove_file(p);
    }

    #[test]
    fn snake_case_token_hash_is_not_the_schema() {
        // the V9.2 scar: a selftest wrote `token_hash`; the contract is camelCase
        let raw = "bfnd-snake-test-token-value";
        let (t, p) = store(serde_json::json!({ "devices": [
            { "id": "dev_s", "token_hash": hash_token(raw), "revoked": false } ] }));
        assert_eq!(t.check(raw, "loopback").unwrap_err(), Deny::Invalid);
        let _ = std::fs::remove_file(p);
    }

    #[test]
    fn freshly_paired_device_is_seen_without_waiting_for_the_cache() {
        // rootlink-sim T9: a device appended right before its root dials in
        let raw = "bfnd-v1-first-token-value";
        let (t, p) = store(serde_json::json!({ "devices": [
            { "id": "dev_a", "tokenHash": hash_token(raw), "revoked": false } ] }));
        assert!(t.knows_dev("dev_a")); // warms the cache
        std::fs::write(&p, serde_json::json!({ "devices": [
            { "id": "dev_a", "tokenHash": hash_token(raw), "revoked": false },
            { "id": "dev_new", "tokenHash": hash_token("bfnd-v1-second-token"), "revoked": false } ] })
        .to_string())
        .unwrap();
        assert!(t.knows_dev("dev_new"), "a miss must re-read the file once");
        let _ = std::fs::remove_file(p);
    }

    #[test]
    fn v1_revoked_and_v2_rules_in_one_file() {
        let v1 = "bfnd-v1-revoked-token-value";
        let v2 = "bfnd-v2-access-token-value";
        let (t, p) = store(serde_json::json!({ "version": 2, "killEpoch": 3, "devices": [
            { "id": "dev_r", "tokenHash": hash_token(v1), "revoked": true },
            { "id": "dev_2", "revoked": false,
              "access": [ { "hash": hash_token(v2), "exp": now_ms() + 60_000, "region": "loopback" } ] } ] }));
        assert_eq!(t.check(v1, "loopback").unwrap_err(), Deny::Revoked);
        assert!(!t.knows_dev("dev_r"));
        assert_eq!(t.check(v2, "loopback").unwrap().device, "dev_2");
        assert_eq!(t.check(v2, "lan:10.0.0.0/24").unwrap_err(), Deny::Region);
        assert_eq!(t.kill_epoch(), 3);
        let _ = std::fs::remove_file(p);
    }
}
