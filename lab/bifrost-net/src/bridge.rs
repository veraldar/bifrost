//! v0.9 bridge — the phone's DIRECT path to the tree (no tailscale).
//!
//! Token-gated WebRTC signaling + peers. Over the `app` data channel: JSON
//! request/response mirroring the PWA proxy's session surface. Over the audio
//! track: mic → Opus → (voice.commit) → speaches STT → opencode prompt →
//! reply → speaches TTS → Opus back to the phone.
//!
//! Auth (S1 seam): Bearer device token required on /offer (tokens.rs — the
//! PWA mints, the bridge verifies). The DTLS session established through that
//! exchange IS the authenticated session. Honest limit: token lifetime = the
//! session lifetime; rotation needs a reconnect. Revocation blocks new
//! signaling within ~1s.

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

use crate::opencode::OpencodeClient;
use crate::speech::{resample_to_48k, Pcm, SpeechClient};
use crate::tokens::{bearer, TokenStore};

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
}

pub struct BridgeHandle {
    pub http: SocketAddr,
    pub media: SocketAddr,
    stop: Arc<AtomicBool>,
}

impl Drop for BridgeHandle {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
    }
}

const RUN_TIMEOUT: Duration = Duration::from_secs(120);
const FRAME_SAMPLES: usize = 960; // 20ms @ 48k

struct Peer {
    rtc: Rtc,
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
    #[serde(rename = "ping")]
    Ping { t: u64 },
}

