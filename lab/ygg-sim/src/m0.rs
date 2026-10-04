//! M0 — prove the critical seams small, before any scenario exists:
//!
//!   M0.1  shaper determinism — the wire's decision function is a pure,
//!         seeded function (same seed → identical drop/delay schedule).
//!   M0.2  shaped WebRTC echo — two str0m peers, full ICE+DTLS+SRTP, with
//!         EVERY datagram crossing the shaped wire under 25% loss + jitter +
//!         reorder + a 600ms blackout mid-stream; frames byte-verified.
//!   M0.3  real-stack REST roundtrip — spawn the REAL yggdrasil binary on an
//!         ephemeral port against the deterministic mock upstream and fly one
//!         full turn (create session → prompt → assistant reply) through the
//!         shaped HTTP path on the phone profile.

use std::net::{SocketAddr, UdpSocket};
use std::time::{Duration, Instant};

use serde_json::Value;
use str0m::change::{SdpAnswer, SdpOffer};
use str0m::format::Codec;
use str0m::media::{Direction, MediaData, MediaKind, MediaTime, Pt};
use str0m::net::{Protocol, Receive};
use str0m::{Candidate, Event, Input, Output, Rtc};

use crate::httpc::ShapedHttp;
use crate::rng::Rng;
use crate::wire::{profile_m0, profile_phone, strip_candidates, Wire};
use crate::world::{World, WorldOpts};

const ECHO_DEADLINE: Duration = Duration::from_secs(25);
const FRAMES_TO_SEND: usize = 150;
/// floor: ~20% of sent — generous, the pipe also carries ICE/RTCP traffic and
/// the blackout eats a window; the assertion is "survives and stays byte-exact",
/// not a throughput measurement.
const VERIFY_TARGET: usize = 25;

pub fn run() -> i32 {
    println!("ygg-sim M0 — shaper + real-stack seams");
    let mut failed = false;

    print!("M0.1 shaper determinism      : ");
    match check_determinism() {
        Ok(line) => println!("PASS — {line}"),
        Err(e) => {
            failed = true;
            println!("FAIL — {e}");
        }
    }

    print!("M0.2 shaped WebRTC echo      : ");
    match check_echo() {
        Ok(line) => println!("PASS — {line}"),
        Err(e) => {
            failed = true;
            println!("FAIL — {e}");
        }
    }

    print!("M0.3 real yggdrasil turn     : ");
    match check_real_stack() {
        Ok(line) => println!("PASS — {line}"),
        Err(e) => {
            failed = true;
            println!("FAIL — {e}");
        }
    }

    if failed {
        println!("M0 VERDICT: RED");
        1
    } else {
        println!("M0 VERDICT: GREEN — 3/3");
        0
    }
}

// ---- M0.1 -------------------------------------------------------------------

fn drop_bitmap(seed: u64, n: usize) -> Vec<(bool, u64)> {
    let prof = profile_m0().fwd;
    let mut rng = Rng::new(seed);
    (0..n)
        .map(|_| (rng.chance(prof.loss), prof.draw_delay(&mut rng).as_millis() as u64))
        .collect()
}

fn check_determinism() -> Result<String, String> {
    for seed in [7u64, 42, 0xC0FFEE, 1] {
        let a = drop_bitmap(seed, 500);
        let b = drop_bitmap(seed, 500);
        if a != b {
            return Err(format!("seed {seed:#x}: decision stream not reproducible"));
        }
    }
    if drop_bitmap(7, 500) == drop_bitmap(42, 500) {
        return Err("different seeds produced identical streams".into());
    }
    let lossy = drop_bitmap(0xC0FFEE, 1000);
    let dropped = lossy.iter().filter(|(d, _)| *d).count();
    let expect = (1000.0 * profile_m0().fwd.loss) as usize;
    let spread = (dropped as i64 - expect as i64).abs();
    if spread > 100 {
        return Err(format!(
            "loss rate off: {dropped}/1000 dropped, expected ~{expect} (±100)"
        ));
    }
    Ok(format!(
        "seeds reproducible; m0 profile dropped {dropped}/1000 (expect ~{expect})"
    ))
}

// ---- M0.2 -------------------------------------------------------------------

fn marker_frame(seq: u32) -> Vec<u8> {
    let mut f = b"YSIM".to_vec();
    f.extend_from_slice(&seq.to_be_bytes());
    f.extend(std::iter::repeat_n(0x5Au8, 80 - f.len()));
    f
}

struct EchoPeer {
    rtc: Rtc,
    sock: UdpSocket,
    /// what Input::Receive.destination claims (the peer's own candidate addr)
    dest: SocketAddr,
    buf: Vec<u8>,
}

