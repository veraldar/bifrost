//! The trunk's root ↔ root leg: brain-to-brain HTTP inside WireGuard, end to end between roots.
//!
//! Every root (the hub included) runs one `bifrost-net wg` node. It holds the root's WireGuard
//! key (mode 600, never leaves it), a userspace TCP/IP stack (smoltcp) over boringtun tunnels,
//! and two HTTP doors:
//!   * the FRONT door, loopback only: `ANY http://127.0.0.1:<http>/_wg/<peer>/<path>` is one
//!     HTTP exchange with that peer's brain, carried inside the tunnel. The brain only needs
//!     URLs: `YGG_PEERS home=http://127.0.0.1:<http>/_wg/local` on a joined root,
//!     `YGG_PEERS_FROM=…/_wg` + `YGG_PEERS_VIA=…/_wg/{id}` on the hub. `GET /_wg` lists the
//!     peers (`[{id, ip, fingerprint, up, handshakes, …}]`), `GET /_wg/_node` the node.
//!   * the IN-TUNNEL door: TCP port 80 on the node's tunnel address. A peer's exchange is
//!     performed against this root's own brain. Only `content-type` and `x-ygg-peer` cross,
//!     both ways (the switchboard's header law).
//!
//! Transport: WireGuard datagrams never touch the internet as UDP. They ride the root-link
//! that already exists (binary ws frames over the dial-out wss), and the hub's bridge relays
//! them: root → hub → root, and root ↔ the hub's own node (a loopback UDP pair). Each datagram
//! on every relay leg is one RELAY FRAME:
//!
//!     [n: u8][n bytes: address][WireGuard datagram]
//!
//! Towards the relay the address is the destination (`local` = the hub's node, else a root
//! id); from the relay it is the source, as the bridge saw it: the root id of the authenticated
//! link it came in on (never what the sender claimed). The relay cannot read or forge anything:
//! it sees handshakes and ciphertext only.
//!
//! Trust: a peer exists only if its public key was pinned. A joined root has one static peer,
//! the hub (`local`), whose key came with its approval. The hub's peers are the roots in the
//! app's roots.json that carry a pinned `wg_pub` + `wg_ip`, are not `revoked`, and whose
//! approving device (`dev`) is still live in devices.json — re-read every second, so revoking
//! the device or removing the root cuts its tunnel at once. A datagram is accepted only from
//! the relay address, only for a known key, and only when the relay's source matches the
//! link that key is pinned to; inner packets only from the peer's own tunnel address.

use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::net::{Ipv4Addr, Shutdown, SocketAddr, TcpListener, TcpStream, UdpSocket};
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::time::{Duration, Instant};

use base64::Engine as _;
use boringtun::noise::errors::WireGuardError;
use boringtun::noise::handshake::parse_handshake_anon;
use boringtun::noise::{Packet, Tunn, TunnResult};
use boringtun::x25519::{PublicKey, StaticSecret};
use rand_core::{OsRng, RngCore};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use smoltcp::iface::{Config as IfaceConfig, Interface, SocketHandle, SocketSet};
use smoltcp::phy::{Device, DeviceCapabilities, Medium, RxToken, TxToken};
use smoltcp::socket::tcp;
use smoltcp::wire::{HardwareAddress, IpAddress, IpCidr};

use crate::registry::Registry;
use crate::switch::{self, HttpReply, HttpReq};

/// Inner packets are at most this big (the WireGuard default: fits a 1500-byte path if a
/// direct UDP leg is ever added; the ws relay itself has no limit).
pub const MTU: usize = 1420;
/// The in-tunnel door on every node's tunnel address.
pub const IN_TUNNEL_PORT: u16 = 80;
/// How long a front-door call waits for the TCP connection through the tunnel (the
/// WireGuard handshake rides inside this).
const CONNECT_WAIT: Duration = Duration::from_secs(10);
/// One exchange, end to end (the switchboard's wait).
const CALL_WAIT: Duration = Duration::from_secs(120);
/// Inbound connections served at once; listening sockets kept ready.
const MAX_INBOUND: usize = 32;
const LISTENERS: usize = 4;
/// Streams of all kinds at once.
const MAX_STREAMS: usize = 96;
const TCP_BUF: usize = 256 * 1024;
const PERSISTENT_KEEPALIVE: u16 = 25;
const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;

/* ------------------------------------------------------------------ relay frames */

/// `local` or a root id (the switchboard's shape).
pub fn valid_addr(a: &str) -> bool {
    !a.is_empty() && a.len() <= 64 && a.bytes().all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
}

/// One relay frame: `[n][address][datagram]`.
pub fn frame(addr: &str, dgram: &[u8]) -> Vec<u8> {
    let mut v = Vec::with_capacity(1 + addr.len() + dgram.len());
    v.push(addr.len() as u8);
    v.extend_from_slice(addr.as_bytes());
    v.extend_from_slice(dgram);
    v
}

/// (address, datagram) of a relay frame; None = malformed.
pub fn unframe(buf: &[u8]) -> Option<(&str, &[u8])> {
    let n = *buf.first()? as usize;
    if buf.len() < 1 + n {
        return None;
    }
    let addr = std::str::from_utf8(&buf[1..1 + n]).ok()?;
    valid_addr(addr).then_some((addr, &buf[1 + n..]))
}

/// The four WireGuard message kinds, by type and length — all the relay ever checks.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WgKind {
    Init,
    Response,
    Cookie,
    Data,
}

pub fn wg_kind(d: &[u8]) -> Option<WgKind> {
    if d.len() < 4 || d[1..4] != [0, 0, 0] {
        return None;
    }
    match (d[0], d.len()) {
        (1, 148) => Some(WgKind::Init),
        (2, 92) => Some(WgKind::Response),
        (3, 64) => Some(WgKind::Cookie),
        // header 16 + payload + tag 16 (boringtun does not pad the payload)
        (4, n) if n >= 32 => Some(WgKind::Data),
        _ => None,
    }
}

/// The short fingerprint the owner compares on the approve page: the first 6 bytes of
/// sha256(raw 32-byte public key), hex, `xxxx-xxxx-xxxx`.
pub fn fingerprint(public: &[u8; 32]) -> String {
    let d = Sha256::digest(public);
    let h: String = d[..6].iter().map(|b| format!("{b:02x}")).collect();
    format!("{}-{}-{}", &h[0..4], &h[4..8], &h[8..12])
}

pub fn decode_key(s: &str) -> Result<[u8; 32], String> {
    let v = B64.decode(s.trim()).map_err(|e| format!("bad base64 key: {e}"))?;
    v.try_into().map_err(|v: Vec<u8>| format!("key must be 32 bytes, got {}", v.len()))
}

/// The node's private key: read from `path` (it must be mode 600), or created there (mode
/// 600) with `<path>.pub` beside it. Returns (secret, public).
pub fn load_or_create_key(path: &str) -> Result<(StaticSecret, PublicKey), String> {
    let p = std::path::Path::new(path);
    if !p.exists() {
        let (priv_b64, pub_b64) = crate::keys::generate();
        write_mode(p, &format!("{priv_b64}\n"), 0o600)?;
        write_mode(&p.with_extension(ext_pub(p)), &format!("{pub_b64}\n"), 0o644)?;
        eprintln!("wg: created key {path} (mode 600) — public {pub_b64}");
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(p).map_err(|e| format!("{path}: {e}"))?.permissions().mode();
        if mode & 0o077 != 0 {
            return Err(format!("{path}: a WireGuard private key must be mode 600 (it is {:o})", mode & 0o777));
        }
    }
    let raw = std::fs::read_to_string(p).map_err(|e| format!("{path}: {e}"))?;
    let secret = StaticSecret::from(decode_key(&raw)?);
    let public = PublicKey::from(&secret);
    let pub_path = p.with_extension(ext_pub(p));
    let pub_b64 = B64.encode(public.as_bytes());
    if std::fs::read_to_string(&pub_path).map(|s| s.trim() != pub_b64).unwrap_or(true) {
        write_mode(&pub_path, &format!("{pub_b64}\n"), 0o644)?;
    }
    Ok((secret, public))
}

fn ext_pub(p: &std::path::Path) -> String {
    match p.extension().and_then(|e| e.to_str()) {
        Some(e) => format!("{e}.pub"),
        None => "pub".into(),
    }
}

fn write_mode(p: &std::path::Path, text: &str, mode: u32) -> Result<(), String> {
    let tmp = p.with_extension(format!("tmp{}", std::process::id()));
    {
        let mut o = std::fs::OpenOptions::new();
        o.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            o.mode(mode);
        }
        let mut f = o.open(&tmp).map_err(|e| format!("{}: {e}", tmp.display()))?;
        f.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(mode));
    }
    std::fs::rename(&tmp, p).map_err(|e| format!("{}: {e}", p.display()))
}

/* ------------------------------------------------------------------ the bridge's relay */

/// What the hub's bridge does with WireGuard: it moves relay frames between root links and
/// the hub's own node, by address only. It never holds a key.
pub struct Relay {
    reg: Registry,
    udp: Option<UdpSocket>,
    /// the hub's own node (its `udp`); None = only root → root is relayed
    local: Option<SocketAddr>,
    pub relayed: AtomicUsize,
    pub dropped: AtomicUsize,
}

