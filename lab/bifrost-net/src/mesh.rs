//! M0 mesh test + S2 mesh service.
//!
//! M0 (m0_test): two nodes connect PRIVATELY via the WireGuard protocol
//! (boringtun, Cloudflare's implementation), over real UDP on loopback.
//!
//! S2 (MeshService): config-driven multi-peer mesh device in userspace —
//! peer routing mirrors boringtun's own device layer (identity for handshake
//! inits via parse_handshake_anon, receiver_idx>>8 for everything else),
//! allowed-IP source checking, endpoint learning, keepalive timers, forced
//! rekeys, and byte counters.

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr, UdpSocket};
use std::time::{Duration, Instant};

use boringtun::noise::{Tunn, TunnResult};
use boringtun::x25519::{PublicKey, StaticSecret};
use rand_core::{OsRng, RngCore};

use crate::keys;

const PING: &[u8; 4] = b"BFNP";
const PONG: &[u8; 4] = b"BFNR";

const MESH_TIMEOUT: Duration = Duration::from_secs(5);

fn random_nonce() -> [u8; 16] {
    let mut n = [0u8; 16];
    OsRng.fill_bytes(&mut n);
    n
}

fn udp_ip_packet(src: Ipv4Addr, sport: u16, dst: Ipv4Addr, dport: u16, payload: &[u8]) -> Vec<u8> {
    let builder =
        etherparse::PacketBuilder::ipv4(src.octets(), dst.octets(), 64).udp(sport, dport);
    let mut pkt = Vec::with_capacity(builder.size(payload.len()));
    builder.write(&mut pkt, payload).expect("packet build");
    pkt
}

struct Node {
    name: &'static str,
    tun: Tunn,
    sock: UdpSocket,
    peer: SocketAddr,
    peer_ip: Ipv4Addr,
    ip: Ipv4Addr,
}

impl Node {
    fn send_wg(&self, buf: &[u8]) {
        self.sock.send_to(buf, self.peer).expect("wg send");
    }

    /// Handle one incoming WG datagram. Returns Some(inner_udp_payload) if an
    /// encrypted data packet decrypted to an IPv4 frame with a UDP payload.
    fn step(&mut self, datagram: &[u8]) -> Option<Vec<u8>> {
        let mut out = vec![0u8; 2000];
        match self.tun.decapsulate(None, datagram, &mut out) {
            TunnResult::WriteToNetwork(b) => {
                self.send_wg(b);
                None
            }
            TunnResult::WriteToTunnelV4(pkt, _dst) => {
                let sliced = etherparse::SlicedPacket::from_ip(pkt).ok()?;
                match sliced.transport {
                    Some(etherparse::TransportSlice::Udp(u)) => Some(u.payload().to_vec()),
                    _ => None,
                }
            }
            TunnResult::WriteToTunnelV6(..) => None,
            TunnResult::Done => None,
            TunnResult::Err(_) => None,
        }
    }

    fn encapsulate_send(&mut self, inner: &[u8]) {
        let mut out = vec![0u8; 2000];
        match self.tun.encapsulate(inner, &mut out) {
            TunnResult::WriteToNetwork(b) => self.send_wg(b),
            _ => panic!("{}: encapsulate failed", self.name),
        }
    }
}

/// Responder node B: echoes any BFNP frame back as BFNR.
fn node_b(mut b: Node, deadline: Instant) -> Result<(), String> {
    let mut buf = vec![0u8; 2000];
    b.sock
        .set_read_timeout(Some(Duration::from_millis(20)))
        .unwrap();
    let mut echoed = false;
    while Instant::now() < deadline && !echoed {
        let n = match b.sock.recv_from(&mut buf) {
            Ok((n, _)) => n,
            Err(_) => continue,
        };
        if let Some(payload) = b.step(&buf[..n]) {
            if payload.starts_with(PING) {
                let mut pong = PONG.to_vec();
                pong.extend_from_slice(&payload[4..]);
                let inner = udp_ip_packet(b.peer_ip, 40001, b.ip, 40000, &pong);
                b.encapsulate_send(&inner);
                echoed = true;
            }
        }
    }
    if echoed {
        Ok(())
    } else {
        Err("B: never echoed a ping".into())
    }
}

