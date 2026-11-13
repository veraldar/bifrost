//! The switchboard — brain-to-brain HTTP over the root-link plane.
//!
//! Every root dials the trunk (rootlink.rs); none accepts inbound. To let the
//! brains call each other anyway (yggdrasil's peer protocol: POST /session,
//! POST /session/:id/message, GET /root, POST /tree/report …), one HTTP
//! exchange rides two ws ops on the links that already exist:
//!
//!   {op:"http", id, to, method, path, headers:{content-type?, x-ygg-peer?}, body_b64}
//!   {op:"http.reply", id, status, headers, body_b64}
//!
//! Routing (all on the trunk):
//!   * `http` from link X, `to` = linked root Y → forwarded to Y as
//!     {op:"http", id:<trunk id>, from:X, …}; Y's `http.reply` for that id is
//!     routed back to X under X's own id. Pending map; 120 s → 504.
//!   * `to` = `local` → the trunk performs it against the box's own brain
//!     (the bridge's opencode_url) and answers X.
//!   * the hub brain's side: `ANY /_root/<id>/<rest>` on the bridge's http
//!     listener (loopback only) → `http` to root <id> with from = `local`.
//!
//! LAW: X may address Y only if X's link-token `roots` claim names Y or `*`
//! (`local` — the trunk's own brain — is always allowed, as on /branch).
//! Only `content-type` and `x-ygg-peer` cross, both ways; nothing else from
//! the outside. A reply is accepted only from the root the request went to.

use std::collections::HashMap;
use std::io::Read;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{sync_channel, SyncSender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::Engine;
use serde_json::{json, Map, Value};

use crate::registry::Registry;

/// How long one exchange may wait for its reply before the caller gets 504.
pub const HTTP_WAIT: Duration = Duration::from_secs(120);
/// Largest body carried either way (raw bytes; base64 on the wire).
pub const MAX_BODY: usize = 4 << 20;
/// Calls the linked roots may have running against the local brain at once.
const MAX_LOCAL: usize = 32;
/// The only headers that cross the switchboard (lowercase).
pub const PASS_HEADERS: [&str; 2] = ["content-type", "x-ygg-peer"];
const METHODS: [&str; 5] = ["GET", "POST", "PUT", "PATCH", "DELETE"];

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;

/// One answered exchange.
#[derive(Debug, Clone)]
pub struct HttpReply {
    pub status: u16,
    pub headers: Map<String, Value>,
    pub body: Vec<u8>,
}

impl HttpReply {
    /// A JSON error the caller's brain can read (`{"error": …}`).
    pub fn error(status: u16, msg: &str) -> HttpReply {
        let mut headers = Map::new();
        headers.insert("content-type".into(), json!("application/json"));
        HttpReply { status, headers, body: json!({ "error": msg }).to_string().into_bytes() }
    }

    fn from_frame(v: &Value) -> HttpReply {
        let status = v.get("status").and_then(|s| s.as_u64()).filter(|s| (100..=599).contains(s)).unwrap_or(502) as u16;
        let body = v
            .get("body_b64")
            .and_then(|b| b.as_str())
            .and_then(|b| B64.decode(b).ok())
            .unwrap_or_default();
        HttpReply { status, headers: pass_headers(v.get("headers")), body }
    }

    fn frame(&self, id: &Value) -> String {
        json!({ "op": "http.reply", "id": id, "status": self.status,
                "headers": self.headers, "body_b64": B64.encode(&self.body) })
        .to_string()
    }
}

/// Keep only the pass-through headers (lowercased names, single-line string values).
pub fn pass_headers(h: Option<&Value>) -> Map<String, Value> {
    let mut out = Map::new();
    if let Some(Value::Object(m)) = h {
        for (k, v) in m {
            let k = k.to_ascii_lowercase();
            if !PASS_HEADERS.contains(&k.as_str()) {
                continue;
            }
            if let Some(s) = v.as_str().filter(|s| s.len() < 1024 && !s.chars().any(|c| c.is_control())) {
                out.insert(k, json!(s));
            }
        }
    }
    out
}

/// LAW: X may address Y iff Y is `local` or X's link-token roots claim
/// names Y or `*`.
pub fn link_may_address(claim: &[String], to: &str) -> bool {
    to == "local" || claim.iter().any(|r| r == "*" || r == to)
}

fn valid_root_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
}

/// The request half of a frame, validated.
#[derive(Debug, Clone)]
pub struct HttpReq {
    pub method: String,
    pub path: String,
    pub headers: Map<String, Value>,
    pub body: Vec<u8>,
}

