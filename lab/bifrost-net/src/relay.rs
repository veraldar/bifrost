//! S3: WebRTC relay service (str0m) — the media half of the access point.
//!
//! One shared UDP media socket, N peers multiplexed via `rtc.accepts()`,
//! media from each peer forwarded to all others (SFU-lite). Signaling is a
//! minimal HTTP endpoint: POST /offer (SdpOffer JSON) -> SdpAnswer JSON.
//! Run-loop and propagate pattern adapted from str0m's own chat example (MIT).
//!
//! Config-pinned candidates only — the livekit.yaml scar: auto-detect lies.

use std::collections::HashMap;
use std::io::Read;
use std::net::{IpAddr, SocketAddr, TcpListener, TcpStream, UdpSocket};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{sync_channel, Receiver, SyncSender};
use std::sync::Arc;
use std::time::{Duration, Instant};

use str0m::change::{SdpAnswer, SdpOffer};
use str0m::format::Codec;
use str0m::media::{MediaData, MediaKind, Mid, Pt};
use str0m::net::{Protocol, Receive};
use str0m::{Candidate, Event, Input, Output, Rtc};

pub struct RelayConfig {
    pub signaling: SocketAddr,
    pub media: SocketAddr,
    /// IPs to advertise as ICE host candidates (pinned, never auto-detected)
    pub candidates: Vec<IpAddr>,
}

pub struct RelayHandle {
    pub signaling: SocketAddr,
    pub media: SocketAddr,
    stop: Arc<AtomicBool>,
}

impl Drop for RelayHandle {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
    }
}

struct RelayClient {
    rtc: Rtc,
    /// this client's own audio mid (captured from MediaAdded)
    mid: Option<Mid>,
}

