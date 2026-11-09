//! v4 root-link — the dial-in ws plane: roots DIAL the trunk.
//!
//! Wire law (one op on the ws control plane):
//!   1. root opens ws, sends `{"op":"root-link","token":"<link-token>"}`
//!   2. trunk opens the HMAC capsule (roots.rs): sig + v1 + `iat` +6h TTL
//!   3. `dev` claim must be a known, unrevoked device (tokens.rs — reuse)
//!   4. SINGLE-USE: the token's sha256 goes into a HashSet on success; a
//!      second dial with the same token is refused
//!   5. success → registry insert (takeover = same root id replaces the old
//!      conn) + a heartbeat thread: ws PING every ping_secs, conn reaped
//!      after 2 missed pongs or socket death
//!
//! NOTE on the listener: this plane binds its own raw TcpListener
//! (loopback, default = bridge http port + 1). tiny_http 0.12's upgrade()
//! hands out ONE fused stream with no cloneable fd, so a ping loop cannot
//! share the /offer port without a writer-thread+mutex redesign of the RTC
//! signaling loop — the dedicated listener is the honest v4 seam. Same
//! process, same ws codec, same auth laws; the /offer path is untouched.

use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::net::{SocketAddr, TcpListener, TcpStream, Shutdown};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{sync_channel, SyncSender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};

use crate::registry::{ConnMsg, Registry, RootHandle};
use crate::roots;
use crate::tokens::TokenStore;
use crate::ws::{self, WsErr, OP_CLOSE, OP_PING, OP_PONG, OP_TEXT};

pub struct RootLinkPlane {
    pub secret: Vec<u8>,
    pub ping_secs: u64,
    pub registry: Registry,
    pub tokens: Arc<TokenStore>,
    /// sha256(link-token) of every CONSUMED token — single-use law
    used: Mutex<HashSet<String>>,
}

impl RootLinkPlane {
    pub fn new(secret: Vec<u8>, registry: Registry, tokens: Arc<TokenStore>, ping_secs: u64) -> Arc<RootLinkPlane> {
        Arc::new(RootLinkPlane {
            secret,
            ping_secs: ping_secs.max(3),
            registry,
            tokens,
            used: Mutex::new(HashSet::new()),
        })
    }