impl Relay {
    /// `bind` = the bridge's relay socket (the hub node's `relay`), `local` = the hub node.
    pub fn new(reg: Registry, bind: Option<SocketAddr>, local: Option<SocketAddr>) -> Result<Arc<Relay>, String> {
        let udp = match (bind, local) {
            (Some(b), Some(_)) => {
                if !b.ip().is_loopback() {
                    return Err(format!("wg_relay {b}: the relay socket is loopback only"));
                }
                Some(UdpSocket::bind(b).map_err(|e| format!("wg_relay bind {b}: {e}"))?)
            }
            (None, None) => None,
            _ => return Err("[bridge.root-link] wg_relay and wg_local go together".into()),
        };
        let relay = Arc::new(Relay { reg, udp, local, relayed: AtomicUsize::new(0), dropped: AtomicUsize::new(0) });
        if let Some(sock) = relay.udp.as_ref().and_then(|s| s.try_clone().ok()) {
            let weak = Arc::downgrade(&relay);
            std::thread::Builder::new()
                .name("wg-relay".into())
                .spawn(move || {
                    let mut buf = vec![0u8; 65536];
                    loop {
                        let Ok((n, from)) = sock.recv_from(&mut buf) else { continue };
                        let Some(r) = weak.upgrade() else { return };
                        r.from_local(&buf[..n], from);
                    }
                })
                .map_err(|e| e.to_string())?;
        }
        Ok(relay)
    }

    fn drop_one(&self, why: &str, src: &str) {
        let n = self.dropped.fetch_add(1, Ordering::Relaxed);
        if n < 20 || n % 1000 == 0 {
            eprintln!("wg-relay: dropped a frame from '{src}': {why}");
        }
    }

    /// A binary frame from root link `src` whose link-token claim is `claim`.
    pub fn from_link(&self, src: &str, claim: &[String], payload: &[u8]) {
        let Some((to, dgram)) = unframe(payload) else { return self.drop_one("not a relay frame", src) };
        if wg_kind(dgram).is_none() {
            return self.drop_one("not a WireGuard message", src);
        }
        if to == src {
            return self.drop_one("addressed to itself", src);
        }
        if !switch::link_may_address(claim, to) {
            return self.drop_one(&format!("claim does not name '{to}'"), src);
        }
        let out = frame(src, dgram);
        if to == "local" {
            match (&self.udp, self.local) {
                (Some(s), Some(l)) => {
                    if s.send_to(&out, l).is_ok() {
                        self.relayed.fetch_add(1, Ordering::Relaxed);
                    }
                }
                _ => self.drop_one("this hub runs no WireGuard node (wg_local unset)", src),
            }
            return;
        }
        match self.reg.send_binary(to, &out) {
            Ok(_) => {
                self.relayed.fetch_add(1, Ordering::Relaxed);
            }
            Err(e) => self.drop_one(&format!("'{to}': {e}"), src),
        }
    }

    /// A relay frame from the hub's own node (loopback UDP).
    fn from_local(&self, buf: &[u8], from: SocketAddr) {
        if Some(from) != self.local {
            return self.drop_one(&format!("UDP from {from}, not the hub's node"), "local");
        }
        let Some((to, dgram)) = unframe(buf) else { return self.drop_one("not a relay frame", "local") };
        if to == "local" || wg_kind(dgram).is_none() {
            return self.drop_one("not a WireGuard message for a root", "local");
        }
        match self.reg.send_binary(to, &frame("local", dgram)) {
            Ok(_) => {
                self.relayed.fetch_add(1, Ordering::Relaxed);
            }
            Err(e) => self.drop_one(&format!("'{to}': {e}"), "local"),
        }
    }
}

/* ------------------------------------------------------------------ node config */

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NodeFile {
    pub wg: NodeConfig,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NodeConfig {
    /// the private key (mode 600; created with `<file>.pub` if missing)
    pub key_file: String,
    /// this node's loopback UDP socket (the relay sends here)
    pub udp: String,
    /// the relay's loopback UDP socket (the dialer's `--wg-udp`, or the bridge's `wg_relay`)
    pub relay: String,
    /// the front door (loopback only)
    pub http: String,
    /// in-tunnel calls are performed against this brain
    #[serde(default)]
    pub brain: Option<String>,
    /// this node's tunnel address with its prefix (`10.a.b.c/24`); the hub's is `.1` of the
    /// net in roots_file
    #[serde(default)]
    pub address: Option<String>,
    /// the hub: the roots registry (pinned keys)
    #[serde(default)]
    pub roots_file: Option<String>,
    /// the hub: devices.json — a root's approving device must be live
    #[serde(default)]
    pub devices_file: Option<String>,
    #[serde(default)]
    pub peer: Vec<StaticPeer>,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StaticPeer {
    /// its relay address: `local` (the hub) or a root id; also its `/_wg/<id>` name
    pub id: String,
    pub public_key: String,
    pub ip: String,
}

#[derive(Debug, Clone, PartialEq)]
struct PeerSpec {
    id: String,
    public: [u8; 32],
    ip: Ipv4Addr,
    /// a static peer (the joined root's hub): dialed every 2 s until up, else every 5 s
    proactive: bool,
}

fn parse_cidr4(s: &str) -> Result<(Ipv4Addr, u8), String> {
    let (ip, len) = s.split_once('/').ok_or_else(|| format!("'{s}': want a.b.c.d/len"))?;
    let ip: Ipv4Addr = ip.trim().parse().map_err(|e| format!("'{s}': {e}"))?;
    let len: u8 = len.trim().parse().map_err(|e| format!("'{s}': {e}"))?;
    if !(8..=30).contains(&len) {
        return Err(format!("'{s}': prefix /{len} out of range (8–30)"));
    }
    Ok((ip, len))
}

fn in_net(ip: Ipv4Addr, net: (Ipv4Addr, u8)) -> bool {
    let mask = u32::MAX << (32 - net.1);
    u32::from(ip) & mask == u32::from(net.0) & mask
}

/// Where the peer list comes from: the config's static peers + (hub) the roots registry.
struct Source {
    statics: Vec<PeerSpec>,
    address: Option<(Ipv4Addr, u8)>,
    roots_file: Option<PathBuf>,
    devices: Option<crate::tokens::TokenStore>,
    warned: std::collections::HashSet<String>,
}

impl Source {
    fn warn(&mut self, msg: String) {
        if self.warned.insert(msg.clone()) {
            eprintln!("wg: {msg}");
        }
    }

    /// (this node's address, the peers it may talk to now)
    fn read(&mut self) -> (Option<(Ipv4Addr, u8)>, Vec<PeerSpec>) {
        let mut peers = self.statics.clone();
        let mut addr = self.address;
        let Some(path) = self.roots_file.clone() else { return (addr, peers) };
        let Ok(text) = std::fs::read_to_string(&path) else { return (addr, peers) };
        let Ok(v) = serde_json::from_str::<Value>(&text) else {
            self.warn(format!("{}: not JSON — keeping no roots", path.display()));
            return (addr, peers);
        };
        let net = match v["wg"]["net"].as_str().map(parse_cidr4) {
            Some(Ok(n)) => n,
            Some(Err(e)) => {
                self.warn(format!("{}: wg.net {e}", path.display()));
                return (addr, peers);
            }
            None => return (addr, peers), // no root carries a key yet
        };
        if addr.is_none() {
            let base = u32::from(net.0) & (u32::MAX << (32 - net.1));
            addr = Some((Ipv4Addr::from(base + 1), net.1));
        }
        let me = addr.map(|a| a.0);
        for r in v["roots"].as_array().into_iter().flatten() {
            let id = r["id"].as_str().unwrap_or_default();
            let (Some(key), Some(ip)) = (r["wg_pub"].as_str(), r["wg_ip"].as_str()) else { continue };
            if !valid_addr(id) || id == "local" {
                continue;
            }
            if r["revoked"].as_bool() == Some(true) {
                continue;
            }
            let dev = r["dev"].as_str().unwrap_or_default();
            if let Some(d) = &self.devices {
                if !d.device_live(dev) {
                    continue;
                }
            }
            let Ok(public) = decode_key(key) else {
                self.warn(format!("root '{id}': wg_pub is not a key"));
                continue;
            };
            let Ok(ip) = ip.parse::<Ipv4Addr>() else { continue };
            if !in_net(ip, net) || Some(ip) == me {
                self.warn(format!("root '{id}': wg_ip {ip} is outside {}/{} or the hub's own", net.0, net.1));
                continue;
            }
            if peers.iter().any(|p| p.public == public || p.ip == ip || p.id == id) {
                self.warn(format!("root '{id}': its key, address or id is already taken — skipped"));
                continue;
            }
            peers.push(PeerSpec { id: id.to_string(), public, ip, proactive: false });
        }
        (addr, peers)
    }
}

/* ------------------------------------------------------------------ the engine */

/// What threads ask of the engine.
enum Cmd {
    /// a TCP stream to `peer`:80 inside the tunnel
    Open { peer: String, events: mpsc::Sender<Ev>, reply: mpsc::Sender<Result<u64, String>> },
    Write { id: u64, data: Vec<u8> },
    /// no more writes: FIN once the queue drained
    Shutdown { id: u64 },
    /// the thread is done with the stream
    Release { id: u64 },
    Stats { reply: mpsc::Sender<(Value, Value)> },
}

/// What the engine tells a stream's thread.
enum Ev {
    Connected,
    Data(Vec<u8>),
    Eof,
    Reset(String),
}

struct Peer {
    spec: PeerSpec,
    tun: Tunn,
    idx: u32,
    handshakes: u64,
    last_init: Instant,
    since_ms: u64,
}

struct Stream {
    handle: SocketHandle,
    events: mpsc::Sender<Ev>,
    out: VecDeque<u8>,
    peer_ip: Ipv4Addr,
    connected: bool,
    eof_sent: bool,
    shutdown: bool,
    closed: bool,
    released: Option<Instant>,
}

#[derive(Default)]
struct Counters {
    rx_frames: u64,
    tx_frames: u64,
    rx_ip: u64,
    tx_ip: u64,
    not_relay: u64,
    garbage: u64,
    unknown_key: u64,
    wrong_link: u64,
    replay: u64,
    auth_fail: u64,
    spoofed_ip: u64,
    other_err: u64,
    udp_send_fail: u64,
}

struct VDev {
    rx: VecDeque<Vec<u8>>,
    tx: VecDeque<Vec<u8>>,
}

struct VRx(Vec<u8>);
struct VTx<'a>(&'a mut VecDeque<Vec<u8>>);

impl RxToken for VRx {
    fn consume<R, F: FnOnce(&[u8]) -> R>(self, f: F) -> R {
        f(&self.0)
    }
}

impl TxToken for VTx<'_> {
    fn consume<R, F: FnOnce(&mut [u8]) -> R>(self, len: usize, f: F) -> R {
        let mut b = vec![0u8; len];
        let r = f(&mut b);
        self.0.push_back(b);
        r
    }
}

