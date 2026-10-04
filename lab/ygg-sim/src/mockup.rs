//! The deterministic upstream LLM — the ONLY simulated server-side component.
//! The real stack (yggdrasil + bridge) speaks to this exactly as it would to a
//! provider: OpenAI-shaped chat completions, streaming SSE or JSON, honoring
//! the mock contract yggdrasil's own harness established (mock_upstream.py
//! subset): roll-up summary detection, "reply with exactly: X", "sleep N",
//! "slow" mode, plus /control failure injection and /calls counters.

use std::io::Read;
use std::net::{SocketAddr, TcpListener};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};

pub struct MockUpstream {
    pub addr: SocketAddr,
    #[allow(dead_code)] // read via control()/calls() from the scenario matrix (M1+)
    state: Arc<Mutex<Ctrl>>,
    stop: Arc<AtomicBool>,
    handles: Vec<std::thread::JoinHandle<()>>,
}

#[derive(Default)]
struct Ctrl {
    chat: u64,
    summary: u64,
    fails: u64,
    fail_next: u32,
    base_latency_ms: u64,
}

impl MockUpstream {
    pub fn start() -> Result<MockUpstream, String> {
        let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
        let addr = listener.local_addr().map_err(|e| e.to_string())?;
        let server = Arc::new(
            tiny_http::Server::from_listener(listener, None).map_err(|e| e.to_string())?,
        );
        let state = Arc::new(Mutex::new(Ctrl::default()));
        let stop = Arc::new(AtomicBool::new(false));
        let mut handles = vec![];
        for _ in 0..4 {
            let server = server.clone();
            let state = state.clone();
            let stop = stop.clone();
            handles.push(
                std::thread::Builder::new()
                    .name("ygg-sim-mock".into())
                    .spawn(move || loop {
                        if stop.load(Ordering::SeqCst) {
                            return;
                        }
                        match server.recv_timeout(Duration::from_millis(200)) {
                            Ok(Some(rq)) => handle(rq, &state),
                            Ok(None) => {}
                            Err(_) => return,
                        }
                    })
                    .map_err(|e| e.to_string())?,
            );
        }
        Ok(MockUpstream {
            addr,
            state,
            stop,
            handles,
        })
    }

    /// Failure injection + base latency for the NEXT calls.
    #[allow(dead_code)] // used from the upstream-down / marathon scenarios (M1+)
    pub fn control(&self, fail_next: u32, base_latency_ms: u64) {
        let mut c = self.state.lock().unwrap();
        c.fail_next = fail_next;
        c.base_latency_ms = base_latency_ms;
    }

    #[allow(dead_code)] // used from the marathon scenario (M1+)
    pub fn calls(&self) -> (u64, u64, u64) {
        let c = self.state.lock().unwrap();
        (c.chat, c.summary, c.fails)
    }
}

impl Drop for MockUpstream {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        // recv_timeout polls every 200ms; join briefly, leaks are harmless in a lab process
        let _ = &self.handles;
    }
}

