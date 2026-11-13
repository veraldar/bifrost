//! v4 root registry — {root-id → live ws conn}, trunk-owned.
//!
//! Law of this file:
//!  * every conn carries a per-root GENERATION. A re-dial (takeover) bumps
//!    the gen_no, kills the old conn (flag + TCP shutdown) and replaces the
//!    entry — newest conn wins.
//!  * a dying conn may only reap ITS OWN generation (`drop_if_current`) —
//!    a late death never ejects the conn that took over.
//!  * `send_job` = queue a job frame to the conn thread; the reply slot
//!    receives the root's `root.result`. Dead/slow root = clean Err to the
//!    branch, never a hang, never a panic.

use std::collections::HashMap;
use std::net::TcpStream;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{sync_channel, Receiver, SyncSender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub type RootId = String;

/// How long a branch turn may wait for the root's `root.result`.
pub const RESULT_WAIT: Duration = Duration::from_secs(20);

/// GAP-A fix (v4c): before RESULT_WAIT, the trunk probes the root's AGENT
/// loop — `root.ping` must be answered with `root.pong` by the root's
/// process (not the ws library). This many consecutive failures = the root
/// is unhealthy → auto-unlinked; branches get 'root unhealthy', never a
/// 20s worker eat.
pub const HEALTH_PROBE_WAIT: Duration = Duration::from_secs(3);
pub const HEALTH_FAIL_LIMIT: u32 = 3;

/// One message on a conn's inbound queue.
pub enum ConnMsg {
    /// dispatch a job frame; the reply slot receives the root's result JSON
    Job {
        frame: String,
        tid: String,
        reply: SyncSender<serde_json::Value>,
    },
    /// liveness probe from `Registry::live`
    Probe,
    /// v4c pre-dispatch health probe: the conn thread sends a `root.ping`
    /// op and reports whether the root's process answered `root.pong`
    /// within HEALTH_PROBE_WAIT (true = healthy).
    Health {
        reply: SyncSender<bool>,
    },
}

impl std::fmt::Display for ConnMsg {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ConnMsg::Job { .. } => write!(f, "Job"),
            ConnMsg::Probe => write!(f, "Probe"),
            ConnMsg::Health { .. } => write!(f, "Health"),
        }
    }
}

/// The v4 registry conn (old shape kept: bridge's takeover logging + tests).
pub struct RootConn {
    pub root: RootId,
    pub dev: String,
    pub tx: SyncSender<ConnMsg>,
    pub since: Instant,
}

/// What the conn thread carries while its jobs are in flight.
pub struct Pending {
    pub rx: Receiver<serde_json::Value>,
}

/// One branch turn awaiting its root's result.
pub fn new_pending() -> (SyncSender<serde_json::Value>, Pending) {
    let (tx, rx) = sync_channel(1);
    (tx, Pending { rx })
}

/// The live handle a dial-in plane registers (rootlink.rs). The kick socket
/// lets a takeover KILL a parked reader instantly (shutdown(Both)).
pub struct RootHandle {
    pub root: RootId,
    pub dev: String,
    /// the link-token's `roots` claim: which roots THIS root may address
    /// through the switchboard (`*` = any; `local` is always allowed)
    pub roots: Vec<String>,
    pub gen_no: u64,
    pub tx: SyncSender<ConnMsg>,
    /// set true ⇒ conn thread should exit asap
    pub kill: Arc<AtomicBool>,
    /// a dup of the conn's socket — shutdown(Both) kills the conn instantly
    pub kick: TcpStream,
    /// the conn's ONE writer (every frame locks it — frames never interleave);
    /// the switchboard writes `http` / `http.reply` frames through it directly
    pub writer: Arc<Mutex<TcpStream>>,
    pub since: Instant,
}

#[derive(Clone)]
pub struct Registry {
    inner: Arc<Mutex<HashMap<RootId, RootHandle>>>,
    gen_no: Arc<AtomicU64>,
    /// GAP-A: per-root in-flight job count (tid → root id) — the CAP law
    inflight: Arc<Mutex<HashMap<String, RootId>>>,
    /// config [root-link].max_inflight; default 1 (0 = cap OFF, unlimited)
    pub max_inflight: Arc<AtomicU64>,
    /// config [root-link].result_secs; how long a branch turn waits for its
    /// root's `root.result` (default RESULT_WAIT = 20 s)
    pub result_secs: Arc<AtomicU64>,
}