impl EchoPeer {
    fn new(sock: UdpSocket, dest: SocketAddr) -> EchoPeer {
        sock.set_nonblocking(true).expect("nonblocking");
        let mut rtc = Rtc::new(Instant::now());
        let cand = Candidate::host(dest, "udp").expect("host candidate");
        rtc.add_local_candidate(cand).expect("add candidate");
        EchoPeer {
            rtc,
            sock,
            dest,
            buf: vec![0u8; 2000],
        }
    }

    /// Drain socket → RTC, advance timers, emit outputs; returns events.
    fn pump(&mut self) -> Vec<Event> {
        let now = Instant::now();
        let mut events = vec![];
        loop {
            match self.sock.recv_from(&mut self.buf) {
                Ok((n, source)) => {
                    let input = Input::Receive(
                        now,
                        Receive {
                            proto: Protocol::Udp,
                            source,
                            destination: self.dest,
                            contents: (&self.buf[..n]).try_into().expect("contents"),
                        },
                    );
                    if self.rtc.accepts(&input) {
                        let _ = self.rtc.handle_input(input);
                    }
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
                Err(_) => break,
            }
        }
        let _ = self.rtc.handle_input(Input::Timeout(now));
        loop {
            match self.rtc.poll_output() {
                Ok(Output::Timeout(_)) => break,
                Ok(Output::Transmit(t)) => {
                    let _ = self.sock.send_to(&t.contents, t.destination);
                }
                Ok(Output::Event(e)) => events.push(e),
                Err(_) => break,
            }
        }
        events
    }
}

fn check_echo() -> Result<String, String> {
    str0m::crypto::from_feature_flags().install_process_default();

    let sock_l = UdpSocket::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let sock_r = UdpSocket::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let addr_l = sock_l.local_addr().map_err(|e| e.to_string())?;
    let addr_r = sock_r.local_addr().map_err(|e| e.to_string())?;

    let profile = profile_m0();
    let wire = Wire::start(addr_l, addr_r, profile, 0xA11CE).map_err(|e| e.to_string())?;

    // L (client side): local candidate = its real addr, receive destination =
    // real addr; its ONLY remote candidate is the wire front. R (server side):
    // honest local candidate; remote = wire front (what the bridge would learn).
    let mut l = EchoPeer::new(sock_l, addr_l);
    let mut r = EchoPeer::new(sock_r, addr_r);

    let front = wire.front;
    let front_cand = || Candidate::host(front, "udp").map_err(|e| e.to_string());

    // L offers an audio track; candidate lines are stripped on BOTH SDPs so
    // the wire owns all reachability, then both sides aim at the wire front.
    let mut change = l.rtc.sdp_api();
    let mid = change.add_media(MediaKind::Audio, Direction::SendRecv, None, None, None);
    let (offer, pending) = change.apply().ok_or("offer apply returned None")?;
    let offer = SdpOffer::from_sdp_string(&strip_candidates(&offer.to_sdp_string()))
        .map_err(|e| format!("reparse stripped offer: {e}"))?;
    let answer = r
        .rtc
        .sdp_api()
        .accept_offer(offer)
        .map_err(|e| format!("accept_offer: {e}"))?;
    let answer = SdpAnswer::from_sdp_string(&strip_candidates(&answer.to_sdp_string()))
        .map_err(|e| format!("reparse stripped answer: {e}"))?;
    l.rtc
        .sdp_api()
        .accept_answer(pending, answer)
        .map_err(|e| format!("accept_answer: {e}"))?;
    l.rtc.add_remote_candidate(front_cand()?);
    r.rtc.add_remote_candidate(front_cand()?);

    let pt: Pt = {
        let cfg = l.rtc.codec_config().clone();
        cfg.find(|p| p.spec().codec == Codec::Opus)
            .ok_or("opus not negotiated")?
            .pt()
    };

    let start = Instant::now();
    let deadline = start + ECHO_DEADLINE;
    let mut sent = 0usize;
    let mut verified = 0usize;
    let mut corrupted = 0usize;
    let mut blackholed_at = 0u64;
    let mut roundtrip_ms: Vec<u64> = vec![];
    let mut sent_at: std::collections::HashMap<u32, Instant> = Default::default();
    let mut next_send = start + Duration::from_millis(40);

    while Instant::now() < deadline {
        let l_events = l.pump();
        let r_events = r.pump();

        if l.rtc.is_connected() && r.rtc.is_connected() && sent < FRAMES_TO_SEND && Instant::now() >= next_send
        {
            let frame = marker_frame(sent as u32);
            if let Some(w) = l.rtc.writer(mid) {
                let rtp = MediaTime::from(Instant::now().duration_since(start));
                if w.write(pt, Instant::now(), rtp, frame).is_ok() {
                    sent_at.insert(sent as u32, Instant::now());
                    sent += 1;
                    next_send += Duration::from_millis(20);
                    // mid-stream tunnel: blackhole everything for 500ms
                    if sent == 40 && blackholed_at == 0 {
                        wire.cmd(crate::wire::WireCmd::Blackout(Duration::from_millis(500)));
                        blackholed_at = sent as u64;
                    }
                }
            }
        }

        for e in &r_events {
            if let Event::MediaData(d) = e {
                echo_back(&mut r, d, pt)?;
            }
        }
        for e in &l_events {
            if let Event::MediaData(d) = e {
                let payload = &d.data[..];
                if payload.starts_with(b"YSIM") {
                    let seq = u32::from_be_bytes(payload[4..8].try_into().unwrap());
                    if payload == &marker_frame(seq)[..] {
                        verified += 1;
                        if let Some(t0) = sent_at.get(&seq) {
                            roundtrip_ms.push((Instant::now() - *t0).as_millis() as u64);
                        }
                    } else {
                        corrupted += 1;
                    }
                }
            }
        }

        if std::env::var_os("YGG_SIM_DEBUG").is_some() && (sent % 10 == 0 || verified % 10 == 0) {
            eprintln!(
                "[dbg] sent {sent} verified {verified} lconn {} rconn {} stats {:?}",
                l.rtc.is_connected(),
                r.rtc.is_connected(),
                wire.stats()
            );
        }

        if verified >= VERIFY_TARGET && sent >= FRAMES_TO_SEND {
            break;
        }
        std::thread::sleep(Duration::from_millis(2));
    }

    let stats = wire.stats();
    if std::env::var_os("YGG_SIM_DEBUG").is_some() {
        eprintln!("[dbg] final sent {sent} verified {verified} corrupted {corrupted} stats {stats:?}");
    }
    drop(wire);
    drop(l);
    drop(r);

    if corrupted > 0 {
        return Err(format!("{corrupted} frames corrupted across the wire"));
    }
    if verified < VERIFY_TARGET {
        return Err(format!(
            "only {verified}/{VERIFY_TARGET} frames survived (sent {sent})"
        ));
    }
    if stats.fwd_dropped == 0 || stats.blackholed == 0 {
        return Err(format!(
            "wire did not actually shape: fwd_dropped {}, blackholed {}",
            stats.fwd_dropped, stats.blackholed
        ));
    }
    let avg = roundtrip_ms.iter().sum::<u64>() / roundtrip_ms.len().max(1) as u64;
    Ok(format!(
        "{verified} frames byte-exact (avg {avg}ms); wire dropped {} fwd pkts, blackholed {} during the tunnel, duped {}",
        stats.fwd_dropped, stats.blackholed, stats.duped
    ))
}

fn echo_back(r: &mut EchoPeer, d: &MediaData, pt: Pt) -> Result<(), String> {
    if let Some(w) = r.rtc.writer(d.mid) {
        w.write(pt, d.network_time, d.time, d.data.clone())
            .map_err(|e| format!("echo write: {e}"))?;
    }
    Ok(())
}

// ---- M0.3 -------------------------------------------------------------------

fn check_real_stack() -> Result<String, String> {
    let world = World::spawn(WorldOpts::default()).map_err(|e| format!("world: {e}"))?;
    let mut http = ShapedHttp::new(0xB0BA, &profile_phone().fwd);

    let t0 = Instant::now();
    let created = http
        .post_json(
            &format!("{}/session", world.ygg_url()),
            r#"{ "title": "ygg-sim m0" }"#,
        )
        .map_err(|e| format!("create session: {e}"))?;
    let sid = serde_json::from_str::<Value>(&created)
        .map_err(|e| e.to_string())?
        .get("id")
        .and_then(|i| i.as_str())
        .ok_or_else(|| format!("no id in {created}"))?
        .to_string();

    let reply = http
        .post_json(
            &format!("{}/session/{sid}/message", world.ygg_url()),
            r#"{ "parts": [{ "type": "text", "text": "hello from ygg-sim" }] }"#,
        )
        .map_err(|e| format!("prompt: {e}"))?;
    let turn_ms = t0.elapsed().as_millis() as u64;

    if !reply.contains("MOCK-REPLY: you said 'hello from ygg-sim'") {
        return Err(format!("assistant reply missing the deterministic echo: {reply}"));
    }

    let tr = http
        .get(&format!("{}/session/{sid}/message", world.ygg_url()))
        .map_err(|e| format!("transcript: {e}"))?;
    let tr_v: Value = serde_json::from_str(&tr).map_err(|e| e.to_string())?;
    let roles: Vec<&str> = tr_v
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|m| m["info"]["role"].as_str())
                .collect()
        })
        .unwrap_or_default();
    if !roles.contains(&"assistant") || !roles.contains(&"user") {
        return Err(format!("transcript roles wrong: {roles:?}"));
    }

    Ok(format!(
        "real yggdrasil @ {} — session {sid} round-tripped, phone-profile turn {turn_ms}ms, transcript user+assistant",
        world.ygg
    ))
}