/// Start the relay: signaling thread + media loop thread. The returned
/// addresses are the ones actually bound (config may use :0).
pub fn start(cfg: RelayConfig) -> Result<RelayHandle, String> {
    let stop = Arc::new(AtomicBool::new(false));

    let media_sock = UdpSocket::bind(cfg.media).map_err(|e| format!("relay media bind: {e}"))?;
    media_sock.set_nonblocking(true).map_err(|e| e.to_string())?;
    let media_addr = media_sock.local_addr().map_err(|e| e.to_string())?;

    let listener =
        TcpListener::bind(cfg.signaling).map_err(|e| format!("relay signaling bind: {e}"))?;
    let sig_addr = listener.local_addr().map_err(|e| e.to_string())?;
    let server = tiny_http::Server::from_listener(listener, None)
        .map_err(|e| format!("relay signaling server: {e}"))?;

    let (new_rtc_tx, new_rtc_rx): (SyncSender<Rtc>, Receiver<Rtc>) = sync_channel(8);

    // advertised address (pinned candidate or loopback) — 0.0.0.0 is never a
    // valid ICE candidate and str0m drops STUN with mismatched destinations
    let advertise_addr = SocketAddr::new(
        cfg.candidates
            .first()
            .copied()
            .unwrap_or(IpAddr::from([127, 0, 0, 1])),
        media_addr.port(),
    );

    // signaling thread: POST /offer -> build Rtc -> answer -> hand to media loop
    {
        let stop = stop.clone();
        let candidates = cfg.candidates.clone();
        std::thread::spawn(move || {
            while !stop.load(Ordering::SeqCst) {
                match server.recv_timeout(Duration::from_millis(100)) {
                    Ok(Some(mut request)) => {
                        let url = request.url().trim_end_matches('/').to_string();
                        if url != "/offer" {
                            let _ = request
                                .respond(tiny_http::Response::from_string("POST /offer"));
                            continue;
                        }
                        let mut body = String::new();
                        let _ = request.as_reader().read_to_string(&mut body);
                        let offer: SdpOffer = match serde_json::from_str(&body) {
                            Ok(o) => o,
                            Err(e) => {
                                let _ = request.respond(
                                    tiny_http::Response::from_string(format!("bad offer: {e}"))
                                        .with_status_code(400),
                                );
                                continue;
                            }
                        };
                        let mut rtc = Rtc::new(Instant::now());
                        let host =
                            Candidate::host(media_addr, "udp").expect("media candidate");
                        let _ = rtc.add_local_candidate(host);
                        for ip in &candidates {
                            let ca = SocketAddr::new(*ip, media_addr.port());
                            if let Ok(c) = Candidate::host(ca, "udp") {
                                let _ = rtc.add_local_candidate(c);
                            }
                        }
                        let answer = match rtc.sdp_api().accept_offer(offer) {
                            Ok(a) => a,
                            Err(e) => {
                                let _ = request.respond(
                                    tiny_http::Response::from_string(format!(
                                        "offer rejected: {e}"
                                    ))
                                    .with_status_code(400),
                                );
                                continue;
                            }
                        };
                        let body = serde_json::to_string(&answer).expect("answer json");
                        if new_rtc_tx.send(rtc).is_err() {
                            break;
                        }
                        let _ = request.respond(
                            tiny_http::Response::from_string(body).with_header(
                                tiny_http::Header::from_bytes(
                                    &b"Content-Type"[..],
                                    &b"application/json"[..],
                                )
                                .unwrap(),
                            ),
                        );
                    }
                    Ok(None) => {}
                    Err(_) => break,
                }
            }
        });
    }

    // media loop thread: everything WebRTC happens here
    {
        let stop = stop.clone();
        std::thread::spawn(move || {
            let mut clients: HashMap<usize, RelayClient> = HashMap::new();
            let mut next_id = 0usize;
            let mut buf = vec![0u8; 4000];

            loop {
                if stop.load(Ordering::SeqCst) {
                    return;
                }
                let now = Instant::now();

                while let Ok(rtc) = new_rtc_rx.try_recv() {
                    let id = next_id;
                    next_id += 1;
                    clients.insert(id, RelayClient { rtc, mid: None });
                }

                // drain the socket ONCE, demuxing each datagram to whichever
                // client accepts it (chat.rs semantics — a per-client drain
                // discards the other peers' packets)
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
                            if let Some((_, client)) =
                                clients.iter_mut().find(|(_, c)| c.rtc.accepts(&input))
                            {
                                let _ = client.rtc.handle_input(input);
                            }
                        }
                        Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
                        Err(_) => break,
                    }
                }

                // per client: timers + outputs
                let mut media_events: Vec<(usize, MediaData)> = vec![];
                let mut timeout = now + Duration::from_millis(20);
                for (id, client) in clients.iter_mut() {
                    let _ = client.rtc.handle_input(Input::Timeout(now));
                    loop {
                        match client.rtc.poll_output() {
                            Ok(Output::Transmit(t)) => {
                                let _ = media_sock.send_to(&t.contents, t.destination);
                            }
                            Ok(Output::Timeout(t)) => {
                                timeout = timeout.min(t);
                                break;
                            }
                            Ok(Output::Event(e)) => match e {
                                Event::MediaAdded(ma) => {
                                    client.mid = Some(ma.mid);
                                }
                                Event::MediaData(d) => media_events.push((*id, d)),
                                _ => {}
                            },
                            Err(_) => break,
                        }
                    }
                }

                // SFU-lite: forward every peer's media to all OTHER peers
                for (origin, d) in &media_events {
                    for (id, client) in clients.iter_mut() {
                        if id == origin {
                            continue; // never echo back to the sender
                        }
                        if let Some(mid) = client.mid {
                            if let Some(writer) = client.rtc.writer(mid) {
                                let _ = writer.write(forward_pt(&d), d.network_time, d.time, d.data.clone());
                            }
                        }
                    }
                }

                let until = timeout.min(Instant::now() + Duration::from_millis(20));
                if until > Instant::now() {
                    std::thread::sleep(Duration::from_millis(2));
                }
            }
        });
    }

    Ok(RelayHandle {
        signaling: sig_addr,
        media: media_addr,
        stop,
    })
}

