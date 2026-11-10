//! v0.9 bridge — the phone's DIRECT path to the tree (no tailscale).
//!
//! Token-gated WebRTC signaling + peers. Over the `app` data channel: JSON
//! request/response mirroring the PWA proxy's session surface. Over the audio
//! track: mic → Opus → (voice.commit) → speaches STT → opencode prompt →
//! reply → speaches TTS → Opus back to the phone.
//!
//! Auth (S1 seam): a live, unexpired, region-bound access token is required on
//! /offer (tokens.rs — the PWA mints, the bridge verifies; region from the REAL
//! socket address). The DTLS session established through that exchange IS the
//! authenticated session, and it stays accountable: every live peer is
//! re-checked every 500ms and SEVERED (a `severed` notice with the reason, then
//! disconnect) when its device is revoked, the kill epoch moves (kill-switch),
//! or its access token lapses without an `auth.refresh` over the channel.
//!
//! Identity (trust-on-first-scan): ONE persisted DTLS certificate for every
//! peer, so its sha-256 fingerprint is stable — GET /identity publishes it for
//! the pairing QR, the phone pins it, and the browser refuses any answer (and
//! any DTLS handshake) that does not carry it. Signaling is the box's own
//! HTTP: no signaling server exists. CORS is open (no cookies are ever read),
//! so the phone's PWA can dial the bridge directly.

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

use crate::opencode::OpencodeClient;
use crate::region::region_of;
use crate::speech::{resample_to_48k, Pcm, SpeechClient};
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
    /// box name published on /identity (goes into the pairing QR)
    pub name: String,
    /// persisted DTLS identity (base64 DER json, chmod 600); None = ephemeral
    pub dtls_cert_file: Option<std::path::PathBuf>,
    /// the signaling URL phones dial (LAN address); None = http://<bind>
    pub public_url: Option<String>,
}

pub struct BridgeHandle {
    pub http: SocketAddr,
    pub media: SocketAddr,
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

struct Peer {
    rtc: Rtc,
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
    },
    Voice {
        client: usize,
        cid: str0m::channel::ChannelId,
        reply_to: u64,
        sid: String,
        opus: Vec<Vec<u8>>,
    },
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
    let speech = Arc::new(SpeechClient::new(
        cfg.speaches_url.clone(),
        &cfg.stt_model,
        &cfg.tts_model,
        &cfg.tts_voice,
    ));

    let (job_tx, job_rx): (SyncSender<Job>, Receiver<Job>) = sync_channel(64);
    let (out_tx, out_rx): (SyncSender<Outcome>, Receiver<Outcome>) = sync_channel(256);
    let (admit_tx, admit_rx): (SyncSender<(Rtc, Grant, u64)>, Receiver<(Rtc, Grant, u64)>) =
        sync_channel(8);
    let job_tx = Arc::new(job_tx);

    // blocking workers: opencode + speaches never run on the RTC loop
    let job_rx = Arc::new(Mutex::new(job_rx));
    for _ in 0..2 {
        let job_rx = job_rx.clone();
        let out_tx = out_tx.clone();
        let oc = oc.clone();
        let speech = speech.clone();
        std::thread::spawn(move || loop {
            let job = job_rx.lock().unwrap().recv();
            let Ok(job) = job else { return };
            let outcome = match job {
                Job::Req { client, cid, reply_to, op } => {
                    handle_req(&oc, &out_tx, client, cid, reply_to, op).unwrap_or_else(|e| {
                        Outcome::Reply {
                            client,
                            cid,
                            json: serde_json::json!({
                                "req": reply_to, "ok": false, "err": e,
                            })
                            .to_string(),
                        }
                    })
                }
                Job::Voice { client, cid, reply_to, sid, opus } => {
                    voice_pipeline(&speech, &oc, &out_tx, client, cid, reply_to, &sid, &opus)
                        .unwrap_or_else(|e| Outcome::Notice {
                            client,
                            json: serde_json::json!({
                                "op": "voice.error", "req": reply_to, "err": e,
                            })
                            .to_string(),
                        })
                }
            };
            let _ = out_tx.send(outcome);
        });
    }

