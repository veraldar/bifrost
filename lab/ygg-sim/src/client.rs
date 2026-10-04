//! Simulated clients — what flies against the real bridge.
//!
//! A SimClient is a phone/desktop/ios-class WebRTC peer (str0m, in-binary):
//! it signals over HTTP (Bearer device token, trickle-shaped offer whose only
//! candidate is the wire front), opens the `app` data channel, offers a
//! sendrecv audio track, and streams/receives Opus frames. EVERY datagram it
//! sends or receives crosses the shaped wire — the client never learns the
//! bridge's real address.
//!
//! Device classes are labels + default wire profiles; the behavior (muted
//! track, fast reconnect, aggressive switching) lives in the scenarios.

use std::net::{SocketAddr, TcpStream, UdpSocket};
use std::io::{Read as _, Write as _};
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use serde_json::Value;
use str0m::change::SdpAnswer;
use str0m::media::{MediaKind, Mid, Pt};
use str0m::net::{Protocol, Receive};
use str0m::{Candidate, Event, Input, Output, Rtc};

use crate::wire::{strip_candidates, Wire, WireCmd};

pub struct SimClient {
    rtc: Rtc,
    sock: UdpSocket,
    dest: SocketAddr,
    wire: Wire,
    pub cid: str0m::channel::ChannelId,
    inbox: Vec<String>,
    /// the client's own offered audio track (its write end)
    pub audio_mid: Mid,
    /// every audio frame received on the track (quality checks decode these)
    pub audio_rx: Vec<Vec<u8>>,
    pub frames_rx: u64,
    buf: Vec<u8>,
}