impl Device for VDev {
    type RxToken<'a> = VRx where Self: 'a;
    type TxToken<'a> = VTx<'a> where Self: 'a;
    fn receive(&mut self, _t: smoltcp::time::Instant) -> Option<(VRx, VTx<'_>)> {
        let p = self.rx.pop_front()?;
        Some((VRx(p), VTx(&mut self.tx)))
    }
    fn transmit(&mut self, _t: smoltcp::time::Instant) -> Option<VTx<'_>> {
        Some(VTx(&mut self.tx))
    }
    fn capabilities(&self) -> DeviceCapabilities {
        let mut c = DeviceCapabilities::default();
        c.medium = Medium::Ip;
        c.max_transmission_unit = MTU;
        c
    }
}

struct Engine {
    secret: StaticSecret,
    public: PublicKey,
    relay: SocketAddr,
    udp: Arc<tokio::net::UdpSocket>,
    addr: Option<(Ipv4Addr, u8)>,
    peers: HashMap<String, Peer>,
    by_pub: HashMap<[u8; 32], String>,
    by_idx: HashMap<u32, String>,
    by_ip: HashMap<Ipv4Addr, String>,
    next_idx: u32,
    source: Source,
    iface: Interface,
    dev: VDev,
    sockets: SocketSet<'static>,
    streams: HashMap<u64, Stream>,
    listeners: Vec<SocketHandle>,
    next_id: u64,
    next_port: u16,
    cmd_tx: tokio::sync::mpsc::UnboundedSender<Cmd>,
    waker: Arc<Waker>,
    brain: Option<String>,
    agent: ureq::Agent,
    c: Counters,
    t0: Instant,
    scratch: Vec<u8>,
}

fn now_ms() -> u64 {
    crate::tokens::now_ms()
}

impl Engine {
    fn now(&self) -> smoltcp::time::Instant {
        smoltcp::time::Instant::from_micros(self.t0.elapsed().as_micros() as i64)
    }

    fn send_relay(&mut self, to: &str, dgram: &[u8]) {
        match self.udp.try_send_to(&frame(to, dgram), self.relay) {
            Ok(_) => self.c.tx_frames += 1,
            Err(_) => self.c.udp_send_fail += 1,
        }
    }

    /// Bring the peer table and the address in line with the source.
    fn reload(&mut self) {
        let (addr, specs) = self.source.read();
        if addr != self.addr {
            if let Some((ip, len)) = addr {
                self.iface.update_ip_addrs(|a| {
                    a.clear();
                    let _ = a.push(IpCidr::new(IpAddress::Ipv4(ip), len));
                });
                eprintln!("wg: tunnel address {ip}/{len}");
            }
            self.addr = addr;
        }
        let gone: Vec<String> =
            self.peers.keys().filter(|id| !specs.iter().any(|s| &s.id == *id && self.peers[*id].spec == *s)).cloned().collect();
        for id in gone {
            if let Some(p) = self.peers.remove(&id) {
                self.by_pub.remove(&p.spec.public);
                self.by_idx.remove(&p.idx);
                self.by_ip.remove(&p.spec.ip);
                let cut: Vec<u64> = self.streams.iter().filter(|(_, s)| s.peer_ip == p.spec.ip).map(|(k, _)| *k).collect();
                for sid in &cut {
                    if let Some(s) = self.streams.get_mut(sid) {
                        self.sockets.get_mut::<tcp::Socket>(s.handle).abort();
                        let _ = s.events.send(Ev::Reset("the peer was removed".into()));
                        s.eof_sent = true;
                    }
                }
                eprintln!(
                    "wg: peer '{id}' REMOVED (fp {}) — its tunnel is cut ({} stream(s) reset)",
                    fingerprint(&p.spec.public),
                    cut.len()
                );
            }
        }
        for s in specs {
            if self.peers.contains_key(&s.id) {
                continue;
            }
            self.next_idx = (self.next_idx + 1) & 0x00ff_ffff;
            let idx = self.next_idx.max(1);
            let tun = Tunn::new(
                self.secret.clone(),
                PublicKey::from(s.public),
                None,
                Some(PERSISTENT_KEEPALIVE),
                idx,
                None,
            );
            eprintln!("wg: peer '{}' {} (fp {})", s.id, s.ip, fingerprint(&s.public));
            self.by_pub.insert(s.public, s.id.clone());
            self.by_idx.insert(idx, s.id.clone());
            self.by_ip.insert(s.ip, s.id.clone());
            self.peers.insert(
                s.id.clone(),
                Peer { spec: s, tun, idx, handshakes: 0, last_init: Instant::now() - Duration::from_secs(60), since_ms: now_ms() },
            );
        }
    }

    /// One relay frame in.
    fn on_udp(&mut self, buf: &[u8], from: SocketAddr) {
        if from != self.relay {
            return; // the waker, or a stray sender: never a peer
        }
        self.c.rx_frames += 1;
        let Some((src, dgram)) = unframe(buf) else {
            self.c.not_relay += 1;
            return;
        };
        let pid = match Tunn::parse_incoming_packet(dgram) {
            Err(_) => {
                self.c.garbage += 1;
                return;
            }
            Ok(Packet::HandshakeInit(p)) => match parse_handshake_anon(&self.secret, &self.public, &p) {
                Ok(hh) => match self.by_pub.get(&hh.peer_static_public) {
                    Some(id) => id.clone(),
                    None => {
                        self.c.unknown_key += 1;
                        if self.c.unknown_key <= 5 || self.c.unknown_key % 100 == 0 {
                            eprintln!(
                                "wg: handshake from '{src}' with an UNPINNED key (fp {}) — dropped",
                                fingerprint(&hh.peer_static_public)
                            );
                        }
                        return;
                    }
                },
                Err(_) => {
                    self.c.auth_fail += 1;
                    return;
                }
            },
            Ok(Packet::HandshakeResponse(p)) => match self.by_idx.get(&(p.receiver_idx >> 8)) {
                Some(id) => id.clone(),
                None => {
                    self.c.other_err += 1;
                    return;
                }
            },
            Ok(Packet::PacketCookieReply(p)) => match self.by_idx.get(&(p.receiver_idx >> 8)) {
                Some(id) => id.clone(),
                None => {
                    self.c.other_err += 1;
                    return;
                }
            },
            Ok(Packet::PacketData(p)) => match self.by_idx.get(&(p.receiver_idx >> 8)) {
                Some(id) => id.clone(),
                None => {
                    self.c.other_err += 1;
                    return;
                }
            },
        };
        if self.peers[&pid].spec.id != src {
            // the key is pinned to another link: a copied key, or a relay that lies
            self.c.wrong_link += 1;
            if self.c.wrong_link <= 5 {
                eprintln!("wg: '{pid}'s key arrived on link '{src}' — dropped");
            }
            return;
        }
        let kind = wg_kind(dgram);
        let mut first = Some(dgram);
        let mut first_result = true;
        loop {
            let r = {
                let peer = self.peers.get_mut(&pid).expect("routed peer");
                match first.take() {
                    Some(d) => peer.tun.decapsulate(None, d, &mut self.scratch),
                    None => peer.tun.decapsulate(None, &[], &mut self.scratch),
                }
            };
            match r {
                TunnResult::WriteToNetwork(b) => {
                    let b = b.to_vec();
                    if first_result && matches!(kind, Some(WgKind::Init) | Some(WgKind::Response)) {
                        self.peers.get_mut(&pid).unwrap().handshakes += 1;
                    }
                    self.send_relay(&pid, &b);
                }
                TunnResult::WriteToTunnelV4(pkt, src_ip) => {
                    let peer_ip = self.peers[&pid].spec.ip;
                    if src_ip != peer_ip {
                        self.c.spoofed_ip += 1;
                    } else {
                        self.c.rx_ip += 1;
                        self.dev.rx.push_back(pkt.to_vec());
                    }
                }
                TunnResult::WriteToTunnelV6(..) => self.c.spoofed_ip += 1,
                TunnResult::Done => {
                    if first_result && kind == Some(WgKind::Response) {
                        self.peers.get_mut(&pid).unwrap().handshakes += 1;
                    }
                    break;
                }
                TunnResult::Err(e) => {
                    if first_result {
                        match e {
                            WireGuardError::DuplicateCounter => self.c.replay += 1,
                            WireGuardError::InvalidAeadTag | WireGuardError::InvalidMac => self.c.auth_fail += 1,
                            _ => self.c.other_err += 1,
                        }
                    }
                    break;
                }
            }
            first_result = false;
        }
    }

