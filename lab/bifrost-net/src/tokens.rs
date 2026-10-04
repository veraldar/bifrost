//! Device tokens — the S1 auth seam, shared contract between the PWA
//! (mints/revokes) and the bridge (validates). One JSON file, both runtimes:
//! the PWA is the source of truth, the bridge only ever verifies.
//!
//! File shape (pwa data dir, chmod 600, gitignored):
//! { "devices": [ { "id", "name", "token_hash", "created", "revoked" } ] }
//! token_hash = lowercase hex sha256 of the raw bearer token.
//! Raw tokens are shown ONCE at pairing and never stored.

use std::path::{Path, PathBuf};
use std::time::Duration;

use sha2::{Digest, Sha256};

pub fn hash_token(raw: &str) -> String {
    let d = Sha256::digest(raw.trim().as_bytes());
    d.iter().map(|b| format!("{b:02x}")).collect()
}

pub struct TokenStore {
    path: PathBuf,
    cache: std::sync::Mutex<Cache>,
}

struct Cache {
    loaded_at: std::time::Instant,
    valid: std::collections::HashSet<String>,
}

impl TokenStore {
    pub fn open(path: impl Into<PathBuf>) -> TokenStore {
        TokenStore {
            path: path.into(),
            cache: std::sync::Mutex::new(Cache {
                loaded_at: std::time::Instant::now() - Duration::from_secs(3600),
                valid: Default::default(),
            }),
        }
    }

    /// Validate a raw bearer token against the CURRENT file (mtime-aware,
    /// re-reads at most once per second so revocation lands within seconds).
    pub fn validate(&self, raw: &str) -> bool {
        let raw = raw.trim();
        if raw.len() < 16 {
            return false;
        }
        let hash = hash_token(raw);
        let mut cache = self.cache.lock().unwrap();
        let reload = cache.loaded_at.elapsed() > Duration::from_secs(1)
            || mtime_newer(&self.path, cache.loaded_at);
        if reload {
            cache.loaded_at = std::time::Instant::now();
            cache.valid.clear();
            if let Ok(txt) = std::fs::read_to_string(&self.path) {
                if let Ok(v) = serde_json::from_str::<TokenFile>(&txt) {
                    for d in v.devices {
                        if !d.revoked {
                            cache.valid.insert(d.token_hash);
                        }
                    }
                }
            }
        }
        cache.valid.contains(&hash)
    }
}

#[derive(serde::Deserialize)]
struct TokenFile {
    #[serde(default)]
    devices: Vec<DeviceEntry>,
}

#[derive(serde::Deserialize)]
struct DeviceEntry {
    token_hash: String,
    #[serde(default)]
    revoked: bool,
}

fn mtime_newer(path: &Path, at: std::time::Instant) -> bool {
    match std::fs::metadata(path).and_then(|m| m.modified()) {
        Ok(mtime) => {
            let age = mtime.elapsed().unwrap_or(Duration::ZERO);
            // newer than `at` if file mtime age < time since `at`
            age < at.elapsed()
        }
        Err(_) => false,
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
