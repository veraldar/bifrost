//! Access point — the public edge the phone dials (no tailscale, no port).
//!
//! `bifrost-net ap -c ap.toml` terminates TLS on 443 (rustls, TLS1.2+, HSTS
//! stamped on every response) and serves NOTHING itself: every browser
//! connection becomes one stream over the bridge's registered channel.
//!
//! The bridge (the box at home) dials OUT — the box never accepts inbound
//! internet. It opens `wss://<ap>/ap`, pins the ap's TLS public key (SPKI
//! sha-256, so a certbot renewal with --reuse-key keeps the pin), presents a
//! pairing-scoped Bearer the ap only knows by its sha-256, and is then the
//! ap's one upstream. Channel = RFC 6455 binary frames, each one mux message:
//!   [kind u8][stream id u32 BE][payload]   OPEN = "ip\n" + request head,
//!   DATA = raw bytes either way, CLOSE = the stream is over.
//!
//! Policy lives on the bridge, never the ap: the S1 gate (a live, unexpired,
//! region-bound device token on /api/* — /api/pair mints them) is checked
//! against the bridge's device registry, with the region of the REAL client
//! address the ap saw on its socket. The bridge then stamps X-Forwarded-For
//! (client-sent copies deleted — server.mjs BIFROST_TRUST_PROXY=1 reads it),
//! forces one request per connection (Connection: close; no pipelined
//! smuggling past the gate: only the declared body is forwarded) and passes
//! websocket upgrades through once the upstream answered 101.

use std::collections::HashMap;
use std::io;
use std::net::{IpAddr, SocketAddr};
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::Engine;
use rand_core::{OsRng, RngCore};
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::CryptoProvider;
use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, ServerName, UnixTime};
use rustls::{DigitallySignedStruct, SignatureScheme};
use serde::Deserialize;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, watch};
use tokio::time::timeout;
use tokio_rustls::{TlsAcceptor, TlsConnector};

use crate::region::region_of;
use crate::tokens::{bearer, hash_token, Deny, TokenStore};

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;
const WS_GUID: &str = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_HEAD: usize = 32 * 1024;
const MAX_FRAME: u64 = 1 << 20;
const OP_BIN: u8 = 0x2;
const OP_CLOSE: u8 = 0x8;
const OP_PING: u8 = 0x9;
const OP_PONG: u8 = 0xA;
const OPEN: u8 = 1;
const DATA: u8 = 2;
const CLOSE: u8 = 3;
const PING_EVERY: Duration = Duration::from_secs(15);
const SILENT: Duration = Duration::from_secs(45);

// ---- config ------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ApConfig {
    /// public TLS listen, e.g. "0.0.0.0:443" (or "127.0.0.1:8443" behind nginx SNI passthrough)
    pub listen: String,
    /// PEM chain + key — the site's certbot maintains them
    pub cert_path: String,
    pub key_path: String,
    /// sha-256 hex of the pairing token the bridge presents (`bifrost-net ap-token`)
    pub bridge_token_sha256: String,
    /// the bridge's channel path
    #[serde(default = "default_channel")]
    pub channel_path: String,
    #[serde(default = "default_hsts")]
    pub hsts: String,
}

fn default_channel() -> String { "/ap".into() }
fn default_hsts() -> String { "max-age=31536000".into() }

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ApFile {
    ap: ApConfig,
}

pub fn load(path: &str) -> Result<ApConfig, String> {
    let raw = std::fs::read_to_string(path).map_err(|e| format!("cannot read config {path}: {e}"))?;
    let f: ApFile = toml::from_str(&raw).map_err(|e| format!("config {path} invalid: {e}"))?;
    let h = f.ap.bridge_token_sha256.trim().to_ascii_lowercase();
    if h.len() != 64 || !h.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("ap.bridge_token_sha256 must be 64 hex chars (bifrost-net ap-token)".into());
    }
    Ok(ApConfig { bridge_token_sha256: h, ..f.ap })
}

/// Bridge side of the channel (bridge.toml `[ap]` + the bridge's registry).
pub struct DialConfig {
    pub url: String,
    pub pin: String,
    pub token: String,
    pub upstream: String,
    pub livekit: Option<String>,
    pub tokens: Arc<TokenStore>,
}

// ---- identity ------------------------------------------------------------------

fn provider() -> Arc<CryptoProvider> {
    Arc::new(rustls::crypto::ring::default_provider())
}

fn der_tlv(b: &[u8]) -> Option<(u8, usize, usize)> {
    let tag = *b.first()?;
    let l0 = *b.get(1)? as usize;
    if l0 < 0x80 {
        return Some((tag, 2, l0));
    }
    let n = l0 & 0x7f;
    if n == 0 || n > 4 {
        return None;
    }
    let mut len = 0usize;
    for i in 0..n {
        len = (len << 8) | *b.get(2 + i)? as usize;
    }
    Some((tag, 2 + n, len))
}

/// The SubjectPublicKeyInfo inside an X.509 certificate (DER walk, no crypto).
fn spki_of(cert: &[u8]) -> Option<&[u8]> {
    let (t, h, l) = der_tlv(cert)?;
    if t != 0x30 {
        return None;
    }
    let tbs = cert.get(h..h + l)?;
    let (t, h, l) = der_tlv(tbs)?;
    if t != 0x30 {
        return None;
    }
    let mut rest = tbs.get(h..h + l)?;
    let skip = |rest: &mut &[u8]| -> Option<()> {
        let (_, h, l) = der_tlv(rest)?;
        *rest = rest.get(h + l..)?;
        Some(())
    };
    if rest.first() == Some(&0xa0) {
        skip(&mut rest)?; // [0] version
    }
    for _ in 0..5 {
        skip(&mut rest)?; // serial, signature alg, issuer, validity, subject
    }
    let (t, h, l) = der_tlv(rest)?;
    if t != 0x30 {
        return None;
    }
    rest.get(..h + l)
}