    /// Inner packets from smoltcp → their peer's tunnel → the relay.
    fn flush_tx(&mut self) {
        let pkts: Vec<Vec<u8>> = self.dev.tx.drain(..).collect();
        for pkt in pkts {
            if pkt.len() < 20 || pkt[0] >> 4 != 4 {
                continue;
            }
            let dst = Ipv4Addr::new(pkt[16], pkt[17], pkt[18], pkt[19]);
            let Some(pid) = self.by_ip.get(&dst).cloned() else { continue };
            self.c.tx_ip += 1;
            let out = {
                let peer = self.peers.get_mut(&pid).unwrap();
                match peer.tun.encapsulate(&pkt, &mut self.scratch) {
                    TunnResult::WriteToNetwork(b) => Some(b.to_vec()),
                    _ => None, // queued behind a handshake: sent when it completes
                }
            };
            if let Some(b) = out {
                self.send_relay(&pid, &b);
            }
        }
    }

    fn timers(&mut self) {
        let ids: Vec<String> = self.peers.keys().cloned().collect();
        let mut out = vec![0u8; 2048];
        for id in ids {
            let send = {
                let p = self.peers.get_mut(&id).unwrap();
                let mut v = vec![];
                // dial every peer until its first handshake: a static peer (the hub) every 2 s, a
                // pinned root every 5 s (the bridge drops frames to a root that is not linked).
                // So a node that restarts brings its tunnels back at once, from either end.
                let every = Duration::from_secs(if p.spec.proactive { 2 } else { 5 });
                if p.tun.stats().0.is_none() && p.last_init.elapsed() > every {
                    p.last_init = Instant::now();
                    if let TunnResult::WriteToNetwork(b) = p.tun.format_handshake_initiation(&mut out, false) {
                        v.push(b.to_vec());
                    }
                }
                if let TunnResult::WriteToNetwork(b) = p.tun.update_timers(&mut out) {
                    v.push(b.to_vec());
                }
                v
            };
            for b in send {
                self.send_relay(&id, &b);
            }
        }
    }

    fn new_socket() -> tcp::Socket<'static> {
        let mut s = tcp::Socket::new(
            tcp::SocketBuffer::new(vec![0u8; TCP_BUF]),
            tcp::SocketBuffer::new(vec![0u8; TCP_BUF]),
        );
        s.set_nagle_enabled(false);
        s.set_timeout(Some(smoltcp::time::Duration::from_secs(CALL_WAIT.as_secs() + 10)));
        s
    }

    fn on_cmd(&mut self, cmd: Cmd) {
        match cmd {
            Cmd::Open { peer, events, reply } => {
                let res = (|| {
                    let p = self.peers.get(&peer).ok_or_else(|| format!("no tunnel peer '{peer}'"))?;
                    if self.addr.is_none() {
                        return Err("this node has no tunnel address yet".to_string());
                    }
                    if self.streams.len() >= MAX_STREAMS {
                        return Err("too many tunnel streams at once".to_string());
                    }
                    let ip = p.spec.ip;
                    let mut s = Self::new_socket();
                    self.next_port = if self.next_port >= 65000 { 40000 } else { self.next_port + 1 };
                    s.connect(self.iface.context(), (IpAddress::Ipv4(ip), IN_TUNNEL_PORT), self.next_port)
                        .map_err(|e| format!("connect: {e}"))?;
                    let handle = self.sockets.add(s);
                    self.next_id += 1;
                    self.streams.insert(
                        self.next_id,
                        Stream {
                            handle,
                            events,
                            out: VecDeque::new(),
                            peer_ip: ip,
                            connected: false,
                            eof_sent: false,
                            shutdown: false,
                            closed: false,
                            released: None,
                        },
                    );
                    Ok(self.next_id)
                })();
                let _ = reply.send(res);
            }
            Cmd::Write { id, data } => {
                if let Some(s) = self.streams.get_mut(&id) {
                    s.out.extend(data);
                }
            }
            Cmd::Shutdown { id } => {
                if let Some(s) = self.streams.get_mut(&id) {
                    s.shutdown = true;
                }
            }
            Cmd::Release { id } => {
                if let Some(s) = self.streams.get_mut(&id) {
                    s.released = Some(Instant::now());
                    let sock = self.sockets.get_mut::<tcp::Socket>(s.handle);
                    match sock.state() {
                        tcp::State::CloseWait => sock.close(),
                        tcp::State::Established | tcp::State::SynSent | tcp::State::SynReceived if !s.shutdown => sock.abort(),
                        _ => {}
                    }
                }
            }
            Cmd::Stats { reply } => {
                let _ = reply.send(self.stats());
            }
        }
    }

    fn stats(&self) -> (Value, Value) {
        let mut peers: Vec<Value> = self
            .peers
            .values()
            .map(|p| {
                let (hs, tx, rx, _, _) = p.tun.stats();
                json!({ "id": p.spec.id, "ip": p.spec.ip.to_string(), "fingerprint": fingerprint(&p.spec.public),
                        "up": hs.is_some_and(|d| d < Duration::from_secs(180)),
                        "last_handshake_ms": hs.map(|d| d.as_millis() as u64), "handshakes": p.handshakes,
                        "tx": tx, "rx": rx, "since": p.since_ms })
            })
            .collect();
        peers.sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
        let c = &self.c;
        let node = json!({
            "ip": self.addr.map(|a| format!("{}/{}", a.0, a.1)), "public_key": B64.encode(self.public.as_bytes()),
            "fingerprint": fingerprint(self.public.as_bytes()), "peers": self.peers.len(), "streams": self.streams.len(),
            "frames": { "rx": c.rx_frames, "tx": c.tx_frames }, "ip_packets": { "rx": c.rx_ip, "tx": c.tx_ip },
            "dropped": { "not_relay": c.not_relay, "garbage": c.garbage, "unknown_key": c.unknown_key,
                         "wrong_link": c.wrong_link, "replay": c.replay, "auth_fail": c.auth_fail,
                         "spoofed_ip": c.spoofed_ip, "other": c.other_err, "udp_send_fail": c.udp_send_fail },
        });
        (Value::Array(peers), node)
    }

    /// Listeners → inbound streams; stream bytes ↔ their threads; reaping.
    fn service(&mut self) {
        // a listening socket that left Listen is an inbound connection now
        let mut i = 0;
        while i < self.listeners.len() {
            let h = self.listeners[i];
            if self.sockets.get::<tcp::Socket>(h).state() != tcp::State::Listen {
                self.listeners.swap_remove(i);
                self.accept(h);
            } else {
                i += 1;
            }
        }
        let inbound = self.streams.len();
        while self.addr.is_some() && self.listeners.len() < LISTENERS && inbound + self.listeners.len() < MAX_STREAMS {
            let mut s = Self::new_socket();
            if s.listen(IN_TUNNEL_PORT).is_err() {
                break;
            }
            self.listeners.push(self.sockets.add(s));
        }
        let mut buf = vec![0u8; 65536];
        let mut reap = vec![];
        for (id, s) in self.streams.iter_mut() {
            let sock = self.sockets.get_mut::<tcp::Socket>(s.handle);
            let state = sock.state();
            if !s.connected && sock.may_send() {
                s.connected = true;
                let _ = s.events.send(Ev::Connected);
            }
            while sock.can_recv() {
                match sock.recv_slice(&mut buf) {
                    Ok(n) if n > 0 => {
                        if s.events.send(Ev::Data(buf[..n].to_vec())).is_err() && s.released.is_none() {
                            s.released = Some(Instant::now());
                            sock.abort();
                        }
                    }
                    _ => break,
                }
            }
            while !s.out.is_empty() && sock.can_send() {
                let (a, _) = s.out.as_slices();
                match sock.send_slice(a) {
                    Ok(n) if n > 0 => {
                        s.out.drain(..n);
                    }
                    _ => break,
                }
            }
            if s.shutdown && s.out.is_empty() && !s.closed && sock.may_send() {
                sock.close();
                s.closed = true;
            }
            if !s.eof_sent && !sock.can_recv() {
                if s.connected && !sock.may_recv() && state != tcp::State::SynSent && state != tcp::State::SynReceived {
                    s.eof_sent = true;
                    let _ = s.events.send(Ev::Eof);
                } else if !s.connected && state == tcp::State::Closed {
                    s.eof_sent = true;
                    let _ = s.events.send(Ev::Reset("the tunnel connection was refused or reset".into()));
                }
            }
            if let Some(at) = s.released {
                let done = matches!(state, tcp::State::Closed | tcp::State::TimeWait);
                if done {
                    reap.push(*id);
                } else if at.elapsed() > Duration::from_secs(30) {
                    sock.abort();
                }
            }
        }
        for id in reap {
            if let Some(s) = self.streams.remove(&id) {
                self.sockets.remove(s.handle);
            }
        }
    }

    fn accept(&mut self, h: SocketHandle) {
        let sock = self.sockets.get_mut::<tcp::Socket>(h);
        let remote = sock.remote_endpoint().map(|e| e.addr);
        let peer = match remote {
            Some(IpAddress::Ipv4(ip)) => self.by_ip.get(&ip).cloned().map(|p| (p, ip)),
            _ => None,
        };
        let inbound_now = self.streams.len();
        let Some((peer, ip)) = peer.filter(|_| inbound_now < MAX_INBOUND * 2) else {
            sock.abort();
            self.sockets.remove(h);
            return;
        };
        let (tx, rx) = mpsc::channel();
        self.next_id += 1;
        let id = self.next_id;
        self.streams.insert(
            id,
            Stream {
                handle: h,
                events: tx,
                out: VecDeque::new(),
                peer_ip: ip,
                connected: false,
                eof_sent: false,
                shutdown: false,
                closed: false,
                released: None,
            },
        );
        let ctl = Ctl { tx: self.cmd_tx.clone(), waker: self.waker.clone() };
        let brain = self.brain.clone();
        let agent = self.agent.clone();
        let _ = std::thread::Builder::new().name("wg-in".into()).spawn(move || serve_inbound(id, rx, ctl, brain, agent, peer));
    }

    fn pump(&mut self) {
        for _ in 0..4 {
            let now = self.now();
            self.iface.poll(now, &mut self.dev, &mut self.sockets);
            self.service();
            let now = self.now();
            self.iface.poll(now, &mut self.dev, &mut self.sockets);
            let busy = !self.dev.tx.is_empty();
            self.flush_tx();
            if !busy && self.dev.rx.is_empty() {
                break;
            }
        }
    }

    fn delay(&mut self) -> Duration {
        let now = self.now();
        let d = self.iface.poll_delay(now, &self.sockets).map(Duration::from).unwrap_or(Duration::from_millis(100));
        let pending = self.streams.values().any(|s| !s.out.is_empty());
        if pending {
            Duration::from_millis(1).min(d)
        } else {
            d.min(Duration::from_millis(100))
        }
    }
}

