//! v4 root-link — roots DIAL the trunk. No inbound ports on root machines.
//!
//! Law of this file (the dispatch order matters):
//!  1. The link token is an HMAC capsule, NOT a free name. `link-token`
//!     strings never reach the registry — only trunk-minted ids.
//!  2. Root selection is a CLAIM: every branch request may carry
//!     `"root": "<id>"`; absent = the trunk's local root.
//!  3. TOKEN LAW: naming any root OTHER than `local` demands a device
//!     token whose `roots` allowlist claim covers it. Anonymous scanners
//!     can only ever reach `local`.
//!  4. Dispatch: Job::Voice / Job::Req prompt turns named at a link-root
//!     ride that root's ws conn; unknown/refused root = clean error to the
//!     branch, never a panic, never a silent drop.
//!
//! Token shape (same HMAC pattern as pwa/lib/ice.ts TURN REST-auth):
//!   link-token = b64url(json payload) + "." + b64url(hmac_sha256)
//!   payload    = { "v":1, "root":"mac-studio", "roots":["mac-studio"],
//!                  "dev":"dev_ab12cd34", "iat":1730000000 }
//!   sub-ns timing leak accepted (only 32-byte secret matters); compare
//!   via subtle-constant-time fold to be exact.

use base64::Engine;
use sha2::{Digest, Sha256};

/// b64url no-pad
pub fn b64url(data: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(data)
}

pub fn b64url_decode(s: &str) -> Option<Vec<u8>> {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(s).ok()
}

/// HMAC-SHA256 (RFC 2104) over sha2 0.10 — no new crates, matches the
/// Python reference vector used by the verify harness.
pub fn hmac_sha256(key: &[u8], msg: &[u8]) -> [u8; 32] {
    const BLOCK: usize = 64;
    let mut k = [0u8; BLOCK];
    if key.len() > BLOCK {
        let d = Sha256::digest(key);
        k[..32].copy_from_slice(&d);
    } else {
        k[..key.len()].copy_from_slice(key);
    }
    let mut ipad = [0x36u8; BLOCK];
    let mut opad = [0x5cu8; BLOCK];
    for i in 0..BLOCK {
        ipad[i] ^= k[i];
        opad[i] ^= k[i];
    }
    let mut inner = Sha256::new();
    inner.update(&ipad);
    inner.update(msg);
    let ih = inner.finalize();
    let mut outer = Sha256::new();
    outer.update(&opad);
    outer.update(&ih);
    outer.finalize().into()
}

/// constant-time equality (dual-|, early-exit-free)
pub fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut acc = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        acc |= x ^ y;
    }
    acc == 0
}

#[derive(Clone, Debug)]
pub struct LinkToken {
    pub root: String,
    /// roots this DEVICE may name on a branch request (allowlist claim)
    pub roots: Vec<String>,
    pub dev: String,
    pub iat: u64,
}

/// v4 TOKEN LAW: a link-token is valid for 6 hours after minting (iat).
pub const LINK_TOKEN_TTL: u64 = 6 * 3600;

pub fn mint_link_token(secret: &[u8], root: &str, roots: &[&str], dev: &str, iat: u64) -> String {
    // jti: two mints inside the same second MUST stay distinct capsules —
    // single-use burns the whole token hash, so identical payloads would
    // cross-burn each other (found by rootlink-sim T3 takeover).
    let now_nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let payload = serde_json::json!({
        "v": 1,
        "root": root,
        "roots": roots,
        "dev": dev,
        "iat": iat,
        "jti": format!("{now_nanos:x}"),
    });
    let body = b64url(payload.to_string().as_bytes());
    let sig = b64url(&hmac_sha256(secret, body.as_bytes()));
    format!("{body}.{sig}")
}

