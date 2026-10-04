//! Device credentials — the S1 auth seam, shared contract between the PWA
//! (mints / rotates / revokes: pwa/lib/devices.ts) and the bridge (verifies).
//! One JSON file, two runtimes; the PWA is the only writer (atomic rename).
//!
//! v2 shape (camelCase, as the PWA writes it):
//! { "version": 2, "killEpoch": n,
//!   "devices": [ { "id", "revoked",
//!                  "access": [ { "hash", "exp" (unix ms), "region" } ], … } ] }
//! hash = lowercase hex sha256 of the raw bearer token. Raw tokens never touch
//! the file. Access tokens are short-lived and region-bound; the bridge also
//! re-checks every LIVE peer (revocation / kill epoch / expiry) — see bridge.rs.

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
    pub exp_ms: u64,
    /// the region the grant was checked in
    pub region: String,
}

#[derive(Default)]
struct Snapshot {
    epoch: u64,
    revoked: HashMap<String, bool>,
    /// access hash → (device, exp ms, region)
    access: HashMap<String, (String, u64, String)>,
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

    /// A live, unexpired access token issued in `region`. A token minted
    /// milliseconds ago may postdate the cache: a miss re-reads the file once.
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
            let (device, exp, reg) = s.access.get(&hash).ok_or(Deny::Invalid)?;
            if s.revoked.get(device).copied().unwrap_or(true) {
                return Err(Deny::Revoked);
            }
            if *exp < now_ms() {
                return Err(Deny::Expired);
            }
            if reg != region {
                return Err(Deny::Region);
            }
            Ok(Grant { device: device.clone(), exp_ms: *exp, region: region.to_string() })
        })
    }

    /// The device still exists and is not revoked.
    pub fn device_live(&self, id: &str) -> bool {
        self.with(|s| s.revoked.get(id) == Some(&false))
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
struct DeviceEntry {
    id: String,
    #[serde(default)]
    revoked: bool,
    #[serde(default)]
    access: Vec<AccessEntry>,
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
            s.revoked.insert(d.id.clone(), d.revoked);
            for a in d.access {
                s.access.insert(a.hash, (d.id.clone(), a.exp, a.region));
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