impl HttpReq {
    pub fn new(method: &str, path: &str, headers: Map<String, Value>, body: Vec<u8>) -> Result<HttpReq, String> {
        let method = method.to_ascii_uppercase();
        if !METHODS.contains(&method.as_str()) {
            return Err(format!("method '{method}' is not switched (GET POST PUT PATCH DELETE)"));
        }
        // the path is appended to a base URL: it MUST start with '/' (no
        // `@host` userinfo trick) and carry no whitespace/control bytes
        if !path.starts_with('/') || path.len() > 8192 || path.bytes().any(|b| b <= b' ' || b == 0x7f) {
            return Err("path must start with '/' and carry no whitespace".into());
        }
        if body.len() > MAX_BODY {
            return Err(format!("body over {MAX_BODY} bytes"));
        }
        Ok(HttpReq { method, path: path.to_string(), headers: pass_headers(Some(&Value::Object(headers))), body })
    }

    fn from_frame(v: &Value) -> Result<HttpReq, String> {
        let method = v.get("method").and_then(|m| m.as_str()).unwrap_or("GET");
        let path = v.get("path").and_then(|p| p.as_str()).ok_or("http frame without path")?;
        let body = match v.get("body_b64").and_then(|b| b.as_str()) {
            Some(b) if !b.is_empty() => B64.decode(b).map_err(|_| "body_b64 is not base64")?,
            _ => vec![],
        };
        HttpReq::new(method, path, pass_headers(v.get("headers")), body)
    }

    fn frame(&self, id: &str, from: &str) -> String {
        json!({ "op": "http", "id": id, "from": from, "method": self.method, "path": self.path,
                "headers": self.headers, "body_b64": B64.encode(&self.body) })
        .to_string()
    }
}

enum Waiter {
    /// a /_root/ caller on this box, blocked on its channel
    Local(SyncSender<HttpReply>),
    /// a root's own request: the reply goes back on its link under its id
    Link { root: String, id: Value },
}

struct Pending {
    /// the root the request was sent to — the only one whose reply counts
    target: String,
    target_gen: Option<u64>,
    waiter: Waiter,
    deadline: Instant,
}

pub struct Switchboard {
    reg: Registry,
    /// the box's own brain (the bridge's opencode_url): `to = local`
    local_brain: String,
    pending: Mutex<HashMap<String, Pending>>,
    seq: AtomicU64,
    http: ureq::Agent,
    wait: Duration,
    /// `to = local` performs in flight (each on its own thread)
    local_calls: std::sync::atomic::AtomicUsize,
}

impl Switchboard {
    pub fn new(reg: Registry, local_brain: &str) -> Arc<Switchboard> {
        Self::with_wait(reg, local_brain, HTTP_WAIT)
    }

    pub fn with_wait(reg: Registry, local_brain: &str, wait: Duration) -> Arc<Switchboard> {
        let sw = Arc::new(Switchboard {
            reg,
            local_brain: local_brain.trim_end_matches('/').to_string(),
            pending: Mutex::new(HashMap::new()),
            seq: AtomicU64::new(1),
            http: ureq::AgentBuilder::new().timeout(wait).redirects(0).build(),
            wait,
            local_calls: std::sync::atomic::AtomicUsize::new(0),
        });
        // the reaper: an exchange nobody answered gets its 504
        let weak = Arc::downgrade(&sw);
        std::thread::Builder::new()
            .name("switch-reaper".into())
            .spawn(move || loop {
                std::thread::sleep(Duration::from_millis(500));
                let Some(sw) = weak.upgrade() else { return };
                let now = Instant::now();
                let expired: Vec<(String, Pending)> = {
                    let mut p = sw.pending.lock().unwrap();
                    let ids: Vec<String> = p.iter().filter(|(_, e)| e.deadline <= now).map(|(k, _)| k.clone()).collect();
                    ids.into_iter().filter_map(|k| p.remove(&k).map(|e| (k, e))).collect()
                };
                for (_, e) in expired {
                    eprintln!("switch: root '{}' did not answer in {}s — 504", e.target, sw.wait.as_secs());
                    let msg = format!("root '{}' did not answer in {}s", e.target, sw.wait.as_secs());
                    sw.deliver(e.waiter, HttpReply::error(504, &msg));
                }
            })
            .expect("switch reaper thread");
        sw
    }

    fn next_id(&self) -> String {
        format!("sw{}", self.seq.fetch_add(1, Ordering::Relaxed))
    }

    fn deliver(&self, waiter: Waiter, reply: HttpReply) {
        match waiter {
            Waiter::Local(tx) => {
                let _ = tx.try_send(reply);
            }
            Waiter::Link { root, id } => {
                if let Err(e) = self.reg.send_text(&root, &reply.frame(&id)) {
                    eprintln!("switch: reply to root '{root}' lost: {e}");
                }
            }
        }
    }

