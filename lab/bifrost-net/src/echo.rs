//! M0 WebRTC echo test: two str0m peers connect over real loopback UDP
//! (full ICE + DTLS + SRTP), peer L sends audio frames, peer R echoes each
//! frame back; L verifies byte-exact round-trips.
//!
//! This is the seam an SFU/access-point needs: receive valid RTP media,
//! decrypt, re-emit valid SRTP toward another peer.
//!
//! Run-loop pattern adapted from str0m's own test harness (MIT, str0m tests/common.rs).

use std::net::{SocketAddr, UdpSocket};
use std::time::{Duration, Instant};

use str0m::format::Codec;
use str0m::media::{Direction, MediaData, MediaKind, MediaTime, Pt};
use str0m::net::{Protocol, Receive};
use str0m::{Candidate, Event, Input, Output, Rtc};

const ECHO_TIMEOUT: Duration = Duration::from_secs(10);
const FRAMES_TO_SEND: usize = 60;
const FRAMES_TO_VERIFY: usize = 40;

fn marker_frame(seq: u32) -> Vec<u8> {
    let mut f = b"BFNE".to_vec();
    f.extend_from_slice(&seq.to_be_bytes());
    // Opus frames are opaque to str0m; pad to a realistic 80-byte frame.
    f.extend(std::iter::repeat_n(0xA7u8, 80 - f.len()));
    f
}

struct Peer {
    rtc: Rtc,
    sock: UdpSocket,
    buf: Vec<u8>,
}

impl Peer {
    fn new(sock: UdpSocket) -> Peer {
        let addr = sock.local_addr().expect("local addr");
        sock.set_nonblocking(true).expect("nonblocking");
        let mut rtc = Rtc::new(Instant::now());
        let candidate = Candidate::host(addr, "udp").expect("host candidate");
        rtc.add_local_candidate(candidate).expect("add candidate");
        Peer {
            rtc,
            sock,
            buf: vec![0u8; 2000],
        }
    }

    fn addr(&self) -> SocketAddr {
        self.sock.local_addr().expect("local addr")
    }

    /// Drain the socket into the RTC and advance it; returns emitted events.
    fn pump(&mut self, now: Instant) -> Vec<Event> {
        let mut events = vec![];
        loop {
            match self.sock.recv_from(&mut self.buf) {
                Ok((n, source)) => {
                    let input = Input::Receive(
                        now,
                        Receive {
                            proto: Protocol::Udp,
                            source,
                            destination: self.addr(),
                            contents: (&self.buf[..n]).try_into().expect("contents"),
                        },
                    );
                    if self.rtc.accepts(&input) {
                        self.rtc.handle_input(input).expect("rtc input");
                    }
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
                Err(e) => panic!("udp recv: {e}"),
            }
        }
        self.rtc.handle_input(Input::Timeout(now)).expect("timeout");
        loop {
            match self.rtc.poll_output().expect("poll_output") {
                Output::Timeout(_) => break,
                Output::Transmit(t) => {
                    self.sock
                        .send_to(&t.contents, t.destination)
                        .expect("udp send");
                }
                Output::Event(e) => events.push(e),
            }
        }
        events
    }
}

pub fn run() -> Result<(), String> {
    str0m::crypto::from_feature_flags().install_process_default();

    let sock_l = UdpSocket::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let sock_r = UdpSocket::bind("127.0.0.1:0").map_err(|e| e.to_string())?;

    let mut l = Peer::new(sock_l);
    let mut r = Peer::new(sock_r);
    let _ = (l.addr(), r.addr()); // candidates were added inside Peer::new

    // L offers a bidirectional audio track; R accepts.
    let mut change = l.rtc.sdp_api();
    let mid = change.add_media(MediaKind::Audio, Direction::SendRecv, None, None, None);
    let (offer, pending) = change.apply().ok_or("offer: apply returned None")?;
    let answer = r
        .rtc
        .sdp_api()
        .accept_offer(offer)
        .map_err(|e| format!("answer: {e}"))?;
    l.rtc
        .sdp_api()
        .accept_answer(pending, answer)
        .map_err(|e| format!("accept answer: {e}"))?;

    let pt: Pt = {
        let cfg = l.rtc.codec_config().clone();
        cfg.find(|p| p.spec().codec == Codec::Opus)
            .expect("opus negotiated")
            .pt()
    };

    let deadline = Instant::now() + ECHO_TIMEOUT;
    let start = Instant::now();
    let mut sent = 0usize;
    let mut verified = 0usize;
    let mut next_send = start + Duration::from_millis(50);
    let mut echo_latency: Vec<Duration> = vec![];

    loop {
        let now = Instant::now();
        if now > deadline {
            return Err(format!(
                "echo: deadline hit with {verified}/{FRAMES_TO_VERIFY} frames verified"
            ));
        }
        let l_events = l.pump(now);
        let r_events = r.pump(now);

        // L: send paced audio frames once connected.
        if l.rtc.is_connected()
            && r.rtc.is_connected()
            && sent < FRAMES_TO_SEND
            && now >= next_send
        {
            let frame = marker_frame(sent as u32);
            let wallclock = now;
            let rtp_time = MediaTime::from(now.duration_since(start));
            l.rtc
                .writer(mid)
                .ok_or("L: writer not open")?
                .write(pt, wallclock, rtp_time, frame)
                .map_err(|e| format!("write: {e}"))?;
            sent += 1;
            next_send += Duration::from_millis(20);
        }

        // R: echo every received frame back on the same track.
        for e in &r_events {
            if let Event::MediaData(d) = e {
                echo_back(&mut r, d, pt)?;
            }
        }

        // L: verify echoed frames byte-for-byte.
        for e in &l_events {
            if let Event::MediaData(d) = e {
                let payload = &d.data[..];
                if payload.starts_with(b"BFNE") {
                    let seq = u32::from_be_bytes(payload[4..8].try_into().unwrap());
                    let expected = marker_frame(seq);
                    if payload == &expected[..] {
                        verified += 1;
                        echo_latency.push(now - start);
                    } else {
                        return Err(format!("echo: frame {seq} corrupted in relay"));
                    }
                }
            }
        }

        if verified >= FRAMES_TO_VERIFY && sent >= FRAMES_TO_SEND {
            break;
        }
        std::thread::sleep(Duration::from_millis(2));
    }

    let avg = echo_latency.iter().sum::<Duration>() / echo_latency.len() as u32;
    println!(
        "  [echo] WebRTC ICE+DTLS+SRTP up; {verified} frames echoed byte-exact (avg relay time {avg:?}): OK"
    );
    Ok(())
}

fn echo_back(r: &mut Peer, d: &MediaData, pt: Pt) -> Result<(), String> {
    if let Some(writer) = r.rtc.writer(d.mid) {
        writer
            .write(pt, d.network_time, d.time, d.data.clone())
            .map_err(|e| format!("echo write: {e}"))?;
    }
    Ok(())
}