    /// Bind + accept loop. One thread per conn (few roots; keeps reads honest).
    pub fn spawn(self: &Arc<Self>, listener: TcpListener) {
        let me = self.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(sock) = stream else { break };
                let me = me.clone();
                std::thread::spawn(move || me.serve_conn(sock));
            }
        });
    }

    fn refuse(writer: &mut dyn std::io::Write, err: &str) {
        let msg = serde_json::json!({ "op": "root-link.error", "err": err }).to_string();
        let _ = ws::write_frame(writer, OP_TEXT, msg.as_bytes());
        let _ = ws::write_frame(writer, OP_CLOSE, &[]);
    }

    fn serve_conn(&self, sock: TcpStream) {
        let peer: Option<SocketAddr> = sock.peer_addr().ok();
        let _ = sock.set_nodelay(true);
        let _ = sock.set_read_timeout(Some(Duration::from_secs(10)));
        let mut reader = match sock.try_clone() {
            Ok(r) => r,
            Err(_) => return,
        };
        let mut writer = match sock.try_clone() {
            Ok(w) => w,
            Err(_) => return,
        };
        let kick = match sock.try_clone() {
            Ok(k) => k,
            Err(_) => return,
        };

        // ---- 1. ws upgrade handshake (RFC 6455, blocking, 10s budget) ----
        let Some(key) = read_handshake(&mut reader) else {
            return;
        };
        let resp = format!(
            "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {}\r\n\r\n",
            ws::accept_key(&key)
        );
        use std::io::Write as _;
        if writer.write_all(resp.as_bytes()).is_err() || writer.flush().is_err() {
            return;
        }
        // loop tick: the reader must wake often enough to honor kill + pings
        let _ = sock.set_read_timeout(Some(Duration::from_secs(2)));

        // ONE writer, two users (heartbeat pings + job/result frames):
        // every write locks — ws frames must NEVER interleave mid-write.
        let writer = Arc::new(Mutex::new(writer));
        macro_rules! wsend {
            ($op:expr, $payload:expr) => {
                ws::write_frame(&mut *writer.lock().unwrap(), $op, $payload)
            };
        }

        // ---- 2. first TEXT frame = the root-link op ----
        let token = match first_frame_token(&mut reader) {
            Ok(t) => t,
            Err(e) => {
                Self::refuse(&mut *writer.lock().unwrap(), &e);
                return;
            }
        };

        // ---- 3. HMAC capsule + 6h law ----
        let lt = match roots::open_link_token(&self.secret, &token) {
            Ok(lt) => lt,
            Err(e) => {
                eprintln!("root-link: refused dial from {peer:?}: {e}");
                Self::refuse(&mut *writer.lock().unwrap(), &e);
                return;
            }
        };
        if lt.root.is_empty() || lt.root == "local" {
            Self::refuse(&mut *writer.lock().unwrap(), "root id 'local' is the trunk itself — dial with a real root id");
            return;
        }
        // ---- 4. reuse tokens.rs auth: the dev claim must be a live device ----
        if !self.tokens.knows_dev(&lt.dev) {
            eprintln!("root-link: refused dial for root '{}' — dev '{}' unknown/revoked", lt.root, lt.dev);
            Self::refuse(&mut *writer.lock().unwrap(), "device unknown or revoked");
            return;
        }
        // ---- 5. SINGLE-USE (check+insert atomic under one lock) ----
        let th = token_hash(&token);
        {
            let mut used = self.used.lock().unwrap();
            if used.contains(&th) {
                eprintln!("root-link: refused SECOND dial with a spent token (root '{}')", lt.root);
                Self::refuse(&mut *writer.lock().unwrap(), "link-token already used");
                return;
            }
            used.insert(th);
        }

        // ---- 6. register (takeover kills the old conn) + ack ----
        let (tx, rx) = sync_channel::<ConnMsg>(16);
        let kill = Arc::new(AtomicBool::new(false));
        let gen_no = self.registry.insert(RootHandle {
            root: lt.root.clone(),
            dev: lt.dev.clone(),
            gen_no: 0,
            tx,
            kill: kill.clone(),
            kick,
            since: Instant::now(),
        });
        eprintln!(
            "root-link: root '{}' LINKED from {peer:?} (dev {}, gen_no {gen_no})",
            lt.root, lt.dev
        );
        let ack = serde_json::json!({ "op": "root-link.ok", "root": lt.root, "gen_no": gen_no }).to_string();
        if wsend!(OP_TEXT, ack.as_bytes()).is_err() {
            self.registry.drop_if_current(&lt.root, gen_no);
            return;
        }

        // ---- 7. heartbeat thread: PING every ping_secs; 2 missed pongs = reap ----
        let last_pong = Arc::new(Mutex::new(Instant::now()));
        // v4c HEALTH LAW: agent-level probe failures — a `root.ping` op the
        // root's PROCESS must answer with `root.pong` (proves the agent loop,
        // not the socket). 3 consecutive misses → auto-unlink.
        let probe_fails = Arc::new(Mutex::new(0u32));
        {
            let kill = kill.clone();
            let last = last_pong.clone();
            let fails = probe_fails.clone();
            let reg = self.registry.clone();
            let root_id = lt.root.clone();
            let gen_no_c = gen_no;
            let hb_writer = writer.clone();
            let Ok(hb_kick) = sock.try_clone() else {
                return;
            };
            let ping = self.ping_secs;
            std::thread::spawn(move || loop {
                if kill.load(Ordering::SeqCst) {
                    return;
                }
                std::thread::sleep(Duration::from_secs(ping));
                if kill.load(Ordering::SeqCst) {
                    return;
                }
                let missed = last.lock().unwrap().elapsed() > Duration::from_secs(ping * 2 + 2);
                if missed {
                    eprintln!("root-link: 2 missed pongs — reaping conn");
                    let _ = hb_kick.shutdown(Shutdown::Both);
                    return;
                }
                // ---- v4c agent-level health probe: root.ping → root.pong ----
                // The root's PROCESS must answer (op-level, not a ws pong):
                // a wedged agent that answers ws pings still fails this.
                {
                    let mut f = fails.lock().unwrap();
                    *f += 1;
                }
                let probe = serde_json::json!({ "op": "root.ping", "tid": "health" }).to_string();
                if ws::write_frame(&mut *hb_writer.lock().unwrap(), OP_TEXT, probe.as_bytes()).is_err() {
                    let _ = hb_kick.shutdown(Shutdown::Both);
                    return;
                }
                let dl = Instant::now() + crate::registry::HEALTH_PROBE_WAIT;
                while Instant::now() < dl && *fails.lock().unwrap() > 0 {
                    std::thread::sleep(Duration::from_millis(25));
                }
                let f = *fails.lock().unwrap();
                if f >= crate::registry::HEALTH_FAIL_LIMIT {
                    eprintln!(
                        "root-link: root '{root_id}' failed {f} consecutive health probes — UNLINKING"
                    );
                    if reg.unlink_unhealthy(&root_id, gen_no_c) {
                        let _ = hb_kick.shutdown(Shutdown::Both);
                        return;
                    }
                }
                let _ = ws::write_frame(&mut *hb_writer.lock().unwrap(), OP_PING, b"root-link-hb");
            });
        }

        // ---- 8. reader/worker loop: jobs out, results/pongs in ----
        let mut pending: HashMap<String, SyncSender<serde_json::Value>> = HashMap::new();
        // v4c: outbound probe tid → failure count so answers pair correctly
        
        loop {
            if kill.load(Ordering::SeqCst) {
                break;
            }
            // queued branch jobs → the wire
            while let Ok(msg) = rx.try_recv() {
                match msg {
                    ConnMsg::Job { frame, tid, reply } => {
                        if wsend!(OP_TEXT, frame.as_bytes()).is_err() {
                            let _ = reply.send(serde_json::json!({"ok": false, "err": "root conn closed"}));
                            break;
                        }
                        pending.insert(tid, reply);
                    }
                    ConnMsg::Probe => continue,
                    ConnMsg::Health { reply } => {
                        // v4c pre-dispatch probe: answer TRUE immediately iff
                        // the LAST agent-level probe was answered — a wedged
                        // root (conn alive, agent silent) fails FAST here, no
                        // worker ever parks in RESULT_WAIT behind it.
                        let healthy = *probe_fails.lock().unwrap() == 0;
                        let _ = reply.send(healthy);
                    }
                }
            }
            match ws::read_frame(&mut reader) {
                Ok(f) => match f.opcode {
                    OP_PONG | OP_PING => {
                        *last_pong.lock().unwrap() = Instant::now();
                        if f.opcode == OP_PING {
                            let _ = wsend!(OP_PONG, &f.payload);
                        }
                    }
                    OP_CLOSE => break,
                    OP_TEXT => {
                        let Ok(v) = serde_json::from_slice::<serde_json::Value>(&f.payload) else {
                            continue;
                        };
                        match v.get("op").and_then(|o| o.as_str()) {
                            Some("root.pong") => {
                                *last_pong.lock().unwrap() = Instant::now();
                                *probe_fails.lock().unwrap() = 0;
                            }
                            Some("root.ping") => {
                                *last_pong.lock().unwrap() = Instant::now();
                                let pong = serde_json::json!({"op":"root.pong"}).to_string();
                                let _ = wsend!(OP_TEXT, pong.as_bytes());
                            }
                            Some("root.result") => {
                                let tid = v.get("tid").and_then(|t| t.as_str()).unwrap_or("");
                                if let Some(reply) = pending.remove(tid) {
                                    let _ = reply.send(v);
                                }
                            }
                            _ => {}
                        }
                    }
                    _ => {}
                },
                Err(WsErr::Timeout) => continue,
                Err(_) => break,
            }
        }

        // ---- 9. teardown: gen_no-checked reap (never ejects a takeover conn) ----
        kill.store(true, Ordering::SeqCst);
        let _ = writer.lock().unwrap().shutdown(Shutdown::Both);
        // v4c: a dead conn must FREE its in-flight branch workers — every
        // pending reply gets an immediate error, nobody eats the 20s wait.
        for (tid, reply) in pending.drain() {
            let _ = reply.send(serde_json::json!({
                "ok": false, "err": "root unhealthy", "tid": tid
            }));
        }
        self.registry.drop_if_current(&lt.root, gen_no);
        eprintln!("root-link: root '{}' unlinked (gen_no {gen_no})", lt.root);
    }
}