/// "sha-256 AA:BB:…" of the certificate's public key — what the bridge pins.
pub fn pin_of(cert_der: &[u8]) -> Result<String, String> {
    use sha2::Digest as _;
    let spki = spki_of(cert_der).ok_or("certificate has no parsable SubjectPublicKeyInfo")?;
    let d = sha2::Sha256::digest(spki);
    let hex: Vec<String> = d.iter().map(|b| format!("{b:02X}")).collect();
    Ok(format!("sha-256 {}", hex.join(":")))
}

pub fn pin_of_pem(path: &str) -> Result<String, String> {
    let first = CertificateDer::pem_file_iter(path)
        .map_err(|e| format!("{path}: {e}"))?
        .next()
        .ok_or(format!("{path}: no certificate"))?
        .map_err(|e| format!("{path}: {e}"))?;
    pin_of(&first)
}

/// Accept exactly the pinned public key; the handshake signature is still
/// verified against it (possession of the key, not just the certificate).
#[derive(Debug)]
struct PinVerifier {
    pin: String,
    provider: Arc<CryptoProvider>,
}

impl ServerCertVerifier for PinVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        let got = pin_of(end_entity).map_err(rustls::Error::General)?;
        if got.eq_ignore_ascii_case(self.pin.trim()) {
            Ok(ServerCertVerified::assertion())
        } else {
            Err(rustls::Error::General(format!("ap identity mismatch: pinned {} got {got}", self.pin)))
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(message, cert, dss, &self.provider.signature_verification_algorithms)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(message, cert, dss, &self.provider.signature_verification_algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider.signature_verification_algorithms.supported_schemes()
    }
}

fn pinned_client(pin: &str) -> Result<TlsConnector, String> {
    let p = provider();
    let cc = rustls::ClientConfig::builder_with_provider(p.clone())
        .with_protocol_versions(&[&rustls::version::TLS13, &rustls::version::TLS12])
        .map_err(|e| e.to_string())?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(PinVerifier { pin: pin.to_string(), provider: p }))
        .with_no_client_auth();
    Ok(TlsConnector::from(Arc::new(cc)))
}

/// A fresh pairing credential: the raw token (bridge.toml) + its hash (ap.toml).
pub fn new_token() -> (String, String) {
    let mut b = [0u8; 32];
    OsRng.fill_bytes(&mut b);
    let raw: String = b.iter().map(|x| format!("{x:02x}")).collect();
    let h = hash_token(&raw);
    (raw, h)
}

/// Self-signed cert+key for local runs (the VPS uses the site's LE files).
pub fn self_signed(dir: &str, names: Vec<String>) -> Result<(String, String, String), String> {
    let ck = rcgen::generate_simple_self_signed(names).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let cert = format!("{dir}/cert.pem");
    let key = format!("{dir}/key.pem");
    std::fs::write(&cert, ck.cert.pem()).map_err(|e| e.to_string())?;
    std::fs::write(&key, ck.signing_key.serialize_pem()).map_err(|e| e.to_string())?;
    Ok((cert, key, pin_of(ck.cert.der())?))
}

// ---- wire: http heads, websocket frames, mux -------------------------------------

struct Req {
    method: String,
    path: String,
    version: String,
    headers: Vec<(String, String)>,
}

impl Req {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }
    fn cookie(&self, name: &str) -> Option<String> {
        self.headers
            .iter()
            .filter(|(k, _)| k.eq_ignore_ascii_case("cookie"))
            .flat_map(|(_, v)| v.split(';'))
            .filter_map(|c| c.trim().split_once('='))
            .find(|(k, _)| *k == name)
            .map(|(_, v)| v.to_string())
    }
}

fn parse_head(head: &[u8]) -> Result<Req, String> {
    let text = std::str::from_utf8(head).map_err(|_| "non-utf8 request head")?;
    let mut lines = text.split("\r\n");
    let first = lines.next().unwrap_or("");
    let mut parts = first.split(' ');
    let (Some(method), Some(path), Some(version), None) = (parts.next(), parts.next(), parts.next(), parts.next()) else {
        return Err("bad request line".into());
    };
    if method.is_empty() || !method.bytes().all(|b| b.is_ascii_uppercase()) || !path.starts_with('/') || !version.starts_with("HTTP/1.") {
        return Err("bad request line".into());
    }
    let mut headers = vec![];
    for line in lines {
        if line.is_empty() {
            break;
        }
        let (k, v) = line.split_once(':').ok_or("bad header")?;
        if k.is_empty() || k.bytes().any(|b| b <= b' ' || b == 0x7f) {
            return Err("bad header name".into());
        }
        headers.push((k.to_string(), v.trim().to_string()));
    }
    Ok(Req { method: method.into(), path: path.into(), version: version.into(), headers })
}

/// Read up to the end of the HTTP head; returns (head, bytes already read past it).
async fn read_head<R: AsyncRead + Unpin>(r: &mut R) -> io::Result<Option<(Vec<u8>, Vec<u8>)>> {
    let mut buf = Vec::with_capacity(4096);
    let mut chunk = [0u8; 4096];
    loop {
        if let Some(p) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            let rest = buf.split_off(p + 4);
            return Ok(Some((buf, rest)));
        }
        if buf.len() > MAX_HEAD {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "request head too large"));
        }
        let n = r.read(&mut chunk).await?;
        if n == 0 {
            return Ok(None);
        }
        buf.extend_from_slice(&chunk[..n]);
    }
}

fn ws_accept(key: &str) -> String {
    use sha1::Digest as _;
    B64.encode(sha1::Sha1::digest(format!("{}{WS_GUID}", key.trim()).as_bytes()))
}

