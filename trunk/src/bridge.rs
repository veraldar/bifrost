//! v0.9 bridge — the phone's DIRECT path to the tree (no tailscale).
//!
//! Token-gated WebRTC signaling + peers. Over the `app` data channel: JSON
//! request/response mirroring the PWA proxy's session surface. Over the audio
//! track: mic → Opus → (voice.commit) → speaches STT → opencode prompt →
//! reply → speaches TTS → Opus back to the phone.
//!
//! Auth (S1 seam): a live device credential is required on /offer and
//! /branch (tokens.rs — the app mints, the bridge verifies): a v2 access token
//! (short-lived, bound to the region of the REAL socket address) or a v1
//! device token (`tokenHash`, no expiry, no region). The DTLS session
//! established through that exchange IS the authenticated session, and it
//! stays accountable: every live peer is re-checked every 500ms and SEVERED
//! (a `severed` notice with the reason, then disconnect) when its device is
//! revoked, the kill epoch moves (kill-switch), or its access token lapses
//! without an `auth.refresh` over the channel.
//!
//! Identity (trust-on-first-scan): ONE persisted DTLS certificate for every
//! peer, so its sha-256 fingerprint is stable — GET /identity publishes it for
//! the pairing QR, the phone pins it, and the browser refuses any answer (and
//! any DTLS handshake) that does not carry it. Signaling is the trunk's own
//! HTTP: no signaling server exists. CORS is open (no cookies are ever read),
//! so the phone's app can dial the bridge directly.
//!
//! Root-link (v4): roots dial IN on their own ws listener (bridge port + 1 by
//! default, rootlink.rs); a turn naming a root rides that root's link, gated
//! by the device's `roots` allowlist (TOKEN LAW, bound at the admit gate).

use std::collections::HashMap;
use std::io::Read;
use std::net::{IpAddr, SocketAddr, TcpListener, TcpStream, UdpSocket};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{sync_channel, Receiver, SyncSender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use str0m::change::SdpOffer;
use str0m::media::{MediaData, MediaKind, MediaTime};
use str0m::net::{Protocol, Receive};
use str0m::{Candidate, Event, Input, Output, Rtc};

use str0m::config::DtlsCert;

use crate::cand;
use crate::opencode::OpencodeClient;
use crate::registry::{new_pending, Registry};
use crate::switch::{HttpReq, HttpReply, Switchboard, MAX_BODY, PASS_HEADERS};
use crate::roots::{resolve_root, root_allowed, RootSel};
use crate::speech::{resample_to_48k, Pcm, SpeechClient};
use crate::region::region_of;
use crate::ws;
use crate::tokens::{bearer, now_ms, Grant, TokenStore};

pub struct BridgeConfig {
    pub http: SocketAddr,
    pub media: SocketAddr,
    pub tokens_file: std::path::PathBuf,
    pub opencode_url: String,
    pub speaches_url: String,
    pub stt_model: String,
    pub tts_model: String,
    pub tts_voice: String,
    pub candidates: Vec<IpAddr>,
    /// v4: HMAC secret for link-tokens + the [roots] table id list.
    /// Empty secret = root-link protocol DISABLED (fail closed).
    pub root_link_secret: Option<Vec<u8>>,
    pub root_ids: Vec<String>,
    /// v4 [bridge.root-link] enabled=true — dial-in OFF unless BOTH the
    /// secret and this flag are set (fail closed twice).
    pub root_link_enabled: bool,
    /// v4 ws listen for root dial-in (None = 127.0.0.1 : bridge port + 1)
    pub root_link_listen: Option<String>,
    /// v4 trunk ping interval (secs); 2 missed pongs = reap
    pub root_link_ping_secs: u64,
    /// v4c GAP-A: per-root in-flight cap (default 1; 0 = unlimited)
    pub root_link_max_inflight: u64,
    /// how long a branch turn waits for its root's result (secs; default 20)
    pub root_link_result_secs: u64,
    /// v0.9 pairing: box name published on /identity (goes into the QR)
    pub name: String,
    /// persisted DTLS identity (base64 DER json, chmod 600); None = ephemeral
    pub dtls_cert_file: Option<std::path::PathBuf>,
    /// the signaling URL phones dial (LAN address); None = http://<bind>
    pub public_url: Option<String>,
}

pub struct BridgeHandle {
    pub http: SocketAddr,
    pub media: SocketAddr,
    /// v4: the root dial-in ws port when the plane is LIVE (None = off)
    pub root_link_port: Option<u16>,
    /// the root dial-in listener's bound address (what an access point's
    /// `/rootlink` stream is forwarded to); None = off
    pub root_link_addr: Option<SocketAddr>,
    /// "sha-256 AB:CD:…" of the persisted DTLS certificate
    pub fingerprint: String,
    stop: Arc<AtomicBool>,
}

impl Drop for BridgeHandle {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
    }
}

const RUN_TIMEOUT: Duration = Duration::from_secs(120);
const FRAME_SAMPLES: usize = 960; // 20ms @ 48k
/// how often every live peer is re-checked against the registry
const RECHECK: Duration = Duration::from_millis(500);
/// an access token may lapse this long before the peer is severed (renewal
/// rides `auth.refresh` over the channel a minute before expiry)
const EXPIRY_GRACE_MS: u64 = 30_000;

/// A peer crossing the admit gate — rtc + the credential it is accountable
/// to (v0.9) + its device's root allowlist (v4 TOKEN LAW: bound at /offer,
/// dispatch trusts only this) + the kill epoch it was admitted under.
pub struct Admit {
    pub rtc: Rtc,
    pub grant: Grant,
    pub epoch: u64,
}

struct Peer {
    rtc: Rtc,
    /// v4 TOKEN LAW: root allowlist bound at /offer from the device token
    roots: Vec<String>,
    /// the credential this peer is accountable to
    device: String,
    exp_ms: u64,
    epoch: u64,
    /// region of the /offer that admitted this peer — renewals must match it
    /// (NOT the media path: a multi-homed client's ICE checks arrive from
    /// several local interfaces, so the datagram source flaps)
    region: String,
    mid: Option<str0m::media::Mid>,
    pt: Option<str0m::media::Pt>,
    channels: Vec<str0m::channel::ChannelId>,
    capturing: bool,
    voice_buf: Vec<Vec<u8>>,
    media_pos_ms: u64,
}

impl Peer {
    fn write_all(&mut self, json: &str) {
        for &cid in &self.channels {
            if let Some(mut ch) = self.rtc.channel(cid) {
                let _ = ch.write(false, json.as_bytes());
            }
        }
    }
}

enum Job {
    Req {
        client: usize,
        cid: str0m::channel::ChannelId,
        reply_to: u64,
        op: ClientOp,
        /// v4: which root this turn is claimed at ("local" when absent)
        root: String,
        /// v4: trunk-minted dispatch id (echoes back on every reply/notice)
        tid: Option<String>,
        /// the device behind the turn (a link-root keeps one session per device)
        dev: String,
    },
    Voice {
        client: usize,
        cid: str0m::channel::ChannelId,
        reply_to: u64,
        sid: String,
        opus: Vec<Vec<u8>>,
        root: String,
        tid: Option<String>,
        dev: String,
    },
}

/// v4: was this turn claimed at a link-root (anything but the trunk's own)?
fn is_remote(root: &str) -> bool {
    !root.is_empty() && root != "local"
}

enum Outcome {
    Reply {
        client: usize,
        cid: str0m::channel::ChannelId,
        json: String,
    },
    Notice {
        client: usize,
        json: String,
    },
    Voice {
        client: usize,
        text: String,
        pcm48: Vec<i16>,
    },
    /// trunk-v2: room broadcast — one JSON message to every OTHER peer
    /// (`outcome.rs`-equivalent of relay.rs's media fan-out; control plane
    /// stays star, only this op fans out).
    Room {
        from: usize,
        json: String,
    },
    /// v4: a link-root's answer — the worker stamps client/cid before send.
    RootReply(serde_json::Map<String, serde_json::Value>),
}

/// The `app` channel contract (JSON; every request carries "req", every
/// response echoes it). Session ids are slugs or sess_*.
#[derive(serde::Deserialize)]
#[serde(tag = "op")]
enum ClientOp {
    #[serde(rename = "hello")]
    Hello {},
    #[serde(rename = "session.list")]
    SessionList {},
    #[serde(rename = "session.create")]
    SessionCreate { name: String },
    #[serde(rename = "prompt")]
    Prompt { id: String, text: String },
    #[serde(rename = "transcript")]
    Transcript { id: String },
    #[serde(rename = "voice.commit")]
    VoiceCommit { id: String, ms: u64 },
    #[serde(rename = "ping")]
    Ping { t: u64 },
    /// trunk-v2 room broadcast: say something to every OTHER peer in the room
    /// (control plane stays star; only this op fans out — relay.rs wiring)
    #[serde(rename = "room.say")]
    RoomSay { text: String },
}

