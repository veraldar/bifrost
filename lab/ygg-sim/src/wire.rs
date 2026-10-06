//! The shaped wire — network chaos as a library, no root, no netem.
//!
//! Topology (one wire per simulated client):
//!
//! ```text
//! client socket A_s ──► FA (wire front)  ──shape fwd──►  FB ──► server socket B_s
//! client socket A_s ◄── FA ◄──shape rev──  FB ◄── server socket B_s
//! ```
//!
//! The client's SDP/signaling advertises **A_s** as its local candidate and the
//! wire's **FA** as its only remote candidate; the server's candidates are
//! stripped from the SDP by the client (the wire owns reachability). Every
//! datagram in both directions crosses the wire — nothing bypasses.
//!
//! Shaping per direction (FlowProfile): base latency + jitter, loss %, dup %,
//! reorder (extra delay on a fraction), bandwidth cap (token bucket), and
//! blackout windows (link down). `Rebind` rotates the FB socket — the server
//! sees a fresh source port, the mapping it learned is dead: a NAT re-bind.
//!
//! Determinism: all decisions draw from a seeded xorshift stream; the decision
//! function is pure (checked by m0). The wire thread itself is wall-clock, so
//! live runs are statistically reproducible, and scenarios absorb residual
//! jitter in their pass bands.

use std::cmp::Reverse;
use std::collections::BinaryHeap;
use std::net::{SocketAddr, UdpSocket};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::rng::Rng;

const BURST_BYTES: f64 = 16_384.0;
const MAX_PKT: usize = 4000;
const HEAP_CAP: usize = 8192;

#[derive(Clone, Debug)]
pub struct FlowProfile {
    /// one-way base latency
    pub latency: Duration,
    /// uniform extra 0..=jitter
    pub jitter: Duration,
    /// drop probability [0,1)
    pub loss: f64,
    /// duplicate probability [0,1)
    pub dup: f64,
    /// fraction of packets given an extra delay (reorder)
    pub reorder_frac: f64,
    /// the extra reorder delay
    pub reorder_delay: Duration,
    /// bytes/sec cap; 0 = unlimited (congested cell links set this)
    pub bps: u64,
}

impl Default for FlowProfile {
    fn default() -> Self {
        FlowProfile {
            latency: Duration::from_millis(2),
            jitter: Duration::from_millis(1),
            loss: 0.0,
            dup: 0.0,
            reorder_frac: 0.0,
            reorder_delay: Duration::from_millis(0),
            bps: 0,
        }
    }
}

impl FlowProfile {
    /// one delay draw (consumes rng — order matters, this is the pure fn m0 checks)
    pub fn draw_delay(&self, rng: &mut Rng) -> Duration {
        let mut ms = self.latency.as_millis() as i64 + rng.range_i64(0, self.jitter.as_millis() as i64);
        if self.reorder_frac > 0.0 && rng.chance(self.reorder_frac) {
            ms += self.reorder_delay.as_millis() as i64;
        }
        Duration::from_millis(ms.max(0) as u64)
    }
}

#[derive(Clone, Debug)]
pub struct NetProfile {
    /// printed on the board per scenario
    #[allow(dead_code)]
    pub name: &'static str,
    /// client → server (phone uplink)
    pub fwd: FlowProfile,
    /// server → client (phone downlink)
    pub rev: FlowProfile,
}

impl NetProfile {
    pub fn new(name: &'static str, fwd: FlowProfile, rev: FlowProfile) -> NetProfile {
        NetProfile { name, fwd, rev }
    }
}

/// The device classes the fleet actually flies.
#[allow(dead_code)] // used from the scenario matrix (M1+)
pub fn profile_home() -> NetProfile {
    let f = FlowProfile {
        latency: Duration::from_millis(4),
        jitter: Duration::from_millis(2),
        ..Default::default()
    };
    NetProfile::new("home", f.clone(), f)
}

pub fn profile_phone() -> NetProfile {
    let f = FlowProfile {
        latency: Duration::from_millis(55),
        jitter: Duration::from_millis(25),
        loss: 0.02,
        dup: 0.005,
        ..Default::default()
    };
    let r = FlowProfile {
        latency: Duration::from_millis(55),
        jitter: Duration::from_millis(25),
        loss: 0.01,
        ..Default::default()
    };
    NetProfile::new("phone-cell", f, r)
}