async fn ws_send<W: AsyncWrite + Unpin>(w: &mut W, op: u8, payload: &[u8], masked: bool) -> io::Result<()> {
    let n = payload.len();
    let mut f = Vec::with_capacity(n + 14);
    f.push(0x80 | op);
    let m = if masked { 0x80 } else { 0 };
    if n < 126 {
        f.push(m | n as u8);
    } else if n < 65536 {
        f.push(m | 126);
        f.extend_from_slice(&(n as u16).to_be_bytes());
    } else {
        f.push(m | 127);
        f.extend_from_slice(&(n as u64).to_be_bytes());
    }
    if masked {
        let mut key = [0u8; 4];
        OsRng.fill_bytes(&mut key);
        f.extend_from_slice(&key);
        f.extend(payload.iter().enumerate().map(|(i, b)| b ^ key[i % 4]));
    } else {
        f.extend_from_slice(payload);
    }
    w.write_all(&f).await?;
    w.flush().await
}

async fn ws_recv<R: AsyncRead + Unpin>(r: &mut R) -> io::Result<(u8, Vec<u8>)> {
    let bad = |m: &str| io::Error::new(io::ErrorKind::InvalidData, m.to_string());
    let mut h = [0u8; 2];
    r.read_exact(&mut h).await?;
    if h[0] & 0x80 == 0 {
        return Err(bad("fragmented frames are not part of the channel"));
    }
    let mut n = (h[1] & 0x7f) as u64;
    if n == 126 {
        let mut b = [0u8; 2];
        r.read_exact(&mut b).await?;
        n = u16::from_be_bytes(b) as u64;
    } else if n == 127 {
        let mut b = [0u8; 8];
        r.read_exact(&mut b).await?;
        n = u64::from_be_bytes(b);
    }
    if n > MAX_FRAME {
        return Err(bad("frame too large"));
    }
    let mut key = [0u8; 4];
    if h[1] & 0x80 != 0 {
        r.read_exact(&mut key).await?;
    }
    let mut p = vec![0u8; n as usize];
    r.read_exact(&mut p).await?;
    if h[1] & 0x80 != 0 {
        for (i, b) in p.iter_mut().enumerate() {
            *b ^= key[i % 4];
        }
    }
    Ok((h[0] & 0x0f, p))
}

fn mux(kind: u8, id: u32, payload: &[u8]) -> (u8, Vec<u8>) {
    let mut m = Vec::with_capacity(5 + payload.len());
    m.push(kind);
    m.extend_from_slice(&id.to_be_bytes());
    m.extend_from_slice(payload);
    (OP_BIN, m)
}

fn unmux(m: &[u8]) -> Option<(u8, u32, &[u8])> {
    let id = u32::from_be_bytes(m.get(1..5)?.try_into().ok()?);
    Some((*m.first()?, id, &m[5..]))
}

fn http_response(status: u16, reason: &str, ctype: &str, body: &str) -> Vec<u8> {
    format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
    .into_bytes()
}

/// Insert HSTS after the status line once the response head is complete.
fn stamp_hsts(head: &[u8], hsts: &str) -> Option<Vec<u8>> {
    let end = head.windows(4).position(|w| w == b"\r\n\r\n")?;
    let line = head.windows(2).position(|w| w == b"\r\n")?;
    let lower = String::from_utf8_lossy(&head[..end]).to_ascii_lowercase();
    if lower.contains("\r\nstrict-transport-security:") {
        return Some(head.to_vec());
    }
    let mut out = Vec::with_capacity(head.len() + 64);
    out.extend_from_slice(&head[..line + 2]);
    out.extend_from_slice(format!("Strict-Transport-Security: {hsts}\r\n").as_bytes());
    out.extend_from_slice(&head[line + 2..]);
    Some(out)
}

// ---- the access point ----------------------------------------------------------------

type Frames = mpsc::UnboundedSender<(u8, Vec<u8>)>;
type StreamTx = mpsc::UnboundedSender<Option<Vec<u8>>>;

#[derive(Clone)]
struct Link {
    epoch: u64,
    out: Frames,
    streams: Arc<Mutex<HashMap<u32, StreamTx>>>,
}

#[derive(Default)]
struct Hub {
    link: Mutex<Option<Link>>,
    gens: AtomicU64,
    ids: AtomicU32,
}

pub fn run(path: &str) -> Result<(), String> {
    let cfg = load(path)?;
    println!("bifrost-net ap (config: {path})");
    let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().map_err(|e| e.to_string())?;
    rt.block_on(serve(cfg, None))
}

/// Start an ap on its own runtime thread (selftest); returns (addr, pin).
pub fn start_background(cfg: ApConfig) -> Result<(SocketAddr, String), String> {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().expect("tokio");
        let tx2 = tx.clone();
        if let Err(e) = rt.block_on(serve(cfg, Some(tx))) {
            let _ = tx2.send(Err(e));
        }
    });
    rx.recv_timeout(Duration::from_secs(5)).map_err(|_| "ap did not start".to_string())?
}