pub fn start(cfg: BridgeConfig) -> Result<BridgeHandle, String> {
    let stop = Arc::new(AtomicBool::new(false));
    let cert = load_or_create_cert(cfg.dtls_cert_file.as_deref())?;
    let fingerprint = fingerprint_of(&cert);

    let media_sock = UdpSocket::bind(cfg.media).map_err(|e| format!("bridge media bind: {e}"))?;
    media_sock.set_nonblocking(true).map_err(|e| e.to_string())?;
    let media_addr = media_sock.local_addr().map_err(|e| e.to_string())?;

    let listener = TcpListener::bind(cfg.http).map_err(|e| format!("bridge http bind: {e}"))?;
    let http_addr = listener.local_addr().map_err(|e| e.to_string())?;
    let server = tiny_http::Server::from_listener(listener, None)
        .map_err(|e| format!("bridge http server: {e}"))?;

    let tokens = Arc::new(TokenStore::open(cfg.tokens_file.clone()));
    let oc = Arc::new(OpencodeClient::new(cfg.opencode_url.clone()));
    let roots_reg = Arc::new(Registry::new());
    // v4c GAP-A: per-root in-flight cap (config [root-link].max_inflight)
    roots_reg.max_inflight.store(
        if cfg.root_link_max_inflight == 0 { 0 } else { cfg.root_link_max_inflight },
        Ordering::SeqCst,
    );
    roots_reg.result_secs.store(cfg.root_link_result_secs.max(1), Ordering::SeqCst);
    // the switchboard: brain-to-brain HTTP over the root links (switch.rs);
    // `to = local` is this box's own brain
    let switch = Switchboard::new((*roots_reg).clone(), &cfg.opencode_url);

    let speech = Arc::new(SpeechClient::new(
        cfg.speaches_url.clone(),
        &cfg.stt_model,
        &cfg.tts_model,
        &cfg.tts_voice,
    ));

    let (job_tx, job_rx): (SyncSender<Job>, Receiver<Job>) = sync_channel(64);
    let (out_tx, out_rx): (SyncSender<Outcome>, Receiver<Outcome>) = sync_channel(256);
    let (admit_tx, admit_rx): (SyncSender<Admit>, Receiver<Admit>) = sync_channel(8);
    let job_tx = Arc::new(job_tx);

    // ---- v4 root-link dial-in plane (rootlink.rs) ----
    // The spec's ws op is {op:'root-link',token:'<link-token>'} as the FIRST
    // TEXT FRAME (not a header — the token must never ride a proxy log), and
    // the trunk drives a 15s ping loop with 2-missed-pong reaping. tiny_http
    // 0.12's upgrade() hands out ONE fused, non-cloneable stream, so the
    // /offer listener cannot host that contract without a blocking-reader
    // deadlock; the dial-in plane therefore binds its own small raw
    // TcpListener (loopback, default = bridge port + 1, config-overridable).
    // Same process, same ws.rs codec, same auth laws; /offer is untouched.
    let mut root_link_port: Option<u16> = None;
    let mut root_link_addr: Option<SocketAddr> = None;
    if let (Some(secret), true) = (cfg.root_link_secret.clone(), cfg.root_link_enabled) {
        if !secret.is_empty() {
            let ping = cfg.root_link_ping_secs.max(3);
            let port = http_addr.port() + 1;
            let listen: SocketAddr = match &cfg.root_link_listen {
                Some(s) => s
                    .parse()
                    .map_err(|e| format!("bridge.root-link.listen: {e}"))?,
                None => SocketAddr::from(([127, 0, 0, 1], port)),
            };
            let l = TcpListener::bind(listen)
                .map_err(|e| format!("bridge root-link bind {listen}: {e}"))?;
            let bound = l.local_addr().map_err(|e| e.to_string())?;
            root_link_port = Some(bound.port());
            root_link_addr = Some(bound);
            let plane = crate::rootlink::RootLinkPlane::new(
                secret,
                (*roots_reg).clone(),
                tokens.clone(),
                ping,
                switch.clone(),
            );
            plane.spawn(l);
            eprintln!(
                "bridge: root-link dial-in LIVE on ws {listen} (ping {ping}s, 2-miss reap)"
            );
        }
    }

    // the address we ADVERTISE — v2c hygiene: loopback/CGNAT/link-local are
    // NEVER advertised (the v2b scar: stale 127.0.0.1:8239 in the SDP made
    // browsers race a dead pair). 0.0.0.0 is a bind address, never a
    // candidate, and str0m drops STUN whose Receive destination doesn't match
    // a local candidate. Filtered candidates only; loopback kept solely as
    // dev/selftest fallback when config pins nothing usable.
    let (advertise_ips, dropped_ips) = cand::filter_advertised(&cfg.candidates);
    if !dropped_ips.is_empty() {
        eprintln!(
            "bridge: candidate hygiene — refused to advertise {} forbidden ip(s): {}",
            dropped_ips.len(),
            dropped_ips
                .iter()
                .map(|i| i.to_string())
                .collect::<Vec<_>>()
                .join(", ")
        );
    }
    let advertise_addr = SocketAddr::new(advertise_ips[0], media_addr.port());

    // blocking workers: opencode + speaches never run on the RTC loop
    let job_rx = Arc::new(Mutex::new(job_rx));
    for _ in 0..2 {
        let job_rx = job_rx.clone();
        let out_tx = out_tx.clone();
        let oc = oc.clone();
        let speech = speech.clone();
        let roots_reg = roots_reg.clone();
        std::thread::spawn(move || loop {
            let job = job_rx.lock().unwrap().recv();
            let Ok(job) = job else { return };
            let outcome = match job {
                Job::Req { client, cid, reply_to, op, root, tid, dev } => {
                    let mut outcome = handle_req(&oc, &out_tx, &roots_reg, client, cid, reply_to, op, &root, tid, &dev)
                        .unwrap_or_else(|e| {
                            Outcome::Reply {
                                client,
                                cid,
                                json: serde_json::json!({
                                    "req": reply_to, "ok": false, "err": e,
                                })
                                .to_string(),
                            }
                        });
                    // v4: stamp the peer coordinates a conn-thread outcome
                    // could not know (link-root answers arrive unm addressed)
                    if let Outcome::RootReply(mut obj) = outcome {
                        obj.insert("req".into(), serde_json::json!(reply_to));
                        outcome = Outcome::Reply {
                            client,
                            cid,
                            json: serde_json::Value::Object(obj).to_string(),
                        };
                    }
                    outcome
                }
                Job::Voice { client, cid, reply_to, sid, opus, root, tid, dev } => {
                    voice_pipeline(
                        &speech, &oc, &out_tx, &roots_reg,
                        client, cid, reply_to, &sid, &opus, &root, tid, &dev,
                    )
                    .unwrap_or_else(|e| Outcome::Notice {
                        client,
                        json: serde_json::json!({
                            "op": "voice.error", "req": reply_to, "err": e,
                        })
                        .to_string(),
                    })
                }
                _ => unreachable!("RootReply outcomes are stamped in the Req arm"),
            };
            let _ = out_tx.send(outcome);
        });
    }

    // ---- v4c: /branch worker pool ----
    // /branch turns BLOCK on a root (RESULT_WAIT, health probes). Handling
    // them on the signaling accept thread let ONE wedged root freeze every
    // /offer and /branch accept. Pool of 4: the signaling thread only
    // splices; turns block here, off the accept path.
    let (branch_tx, branch_rx): (SyncSender<tiny_http::Request>, Receiver<tiny_http::Request>) =
        sync_channel(64);
    let branch_rx = Arc::new(Mutex::new(branch_rx));
    for _ in 0..4 {
        let branch_rx = branch_rx.clone();
        let tokens_b = tokens.clone();
        let roots_reg_b = roots_reg.clone();
        let oc_b = oc.clone();
        std::thread::spawn(move || loop {
            let request = branch_rx.lock().unwrap().recv();
            let Ok(request) = request else { return };
            handle_branch(request, &tokens_b, &roots_reg_b, &oc_b);
        });
    }

    // signaling thread: GET /identity, POST /offer (+ device credential),
    // POST /branch (spliced to the pool), CORS
    {
        let stop = stop.clone();
        let candidates = advertise_ips.clone();
        let tokens = tokens.clone();
        let cert = cert.clone();
        let identity = serde_json::json!({
            "name": cfg.name,
            "fingerprint": fingerprint,
            "signal": cfg.public_url.clone().unwrap_or_else(|| format!("http://{http_addr}")),
            "version": env!("CARGO_PKG_VERSION"),
        })
        .to_string();
        // v4: every ws-looking request on /offer is REFUSED — root dial-in
        // lives on its own listener (see the plane above). Keeping the
        // refusal here makes the architecture explicit instead of silent.
        let roots_reg = roots_reg.clone();
        let oc = oc.clone();
        let branch_tx = branch_tx.clone();
        let switch = switch.clone();
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        std::thread::spawn(move || while !stop.load(Ordering::SeqCst) {
            let request = match server.recv_timeout(Duration::from_millis(100)) {
                Ok(Some(r)) => r,
                Ok(None) => continue,
                Err(_) => break,
            };
            // the switchboard's hub end: the box's own brain calls a linked
            // root (loopback only; blocks up to 120 s → its own thread)
            if request.url() == "/_root" || request.url().starts_with("/_root/") || request.url().starts_with("/_root?") {
                root_call_splice(request, &switch, &calls);
                continue;
            }
            let ws_looks = ws::ws_requested(&request).is_some();
            if ws_looks {
                let _ = request.respond(
                    tiny_http::Response::from_string(
                        "root dial-in is NOT on this port: dial the root-link ws (bridge port + 1)",
                    )
                    .with_status_code(426),
                );
                continue;
            }
            // v4c: /branch turns BLOCK on a root — splice to the branch
            // pool so /offer + health checks stay live during a root wait.
            let is_branch = request.url().trim_end_matches('/') == "/branch"
                && request.method() != &tiny_http::Method::Options;
            if is_branch {
                let _ = branch_tx.send(request);
                continue;
            }
            // ---- branch signaling: /identity, /offer ----
            handle_signaling_request(
                request,
                &candidates,
                media_addr,
                advertise_ips[0],
                &tokens,
                &cert,
                &identity,
                &admit_tx,
                &roots_reg,
                &oc,
            );
        });
    }

    // main RTC loop
    {
        let stop = stop.clone();
        let tokens = tokens.clone();
        let out_rx = Arc::new(Mutex::new(out_rx));
        std::thread::spawn(move || {
            let mut peers: HashMap<usize, Peer> = HashMap::new();
            let mut next_id = 0usize;
            let mut buf = vec![0u8; 4000];
            let mut last_check = Instant::now();

            loop {
                if stop.load(Ordering::SeqCst) {
                    return;
                }
                let now = Instant::now();

                // worker outcomes
                loop {
                    let outcome = { out_rx.lock().unwrap().try_recv() };
                    let Ok(outcome) = outcome else { break };
                    match outcome {
                        Outcome::Reply { client, cid, json } => {
                            if let Some(p) = peers.get_mut(&client) {
                                if let Some(mut ch) = p.rtc.channel(cid) {
                                    let _ = ch.write(false, json.as_bytes());
                                }
                            }
                        }
                        Outcome::Notice { client, json } => {
                            if let Some(p) = peers.get_mut(&client) {
                                p.write_all(&json);
                            }
                        }
                        Outcome::Voice { client, text, pcm48 } => {
                            if let Some(p) = peers.get_mut(&client) {
                                let frames = encode_opus_stream(&pcm48);
                                let mut wrote = 0usize;
                                if let (Some(mid), Some(pt)) = (p.mid, p.pt) {
                                    for (i, frame) in frames.iter().enumerate() {
                                        if let Some(w) = p.rtc.writer(mid) {
                                            let rtp = MediaTime::from(Duration::from_millis(
                                                p.media_pos_ms + (i as u64) * 20,
                                            ));
                                            if w.write(pt, Instant::now(), rtp, frame.clone())
                                                .is_ok()
                                            {
                                                wrote += 1;
                                            }
                                        }
                                    }
                                    p.media_pos_ms += (frames.len() as u64) * 20;
                                }
                                let notice = serde_json::json!({
                                    "op": "voice.reply",
                                    "text": text,
                                    "frames": wrote,
                                });
                                p.write_all(&notice.to_string());
                            }
                        }
                        Outcome::Room { from, json } => {
                            // trunk-v2 room fan-out: every peer EXCEPT the
                            // sender gets the message (relay.rs semantics —
                            // never echo back to the origin)
                            let targets: Vec<usize> = peers
                                .keys()
                                .copied()
                                .filter(|id| *id != from)
                                .collect();
                            for id in targets {
                                if let Some(p) = peers.get_mut(&id) {
                                    p.write_all(&json);
                                }
                            }
                        }
                        Outcome::RootReply(_) => {
                            unreachable!("workers stamp RootReply before sending")
                        }
                    }
                }

                // admit peers
                while let Ok(adm) = admit_rx.try_recv() {
                    let id = next_id;
                    next_id += 1;
                    peers.insert(
                        id,
                        Peer {
                            rtc: adm.rtc,
                            mid: None,
                            pt: None,
                            channels: vec![],
                            capturing: true,
                            voice_buf: vec![],
                            media_pos_ms: 0,
                            // v4 TOKEN LAW: the device's root allowlist,
                            // bound at /offer — dispatch trusts only this.
                            roots: adm.grant.roots,
                            device: adm.grant.device,
                            exp_ms: adm.grant.exp_ms,
                            epoch: adm.epoch,
                            region: adm.grant.region,
                        },
                    );
                }

                // socket drain once, demux per datagram.
                //
                // v2c LEARN-FROM-SOURCE law: `source` is the address the
                // packet ACTUALLY arrived from — never a remembered session
                // address. str0m's ICE agent (is crate) accepts the STUN
                // binding request against the ufrag/password and creates a
                // peer-reflexive REMOTE candidate from req.source, so the
                // media path re-anchors on the real source even when every
                // remembered address (trickle/SDP) was stale. Forbidden-class
                // remembered addresses are already purged at ingestion above;
                // packet sources are never filtered here — a valid STUN from
                // anywhere the phone actually is IS the peer address.
                loop {
                    match media_sock.recv_from(&mut buf) {
                        Ok((n, source)) => {
                            let input = Input::Receive(
                                now,
                                Receive {
                                    proto: Protocol::Udp,
                                    source,
                                    destination: advertise_addr,
                                    contents: (&buf[..n]).try_into().expect("contents"),
                                },
                            );
                            if let Some((_, p)) =
                                peers.iter_mut().find(|(_, p)| p.rtc.accepts(&input))
                            {
                                let _ = p.rtc.handle_input(input);
                            }
                        }
                        Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
                        Err(_) => break,
                    }
                }

                // per-peer timers + events; audio inbound is ALSO relayed
                // cross-peer (trunk-v2 room broadcast, relay.rs semantics:
                // collect per-origin here, fan out after the loop so the
                // peers map isn't borrowed twice)
                let mut room_audio: Vec<(usize, MediaData)> = vec![];
                for (id, p) in peers.iter_mut() {
                    let _ = p.rtc.handle_input(Input::Timeout(now));
                    loop {
                        match p.rtc.poll_output() {
                            Ok(Output::Transmit(t)) => {
                                let _ = media_sock.send_to(&t.contents, t.destination);
                            }
                            Ok(Output::Timeout(_)) => break,
                            Ok(Output::Event(e)) => match e {
                                Event::MediaAdded(ma) => {
                                    if ma.kind == MediaKind::Audio {
                                        p.mid = Some(ma.mid);
                                    }
                                }
                                Event::MediaData(d) => {
                                    p.pt = Some(d.pt);
                                    // trunk-v2: keep feeding the owner's voice
                                    // pipeline AND relay to the room
                                    if p.capturing {
                                        p.voice_buf.push(d.data.to_vec());
                                        if p.voice_buf.len() > 3000 {
                                            p.voice_buf.remove(0);
                                        }
                                    }
                                    room_audio.push((*id, d));
                                }
                                Event::ChannelOpen(cid, _) => p.channels.push(cid),
                                Event::ChannelData(cd) => {
                                    if let Ok(txt) = std::str::from_utf8(&cd.data) {
                                        // v0.9: in-band credential renewal,
                                        // answered inline (cached map lookup)
                                        if let Some(reply) = auth_refresh(&tokens, p, txt) {
                                            if let Some(mut ch) = p.rtc.channel(cd.id) {
                                                let _ = ch.write(false, reply.as_bytes());
                                            }
                                            continue;
                                        }
                                        let opus = match serde_json::from_str::<serde_json::Value>(txt)
                                        {
                                            Ok(v) if v.get("op").and_then(|o| o.as_str()) == Some("voice.commit") =>
                                                std::mem::take(&mut p.voice_buf),
                                            _ => vec![],
                                        };
                                        dispatch(
                                            &job_tx,
                                            &out_tx,
                                            &p.roots,
                                            &p.device,
                                            &roots_reg,
                                            *id,
                                            cd.id,
                                            txt,
                                            opus,
                                        );
                                    }
                                }
                                _ => {}
                            },
                            Err(_) => break,
                        }
                    }
                }

                // trunk-v2 room relay: every peer's audio → all OTHER peers
                // (byte-forwarded Opus, no decode/re-encode; sender excluded
                // so nobody hears themselves)
                for (origin, d) in &room_audio {
                    let pt = d.params.pt();
                    for (id, p) in peers.iter_mut() {
                        if *id == *origin {
                            continue; // never echo back to the sender
                        }
                        if let Some(mid) = p.mid {
                            if let Some(w) = p.rtc.writer(mid) {
                                let _ = w.write(pt, d.network_time, d.time, d.data.clone());
                            }
                        }
                    }
                }

                // v0.9 accountability sweep: revoked / kill-switch / lapsed →
                // severed (a v1 credential never lapses: exp = NO_EXPIRY)
                if last_check.elapsed() >= RECHECK {
                    last_check = Instant::now();
                    let epoch = tokens.kill_epoch();
                    let doomed: Vec<(usize, &'static str)> = peers
                        .iter()
                        .filter_map(|(id, p)| {
                            let why = if epoch != p.epoch {
                                "kill-switch"
                            } else if !tokens.device_live(&p.device) {
                                "revoked"
                            } else if now_ms() > p.exp_ms.saturating_add(EXPIRY_GRACE_MS) {
                                "token expired"
                            } else if !p.rtc.is_alive() {
                                "gone"
                            } else {
                                return None;
                            };
                            Some((*id, why))
                        })
                        .collect();
                    for (id, why) in doomed {
                        if let Some(mut p) = peers.remove(&id) {
                            sever(&mut p, why, &media_sock);
                            if why != "gone" {
                                println!("  bridge: severed peer {} ({}) — {why}", id, p.device);
                            }
                        }
                    }
                }

                std::thread::sleep(Duration::from_millis(2));
            }
        });
    }

    Ok(BridgeHandle {
        http: http_addr,
        media: media_addr,
        root_link_port,
        root_link_addr,
        fingerprint,
        stop,
    })
}

/// Tell the peer why, flush that last message onto the wire, then hang up.
fn sever(p: &mut Peer, why: &str, sock: &UdpSocket) {
    if p.rtc.is_alive() {
        p.write_all(&serde_json::json!({ "op": "severed", "why": why }).to_string());
        let _ = p.rtc.handle_input(Input::Timeout(Instant::now()));
        while let Ok(out) = p.rtc.poll_output() {
            match out {
                Output::Transmit(t) => {
                    let _ = sock.send_to(&t.contents, t.destination);
                }
                Output::Timeout(_) => break,
                Output::Event(_) => {}
            }
        }
    }
    p.rtc.disconnect();
}

/// `auth.refresh {token}` — rebind a live peer to a fresh credential (same
/// device, same region as the /offer that admitted the peer). Answered
/// inline on the RTC loop: the registry check is a cached map lookup.
fn auth_refresh(tokens: &TokenStore, p: &mut Peer, txt: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(txt).ok()?;
    if v.get("op").and_then(|o| o.as_str()) != Some("auth.refresh") {
        return None;
    }
    let req = v.get("req").and_then(|r| r.as_u64()).unwrap_or(0);
    let token = v.get("token").and_then(|t| t.as_str()).unwrap_or_default();
    Some(
        match tokens.check(token, &p.region) {
            Ok(g) if g.device == p.device => {
                p.exp_ms = g.exp_ms;
                serde_json::json!({ "req": req, "ok": true, "exp": g.exp_ms })
            }
            Ok(_) => serde_json::json!({ "req": req, "ok": false, "err": "token belongs to another device" }),
            Err(d) => serde_json::json!({ "req": req, "ok": false, "err": d.why(), "reauth": d.reauth() }),
        }
        .to_string(),
    )
}

/// CORS: the token IS the gate (no cookies are ever read), so the bridge is
/// origin-permissive by design; Private-Network lets an https PWA dial a LAN
/// bridge directly.
fn cors<T: std::io::Read>(r: tiny_http::Response<T>) -> tiny_http::Response<T> {
    let h = |k: &str, v: &str| tiny_http::Header::from_bytes(k.as_bytes(), v.as_bytes()).unwrap();
    r.with_header(h("Access-Control-Allow-Origin", "*"))
        .with_header(h("Access-Control-Allow-Headers", "Authorization, Content-Type"))
        .with_header(h("Access-Control-Allow-Methods", "GET, POST, OPTIONS"))
        .with_header(h("Access-Control-Allow-Private-Network", "true"))
        .with_header(h("Cache-Control", "no-store"))
}

fn json_response(status: u16, body: String) -> tiny_http::Response<std::io::Cursor<Vec<u8>>> {
    cors(
        tiny_http::Response::from_string(body)
            .with_status_code(status)
            .with_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap()),
    )
}