/// Wakes the engine from another thread: a 1-byte datagram to its socket (it is not the
/// relay's address, so it is never mistaken for a frame).
struct Waker {
    sock: UdpSocket,
    to: SocketAddr,
}

impl Waker {
    fn wake(&self) {
        let _ = self.sock.send_to(&[0], self.to);
    }
}

/// A thread's handle on the engine.
#[derive(Clone)]
struct Ctl {
    tx: tokio::sync::mpsc::UnboundedSender<Cmd>,
    waker: Arc<Waker>,
}

impl Ctl {
    fn send(&self, c: Cmd) -> bool {
        let ok = self.tx.send(c).is_ok();
        self.waker.wake();
        ok
    }

    fn stats(&self) -> Option<(Value, Value)> {
        let (tx, rx) = mpsc::channel();
        self.send(Cmd::Stats { reply: tx });
        rx.recv_timeout(Duration::from_secs(5)).ok()
    }
}

/* ------------------------------------------------------------------ HTTP on the doors */

struct Request {
    method: String,
    target: String,
    headers: Map<String, Value>,
    body: Vec<u8>,
    raw_headers: Vec<(String, String)>,
}

/// The head of an HTTP/1.x message in `b`: (start line, headers, head length).
fn parse_head(b: &[u8]) -> Option<Result<(String, Vec<(String, String)>, usize), String>> {
    let end = b.windows(4).position(|w| w == b"\r\n\r\n")?;
    let text = match std::str::from_utf8(&b[..end]) {
        Ok(t) => t,
        Err(_) => return Some(Err("head is not UTF-8".into())),
    };
    let mut lines = text.split("\r\n");
    let start = lines.next().unwrap_or_default().to_string();
    let mut headers = vec![];
    for l in lines {
        match l.split_once(':') {
            Some((k, v)) => headers.push((k.trim().to_ascii_lowercase(), v.trim().to_string())),
            None => return Some(Err("malformed header line".into())),
        }
    }
    Some(Ok((start, headers, end + 4)))
}

fn header<'a>(h: &'a [(String, String)], name: &str) -> Option<&'a str> {
    h.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
}

fn pass_map(h: &[(String, String)]) -> Map<String, Value> {
    let mut m = Map::new();
    for (k, v) in h {
        m.insert(k.clone(), json!(v));
    }
    switch::pass_headers(Some(&Value::Object(m)))
}

/// A whole request (Content-Length bodies only), read by `more` until complete.
fn read_request(mut more: impl FnMut(&mut Vec<u8>) -> Result<bool, String>) -> Result<Request, (u16, String)> {
    let mut buf = Vec::new();
    let (start, headers, head) = loop {
        if let Some(r) = parse_head(&buf) {
            break r.map_err(|e| (400, e))?;
        }
        if buf.len() > 16 * 1024 {
            return Err((431, "request head too large".into()));
        }
        if !more(&mut buf).map_err(|e| (408, e))? {
            return Err((400, "connection closed mid-request".into()));
        }
    };
    let mut parts = start.split(' ');
    let (method, target) = (parts.next().unwrap_or_default().to_string(), parts.next().unwrap_or_default().to_string());
    if header(&headers, "transfer-encoding").is_some() || header(&headers, "upgrade").is_some() {
        return Err((400, "plain HTTP with a Content-Length only".into()));
    }
    let len: usize = header(&headers, "content-length").map(|v| v.parse().unwrap_or(usize::MAX)).unwrap_or(0);
    if len > switch::MAX_BODY {
        return Err((413, format!("body over {} bytes", switch::MAX_BODY)));
    }
    while buf.len() < head + len {
        if !more(&mut buf).map_err(|e| (408, e))? {
            return Err((400, "connection closed mid-body".into()));
        }
    }
    let body = buf[head..head + len].to_vec();
    Ok(Request { method, target, headers: pass_map(&headers), body, raw_headers: headers })
}

fn reason(st: u16) -> &'static str {
    match st {
        200 => "OK",
        201 => "Created",
        204 => "No Content",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        408 => "Request Timeout",
        413 => "Payload Too Large",
        431 => "Request Header Fields Too Large",
        500 => "Internal Server Error",
        501 => "Not Implemented",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        504 => "Gateway Timeout",
        _ => "",
    }
}

fn encode_reply(r: &HttpReply) -> Vec<u8> {
    let mut out = format!("HTTP/1.1 {} {}\r\ncontent-length: {}\r\nconnection: close\r\n", r.status, reason(r.status), r.body.len());
    for (k, v) in &r.headers {
        if let Some(s) = v.as_str() {
            out.push_str(&format!("{k}: {s}\r\n"));
        }
    }
    out.push_str("\r\n");
    let mut b = out.into_bytes();
    b.extend_from_slice(&r.body);
    b
}

fn encode_request(peer: &str, req: &HttpReq) -> Vec<u8> {
    let mut out = format!(
        "{} {} HTTP/1.1\r\nhost: {peer}\r\ncontent-length: {}\r\nconnection: close\r\n",
        req.method,
        req.path,
        req.body.len()
    );
    for (k, v) in &req.headers {
        if let Some(s) = v.as_str() {
            out.push_str(&format!("{k}: {s}\r\n"));
        }
    }
    out.push_str("\r\n");
    let mut b = out.into_bytes();
    b.extend_from_slice(&req.body);
    b
}

/// The in-tunnel door: one exchange from a peer, performed against this root's brain.
fn serve_inbound(id: u64, rx: mpsc::Receiver<Ev>, ctl: Ctl, brain: Option<String>, agent: ureq::Agent, _peer: String) {
    let deadline = Instant::now() + Duration::from_secs(30);
    let got = read_request(|buf| loop {
        let left = deadline.saturating_duration_since(Instant::now());
        match rx.recv_timeout(left) {
            Ok(Ev::Data(d)) => {
                buf.extend_from_slice(&d);
                return Ok(true);
            }
            Ok(Ev::Connected) => continue,
            Ok(Ev::Eof) | Ok(Ev::Reset(_)) => return Ok(false),
            Err(_) => return Err("timed out reading the request".into()),
        }
    });
    let reply = match got {
        Err((st, msg)) => HttpReply::error(st, &msg),
        Ok(r) => match (HttpReq::new(&r.method, &r.target, r.headers, r.body), &brain) {
            (Err(e), _) => HttpReply::error(400, &e),
            (Ok(_), None) => HttpReply::error(501, "this root runs no brain behind its tunnel"),
            (Ok(req), Some(b)) => switch::perform(&agent, b, &req),
        },
    };
    ctl.send(Cmd::Write { id, data: encode_reply(&reply) });
    ctl.send(Cmd::Shutdown { id });
    ctl.send(Cmd::Release { id });
}