fn forward_pt(d: &MediaData) -> Pt {
    d.params.pt()
}

// ---------------------------------------------------------------------------
// S3 selftest: two clients through the REAL signaling HTTP path, cross-relay.
// ---------------------------------------------------------------------------

fn http_post_json(addr: SocketAddr, path: &str, body: &str) -> Result<String, String> {
    let mut s = TcpStream::connect(addr).map_err(|e| format!("connect signaling: {e}"))?;
    let req = format!(
        "POST {path} HTTP/1.1\r\nHost: relay\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    use std::io::Write;
    s.write_all(req.as_bytes()).map_err(|e| e.to_string())?;
    let mut raw = String::new();
    s.read_to_string(&mut raw).map_err(|e| e.to_string())?;
    raw.split("\r\n\r\n")
        .nth(1)
        .map(String::from)
        .ok_or_else(|| "no http body".into())
}

struct TestClient {
    rtc: Rtc,
    sock: UdpSocket,
    buf: Vec<u8>,
    mid: Option<Mid>,
    pt: Option<Pt>,
    born: Instant,
}

impl TestClient {
    fn connect(_name: &str, relay_sig: SocketAddr, _relay_media: SocketAddr) -> Result<TestClient, String> {
        let sock = UdpSocket::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
        sock.set_nonblocking(true).map_err(|e| e.to_string())?;
        let local = sock.local_addr().map_err(|e| e.to_string())?;

        let mut rtc = Rtc::new(Instant::now());
        let cand = Candidate::host(local, "udp").map_err(|e| e.to_string())?;
        rtc.add_local_candidate(cand).ok_or("candidate rejected")?;

        let pt: Pt = {
            let cfg = rtc.codec_config().clone();
            cfg.find(|p| p.spec().codec == Codec::Opus)
                .ok_or("no opus in codec config")?
                .pt()
        };
        let mut change = rtc.sdp_api();
        let mid = change.add_media(MediaKind::Audio, str0m::media::Direction::SendRecv, None, None, None);
        let (offer, pending) = change.apply().ok_or("offer apply failed")?;
        let offer_json = serde_json::to_string(&offer).map_err(|e| e.to_string())?;
        let answer_json = http_post_json(relay_sig, "/offer", &offer_json)?;
        let answer: SdpAnswer =
            serde_json::from_str(&answer_json).map_err(|e| format!("bad answer: {e}"))?;
        rtc.sdp_api()
            .accept_answer(pending, answer)
            .map_err(|e| format!("accept_answer: {e}"))?;


        Ok(TestClient {
            rtc,
            sock,
            buf: vec![0u8; 4000],
            mid: Some(mid),
            pt: Some(pt),
            born: Instant::now(),
        })
    }

    fn pump(&mut self) -> Vec<Event> {
        let mut events = vec![];
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
                Ok(Output::Event(e)) => events.push(e),
                Err(_) => break,
            }
        }
        events
    }

    fn is_connected(&self) -> bool {
        self.rtc.is_connected()
    }

    fn send_frame(&mut self, tag: &[u8; 3], seq: u32) -> Result<Vec<u8>, String> {
        let mut frame = tag.to_vec();
        frame.extend_from_slice(&seq.to_be_bytes());
        frame.extend(std::iter::repeat_n(0x5Au8, 80 - frame.len()));
        let pt = self.pt.expect("client pt");
        let wallclock = Instant::now();
        let rtp_time = str0m::media::MediaTime::from(
            wallclock.duration_since(self.born).max(Duration::from_millis(1)),
        );
        let mid = self.mid.expect("client mid");
        self.rtc
            .writer(mid)
            .ok_or("writer closed")?
            .write(pt, wallclock, rtp_time, frame.clone())
            .map_err(|e| format!("client write: {e}"))?;
        Ok(frame)
    }
}