/// Raw signaling POST (status line, body) — the negative-auth scenarios need
/// the status code, so this bypasses ureq's error mapping on purpose.
pub fn post_offer_raw(
    sig: SocketAddr,
    path: &str,
    token: Option<&str>,
    body: &str,
) -> Result<(String, String), String> {
    let mut s = TcpStream::connect(sig).map_err(|e| format!("connect signaling: {e}"))?;
    s.set_read_timeout(Some(Duration::from_secs(5))).ok();
    let auth = token
        .map(|t| format!("Authorization: Bearer {t}\r\n"))
        .unwrap_or_default();
    let req = format!(
        "POST {path} HTTP/1.1\r\nHost: bridge\r\n{auth}Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    s.write_all(req.as_bytes()).map_err(|e| e.to_string())?;
    let mut raw = String::new();
    s.read_to_string(&mut raw).map_err(|e| e.to_string())?;
    let status = raw.split_whitespace().nth(1).unwrap_or("??").to_string();
    let body = raw
        .split("\r\n\r\n")
        .nth(1)
        .unwrap_or_default()
        .to_string();
    Ok((status, body))
}

impl SimClient {
    /// Signal + connect through the wire. `media` is the bridge's REAL media
    /// address — only the wire ever uses it.
    pub fn connect(
        sig: SocketAddr,
        media: SocketAddr,
        token: &str,
        profile: crate::wire::NetProfile,
        seed: u64,
    ) -> Result<SimClient, String> {
        let sock = UdpSocket::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
        let local = sock.local_addr().map_err(|e| e.to_string())?;
        sock.set_nonblocking(true).map_err(|e| e.to_string())?;
        let wire = Wire::start(local, media, profile.clone(), seed)?;

        // device-class jitter buffer: a phone on a bad link buffers deeper
        // (str0m frame-mode reordering hold; default 15 packets / 1s timeout)
        let jitter_packets = if profile.rev.loss > 0.05 || profile.rev.reorder_frac > 0.05 {
            60
        } else {
            15
        };
        let mut rtc = Rtc::builder()
            .set_reordering_size_audio(jitter_packets)
            .build(Instant::now());
        rtc.add_local_candidate(Candidate::host(local, "udp").map_err(|e| e.to_string())?);

        let mut change = rtc.sdp_api();
        let cid = change.add_channel("app".into());
        let audio_mid = change.add_media(MediaKind::Audio, str0m::media::Direction::SendRecv, None, None, None);
        let (offer, pending) = change.apply().ok_or("offer apply returned None")?;
        let front_sdp = Candidate::host(wire.front, "udp")
            .map_err(|e| e.to_string())?
            .to_sdp_string();
        let body = serde_json::json!({
            "sdp": offer.to_sdp_string(),
            "candidates": [front_sdp],
        })
        .to_string();
        let (status, resp) = post_offer_raw(sig, "/offer", Some(token), &body)?;
        if !status.starts_with('2') {
            return Err(format!("signaling rejected our offer: {status} {resp}"));
        }
        let answer_v: Value = serde_json::from_str(&resp).map_err(|e| format!("bad answer json: {e}"))?;
        let answer = SdpAnswer::from_sdp_string(&strip_candidates(
            &serde_json::from_str::<SdpAnswer>(&resp)
                .map_err(|e| format!("answer not SdpAnswer: {e}"))?
                .to_sdp_string(),
        ))
        .map_err(|e| format!("reparse stripped answer: {e}"))?;
        let _ = answer_v;
        rtc.sdp_api()
            .accept_answer(pending, answer)
            .map_err(|e| format!("accept_answer: {e}"))?;
        rtc.add_remote_candidate(Candidate::host(wire.front, "udp").map_err(|e| e.to_string())?);

        Ok(SimClient {
            rtc,
            sock,
            dest: local,
            wire,
            cid,
            inbox: vec![],
            audio_mid,
            audio_rx: vec![],
            frames_rx: 0,
            buf: vec![0u8; 4000],
        })
    }

    pub fn wire_cmd(&self, c: WireCmd) {
        self.wire.cmd(c);
    }

    pub fn wire_stats(&self) -> crate::wire::WireStats {
        self.wire.stats()
    }

    /// Drain the socket, advance the RTC, collect events.
    pub fn pump(&mut self) {
        crate::STEP.store(4, Ordering::Relaxed);
        let now = Instant::now();
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
                    // to the wire front — never to the bridge directly
                    let _ = self.sock.send_to(&t.contents, self.wire.front);
                }
                Ok(Output::Event(e)) => match e {
                    Event::ChannelData(cd) => {
                        if let Ok(s) = std::str::from_utf8(&cd.data) {
                            self.inbox.push(s.to_string());
                        }
                    }
                    Event::MediaData(d) => {
                        self.audio_rx.push(d.data.to_vec());
                        self.frames_rx += 1;
                    }
                    _ => {}
                },
                Err(_) => break,
            }
        }
    }

    pub fn is_connected(&self) -> bool {
        self.rtc.is_connected()
    }

    /// The Opus payload type negotiated for our audio track — what a mic would
    /// encode with.
    pub fn opus_pt(&self) -> Option<Pt> {
        let cfg = self.rtc.codec_config();
        cfg.find(|p| p.spec().codec == str0m::format::Codec::Opus)
            .map(|p| p.pt())
    }

    /// Write one mic frame on the audio track; Ok(false) = not yet writable.
    pub fn write_audio(&mut self, pt: Pt, frame: Vec<u8>, elapsed: Duration) -> Result<bool, String> {
        let Some(w) = self.rtc.writer(self.audio_mid) else {
            return Ok(false);
        };
        let rtp = str0m::media::MediaTime::from(elapsed);
        w.write(pt, Instant::now(), rtp, frame)
            .map(|_| true)
            .map_err(|e| format!("audio write: {e}"))
    }

    /// Audio frames received so far (quality checks decode these).
    pub fn audio(&self) -> &[Vec<u8>] {
        &self.audio_rx
    }

    /// Send a channel message (ordered/reliable), retrying while SCTP buffers.
    pub fn send(&mut self, json: &str) -> Result<(), String> {
        let dbg = std::env::var_os("YGG_SIM_DEBUG").is_some();
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut beat = Instant::now();
        crate::STEP.store(1, Ordering::Relaxed);
        loop {
            crate::STEP.store(2, Ordering::Relaxed);
            if Instant::now() > deadline {
                return Err("channel never accepted the write (not connected?)".into());
            }
            if dbg && beat.elapsed() > Duration::from_millis(500) {
                beat = Instant::now();
                let ws = self.wire_stats();
                eprintln!(
                    "[send] waiting: chan? {} conn {} frames {} | wire fwd+{} -{} rev+{} -{} bh {}",
                    self.rtc.channel(self.cid).is_some(),
                    self.is_connected(),
                    self.frames_rx,
                    ws.fwd_sent,
                    ws.fwd_dropped,
                    ws.rev_sent,
                    ws.rev_dropped,
                    ws.blackholed
                );
            }
            match self.rtc.channel(self.cid) {
                Some(mut ch) => match ch.write(false, json.as_bytes()) {
                    Ok(true) => return Ok(()),
                    Ok(false) => {
                        self.pump();
                        std::thread::sleep(Duration::from_millis(20));
                    }
                    Err(e) => return Err(format!("channel write: {e}")),
                },
                None => {
                    self.pump();
                    std::thread::sleep(Duration::from_millis(20));
                }
            }
        }
    }

    /// Request/response over the `app` channel: send, then wait for `"req"`.
    pub fn roundtrip(&mut self, req: u64, json: &str, timeout: Duration) -> Result<String, String> {
        let dbg = std::env::var_os("YGG_SIM_DEBUG").is_some();
        let t0 = Instant::now();
        crate::STEP.store(1, Ordering::Relaxed);
        self.send(json)?;
        crate::STEP.store(3, Ordering::Relaxed);
        let deadline = Instant::now() + timeout;
        let mut last_beat = Instant::now();
        while Instant::now() < deadline {
            self.pump();
            if let Some(i) = self.inbox_index_for_req(req) {
                return Ok(self.inbox.remove(i));
            }
            if dbg && last_beat.elapsed() > Duration::from_millis(1000) {
                last_beat = Instant::now();
                eprintln!(
                    "[rt] req {req} t {:.1}s conn {} chan {} inbox {} frames {}",
                    t0.elapsed().as_secs_f32(),
                    self.is_connected(),
                    self.rtc.channel(self.cid).is_some(),
                    self.inbox.len(),
                    self.frames_rx
                );
            }
            std::thread::sleep(Duration::from_millis(15));
        }
        Err(format!("no reply to req {req} within {timeout:?}"))
    }

    /// Wait for a notice `{"op": ...}` (voice.stt, run.done, voice.reply...).
    pub fn wait_notice(&mut self, op: &str, timeout: Duration) -> Result<String, String> {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            self.pump();
            if let Some(hit) = self
                .inbox
                .iter()
                .position(|m| {
                    serde_json::from_str::<Value>(m)
                        .ok()
                        .and_then(|v| v.get("op").and_then(|o| o.as_str()).map(String::from))
                        .as_deref()
                        == Some(op)
                })
            {
                return Ok(self.inbox.remove(hit));
            }
            std::thread::sleep(Duration::from_millis(15));
        }
        Err(format!("notice '{op}' never arrived within {timeout:?}"))
    }

    /// Ping RTT over the channel.
    pub fn ping_rtt(&mut self, req: u64) -> Result<Duration, String> {
        let t0 = Instant::now();
        self.roundtrip(
            req,
            &serde_json::json!({"op": "ping", "req": req, "t": 0}).to_string(),
            Duration::from_secs(8),
        )?;
        Ok(t0.elapsed())
    }

    fn inbox_index_for_req(&self, req: u64) -> Option<usize> {
        self.inbox.iter().position(|m| {
            serde_json::from_str::<Value>(m)
                .ok()
                .and_then(|v| v.get("req").and_then(|r| r.as_u64()))
                == Some(req)
        })
    }
}