impl Registry {
    pub fn new() -> Registry {
        Registry {
            inner: Arc::new(Mutex::new(HashMap::new())),
            gen_no: Arc::new(AtomicU64::new(1)),
            inflight: Arc::new(Mutex::new(HashMap::new())),
            max_inflight: Arc::new(AtomicU64::new(1)),
            result_secs: Arc::new(AtomicU64::new(RESULT_WAIT.as_secs())),
        }
    }

    /// How long a branch turn waits for a root's result (config result_secs).
    pub fn result_wait(&self) -> Duration {
        Duration::from_secs(self.result_secs.load(Ordering::SeqCst).max(1))
    }

    /// The link-token `roots` claim of the conn registered for `root`.
    pub fn roots_of(&self, root: &str) -> Option<Vec<String>> {
        self.inner.lock().unwrap().get(root).map(|c| c.roots.clone())
    }

    /// Write one TEXT frame straight onto a root's conn (switchboard path —
    /// no 2 s reader tick). Returns the generation it was written to. The
    /// writer is cloned out under the registry lock and written OUTSIDE it, so
    /// a slow root never stalls the registry; a failed write kicks that conn.
    pub fn send_text(&self, root: &str, text: &str) -> Result<u64, String> {
        let (writer, kick, gen_no) = {
            let map = self.inner.lock().unwrap();
            match map.get(root) {
                Some(c) if !c.kill.load(Ordering::SeqCst) => {
                    let kick = c.kick.try_clone().map_err(|e| e.to_string())?;
                    (c.writer.clone(), kick, c.gen_no)
                }
                _ => return Err("root not linked".to_string()),
            }
        };
        let res = crate::ws::write_frame(&mut *writer.lock().unwrap(), crate::ws::OP_TEXT, text.as_bytes());
        if let Err(e) = res {
            let _ = kick.shutdown(std::net::Shutdown::Both);
            return Err(format!("root '{root}' write failed: {e}"));
        }
        Ok(gen_no)
    }

    /// Register a live conn. If a conn for the same root id is already up,
    /// it is KILLED and replaced (reconnect takeover — newest wins).
    /// Returns the conn's generation (for gen_no-checked reaping).
    pub fn insert(&self, mut conn: RootHandle) -> u64 {
        let mut map = self.inner.lock().unwrap();
        conn.gen_no = self.gen_no.fetch_add(1, Ordering::SeqCst);
        let gen_no = conn.gen_no;
        let root = conn.root.clone();
        if let Some(old) = map.insert(root.clone(), conn) {
            // takeover: kill the old conn so its reader loop exits
            old.kill.store(true, Ordering::SeqCst);
            let _ = old.kick.shutdown(std::net::Shutdown::Both);
            eprintln!(
                "root-link: takeover — root '{root}' gen_no {gen_no} replaces gen_no {}",
                old.gen_no
            );
        }
        gen_no
    }

    /// A conn thread exiting calls this; only removes its own generation.
    pub fn drop_if_current(&self, root: &str, gen_no: u64) {
        let mut map = self.inner.lock().unwrap();
        if map.get(root).map(|c| c.gen_no) == Some(gen_no) {
            map.remove(root);
            eprintln!("root-link: reaped root '{root}' (gen_no {gen_no} gone)");
        }
    }

    /// v4c CAP LAW: a root AT its in-flight cap gets an immediate
    /// 429-style error — NEVER a queued worker slot. Bookkeeping is
    /// atomic under one lock: reserve → send → release.
    /// Returns Ok(()) = dispatched (slot reserved; caller MUST
    /// `release_inflight` when done), Err(msg) = refused (worker free).
    pub fn send_job_capped(
        &self,
        root: &str,
        tid: &str,
        kind: &str,
        body: serde_json::Value,
        reply: SyncSender<serde_json::Value>,
    ) -> Result<(), String> {
        let frame = crate::roots::job_frame(root, tid, kind, body);
        let cap = self.max_inflight.load(Ordering::SeqCst);
        let mut map = self.inner.lock().unwrap();
        let mut flying = self.inflight.lock().unwrap();
        let live = match map.get(root) {
            Some(c) if !c.kill.load(Ordering::SeqCst) => c,
            _ => {
                // dying/gone conn: sweep the ghost so state stays honest
                map.remove(root);
                return Err("root not linked".to_string());
            }
        };
        if cap > 0 && flying.values().filter(|r| r.as_str() == root).count() >= cap as usize {
            eprintln!("root-link: root '{root}' at in-flight cap {cap} — immediate 429-style refusal");
            return Err(format!("root '{root}' busy (in-flight cap {cap} reached), retry shortly"));
        }
        let sent = live
            .tx
            .send(ConnMsg::Job {
                frame,
                tid: tid.to_string(),
                reply,
            })
            .is_ok();
        if sent {
            flying.insert(tid.to_string(), root.to_string());
        }
        sent.then_some(()).ok_or_else(|| "root not linked".to_string())
    }