fn handle(mut rq: tiny_http::Request, state: &Arc<Mutex<Ctrl>>) {
    let url = rq.url().to_string();
    let method = rq.method().clone();

    if method == tiny_http::Method::Get && url.starts_with("/calls") {
        let c = state.lock().unwrap();
        let body = json!({"chat": c.chat, "summary": c.summary, "fails": c.fails}).to_string();
        drop(c);
        let _ = rq.respond(json_response(body, 200));
        return;
    }
    if method == tiny_http::Method::Post && url.starts_with("/control") {
        let mut body = String::new();
        let _ = rq.as_reader().read_to_string(&mut body);
        let v: Value = serde_json::from_str(&body).unwrap_or(json!({}));
        let mut c = state.lock().unwrap();
        if let Some(n) = v.get("fail_next").and_then(|x| x.as_u64()) {
            c.fail_next = n as u32;
        }
        if let Some(ms) = v.get("base_latency_ms").and_then(|x| x.as_u64()) {
            c.base_latency_ms = ms;
        }
        drop(c);
        let _ = rq.respond(json_response(r#"{"ok":true}"#.to_string(), 200));
        return;
    }
    if method == tiny_http::Method::Post && url.ends_with("/chat/completions") {
        let mut body = String::new();
        let _ = rq.as_reader().read_to_string(&mut body);
        let v: Value = match serde_json::from_str(&body) {
            Ok(v) => v,
            Err(e) => {
                let _ = rq.respond(json_response(
                    json!({"error": {"message": format!("bad json: {e}")}}).to_string(),
                    400,
                ));
                return;
            }
        };
        let (fail_next, base_ms) = {
            let mut c = state.lock().unwrap();
            c.chat += 1;
            (c.fail_next, c.base_latency_ms)
        };
        let mut c = state.lock().unwrap();
        if fail_next > 0 {
            c.fail_next -= 1;
            c.fails += 1;
            drop(c);
            let _ = rq.respond(json_response(
                json!({"error": {"message": "mock upstream failure (injected)"}}).to_string(),
                500,
            ));
            return;
        }
        drop(c);

        let planned = plan(&v);
        {
            let mut c = state.lock().unwrap();
            if planned.kind == "summary" {
                c.summary += 1;
            }
        }
        if base_ms > 0 {
            std::thread::sleep(Duration::from_millis(base_ms));
        }
        let stream = v.get("stream").and_then(|s| s.as_bool()).unwrap_or(false);
        if stream {
            let _ = rq.respond(sse_response(planned));
        } else {
            let body = json!({
                "id": "cmpl-ygg-sim",
                "object": "chat.completion",
                "choices": [{
                    "index": 0,
                    "message": {"role": "assistant", "content": planned.text},
                    "finish_reason": "stop",
                }],
            })
            .to_string();
            let _ = rq.respond(json_response(body, 200));
        }
        return;
    }
    // anything else (anthropic /v1/messages included) — loud, not silent
    let _ = rq.respond(json_response(
        json!({"error": {"message": format!("ygg-sim mock upstream does not simulate {url}")}})
            .to_string(),
        404,
    ));
}

struct Planned {
    kind: &'static str,
    text: String,
    chunk_ms: u64,
    first_ms: u64,
    /// tool calls the agent loop must execute (in order) before the next turn
    calls: Vec<PlannedCall>,
}

struct PlannedCall {
    id: String,
    name: String,
    args: String,
}

/// Dialect-neutral reply plan — mirrors mock_upstream.py's contract subset.
fn plan(body: &Value) -> Planned {
    let msgs = body.get("messages").and_then(|m| m.as_array()).cloned().unwrap_or_default();

    // roll-up summarizer call
    let is_summary = msgs
        .first()
        .map(|m| {
            m.get("role").and_then(|r| r.as_str()) == Some("system")
                && m.get("content")
                    .and_then(|c| c.as_str())
                    .map(|c| c.starts_with("[yggdrasil roll-up]"))
                    .unwrap_or(false)
        })
        .unwrap_or(false);
    if is_summary {
        let tr = msgs
            .last()
            .and_then(|m| m.get("content"))
            .and_then(|c| c.as_str())
            .unwrap_or_default();
        let head = tr
            .lines()
            .find(|l| l.starts_with("USER: "))
            .unwrap_or("");
        return Planned {
            kind: "summary",
            text: format!("MOCK-SUMMARY: {head} | {} chars", tr.len()),
            chunk_ms: 0,
            first_ms: 0,
            calls: vec![],
        };
    }

    let last_user = msgs
        .iter()
        .rev()
        .find(|m| m.get("role").and_then(|r| r.as_str()) == Some("user"))
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_str())
        .unwrap_or_default();
    let lc = last_user.to_lowercase();

    // ---- agent tool loop ----------------------------------------------------
    // "tool:echo X"   → one bash `echo X` call, then TOOL-FINAL: X
    // "tool:twice X"  → two calls (`echo X-1`, `echo X-2`), then TOOL-FINAL: X-2
    // The last USER message carries the directive; results after it mean the
    // loop already ran (this turn = final text). Older tool messages from
    // EARLIER loops don't count — positions, not existence.
    if last_user.starts_with("tool:") {
        let last_user_pos = msgs.iter().rposition(|m| m.get("role").and_then(|r| r.as_str()) == Some("user"));
        let last_tool_pos = msgs.iter().rposition(|m| m.get("role").and_then(|r| r.as_str()) == Some("tool"));
        let fresh = last_tool_pos.map_or(true, |t| last_user_pos.map_or(false, |u| u > t));
        let arg = last_user["tool:".len()..].trim();
        if !fresh {
            let last_tool = msgs
                .iter()
                .rev()
                .find(|m| m.get("role").and_then(|r| r.as_str()) == Some("tool"))
                .and_then(|m| m.get("content"))
                .and_then(|c| c.as_str())
                .unwrap_or_default()
                .trim()
                .to_string();
            return Planned {
                kind: "chat",
                text: format!("TOOL-FINAL: {last_tool}"),
                chunk_ms: 10,
                first_ms: 0,
                calls: vec![],
            };
        }
        let mk = |n: usize, cmd: String| PlannedCall {
            id: format!("call_sim_{n}"),
            name: "bash".into(),
            args: serde_json::json!({ "command": cmd }).to_string(),
        };
        if let Some(x) = arg.strip_prefix("twice ") {
            let x = x.trim();
            return Planned {
                kind: "tools",
                text: "Running the tools.".into(),
                chunk_ms: 5,
                first_ms: 0,
                calls: vec![mk(0, format!("echo {x}-1")), mk(1, format!("echo {x}-2"))],
            };
        }
        if let Some(x) = arg.strip_prefix("echo ") {
            return Planned {
                kind: "tools",
                text: "Running the tool.".into(),
                chunk_ms: 5,
                first_ms: 0,
                calls: vec![mk(0, format!("echo {x}"))],
            };
        }
        return Planned {
            kind: "chat",
            text: format!("TOOL-FINAL: unknown tool directive '{arg}'"),
            chunk_ms: 10,
            first_ms: 0,
            calls: vec![],
        };
    }

    // "reply with exactly: X"
    for marker in ["reply with exactly:", "reply exactly:", "reply:"] {
        if let Some(i) = lc.find(marker) {
            let rest = last_user[i + marker.len()..].trim();
            let word = rest.split_whitespace().next().unwrap_or_default();
            let word = word.trim_end_matches('.');
            return Planned {
                kind: "chat",
                text: word.to_string(),
                chunk_ms: 5,
                first_ms: 0,
                calls: vec![],
            };
        }
    }

    let nap = find_sleep(&lc);

    // multi-paragraph long-form reply — the "TTS breaks" pattern (the voice
    // pipeline must carry paragraph pauses and a long burst to the far end).
    // contains, not starts_with: STT may prepend filler to the spoken directive.
    if lc.contains("essay") {
        let para = |n: &str, tail: &str| {
            format!(
                "This is paragraph {n} of the simulated essay. It carries several full sentences so the voice has real length to hold. The bridge must hand every pause and every burst to the far end without dropping the thread. {tail}"
            )
        };
        return Planned {
            kind: "chat",
            text: format!("{}\n\n{}", para("one", "Here the first thought rests."), para("two", "And here the essay closes.")),
            chunk_ms: 5,
            first_ms: nap,
            calls: vec![],
        };
    }

    if last_user.starts_with("slow") {
        return Planned {
            kind: "chat",
            text: format!(
                "MOCK-REPLY: you said '{last_user}' ({} msgs) {} SLOW-END",
                msgs.len(),
                "lorem ipsum ".repeat(30)
            ),
            chunk_ms: 200,
            first_ms: nap,
            calls: vec![],
        };
    }

    Planned {
        kind: "chat",
        text: format!("MOCK-REPLY: you said '{last_user}' ({} msgs)", msgs.len()),
        chunk_ms: 10,
        first_ms: nap,
        calls: vec![],
    }
}

fn find_sleep(lc: &str) -> u64 {
    if let Some(i) = lc.find("sleep ") {
        let rest = &lc[i + 6..];
        let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
        if let Ok(n) = digits.parse::<u64>() {
            return n.min(30) * 1000;
        }
    }
    0
}

fn json_response(body: String, code: u16) -> tiny_http::Response<std::io::Cursor<Vec<u8>>> {
    tiny_http::Response::from_string(body)
        .with_status_code(code)
        .with_header(
            tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap(),
        )
}

/// SSE with real pacing: a writer thread drips chunks through a channel; the
/// reader end implements Read for tiny_http. Client abort = response dropped =
/// sender fails = writer exits.
fn sse_response(p: Planned) -> tiny_http::Response<ChanReader> {
    let (tx, rx) = std::sync::mpsc::sync_channel::<Vec<u8>>(8);
    std::thread::Builder::new()
        .name("ygg-sim-sse".into())
        .spawn(move || {
            if p.first_ms > 0 {
                // drip pings so keepalives flow while we stall
                let _ = tx.send(sse_data(&json!({"type": "ping"}).to_string()));
            }
            std::thread::sleep(Duration::from_millis(p.first_ms));
            for chunk in split_chunks(&p.text, 12) {
                let ev = json!({
                    "id": "cmpl-ygg-sim",
                    "object": "chat.completion.chunk",
                    "choices": [{"index": 0, "delta": {"content": chunk}}],
                });
                if tx.send(sse_data(&ev.to_string())).is_err() {
                    return;
                }
                if p.chunk_ms > 0 {
                    std::thread::sleep(Duration::from_millis(p.chunk_ms));
                }
            }
            // tool calls: id+name in the first delta, arguments split across
            // two more (forces the consumer to reassemble across chunks)
            for (i, call) in p.calls.iter().enumerate() {
                let head = json!({
                    "id": "cmpl-ygg-sim",
                    "object": "chat.completion.chunk",
                    "choices": [{"index": 0, "delta": {"tool_calls": [{
                        "index": i, "id": call.id, "type": "function",
                        "function": {"name": call.name, "arguments": ""},
                    }]}}],
                });
                if tx.send(sse_data(&head.to_string())).is_err() {
                    return;
                }
                let cut = call.args.len() / 2;
                for piece in [call.args[..cut].to_string(), call.args[cut..].to_string()] {
                    let ev = json!({
                        "id": "cmpl-ygg-sim",
                        "object": "chat.completion.chunk",
                        "choices": [{"index": 0, "delta": {"tool_calls": [{
                            "index": i, "function": {"arguments": piece},
                        }]}}],
                    });
                    if tx.send(sse_data(&ev.to_string())).is_err() {
                        return;
                    }
                }
            }
            let _ = tx.send(b"data: [DONE]\n\n".to_vec());
        })
        .expect("sse writer thread");
    tiny_http::Response::new(
        tiny_http::StatusCode(200),
        vec![
            tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"text/event-stream"[..]).unwrap(),
            tiny_http::Header::from_bytes(&b"Cache-Control"[..], &b"no-cache"[..]).unwrap(),
        ],
        ChanReader { rx, buf: vec![] },
        None,
        None,
    )
}