#[allow(dead_code)] // used from the scenario matrix (M1+)
pub fn profile_poor() -> NetProfile {
    let f = FlowProfile {
        latency: Duration::from_millis(150),
        jitter: Duration::from_millis(90),
        loss: 0.15,
        dup: 0.01,
        reorder_frac: 0.2,
        reorder_delay: Duration::from_millis(180),
        ..Default::default()
    };
    let r = FlowProfile {
        latency: Duration::from_millis(120),
        jitter: Duration::from_millis(60),
        loss: 0.08,
        reorder_frac: 0.1,
        reorder_delay: Duration::from_millis(120),
        ..Default::default()
    };
    NetProfile::new("poor-cell", f, r)
}

/// Congested cell: capped downlink (64 kbps) + loss — the TTS burst queues
/// against the token bucket and the pipe drips.
#[allow(dead_code)] // used from bridge.bandwidth-starved (v2)
pub fn profile_congested() -> NetProfile {
    let f = FlowProfile {
        latency: Duration::from_millis(60),
        jitter: Duration::from_millis(25),
        loss: 0.03,
        ..Default::default()
    };
    let r = FlowProfile {
        latency: Duration::from_millis(80),
        jitter: Duration::from_millis(30),
        loss: 0.05,
        dup: 0.0,
        reorder_frac: 0.0,
        reorder_delay: Duration::from_millis(0),
        bps: 8000, // 64 kbps downlink
    };
    NetProfile::new("congested-cell", f, r)
}

/// Congested cell, UPCAPPED UPLINK: the client's paced 20ms mic stream against
/// a 64 kbps send pipe — the paced-reference half of the bandwidth law.
#[allow(dead_code)] // used from bridge.paced-uplink-starved (v4)
pub fn profile_congested_uplink() -> NetProfile {
    let f = FlowProfile {
        latency: Duration::from_millis(60),
        jitter: Duration::from_millis(25),
        loss: 0.03,
        dup: 0.0,
        reorder_frac: 0.0,
        reorder_delay: Duration::from_millis(0),
        bps: 8000, // 64 kbps uplink
    };
    let r = FlowProfile {
        latency: Duration::from_millis(55),
        jitter: Duration::from_millis(25),
        loss: 0.01,
        dup: 0.0,
        reorder_frac: 0.0,
        reorder_delay: Duration::from_millis(0),
        bps: 0,
    };
    NetProfile::new("congested-uplink", f, r)
}

/// m0's proof profile: lossy enough that nothing survives by luck.
pub fn profile_m0() -> NetProfile {
    let f = FlowProfile {
        latency: Duration::from_millis(8),
        jitter: Duration::from_millis(4),
        loss: 0.25,
        dup: 0.01,
        reorder_frac: 0.1,
        reorder_delay: Duration::from_millis(60),
        ..Default::default()
    };
    let r = f.clone();
    NetProfile::new("m0-lossy", f, r)
}

#[derive(Clone, Copy, Default, Debug)]
pub struct WireStats {
    pub fwd_sent: u64,
    pub fwd_dropped: u64,
    pub rev_sent: u64,
    pub rev_dropped: u64,
    pub duped: u64,
    pub blackholed: u64,
    pub rebinds: u64,
}

pub enum WireCmd {
    /// blackhole everything for d (tunnel, elevator, radio-off)
    Blackout(Duration),
    /// rotate the server-facing socket: the server's learned mapping dies
    #[allow(dead_code)] // used from the nat-rebind scenario (M2)
    Rebind,
    /// swap the live profile mid-flight (wifi → cell)
    #[allow(dead_code)] // used from the network-switch scenario (M2)
    SetProfile(NetProfile),
}

pub struct Wire {
    /// the client's only remote address (what goes into SDP / signaling)
    pub front: SocketAddr,
    cmd: Sender<WireCmd>,
    stats: Arc<Mutex<WireStats>>,
    stop: Arc<AtomicBool>,
    handle: Option<std::thread::JoinHandle<()>>,
}