async fn serve(cfg: ApConfig, ready: Option<std::sync::mpsc::Sender<Result<(SocketAddr, String), String>>>) -> Result<(), String> {
    let certs: Vec<CertificateDer<'static>> = CertificateDer::pem_file_iter(&cfg.cert_path)
        .map_err(|e| format!("ap.cert_path {}: {e}", cfg.cert_path))?
        .collect::<Result<_, _>>()
        .map_err(|e| format!("ap.cert_path {}: {e}", cfg.cert_path))?;
    let pin = pin_of(certs.first().ok_or("ap.cert_path: empty chain")?)?;
    let key = PrivateKeyDer::from_pem_file(&cfg.key_path).map_err(|e| format!("ap.key_path {}: {e}", cfg.key_path))?;
    let mut sc = rustls::ServerConfig::builder_with_provider(provider())
        .with_protocol_versions(&[&rustls::version::TLS13, &rustls::version::TLS12])
        .map_err(|e| e.to_string())?
        .with_no_client_auth()
        .with_single_cert(certs, key)
        .map_err(|e| format!("ap cert/key: {e}"))?;
    sc.alpn_protocols = vec![b"http/1.1".to_vec()];
    let acceptor = TlsAcceptor::from(Arc::new(sc));
    let listener = TcpListener::bind(&cfg.listen).await.map_err(|e| format!("ap.listen {}: {e}", cfg.listen))?;
    let addr = listener.local_addr().map_err(|e| e.to_string())?;
    println!("  ap: https {addr} — LIVE (TLS1.2+, HSTS '{}')", cfg.hsts);
    println!("  ap: identity {pin}  (bridge.toml [ap] pin)");
    println!("  ap: bridge channel wss://<host>{} (Bearer, sha-256 admitted)", cfg.channel_path);
    if let Some(r) = ready {
        let _ = r.send(Ok((addr, pin)));
    }
    let hub = Arc::new(Hub::default());
    let cfg = Arc::new(cfg);
    loop {
        let (tcp, peer) = match listener.accept().await {
            Ok(x) => x,
            Err(e) => {
                eprintln!("  ap: accept: {e}");
                tokio::time::sleep(Duration::from_millis(100)).await;
                continue;
            }
        };
        let (acceptor, hub, cfg) = (acceptor.clone(), hub.clone(), cfg.clone());
        tokio::spawn(async move {
            let _ = tcp.set_nodelay(true);
            let Ok(Ok(tls)) = timeout(Duration::from_secs(10), acceptor.accept(tcp)).await else { return };
            let _ = edge_conn(tls, peer, hub, cfg).await;
        });
    }
}

async fn edge_conn(
    mut tls: tokio_rustls::server::TlsStream<TcpStream>,
    peer: SocketAddr,
    hub: Arc<Hub>,
    cfg: Arc<ApConfig>,
) -> io::Result<()> {
    let Ok(Ok(Some((head, rest)))) = timeout(Duration::from_secs(30), read_head(&mut tls)).await else {
        return Ok(());
    };
    let path = parse_head(&head).map(|r| r.path).unwrap_or_default();
    if path == cfg.channel_path || path.starts_with(&format!("{}?", cfg.channel_path)) {
        return bridge_link(tls, peer, &head, hub, cfg).await;
    }
    let stamped = |b: Vec<u8>| stamp_hsts(&b, &cfg.hsts).unwrap_or(b);
    let link = hub.link.lock().unwrap().clone();
    let Some(link) = link else {
        tls.write_all(&stamped(http_response(503, "Service Unavailable", "text/plain", "bifrost: the bridge is offline\n"))).await?;
        return tls.shutdown().await;
    };
    let id = hub.ids.fetch_add(1, Ordering::Relaxed) + 1;
    let (tx, mut rx) = mpsc::unbounded_channel::<Option<Vec<u8>>>();
    link.streams.lock().unwrap().insert(id, tx);
    let mut open = format!("{}\n", peer.ip().to_canonical()).into_bytes();
    open.extend_from_slice(&head);
    let _ = link.out.send(mux(OPEN, id, &open));
    if !rest.is_empty() {
        let _ = link.out.send(mux(DATA, id, &rest));
    }
    let (mut rd, mut wr) = tokio::io::split(tls);
    let up = link.out.clone();
    let reader = tokio::spawn(async move {
        let mut buf = vec![0u8; 16384];
        loop {
            match rd.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if up.send(mux(DATA, id, &buf[..n])).is_err() {
                        break;
                    }
                }
            }
        }
        let _ = up.send(mux(CLOSE, id, &[]));
    });
    let mut pending: Option<Vec<u8>> = Some(vec![]);
    while let Some(Some(chunk)) = rx.recv().await {
        if let Some(mut hb) = pending.take() {
            hb.extend_from_slice(&chunk);
            match stamp_hsts(&hb, &cfg.hsts) {
                Some(out) => wr.write_all(&out).await?,
                None if hb.len() > MAX_HEAD => wr.write_all(&hb).await?,
                None => pending = Some(hb),
            }
            continue;
        }
        if wr.write_all(&chunk).await.is_err() {
            break;
        }
    }
    if let Some(hb) = pending.filter(|b| !b.is_empty()) {
        let _ = wr.write_all(&hb).await;
    }
    let _ = wr.shutdown().await;
    reader.abort();
    link.streams.lock().unwrap().remove(&id);
    let _ = link.out.send(mux(CLOSE, id, &[]));
    Ok(())
}

async fn bridge_link(
    mut tls: tokio_rustls::server::TlsStream<TcpStream>,
    peer: SocketAddr,
    head: &[u8],
    hub: Arc<Hub>,
    cfg: Arc<ApConfig>,
) -> io::Result<()> {
    let req = parse_head(head).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    let raw = req.header("authorization").and_then(bearer).unwrap_or("");
    if raw.len() < 16 || hash_token(raw) != cfg.bridge_token_sha256 {
        eprintln!("  ap: bridge registration from {peer} REFUSED (bad pairing token)");
        tls.write_all(&http_response(401, "Unauthorized", "text/plain", "bridge token required\n")).await?;
        return tls.shutdown().await;
    }
    let Some(key) = req.header("sec-websocket-key").filter(|_| {
        req.header("upgrade").is_some_and(|u| u.eq_ignore_ascii_case("websocket"))
    }) else {
        tls.write_all(&http_response(400, "Bad Request", "text/plain", "websocket upgrade required\n")).await?;
        return tls.shutdown().await;
    };
    let resp = format!(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {}\r\n\r\n",
        ws_accept(key)
    );
    tls.write_all(resp.as_bytes()).await?;
    let (mut rd, mut wr) = tokio::io::split(tls);
    let (out, mut out_rx) = mpsc::unbounded_channel::<(u8, Vec<u8>)>();
    let streams: Arc<Mutex<HashMap<u32, StreamTx>>> = Arc::default();
    let epoch = hub.gens.fetch_add(1, Ordering::Relaxed) + 1;
    let old = hub.link.lock().unwrap().replace(Link { epoch, out: out.clone(), streams: streams.clone() });
    if let Some(old) = old {
        old.streams.lock().unwrap().clear();
        let _ = old.out.send((OP_CLOSE, vec![]));
    }
    println!("  ap: bridge registered from {peer} (link #{epoch}) — serving");
    let writer = tokio::spawn(async move {
        while let Some((op, p)) = out_rx.recv().await {
            if ws_send(&mut wr, op, &p, false).await.is_err() || op == OP_CLOSE {
                break;
            }
        }
        let _ = wr.shutdown().await;
    });
    loop {
        let Ok(Ok((op, p))) = timeout(SILENT, ws_recv(&mut rd)).await else { break };
        match op {
            OP_BIN => {
                let Some((kind, id, body)) = unmux(&p) else { continue };
                match kind {
                    DATA => {
                        let tx = streams.lock().unwrap().get(&id).cloned();
                        if let Some(tx) = tx {
                            let _ = tx.send(Some(body.to_vec()));
                        }
                    }
                    CLOSE => {
                        if let Some(tx) = streams.lock().unwrap().remove(&id) {
                            let _ = tx.send(None);
                        }
                    }
                    _ => {}
                }
            }
            OP_PING => {
                let _ = out.send((OP_PONG, p));
            }
            OP_CLOSE => break,
            _ => {}
        }
    }
    {
        let mut l = hub.link.lock().unwrap();
        if l.as_ref().map(|x| x.epoch) == Some(epoch) {
            *l = None;
        }
    }
    streams.lock().unwrap().clear();
    let _ = out.send((OP_CLOSE, vec![]));
    let _ = timeout(Duration::from_secs(2), writer).await;
    println!("  ap: bridge link #{epoch} down");
    Ok(())
}