fn sse_data(s: &str) -> Vec<u8> {
    format!("data: {s}\n\n").into_bytes()
}

fn split_chunks(s: &str, n: usize) -> Vec<String> {
    let mut out = vec![];
    let mut cur = String::new();
    let mut len = 0usize;
    for word in s.split_inclusive(' ') {
        cur.push_str(word);
        len += word.len();
        if len >= n {
            out.push(std::mem::take(&mut cur));
            len = 0;
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

struct ChanReader {
    rx: std::sync::mpsc::Receiver<Vec<u8>>,
    buf: Vec<u8>,
}

impl Read for ChanReader {
    fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
        if self.buf.is_empty() {
            match self.rx.recv() {
                Ok(c) => self.buf = c,
                Err(_) => return Ok(0),
            }
        }
        let n = out.len().min(self.buf.len());
        out[..n].copy_from_slice(&self.buf[..n]);
        self.buf.drain(..n);
        Ok(n)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plan_echo() {
        let body = json!({"messages": [
            {"role": "user", "content": "hello from ygg-sim"}
        ], "stream": true});
        let p = plan(&body);
        assert_eq!(p.kind, "chat");
        assert_eq!(p.text, "MOCK-REPLY: you said 'hello from ygg-sim' (1 msgs)");
    }

    #[test]
    fn plan_summary() {
        let body = json!({"messages": [
            {"role": "system", "content": "[yggdrasil roll-up] compress"},
            {"role": "user", "content": "TRANSCRIPT:\n\nUSER: build the thing\n\nASSISTANT: ok"}
        ]});
        let p = plan(&body);
        assert_eq!(p.kind, "summary");
        assert!(p.text.starts_with("MOCK-SUMMARY: USER: build the thing"));
    }

    #[test]
    fn plan_exact_and_sleep() {
        let p = plan(&json!({"messages": [{"role": "user", "content": "reply with exactly: PONG."}]}));
        assert_eq!(p.text, "PONG");
        let p = plan(&json!({"messages": [{"role": "user", "content": "sleep 2 and say hi"}]}));
        assert_eq!(p.first_ms, 2000);
    }

    #[test]
    fn plan_tool_loop() {
        // step 1: the directive — one bash call
        let p = plan(&json!({"messages": [{"role": "user", "content": "tool:echo ygg-sim-v2"}], "stream": true}));
        assert_eq!(p.kind, "tools");
        assert_eq!(p.calls.len(), 1);
        assert_eq!(p.calls[0].name, "bash");
        assert!(p.calls[0].args.contains("echo ygg-sim-v2"));
        // step 2: the tool result is in history — final text carries it
        let p = plan(&json!({"messages": [
            {"role": "user", "content": "tool:echo ygg-sim-v2"},
            {"role": "assistant", "content": null, "tool_calls": [{"id": "call_sim_0", "function": {"name": "bash", "arguments": "{}"}}]},
            {"role": "tool", "tool_call_id": "call_sim_0", "content": "ygg-sim-v2\n"}
        ]}));
        assert_eq!(p.text, "TOOL-FINAL: ygg-sim-v2");
        // twice: two calls
        let p = plan(&json!({"messages": [{"role": "user", "content": "tool:twice deep"}]}));
        assert_eq!(p.calls.len(), 2);
        assert!(p.calls[1].args.contains("echo deep-2"));
    }

    #[test]
    fn chunker_keeps_all_text() {
        let t = "MOCK-REPLY: you said 'x' (3 msgs)";
        let joined: String = split_chunks(t, 12).concat();
        assert_eq!(joined, t);
    }
}