    /// Release one in-flight slot (by tid) — on result OR on timeout.
    pub fn release_inflight(&self, tid: &str) {
        self.inflight.lock().unwrap().remove(tid);
    }

    /// v4c HEALTH LAW: after `HEALTH_FAIL_LIMIT` consecutive probe
    /// failures the conn is auto-unlinked. Returns true if it ejected.
    pub fn unlink_unhealthy(&self, root: &str, gen_no: u64) -> bool {
        let mut map = self.inner.lock().unwrap();
        if map.get(root).map(|c| c.gen_no) == Some(gen_no) {
            let conn = map.remove(root).expect("just checked");
            conn.kill.store(true, Ordering::SeqCst);
            let _ = conn.kick.shutdown(std::net::Shutdown::Both);
            eprintln!("root-link: root '{root}' UNHEALTHY — auto-unlinked (gen_no {gen_no})");
            true
        } else {
            false
        }
    }

    /// The generation of the conn currently registered for a root.
    pub fn gen_of(&self, root: &str) -> Option<u64> {
        self.inner.lock().unwrap().get(root).map(|c| c.gen_no)
    }

    /// v4c agent-level pre-dispatch probe: round-trip a health check
    /// through the conn thread — true iff the LAST trunk-driven agent
    /// probe was answered (no new wire probe; the heartbeat loop owns
    /// the cadence). A gen-verified re-check under the SAME lock as the
    /// channel send keeps the dying-conn race honest: a conn that is
    /// GONE is 'root not linked', never 'unhealthy'.
    pub fn probe_health(&self, root: &str) -> Result<(), String> {
        let (tx, rx) = sync_channel(1);
        {
            let mut map = self.inner.lock().unwrap();
            let conn = match map.get(root) {
                Some(c) if !c.kill.load(Ordering::SeqCst) => c,
                _ => {
                    // also sweep the ghost out so the next check is clean
                    map.remove(root);
                    return Err("root not linked".to_string());
                }
            };
            if conn.tx.send(ConnMsg::Health { reply: tx }).is_err() {
                map.remove(root);
                return Err("root not linked".to_string());
            }
        }
        match rx.recv_timeout(HEALTH_PROBE_WAIT) {
            Ok(true) => Ok(()),
            Ok(false) => Err(format!("root '{root}' unhealthy (health probe failed)")),
            Err(_) => Err(format!("root '{root}' unhealthy (health probe timed out)")),
        }
    }

    /// Legacy-shaped insert (bridge.rs selftests) — wraps RootHandle with a
    /// dummy kick socket.
    pub fn insert_conn(&self, conn: RootConn) -> u64 {
        let a = std::net::TcpListener::bind("127.0.0.1:0").expect("loopback bind");
        let c = TcpStream::connect(a.local_addr().unwrap()).expect("loopback connect");
        let _ = a.accept();
        let writer = Arc::new(Mutex::new(c.try_clone().expect("dup loopback socket")));
        self.insert(RootHandle {
            root: conn.root,
            dev: conn.dev,
            roots: vec![],
            gen_no: 0,
            tx: conn.tx,
            kill: Arc::new(AtomicBool::new(false)),
            kick: c,
            writer,
            since: conn.since,
        })
    }

    pub fn is_linked(&self, root: &str) -> bool {
        self.inner.lock().unwrap().contains_key(root)
    }

    pub fn linked(&self) -> Vec<String> {
        self.inner.lock().unwrap().keys().cloned().collect()
    }