    /// Queue `req` at linked root `to` (from = the caller's name); the reply
    /// lands on `waiter`. Err = refused before anything was sent.
    fn forward(&self, from: &str, to: &str, req: &HttpReq, waiter: Waiter) -> Result<(), (Waiter, HttpReply)> {
        if !self.reg.is_linked(to) {
            return Err((waiter, HttpReply::error(502, &format!("root '{to}' not linked"))));
        }
        let tid = self.next_id();
        let target_gen = self.reg.gen_of(to);
        self.pending.lock().unwrap().insert(
            tid.clone(),
            Pending { target: to.to_string(), target_gen, waiter, deadline: Instant::now() + self.wait },
        );
        if let Err(e) = self.reg.send_text(to, &req.frame(&tid, from)) {
            let p = self.pending.lock().unwrap().remove(&tid);
            let msg = format!("root '{to}' unreachable: {e}");
            return match p {
                Some(p) => Err((p.waiter, HttpReply::error(502, &msg))),
                None => Ok(()), // already answered/reaped
            };
        }
        Ok(())
    }

    /// The hub brain's side (`/_root/<to>/…`, from = local): blocks until the
    /// root answers, or 504 after the wait.
    pub fn call_root(&self, to: &str, req: HttpReq) -> HttpReply {
        if to == "local" || !valid_root_id(to) {
            return HttpReply::error(400, &format!("'{to}' is not a root id"));
        }
        let (tx, rx) = sync_channel(1);
        if let Err((_, reply)) = self.forward("local", to, &req, Waiter::Local(tx)) {
            return reply;
        }
        rx.recv_timeout(self.wait + Duration::from_secs(2))
            .unwrap_or_else(|_| HttpReply::error(504, &format!("root '{to}' did not answer in {}s", self.wait.as_secs())))
    }

    /// Perform a request against the box's own brain.
    pub fn perform_local(&self, req: &HttpReq) -> HttpReply {
        let url = format!("{}{}", self.local_brain, req.path);
        let mut r = self.http.request(&req.method, &url);
        for (k, v) in &req.headers {
            if let Some(s) = v.as_str() {
                r = r.set(k, s);
            }
        }
        let resp = match if req.body.is_empty() && req.method == "GET" { r.call() } else { r.send_bytes(&req.body) } {
            Ok(resp) => resp,
            Err(ureq::Error::Status(_, resp)) => resp,
            Err(e) => return HttpReply::error(502, &format!("local brain unreachable: {e}")),
        };
        let status = resp.status();
        let mut headers = Map::new();
        for k in PASS_HEADERS {
            if let Some(v) = resp.header(k) {
                headers.insert(k.to_string(), json!(v));
            }
        }
        let mut body = Vec::new();
        if let Err(e) = resp.into_reader().take(MAX_BODY as u64 + 1).read_to_end(&mut body) {
            return HttpReply::error(502, &format!("local brain body: {e}"));
        }
        if body.len() > MAX_BODY {
            return HttpReply::error(502, &format!("local brain body over {MAX_BODY} bytes"));
        }
        HttpReply { status, headers: pass_headers(Some(&Value::Object(headers))), body }
    }

    /// An `http` frame from link `from`; its link-token `roots` claim is the
    /// one the registry holds for that conn. Never blocks the conn's reader:
    /// a local perform runs on its own thread.
    pub fn on_http(self: &Arc<Self>, from: &str, v: Value) {
        let claim = self.reg.roots_of(from).unwrap_or_default();
        let id = v.get("id").cloned().unwrap_or(Value::Null);
        let back = |reply: HttpReply| {
            if let Err(e) = self.reg.send_text(from, &reply.frame(&id)) {
                eprintln!("switch: reply to root '{from}' lost: {e}");
            }
        };
        if !(id.is_string() || id.is_number()) {
            return back(HttpReply::error(400, "http frame needs an id"));
        }
        let to = v.get("to").and_then(|t| t.as_str()).unwrap_or("").to_string();
        if !valid_root_id(&to) {
            return back(HttpReply::error(400, &format!("'{to}' is not a root id")));
        }
        if to == from {
            return back(HttpReply::error(400, "a root cannot address itself through the trunk"));
        }
        if !link_may_address(&claim, &to) {
            eprintln!("switch: root '{from}' → '{to}' REFUSED (link-token roots claim {claim:?})");
            return back(HttpReply::error(
                403,
                &format!("root '{from}' may not address root '{to}': its link-token roots claim does not name it"),
            ));
        }
        let req = match HttpReq::from_frame(&v) {
            Ok(r) => r,
            Err(e) => return back(HttpReply::error(400, &e)),
        };
        if to == "local" {
            if self.local_calls.fetch_add(1, Ordering::SeqCst) >= MAX_LOCAL {
                self.local_calls.fetch_sub(1, Ordering::SeqCst);
                return back(HttpReply::error(503, "the hub brain has too many calls in flight"));
            }
            let me = self.clone();
            let from = from.to_string();
            std::thread::spawn(move || {
                let reply = me.perform_local(&req);
                me.local_calls.fetch_sub(1, Ordering::SeqCst);
                if let Err(e) = me.reg.send_text(&from, &reply.frame(&id)) {
                    eprintln!("switch: reply to root '{from}' lost: {e}");
                }
            });
            return;
        }
        if let Err((waiter, reply)) = self.forward(from, &to, &req, Waiter::Link { root: from.to_string(), id: id.clone() }) {
            self.deliver(waiter, reply);
        }
    }