// ---- DTLS identity ---------------------------------------------------------

#[derive(serde::Serialize, serde::Deserialize)]
struct CertFile {
    certificate: String,
    private_key: String,
}

/// Load the persisted DTLS identity, or mint one and persist it (chmod 600).
fn load_or_create_cert(path: Option<&std::path::Path>) -> Result<DtlsCert, String> {
    use base64::Engine as _;
    let b64 = base64::engine::general_purpose::STANDARD;
    if let Some(path) = path {
        if let Ok(txt) = std::fs::read_to_string(path) {
            let f: CertFile = serde_json::from_str(&txt).map_err(|e| format!("dtls cert {}: {e}", path.display()))?;
            return Ok(DtlsCert {
                certificate: b64.decode(f.certificate).map_err(|e| e.to_string())?,
                private_key: b64.decode(f.private_key).map_err(|e| e.to_string())?,
            });
        }
    }
    let cert = str0m::crypto::from_feature_flags()
        .dtls_provider
        .generate_certificate()
        .ok_or("crypto provider cannot generate a DTLS certificate")?;
    if let Some(path) = path {
        let f = CertFile {
            certificate: b64.encode(&cert.certificate),
            private_key: b64.encode(&cert.private_key),
        };
        std::fs::write(path, serde_json::to_string(&f).unwrap()).map_err(|e| format!("dtls cert write: {e}"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
        }
    }
    Ok(cert)
}

/// The SDP form: "sha-256 AB:CD:…" over the DER certificate.
pub fn fingerprint_of(cert: &DtlsCert) -> String {
    use sha2::Digest as _;
    let d = sha2::Sha256::digest(&cert.certificate);
    let hex: Vec<String> = d.iter().map(|b| format!("{b:02X}")).collect();
    format!("sha-256 {}", hex.join(":"))
}

// ---------------------------------------------------------------------------
// branch signaling (GET /identity, POST /offer) — the v2c candidate law + the
// v0.9 pairing law (pinned DTLS identity, region-checked credential).
// ---------------------------------------------------------------------------

/// The 401 every signaling/branch gate answers: `why` + what the client must
/// do next (`reauth`: refresh | pair) — the PWA middleware's contract.
fn deny_response(why: &str, reauth: &str) -> tiny_http::Response<std::io::Cursor<Vec<u8>>> {
    json_response(
        401,
        serde_json::json!({ "error": "device token required", "why": why, "reauth": reauth }).to_string(),
    )
}

/// Bearer credential → Grant, checked in the region of the REAL socket
/// address (never a header a client could fake).
fn authorize(request: &tiny_http::Request, tokens: &TokenStore) -> Result<Grant, crate::tokens::Deny> {
    let auth = request
        .headers()
        .iter()
        .find(|h| h.field.equiv("Authorization"))
        .map(|h| h.value.as_str().to_string())
        .unwrap_or_default();
    let raw = bearer(&auth).ok_or(crate::tokens::Deny::Missing)?;
    tokens.check(raw, &request_region(request))
}

/// The region of the address a request really came from: its socket, except
/// for a stream the access-point dial-out handed over (it comes from this host,
/// with the client's address in X-Forwarded-For, believed only beside this
/// process's edge key — a secret that never leaves the process). A wrong key
/// or a bad address = no region (fail closed).
fn request_region(request: &tiny_http::Request) -> String {
    let Some(sock) = request.remote_addr().map(|a| a.ip()) else { return String::new() };
    let header = |name: &'static str| {
        request.headers().iter().find(|h| h.field.equiv(name)).map(|h| h.value.as_str().trim().to_string())
    };
    match header("X-Bifrost-Edge") {
        Some(k) => {
            if !crate::roots::ct_eq(k.as_bytes(), crate::ap::edge_key().as_bytes()) {
                return String::new();
            }
            header("X-Forwarded-For")
                .and_then(|x| x.parse::<IpAddr>().ok())
                .map(region_of)
                .unwrap_or_default()
        }
        _ => region_of(sock),
    }
}

