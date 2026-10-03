//! Key material helpers — WireGuard-style base64 keys via boringtun's x25519.

use base64::Engine;
use boringtun::x25519::{PublicKey, StaticSecret};
use rand_core::{OsRng, RngCore};

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;

pub fn generate() -> (String, String) {
    let secret = StaticSecret::random_from_rng(OsRng);
    let public = PublicKey::from(&secret);
    (encode_secret(&secret), encode_public(&public))
}

pub fn encode_secret(k: &StaticSecret) -> String {
    B64.encode(k.as_bytes())
}

pub fn encode_public(k: &PublicKey) -> String {
    B64.encode(k.as_bytes())
}

pub fn decode_secret(s: &str) -> Result<StaticSecret, String> {
    let bytes = decode32(s)?;
    Ok(StaticSecret::from(bytes))
}

pub fn decode_public(s: &str) -> Result<PublicKey, String> {
    let bytes = decode32(s)?;
    Ok(PublicKey::from(bytes))
}

fn decode32(s: &str) -> Result<[u8; 32], String> {
    let v = B64
        .decode(s.trim())
        .map_err(|e| format!("bad base64 key: {e}"))?;
    v.try_into()
        .map_err(|v: Vec<u8>| format!("key must be 32 bytes, got {}", v.len()))
}

pub fn random_bytes(n: usize) -> Vec<u8> {
    let mut v = vec![0u8; n];
    OsRng.fill_bytes(&mut v);
    v
}