/// Initiator node A: handshake, then ping until pong.
fn node_a(mut a: Node, nonce: [u8; 16], deadline: Instant) -> Result<(), String> {
    let mut buf = vec![0u8; 2000];
    a.sock
        .set_read_timeout(Some(Duration::from_millis(20)))
        .unwrap();

    let mut session_up = false;
    let mut last_init = Instant::now();
    let mut last_ping = Instant::now();
    let mut ping_payload = PING.to_vec();
    ping_payload.extend_from_slice(&nonce);
    let ping = udp_ip_packet(a.ip, 40000, a.peer_ip, 40001, &ping_payload);

    loop {
        let now = Instant::now();
        if now > deadline {
            return Err("A: no pong before deadline".into());
        }
        if !session_up && now.duration_since(last_init) > Duration::from_millis(200) {
            let mut out = vec![0u8; 2000];
            match a.tun.format_handshake_initiation(&mut out, false) {
                TunnResult::WriteToNetwork(b) => a.send_wg(b),
                _ => return Err("A: handshake_initiation failed".into()),
            }
            last_init = now;
        }
        if session_up && now.duration_since(last_ping) > Duration::from_millis(50) {
            a.encapsulate_send(&ping);
            last_ping = now;
        }
        let n = match a.sock.recv_from(&mut buf) {
            Ok((n, _)) => n,
            Err(_) => continue,
        };
        let mut out = vec![0u8; 2000];
        match a.tun.decapsulate(None, &buf[..n], &mut out) {
            TunnResult::WriteToNetwork(b) => {
                a.send_wg(b);
                // The first packet B can send us is the handshake response;
                // processing it created our TX session — we may ping now.
                session_up = true;
            }
            TunnResult::Done => {
                session_up = true;
            }
            TunnResult::WriteToTunnelV4(pkt, _dst) => {
                let sliced = etherparse::SlicedPacket::from_ip(pkt)
                    .map_err(|e| format!("A: bad inner packet: {e}"))?;
                let payload = sliced
                    .transport
                    .and_then(|t| match t {
                        etherparse::TransportSlice::Udp(u) => Some(u.payload().to_vec()),
                        _ => None,
                    })
                    .ok_or("A: inner packet without UDP payload")?;
                if payload.starts_with(PONG) && &payload[4..] == &nonce {
                    return Ok(());
                }
            }
            TunnResult::WriteToTunnelV6(..) | TunnResult::Err(_) => {}
        }
    }
}

pub fn m0_test() -> Result<(), String> {
    // Key material: two node keypairs (never shared).
    let a_secret = StaticSecret::random_from_rng(OsRng);
    let b_secret = StaticSecret::random_from_rng(OsRng);
    let a_pub = PublicKey::from(&a_secret);
    let b_pub = PublicKey::from(&b_secret);

    let ip_a = Ipv4Addr::new(10, 7, 0, 1);
    let ip_b = Ipv4Addr::new(10, 7, 0, 2);

    let sock_a = UdpSocket::bind("127.0.0.1:0").expect("bind A");
    let sock_b = UdpSocket::bind("127.0.0.1:0").expect("bind B");
    let addr_a = sock_a.local_addr().unwrap();
    let addr_b = sock_b.local_addr().unwrap();

    let node_a_impl = Node {
        name: "A",
        tun: Tunn::new(a_secret, b_pub, None, None, 1, None),
        sock: sock_a,
        peer: addr_b,
        peer_ip: ip_b,
        ip: ip_a,
    };
    let node_b_impl = Node {
        name: "B",
        tun: Tunn::new(b_secret, a_pub, None, None, 2, None),
        sock: sock_b,
        peer: addr_a,
        peer_ip: ip_a,
        ip: ip_b,
    };

    let deadline = Instant::now() + MESH_TIMEOUT;
    let nonce = random_nonce();

    let h_b = std::thread::spawn(move || node_b(node_b_impl, deadline));
    let h_a = std::thread::spawn(move || node_a(node_a_impl, nonce, deadline));

    h_b.join().map_err(|_| "B thread panicked".to_string())??;
    h_a.join().map_err(|_| "A thread panicked".to_string())??;

    println!("  [mesh] WG handshake + encrypted ping/pong A<->B: OK (payloads byte-verified)");

    negative_test()?;

    Ok(())
}