impl Wire {
    pub fn start(
        client: SocketAddr,
        server: SocketAddr,
        profile: NetProfile,
        seed: u64,
    ) -> Result<Wire, String> {
        let fa = UdpSocket::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
        let fb = UdpSocket::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
        fa.set_nonblocking(true).map_err(|e| e.to_string())?;
        fb.set_nonblocking(true).map_err(|e| e.to_string())?;
        let front = fa.local_addr().map_err(|e| e.to_string())?;
        let (cmd_tx, cmd_rx) = std::sync::mpsc::channel();
        let stats = Arc::new(Mutex::new(WireStats::default()));
        let stop = Arc::new(AtomicBool::new(false));
        let stats_t = stats.clone();
        let stop_t = stop.clone();
        let handle = std::thread::Builder::new()
            .name("ygg-sim-wire".into())
            .spawn(move || {
                wire_loop(fa, fb, client, server, profile, seed, cmd_rx, stats_t, stop_t)
            })
            .map_err(|e| e.to_string())?;
        Ok(Wire {
            front,
            cmd: cmd_tx,
            stats,
            stop,
            handle: Some(handle),
        })
    }

    pub fn cmd(&self, c: WireCmd) {
        let _ = self.cmd.send(c);
    }

    pub fn stats(&self) -> WireStats {
        *self.stats.lock().unwrap()
    }
}