#[allow(clippy::too_many_arguments)]
fn handle_signaling_request(
    mut request: tiny_http::Request,
    candidates: &[IpAddr],
    media_addr: SocketAddr,
    advertise_ip: IpAddr,
    tokens: &Arc<TokenStore>,
    cert: &DtlsCert,
    identity: &str,
    admit_tx: &SyncSender<Admit>,
    roots_reg: &Arc<Registry>,
    oc: &Arc<OpencodeClient>,
) {
    let url = request.url().trim_end_matches('/').to_string();
    let method = request.method().clone();
    // CORS: the PWA (any origin) posts offers with an Authorization header —
    // the token IS the gate, so the bridge is origin-permissive by design.
    if method == tiny_http::Method::Options {
        let _ = request.respond(cors(tiny_http::Response::empty(204)));
        return;
    }
    // v0.9: the pairing QR pins this fingerprint (trust-on-first-scan)
    if url == "/identity" {
        let _ = request.respond(json_response(200, identity.to_string()));
        return;
    }
    // v4: POST /branch — the SAME dispatch law as the data channel, over
    // authenticated HTTP. Exists so non-WebRTC harnesses (rootlink-sim.py,
    // no DTLS in stdlib python) can name roots; the phone keeps /offer.
    if url == "/branch" {
        handle_branch(request, tokens, roots_reg, oc);
        return;
    }
    if url != "/offer" || method != tiny_http::Method::Post {
        let _ = request.respond(cors(tiny_http::Response::from_string("bifrost bridge")));
        return;
    }
    let grant = match authorize(&request, tokens) {
        Ok(g) => g,
        Err(d) => {
            let _ = request.respond(deny_response(d.why(), d.reauth()));
            return;
        }
    };
    let epoch = tokens.kill_epoch();
    let bad = |msg: String| json_response(400, serde_json::json!({ "error": msg }).to_string());
    let mut body = String::new();
    let _ = request.as_reader().read_to_string(&mut body);
    // Chrome is trickle-only: the offer SDP carries NO candidates; they
    // arrive in the same POST as a `candidates` array (gathered client-side).
    // The body is the SdpOffer json ({type, sdp}) + that optional array.
    let parsed: serde_json::Value = match serde_json::from_str(&body) {
        Ok(v) => v,
        Err(e) => {
            let _ = request.respond(bad(format!("bad offer: {e}")));
            return;
        }
    };
    let Some(sdp_str) = parsed.get("sdp").and_then(|s| s.as_str()) else {
        let _ = request.respond(bad("bad offer: missing sdp".into()));
        return;
    };
    // v2c: purge forbidden addresses the client REMEMBERS about us (old
    // a=candidate lines — the v2b stale 127.0.0.1:8239 rode exactly this
    // path into answers)
    let (sdp_str, stripped) = cand::strip_forbidden_sdp_lines(sdp_str);
    if stripped > 0 {
        eprintln!(
            "bridge: candidate hygiene — stripped {stripped} forbidden a=candidate line(s) from offer SDP"
        );
    }
    let offer = match SdpOffer::from_sdp_string(&sdp_str) {
        Ok(o) => o,
        Err(e) => {
            let _ = request.respond(bad(format!("bad sdp: {e}")));
            return;
        }
    };
    let trickle: Vec<String> = parsed
        .get("candidates")
        .and_then(|c| c.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|c| c.as_str().map(String::from))
                .filter(|line| {
                    // v2c: stored peer transport addresses in 100.64/10,
                    // 127/8, 169.254/16 (etc) are PURGED at ingestion — ICE
                    // learns the real address from the first packet's source
                    // instead (str0m/is peer-reflexive path)
                    let ok = cand::usable_candidate_line(line);
                    if !ok {
                        eprintln!(
                            "bridge: candidate hygiene — dropped forbidden trickle candidate: {line}"
                        );
                    }
                    ok
                })
                .collect()
        })
        .unwrap_or_default();
    // v0.9: every peer shares the ONE persisted DTLS identity the QR pinned
    let mut rtc = Rtc::builder().set_dtls_cert(cert.clone()).build(Instant::now());
    // v2c emission: advertise ONLY the filtered list, public/reachable first
    // (str0m nominates the highest-priority pair — the public path must
    // lead), else loopback (0.0.0.0 is not a valid ICE candidate — this
    // panic'd the signaling thread once already). NEVER loopback/CGNAT/
    // link-local alongside a real IP.
    let advertise = advertise_ip;
    let ca = SocketAddr::new(advertise, media_addr.port());
    if let Ok(host) = Candidate::host(ca, "udp") {
        let _ = rtc.add_local_candidate(host);
    }
    for ip in candidates {
        if *ip == advertise {
            continue;
        }
        let caddr = SocketAddr::new(*ip, media_addr.port());
        if let Ok(c) = Candidate::host(caddr, "udp") {
            let _ = rtc.add_local_candidate(c);
        }
    }
    let answer = match rtc.sdp_api().accept_offer(offer) {
        Ok(a) => a,
        Err(e) => {
            let _ = request.respond(bad(format!("offer rejected: {e}")));
            return;
        }
    };
    // trickle AFTER accept_offer: str0m rejects remote candidates on an Rtc
    // in signaling-stable state, and the answer must already exist before
    // the browser can pair — this ordering is the ICE make-or-break.
    for c in &trickle {
        if let Ok(cand) = str0m::Candidate::from_sdp_string(c) {
            rtc.add_remote_candidate(cand); // malformed trickle lines are ignored
        }
    }
    eprintln!(
        "bridge: /offer answered — advertised {}:{} + {} remote candidate(s)",
        advertise,
        media_addr.port(),
        trickle.len()
    );
    let body = serde_json::to_string(&answer).expect("answer json");
    // v4 TOKEN LAW: the device's root-allowlist claim rides the grant into
    // the admit gate — dispatch trusts ONLY this (never anything from the
    // wire). v0.9: the grant + epoch make the peer accountable (sweep).
    if admit_tx.send(Admit { rtc, grant, epoch }).is_err() {
        return;
    }
    let _ = request.respond(json_response(200, body));
}

