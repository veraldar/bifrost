//! M0 mesh test: two nodes connect PRIVATELY via the WireGuard protocol
//! (boringtun, Cloudflare's implementation), over real UDP on loopback.
//!
//! Node A (10.7.0.1) and node B (10.7.0.2) each own a real UDP socket.
//! All WireGuard packets (Noise_IKpsk2 handshake, encrypted data transport)
//! physically transit 127.0.0.1 UDP. The inner packets are ordinary IPv4+UDP.
//!
//! Proven:
//! 1. Full WG handshake between the two nodes.
//! 2. A -> B encrypted "ping", B -> A encrypted "pong", payloads byte-verified.
//! 3. Negative: a node with the wrong static key CANNOT complete a handshake.

use std::net::{Ipv4Addr, SocketAddr, UdpSocket};
use std::time::{Duration, Instant};

use boringtun::noise::{Tunn, TunnResult};
use boringtun::x25519::{PublicKey, StaticSecret};
use rand_core::{OsRng, RngCore};

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

pub fn run() -> Result<(), String> {
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