// ---- the bridge's dial-out half ------------------------------------------------------------

/// Keep a channel to the ap up forever (reconnect with backoff).
pub fn spawn_dialer(cfg: DialConfig) {
    std::thread::Builder::new()
        .name("ap-dialer".into())
        .spawn(move || {
            let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().expect("tokio");
            rt.block_on(dial_forever(Arc::new(cfg)));
        })
        .expect("ap dialer thread");
}

async fn dial_forever(cfg: Arc<DialConfig>) {
    let mut backoff = 1u64;
    loop {
        let t0 = Instant::now();
        match dial_once(&cfg).await {
            Ok(()) => eprintln!("  ap: channel closed by the ap"),
            Err(e) => eprintln!("  ap: {e}"),
        }
        if t0.elapsed() > Duration::from_secs(30) {
            backoff = 1;
        }
        tokio::time::sleep(Duration::from_secs(backoff)).await;
        backoff = (backoff * 2).min(30);
    }
}

fn parse_wss(url: &str) -> Result<(String, u16, String), String> {
    let rest = url.strip_prefix("wss://").ok_or("ap.url must be wss://host[:port]/path")?;
    let (hostport, path) = rest.split_once('/').map(|(h, p)| (h, format!("/{p}"))).unwrap_or((rest, "/ap".into()));
    let (host, port) = match hostport.rsplit_once(':') {
        Some((h, p)) if !h.ends_with(']') || h.starts_with('[') => (h, p.parse().map_err(|_| "ap.url: bad port")?),
        _ => (hostport, 443),
    };
    Ok((host.trim_matches(|c| c == '[' || c == ']').to_string(), port, path))
}

async fn dial_once(cfg: &Arc<DialConfig>) -> Result<(), String> {
    let (host, port, path) = parse_wss(&cfg.url)?;
    let tcp = timeout(Duration::from_secs(10), TcpStream::connect((host.as_str(), port)))
        .await
        .map_err(|_| format!("connect {host}:{port}: timeout"))?
        .map_err(|e| format!("connect {host}:{port}: {e}"))?;
    let _ = tcp.set_nodelay(true);
    let name = ServerName::try_from(host.clone()).map_err(|e| format!("ap host {host}: {e}"))?;
    let mut tls = timeout(Duration::from_secs(10), pinned_client(&cfg.pin)?.connect(name, tcp))
        .await
        .map_err(|_| "tls: timeout".to_string())?
        .map_err(|e| format!("tls: {e}"))?;
    let mut k = [0u8; 16];
    OsRng.fill_bytes(&mut k);
    let key = B64.encode(k);
    let req = format!(
        "GET {path} HTTP/1.1\r\nHost: {host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\nAuthorization: Bearer {}\r\n\r\n",
        cfg.token.trim()
    );
    tls.write_all(req.as_bytes()).await.map_err(|e| e.to_string())?;
    let (head, _) = timeout(Duration::from_secs(10), read_head(&mut tls))
        .await
        .map_err(|_| "upgrade: timeout".to_string())?
        .map_err(|e| e.to_string())?
        .ok_or("ap closed during the upgrade")?;
    let text = String::from_utf8_lossy(&head);
    if !text.starts_with("HTTP/1.1 101") {
        return Err(format!("ap refused the bridge: {}", text.lines().next().unwrap_or("")));
    }
    if !text.contains(&ws_accept(&key)) {
        return Err("ap upgrade answer has the wrong Sec-WebSocket-Accept".into());
    }
    println!("  ap: channel up — {} (pinned {})", cfg.url, cfg.pin);
    let (mut rd, mut wr) = tokio::io::split(tls);
    let (out, mut out_rx) = mpsc::unbounded_channel::<(u8, Vec<u8>)>();
    let writer = tokio::spawn(async move {
        while let Some((op, p)) = out_rx.recv().await {
            if ws_send(&mut wr, op, &p, true).await.is_err() {
                break;
            }
        }
    });
    let ping = {
        let out = out.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(PING_EVERY).await;
                if out.send((OP_PING, vec![])).is_err() {
                    break;
                }
            }
        })
    };
    let mut streams: HashMap<u32, StreamTx> = HashMap::new();
    let res = loop {
        let (op, p) = match timeout(SILENT, ws_recv(&mut rd)).await {
            Ok(Ok(x)) => x,
            Ok(Err(e)) => break Err(format!("channel: {e}")),
            Err(_) => break Err("channel: ap silent 45s".into()),
        };
        match op {
            OP_BIN => {
                let Some((kind, id, body)) = unmux(&p) else { continue };
                match kind {
                    OPEN => {
                        let (tx, rx) = mpsc::unbounded_channel();
                        streams.insert(id, tx);
                        tokio::spawn(serve_stream(cfg.clone(), id, body.to_vec(), rx, out.clone()));
                    }
                    DATA => {
                        if let Some(tx) = streams.get(&id) {
                            let _ = tx.send(Some(body.to_vec()));
                        }
                    }
                    CLOSE => {
                        if let Some(tx) = streams.remove(&id) {
                            let _ = tx.send(None);
                        }
                    }
                    _ => {}
                }
                streams.retain(|_, tx| !tx.is_closed());
            }
            OP_PING => {
                let _ = out.send((OP_PONG, p));
            }
            OP_CLOSE => break Ok(()),
            _ => {}
        }
    };
    ping.abort();
    writer.abort();
    res
}