pub fn start(cfg: BridgeConfig) -> Result<BridgeHandle, String> {
    let stop = Arc::new(AtomicBool::new(false));

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
    let (admit_tx, admit_rx): (SyncSender<Rtc>, Receiver<Rtc>) = sync_channel(8);
    let job_tx = Arc::new(job_tx);

    // the address we ADVERTISE (pinned candidate or loopback) — 0.0.0.0 is a
    // bind address, never a candidate, and str0m drops STUN whose Receive
    // destination doesn't match a local candidate
    let advertise_addr = SocketAddr::new(
        cfg.candidates
            .first()
            .copied()
            .unwrap_or(IpAddr::from([127, 0, 0, 1])),
        media_addr.port(),
    );

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

    // signaling thread: POST /offer + Bearer device token
    {
        let stop = stop.clone();
        let candidates = cfg.candidates.clone();
        let tokens = tokens.clone();
        std::thread::spawn(move || {
            while !stop.load(Ordering::SeqCst) {
                match server.recv_timeout(Duration::from_millis(100)) {
                    Ok(Some(mut request)) => {
                        let url = request.url().trim_end_matches('/').to_string();
                        // CORS: the PWA (any origin) posts offers with an
                        // Authorization header — the token IS the gate, so
                        // the bridge is origin-permissive by design.
                        let preflight = request.method() == &tiny_http::Method::Options;
                        if preflight {
                            let _ = request.respond(cors(tiny_http::Response::empty(204)));
                            continue;
                        }
                        if url != "/offer" {
                            let _ = request.respond(cors(
                                tiny_http::Response::from_string("bifrost bridge"),
                            ));
                            continue;
                        }
                        let auth = request
                            .headers()
                            .iter()
                            .find(|h| h.field.equiv("Authorization"))
                            .map(|h| h.value.as_str().to_string())
                            .unwrap_or_default();
                        let Some(raw) = bearer(&auth) else {
                            let _ = request.respond(cors(
                                tiny_http::Response::from_string("device token required")
                                    .with_status_code(401),
                            ));
                            continue;
                        };
                        if !tokens.validate(raw) {
                            let _ = request.respond(cors(
                                tiny_http::Response::from_string("unknown or revoked device")
                                    .with_status_code(401),
                            ));
                            continue;
                        }
                        let mut body = String::new();
                        let _ = request.as_reader().read_to_string(&mut body);
                        // Chrome is trickle-only: the offer SDP carries NO
                        // candidates; they arrive in the same POST as a
                        // `candidates` array (gathered client-side).
                        let parsed: serde_json::Value = match serde_json::from_str(&body) {
                            Ok(v) => v,
                            Err(e) => {
                                let _ = request.respond(cors(
                                    tiny_http::Response::from_string(format!("bad offer: {e}"))
                                        .with_status_code(400),
                                ));
                                continue;
                            }
                        };
                        let Some(sdp_str) = parsed.get("sdp").and_then(|s| s.as_str()) else {
                            let _ = request.respond(cors(
                                tiny_http::Response::from_string("offer missing sdp")
                                    .with_status_code(400),
                            ));
                            continue;
                        };
                        let offer = match SdpOffer::from_sdp_string(sdp_str) {
                            Ok(o) => o,
                            Err(e) => {
                                let _ = request.respond(cors(
                                    tiny_http::Response::from_string(format!("bad sdp: {e}"))
                                        .with_status_code(400),
                                ));
                                continue;
                            }
                        };
                        let trickle: Vec<String> = parsed
                            .get("candidates")
                            .and_then(|c| c.as_array())
                            .map(|a| {
                                a.iter()
                                    .filter_map(|c| c.as_str().map(String::from))
                                    .collect()
                            })
                            .unwrap_or_default();
                        let mut rtc = Rtc::new(Instant::now());
                        // advertise a REAL ip: first pinned candidate, else
                        // loopback (0.0.0.0 is not a valid ICE candidate —
                        // this panic'd the signaling thread once already)
                        let advertise = candidates
                            .first()
                            .copied()
                            .unwrap_or(IpAddr::from([127, 0, 0, 1]));
                        let ca = SocketAddr::new(advertise, media_addr.port());
                        if let Ok(host) = Candidate::host(ca, "udp") {
                            let _ = rtc.add_local_candidate(host);
                        }
                        for ip in &candidates {
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
                                let _ = request.respond(cors(
                                    tiny_http::Response::from_string(format!(
                                        "offer rejected: {e}"
                                    ))
                                    .with_status_code(400),
                                ));
                                continue;
                            }
                        };
                        for c in &trickle {
                            match str0m::Candidate::from_sdp_string(c) {
                                Ok(cand) => rtc.add_remote_candidate(cand),
                                Err(_) => {} // malformed trickle lines are ignored
                            }
                        }
                        let body = serde_json::to_string(&answer).expect("answer json");
                        if admit_tx.send(rtc).is_err() {
                            break;
                        }
                        let _ = request.respond(cors(
                            tiny_http::Response::from_string(body).with_header(
                                tiny_http::Header::from_bytes(
                                    &b"Content-Type"[..],
                                    &b"application/json"[..],
                                )
                                .unwrap(),
                            ),
                        ));
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
        let out_rx = Arc::new(Mutex::new(out_rx));
        std::thread::spawn(move || {
            let mut peers: HashMap<usize, Peer> = HashMap::new();
            let mut next_id = 0usize;
            let mut buf = vec![0u8; 4000];

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
                while let Ok(rtc) = admit_rx.try_recv() {
                    let id = next_id;
                    next_id += 1;
                    peers.insert(
                        id,
                        Peer {
                            rtc,
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

                std::thread::sleep(Duration::from_millis(2));
            }
        });
    }

    Ok(BridgeHandle {
        http: http_addr,
        media: media_addr,
        stop,
    })
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
            oc.prompt(&sid, &text)?;
            // run lifecycle: notify the client when the assistant replies
            let oc2 = oc.clone();
            let out_tx2 = out_tx.clone();
            let sid2 = sid.clone();
            std::thread::spawn(move || {
                let _ = out_tx2.send(wait_run_done(&oc2, client, &sid2));
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
        ClientOp::VoiceCommit { .. } => unreachable!("routed as Job::Voice"),
    }
}

/// Poll the transcript until an assistant message lands (count grows).
fn wait_run_done(oc: &OpencodeClient, client: usize, sid: &str) -> Outcome {
    let before = oc.transcript(sid).map(|m| assistant_count(&m)).unwrap_or(0);
    let start = Instant::now();
    loop {
        if start.elapsed() > RUN_TIMEOUT {
            return Outcome::Notice {
                client,
                json: r#"{"op":"run.done","timeout":true}"#.into(),
            };
        }
        std::thread::sleep(Duration::from_millis(1200));
        if let Ok(msgs) = oc.transcript(sid) {
            if assistant_count(&msgs) > before {
                return Outcome::Notice {
                    client,
                    json: serde_json::json!({"op":"run.done","id":sid}).to_string(),
                };
            }
        }
    }
}

fn assistant_count(msgs: &[crate::opencode::MessageInfo]) -> usize {
    msgs.iter().filter(|m| m.role() == Some("assistant")).count()
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
    const TIMEOUT: Duration = Duration::from_secs(15);

    // temp tokens file: one device, raw token known to the test
    let raw = format!("bfnt-{}", uuid_like());
    let hash = crate::tokens::hash_token(&raw);
    let dir = std::env::temp_dir().join(format!("bfn-v9-{}", uuid_like()));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let tokens_path = dir.join("devices.json");
    let tokens_json = serde_json::json!({
        "devices": [{"id": "dev_e2e", "name": "e2e", "token_hash": hash, "created": "now", "revoked": false}]
    });
    std::fs::write(&tokens_path, tokens_json.to_string()).map_err(|e| e.to_string())?;

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
    })
    .map_err(|e| e.to_string())?;

    // auth negatives first (no token, wrong token)
    let no_auth = http_post(handle.http, "/offer", None, "{}")?;
    if !no_auth.0.starts_with("401") {
        return Err(format!("bridge accepted an offer WITHOUT a token: {}", no_auth.0));
    }
    let bad_auth = http_post(handle.http, "/offer", Some("bfnt-not-a-real-token-value"), "{}")?;
    if !bad_auth.0.starts_with("401") {
        return Err(format!("bridge accepted an offer with a WRONG token: {}", bad_auth.0));
    }

    // the real client: browser-shaped peer with the `app` data channel
    let mut c = V9Client::connect(handle.http, handle.media, &raw)?;

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

    // revocation lands within the store's 1s refresh: revoke -> new offer 401
    let tokens_json = serde_json::json!({
        "devices": [{"id": "dev_e2e", "name": "e2e", "token_hash": hash, "created": "now", "revoked": true}]
    });
    std::fs::write(&tokens_path, tokens_json.to_string()).map_err(|e| e.to_string())?;
    std::thread::sleep(Duration::from_millis(1300));
    let revoked = http_post(handle.http, "/offer", Some(&raw), "{}")?;
    if !revoked.0.starts_with("401") {
        return Err("REVOKED token still opens the bridge".into());
    }

    drop(c);
    drop(handle);
    let _ = std::fs::remove_dir_all(&dir);

    println!("    401 without/with wrong token; hello+session.create+list+transcript over the channel; revoked token 401; opencode session {sid}");
    Ok(())
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

fn cors<T: std::io::Read>(r: tiny_http::Response<T>) -> tiny_http::Response<T> {
    use tiny_http::Header;
    r.with_header(
        Header::from_bytes(&b"Access-Control-Allow-Origin"[..], &b"*"[..]).unwrap(),
    )
    .with_header(
        Header::from_bytes(
            &b"Access-Control-Allow-Headers"[..],
            &b"Authorization, Content-Type"[..],
        )
        .unwrap(),
    )
    .with_header(
        Header::from_bytes(&b"Access-Control-Allow-Methods"[..], &b"POST, OPTIONS"[..]).unwrap(),
    )
}