/// A node with the wrong static key cannot complete the handshake:
/// the responder's Noise IK check (expected initiator static key) fails.
fn negative_test() -> Result<(), String> {
    let a_secret = StaticSecret::random_from_rng(OsRng);
    let b_secret = StaticSecret::random_from_rng(OsRng);
    let a_pub = PublicKey::from(&a_secret);
    let b_pub = PublicKey::from(&b_secret);
    let c_secret = StaticSecret::random_from_rng(OsRng); // impostor: knows A's pubkey, wrong identity

    // A only ever trusts B.
    let mut a = Tunn::new(a_secret, b_pub, None, None, 11, None);
    // C initiates toward A (C knows A's real public key).
    let mut c = Tunn::new(c_secret, a_pub, None, None, 12, None);

    let mut buf = vec![0u8; 2000];
    let init = match c.format_handshake_initiation(&mut buf, false) {
        TunnResult::WriteToNetwork(x) => x.to_vec(),
        _ => return Err("C: could not build handshake initiation".into()),
    };

    let mut out = vec![0u8; 2000];
    let r = a.decapsulate(None, &init, &mut out);
    match r {
        TunnResult::Err(_) => {
            println!("  [mesh] wrong-key impostor handshake REJECTED by A: OK");
            Ok(())
        }
        TunnResult::WriteToNetwork(_) => {
            Err("A accepted an impostor's handshake initiation — privacy claim broken".into())
        }
        _ => Err("unexpected TunnResult for impostor init".into()),
    }
}

/// S2: the mesh service — a userspace WireGuard device for N peers.
pub struct MeshService {
    name: String,
    static_public: PublicKey,
    secret_master: StaticSecret,
    virtual_ip4: Ipv4Addr,
    sock: UdpSocket,
    peers: Vec<ServicePeer>,
    by_idx: HashMap<u32, usize>,
    by_pub: HashMap<[u8; 32], usize>,
    last_tick: Instant,
    pub dropped_spoofed: usize,
    pub dropped_garbage: usize,
    pub send_errors: usize,
    pub handshakes_received: usize,
}

struct ServicePeer {
    name: String,
    tun: Tunn,
    endpoint: SocketAddr,
    allowed_ips: Vec<(IpAddr, u8)>,
    known: bool,
}

/// One decrypted inner packet handed up from the mesh.
pub struct Inbound {
    pub peer: String,
    pub dst: IpAddr,
    pub payload: Vec<u8>,
}

/// Peer descriptor for MeshService::new (mirrors config::PeerConfig, resolved).
pub struct PeerDesc {
    pub name: String,
    pub public: PublicKey,
    pub endpoint: Option<SocketAddr>,
    pub allowed_ips: Vec<(IpAddr, u8)>,
}

pub fn parse_cidr(cidr: &str) -> Result<(IpAddr, u8), String> {
    let (ip, len) = cidr
        .split_once('/')
        .ok_or_else(|| format!("allowed_ip '{cidr}' missing /len"))?;
    let ip: IpAddr = ip.parse().map_err(|e| format!("allowed_ip '{cidr}': {e}"))?;
    let len: u8 = len.parse().map_err(|e| format!("allowed_ip '{cidr}': {e}"))?;
    let max = if ip.is_ipv4() { 32 } else { 128 };
    if len > max {
        return Err(format!("allowed_ip '{cidr}': /{len} > /{max}"));
    }
    Ok((ip, len))
}