/// The S1 gate, on the bridge: /api/* needs a live device token issued in the
/// region of the client's REAL address (as the ap saw it). /api/pair mints.
fn gate(tokens: &TokenStore, req: &Req, ip: IpAddr) -> Result<(), Deny> {
    let p = req.path.split('?').next().unwrap_or("");
    if !(p == "/api" || p.starts_with("/api/")) || p == "/api/pair" || p.starts_with("/api/pair/") {
        return Ok(());
    }
    let raw = req
        .header("authorization")
        .and_then(bearer)
        .map(str::to_string)
        .or_else(|| req.cookie("bifrost_device"))
        .unwrap_or_default();
    tokens.check(&raw, &region_of(ip)).map(|_| ())
}

fn rewrite_head(req: &Req, ip: IpAddr, upgrade: bool) -> Vec<u8> {
    const DROP: &[&str] = &[
        "connection", "keep-alive", "proxy-connection", "forwarded", "x-forwarded-for",
        "x-forwarded-proto", "x-forwarded-host", "x-real-ip", "x-bifrost-peer",
    ];
    let mut s = format!("{} {} {}\r\n", req.method, req.path, req.version);
    for (k, v) in &req.headers {
        if !DROP.contains(&k.to_ascii_lowercase().as_str()) {
            s.push_str(&format!("{k}: {v}\r\n"));
        }
    }
    s.push_str(if upgrade { "Connection: Upgrade\r\n" } else { "Connection: close\r\n" });
    s.push_str(&format!("X-Forwarded-For: {ip}\r\nX-Forwarded-Proto: https\r\n"));
    if let Some(h) = req.header("host") {
        s.push_str(&format!("X-Forwarded-Host: {h}\r\n"));
    }
    s.push_str("\r\n");
    s.into_bytes()
}

async fn serve_stream(
    cfg: Arc<DialConfig>,
    id: u32,
    open: Vec<u8>,
    mut rx: mpsc::UnboundedReceiver<Option<Vec<u8>>>,
    out: Frames,
) {
    let reply = |bytes: Vec<u8>| {
        let _ = out.send(mux(DATA, id, &bytes));
        let _ = out.send(mux(CLOSE, id, &[]));
    };
    let Some(nl) = open.iter().position(|&b| b == b'\n') else { return reply(vec![]) };
    let Some(ip) = std::str::from_utf8(&open[..nl]).ok().and_then(|s| s.parse::<IpAddr>().ok()) else {
        return reply(vec![]);
    };
    let req = match parse_head(&open[nl + 1..]) {
        Ok(r) => r,
        Err(e) => return reply(http_response(400, "Bad Request", "text/plain", &format!("{e}\n"))),
    };
    if let Err(d) = gate(&cfg.tokens, &req, ip) {
        let body = serde_json::json!({ "error": "device token required", "why": d.why(), "reauth": d.reauth() }).to_string();
        return reply(http_response(401, "Unauthorized", "application/json", &body));
    }
    // one request per connection: only the declared body passes (no pipelined
    // request can ride past the gate); chunked request bodies are refused
    if req.header("transfer-encoding").is_some() {
        return reply(http_response(411, "Length Required", "text/plain", "chunked request bodies are not proxied\n"));
    }
    let lens: Vec<&str> = req.headers.iter().filter(|(k, _)| k.eq_ignore_ascii_case("content-length")).map(|(_, v)| v.as_str()).collect();
    if lens.len() > 1 && lens.iter().any(|l| *l != lens[0]) {
        return reply(http_response(400, "Bad Request", "text/plain", "conflicting content-length\n"));
    }
    let Ok(mut budget) = lens.first().map(|l| l.parse::<u64>()).unwrap_or(Ok(0)) else {
        return reply(http_response(400, "Bad Request", "text/plain", "bad content-length\n"));
    };
    let upgrade = req.header("upgrade").is_some();
    let p = req.path.split('?').next().unwrap_or("");
    let target = match &cfg.livekit {
        Some(lk) if p == "/rtc" || p.starts_with("/rtc/") => lk.clone(),
        _ => cfg.upstream.clone(),
    };
    let up = match TcpStream::connect(&target).await {
        Ok(s) => s,
        Err(e) => return reply(http_response(502, "Bad Gateway", "text/plain", &format!("bifrost: upstream {target}: {e}\n"))),
    };
    let _ = up.set_nodelay(true);
    let (mut ur, mut uw) = up.into_split();
    if uw.write_all(&rewrite_head(&req, ip, upgrade)).await.is_err() {
        return reply(vec![]);
    }
    let (switched_tx, mut switched) = watch::channel(false);
    let out2 = out.clone();
    let pump = tokio::spawn(async move {
        let mut buf = vec![0u8; 16384];
        let mut first = true;
        loop {
            match ur.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if first && buf[..n].starts_with(b"HTTP/1.1 101") {
                        let _ = switched_tx.send(true);
                    }
                    first = false;
                    if out2.send(mux(DATA, id, &buf[..n])).is_err() {
                        break;
                    }
                }
            }
        }
        let _ = out2.send(mux(CLOSE, id, &[]));
    });
    while let Some(Some(chunk)) = rx.recv().await {
        let mut take = chunk.len();
        if !*switched.borrow() {
            if budget == 0 && upgrade {
                // the client speaks first after an upgrade: wait for the 101
                if !matches!(timeout(Duration::from_secs(15), switched.wait_for(|v| *v)).await, Ok(Ok(_))) {
                    break;
                }
            } else {
                take = take.min(budget as usize);
                budget -= take as u64;
            }
        }
        if take > 0 && uw.write_all(&chunk[..take]).await.is_err() {
            break;
        }
    }
    let _ = uw.shutdown().await;
    pump.abort();
}