/// v4: POST /branch — one turn, Bearer device token, optional "root" claim.
/// Identical law to the channel path: allowlist from the TOKEN (never the
/// message), unknown root = "root not linked", local = the trunk's own
/// opencode (read-only ops only here — the interactive flow stays on the
/// data channel; /branch exists for harnesses without DTLS).
fn handle_branch(
    mut request: tiny_http::Request,
    tokens: &Arc<TokenStore>,
    roots_reg: &Arc<Registry>,
    oc: &Arc<OpencodeClient>,
) {
    // same gate as /offer: a live credential in the caller's real region
    // (a present-but-unknown token is refused too — never "anonymous")
    let grant = match authorize(&request, tokens) {
        Ok(g) => g,
        Err(d) => {
            let _ = request.respond(json_response(
                401,
                serde_json::json!({ "ok": false, "err": "device token required",
                                    "why": d.why(), "reauth": d.reauth() })
                .to_string(),
            ));
            return;
        }
    };
    // the device's root allowlist (TOKEN LAW — empty = anonymous-class)
    let roots_claim = grant.roots.clone();
    let mut body = String::new();
    let _ = request.as_reader().read_to_string(&mut body);
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&body) else {
        let _ = request.respond(cors(tiny_http::Response::from_string(
            r#"{"ok":false,"err":"bad json"}"#,
        ).with_status_code(400)));
        return;
    };
    let sel = v.get("root").and_then(|r| r.as_str()).unwrap_or("local").to_string();
    if sel == "local" {
        // local turns ride the trunk's own opencode — read-only surface here
        let out = match v.get("op").and_then(|o| o.as_str()) {
            Some("session.list") => match oc.list_sessions() {
                Ok(s) => {
                    let brief: Vec<_> = s
                        .iter()
                        .map(|x| serde_json::json!({"id": x.id, "title": x.title}))
                        .collect();
                    serde_json::json!({"ok": true, "root": "local", "sessions": brief})
                }
                Err(e) => serde_json::json!({"ok": false, "root": "local", "err": e}),
            },
            other => serde_json::json!({"ok": false, "root": "local",
                "err": format!("op '{other:?}' over /branch local is not served — use the data channel")}),
        };
        let code = if out.get("ok") == Some(&serde_json::Value::Bool(true)) { 200 } else { 502 };
        let _ = request.respond(cors(tiny_http::Response::from_string(out.to_string()).with_status_code(code)));
        return;
    }
    // remote root: allowlist FIRST (anonymous can never select), then link
    if !root_allowed(&roots_claim, &sel) {
        let _ = request.respond(cors(tiny_http::Response::from_string(
            serde_json::json!({"ok": false,
                "err": format!("root '{sel}' not allowed for this device token")}).to_string(),
        ).with_status_code(403)));
        return;
    }
    if !roots_reg.is_linked(&sel) {
        let _ = request.respond(cors(tiny_http::Response::from_string(
            r#"{"ok":false,"err":"root not linked"}"#,
        ).with_status_code(404)));
        return;
    }
    let kind = match v.get("op").and_then(|o| o.as_str()) {
        Some("prompt") => "prompt",
        Some("transcript") => "transcript",
        _ => {
            let _ = request.respond(cors(tiny_http::Response::from_string(
                r#"{"ok":false,"err":"/branch remote supports op prompt|transcript"}"#,
            ).with_status_code(400)));
            return;
        }
    };
    let mut turn_body = serde_json::Map::new();
    if let Some(id) = v.get("id") {
        turn_body.insert("session".into(), id.clone());
    }
    if let Some(t) = v.get("text") {
        turn_body.insert("text".into(), t.clone());
    }
    match root_turn(roots_reg, &sel, "", kind, serde_json::Value::Object(turn_body), &grant.device) {
        Ok(Outcome::RootReply(mut obj)) => {
            obj.insert("ok".into(), serde_json::json!(true));
            obj.insert("root".into(), serde_json::json!(sel));
            let _ = request.respond(cors(tiny_http::Response::from_string(
                serde_json::Value::Object(obj).to_string(),
            )));
        }
        Ok(_) => {
            let _ = request.respond(cors(tiny_http::Response::from_string(
                r#"{"ok":false,"err":"internal: unm stamped root reply"}"#,
            ).with_status_code(500)));
        }
        Err(e) => {
            let code = if e == "root not linked" {
                404
            } else if e.contains("unhealthy") || e.contains("busy") {
                // v4c: cap = 429-style, unhealthy = 503-style — both FAST
                429
            } else {
                502
            };
            let _ = request.respond(cors(tiny_http::Response::from_string(
                serde_json::json!({"ok": false, "err": e}).to_string(),
            ).with_status_code(code)));
        }
    }
}

/// How many `/_root/` calls may wait on roots at once.
const MAX_ROOT_CALLS: usize = 32;

/// Who may use `/_root/`: the box's own brain only — a LOOPBACK socket that
/// is neither a proxied request (an edge in front would make every client
/// look local) nor a browser (a web page on this box could otherwise drive a
/// root's brain cross-site: browsers always send Origin / Sec-Fetch-*).
fn root_call_guard(request: &tiny_http::Request) -> Result<(), &'static str> {
    let local = request.remote_addr().is_some_and(|a| a.ip().to_canonical().is_loopback());
    if !local {
        return Err("/_root is for this box's own brain: loopback clients only");
    }
    for h in request.headers() {
        let k = h.field.as_str().as_str().to_ascii_lowercase();
        if ["origin", "forwarded", "x-forwarded-for", "x-real-ip"].contains(&k.as_str()) || k.starts_with("sec-fetch-") {
            return Err("/_root refuses proxied and browser requests");
        }
    }
    if ws::ws_requested(request).is_some() {
        return Err("/_root carries plain HTTP, not websockets");
    }
    Ok(())
}

/// `ANY /_root/<id>/<rest>` → (id, "/<rest>") — the query rides along.
fn split_root_url(url: &str) -> Option<(String, String)> {
    let tail = url.strip_prefix("/_root/")?;
    let cut = tail.find(['/', '?']).unwrap_or(tail.len());
    let (id, rest) = tail.split_at(cut);
    let rest = if rest.is_empty() {
        "/".to_string()
    } else if rest.starts_with('?') {
        format!("/{rest}")
    } else {
        rest.to_string()
    };
    (!id.is_empty()).then(|| (id.to_string(), rest))
}

fn switch_response(reply: HttpReply) -> tiny_http::Response<std::io::Cursor<Vec<u8>>> {
    let mut r = tiny_http::Response::from_data(reply.body).with_status_code(reply.status);
    for (k, v) in &reply.headers {
        if let (true, Some(v)) = (PASS_HEADERS.contains(&k.as_str()), v.as_str()) {
            if let Ok(h) = tiny_http::Header::from_bytes(k.as_bytes(), v.as_bytes()) {
                r = r.with_header(h);
            }
        }
    }
    r.with_header(tiny_http::Header::from_bytes(&b"Cache-Control"[..], &b"no-store"[..]).unwrap())
}

/// The signaling thread only checks and splices: the call waits on its own
/// thread (a root may take up to the switchboard's 120 s to answer).
fn root_call_splice(request: tiny_http::Request, switch: &Arc<Switchboard>, calls: &Arc<std::sync::atomic::AtomicUsize>) {
    if let Err(why) = root_call_guard(&request) {
        let _ = request.respond(switch_response(HttpReply::error(403, why)));
        return;
    }
    if calls.fetch_add(1, Ordering::SeqCst) >= MAX_ROOT_CALLS {
        calls.fetch_sub(1, Ordering::SeqCst);
        let _ = request.respond(switch_response(HttpReply::error(503, "too many root calls in flight")));
        return;
    }
    let (switch, calls) = (switch.clone(), calls.clone());
    std::thread::spawn(move || {
        handle_root_call(request, &switch);
        calls.fetch_sub(1, Ordering::SeqCst);
    });
}

fn handle_root_call(mut request: tiny_http::Request, switch: &Switchboard) {
    let Some((to, path)) = split_root_url(request.url()) else {
        let _ = request.respond(switch_response(HttpReply::error(404, "use /_root/<root id>/<path>")));
        return;
    };
    let mut headers = serde_json::Map::new();
    for h in request.headers() {
        let k = h.field.as_str().as_str().to_ascii_lowercase();
        if PASS_HEADERS.contains(&k.as_str()) {
            headers.insert(k, serde_json::json!(h.value.as_str()));
        }
    }
    let mut body = Vec::new();
    if request.as_reader().take(MAX_BODY as u64 + 1).read_to_end(&mut body).is_err() {
        let _ = request.respond(switch_response(HttpReply::error(400, "could not read the body")));
        return;
    }
    if body.len() > MAX_BODY {
        let _ = request.respond(switch_response(HttpReply::error(413, "body too large for the switchboard")));
        return;
    }
    let reply = match HttpReq::new(request.method().as_str(), &path, headers, body) {
        Ok(req) => switch.call_root(&to, req),
        Err(e) => HttpReply::error(400, &e),
    };
    let _ = request.respond(switch_response(reply));
}

#[allow(clippy::too_many_arguments)]
fn dispatch(
    job_tx: &Arc<SyncSender<Job>>,
    out_tx: &SyncSender<Outcome>,
    roots_claim: &[String],
    device: &str,
    reg: &Registry,
    client: usize,
    cid: str0m::channel::ChannelId,
    txt: &str,
    opus: Vec<Vec<u8>>,
) {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(txt) else {
        return;
    };
    let reply_to = v.get("req").and_then(|r| r.as_u64()).unwrap_or(0);
    // v4 ROOT SELECTION: "root" claim on ANY op ("local" when absent).
    let sel = v
        .get("root")
        .and_then(|r| r.as_str())
        .unwrap_or("local")
        .to_string();
    // v4 TOKEN LAW: naming any root OTHER than the trunk's local root
    // demands a device token whose root-allowlist claim covers it. The
    // claim is bound at /offer from the token — NEVER from this message.
    // Anonymous scanners can only ever reach the public/local root.
    if is_remote(&sel) {
        // v4 TOKEN LAW: naming any root OTHER than the trunk's local root
        // demands a device token whose root-allowlist claim covers it. The
        // claim is bound at /offer from the token — NEVER from this message.
        // Anonymous scanners can only ever reach the public/local root.
        if !root_allowed(&roots_claim, &sel) {
            let err = serde_json::json!({
                "req": reply_to, "ok": false,
                "err": format!("root '{sel}' not allowed for this device token"),
            })
            .to_string();
            let _ = out_tx.send(Outcome::Reply { client, cid, json: err });
            return;
        }
        // v4 LINK LAW: allowed on paper but not dialed in = clean error.
        if !reg.is_linked(&sel) {
            let err = serde_json::json!({
                "req": reply_to, "ok": false,
                "err": "root not linked",
            })
            .to_string();
            let _ = out_tx.send(Outcome::Reply { client, cid, json: err });
            return;
        }
    }
    // v4 dispatch id: trunk-minted (branch req ids may collide across
    // sessions); every reply/notice to the branch echoes it as "tid".
    let tid = Some(format!("t{}", uuid_like()));
    let is_voice = v.get("op").and_then(|o| o.as_str()) == Some("voice.commit");
    let job = if is_voice {
        serde_json::from_value::<ClientOp>(v).ok().and_then(|op| match op {
            ClientOp::VoiceCommit { id, .. } => Some(Job::Voice {
                client,
                cid,
                reply_to,
                sid: id,
                opus,
                root: sel,
                tid,
                dev: device.to_string(),
            }),
            _ => None,
        })
    } else {
        serde_json::from_value::<ClientOp>(v).ok().map(|op| Job::Req {
            client,
            cid,
            reply_to,
            op,
            root: sel,
            tid,
            dev: device.to_string(),
        })
    };
    if let Some(job) = job {
        let _ = job_tx.send(job);
    }
}

fn reply_json(
    client: usize,
    cid: str0m::channel::ChannelId,
    req: u64,
    value: serde_json::Value,
) -> Outcome {
    let mut v = serde_json::json!({ "req": req, "ok": true });
    if let (Some(dst), Some(src)) = (v.as_object_mut(), value.as_object()) {
        for (k, val) in src {
            dst.insert(k.clone(), val.clone());
        }
    }
    Outcome::Reply {
        client,
        cid,
        json: v.to_string(),
    }
}