/// The front door's half: one exchange with `peer`'s brain through the tunnel.
fn tunnel_call(ctl: &Ctl, peer: &str, req: &HttpReq) -> HttpReply {
    let (ev_tx, ev_rx) = mpsc::channel();
    let (rtx, rrx) = mpsc::channel();
    if !ctl.send(Cmd::Open { peer: peer.to_string(), events: ev_tx, reply: rtx }) {
        return HttpReply::error(503, "the tunnel engine is not running");
    }
    let id = match rrx.recv_timeout(Duration::from_secs(5)) {
        Ok(Ok(id)) => id,
        Ok(Err(e)) => return HttpReply::error(502, &e),
        Err(_) => return HttpReply::error(503, "the tunnel engine did not answer"),
    };
    let release = |r: HttpReply| {
        ctl.send(Cmd::Release { id });
        r
    };
    // 1. the TCP connection inside the tunnel (the WireGuard handshake rides in this wait)
    let until = Instant::now() + CONNECT_WAIT;
    loop {
        match ev_rx.recv_timeout(until.saturating_duration_since(Instant::now())) {
            Ok(Ev::Connected) => break,
            Ok(Ev::Reset(e)) => return release(HttpReply::error(502, &format!("root '{peer}': {e}"))),
            Ok(_) => continue,
            Err(_) => {
                return release(HttpReply::error(
                    504,
                    &format!("no tunnel to root '{peer}' (no answer inside WireGuard in {}s: not linked, or its key is not approved)", CONNECT_WAIT.as_secs()),
                ))
            }
        }
    }
    ctl.send(Cmd::Write { id, data: encode_request(peer, req) });
    // 2. the whole reply, until the far side closes
    let until = Instant::now() + CALL_WAIT;
    let mut buf: Vec<u8> = Vec::new();
    loop {
        match ev_rx.recv_timeout(until.saturating_duration_since(Instant::now())) {
            Ok(Ev::Data(d)) => {
                buf.extend_from_slice(&d);
                if buf.len() > switch::MAX_BODY + 64 * 1024 {
                    return release(HttpReply::error(502, "reply over the body limit"));
                }
            }
            Ok(Ev::Connected) => {}
            Ok(Ev::Eof) => break,
            Ok(Ev::Reset(e)) => return release(HttpReply::error(502, &format!("root '{peer}': {e}"))),
            Err(_) => return release(HttpReply::error(504, &format!("root '{peer}' did not answer in {}s", CALL_WAIT.as_secs()))),
        }
    }
    let reply = match parse_head(&buf) {
        None => HttpReply::error(502, &format!("root '{peer}' closed without a reply")),
        Some(Err(e)) => HttpReply::error(502, &e),
        Some(Ok((start, headers, head))) => {
            let status = start.split(' ').nth(1).and_then(|s| s.parse::<u16>().ok()).filter(|s| (100..=599).contains(s));
            let body = buf[head..].to_vec();
            let want = header(&headers, "content-length").and_then(|v| v.parse::<usize>().ok());
            match status {
                None => HttpReply::error(502, "malformed status line"),
                Some(_) if want.is_some_and(|w| w != body.len()) => HttpReply::error(502, "the reply was cut short"),
                Some(st) => HttpReply { status: st, headers: pass_map(&headers), body },
            }
        }
    };
    release(reply)
}

fn write_reply(s: &mut TcpStream, r: &HttpReply) {
    let _ = s.write_all(&encode_reply(r));
    let _ = s.flush();
    let _ = s.shutdown(Shutdown::Write);
}

/// One front-door connection (loopback; this root's own brain or a local tool).
fn serve_front(mut s: TcpStream, ctl: Ctl) {
    if !s.peer_addr().is_ok_and(|a| a.ip().is_loopback()) {
        return;
    }
    let _ = s.set_read_timeout(Some(Duration::from_secs(15)));
    let _ = s.set_nodelay(true);
    let mut rd = match s.try_clone() {
        Ok(r) => r,
        Err(_) => return,
    };
    let got = read_request(|buf| {
        let mut chunk = [0u8; 65536];
        match rd.read(&mut chunk) {
            Ok(0) => Ok(false),
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                Ok(true)
            }
            Err(e) => Err(e.to_string()),
        }
    });
    let r = match got {
        Err((st, msg)) => return write_reply(&mut s, &HttpReply::error(st, &msg)),
        Ok(r) => r,
    };
    // the same guard as the switchboard's /_root/: no browsers, no proxies
    if r.raw_headers.iter().any(|(k, _)| {
        matches!(k.as_str(), "origin" | "forwarded" | "x-forwarded-for" | "x-real-ip") || k.starts_with("sec-fetch-")
    }) {
        return write_reply(&mut s, &HttpReply::error(403, "the tunnel's front door serves this root's own brain only (no browsers, no proxies)"));
    }
    let path = r.target.clone();
    let json_reply = |v: &Value| {
        let mut h = Map::new();
        h.insert("content-type".into(), json!("application/json"));
        HttpReply { status: 200, headers: h, body: v.to_string().into_bytes() }
    };
    let bare = path.split('?').next().unwrap_or_default();
    if bare == "/_wg" || bare == "/_wg/_node" {
        if r.method != "GET" {
            return write_reply(&mut s, &HttpReply::error(405, "GET only"));
        }
        let reply = match ctl.stats() {
            Some((peers, node)) => json_reply(if bare == "/_wg" { &peers } else { &node }),
            None => HttpReply::error(503, "the tunnel engine did not answer"),
        };
        return write_reply(&mut s, &reply);
    }
    let Some(tail) = path.strip_prefix("/_wg/") else {
        return write_reply(&mut s, &HttpReply::error(404, "use /_wg/<root>/<path> (local = the hub), or GET /_wg"));
    };
    let cut = tail.find(['/', '?']).unwrap_or(tail.len());
    let (peer, rest) = (&tail[..cut], &tail[cut..]);
    if !valid_addr(peer) {
        return write_reply(&mut s, &HttpReply::error(404, "use /_wg/<root>/<path> (local = the hub)"));
    }
    let rest = if rest.starts_with('/') { rest.to_string() } else { format!("/{rest}") };
    let reply = match HttpReq::new(&r.method, &rest, r.headers, r.body) {
        Err(e) => HttpReply::error(400, &e),
        Ok(req) => tunnel_call(&ctl, peer, &req),
    };
    write_reply(&mut s, &reply);
}

/* ------------------------------------------------------------------ the node */

pub struct NodeHandle {
    pub http: SocketAddr,
    pub udp: SocketAddr,
    pub public: [u8; 32],
}

/// Start a node from its config: the engine thread + the front door. Returns at once.
pub fn start(cfg: NodeConfig) -> Result<NodeHandle, String> {
    let (secret, public) = load_or_create_key(&cfg.key_file)?;
    let udp_addr: SocketAddr = cfg.udp.parse().map_err(|e| format!("wg.udp: {e}"))?;
    let relay: SocketAddr = cfg.relay.parse().map_err(|e| format!("wg.relay: {e}"))?;
    let http_addr: SocketAddr = cfg.http.parse().map_err(|e| format!("wg.http: {e}"))?;
    for (k, a) in [("udp", udp_addr), ("relay", relay), ("http", http_addr)] {
        if !a.ip().is_loopback() {
            return Err(format!("wg.{k} {a}: loopback only (the relay carries WireGuard; nothing listens outside)"));
        }
    }
    let address = cfg.address.as_deref().map(parse_cidr4).transpose().map_err(|e| format!("wg.address {e}"))?;
    let mut statics = vec![];
    for p in &cfg.peer {
        if !valid_addr(&p.id) {
            return Err(format!("wg.peer '{}': not a root id (or local)", p.id));
        }
        let public = decode_key(&p.public_key).map_err(|e| format!("wg.peer '{}': {e}", p.id))?;
        let ip: Ipv4Addr = p.ip.parse().map_err(|e| format!("wg.peer '{}' ip: {e}", p.id))?;
        statics.push(PeerSpec { id: p.id.clone(), public, ip, proactive: true });
    }
    if address.is_none() && cfg.roots_file.is_none() {
        return Err("wg: give `address` (a joined root) or `roots_file` (the hub)".into());
    }
    let std_udp = UdpSocket::bind(udp_addr).map_err(|e| format!("wg udp bind {udp_addr}: {e}"))?;
    let udp_bound = std_udp.local_addr().map_err(|e| e.to_string())?;
    std_udp.set_nonblocking(true).map_err(|e| e.to_string())?;
    let listener = TcpListener::bind(http_addr).map_err(|e| format!("wg http bind {http_addr}: {e}"))?;
    let http_bound = listener.local_addr().map_err(|e| e.to_string())?;
    let waker = Arc::new(Waker {
        sock: UdpSocket::bind("127.0.0.1:0").map_err(|e| e.to_string())?,
        to: udp_bound,
    });
    let (cmd_tx, cmd_rx) = tokio::sync::mpsc::unbounded_channel::<Cmd>();
    let source = Source {
        statics,
        address,
        roots_file: cfg.roots_file.clone().map(PathBuf::from),
        devices: cfg.devices_file.clone().map(crate::tokens::TokenStore::open),
        warned: Default::default(),
    };
    let brain = cfg.brain.clone().map(|b| b.trim_end_matches('/').to_string());
    let public_bytes = *public.as_bytes();
    let ctl = Ctl { tx: cmd_tx.clone(), waker: waker.clone() };
    let (ready_tx, ready_rx) = mpsc::channel::<Result<(), String>>();
    std::thread::Builder::new()
        .name("wg-engine".into())
        .spawn(move || {
            let rt = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
                Ok(rt) => rt,
                Err(e) => {
                    let _ = ready_tx.send(Err(e.to_string()));
                    return;
                }
            };
            rt.block_on(async move {
                let udp = match tokio::net::UdpSocket::from_std(std_udp) {
                    Ok(u) => Arc::new(u),
                    Err(e) => {
                        let _ = ready_tx.send(Err(e.to_string()));
                        return;
                    }
                };
                let mut dev = VDev { rx: VecDeque::new(), tx: VecDeque::new() };
                let mut icfg = IfaceConfig::new(HardwareAddress::Ip);
                icfg.random_seed = OsRng.next_u64();
                let t0 = Instant::now();
                let iface = Interface::new(icfg, &mut dev, smoltcp::time::Instant::from_micros(0));
                let mut e = Engine {
                    secret,
                    public,
                    relay,
                    udp: udp.clone(),
                    addr: None,
                    peers: HashMap::new(),
                    by_pub: HashMap::new(),
                    by_idx: HashMap::new(),
                    by_ip: HashMap::new(),
                    next_idx: OsRng.next_u32() & 0xffff,
                    source,
                    iface,
                    dev,
                    sockets: SocketSet::new(vec![]),
                    streams: HashMap::new(),
                    listeners: vec![],
                    next_id: 0,
                    next_port: 40000 + (OsRng.next_u32() % 20000) as u16,
                    cmd_tx,
                    waker,
                    brain,
                    agent: ureq::AgentBuilder::new().timeout(CALL_WAIT).redirects(0).build(),
                    c: Counters::default(),
                    t0,
                    scratch: vec![0u8; 65536],
                };
                e.reload();
                let _ = ready_tx.send(Ok(()));
                let mut cmd_rx = cmd_rx;
                let mut buf = vec![0u8; 65536];
                let mut last_timers = Instant::now();
                let mut last_reload = Instant::now();
                loop {
                    let wait = e.delay();
                    enum Wake {
                        Udp(usize, SocketAddr),
                        Cmd(Option<Cmd>),
                        Tick,
                    }
                    let w = tokio::select! {
                        r = udp.recv_from(&mut buf) => match r { Ok((n, f)) => Wake::Udp(n, f), Err(_) => Wake::Tick },
                        c = cmd_rx.recv() => Wake::Cmd(c),
                        _ = tokio::time::sleep(wait) => Wake::Tick,
                    };
                    match w {
                        Wake::Udp(n, f) => {
                            let d = buf[..n].to_vec();
                            e.on_udp(&d, f);
                        }
                        Wake::Cmd(Some(c)) => e.on_cmd(c),
                        Wake::Cmd(None) => return,
                        Wake::Tick => {}
                    }
                    for _ in 0..256 {
                        match udp.try_recv_from(&mut buf) {
                            Ok((n, f)) => {
                                let d = buf[..n].to_vec();
                                e.on_udp(&d, f);
                            }
                            Err(_) => break,
                        }
                    }
                    while let Ok(c) = cmd_rx.try_recv() {
                        e.on_cmd(c);
                    }
                    e.pump();
                    if last_timers.elapsed() >= Duration::from_millis(100) {
                        last_timers = Instant::now();
                        e.timers();
                    }
                    if last_reload.elapsed() >= Duration::from_secs(1) {
                        last_reload = Instant::now();
                        e.reload();
                    }
                }
            });
        })
        .map_err(|e| e.to_string())?;
    ready_rx.recv_timeout(Duration::from_secs(5)).map_err(|_| "wg engine did not start".to_string())??;
    let busy = Arc::new(AtomicUsize::new(0));
    std::thread::Builder::new()
        .name("wg-front".into())
        .spawn(move || {
            for conn in listener.incoming() {
                let Ok(s) = conn else { continue };
                if busy.fetch_add(1, Ordering::SeqCst) >= 64 {
                    busy.fetch_sub(1, Ordering::SeqCst);
                    let mut s = s;
                    write_reply(&mut s, &HttpReply::error(503, "too many tunnel calls at once"));
                    continue;
                }
                let (ctl, busy) = (ctl.clone(), busy.clone());
                std::thread::spawn(move || {
                    serve_front(s, ctl);
                    busy.fetch_sub(1, Ordering::SeqCst);
                });
            }
        })
        .map_err(|e| e.to_string())?;
    Ok(NodeHandle { http: http_bound, udp: udp_bound, public: public_bytes })
}