// ---- selftest: the whole chain in one process --------------------------------------------

pub fn selftest() -> Result<String, String> {
    let dir = std::env::temp_dir().join(format!("bifrost-ap-{}", std::process::id()));
    let dir_s = dir.to_string_lossy().to_string();
    let (cert, key, pin) = self_signed(&dir_s, vec!["localhost".into(), "127.0.0.1".into()])?;
    if pin_of_pem(&cert)? != pin {
        return Err("pin of the PEM file differs from the generated cert's".into());
    }
    let (bridge_tok, bridge_hash) = new_token();
    let (ap_addr, ap_pin) = start_background(ApConfig {
        listen: "127.0.0.1:0".into(),
        cert_path: cert,
        key_path: key,
        bridge_token_sha256: bridge_hash,
        channel_path: "/ap".into(),
        hsts: "max-age=31536000".into(),
    })?;
    if ap_pin != pin {
        return Err("ap announces a different pin".into());
    }

    // the upstream stand-in: echoes what it was sent; upgrades become a raw echo
    let upstream = std::net::TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let up_addr = upstream.local_addr().map_err(|e| e.to_string())?;
    std::thread::spawn(move || {
        for s in upstream.incoming().flatten() {
            std::thread::spawn(move || stub_upstream(s));
        }
    });

    // device registry: one loopback-region token (the region curl on this box has)
    let dev_tok = "dev-token-0123456789abcdef";
    let reg = serde_json::json!({ "version": 2, "killEpoch": 0, "devices": [
        { "id": "phone-1", "revoked": false, "access": [
            { "hash": hash_token(dev_tok), "exp": crate::tokens::now_ms() + 3_600_000, "region": "loopback" } ] } ] });
    let reg_path = dir.join("devices.json");
    std::fs::write(&reg_path, reg.to_string()).map_err(|e| e.to_string())?;

    // a bridge with the WRONG token is refused; with a wrong pin it never connects
    let url = format!("wss://127.0.0.1:{}/ap", ap_addr.port());
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().map_err(|e| e.to_string())?;
    let mk = |pin: &str, token: &str| {
        Arc::new(DialConfig {
            url: url.clone(),
            pin: pin.into(),
            token: token.into(),
            upstream: up_addr.to_string(),
            livekit: None,
            tokens: Arc::new(TokenStore::open(&reg_path)),
        })
    };
    let bad_tok = rt.block_on(async { timeout(Duration::from_secs(5), dial_once(&mk(&pin, "not-the-pairing-token-000"))).await });
    match bad_tok {
        Ok(Err(e)) if e.contains("401") => {}
        other => return Err(format!("wrong pairing token was not refused: {other:?}")),
    }
    let wrong_pin = "sha-256 00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF";
    let bad_pin = rt.block_on(async { timeout(Duration::from_secs(5), dial_once(&mk(wrong_pin, &bridge_tok))).await });
    match bad_pin {
        Ok(Err(e)) if e.contains("tls") => {}
        other => return Err(format!("wrong pin was not refused: {other:?}")),
    }

    // the real bridge
    let good = mk(&pin, &bridge_tok);
    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().expect("tokio");
        rt.block_on(dial_forever(good));
    });

    let client = |raw_req: Vec<u8>, follow: Option<Vec<u8>>| -> Result<Vec<u8>, String> {
        rt.block_on(async {
            let tcp = TcpStream::connect(ap_addr).await.map_err(|e| e.to_string())?;
            let mut tls = pinned_client(&pin)?
                .connect(ServerName::try_from("localhost").unwrap(), tcp)
                .await
                .map_err(|e| e.to_string())?;
            tls.write_all(&raw_req).await.map_err(|e| e.to_string())?;
            let mut got = vec![];
            if let Some(f) = follow {
                // websocket-style: wait for the 101, then speak
                let (h, rest) = read_head(&mut tls).await.map_err(|e| e.to_string())?.ok_or("closed before 101")?;
                got.extend_from_slice(&h);
                got.extend_from_slice(&rest);
                tls.write_all(&f).await.map_err(|e| e.to_string())?;
                let mut buf = vec![0u8; f.len()];
                let have = rest.len().min(f.len());
                buf[..have].copy_from_slice(&rest[..have]);
                timeout(Duration::from_secs(5), tls.read_exact(&mut buf[have..]))
                    .await
                    .map_err(|_| "echo timeout")?
                    .map_err(|e| e.to_string())?;
                got.extend_from_slice(&buf[have..]);
                return Ok(got);
            }
            timeout(Duration::from_secs(5), tls.read_to_end(&mut got))
                .await
                .map_err(|_| "response timeout".to_string())?
                .ok();
            Ok(got)
        })
    };

    // wait for the registration
    let t0 = Instant::now();
    loop {
        let r = client(b"GET / HTTP/1.1\r\nHost: localhost\r\n\r\n".to_vec(), None)?;
        if !r.starts_with(b"HTTP/1.1 503") {
            break;
        }
        if t0.elapsed() > Duration::from_secs(8) {
            return Err("bridge never registered".into());
        }
        std::thread::sleep(Duration::from_millis(150));
    }

    let text = |b: &[u8]| String::from_utf8_lossy(b).to_string();
    // 1. shell page: answered through the chain, HSTS stamped, client XFF replaced by the real peer
    let r = text(&client(b"GET /?x=1 HTTP/1.1\r\nHost: localhost\r\nX-Forwarded-For: 6.6.6.6\r\nX-Bifrost-Peer: 6.6.6.6\r\n\r\n".to_vec(), None)?);
    if !r.starts_with("HTTP/1.1 200") || !r.contains("Strict-Transport-Security: max-age=31536000") {
        return Err(format!("GET / through the chain: {r}"));
    }
    if !r.contains("xff=127.0.0.1;") || r.contains("6.6.6.6") || !r.contains("path=/?x=1;") {
        return Err(format!("forwarded-for not rewritten to the real peer: {r}"));
    }
    // 2. gate: /api without a token → 401 from the bridge (never reaches the upstream)
    let r = text(&client(b"GET /api/sessions HTTP/1.1\r\nHost: localhost\r\n\r\n".to_vec(), None)?);
    if !r.starts_with("HTTP/1.1 401") || !r.contains("\"why\":\"missing\"") {
        return Err(format!("uncredentialed /api not refused: {r}"));
    }
    let r = text(&client(b"GET /api/sessions HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer wrong-token-0123456789\r\n\r\n".to_vec(), None)?);
    if !r.starts_with("HTTP/1.1 401") || !r.contains("\"why\":\"invalid\"") {
        return Err(format!("bad token not refused: {r}"));
    }
    // 3. device token (Bearer and cookie) passes; /api/pair needs none
    let r = text(&client(format!("GET /api/sessions HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer {dev_tok}\r\n\r\n").into_bytes(), None)?);
    if !r.starts_with("HTTP/1.1 200") || !r.contains("path=/api/sessions;") {
        return Err(format!("device-token'd request did not pass: {r}"));
    }
    let r = text(&client(format!("GET /api/x HTTP/1.1\r\nHost: localhost\r\nCookie: a=b; bifrost_device={dev_tok}\r\n\r\n").into_bytes(), None)?);
    if !r.starts_with("HTTP/1.1 200") {
        return Err(format!("cookie device token did not pass: {r}"));
    }
    let r = text(&client(b"POST /api/pair/redeem HTTP/1.1\r\nHost: localhost\r\nContent-Length: 0\r\n\r\n".to_vec(), None)?);
    if !r.starts_with("HTTP/1.1 200") {
        return Err(format!("/api/pair was gated: {r}"));
    }
    // 4. POST body byte-exact; a pipelined request smuggled behind it never reaches the upstream
    let body: String = (0..5000).map(|i| char::from(b'a' + (i % 26) as u8)).collect();
    let mut req = format!("POST /echo HTTP/1.1\r\nHost: localhost\r\nContent-Length: {}\r\n\r\n{body}", body.len()).into_bytes();
    req.extend_from_slice(b"GET /api/sessions HTTP/1.1\r\nHost: localhost\r\n\r\n");
    let r = text(&client(req, None)?);
    if !r.contains(&format!("body={body};")) || r.contains("smuggled") {
        return Err(format!("POST body / smuggling guard: {}", &r[..r.len().min(300)]));
    }
    // 5. websocket upgrade through the chain: 101 then bytes echo byte-exact
    let probe: Vec<u8> = (0..=255u8).cycle().take(3000).collect();
    let r = client(
        b"GET /api/run-events HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nAuthorization: Bearer dev-token-0123456789abcdef\r\n\r\n".to_vec(),
        Some(probe.clone()),
    )?;
    if !r.starts_with(b"HTTP/1.1 101") || !r.ends_with(&probe) {
        return Err(format!("websocket passthrough failed: {}", text(&r[..r.len().min(200)])));
    }
    let _ = std::fs::remove_dir_all(&dir);
    Ok(format!(
        "pin {}…; wrong pairing token 401 + wrong pin refused; GET / 200 + HSTS + XFF=real peer (spoofed dropped); \
         /api 401 missing/invalid, Bearer+cookie pass, /api/pair open; 5000-byte POST exact + smuggled request dropped; \
         websocket 101 + 3000 bytes echoed byte-exact",
        &pin[..20]
    ))
}

