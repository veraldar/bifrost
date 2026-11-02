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
    pub gen_no: u64,
    pub tx: SyncSender<ConnMsg>,
    /// set true ⇒ conn thread should exit asap
    pub kill: Arc<AtomicBool>,
    /// a dup of the conn's socket — shutdown(Both) kills the conn instantly
    pub kick: TcpStream,
    pub since: Instant,
}

#[derive(Clone)]
pub struct Registry {
    inner: Arc<Mutex<HashMap<RootId, RootHandle>>>,
    gen_no: Arc<AtomicU64>,
}

impl Registry {
    pub fn new() -> Registry {
        Registry {
            inner: Arc::new(Mutex::new(HashMap::new())),
            gen_no: Arc::new(AtomicU64::new(1)),
        }
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

    /// Legacy-shaped insert (bridge.rs selftests) — wraps RootHandle with a
    /// dummy kick socket.
    pub fn insert_conn(&self, conn: RootConn) -> u64 {
        let a = std::net::TcpListener::bind("127.0.0.1:0").expect("loopback bind");
        let c = TcpStream::connect(a.local_addr().unwrap()).expect("loopback connect");
        let _ = a.accept();
        self.insert(RootHandle {
            root: conn.root,
            dev: conn.dev,
            gen_no: 0,
            tx: conn.tx,
            kill: Arc::new(AtomicBool::new(false)),
            kick: c,
            since: conn.since,
        })
    }

    pub fn is_linked(&self, root: &str) -> bool {
        self.inner.lock().unwrap().contains_key(root)
    }

    pub fn linked(&self) -> Vec<String> {
        self.inner.lock().unwrap().keys().cloned().collect()
    }

    /// Queue one job frame at a linked root. False = root not linked (or
    /// already dying) — the branch gets a clean error, never a hang.
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
        RootHandle {
            root: root.into(),
            dev: "d1".into(),
            gen_no: 0,
            tx,
            kill,
            kick: dummy_kick(),
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
}