    /// The linked roots with the moment each conn came up, sorted by id
    /// (`GET /_roots` — the hub brain learns its peers from this).
    pub fn linked_since(&self) -> Vec<(String, Instant)> {
        let mut v: Vec<(String, Instant)> = self
            .inner
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, c)| !c.kill.load(Ordering::SeqCst))
            .map(|(id, c)| (id.clone(), c.since))
            .collect();
        v.sort_by(|a, b| a.0.cmp(&b.0));
        v
    }

    /// Queue one job frame at a linked root (UNCAPPED legacy path — kept
    /// for the selftest surface; /branch dispatch uses `send_job_capped`).
    pub fn send_job(
        &self,
        root: &str,
        tid: &str,
        kind: &str,
        body: serde_json::Value,
        reply: SyncSender<serde_json::Value>,
    ) -> bool {
        let frame = crate::roots::job_frame(root, tid, kind, body);
        let map = self.inner.lock().unwrap();
        match map.get(root) {
            Some(c) if !c.kill.load(Ordering::SeqCst) => {
                c.tx
                    .send(ConnMsg::Job {
                        frame,
                        tid: tid.to_string(),
                        reply,
                    })
                    .is_ok()
            }
            _ => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dummy_kick() -> TcpStream {
        let a = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let c = TcpStream::connect(a.local_addr().unwrap()).unwrap();
        let _ = a.accept().unwrap();
        c
    }

    fn handle(root: &str, kill: Arc<AtomicBool>, tx: SyncSender<ConnMsg>) -> RootHandle {
        let kick = dummy_kick();
        let writer = Arc::new(Mutex::new(kick.try_clone().unwrap()));
        RootHandle {
            root: root.into(),
            dev: "d1".into(),
            roots: vec![],
            gen_no: 0,
            tx,
            kill,
            kick,
            writer,
            since: Instant::now(),
        }
    }

    #[test]
    fn takeover_and_generation_guard() {
        let reg = Registry::new();
        let (tx1, _r1) = sync_channel(4);
        reg.insert(handle("mac-a", Arc::new(AtomicBool::new(false)), tx1));
        assert!(reg.is_linked("mac-a"));

        // same root dials again → takeover, old conn flagged dead
        let (tx2, _r2) = sync_channel(4);
        let kill2 = Arc::new(AtomicBool::new(false));
        reg.insert(handle("mac-a", kill2.clone(), tx2));
        assert!(reg.is_linked("mac-a"));

        // OLD conn dies late → must NOT eject the new one
        reg.drop_if_current("mac-a", 1);
        assert!(reg.is_linked("mac-a"), "stale gen_no reaped a live takeover conn");
        // NEW conn dies → gone
        reg.drop_if_current("mac-a", 2);
        assert!(!reg.is_linked("mac-a"));
    }

    #[test]
    fn send_job_to_unknown_root_is_clean_refusal() {
        let reg = Registry::new();
        let (rtx, _rrx) = sync_channel(1);
        assert!(!reg.send_job("ghost", "t1", "prompt", serde_json::json!({}), rtx));
    }

    #[test]
    fn cap_law_immediate_429_never_queued() {
        let reg = Registry::new();
        reg.max_inflight.store(1, Ordering::SeqCst);
        let (tx, _rx) = sync_channel(4);
        reg.insert(handle("mac-a", Arc::new(AtomicBool::new(false)), tx));
        let (r1, p1) = new_pending();
        assert!(reg.send_job_capped("mac-a", "t1", "prompt", serde_json::json!({}), r1).is_ok());
        // second turn while t1 flies = IMMEDIATE 429-style refusal
        let (r2, _p2) = new_pending();
        let err = reg
            .send_job_capped("mac-a", "t2", "prompt", serde_json::json!({}), r2)
            .unwrap_err();
        assert!(err.contains("busy") && err.contains("cap 1"), "wrong refusal: {err}");
        // release t1 → the slot frees
        reg.release_inflight("t1");
        let (r3, _p3) = new_pending();
        assert!(reg.send_job_capped("mac-a", "t3", "prompt", serde_json::json!({}), r3).is_ok(),
            "slot did not free after release_inflight");
    }

    #[test]
    fn cap_zero_is_unlimited() {
        let reg = Registry::new();
        reg.max_inflight.store(0, Ordering::SeqCst);
        let (tx, _rx) = sync_channel(16);
        reg.insert(handle("mac-a", Arc::new(AtomicBool::new(false)), tx));
        for i in 1..=5 {
            let (r, _p) = new_pending();
            assert!(reg.send_job_capped("mac-a", &format!("t{i}"), "prompt", serde_json::json!({}), r).is_ok());
        }
    }

    #[test]
    fn health_unlink_is_gen_checked_and_kills() {
        let reg = Registry::new();
        let kill = Arc::new(AtomicBool::new(false));
        let (tx, _rx) = sync_channel(4);
        let gen_no = reg.insert(handle("mac-a", kill.clone(), tx));
        assert!(!reg.unlink_unhealthy("mac-a", gen_no + 999), "stale gen ejected a live conn");
        assert!(reg.is_linked("mac-a"));
        assert!(reg.unlink_unhealthy("mac-a", gen_no));
        assert!(!reg.is_linked("mac-a"), "unhealthy root stayed linked");
        assert!(kill.load(Ordering::SeqCst), "unlink did not kill the conn loop");
    }
}