#[allow(clippy::too_many_arguments)]
fn handle_req(
    oc: &OpencodeClient,
    out_tx: &SyncSender<Outcome>,
    roots: &Arc<Registry>,
    client: usize,
    cid: str0m::channel::ChannelId,
    reply_to: u64,
    op: ClientOp,
    root: &str,
    tid: Option<String>,
    dev: &str,
) -> Result<Outcome, String> {
    // v4: ops that RESOLVE A SESSION are "turns" — a turn claimed at a
    // link-root rides that root's ws conn (trunk-local ops like hello /
    // ping / room.say stay trunk-local always).
    if is_remote(root) {
        match op {
            ClientOp::Prompt { id, text } => {
                return root_turn(
                    roots,
                    root,
                    tid.as_deref().unwrap_or(""),
                    "prompt",
                    serde_json::json!({ "session": id, "text": text }),
                    dev,
                );
            }
            ClientOp::Transcript { id } => {
                return root_turn(
                    roots,
                    root,
                    tid.as_deref().unwrap_or(""),
                    "transcript",
                    serde_json::json!({ "session": id }),
                    dev,
                );
            }
            // session.list / session.create named at a remote root are turns
            // too — the remote brain owns its own session surface
            ClientOp::SessionList {} => {
                return root_turn(roots, root, tid.as_deref().unwrap_or(""), "sessions", serde_json::json!({}), dev);
            }
            ClientOp::SessionCreate { name } => {
                return root_turn(
                    roots,
                    root,
                    tid.as_deref().unwrap_or(""),
                    "create",
                    serde_json::json!({ "name": name }),
                    dev,
                );
            }
            // hello / ping / room.say: trunk-local control plane
            _ => {}
        }
    }
    match op {
        ClientOp::Hello {} => Ok(reply_json(
            client,
            cid,
            reply_to,
            serde_json::json!({ "bridge": env!("CARGO_PKG_VERSION"), "voice": "speaches+opencode" }),
        )),
        ClientOp::SessionList {} => {
            let sessions = oc.list_sessions()?;
            let brief: Vec<_> = sessions
                .iter()
                .map(|s| serde_json::json!({"id": s.id, "title": s.title}))
                .collect();
            Ok(reply_json(
                client,
                cid,
                reply_to,
                serde_json::json!({ "sessions": brief }),
            ))
        }
        ClientOp::SessionCreate { name } => {
            let s = oc.create_session(&name)?;
            Ok(reply_json(
                client,
                cid,
                reply_to,
                serde_json::json!({ "id": s.id, "title": s.title }),
            ))
        }
        ClientOp::Transcript { id } => {
            let sid = oc.resolve(&id)?;
            let msgs = oc.transcript(&sid)?;
            Ok(reply_json(
                client,
                cid,
                reply_to,
                serde_json::json!({ "id": sid, "messages": msgs }),
            ))
        }
        ClientOp::Prompt { id, text } => {
            let sid = oc.resolve(&id)?;
            // opencode's POST /message resolves only when the run completes
            // (pwa/lib/oc-live.ts) — so the prompt runs off-worker and its
            // return IS run.done; the reply text rides the notice
            let oc2 = oc.clone();
            let out_tx2 = out_tx.clone();
            let sid2 = sid.clone();
            std::thread::spawn(move || {
                let json = match oc2.prompt(&sid2, &text) {
                    Ok(()) => {
                        let reply = oc2
                            .transcript(&sid2)
                            .ok()
                            .and_then(|m| last_assistant_text(&m))
                            .unwrap_or_default();
                        serde_json::json!({ "op": "run.done", "id": sid2, "reply": reply })
                    }
                    Err(e) => serde_json::json!({ "op": "run.done", "id": sid2, "error": e }),
                };
                let _ = out_tx2.send(Outcome::Notice { client, json: json.to_string() });
            });
            Ok(reply_json(
                client,
                cid,
                reply_to,
                serde_json::json!({ "id": sid, "accepted": true }),
            ))
        }
        ClientOp::Ping { t } => Ok(reply_json(
            client,
            cid,
            reply_to,
            serde_json::json!({ "pong": t }),
        )),
        ClientOp::RoomSay { text } => Ok(Outcome::Room {
            from: client,
            json: serde_json::json!({
                "op": "room.msg",
                "from": client,
                "text": text,
            })
            .to_string(),
        }),
        ClientOp::VoiceCommit { .. } => unreachable!("routed as Job::Voice"),
    }
}

/// v4: send one turn to a link-root and WAIT for its result (bounded).
/// Clean errors — never a panic — on unknown/refused/dead root or timeout.
fn root_turn(
    roots: &Arc<Registry>,
    root: &str,
    _tid: &str,
    kind: &str,
    mut body: serde_json::Value,
    dev: &str,
) -> Result<Outcome, String> {
    // the device behind the turn rides the job: a root running turns on its
    // own brain keeps ONE session per device (root-dial --brain)
    if let Some(obj) = body.as_object_mut() {
        obj.insert("dev".into(), serde_json::json!(dev));
    }
    // LINK LAW at the turn boundary: the allowlist lives at dispatch (it
    // holds the device claim); here we only re-check the dial state so a
    // root that died between dispatch and turn gets the clean error too.
    if !roots.is_linked(root) {
        return Err("root not linked".to_string());
    }
    // v4c HEALTH LAW — BEFORE RESULT_WAIT: the trunk probes the root's
    // AGENT loop (root.ping op → root.pong). Wedged agent = fast
    // 'root unhealthy', never a 20s worker eat.
    if let Err(e) = roots.probe_health(root) {
        return Err(e);
    }
    let tid_owned = crate::bridge::dispatch_tid();
    let (reply_tx, pending) = crate::registry::new_pending();
    // v4c CAP LAW — per-root in-flight cap: a root AT its cap gets an
    // immediate 429-style refusal, never a queued worker slot.
    let cap_err = roots.send_job_capped(root, &tid_owned, kind, body, reply_tx);
    if let Err(e) = cap_err {
        return Err(e);
    }
    let result = pending
        .rx
        .recv_timeout(roots.result_wait());
    // the slot is freed on result OR timeout — the cap never sticks
    roots.release_inflight(&tid_owned);
    let result = result.map_err(|_| format!("root '{root}' did not answer in time"))?;
    let ok = result.get("ok").and_then(|o| o.as_bool()).unwrap_or(false);
    // v4c: a conn-death drain reply carries err="root unhealthy" (no text) —
    // surface THAT to the branch, never an empty "refused the turn".
    let text = result
        .get("text")
        .and_then(|t| t.as_str())
        .or_else(|| result.get("err").and_then(|e| e.as_str()))
        .unwrap_or_default()
        .to_string();
    if !ok {
        return Err(if text == "root unhealthy" {
            "root unhealthy".to_string()
        } else {
            format!("root '{root}' refused the turn: {text}")
        });
    }
    let value: serde_json::Value = serde_json::from_str(&text)
        .unwrap_or_else(|_| serde_json::json!({ "text": text }));
    // client/cid stamped by the worker from the Job — a conn-thread Outcome
    // cannot know the peer coordinates, so it carries RootReply.
    let mut obj = match value {
        serde_json::Value::Object(o) => o,
        other => serde_json::json!({ "text": other.to_string() })
            .as_object()
            .cloned()
            .unwrap_or_default(),
    };
    obj.insert("root".into(), serde_json::json!(root));
    Ok(Outcome::RootReply(obj))
}

/// v4: trunk-minted dispatch id for a root turn.
fn dispatch_tid() -> String {
    format!("t{}", uuid_like())
}

fn assistant_count(msgs: &[crate::opencode::MessageInfo]) -> usize {
    msgs.iter().filter(|m| m.role() == Some("assistant")).count()
}

/// opus frames in (from the browser mic) → transcript → prompt → reply → TTS pcm48
#[allow(clippy::too_many_arguments)]
fn voice_pipeline(
    speech: &SpeechClient,
    oc: &OpencodeClient,
    out_tx: &SyncSender<Outcome>,
    roots: &Arc<Registry>,
    client: usize,
    _cid: str0m::channel::ChannelId,
    reply_to: u64,
    sid_or_slug: &str,
    opus: &[Vec<u8>],
    root: &str,
    _tid: Option<String>,
    dev: &str,
) -> Result<Outcome, String> {
    // v4: a voice turn claimed at a link-root = STT rides the trunk (the
    // trunk's speaches is the house ear), but the PROMPT runs on the named
    // root's brain; its text reply comes back as voice.reply (v5 will move
    // TTS/voice out too).
    if is_remote(root) {
        let pcm = decode_opus_stream(opus)?;
        let text = speech.transcribe(&Pcm { samples: pcm, rate: 48000 })?;
        if text.is_empty() {
            return Ok(Outcome::Notice {
                client,
                json: serde_json::json!({"op":"voice.error","req":reply_to,"err":"empty transcript"}).to_string(),
            });
        }
        let _ = out_tx.send(Outcome::Notice {
            client,
            json: serde_json::json!({"op":"voice.stt","req":reply_to,"text":text}).to_string(),
        });
        let outcome = root_turn(
            roots,
            root,
            "",
            "prompt",
            serde_json::json!({ "session": sid_or_slug, "text": text, "voice": true }),
            dev,
        )?;
        // stamp coords for the voice.reply notice
        if let Outcome::RootReply(mut obj) = outcome {
            obj.insert("op".into(), serde_json::json!("voice.reply"));
            obj.insert("req".into(), serde_json::json!(reply_to));
            return Ok(Outcome::Notice {
                client,
                json: serde_json::Value::Object(obj).to_string(),
            });
        }
        return Ok(outcome);
    }
    if opus.is_empty() {
        return Ok(Outcome::Notice {
            client,
            json: serde_json::json!({"op":"voice.error","req":reply_to,"err":"no audio captured"}).to_string(),
        });
    }
    let pcm = decode_opus_stream(opus)?;
    let text = speech.transcribe(&Pcm { samples: pcm, rate: 48000 })?;
    if text.is_empty() {
        return Ok(Outcome::Notice {
            client,
            json: serde_json::json!({"op":"voice.error","req":reply_to,"err":"empty transcript"}).to_string(),
        });
    }
    let _ = out_tx.send(Outcome::Notice {
        client,
        json: serde_json::json!({"op":"voice.stt","req":reply_to,"text":text}).to_string(),
    });

    let sid = oc.resolve(sid_or_slug)?;
    let before = oc.transcript(&sid).map(|m| assistant_count(&m)).unwrap_or(0);
    oc.prompt(&sid, &text)?;

    let start = Instant::now();
    let reply_text = loop {
        if start.elapsed() > RUN_TIMEOUT {
            return Ok(Outcome::Notice {
                client,
                json: serde_json::json!({"op":"run.done","id":sid,"timeout":true}).to_string(),
            });
        }
        std::thread::sleep(Duration::from_millis(1200));
        if let Ok(msgs) = oc.transcript(&sid) {
            if assistant_count(&msgs) > before {
                break last_assistant_text(&msgs).unwrap_or_default();
            }
        }
    };

    let _ = out_tx.send(Outcome::Notice {
        client,
        json: serde_json::json!({"op":"run.done","id":sid}).to_string(),
    });

    let tts = speech.tts(&reply_text)?;
    let pcm48 = resample_to_48k(&tts);
    Ok(Outcome::Voice {
        client,
        text: reply_text,
        pcm48,
    })
}