pub fn service_test() -> Result<(), String> {
    const N: usize = 40;
    const VERIFY: usize = 25;
    const TIMEOUT: Duration = Duration::from_secs(12);

    let handle = start(RelayConfig {
        signaling: "127.0.0.1:0".parse().unwrap(),
        media: "127.0.0.1:0".parse().unwrap(),
        candidates: vec![IpAddr::from([127, 0, 0, 1])],
    })
    .map_err(|e| e.to_string())?;

    let mut a = TestClient::connect("A", handle.signaling, handle.media)?;
    let mut b = TestClient::connect("B", handle.signaling, handle.media)?;

    let deadline = Instant::now() + TIMEOUT;
    let mut a_sent = 0;
    let mut b_sent = 0;
    let mut a_verified = 0;
    let mut b_verified = 0;
    let mut next_send = Instant::now() + Duration::from_millis(50);
    let mut a_trail: Vec<String> = vec![];
    let mut b_trail: Vec<String> = vec![];

    let expect_for = |tag: &[u8; 3], seq: u32| -> Vec<u8> {
        let mut f = tag.to_vec();
        f.extend_from_slice(&seq.to_be_bytes());
        f.extend(std::iter::repeat_n(0x5Au8, 80 - f.len()));
        f
    };

    while Instant::now() < deadline {
        let a_events = a.pump();
        let b_events = b.pump();
        for e in &a_events {
            if let Event::IceConnectionStateChange(v) = e {
                a_trail.push(format!("{v:?}"));
            }
        }
        for e in &b_events {
            if let Event::IceConnectionStateChange(v) = e {
                b_trail.push(format!("{v:?}"));
            }
        }

        for e in &a_events {
            if let Event::MediaData(d) = e {
                if a.pt.is_none() {
                    a.pt = Some(d.pt);
                }
                let seq = d
                    .data
                    .get(3..7)
                    .map(|s| u32::from_be_bytes(s.try_into().unwrap()));
                if d.data.starts_with(b"BTB") {
                    if let Some(seq) = seq {
                        if d.data[..] == expect_for(b"BTB", seq)[..] {
                            b_verified += 1;
                        } else {
                            return Err(format!("relay corrupted B frame {seq}"));
                        }
                    }
                }
            }
        }
        for e in &b_events {
            if let Event::MediaData(d) = e {
                if b.pt.is_none() {
                    b.pt = Some(d.pt);
                }
                let seq = d
                    .data
                    .get(3..7)
                    .map(|s| u32::from_be_bytes(s.try_into().unwrap()));
                if d.data.starts_with(b"BTA") {
                    if let Some(seq) = seq {
                        if d.data[..] == expect_for(b"BTA", seq)[..] {
                            a_verified += 1;
                        } else {
                            return Err(format!("relay corrupted A frame {seq}"));
                        }
                    }
                }
            }
        }

        if a.is_connected() && b.is_connected() && Instant::now() >= next_send {
            if a_sent < N {
                a.send_frame(b"BTA", a_sent as u32).map_err(|e| e.to_string())?;
                a_sent += 1;
            }
            if b_sent < N {
                b.send_frame(b"BTB", b_sent as u32).map_err(|e| e.to_string())?;
                b_sent += 1;
            }
            next_send += Duration::from_millis(20);
        }

        if a_verified >= VERIFY && b_verified >= VERIFY && a_sent >= N && b_sent >= N {
            println!("    {a_verified} A-frames relayed to B, {b_verified} B-frames relayed to A, byte-exact");
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(2));
    }

    Err(format!(
        "deadline: a_sent={a_sent} b_sent={b_sent} a_verified={a_verified} b_verified={b_verified} \
         a_conn={} b_conn={} a_trail={a_trail:?} b_trail={b_trail:?}",
        a.is_connected(),
        b.is_connected()
    ))
}
