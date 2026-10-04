//! S4: serve mode — THE binary. One process = private mesh (boringtun,
//! session-keeping with timers/handshakes) + WebRTC relay (str0m) + signaling,
//! all from one explicit config file. This is the sovereign access point shape:
//! drop on a VPS in the country you choose, point peers at it.

use std::net::IpAddr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::config;
use crate::keys;
use crate::mesh::{self, MeshService, PeerDesc};
use crate::relay::{self, RelayConfig};

pub fn run(path: &str) -> Result<(), String> {
    let loaded = config::load(path)?;
    println!(
        "bifrost-net '{}' starting (config: {})",
        loaded.config.node.name, loaded.path
    );
    let lines = loaded.config.check()?;
    for line in &lines {
        println!("  {line}");
    }

    let cfg = loaded.config.clone();

    // ---- WebRTC half ----
    let mut relay_handle: Option<relay::RelayHandle> = None;
    if let Some(w) = &cfg.webrtc {
        let candidates: Vec<IpAddr> = w
            .candidates
            .iter()
            .filter_map(|c| c.parse().ok())
            .collect();
        let handle = relay::start(RelayConfig {
            signaling: w.signaling.parse().map_err(|e| format!("webrtc.signaling: {e}"))?,
            media: w.media.parse().map_err(|e| format!("webrtc.media: {e}"))?,
            candidates,
        })?;
        println!(
            "  webrtc: signaling http://{} (POST /offer) + media udp {} — LIVE",
            handle.signaling, handle.media
        );
        relay_handle = Some(handle);
    }

    // ---- mesh half ----
    let stop = Arc::new(AtomicBool::new(false));
    if let Some(m) = &cfg.mesh {
        let (my_ip, _len) = mesh::parse_cidr(&m.address).map_err(|e| format!("mesh.address: {e}"))?;
        let my_ip4 = match my_ip {
            IpAddr::V4(v) => v,
            IpAddr::V6(_) => return Err("mesh.address: v6 not supported yet".into()),
        };
        let mut peers: Vec<PeerDesc> = vec![];
        for p in &m.peers {
            let public = keys::decode_public(&p.public_key)
                .map_err(|e| format!("mesh.peers[{}]: {e}", p.name))?;
            let endpoint = match &p.endpoint {
                Some(ep) => Some(ep.parse().map_err(|e| format!("mesh.peers[{}] endpoint: {e}", p.name))?),
                None => None,
            };
            let allowed = p
                .allowed_ips
                .iter()
                .map(|c| mesh::parse_cidr(c))
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| format!("mesh.peers[{}]: {e}", p.name))?;
            peers.push(PeerDesc {
                name: p.name.clone(),
                public,
                endpoint,
                allowed_ips: allowed,
            });
        }
        let mut svc = MeshService::new(
            &cfg.node.name,
            loaded.secret.clone(),
            my_ip4,
            m.listen.parse().map_err(|e| format!("mesh.listen: {e}"))?,
            peers,
        )?;
        println!("  mesh: udp {} — LIVE ({} peer(s))", svc.local_addr(), m.peers.len());

        let stop_mesh = stop.clone();
        std::thread::spawn(move || {
            let mut last_report = Instant::now();
            loop {
                if stop_mesh.load(Ordering::SeqCst) {
                    return;
                }
                for inb in svc.pump() {
                    // M1 serve: sessions stay up; inner traffic is counted and
                    // dropped (TUN/bridge routing is the M2 slice).
                    let _ = (inb.peer, inb.dst, inb.payload.len());
                }
                if last_report.elapsed() > Duration::from_secs(30) {
                    last_report = Instant::now();
                    let peers = svc
                        .peer_names()
                        .into_iter()
                        .map(|n| {
                            let up = svc.peer_stats(&n).map(|s| s.0.is_some()).unwrap_or(false);
                            format!("{n}={}", if up { "UP" } else { "down" })
                        })
                        .collect::<Vec<_>>()
                        .join(" ");
                    println!(
                        "  mesh[{}]: alive (inits received: {}, drops: {} garbage / {} spoofed) peers: {}",
                        svc.name(), svc.handshakes_received, svc.dropped_garbage, svc.dropped_spoofed, peers
                    );
                }
                std::thread::sleep(Duration::from_millis(5));
            }
        });
    }

    if relay_handle.is_none() && cfg.mesh.is_none() {
        return Err("nothing to serve: enable [mesh] and/or [webrtc]".into());
    }

    println!("bifrost-net serving — Ctrl-C to stop");
    // park the main thread; relay/mesh threads do the work.
    // (systemd owns the lifecycle in deployment; default signal handling exits.)
    loop {
        std::thread::sleep(Duration::from_secs(3600));
    }
}