fn last_assistant_text(msgs: &[crate::opencode::MessageInfo]) -> Option<String> {
    let last = msgs.iter().rev().find(|m| m.role() == Some("assistant"))?;
    let parts = last.parts.as_ref()?;
    let arr = parts.as_array()?;
    let text: String = arr
        .iter()
        .filter_map(|p| p.get("text").and_then(|t| t.as_str()))
        .collect::<Vec<_>>()
        .join("");
    Some(text)
}

// ---- opus ------------------------------------------------------------------

fn decode_opus_stream(opus: &[Vec<u8>]) -> Result<Vec<i16>, String> {
    let mut dec = opus::Decoder::new(48000, opus::Channels::Mono)
        .map_err(|e| format!("opus decoder: {e}"))?;
    let mut out = Vec::with_capacity(opus.len() * FRAME_SAMPLES);
    let mut buf = vec![0i16; FRAME_SAMPLES * 4];
    for frame in opus {
        let n = dec
            .decode(frame, &mut buf, false)
            .map_err(|e| format!("opus decode: {e}"))?;
        out.extend_from_slice(&buf[..n]);
    }
    Ok(out)
}

fn encode_opus_stream(pcm48: &[i16]) -> Vec<Vec<u8>> {
    let mut enc = match opus::Encoder::new(48000, opus::Channels::Mono, opus::Application::LowDelay)
    {
        Ok(e) => e,
        Err(_) => return vec![],
    };
    let mut packets = vec![];
    let mut buf = vec![0u8; 400];
    for chunk in pcm48.chunks(FRAME_SAMPLES) {
        let mut input = chunk.to_vec();
        if input.len() < FRAME_SAMPLES {
            input.resize(FRAME_SAMPLES, 0);
        }
        if let Ok(n) = enc.encode(&input, &mut buf) {
            packets.push(buf[..n].to_vec());
        }
    }
    packets
}

// ---------------------------------------------------------------------------
// V9.2 selftest: in-process client through the REAL token-gated signaling,
// full channel protocol against the LIVE opencode server.
// ---------------------------------------------------------------------------