    // signaling thread: GET /identity, POST /offer (+ access token), CORS
    {
        let stop = stop.clone();
        let candidates = cfg.candidates.clone();
        let tokens = tokens.clone();
        let cert = cert.clone();
        let identity = serde_json::json!({
            "name": cfg.name,
            "fingerprint": fingerprint,
            "signal": cfg.public_url.clone().unwrap_or_else(|| format!("http://{http_addr}")),
            "version": env!("CARGO_PKG_VERSION"),
        })
        .to_string();
        std::thread::spawn(move || {
            while !stop.load(Ordering::SeqCst) {
                match server.recv_timeout(Duration::from_millis(100)) {
                    Ok(Some(request)) => {
                        handle_signal(request, &tokens, &cert, &candidates, media_addr, &identity, &admit_tx)
                    }
                    Ok(None) => {}
                    Err(_) => break,
                }
            }
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
                    }
                }

                // admit peers
                while let Ok((rtc, grant, epoch)) = admit_rx.try_recv() {
                    let id = next_id;
                    next_id += 1;
                    peers.insert(
                        id,
                        Peer {
                            rtc,
                            device: grant.device,
                            exp_ms: grant.exp_ms,
                            epoch,
                            region: grant.region,
                            mid: None,
                            pt: None,
                            channels: vec![],
                            capturing: true,
                            voice_buf: vec![],
                            media_pos_ms: 0,
                        },
                    );
                }

                // socket drain once, demux per datagram
                loop {
                    match media_sock.recv_from(&mut buf) {
                        Ok((n, source)) => {
                            let input = Input::Receive(
                                now,
                                Receive {
                                    proto: Protocol::Udp,
                                    source,
                                    destination: media_addr,
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

                // per-peer timers + events
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
                                    if p.capturing {
                                        p.voice_buf.push(d.data.to_vec());
                                        if p.voice_buf.len() > 3000 {
                                            p.voice_buf.remove(0);
                                        }
                                    }
                                }
                                Event::ChannelOpen(cid, _) => p.channels.push(cid),
                                Event::ChannelData(cd) => {
                                    if let Ok(txt) = std::str::from_utf8(&cd.data) {
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
                                        dispatch(&job_tx, *id, cd.id, txt, opus);
                                    }
                                }
                                _ => {}
                            },
                            Err(_) => break,
                        }
                    }
                }

                // accountability sweep: revoked / kill-switch / lapsed → severed
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
                            } else if now_ms() > p.exp_ms + EXPIRY_GRACE_MS {
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

/// `auth.refresh {token}` — rebind a live peer to a fresh access token (same
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

fn cors(r: tiny_http::Response<std::io::Cursor<Vec<u8>>>) -> tiny_http::Response<std::io::Cursor<Vec<u8>>> {
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

fn handle_signal(
    mut request: tiny_http::Request,
    tokens: &TokenStore,
    cert: &DtlsCert,
    candidates: &[IpAddr],
    media_addr: SocketAddr,
    identity: &str,
    admit_tx: &SyncSender<(Rtc, Grant, u64)>,
) {
    let url = request.url().trim_end_matches('/').to_string();
    let method = request.method().clone();
    if method == tiny_http::Method::Options {
        let _ = request.respond(cors(tiny_http::Response::from_string("").with_status_code(204)));
        return;
    }
    if url == "/identity" {
        let _ = request.respond(json_response(200, identity.to_string()));
        return;
    }
    if url != "/offer" || method != tiny_http::Method::Post {
        let _ = request.respond(cors(tiny_http::Response::from_string("bifrost bridge")));
        return;
    }
    let deny = |why: &str, reauth: &str| {
        json_response(
            401,
            serde_json::json!({ "error": "device token required", "why": why, "reauth": reauth }).to_string(),
        )
    };
    let auth = request
        .headers()
        .iter()
        .find(|h| h.field.equiv("Authorization"))
        .map(|h| h.value.as_str().to_string())
        .unwrap_or_default();
    let Some(raw) = bearer(&auth) else {
        let _ = request.respond(deny("missing", "pair"));
        return;
    };
    let region = request.remote_addr().map(|a| region_of(a.ip())).unwrap_or_default();
    let grant = match tokens.check(raw, &region) {
        Ok(g) => g,
        Err(d) => {
            let _ = request.respond(deny(d.why(), d.reauth()));
            return;
        }
    };
    let epoch = tokens.kill_epoch();
    let mut body = String::new();
    let _ = request.as_reader().read_to_string(&mut body);
    let offer: SdpOffer = match serde_json::from_str(&body) {
        Ok(o) => o,
        Err(e) => {
            let _ = request.respond(json_response(400, serde_json::json!({ "error": format!("bad offer: {e}") }).to_string()));
            return;
        }
    };
    let mut rtc = Rtc::builder().set_dtls_cert(cert.clone()).build(Instant::now());
    let host = Candidate::host(media_addr, "udp").expect("media candidate");
    let _ = rtc.add_local_candidate(host);
    for ip in candidates {
        let ca = SocketAddr::new(*ip, media_addr.port());
        if let Ok(c) = Candidate::host(ca, "udp") {
            let _ = rtc.add_local_candidate(c);
        }
    }
    let answer = match rtc.sdp_api().accept_offer(offer) {
        Ok(a) => a,
        Err(e) => {
            let _ = request.respond(json_response(400, serde_json::json!({ "error": format!("offer rejected: {e}") }).to_string()));
            return;
        }
    };
    let body = serde_json::to_string(&answer).expect("answer json");
    if admit_tx.send((rtc, grant, epoch)).is_err() {
        return;
    }
    let _ = request.respond(json_response(200, body));
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

fn dispatch(
    job_tx: &Arc<SyncSender<Job>>,
    client: usize,
    cid: str0m::channel::ChannelId,
    txt: &str,
    opus: Vec<Vec<u8>>,
) {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(txt) else {
        return;
    };
    let reply_to = v.get("req").and_then(|r| r.as_u64()).unwrap_or(0);
    let is_voice = v.get("op").and_then(|o| o.as_str()) == Some("voice.commit");
    let job = if is_voice {
        serde_json::from_value::<ClientOp>(v).ok().and_then(|op| match op {
            ClientOp::VoiceCommit { id, .. } => Some(Job::Voice { client, cid, reply_to, sid: id, opus }),
            _ => None,
        })
    } else {
        serde_json::from_value::<ClientOp>(v)
            .ok()
            .map(|op| Job::Req { client, cid, reply_to, op })
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

fn handle_req(
    oc: &OpencodeClient,
    out_tx: &SyncSender<Outcome>,
    client: usize,
    cid: str0m::channel::ChannelId,
    reply_to: u64,
    op: ClientOp,
) -> Result<Outcome, String> {
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
        ClientOp::VoiceCommit { .. } => unreachable!("routed as Job::Voice"),
    }
}

fn assistant_count(msgs: &[crate::opencode::MessageInfo]) -> usize {
    msgs.iter()
        .filter(|m| m.role() == Some("assistant"))
        .count()
}

/// opus frames in (from the browser mic) → transcript → prompt → reply → TTS pcm48
fn voice_pipeline(
    speech: &SpeechClient,
    oc: &OpencodeClient,
    out_tx: &SyncSender<Outcome>,
    client: usize,
    _cid: str0m::channel::ChannelId,
    reply_to: u64,
    sid_or_slug: &str,
    opus: &[Vec<u8>],
) -> Result<Outcome, String> {
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

    // temp v2 registry (the PWA's exact shape): devices with region-bound,
    // expiring access tokens; the test plays the PWA writer
    let dir = std::env::temp_dir().join(format!("bfn-v9-{}", uuid_like()));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let tokens_path = dir.join("devices.json");
    let write_reg = |epoch: u64, devs: &[(&str, bool, &str, u64, &str)]| {
        let devices: Vec<_> = devs
            .iter()
            .map(|(id, revoked, raw, exp, region)| {
                serde_json::json!({
                    "id": id, "name": id, "revoked": revoked,
                    "access": [{ "hash": hash_token(raw), "exp": exp, "region": region }],
                })
            })
            .collect();
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
    write_reg(0, &devs).map_err(|e| e.to_string())?;

    let handle = start(BridgeConfig {
        http: "127.0.0.1:0".parse().unwrap(),
        media: "127.0.0.1:0".parse().unwrap(),
        tokens_file: tokens_path.clone(),
        opencode_url: std::env::var("OPENCODE_URL").unwrap_or_else(|_| "http://127.0.0.1:4096".into()),
        speaches_url: std::env::var("SPEACHES_URL").unwrap_or_else(|_| "http://127.0.0.1:8000/v1".into()),
        stt_model: "Systran/faster-whisper-small".into(),
        tts_model: "speaches-ai/Kokoro-82M-v1.0-ONNX".into(),
        tts_voice: "af_heart".into(),
        candidates: vec![IpAddr::from([127, 0, 0, 1])],
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

    // the real client: browser-shaped peer with the `app` data channel
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
    // auth.refresh over the channel: a token of ANOTHER device is refused
    let other = c.roundtrip(5, &serde_json::json!({"op":"auth.refresh","req":5,"token":two_tok}).to_string())?;
    if !other.contains("another device") {
        return Err(format!("auth.refresh accepted a foreign token: {other}"));
    }
    let _ = oc_delete(&std::env::var("OPENCODE_URL").unwrap_or_else(|_| "http://127.0.0.1:4096".into()), &sid);

    // revoke MID-SESSION: the live peer is severed with the reason
    devs[0].1 = true;
    write_reg(0, &devs).map_err(|e| e.to_string())?;
    let t0 = Instant::now();
    c.await_notice("severed", "revoked", Duration::from_secs(4))?;
    let revoke_ms = t0.elapsed().as_millis();
    let revoked = http_post(handle.http, "/offer", Some(&ok_tok), "{}")?;
    if !revoked.0.starts_with("401") {
        return Err("REVOKED token still opens the bridge".into());
    }

    // kill-switch: the epoch moves → every live peer severed
    let mut c2 = V9Client::connect(handle.http, handle.media, &two_tok)?;
    c2.roundtrip(1, r#"{"op":"hello","req":1}"#)?;
    write_reg(1, &devs).map_err(|e| e.to_string())?;
    let t1 = Instant::now();
    c2.await_notice("severed", "kill-switch", Duration::from_secs(4))?;
    let kill_ms = t1.elapsed().as_millis();

    drop(c);
    drop(c2);
    drop(handle);
    let _ = std::fs::remove_dir_all(&dir);

    println!(
        "    identity pinned+stable; 401 missing/invalid/region/expired; hello+create+list+transcript over the channel; \
         foreign auth.refresh refused; revoke mid-session → severed in {revoke_ms}ms; kill epoch → severed in {kill_ms}ms"
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
        let body = body.clone();
        rtc.sdp_api()
            .accept_answer(pending, answer)
            .map_err(|e| format!("accept_answer: {e}"))?;

        Ok(V9Client {
            rtc,
            answer: body.clone(),
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