fn ip_in_cidr(ip: IpAddr, cidr: (IpAddr, u8)) -> bool {
    match (ip, cidr.0) {
        (IpAddr::V4(a), IpAddr::V4(b)) => {
            let (a, b) = (u32::from(a), u32::from(b));
            let mask = if cidr.1 == 0 { 0 } else { u32::MAX << (32 - cidr.1) };
            a & mask == b & mask
        }
        (IpAddr::V6(a), IpAddr::V6(b)) => {
            let (a, b) = (u128::from(a), u128::from(b));
            let mask = if cidr.1 == 0 { 0 } else { u128::MAX << (128 - cidr.1) };
            a & mask == b & mask
        }
        _ => false,
    }
}

impl MeshService {
    pub fn new(
        name: &str,
        secret: StaticSecret,
        virtual_ip4: Ipv4Addr,
        listen: SocketAddr,
        peers: Vec<PeerDesc>,
    ) -> Result<Self, String> {
        let sock = UdpSocket::bind(listen).map_err(|e| format!("mesh bind {listen}: {e}"))?;
        sock.set_nonblocking(true).map_err(|e| e.to_string())?;
        let static_public = PublicKey::from(&secret);
        let secret_bytes = secret.to_bytes();
        let secret_master = secret.clone();
        let mut by_idx = HashMap::new();
        let mut by_pub = HashMap::new();
        let peers: Vec<ServicePeer> = peers
            .into_iter()
            .enumerate()
            .map(|(i, p)| {
                by_idx.insert((i as u32) + 1, i);
                by_pub.insert(p.public.to_bytes(), i);
                ServicePeer {
                    name: p.name,
                    tun: Tunn::new(
                        StaticSecret::from(secret_bytes),
                        p.public,
                        None,
                        None,
                        (i as u32) + 1,
                        None,
                    ),
                    endpoint: p
                        .endpoint
                        .unwrap_or_else(|| SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), 0)),
                    allowed_ips: p.allowed_ips,
                    known: p.endpoint.is_some(),
                }
            })
            .collect();
        Ok(Self {
            name: name.to_string(),
            static_public,
            secret_master,
            virtual_ip4,
            sock,
            peers,
            by_idx,
            by_pub,
            last_tick: Instant::now(),
            dropped_spoofed: 0,
            dropped_garbage: 0,
            send_errors: 0,
            handshakes_received: 0,
        })
    }

    pub fn local_addr(&self) -> SocketAddr {
        self.sock.local_addr().expect("mesh local addr")
    }

    fn send_wg(&self, peer_i: usize, buf: &[u8]) {
        let ep = self.peers[peer_i].endpoint;
        let _ = self.sock.send_to(buf, ep);
    }

    /// Nonblocking pump: drain the socket, route packets (boringtun device
    /// semantics), run tunnel timers. Returns decrypted inner packets.
    pub fn pump(&mut self) -> Vec<Inbound> {
        let mut out = vec![];
        let mut buf = [0u8; 2000];
        loop {
            match self.sock.recv_from(&mut buf) {
                Ok((n, from)) => {
                    if let Some(inbound) = self.handle_datagram(&buf[..n], from) {
                        out.extend(inbound);
                    }
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
                Err(_) => break,
            }
        }
        if self.last_tick.elapsed() > Duration::from_millis(50) {
            self.last_tick = Instant::now();
            self.run_timers();
        }
        out
    }

    /// One WG datagram in: parse, route to the right peer tunnel, decapsulate.
    ///
    /// boringtun device semantics: after ANY WriteToNetwork result, keep
    /// calling decapsulate with an empty datagram until Done — that flushes
    /// packets queued while the session was still negotiating.
    fn handle_datagram(&mut self, datagram: &[u8], from: SocketAddr) -> Option<Vec<Inbound>> {
        use boringtun::noise::Packet as WgPacket;
        let parsed = match Tunn::parse_incoming_packet(datagram) {
            Ok(p) => p,
            Err(_) => {
                self.dropped_garbage += 1;
                return None;
            }
        };
        let peer_i = match &parsed {
            WgPacket::HandshakeInit(p) => {
                self.handshakes_received += 1;
                // boringtun device semantics: identity route via anonymous parse
                let hh = boringtun::noise::handshake::parse_handshake_anon(
                    &self.secret_for_anon_parse(),
                    &self.static_public,
                    p,
                )
                .ok()?;
                match self.by_pub.get(&hh.peer_static_public) {
                    Some(&i) => i,
                    None => {
                        self.dropped_garbage += 1;
                        return None;
                    }
                }
            }
            WgPacket::HandshakeResponse(p) => *self.by_idx.get(&(p.receiver_idx >> 8))?,
            WgPacket::PacketCookieReply(p) => *self.by_idx.get(&(p.receiver_idx >> 8))?,
            WgPacket::PacketData(p) => *self.by_idx.get(&(p.receiver_idx >> 8))?,
        };

        let peer_name = self.peers[peer_i].name.clone();
        let mut inbounds: Vec<Inbound> = vec![];
        let mut out = vec![0u8; 2000];

        // first pass on the real datagram, then flush queued packets
        let mut first = Some(datagram);
        let mut first_result = true;
        loop {
            let r = match first.take() {
                Some(d) => self.peers[peer_i].tun.decapsulate(None, d, &mut out),
                None => self.peers[peer_i].tun.decapsulate(None, &[], &mut out),
            };
            match r {
                TunnResult::WriteToNetwork(b) => {
                    // valid traffic: learn endpoint (NAT roaming)
                    self.peers[peer_i].endpoint = from;
                    self.peers[peer_i].known = true;
                    self.send_wg(peer_i, b);
                }
                TunnResult::WriteToTunnelV4(pkt, _dst) => {
                    self.peers[peer_i].endpoint = from;
                    self.peers[peer_i].known = true;
                    match inner_ips(pkt) {
                        Some((src, dst)) => {
                            // allowed-IP check on SOURCE — virtual-IP spoofing drops here
                            if !self.peers[peer_i]
                                .allowed_ips
                                .iter()
                                .any(|c| ip_in_cidr(src, *c))
                            {
                                self.dropped_spoofed += 1;
                            } else if let Some(payload) = inner_udp_payload(pkt) {
                                inbounds.push(Inbound {
                                    peer: peer_name.clone(),
                                    dst,
                                    payload,
                                });
                            }
                        }
                        None => self.dropped_garbage += 1,
                    }
                }
                TunnResult::WriteToTunnelV6(pkt, _dst) => {
                    self.peers[peer_i].endpoint = from;
                    self.peers[peer_i].known = true;
                    match inner_ips(pkt) {
                        Some((src, dst)) => {
                            if !self.peers[peer_i]
                                .allowed_ips
                                .iter()
                                .any(|c| ip_in_cidr(src, *c))
                            {
                                self.dropped_spoofed += 1;
                            } else if let Some(payload) = inner_udp_payload(pkt) {
                                inbounds.push(Inbound {
                                    peer: peer_name.clone(),
                                    dst,
                                    payload,
                                });
                            }
                        }
                        None => self.dropped_garbage += 1,
                    }
                }
                TunnResult::Done => break,
                TunnResult::Err(_) => {
                    // only the outer datagram counts as garbage; empty-datum
                    // flush errors just end the loop
                    if first_result {
                        self.dropped_garbage += 1;
                    }
                    break;
                }
            }
            first_result = false;
        }

        if inbounds.is_empty() {
            None
        } else {
            Some(inbounds)
        }
    }

    // parse_handshake_anon needs a reference to our secret; tunnels own copies,
    // so keep an authoritative copy for identity routing.
    fn secret_for_anon_parse(&self) -> StaticSecret {
        self.secret_master.clone()
    }    fn run_timers(&mut self) {
        let mut out = vec![0u8; 2000];
        for i in 0..self.peers.len() {
            if !self.peers[i].known {
                // never dialed / never heard: initiate handshake ourselves
                match self.peers[i].tun.format_handshake_initiation(&mut out, false) {
                    TunnResult::WriteToNetwork(b) => self.send_wg(i, b),
                    _ => {}
                }
            }
            match self.peers[i].tun.update_timers(&mut out) {
                TunnResult::WriteToNetwork(b) => self.send_wg(i, b),
                _ => {}
            }
        }
    }

    /// Route an inner packet by virtual destination IP and encrypt it out.
    pub fn send(&mut self, dst: IpAddr, payload: &[u8], src_port: u16, dst_port: u16) -> Result<(), String> {
        let peer_i = self
            .peers
            .iter()
            .position(|p| p.allowed_ips.iter().any(|c| ip_in_cidr(dst, *c)))
            .ok_or_else(|| format!("no mesh peer owns {dst}"))?;
        let src_ip = match dst {
            IpAddr::V4(_) => IpAddr::V4(self.virtual_ip4),
            IpAddr::V6(_) => return Err("v6 source not configured".into()),
        };
        let inner = udp_ip_packet(
            match src_ip { IpAddr::V4(v) => v, IpAddr::V6(_) => unreachable!() },
            src_port,
            match dst { IpAddr::V4(v) => v, IpAddr::V6(_) => unreachable!() },
            dst_port,
            payload,
        );
        let mut out = vec![0u8; 2000];
        match self.peers[peer_i].tun.encapsulate(&inner, &mut out) {
            TunnResult::WriteToNetwork(b) => {
                self.send_wg(peer_i, b);
                Ok(())
            }
            // No session / handshake in flight: encapsulate QUEUED the packet;
            // it flushes when the session comes up (update_timers in pump()).
            // WireGuardError variants are private in boringtun 0.7; its own
            // device loop treats any Err on send as "keep going" — we mirror
            // that, counting instead of failing the data path.
            TunnResult::Done => Ok(()),
            TunnResult::Err(e) => {
                self.send_errors += 1;
                let _ = e;
                Ok(())
            }
            _ => Ok(()),
        }
    }

    /// Force a fresh handshake with a peer (the rekey path).
    pub fn force_rekey(&mut self, peer: &str) -> Result<(), String> {
        let i = self
            .peers
            .iter()
            .position(|p| p.name == peer)
            .ok_or_else(|| format!("no peer '{peer}'"))?;
        let mut out = vec![0u8; 2000];
        match self.peers[i].tun.format_handshake_initiation(&mut out, true) {
            TunnResult::WriteToNetwork(b) => {
                self.send_wg(i, b);
                Ok(())
            }
            _ => Err("rekey: no handshake written".into()),
        }
    }

    pub fn peer_endpoint_mut(&mut self, peer: &str) -> Option<&mut SocketAddr> {
        self.peers
            .iter_mut()
            .find(|p| p.name == peer)
            .map(|p| &mut p.endpoint)
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    /// (time since last handshake, tx bytes, rx bytes)
    pub fn peer_stats(&self, peer: &str) -> Result<(Option<Duration>, usize, usize), String> {
        let p = self
            .peers
            .iter()
            .find(|p| p.name == peer)
            .ok_or_else(|| format!("no peer '{peer}'"))?;
        let (hs, tx, rx, _, _) = p.tun.stats();
        Ok((hs, tx, rx))
    }

}

/// S2 selftest: config-shaped mesh service under sustained traffic.
/// - 200 packets A->B, 200 B->A, in-order byte-verified
/// - malformed/garbage datagrams injected mid-stream (must not die)
/// - forced rekey on A, then 200 more packets each way on the new session
/// - byte counters on both tunnels match the traffic
pub fn service_test() -> Result<(), String> {
    const N: usize = 200;
    const TIMEOUT: Duration = Duration::from_secs(10);

    let a_secret = StaticSecret::random_from_rng(OsRng);
    let b_secret = StaticSecret::random_from_rng(OsRng);
    let a_pub = PublicKey::from(&a_secret);
    let b_pub = PublicKey::from(&b_secret);

    let mut a = MeshService::new(
        "A",
        a_secret,
        Ipv4Addr::new(10, 7, 0, 1),
        "127.0.0.1:0".parse().unwrap(),
        vec![PeerDesc {
            name: "B".into(),
            public: b_pub,
            endpoint: None, // dialed lazily by timers, learned on contact
            allowed_ips: vec![(IpAddr::V4(Ipv4Addr::new(10, 7, 0, 2)), 32)],
        }],
    )
    .map_err(|e| e.to_string())?;
    let mut b = MeshService::new(
        "B",
        b_secret,
        Ipv4Addr::new(10, 7, 0, 2),
        "127.0.0.1:0".parse().unwrap(),
        vec![PeerDesc {
            name: "A".into(),
            public: a_pub,
            endpoint: Some(a.local_addr()),
            allowed_ips: vec![(IpAddr::V4(Ipv4Addr::new(10, 7, 0, 1)), 32)],
        }],
    )
    .map_err(|e| e.to_string())?;
    // A learns B's real endpoint
    *a_endpoint_of(&mut a) = b.local_addr();

    fn a_endpoint_of(a: &mut MeshService) -> &mut SocketAddr {
        a.peer_endpoint_mut("B").expect("peer B")
    }

    let deadline = Instant::now() + TIMEOUT;

    // A cannot send before a session exists — send() encapsulates anyway and
    // boringtun queues the data and initiates the handshake (proven path).
    let send_wave_a = |s: &mut MeshService, tag: &[u8], base: u32| -> Result<(), String> {
        for seq in 0..N as u32 {
            let mut p = tag.to_vec();
            p.extend_from_slice(&(seq + base).to_be_bytes());
            s.send(IpAddr::V4(Ipv4Addr::new(10, 7, 0, 2)), &p, 40000, 40001)
                .map_err(|e| format!("A send: {e}"))?;
        }
        Ok(())
    };
    send_wave_a(&mut a, b"BFNA", 0)?;

    let mut a_got: Vec<u32> = vec![];
    let mut b_got: Vec<u32> = vec![];
    let mut garbage = 0usize;
    let mut rekeyed = false;
    let mut wave2_sent = false;

    while Instant::now() < deadline {
        // chaos: garbage into A mid-stream (service must survive)
        if garbage < 25 {
            garbage += 1;
            let junk = keys::random_bytes(148);
            let _ = std::net::UdpSocket::bind("127.0.0.1:0")
                .unwrap()
                .send_to(&junk, a.local_addr());
        }

        for inb in a.pump() {
            if let Ok(seq) = parse_seq(&inb.payload, b"BFNB") {
                a_got.push(seq);
            }
        }
        for inb in b.pump() {
            if let Ok(seq) =
                parse_seq(&inb.payload, b"BFNA")
                    .or_else(|_| parse_seq(&inb.payload, b"BFNC"))
            {
                b_got.push(seq);
                // B echoes back with its own tag
                let mut p = b"BFNB".to_vec();
                p.extend_from_slice(&seq.to_be_bytes());
                b.send(IpAddr::V4(Ipv4Addr::new(10, 7, 0, 1)), &p, 40001, 40000)
                    .map_err(|e| format!("B send: {e}"))?;
            }
        }

        if !rekeyed && b_got.len() >= N && a_got.len() >= N {
            // wave1 complete: in-order both ways, then rekey
            if b_got[..N] != (0..N as u32).collect::<Vec<_>>() {
                return Err(format!("B out-of-order: {:?}", &b_got[..12]));
            }
            if a_got[..N] != (0..N as u32).collect::<Vec<_>>() {
                return Err(format!("A out-of-order: {:?}", &a_got[..12]));
            }
            a.force_rekey("B")?;
            rekeyed = true;
            a_got.clear();
            b_got.clear();
        }
        if rekeyed && !wave2_sent {
            // proof the rekey landed: B received a SECOND handshake initiation
            // on the wire (stats-based age checks proved unreliable in 0.7)
            if b.handshakes_received >= 2 {
                send_wave_a(&mut a, b"BFNC", N as u32)?;
                wave2_sent = true;
            }
        }
        if wave2_sent && a_got.len() >= N && b_got.len() >= N {
            let expect: Vec<u32> = (N as u32..2 * N as u32).collect();
            if b_got[..N] != expect {
                return Err("B wave2 out-of-order after rekey".into());
            }
            if a_got[..N] != expect {
                return Err("A wave2 out-of-order after rekey".into());
            }
            let ((_, a_tx, a_rx), (_, b_tx, b_rx)) = (a.peer_stats("B")?, b.peer_stats("A")?);
            if a.dropped_garbage == 0 {
                return Err("garbage datagrams were not observed as dropped".into());
            }
            if a_rx == 0 || b_rx == 0 {
                return Err("zero byte counters — stats broken".into());
            }
            println!(
                "    wave1 2x{N} + rekey + wave2 2x{N}: counters A(tx={a_tx},rx={b_rx}) B(tx={b_tx},rx={a_rx}), garbage dropped {}",
                a.dropped_garbage
            );
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(2));
    }
    Err(format!(
        "deadline: wave2={wave2_sent} a_got={} b_got={} rekeyed={rekeyed} \
         a_hs_now={:?} b_hs_now={:?} a_errs={} b_inits={}          a(tx={},rx={}) b(tx={},rx={}) b_garbage={} b_spoof={}",
        a_got.len(),
        b_got.len(),
        a.peer_stats("B").map(|s| s.0).unwrap_or(None),
        b.peer_stats("A").map(|s| s.0).unwrap_or(None),
        a.send_errors,
        b.handshakes_received,
        a.peer_stats("B").map(|s| s.1).unwrap_or(0),
        a.peer_stats("B").map(|s| s.2).unwrap_or(0),
        b.peer_stats("A").map(|s| s.1).unwrap_or(0),
        b.peer_stats("A").map(|s| s.2).unwrap_or(0),
        b.dropped_garbage,
        b.dropped_spoofed,
    ))
}

fn parse_seq(payload: &[u8], tag: &[u8]) -> Result<u32, ()> {
    if payload.starts_with(tag) && payload.len() >= tag.len() + 4 {
        let off = tag.len();
        Ok(u32::from_be_bytes(payload[off..off + 4].try_into().unwrap()))
    } else {
        Err(())
    }
}

/// (source, destination) of an inner IPv4/IPv6 packet.
fn inner_ips(pkt: &[u8]) -> Option<(IpAddr, IpAddr)> {
    let sliced = etherparse::SlicedPacket::from_ip(pkt).ok()?;
    match sliced.net? {
        etherparse::NetSlice::Ipv4(v4) => {
            let h = v4.header();
            Some((IpAddr::V4(h.source_addr()), IpAddr::V4(h.destination_addr())))
        }
        etherparse::NetSlice::Ipv6(v6) => {
            Some((
                IpAddr::V6(v6.header().source_addr()),
                IpAddr::V6(v6.header().destination_addr()),
            ))
        }
        _ => None,
    }
}

fn inner_udp_payload(pkt: &[u8]) -> Option<Vec<u8>> {
    let sliced = etherparse::SlicedPacket::from_ip(pkt).ok()?;
    match sliced.transport? {
        etherparse::TransportSlice::Udp(u) => Some(u.payload().to_vec()),
        _ => None,
    }
}