pub fn bridge_test() -> Result<(), String> {
    use crate::tokens::{hash_token, now_ms};

    // ONE temp registry in BOTH shapes the app writes (the test plays the
    // writer): v2 devices with region-bound, expiring access tokens, and a
    // v1 device — camelCase `tokenHash`, no expiry, no region (the V9.2 scar:
    // this test once wrote snake_case `token_hash`, which no reader accepts).
    let dir = std::env::temp_dir().join(format!("bfn-v9-{}", uuid_like()));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let tokens_path = dir.join("devices.json");
    let v1_tok = format!("bfnd-v1-{}", uuid_like());
    let write_reg = |epoch: u64, devs: &[(&str, bool, &str, u64, &str)], v1_revoked: bool| {
        let mut devices: Vec<_> = devs
            .iter()
            .map(|(id, revoked, raw, exp, region)| {
                serde_json::json!({
                    "id": id, "name": id, "revoked": revoked,
                    "access": [{ "hash": hash_token(raw), "exp": exp, "region": region }],
                })
            })
            .collect();
        devices.push(serde_json::json!({
            "id": "dev_v1", "name": "v1", "tokenHash": hash_token(&v1_tok),
            "created": "now", "revoked": v1_revoked, "roots": [],
        }));
        let reg = serde_json::json!({ "version": 2, "killEpoch": epoch, "devices": devices, "codes": [] });
        let tmp = tokens_path.with_extension("tmp");
        std::fs::write(&tmp, reg.to_string()).and_then(|_| std::fs::rename(&tmp, &tokens_path))
    };
    let ok_tok = format!("bfnd-ok-{}", uuid_like());
    let lan_tok = format!("bfnd-lan-{}", uuid_like());
    let old_tok = format!("bfnd-old-{}", uuid_like());
    let two_tok = format!("bfnd-two-{}", uuid_like());
    let later = now_ms() + 600_000;
    let mut devs = vec![
        ("dev_ok", false, ok_tok.as_str(), later, "loopback"),
        ("dev_lan", false, lan_tok.as_str(), later, "lan:10.9.9.0/24"),
        ("dev_old", false, old_tok.as_str(), now_ms() - 1, "loopback"),
        ("dev_two", false, two_tok.as_str(), later, "loopback"),
    ];
    write_reg(0, &devs, false).map_err(|e| e.to_string())?;

    let oc_url = std::env::var("OPENCODE_URL").unwrap_or_else(|_| "http://127.0.0.1:4096".into());
    let handle = start(BridgeConfig {
        http: "127.0.0.1:0".parse().unwrap(),
        media: "127.0.0.1:0".parse().unwrap(),
        tokens_file: tokens_path.clone(),
        opencode_url: oc_url.clone(),
        speaches_url: std::env::var("SPEACHES_URL").unwrap_or_else(|_| "http://127.0.0.1:8000/v1".into()),
        stt_model: "Systran/faster-whisper-small".into(),
        tts_model: "speaches-ai/Kokoro-82M-v1.0-ONNX".into(),
        tts_voice: "af_heart".into(),
        candidates: vec![IpAddr::from([127, 0, 0, 1])],
        // v9 e2e: root-link OFF here (the rootlink-sim.py harness is the
        // root-link plane's own test).
        root_link_secret: None,
        root_ids: vec![],
        root_link_enabled: false,
        root_link_listen: None,
        root_link_ping_secs: 15,
        root_link_max_inflight: 1,
        root_link_result_secs: 20,
        name: "selftest".into(),
        dtls_cert_file: Some(dir.join("dtls.json")),
        public_url: None,
    })
    .map_err(|e| e.to_string())?;

    // identity: persisted, stable across restarts, published for the QR
    let again = load_or_create_cert(Some(&dir.join("dtls.json")))?;
    if fingerprint_of(&again) != handle.fingerprint {
        return Err("persisted DTLS identity changed across a reload".into());
    }
    let id = http_get(handle.http, "/identity")?;
    if !id.contains(&handle.fingerprint) {
        return Err(format!("/identity does not publish the fingerprint: {id}"));
    }

    // auth negatives (no token, wrong token, wrong region, expired)
    for (tok, want) in [
        (None, "missing"),
        (Some("bfnd-not-a-real-token-value"), "invalid"),
        (Some(lan_tok.as_str()), "region"),
        (Some(old_tok.as_str()), "expired"),
    ] {
        let (status, body) = http_post(handle.http, "/offer", tok, "{}")?;
        if !status.starts_with("401") || !body.contains(want) {
            return Err(format!("offer with {want} credential answered {status} {body}"));
        }
    }

    // the real client: browser-shaped peer with the `app` data channel (v2)
    let mut c = V9Client::connect(handle.http, handle.media, &ok_tok)?;
    let fp_hex = handle.fingerprint.trim_start_matches("sha-256 ");
    if !c.answer.contains(fp_hex) {
        return Err("bridge answer does not carry the pinned fingerprint".into());
    }

    let hello = c.roundtrip(1, r#"{"op":"hello","req":1}"#)?;
    if !hello.contains("\"bridge\"") {
        return Err(format!("hello failed: {hello}"));
    }
    let name = format!("v9-e2e-{}", uuid_like());
    let created = c.roundtrip(
        2,
        &serde_json::json!({"op":"session.create","req":2,"name":name}).to_string(),
    )?;
    let created_v: serde_json::Value = serde_json::from_str(&created).map_err(|e| e.to_string())?;
    let sid = created_v["id"]
        .as_str()
        .ok_or_else(|| format!("no session id in {created}"))?
        .to_string();

    let list = c.roundtrip(3, r#"{"op":"session.list","req":3}"#)?;
    if !list.contains(&sid) {
        return Err(format!("created session {sid} missing from list: {list}"));
    }
    let tr = c.roundtrip(4, &format!(r#"{{"op":"transcript","req":4,"id":"{sid}"}}"#))?;
    let tr_v: serde_json::Value = serde_json::from_str(&tr).map_err(|e| e.to_string())?;
    if tr_v["messages"].as_array().is_none() {
        return Err(format!("transcript malformed: {tr}"));
    }

    // v1 device token (camelCase tokenHash, the tree's app shape) opens the
    // SAME pinned identity and speaks the same channel protocol
    let mut cv1 = V9Client::connect(handle.http, handle.media, &v1_tok)?;
    if !cv1.answer.contains(fp_hex) {
        return Err("v1 answer does not carry the pinned fingerprint".into());
    }
    let list_v1 = cv1.roundtrip(1, r#"{"op":"session.list","req":1}"#)?;
    if !list_v1.contains(&sid) {
        return Err(format!("v1 peer: session list missing {sid}: {list_v1}"));
    }

    // auth.refresh over the channel: a token of ANOTHER device is refused
    let other = c.roundtrip(5, &serde_json::json!({"op":"auth.refresh","req":5,"token":two_tok}).to_string())?;
    if !other.contains("another device") {
        return Err(format!("auth.refresh accepted a foreign token: {other}"));
    }
    let _ = oc_delete(&oc_url, &sid);

    // revoke MID-SESSION: the live peer is severed with the reason
    devs[0].1 = true;
    write_reg(0, &devs, false).map_err(|e| e.to_string())?;
    let t0 = Instant::now();
    c.await_notice("severed", "revoked", Duration::from_secs(4))?;
    let revoke_ms = t0.elapsed().as_millis();
    let revoked = http_post(handle.http, "/offer", Some(&ok_tok), "{}")?;
    if !revoked.0.starts_with("401") {
        return Err("REVOKED token still opens the bridge".into());
    }

    // the v1 device is just as accountable: revoke → severed, then 401
    write_reg(0, &devs, true).map_err(|e| e.to_string())?;
    let t2 = Instant::now();
    cv1.await_notice("severed", "revoked", Duration::from_secs(4))?;
    let revoke_v1_ms = t2.elapsed().as_millis();
    let revoked_v1 = http_post(handle.http, "/offer", Some(&v1_tok), "{}")?;
    if !revoked_v1.0.starts_with("401") || !revoked_v1.1.contains("revoked") {
        return Err(format!("REVOKED v1 token still opens the bridge: {revoked_v1:?}"));
    }

    // kill-switch: the epoch moves → every live peer severed
    let mut c2 = V9Client::connect(handle.http, handle.media, &two_tok)?;
    c2.roundtrip(1, r#"{"op":"hello","req":1}"#)?;
    write_reg(1, &devs, true).map_err(|e| e.to_string())?;
    let t1 = Instant::now();
    c2.await_notice("severed", "kill-switch", Duration::from_secs(4))?;
    let kill_ms = t1.elapsed().as_millis();

    drop(c);
    drop(cv1);
    drop(c2);
    drop(handle);
    let _ = std::fs::remove_dir_all(&dir);

    println!(
        "    identity pinned+stable; 401 missing/invalid/region/expired; hello+create+list+transcript over the channel; \
         v1 tokenHash device admitted (same pin); foreign auth.refresh refused; revoke mid-session → severed in {revoke_ms}ms \
         (v1: {revoke_v1_ms}ms); kill epoch → severed in {kill_ms}ms"
    );
    Ok(())
}

fn http_get(addr: SocketAddr, path: &str) -> Result<String, String> {
    use std::io::Write as _;
    let mut s = TcpStream::connect(addr).map_err(|e| format!("connect: {e}"))?;
    let req = format!("GET {path} HTTP/1.1\r\nHost: bridge\r\nConnection: close\r\n\r\n");
    s.write_all(req.as_bytes()).map_err(|e| e.to_string())?;
    let mut raw = String::new();
    s.read_to_string(&mut raw).map_err(|e| e.to_string())?;
    Ok(raw.split("\r\n\r\n").nth(1).unwrap_or_default().to_string())
}

fn oc_delete(base: &str, sid: &str) -> Result<(), String> {
    ureq::delete(&format!("{base}/session/{sid}")).call().map(|_| ()).map_err(|e| e.to_string())
}

fn uuid_like() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let n = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("{:x}", n)
}

/// (status-line, body)
fn http_post(
    addr: SocketAddr,
    path: &str,
    token: Option<&str>,
    body: &str,
) -> Result<(String, String), String> {
    use std::io::Write as _;
    let mut s = TcpStream::connect(addr).map_err(|e| format!("connect: {e}"))?;
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
    let status = raw
        .split_whitespace()
        .nth(1)
        .unwrap_or("??")
        .to_string();
    let body = raw
        .split("\r\n\r\n")
        .nth(1)
        .unwrap_or_default()
        .to_string();
    Ok((status, body))
}

/// Browser-shaped str0m client: opens the `app` data channel, speaks JSON.
struct V9Client {
    rtc: Rtc,
    /// the raw signaling answer (fingerprint check)
    answer: String,
    sock: UdpSocket,
    buf: Vec<u8>,
    cid: Option<str0m::channel::ChannelId>,
    inbox: Vec<String>,
    born: Instant,
}

impl V9Client {
    fn connect(sig: SocketAddr, media: SocketAddr, token: &str) -> Result<V9Client, String> {
        let sock = UdpSocket::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
        sock.set_nonblocking(true).map_err(|e| e.to_string())?;
        let local = sock.local_addr().map_err(|e| e.to_string())?;

        let mut rtc = Rtc::new(Instant::now());
        let cand = Candidate::host(local, "udp").map_err(|e| e.to_string())?;
        rtc.add_local_candidate(cand).ok_or("candidate rejected")?;

        let mut change = rtc.sdp_api();
        let cid = change.add_channel("app".into());
        let (offer, pending) = change.apply().ok_or("offer apply failed")?;
        let offer_json = serde_json::to_string(&offer).map_err(|e| e.to_string())?;
        let (status, body) = http_post(sig, "/offer", Some(token), &offer_json)?;
        if !status.starts_with('2') {
            return Err(format!("signaling rejected our offer: {status} {body}"));
        }
        let answer: str0m::change::SdpAnswer =
            serde_json::from_str(&body).map_err(|e| format!("bad answer: {e}"))?;
        rtc.sdp_api()
            .accept_answer(pending, answer)
            .map_err(|e| format!("accept_answer: {e}"))?;

        Ok(V9Client {
            rtc,
            answer: body,
            sock,
            buf: vec![0u8; 4000],
            cid: Some(cid),
            inbox: vec![],
            born: Instant::now(),
        })
    }

    fn pump(&mut self) {
        let now = Instant::now();
        loop {
            match self.sock.recv_from(&mut self.buf) {
                Ok((n, source)) => {
                    let input = Input::Receive(
                        now,
                        Receive {
                            proto: Protocol::Udp,
                            source,
                            destination: self.sock.local_addr().expect("local"),
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
                Ok(Output::Transmit(t)) => {
                    let _ = self.sock.send_to(&t.contents, t.destination);
                }
                Ok(Output::Timeout(_)) => break,
                Ok(Output::Event(e)) => match e {
                    Event::ChannelData(cd) => {
                        if let Ok(s) = std::str::from_utf8(&cd.data) {
                            self.inbox.push(s.to_string());
                        }
                    }
                    _ => {}
                },
                Err(_) => break,
            }
        }
    }

    /// Wait for a server notice `{"op": op, "why": why}`.
    fn await_notice(&mut self, op: &str, why: &str, within: Duration) -> Result<(), String> {
        let deadline = Instant::now() + within;
        while Instant::now() < deadline {
            self.pump();
            let hit = self.inbox.iter().any(|m| {
                serde_json::from_str::<serde_json::Value>(m).is_ok_and(|v| {
                    v.get("op").and_then(|o| o.as_str()) == Some(op)
                        && v.get("why").and_then(|w| w.as_str()) == Some(why)
                })
            });
            if hit {
                return Ok(());
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        Err(format!("no {op}/{why} notice within {within:?} (inbox: {:?})", self.inbox))
    }

    fn roundtrip(&mut self, req: u64, json: &str) -> Result<String, String> {
        let deadline = Instant::now() + TIMEOUT_DUR;
        let cid = self.cid.ok_or("channel not open yet")?;
        // wait until SCTP association is up (client-side channel appears),
        // pumping ICE/DTLS meanwhile
        loop {
            if self.rtc.channel(cid).is_some() {
                break;
            }
            if Instant::now() > deadline {
                return Err("channel never opened".into());
            }
            self.pump();
            std::thread::sleep(Duration::from_millis(20));
        }
        // channel write: borrow the channel alone in its own scope
        {
            let wrote = loop {
                if Instant::now() > deadline {
                    break false;
                }
                let ok = self
                    .rtc
                    .channel(cid)
                    .ok_or("channel vanished")?
                    .write(false, json.as_bytes());
                match ok {
                    Ok(true) => break true,
                    Ok(false) => self.pump(),
                    Err(e) => return Err(format!("channel write: {e}")),
                }
                std::thread::sleep(Duration::from_millis(25));
            };
            if !wrote {
                return Err("channel never accepted the write (not connected?)".into());
            }
        }
        while Instant::now() < deadline {
            self.pump();
            let hit = self.inbox.iter().position(|msg| {
                serde_json::from_str::<serde_json::Value>(msg)
                    .ok()
                    .and_then(|v| v.get("req").and_then(|r| r.as_u64()))
                    == Some(req)
            });
            if let Some(i) = hit {
                return Ok(self.inbox.remove(i));
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        Err(format!("no reply to req {req}"))
    }
}

const TIMEOUT_DUR: Duration = Duration::from_secs(12);

/// V9.3: voice pipeline validation WITHOUT a browser —
/// 1. opus round trip keeps the waveform (correlation)
/// 2. real STT∘TTS loop against speaches: tts(text) → opus → decode → stt(text')
pub fn voice_test() -> Result<(), String> {
    // 1. codec round trip
    let mut pcm: Vec<i16> = Vec::with_capacity(48000);
    for n in 0..48000usize {
        let t = n as f32 / 48000.0;
        let env = (t * 3.0).sin().abs().min(1.0);
        let s = (t * 2.0 * std::f32::consts::PI * 440.0).sin() * 12000.0 * env;
        pcm.push(s as i16);
    }
    let packets = encode_opus_stream(&pcm);
    let decoded = decode_opus_stream(&packets)?;
    let corr = correlate(&pcm, &decoded);
    if corr < 0.8 {
        return Err(format!("opus round trip correlation {corr:.2} < 0.8"));
    }

    // 2. real speaches loop (skips honestly if the server is absent)
    let speech = SpeechClient::new(
        std::env::var("SPEACHES_URL").unwrap_or_else(|_| "http://127.0.0.1:8000/v1".into()),
        &std::env::var("V9_STT_MODEL")
            .unwrap_or_else(|_| "Systran/faster-whisper-small".into()),
        &std::env::var("V9_TTS_MODEL")
            .unwrap_or_else(|_| "speaches-ai/Kokoro-82M-v1.0-ONNX".into()),
        "af_heart",
    );
    let text_in = "Bifrost bridge voice test";
    let tts = speech.tts(text_in)?;
    if tts.samples.is_empty() {
        return Err("speaches TTS returned no audio".into());
    }
    let pcm48 = resample_to_48k(&tts);
    let packets = encode_opus_stream(&pcm48);
    let decoded = decode_opus_stream(&packets)?;
    let heard = speech.transcribe(&Pcm {
        samples: decoded,
        rate: 48000,
    })?;
    let heard_lower = heard.to_lowercase();
    if heard_lower.len() < 4 {
        return Err(format!("STT of TTS audio came back empty ('{heard}')"));
    }
    let hits = ["bifrost", "bridge", "voice", "test"]
        .iter()
        .filter(|w| heard_lower.contains(**w))
        .count();
    if hits == 0 {
        return Err(format!(
            "STT∘TTS loop lost the sentence: heard '{heard}' (expected ~'{text_in}')"
        ));
    }
    println!(
        "    opus corr {corr:.2}; TTS '{text_in}' → {} opus frames → STT heard '{heard}' ({hits}/4 keywords)",
        packets.len()
    );
    Ok(())
}

fn correlate(a: &[i16], b: &[i16]) -> f64 {
    let n = a.len().min(b.len());
    if n == 0 {
        return 0.0;
    }
    let (a, b) = (&a[..n], &b[..n]);
    let ma: f64 = a.iter().map(|x| *x as f64).sum::<f64>() / n as f64;
    let mb: f64 = b.iter().map(|x| *x as f64).sum::<f64>() / n as f64;
    let (mut num, mut da, mut db) = (0.0, 0.0, 0.0);
    for i in 0..n {
        let x = a[i] as f64 - ma;
        let y = b[i] as f64 - mb;
        num += x * y;
        da += x * x;
        db += y * y;
    }
    if da == 0.0 || db == 0.0 {
        return 0.0;
    }
    num / (da.sqrt() * db.sqrt())
}

#[cfg(test)]
mod switch_url_tests {
    use super::split_root_url;

    #[test]
    fn root_urls_split_with_their_query() {
        let s = |u: &str| split_root_url(u);
        assert_eq!(s("/_root/mac/session/x/message?async=1&origin=none"),
                   Some(("mac".into(), "/session/x/message?async=1&origin=none".into())));
        assert_eq!(s("/_root/mac"), Some(("mac".into(), "/".into())));
        assert_eq!(s("/_root/mac?x=1"), Some(("mac".into(), "/?x=1".into())));
        assert_eq!(s("/_root/mac/"), Some(("mac".into(), "/".into())));
        assert_eq!(s("/_root/"), None);
        assert_eq!(s("/_root//x"), None);
    }
}