/// sha256 hex of the raw token — the single-use key.
fn token_hash(token: &str) -> String {
    let d = Sha256::digest(token.trim().as_bytes());
    d.iter().map(|b| format!("{b:02x}")).collect()
}

/// Read the client HTTP upgrade request, return Sec-WebSocket-Key.
fn read_handshake(stream: &mut dyn Read) -> Option<String> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 512];
    let deadline = Instant::now() + Duration::from_secs(10);
    while !buf.ends_with(b"\r\n\r\n") {
        if Instant::now() > deadline || buf.len() > 16 * 1024 {
            return None;
        }
        let n = stream.read(&mut chunk).ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&chunk[..n]);
    }
    let text = String::from_utf8_lossy(&buf);
    for line in text.lines() {
        if let Some((k, v)) = line.split_once(':') {
            if k.trim().eq_ignore_ascii_case("sec-websocket-key") {
                return Some(v.trim().to_string());
            }
        }
    }
    None
}

/// Wait (bounded) for the first TEXT frame and pull the link-token out of
/// `{"op":"root-link","token":"..."}`.
fn first_frame_token(stream: &mut dyn Read) -> Result<String, String> {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if Instant::now() > deadline {
            return Err("timed out waiting for the root-link op".into());
        }
        match ws::read_frame(stream) {
            Ok(f) if f.opcode == OP_TEXT => {
                let v: serde_json::Value = serde_json::from_slice(&f.payload)
                    .map_err(|_| "first frame is not JSON".to_string())?;
                if v.get("op").and_then(|o| o.as_str()) != Some("root-link") {
                    return Err("first op must be 'root-link'".into());
                }
                let t = v
                    .get("token")
                    .and_then(|t| t.as_str())
                    .filter(|t| !t.trim().is_empty())
                    .ok_or("root-link op missing token")?;
                return Ok(t.to_string());
            }
            Ok(_) => continue, // control frames before auth: tolerated
            Err(WsErr::Timeout) => continue,
            Err(WsErr::Closed) => return Err("socket closed before root-link op".into()),
            Err(WsErr::Protocol(e)) => return Err(e.into()),
        }
    }
}