impl Drop for Wire {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(h) = self.handle.take() {
            let _ = h.join();
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn wire_loop(
    fa: UdpSocket,
    fb: UdpSocket,
    client: SocketAddr,
    server: SocketAddr,
    mut profile: NetProfile,
    seed: u64,
    cmd_rx: Receiver<WireCmd>,
    stats: Arc<Mutex<WireStats>>,
    stop: Arc<AtomicBool>,
) {
    let mut rng = Rng::new(seed);
    let mut heap: BinaryHeap<Reverse<(Instant, u64, bool, Vec<u8>)>> = BinaryHeap::new();
    let mut seq = 0u64;
    let mut out_sock = fb;
    let mut blackout_until: Option<Instant> = None;
    let mut tokens_fwd = BURST_BYTES;
    let mut tokens_rev = BURST_BYTES;
    let mut last = Instant::now();
    let mut buf = vec![0u8; MAX_PKT];

    while !stop.load(Ordering::SeqCst) {
        let now = Instant::now();
        let dt = now.duration_since(last);
        last = now;
        if profile.fwd.bps > 0 {
            tokens_fwd = (tokens_fwd + rate(&profile.fwd) * dt.as_secs_f64()).min(BURST_BYTES);
        }
        if profile.rev.bps > 0 {
            tokens_rev = (tokens_rev + rate(&profile.rev) * dt.as_secs_f64()).min(BURST_BYTES);
        }

        // deliver everything due
        while let Some(Reverse((at, _, _, _))) = heap.peek() {
            if *at > now {
                break;
            }
            let Reverse((_, _, rev, data)) = heap.pop().unwrap();
            let res = if rev {
                fa.send_to(&data, client)
            } else {
                out_sock.send_to(&data, server)
            };
            let mut s = stats.lock().unwrap();
            if res.is_ok() {
                if rev {
                    s.rev_sent += 1
                } else {
                    s.fwd_sent += 1
                }
            } else if rev {
                s.rev_dropped += 1
            } else {
                s.fwd_dropped += 1
            }
        }

        // FA carries client → server; the server also targets FA (it is the
        // candidate both sides advertise), so demux by source.
        loop {
            match fa.recv_from(&mut buf) {
                Ok((n, src)) => {
                    let rev = src == server;
                    schedule(
                        &mut heap,
                        &mut seq,
                        rev,
                        &buf[..n],
                        if rev { &profile.rev } else { &profile.fwd },
                        &mut rng,
                        blackout_until,
                        if rev { &mut tokens_rev } else { &mut tokens_fwd },
                        &stats,
                    );
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
                Err(_) => break,
            }
        }
        // FB carries server → client (from the server) — anything else is stray
        loop {
            let sock = &out_sock;
            match sock.recv_from(&mut buf) {
                Ok((n, _src)) => schedule(
                    &mut heap,
                    &mut seq,
                    true,
                    &buf[..n],
                    &profile.rev,
                    &mut rng,
                    blackout_until,
                    &mut tokens_rev,
                    &stats,
                ),
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
                Err(_) => break,
            }
        }

        while let Ok(c) = cmd_rx.try_recv() {
            match c {
                WireCmd::Blackout(d) => blackout_until = Some(Instant::now() + d),
                WireCmd::Rebind => {
                    if let Ok(s) = UdpSocket::bind("127.0.0.1:0") {
                        s.set_nonblocking(true).ok();
                        out_sock = s;
                        stats.lock().unwrap().rebinds += 1;
                    }
                }
                WireCmd::SetProfile(p) => profile = p,
            }
        }

        // shed load if a profile ever outruns us (honest congestion, not silent growth)
        while heap.len() > HEAP_CAP {
            heap.pop();
            stats.lock().unwrap().fwd_dropped += 1;
        }

        std::thread::sleep(Duration::from_millis(1));
    }
}

fn rate(f: &FlowProfile) -> f64 {
    f.bps as f64 / 8.0
}

#[allow(clippy::too_many_arguments)]
fn schedule(
    heap: &mut BinaryHeap<Reverse<(Instant, u64, bool, Vec<u8>)>>,
    seq: &mut u64,
    rev: bool,
    data: &[u8],
    prof: &FlowProfile,
    rng: &mut Rng,
    blackout: Option<Instant>,
    tokens: &mut f64,
    stats: &Arc<Mutex<WireStats>>,
) {
    let mut guard = stats.lock().unwrap();
    let s: &mut WireStats = &mut guard;
    let now = Instant::now();
    let count_drop = |s: &mut WireStats| {
        if rev {
            s.rev_dropped += 1
        } else {
            s.fwd_dropped += 1
        }
    };
    if let Some(u) = blackout {
        if now < u {
            s.blackholed += 1;
            count_drop(s);
            return;
        }
    }
    if rng.chance(prof.loss) {
        count_drop(s);
        return;
    }
    if prof.bps > 0 {
        if (data.len() as f64) > *tokens {
            count_drop(s);
            return;
        }
        *tokens -= data.len() as f64;
    }
    let at = now + prof.draw_delay(rng);
    heap.push(Reverse((at, *seq, rev, data.to_vec())));
    *seq += 1;
    if rng.chance(prof.dup) {
        heap.push(Reverse((at + Duration::from_millis(5), *seq, rev, data.to_vec())));
        s.duped += 1;
        *seq += 1;
    }
}

/// Removes candidate lines from an SDP body — the client's answer-side strip so
/// the wire owns all reachability (the server never learns the client's real
/// address, the client never learns the server's).
pub fn strip_candidates(sdp: &str) -> String {
    sdp.lines()
        .filter(|l| !l.starts_with("a=candidate:"))
        .collect::<Vec<_>>()
        .join("\r\n")
        + "\r\n"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decision_fn_deterministic() {
        let prof = FlowProfile {
            latency: Duration::from_millis(10),
            jitter: Duration::from_millis(5),
            loss: 0.3,
            dup: 0.02,
            reorder_frac: 0.15,
            reorder_delay: Duration::from_millis(40),
            bps: 0,
        };
        let bitmap = |seed: u64| {
            let mut rng = Rng::new(seed);
            (0..500)
                .map(|_| (rng.chance(prof.loss), prof.draw_delay(&mut rng).as_millis()))
                .collect::<Vec<_>>()
        };
        for seed in [7u64, 42, 0xC0FFEE] {
            assert_eq!(bitmap(seed), bitmap(seed), "seed {seed} not reproducible");
        }
        assert_ne!(bitmap(7), bitmap(42), "different seeds gave identical streams");
    }

    #[test]
    fn strip_removes_only_candidates() {
        let sdp = "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\na=candidate:1 1 udp 2130706431 127.0.0.1 5000 typ host\r\na=mid:0\r\n";
        let s = strip_candidates(sdp);
        assert!(!s.contains("candidate:"));
        assert!(s.contains("a=mid:0"));
        assert!(s.contains("v=0"));
    }
}