pub fn open_link_token(secret: &[u8], token: &str) -> Result<LinkToken, String> {
    let Some((body, sig)) = token.trim().split_once('.') else {
        return Err("link-token: missing signature".into());
    };
    let want = hmac_sha256(secret, body.as_bytes());
    let got = b64url_decode(sig).ok_or("link-token: sig not b64url")?;
    if !ct_eq(&want, &got) {
        return Err("link-token: HMAC mismatch".to_string());
    }
    let bytes = b64url_decode(body).ok_or("link-token: payload not b64url")?;
    let v: serde_json::Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    if v.get("v").and_then(|x| x.as_u64()) != Some(1) {
        return Err("link-token: unsupported version".into());
    }
    let root = v
        .get("root")
        .and_then(|x| x.as_str())
        .ok_or("link-token: root claim missing")?
        .to_string();
    let roots: Vec<String> = v
        .get("roots")
        .and_then(|x| x.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    let dev = v
        .get("dev")
        .and_then(|x| x.as_str())
        .unwrap_or("unknown-dev")
        .to_string();
    let iat = v.get("iat").and_then(|x| x.as_u64()).unwrap_or(0);
    // +6h expiry law: iat must exist and not be older than the TTL.
    // (now < iat is tolerated — clock skew between minting machines.)
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    if iat == 0 {
        return Err("link-token: missing iat claim".into());
    }
    if now > iat.saturating_add(LINK_TOKEN_TTL) {
        return Err("link-token: expired (>6h old)".into());
    }
    Ok(LinkToken {
        root,
        roots,
        dev,
        iat,
    })
}

/// Dispatch law — resolve a branch's root selection against the device
/// token's allowlist and the live registry. Pure so the harness unit-tests
/// every refusal:
///   * absent selection  → "local" (NO behavior change for existing flow)
///   * "local"           → the trunk's own root, always allowed
///   * remote id, not in the token's roots claim → refused (anonymous never)
///   * remote id, allowed but not dialed-in → "root not linked"
pub fn resolve_root(sel: Option<&str>, roots: &[String], reg: &crate::registry::Registry) -> Result<RootSel, String> {
    let sel = sel.unwrap_or("local");
    if !root_allowed(roots, sel) {
        return Err("root not allowed for device".into());
    }
    if sel != "local" && !reg.is_linked(sel) {
        return Err("root not linked".into());
    }
    Ok(RootSel(sel.to_string()))
}

/// The resolved target of a branch turn (newtype keeps call sites honest).
#[derive(Debug, Clone, PartialEq)]
pub struct RootSel(pub String);

/// Dispatch guard — pure so the e2e harness can unit-test every refusal.
/// Trunk-local root bypasses the allowlist (the trunk owns `local`).
pub fn root_allowed(roots: &[String], sel: &str) -> bool {
    sel == "local" || roots.iter().any(|r| r == sel)
}

/// Frame one JSON message for a root conn (job envelope over the wire).
pub fn job_frame(root: &str, tid: &str, kind: &str, body: serde_json::Value) -> String {
    serde_json::json!({
        "op": "root.job",
        "root": root,
        "tid": tid,
        "kind": kind, // "prompt" | "voice"
        "body": body,
    })
    .to_string()
}

#[derive(serde::Deserialize)]
#[serde(tag = "op")]
pub enum RootMsg {
    #[serde(rename = "root.hello")]
    Hello {},
    #[serde(rename = "root.ping")]
    Ping {},
    #[serde(rename = "root.result")]
    Result { tid: String, ok: bool, text: String },
    #[serde(skip)]
    Unknown,
}

// ---------------------------------------------------------------------------
// selftest — pure-law assertions (HMAC vs Python reference, tamper refusals,
// allowlist matrix). The e2e ws harness lives in bridge.rs v4 section.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    const PY_VECTOR: &str = "16976b4fc48e12501e6966443b60e7ada16d33d8272282e84fe46655e56f4dd4";

    #[test]
    fn hmac_matches_python() {
        let h = hex(&hmac_sha256(b"secret", b"root-link:mac-a"));
        assert_eq!(h, PY_VECTOR);
    }

    fn hex(b: &[u8]) -> String {
        b.iter().map(|x| format!("{x:02x}")).collect()
    }

    #[test]
    fn token_roundtrip_and_tamper() {
        // v4 expiry law: mint at NOW (iat=123 is 56 years stale → refused)
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let t = mint_link_token(b"k", "mac-a", &["mac-a", "mac-b"], "dev_x", now);
        let lt = open_link_token(b"k", &t).expect("open");
        assert_eq!(lt.root, "mac-a");
        assert_eq!(lt.roots, vec!["mac-a".to_string(), "mac-b".to_string()]);
        // wrong secret
        assert!(open_link_token(b"other", &t).is_err());
        // tampered payload byte
        let (body, sig) = t.split_once('.').unwrap();
        let mut tam = body.as_bytes().to_vec();
        tam[4] ^= 0x01;
        let tampered = format!("{}.{}", b64url(&tam), sig);
        assert!(open_link_token(b"k", &tampered).is_err());
    }

    #[test]
    fn allowlist_matrix() {
        let r = ["mac-a".to_string()];
        // anonymous (no claim) can ONLY ever reach local
        assert!(root_allowed(&[], "local"));
        assert!(!root_allowed(&[], "mac-a"));
        assert!(root_allowed(&r, "local"));
        assert!(root_allowed(&r, "mac-a"));
        assert!(!root_allowed(&r, "mac-c"));
    }

    #[test]
    fn expiry_enforced() {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let fresh = mint_link_token(b"k", "mac-a", &["mac-a"], "dev_x", now);
        assert!(open_link_token(b"k", &fresh).is_ok(), "fresh token refused");
        // minted 6h + 61s ago → refused
        let old = mint_link_token(b"k", "mac-a", &["mac-a"], "dev_x", now - LINK_TOKEN_TTL - 61);
        assert!(open_link_token(b"k", &old).is_err(), "expired token accepted");
        // missing iat (v1 shape without it) → refused
        let body = b64url(br#"{"v":1,"root":"mac-a"}"#);
        let sig = b64url(&hmac_sha256(b"k", body.as_bytes()));
        assert!(open_link_token(b"k", &format!("{body}.{sig}")).is_err());
    }
}