    /// An `http.reply` frame from link `from`: routed to whoever asked —
    /// accepted only from the root the request was sent to.
    pub fn on_reply(&self, from: &str, v: Value) {
        let Some(id) = v.get("id").and_then(|i| i.as_str()) else { return };
        let entry = {
            let mut p = self.pending.lock().unwrap();
            match p.get(id) {
                Some(e) if e.target == from => p.remove(id),
                Some(e) => {
                    eprintln!("switch: root '{from}' answered '{id}' meant for '{}' — ignored", e.target);
                    None
                }
                None => None, // late (already 504'd) or unknown
            }
        };
        if let Some(e) = entry {
            self.deliver(e.waiter, HttpReply::from_frame(&v));
        }
    }

    /// A link went down: every exchange waiting on THAT conn fails now (502)
    /// instead of eating the full wait.
    pub fn link_down(&self, root: &str, gen_no: u64) {
        let dead: Vec<Pending> = {
            let mut p = self.pending.lock().unwrap();
            let ids: Vec<String> = p
                .iter()
                .filter(|(_, e)| e.target == root && e.target_gen.is_none_or(|g| g == gen_no))
                .map(|(k, _)| k.clone())
                .collect();
            ids.into_iter().filter_map(|k| p.remove(&k)).collect()
        };
        for e in dead {
            self.deliver(e.waiter, HttpReply::error(502, &format!("root '{root}' went away mid-call")));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_two_headers_cross() {
        let h = json!({ "Content-Type": "application/json", "X-Ygg-Peer": "t", "authorization": "Bearer x",
                        "cookie": "a=b", "x-forwarded-for": "6.6.6.6", "x-ygg-peer-evil": "1" });
        let got = pass_headers(Some(&h));
        assert_eq!(got.len(), 2);
        assert_eq!(got["content-type"], "application/json");
        assert_eq!(got["x-ygg-peer"], "t");
        // header injection never crosses
        let bad = json!({ "content-type": "text/plain\r\nX-Evil: 1" });
        assert!(pass_headers(Some(&bad)).is_empty());
    }

    #[test]
    fn address_law() {
        let mac = vec!["mac".to_string()];
        assert!(link_may_address(&mac, "local"));
        assert!(link_may_address(&mac, "mac"));
        assert!(!link_may_address(&mac, "lab"));
        assert!(!link_may_address(&[], "lab"));
        assert!(link_may_address(&["*".to_string()], "lab"));
    }

    #[test]
    fn request_validation() {
        assert!(HttpReq::new("get", "/root", Map::new(), vec![]).is_ok());
        assert!(HttpReq::new("CONNECT", "/x", Map::new(), vec![]).is_err());
        assert!(HttpReq::new("GET", "@evil.example/", Map::new(), vec![]).is_err());
        assert!(HttpReq::new("GET", "/a b", Map::new(), vec![]).is_err());
        assert!(HttpReq::new("GET", "/a\r\nHost: x", Map::new(), vec![]).is_err());
        assert!(!valid_root_id("") && !valid_root_id("a/b") && valid_root_id("mac-studio.1"));
    }

    #[test]
    fn unlinked_root_is_a_clean_502() {
        let sw = Switchboard::with_wait(Registry::new(), "http://127.0.0.1:9", Duration::from_secs(1));
        let r = sw.call_root("ghost", HttpReq::new("GET", "/root", Map::new(), vec![]).unwrap());
        assert_eq!(r.status, 502);
        assert!(String::from_utf8_lossy(&r.body).contains("not linked"));
        assert_eq!(sw.call_root("local", HttpReq::new("GET", "/", Map::new(), vec![]).unwrap()).status, 400);
    }
}