/// `bifrost-net wg -c NODE.toml` — run a node until killed.
pub fn run(path: &str) -> Result<(), String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("{path}: {e}"))?;
    let f: NodeFile = toml::from_str(&text).map_err(|e| format!("{path}: {e}"))?;
    let cfg = f.wg;
    let h = start(cfg.clone())?;
    println!("bifrost-net wg (config: {path})");
    println!("  key {} (fp {}) — the private half stays in {}", B64.encode(h.public), fingerprint(&h.public), cfg.key_file);
    println!("  relay udp {} → {} (WireGuard datagrams in relay frames)", h.udp, cfg.relay);
    println!("  front door http://{}/_wg/<root>/<path> (loopback) · GET /_wg lists the peers", h.http);
    match &cfg.brain {
        Some(b) => println!("  in-tunnel door :{IN_TUNNEL_PORT} → brain {b}"),
        None => println!("  in-tunnel door :{IN_TUNNEL_PORT} → no brain (answers 501)"),
    }
    if let Some(r) = &cfg.roots_file {
        println!("  peers: the pinned roots in {r} (approver live in {})", cfg.devices_file.as_deref().unwrap_or("-"));
    }
    println!("bifrost-net wg serving — Ctrl-C to stop");
    loop {
        std::thread::sleep(Duration::from_secs(3600));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relay_frames_roundtrip_and_reject_junk() {
        let f = frame("mac-studio", &[4, 0, 0, 0, 9]);
        assert_eq!(unframe(&f), Some(("mac-studio", &[4u8, 0, 0, 0, 9][..])));
        assert_eq!(unframe(&[]), None);
        assert_eq!(unframe(&[5, b'a']), None);
        assert_eq!(unframe(&frame("a/b", b"x")), None);
        assert_eq!(unframe(&frame("", b"x")), None);
    }

    #[test]
    fn wg_shapes() {
        let mut init = vec![1, 0, 0, 0];
        init.resize(148, 7);
        assert_eq!(wg_kind(&init), Some(WgKind::Init));
        let mut data = vec![4, 0, 0, 0];
        data.resize(32, 0);
        assert_eq!(wg_kind(&data), Some(WgKind::Data));
        data.resize(48, 0);
        assert_eq!(wg_kind(&data), Some(WgKind::Data));
        data.resize(31, 0);
        assert_eq!(wg_kind(&data), None);
        assert_eq!(wg_kind(b"GET /root HTTP/1.1\r\n"), None);
        assert_eq!(wg_kind(b"{\"op\":\"http\"}"), None);
    }

    #[test]
    fn fingerprint_is_stable_and_short() {
        let k = [7u8; 32];
        let fp = fingerprint(&k);
        assert_eq!(fp.len(), 14);
        assert_eq!(fp, fingerprint(&k));
        assert_ne!(fp, fingerprint(&[8u8; 32]));
        // the reference vector the app (JS) and the joiner (Python) check against
        let zero = fingerprint(&[0u8; 32]);
        assert_eq!(zero, "6668-7aad-f862");
    }

    /// A brain on loopback: GET /root names it, POST /echo answers the body back.
    fn fake_brain(name: &'static str) -> String {
        let srv = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let url = format!("http://{}", srv.server_addr().to_ip().unwrap());
        std::thread::spawn(move || {
            for mut rq in srv.incoming_requests() {
                let mut body = vec![];
                let _ = rq.as_reader().read_to_end(&mut body);
                let peer_hdr = rq.headers().iter().find(|h| h.field.equiv("x-ygg-peer")).map(|h| h.value.to_string());
                let leaked = rq.headers().iter().any(|h| h.field.equiv("authorization") || h.field.equiv("x-evil"));
                let out = match rq.url() {
                    "/root" => json!({ "name": name, "peer": peer_hdr, "leaked": leaked }).to_string().into_bytes(),
                    "/echo" => body,
                    _ => b"{\"error\":\"no route\"}".to_vec(),
                };
                let st = if rq.url() == "/root" || rq.url() == "/echo" { 200 } else { 404 };
                let h = tiny_http::Header::from_bytes(&b"content-type"[..], &b"application/json"[..]).unwrap();
                let _ = rq.respond(tiny_http::Response::from_data(out).with_status_code(st).with_header(h));
            }
        });
        url
    }

    /// The bridge's part, in miniature: hub node A ("local") <-> joined nodes by link id.
    /// `mode`: 0 pass, 1 replay the next data frame, 2 tamper the next data frame.
    struct FakeRelay {
        seen: Arc<std::sync::Mutex<Vec<Vec<u8>>>>,
        mode: Arc<std::sync::atomic::AtomicU8>,
    }

    fn fake_relay(a_udp: SocketAddr, links: Vec<(&'static str, UdpSocket, SocketAddr)>, a_side: UdpSocket) -> FakeRelay {
        let seen = Arc::new(std::sync::Mutex::new(vec![]));
        let mode = Arc::new(std::sync::atomic::AtomicU8::new(0));
        let a_side = Arc::new(a_side);
        let table: Arc<Vec<(&'static str, Arc<UdpSocket>, SocketAddr)>> =
            Arc::new(links.into_iter().map(|(id, s, n)| (id, Arc::new(s), n)).collect());
        // from the hub node: [dest][dgram] -> that link as [local][dgram]
        {
            let (a_side, table, seen) = (a_side.clone(), table.clone(), seen.clone());
            std::thread::spawn(move || {
                let mut buf = vec![0u8; 65536];
                loop {
                    let Ok((n, _)) = a_side.recv_from(&mut buf) else { continue };
                    let Some((to, d)) = unframe(&buf[..n]) else { continue };
                    seen.lock().unwrap().push(d.to_vec());
                    if let Some((_, s, node)) = table.iter().find(|(id, _, _)| *id == to) {
                        let _ = s.send_to(&frame("local", d), node);
                    }
                }
            });
        }
        // from a joined node on its link: [local][dgram] -> the hub node as [link id][dgram]
        for (id, s, _) in table.iter() {
            let (id, s, a_side, seen, mode) = (*id, s.clone(), a_side.clone(), seen.clone(), mode.clone());
            std::thread::spawn(move || {
                let mut buf = vec![0u8; 65536];
                loop {
                    let Ok((n, _)) = s.recv_from(&mut buf) else { continue };
                    let Some((to, d)) = unframe(&buf[..n]) else { continue };
                    if to != "local" {
                        continue;
                    }
                    seen.lock().unwrap().push(d.to_vec());
                    let mut d = d.to_vec();
                    let m = mode.load(Ordering::SeqCst);
                    if m != 0 && wg_kind(&d) == Some(WgKind::Data) && d.len() > 64 {
                        mode.store(0, Ordering::SeqCst);
                        if m == 1 {
                            let _ = a_side.send_to(&frame(id, &d), a_udp);
                        } else {
                            let at = d.len() - 20;
                            d[at] ^= 0x5a;
                        }
                    }
                    let _ = a_side.send_to(&frame(id, &d), a_udp);
                }
            });
        }
        FakeRelay { seen, mode }
    }

    fn http(addr: SocketAddr, method: &str, path: &str, body: &[u8], extra: &str) -> (u16, Vec<u8>) {
        let mut s = TcpStream::connect(addr).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(30))).unwrap();
        let head = format!("{method} {path} HTTP/1.1\r\nhost: x\r\ncontent-length: {}\r\ncontent-type: application/json\r\n{extra}\r\n", body.len());
        s.write_all(head.as_bytes()).unwrap();
        s.write_all(body).unwrap();
        let mut out = vec![];
        let _ = s.read_to_end(&mut out);
        let (start, _, at) = parse_head(&out).expect("a reply head").unwrap();
        (start.split(' ').nth(1).unwrap().parse().unwrap(), out[at..].to_vec())
    }

    fn stats(addr: SocketAddr) -> Value {
        serde_json::from_slice(&http(addr, "GET", "/_wg/_node", b"", "").1).unwrap()
    }

    #[test]
    fn two_nodes_through_a_relay_end_to_end() {
        let dir = std::env::temp_dir().join(format!("wg-test-{}", OsRng.next_u32()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = |n: &str| dir.join(n).to_string_lossy().to_string();
        let free_udp = || UdpSocket::bind("127.0.0.1:0").unwrap();
        // keys: the hub (A), the approved root (B), a root nobody approved (C)
        let (_, a_pub) = load_or_create_key(&p("a.key")).unwrap();
        let (_, b_pub) = load_or_create_key(&p("b.key")).unwrap();
        let (_, _c_pub) = load_or_create_key(&p("c.key")).unwrap();
        let b64 = |k: &PublicKey| B64.encode(k.as_bytes());
        let roots = json!({ "version": 1, "wg": { "net": "10.77.3.0/24" },
            "roots": [{ "id": "b", "dev": "dev_ok", "wg_pub": b64(&b_pub), "wg_ip": "10.77.3.2" }] });
        std::fs::write(p("roots.json"), roots.to_string()).unwrap();
        let devs = |revoked: bool| json!({ "devices": [{ "id": "dev_ok", "tokenHash": "00", "revoked": revoked, "roots": ["b"] }] });
        std::fs::write(p("devices.json"), devs(false).to_string()).unwrap();
        // sockets: the relay's side of each leg
        let (ra, rb, rc) = (free_udp(), free_udp(), free_udp());
        let (ra_addr, rb_addr, rc_addr) = (ra.local_addr().unwrap(), rb.local_addr().unwrap(), rc.local_addr().unwrap());
        let node = |key: &str, relay: SocketAddr, brain: Option<String>, address: Option<&str>, roots: bool, peer: Option<&PublicKey>| {
            start(NodeConfig {
                key_file: p(key),
                udp: "127.0.0.1:0".into(),
                relay: relay.to_string(),
                http: "127.0.0.1:0".into(),
                brain,
                address: address.map(String::from),
                roots_file: roots.then(|| p("roots.json")),
                devices_file: roots.then(|| p("devices.json")),
                peer: peer.map(|k| vec![StaticPeer { id: "local".into(), public_key: b64(k), ip: "10.77.3.1".into() }]).unwrap_or_default(),
            })
            .unwrap()
        };
        let a = node("a.key", ra_addr, Some(fake_brain("A")), None, true, None);
        let b = node("b.key", rb_addr, Some(fake_brain("B")), Some("10.77.3.2/24"), false, Some(&a_pub));
        let c = node("c.key", rc_addr, Some(fake_brain("C")), Some("10.77.3.9/24"), false, Some(&a_pub));
        let relay = fake_relay(a.udp, vec![("b", rb, b.udp), ("c", rc, c.udp)], ra);

        // B -> the hub's brain, and the hub -> B's brain, inside the tunnel
        let (st, body) = http(b.http, "GET", "/_wg/local/root", b"", "x-ygg-peer: tok\r\nauthorization: Bearer no\r\nx-evil: 1\r\n");
        let v: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!((st, v["name"].as_str(), v["peer"].as_str(), v["leaked"].as_bool()), (200, Some("A"), Some("tok"), Some(false)), "{v}");
        let (st, body) = http(a.http, "GET", "/_wg/b/root", b"", "");
        assert_eq!((st, serde_json::from_slice::<Value>(&body).unwrap()["name"].as_str()), (200, Some("B")));
        let big: Vec<u8> = (0..300_000u32).map(|i| b"0123456789abcdef"[(i % 16) as usize]).collect();
        let (st, body) = http(a.http, "POST", "/_wg/b/echo", &big, "");
        assert!(st == 200 && body == big, "300 KB echo through the tunnel: {st} {}", body.len());
        let mut lat = vec![];
        for _ in 0..20 {
            let t = Instant::now();
            assert_eq!(http(a.http, "GET", "/_wg/b/root", b"", "").0, 200);
            lat.push(t.elapsed().as_secs_f64() * 1000.0);
        }
        lat.sort_by(|x, y| x.partial_cmp(y).unwrap());
        eprintln!("LATENCY in-process relay: median {:.2} ms, max {:.2} ms", lat[10], lat[19]);
        let (st, _) = http(a.http, "GET", "/_wg/b/nope", b"", "");
        assert_eq!(st, 404, "the brain's own status crosses");
        let (st, _) = http(a.http, "GET", "/_wg/ghost/root", b"", "");
        assert_eq!(st, 502, "an unknown peer is a clean 502");
        let (st, _) = http(a.http, "GET", "/_wg/b/root", b"", "origin: https://evil.example\r\n");
        assert_eq!(st, 403, "browsers are refused at the front door");

        // the relay only ever carried WireGuard: no HTTP, no body bytes
        {
            let seen = relay.seen.lock().unwrap();
            assert!(seen.len() > 50 && seen.iter().all(|d| wg_kind(d).is_some()), "{} frames", seen.len());
            let all: Vec<u8> = seen.concat();
            for needle in [&b"GET /root"[..], b"HTTP/1.1", b"0123456789abcdef0123", b"\"name\""] {
                assert!(!all.windows(needle.len()).any(|w| w == needle), "plaintext {:?} crossed the relay", String::from_utf8_lossy(needle));
            }
        }

        // a replayed and a tampered packet are dropped; the calls still succeed
        relay.mode.store(1, Ordering::SeqCst);
        let (st, body) = http(b.http, "POST", "/_wg/local/echo", &big, "");
        assert!(st == 200 && body == big);
        relay.mode.store(2, Ordering::SeqCst);
        let (st, body) = http(b.http, "POST", "/_wg/local/echo", &big, "");
        assert!(st == 200 && body == big);
        let s = stats(a.http);
        assert!(s["dropped"]["replay"].as_u64() >= Some(1), "replay not counted: {s}");
        assert!(s["dropped"]["auth_fail"].as_u64() >= Some(1), "tamper not counted: {s}");

        // C has a valid link but an unpinned key: nothing gets through
        let t = Instant::now();
        let (st, _) = http(c.http, "GET", "/_wg/local/root", b"", "");
        assert_eq!(st, 504, "an unapproved key reached the hub");
        assert!(t.elapsed() < Duration::from_secs(15));
        assert!(stats(a.http)["dropped"]["unknown_key"].as_u64() >= Some(1));

        // revoking the approving device cuts B's tunnel within a reload
        std::fs::write(p("devices.json"), devs(true).to_string()).unwrap();
        std::thread::sleep(Duration::from_millis(1800));
        let (st, _) = http(a.http, "GET", "/_wg/b/root", b"", "");
        assert_eq!(st, 502, "the hub still reaches a root whose approver was revoked");
        let (st, _) = http(b.http, "GET", "/_wg/local/root", b"", "");
        assert_eq!(st, 504, "a root whose approver was revoked still reaches the hub");
        let list: Value = serde_json::from_slice(&http(a.http, "GET", "/_wg", b"", "").1).unwrap();
        assert_eq!(list, json!([]));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn cidr_and_net() {
        assert_eq!(parse_cidr4("10.9.8.2/24").unwrap(), (Ipv4Addr::new(10, 9, 8, 2), 24));
        assert!(parse_cidr4("10.9.8.2").is_err() && parse_cidr4("10.9.8.2/32").is_err());
        assert!(in_net(Ipv4Addr::new(10, 9, 8, 77), (Ipv4Addr::new(10, 9, 8, 0), 24)));
        assert!(!in_net(Ipv4Addr::new(10, 9, 9, 1), (Ipv4Addr::new(10, 9, 8, 0), 24)));
    }
}