/// Upstream stand-in: one request per connection (as the bridge sends them).
fn stub_upstream(mut s: std::net::TcpStream) {
    use std::io::{Read, Write};
    let mut buf = vec![];
    let mut chunk = [0u8; 8192];
    let head_end = loop {
        if let Some(p) = buf.windows(4).position(|w: &[u8]| w == b"\r\n\r\n") {
            break p + 4;
        }
        match s.read(&mut chunk) {
            Ok(0) | Err(_) => return,
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
        }
    };
    let Ok(req) = parse_head(&buf[..head_end]) else { return };
    if req.header("upgrade").is_some() {
        let _ = s.write_all(b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
        let _ = s.write_all(&buf[head_end..]);
        while let Ok(n) = s.read(&mut chunk) {
            if n == 0 || s.write_all(&chunk[..n]).is_err() {
                break;
            }
        }
        return;
    }
    let want: usize = req.header("content-length").and_then(|l| l.parse().ok()).unwrap_or(0);
    while buf.len() < head_end + want {
        match s.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
        }
    }
    // anything past the declared body would be a smuggled request
    let _ = s.set_read_timeout(Some(Duration::from_millis(300)));
    if let Ok(n) = s.read(&mut chunk) {
        buf.extend_from_slice(&chunk[..n]);
    }
    let body_end = (head_end + want).min(buf.len());
    let extra = if buf.len() > body_end { "smuggled" } else { "" };
    let out = format!(
        "path={};xff={};conn={};body={};{extra}",
        req.path,
        req.header("x-forwarded-for").unwrap_or(""),
        req.header("connection").unwrap_or(""),
        String::from_utf8_lossy(&buf[head_end..body_end])
    );
    let _ = s.write_all(&http_response(200, "OK", "text/plain", &out));
}
