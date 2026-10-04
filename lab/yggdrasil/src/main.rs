//! YGGDRASIL (slices 1-7): an opencode-compatible surface that bifrost's PWA proxy can
//! drive unchanged. Sessions + message relay to an OpenAI- or Anthropic-compatible endpoint;
//! abort; global `/event` bus; on-disk store; per-session run serialization;
//! session get/patch/delete, busy map, model/agent catalog + v2 switches.
//!
//! Env:
//!   YGG_UPSTREAM_BASE_URL  e.g. https://api.openai.com/v1  (required; `/chat/completions` is appended)
//!   YGG_UPSTREAM_API_KEY   bearer token (optional; omitted header if unset; the anthropic
//!                          dialect sends it as `x-api-key` AND `Authorization: Bearer`)
//!   YGG_UPSTREAM_STYLE     slice 7: `openai` (default: `{base}/chat/completions`) | `anthropic`
//!                          (`{base}/v1/messages`, block SSE; `anthropic.rs`)
//!   YGG_MAX_TOKENS         anthropic dialect's required `max_tokens` (default 16384)
//!   YGG_UPSTREAM_MODEL     model name (default: gpt-4o-mini)
//!   YGG_LISTEN             bind address (default: 127.0.0.1:4096)
//!   YGG_DATA_DIR           on-disk store (default: ./data); one `session/<id>.json` per session
//!   YGG_CATALOG            JSON file `{providers:[...], agents:[...]}` served as
//!                          `/config/providers` + `/agent` (default: one provider = the upstream model,
//!                          agents build + plan)
//!   YGG_PROJECT_DIR        slice 6a: where tools run / relative paths resolve (default: cwd)
//!   YGG_MAX_STEPS          upstream calls per run before the loop gives up (default: 100)
//!   YGG_BASH_TIMEOUT_MS    default bash tool timeout (default: 120000)
//!   YGG_TOOLS              `0` = don't declare tools (plain relay, for tool-less upstreams)
//!   YGG_ROLLUP_TOKENS      slice 6b: estimated-token limit for the upstream history (default 100000,
//!                          `0` = off); over it, older history is summarized (`rollup.rs`)
//!   YGG_ROLLUP_KEEP_TOKENS recent history kept verbatim at a roll-up (default: limit / 4)
//!
//! Slice 6a: each run is an agent loop — the upstream gets the tool set (`tools.rs`); its
//! tool_calls are executed serially, fed back as `tool` messages, repeated until a reply
//! with no tool calls. Every call is stored on the assistant message as an opencode
//! `{"type":"tool", callID, tool, state:{status, input, output, ...}}` part and announced
//! on `message.part.updated` (running, then completed|error).
//!
//! Slice 7: `YGG_UPSTREAM_STYLE=anthropic` speaks the Anthropic Messages API instead. The run
//! keeps the same internal (OpenAI-shaped) conversation; `anthropic.rs` translates it at the
//! wire, decodes the block SSE back into the same deltas + tool calls, and the relay re-keys
//! tool-use ids — stored transcripts and client events are identical in both dialects.
//!
//! `POST /session/:id/message` answers like opencode (blocks, returns the final assistant
//! message as JSON) unless the request sends `Accept: text/event-stream`, which gets the
//! slice-1 per-request SSE relay.

use std::{
    collections::HashMap,
    convert::Infallible,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use axum::{
    Json, Router,
    extract::{Path, State},
    http::{HeaderMap, StatusCode, header},
    response::{
        IntoResponse, Response,
        sse::{Event, KeepAlive, Sse},
    },
    routing::{get, post},
};
use futures::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::{Notify, broadcast, mpsc, oneshot};
use tokio_stream::wrappers::{BroadcastStream, ReceiverStream};

mod anthropic;
mod rollup;
mod tools;

#[derive(Clone, Copy, PartialEq, Debug)]
enum Dialect {
    OpenAi,
    Anthropic,
}

struct Config {
    base_url: String,
    dialect: Dialect,
    max_tokens: u64,
    api_key: Option<String>,
    model: String,
    catalog: Value,
    max_steps: usize,
    tools_enabled: bool,
    rollup_tokens: usize,
    rollup_keep_tokens: usize,
}

#[derive(Serialize, Deserialize)]
struct Session {
    info: Value,
    messages: Vec<Value>,
    /// Last `todowrite` list (opencode's `GET /session/:id/todo`).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    todo: Vec<Value>,
}

#[derive(Clone)]
struct AppState {
    sessions: Arc<Mutex<HashMap<String, Session>>>,
    /// In-flight replies, keyed by session id; notified by `POST /session/:id/abort`.
    running: Arc<Mutex<HashMap<String, Arc<Notify>>>>,
    /// One run at a time per session (opencode serializes; stacked prompts wait their turn).
    run_locks: Arc<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>>,
    /// Global event bus feeding `GET /event`: `{type, properties}` JSON, opencode-style.
    bus: broadcast::Sender<Value>,
    data_dir: Arc<PathBuf>,
    config: Arc<Config>,
    http: reqwest::Client,
    tools: Arc<tools::ToolEnv>,
}

#[derive(Deserialize)]
struct PostMessage {
    #[serde(default)]
    parts: Vec<Value>,
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64
}

fn new_id(prefix: &str) -> String {
    format!("{prefix}_{}", uuid::Uuid::new_v4().simple())
}

/// `parts` without ids get them stamped, so stored messages look like opencode's.
fn make_message(session_id: &str, role: &str, parts: Vec<Value>) -> Value {
    let id = new_id("msg");
    let parts: Vec<Value> = parts
        .into_iter()
        .map(|mut p| {
            p["id"] = json!(new_id("prt"));
            p["messageID"] = json!(id);
            p["sessionID"] = json!(session_id);
            p
        })
        .collect();
    json!({
        "info": { "id": id, "sessionID": session_id, "role": role, "time": { "created": now_ms() } },
        "parts": parts,
    })
}

fn text_part(text: &str) -> Value {
    json!({ "type": "text", "text": text })
}

fn message_text(msg: &Value) -> String {
    msg["parts"]
        .as_array()
        .map(|parts| {
            parts
                .iter()
                .filter(|p| p["type"] == "text")
                .filter_map(|p| p["text"].as_str())
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}

fn session_path(dir: &std::path::Path, id: &str) -> PathBuf {
    dir.join("session").join(format!("{id}.json"))
}

/// Writes the session atomically (tmp + rename). Called with the sessions lock held,
/// so writes for one session never interleave.
fn persist(dir: &std::path::Path, id: &str, session: &Session) {
    let path = session_path(dir, id);
    let tmp = path.with_extension("json.tmp");
    let res = serde_json::to_vec_pretty(session)
        .map_err(std::io::Error::other)
        .and_then(|bytes| std::fs::write(&tmp, bytes))
        .and_then(|_| std::fs::rename(&tmp, &path));
    if let Err(e) = res {
        eprintln!("persist {id}: {e}");
    }
}

fn load_sessions(dir: &std::path::Path) -> HashMap<String, Session> {
    let mut out = HashMap::new();
    let Ok(entries) = std::fs::read_dir(dir.join("session")) else { return out };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().is_none_or(|e| e != "json") {
            continue;
        }
        match std::fs::read(&path).map_err(|e| e.to_string()).and_then(|b| {
            serde_json::from_slice::<Session>(&b).map_err(|e| e.to_string())
        }) {
            Ok(s) => match s.info["id"].as_str() {
                Some(id) => {
                    out.insert(id.to_string(), s);
                }
                None => eprintln!("skip {}: no info.id", path.display()),
            },
            Err(e) => eprintln!("skip {}: {e}", path.display()),
        }
    }
    out
}

/// Mutates one session under the lock, bumps `time.updated`, persists.
/// Returns `None` if the session is gone (deleted mid-run).
fn with_session<R>(st: &AppState, id: &str, f: impl FnOnce(&mut Session) -> R) -> Option<R> {
    let mut sessions = st.sessions.lock().unwrap();
    let s = sessions.get_mut(id)?;
    let r = f(s);
    s.info["time"]["updated"] = json!(now_ms());
    persist(&st.data_dir, id, s);
    Some(r)
}

/// Replaces a stored message (matched by `info.id`) — the assistant placeholder
/// is created at run start and filled in when the run ends.
fn replace_message(st: &AppState, sid: &str, msg: &Value) {
    with_session(st, sid, |s| {
        if let Some(slot) = s.messages.iter_mut().find(|m| m["info"]["id"] == msg["info"]["id"]) {
            *slot = msg.clone();
        } else {
            s.messages.push(msg.clone());
        }
    });
}

fn publish(st: &AppState, kind: &str, props: Value) {
    let _ = st.bus.send(json!({ "type": kind, "properties": props }));
}

/// Sends an event to the posting client's stream (named SSE event, slice-1 shape)
/// and to the global bus (`{type, properties}`).
async fn emit(st: &AppState, tx: &mpsc::Sender<Event>, kind: &str, props: Value) {
    publish(st, kind, props.clone());
    // The posting client may have gone away; the reply keeps going for /event listeners.
    let _ = tx.send(Event::default().event(kind).json_data(props).unwrap()).await;
}

fn not_found(id: &str) -> Response {
    (StatusCode::NOT_FOUND, Json(json!({ "name": "NotFoundError", "error": format!("session {id} not found") })))
        .into_response()
}

fn bad_request(msg: &str) -> Response {
    (StatusCode::BAD_REQUEST, Json(json!({ "error": msg }))).into_response()
}

/// `POST /session` — body `{title?, parentID?}` (opencode accepts an empty body too).
async fn create_session(State(st): State<AppState>, body: Option<Json<Value>>) -> Json<Value> {
    let body = body.map(|Json(b)| b).unwrap_or(Value::Null);
    let id = new_id("ses");
    let now = now_ms();
    let title = body["title"].as_str().filter(|t| !t.is_empty()).unwrap_or("New session");
    let mut info = json!({ "id": id, "title": title, "time": { "created": now, "updated": now } });
    if let Some(parent) = body["parentID"].as_str() {
        info["parentID"] = json!(parent);
    }
    let session = Session { info: info.clone(), messages: Vec::new(), todo: Vec::new() };
    {
        let mut sessions = st.sessions.lock().unwrap();
        persist(&st.data_dir, &id, &session);
        sessions.insert(id, session);
    }
    publish(&st, "session.created", json!({ "info": info }));
    Json(info)
}

/// `GET /session` — newest-updated first, like opencode.
async fn list_sessions(State(st): State<AppState>) -> Json<Value> {
    let sessions = st.sessions.lock().unwrap();
    let mut infos: Vec<Value> = sessions.values().map(|s| s.info.clone()).collect();
    infos.sort_by_key(|i| std::cmp::Reverse(i["time"]["updated"].as_u64().unwrap_or(0)));
    Json(Value::Array(infos))
}

async fn get_session(State(st): State<AppState>, Path(id): Path<String>) -> Response {
    match st.sessions.lock().unwrap().get(&id) {
        Some(s) => Json(s.info.clone()).into_response(),
        None => not_found(&id),
    }
}

/// `PATCH /session/:id` — `{title}`.
async fn patch_session(State(st): State<AppState>, Path(id): Path<String>, Json(body): Json<Value>) -> Response {
    let info = with_session(&st, &id, |s| {
        if let Some(t) = body["title"].as_str() {
            s.info["title"] = json!(t);
        }
        s.info.clone()
    });
    match info {
        Some(info) => {
            publish(&st, "session.updated", json!({ "info": info }));
            Json(info).into_response()
        }
        None => not_found(&id),
    }
}

/// `DELETE /session/:id` — aborts a live run, drops the record + file. Returns `true`.
async fn delete_session(State(st): State<AppState>, Path(id): Path<String>) -> Response {
    let Some(s) = st.sessions.lock().unwrap().remove(&id) else { return not_found(&id) };
    if let Some(n) = st.running.lock().unwrap().remove(&id) {
        n.notify_one();
    }
    let _ = std::fs::remove_file(session_path(&st.data_dir, &id));
    publish(&st, "session.deleted", json!({ "info": s.info }));
    Json(true).into_response()
}

/// `GET /session/:id/todo` — the last `todowrite` list.
async fn get_todo(State(st): State<AppState>, Path(id): Path<String>) -> Response {
    match st.sessions.lock().unwrap().get(&id) {
        Some(s) => Json(Value::Array(s.todo.clone())).into_response(),
        None => not_found(&id),
    }
}

/// `GET /session/status` — opencode's busy map: only sessions with a live run appear.
async fn session_status(State(st): State<AppState>) -> Json<Value> {
    let running = st.running.lock().unwrap();
    Json(Value::Object(running.keys().map(|k| (k.clone(), json!({ "type": "busy" }))).collect()))
}

async fn list_messages(State(st): State<AppState>, Path(id): Path<String>) -> Response {
    match st.sessions.lock().unwrap().get(&id) {
        Some(s) => Json(Value::Array(s.messages.clone())).into_response(),
        None => not_found(&id),
    }
}

/// `POST /session/:id/abort` — like opencode: returns `true` if a reply was in flight.
async fn abort_session(State(st): State<AppState>, Path(id): Path<String>) -> Response {
    if !st.sessions.lock().unwrap().contains_key(&id) {
        return not_found(&id);
    }
    let handle = st.running.lock().unwrap().get(&id).cloned();
    match handle {
        Some(n) => {
            n.notify_one();
            Json(true).into_response()
        }
        None => Json(false).into_response(),
    }
}

/// `GET /config/providers` — `{providers, default}` from the catalog.
async fn config_providers(State(st): State<AppState>) -> Json<Value> {
    let c = &st.config.catalog;
    Json(json!({ "providers": c["providers"], "default": c.get("default").cloned().unwrap_or(json!({})) }))
}

/// `GET /agent` — `[{name, mode, description}]` from the catalog.
async fn list_agents(State(st): State<AppState>) -> Json<Value> {
    Json(st.config.catalog["agents"].clone())
}

/// `POST /api/session/:id/model` — v2 switch, `{model:{id, providerID}}` → 204.
/// The model must exist in the catalog. Recorded on the session; the upstream call
/// still goes to the one configured upstream model (single-provider relay).
async fn switch_model(State(st): State<AppState>, Path(id): Path<String>, Json(body): Json<Value>) -> Response {
    let (Some(mid), Some(pid)) = (body["model"]["id"].as_str(), body["model"]["providerID"].as_str()) else {
        return bad_request("model needs id + providerID");
    };
    let known = st.config.catalog["providers"]
        .as_array()
        .into_iter()
        .flatten()
        .any(|p| p["id"] == pid && p["models"].get(mid).is_some());
    if !known {
        return bad_request(&format!("unknown model {pid}/{mid}"));
    }
    let model = json!({ "id": mid, "providerID": pid });
    match with_session(&st, &id, |s| s.info["model"] = model) {
        Some(()) => StatusCode::NO_CONTENT.into_response(),
        None => not_found(&id),
    }
}

/// `POST /api/session/:id/agent` — v2 switch, `{agent}` → 204. Must be a catalog agent.
async fn switch_agent(State(st): State<AppState>, Path(id): Path<String>, Json(body): Json<Value>) -> Response {
    let Some(name) = body["agent"].as_str() else { return bad_request("agent required") };
    let known = st.config.catalog["agents"].as_array().into_iter().flatten().any(|a| a["name"] == name);
    if !known {
        return bad_request(&format!("unknown agent {name}"));
    }
    match with_session(&st, &id, |s| s.info["agent"] = json!(name)) {
        Some(()) => StatusCode::NO_CONTENT.into_response(),
        None => not_found(&id),
    }
}

/// `GET /event` — global SSE stream of every event for every session.
async fn events(State(st): State<AppState>) -> Response {
    let rx = st.bus.subscribe();
    let hello = futures::stream::once(async { json!({ "type": "server.connected", "properties": {} }) });
    // Lagged receivers just skip what they missed.
    let stream = hello
        .chain(BroadcastStream::new(rx).filter_map(|r| async move { r.ok() }))
        .map(|v| Ok::<_, Infallible>(Event::default().json_data(v).unwrap()));
    Sse::new(stream).keep_alive(KeepAlive::default()).into_response()
}

async fn post_message(
    State(st): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<PostMessage>,
) -> Response {
    // Text parts go upstream; file parts (data: URLs) are stored so the transcript keeps them.
    let parts: Vec<Value> = body
        .parts
        .into_iter()
        .filter(|p| (p["type"] == "text" && p["text"].is_string()) || (p["type"] == "file" && p["url"].is_string()))
        .collect();
    if parts.is_empty() {
        return bad_request("no text or file parts");
    }
    let want_sse = headers
        .get(header::ACCEPT)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|a| a.contains("text/event-stream"));

    // The user message lands at once (a stacked prompt is visible while it waits its turn).
    let user_msg = make_message(&id, "user", parts);
    if with_session(&st, &id, |s| s.messages.push(user_msg.clone())).is_none() {
        return not_found(&id);
    }
    publish(&st, "message.updated", json!({ "info": user_msg["info"] }));

    let lock = st.run_locks.lock().unwrap().entry(id.clone()).or_default().clone();
    let (tx, rx) = mpsc::channel::<Event>(64);
    let (done_tx, done_rx) = oneshot::channel::<Result<Value, String>>();
    tokio::spawn(async move {
        let _turn = lock.lock().await;
        let result = run_turn(&st, &id, &tx).await;
        let _ = done_tx.send(result);
    });

    if want_sse {
        return Sse::new(ReceiverStream::new(rx).map(Ok::<_, Infallible>)).into_response();
    }
    // opencode shape: the POST resolves when the run ends, with the assistant message.
    drop(rx);
    match done_rx.await {
        Ok(Ok(msg)) => Json(msg).into_response(),
        Ok(Err(e)) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e }))).into_response(),
        Err(_) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": "run task died" }))).into_response(),
    }
}

/// Rebuilds the upstream conversation from stored messages. Assistant messages replay
/// their steps: text, then the step's tool calls, then one `tool` message per result —
/// a tool part closes a step, the next text part opens a new one. Unfinished tool parts
/// (no result) are skipped: the upstream rejects a call without its result.
fn upstream_history(messages: &[Value]) -> Vec<Value> {
    fn flush(out: &mut Vec<Value>, text: &mut String, calls: &mut Vec<Value>, results: &mut Vec<Value>) {
        if text.is_empty() && calls.is_empty() {
            return;
        }
        let content = if text.is_empty() { Value::Null } else { json!(text) };
        let mut a = json!({ "role": "assistant", "content": content });
        if !calls.is_empty() {
            a["tool_calls"] = json!(std::mem::take(calls));
        }
        out.push(a);
        out.append(results);
        text.clear();
    }
    let mut out = Vec::new();
    for m in &messages[last_compaction(messages)..] {
        let role = m["info"]["role"].as_str().unwrap_or("user");
        if role != "assistant" {
            let text = if is_compaction(m) { rollup::COMPACTION_ASK.to_string() } else { message_text(m) };
            if !text.is_empty() {
                out.push(json!({ "role": role, "content": text }));
            }
            continue;
        }
        let (mut text, mut calls, mut results) = (String::new(), Vec::new(), Vec::new());
        for p in m["parts"].as_array().into_iter().flatten() {
            match p["type"].as_str() {
                Some("text") => {
                    if !calls.is_empty() {
                        flush(&mut out, &mut text, &mut calls, &mut results);
                    }
                    let t = p["text"].as_str().unwrap_or_default();
                    if !text.is_empty() && !t.is_empty() {
                        text.push('\n');
                    }
                    text.push_str(t);
                }
                Some("tool") => {
                    let state = &p["state"];
                    let status = state["status"].as_str().unwrap_or_default();
                    if status != "completed" && status != "error" {
                        continue;
                    }
                    calls.push(json!({ "id": p["callID"], "type": "function",
                        "function": { "name": p["tool"], "arguments": state["input"].to_string() } }));
                    results.push(json!({ "role": "tool", "tool_call_id": p["callID"], "content": tool_content(state) }));
                }
                _ => {}
            }
        }
        flush(&mut out, &mut text, &mut calls, &mut results);
    }
    out
}

fn is_compaction(msg: &Value) -> bool {
    msg["parts"].as_array().is_some_and(|ps| ps.iter().any(|p| p["type"] == "compaction"))
}

/// Index of the latest compaction message (the upstream history starts there), or 0.
fn last_compaction(messages: &[Value]) -> usize {
    messages.iter().rposition(is_compaction).unwrap_or(0)
}

/// What the model sees for a finished tool part.
fn tool_content(state: &Value) -> String {
    let output = state["output"].as_str().unwrap_or_default();
    if state["status"] == "error" { format!("Error: {output}") } else { output.to_string() }
}

#[derive(Default)]
struct ToolCall {
    id: String,
    name: String,
    arguments: String,
}

/// A run in progress: the assistant message being built (parts appended per step) and
/// the current step's streamed text. Lives outside the loop future so an abort (which
/// drops that future) keeps everything produced so far.
struct Run {
    msg: Value,
    text: String,
}

impl Run {
    fn push_part(&mut self, part: Value) -> usize {
        let mut part = part;
        part["id"] = json!(new_id("prt"));
        part["messageID"] = self.msg["info"]["id"].clone();
        part["sessionID"] = self.msg["info"]["sessionID"].clone();
        let parts = self.msg["parts"].as_array_mut().unwrap();
        parts.push(part);
        parts.len() - 1
    }

    /// Lands the streamed text of the current step as a text part.
    fn flush_text(&mut self) {
        let text = std::mem::take(&mut self.text);
        if !text.is_empty() {
            self.push_part(text_part(&text));
        }
    }

    /// Closes the message: pending text kept, interrupted tool calls marked as errors,
    /// and at least one text part (the PWA reads the reply from text parts).
    fn finish(&mut self, interrupted: &str) {
        self.flush_text();
        let now = now_ms();
        let mut has_text = false;
        for p in self.msg["parts"].as_array_mut().unwrap() {
            has_text |= p["type"] == "text";
            if p["type"] == "tool" && p["state"]["status"] == "running" {
                p["state"]["status"] = json!("error");
                p["state"]["error"] = json!(interrupted);
                p["state"]["output"] = json!(interrupted);
                p["state"]["time"]["end"] = json!(now);
            }
        }
        if !has_text {
            self.push_part(text_part(""));
        }
        self.msg["info"]["time"]["completed"] = json!(now);
    }
}

/// One run, called with the session's run lock held: snapshot history, create the
/// un-completed assistant placeholder, run the agent loop (abortable), store the
/// outcome, then `session.idle`. Returns the final assistant message (aborted ones included).
async fn run_turn(st: &AppState, id: &str, tx: &mpsc::Sender<Event>) -> Result<Value, String> {
    let history = st.sessions.lock().unwrap().get(id).map(|s| s.messages.clone());
    let Some(history) = history else { return Err(format!("session {id} not found")) };

    let cancel = Arc::new(Notify::new());
    st.running.lock().unwrap().insert(id.to_string(), cancel.clone());
    publish(st, "session.status", json!({ "sessionID": id, "status": { "type": "busy" } }));
    let placeholder = make_message(id, "assistant", vec![text_part("")]);
    replace_message(st, id, &placeholder);
    publish(st, "message.updated", json!({ "info": placeholder["info"] }));

    let mut msg = placeholder;
    msg["parts"] = json!([]);
    let mut run = Run { msg, text: String::new() };
    let outcome = {
        let fut = agent_loop(st, id, history, tx, &mut run);
        tokio::select! {
            r = fut => Some(r),
            _ = cancel.notified() => None,
        }
    };
    // Only clear our own entry; a delete may already have removed it.
    {
        let mut running = st.running.lock().unwrap();
        if running.get(id).is_some_and(|n| Arc::ptr_eq(n, &cancel)) {
            running.remove(id);
        }
    }
    let result = match outcome {
        Some(Ok(())) => {
            run.finish("interrupted");
            replace_message(st, id, &run.msg);
            publish(st, "message.updated", json!({ "info": run.msg["info"] }));
            emit(st, tx, "message.completed", run.msg.clone()).await;
            Ok(run.msg)
        }
        Some(Err(e)) => {
            eprintln!("run error: {e}");
            run.finish(&e);
            run.msg["info"]["error"] = json!({ "name": "UnknownError", "data": { "message": e } });
            replace_message(st, id, &run.msg);
            emit(st, tx, "error", json!({ "sessionID": id, "error": e })).await;
            Err(e)
        }
        None => {
            // Keep whatever was streamed/executed, flagged the way opencode flags it.
            run.finish("aborted");
            run.msg["info"]["error"] = json!({ "name": "MessageAbortedError", "data": { "message": "aborted" } });
            replace_message(st, id, &run.msg);
            publish(st, "message.updated", json!({ "info": run.msg["info"] }));
            emit(st, tx, "message.aborted", run.msg.clone()).await;
            Ok(run.msg)
        }
    };
    publish(st, "session.idle", json!({ "sessionID": id }));
    result
}

/// The agent loop: call upstream; no tool calls → done; else execute each call
/// (serially, in order), append the results, call again. At most `max_steps` upstream
/// calls per run — the cap turns a model that never stops calling tools into an error.
async fn agent_loop(
    st: &AppState,
    id: &str,
    messages: Vec<Value>,
    tx: &mpsc::Sender<Event>,
    run: &mut Run,
) -> Result<(), String> {
    let mut convo = rollup_if_needed(st, id, tx, messages).await;
    let max = st.config.max_steps;
    for _ in 0..max {
        if st.config.rollup_tokens > 0 {
            let n = rollup::prune(&mut convo, st.config.rollup_tokens);
            if n > 0 {
                eprintln!("roll-up: pruned {n} old tool output(s) in session {id}");
            }
        }
        let calls = relay(st, id, &convo, tx, &mut run.text).await?;
        let text = run.text.clone();
        run.flush_text();
        if calls.is_empty() {
            return Ok(());
        }
        let calls: Vec<ToolCall> = calls
            .into_iter()
            .map(|mut c| {
                if c.id.is_empty() {
                    c.id = new_id("call");
                }
                c
            })
            .collect();
        convo.push(json!({
            "role": "assistant",
            "content": if text.is_empty() { Value::Null } else { json!(text) },
            "tool_calls": calls.iter().map(|c| json!({ "id": c.id, "type": "function",
                "function": { "name": c.name, "arguments": c.arguments } })).collect::<Vec<_>>(),
        }));
        for call in calls {
            let output = run_tool(st, id, tx, run, &call).await;
            convo.push(json!({ "role": "tool", "tool_call_id": call.id, "content": output }));
        }
    }
    Err(format!("agent loop hit the step cap ({max} upstream calls) without a final reply"))
}

/// Slice 6b. Over the token limit at run start: summarize everything before the recent
/// tail with one extra upstream call, store the compaction pair in front of the tail, and
/// return the shortened upstream history. Any failure keeps the full history (logged).
async fn rollup_if_needed(st: &AppState, id: &str, tx: &mpsc::Sender<Event>, messages: Vec<Value>) -> Vec<Value> {
    let convo = upstream_history(&messages);
    let limit = st.config.rollup_tokens;
    if limit == 0 || rollup::est_tokens(&convo) <= limit {
        return convo;
    }
    // The tail starts at a user message and fits the keep budget (the current prompt always stays).
    let start = last_compaction(&messages);
    let live = &messages[start..];
    let (mut cut, mut acc) = (None, 0);
    for i in (0..live.len()).rev() {
        acc += rollup::est_tokens(&upstream_history(&live[i..=i]));
        if acc > st.config.rollup_keep_tokens && cut.is_some() {
            break;
        }
        if live[i]["info"]["role"] == "user" && !is_compaction(&live[i]) {
            cut = Some(i);
        }
    }
    let cut = cut.unwrap_or(0);
    let covered = upstream_history(&live[..cut]);
    if !live[..cut].iter().any(|m| !is_compaction(m) && m["info"]["summary"] != true) {
        return convo; // nothing new to fold in; in-run pruning is all that's left
    }
    let req = json!([
        { "role": "system", "content": rollup::PROMPT },
        { "role": "user", "content": rollup::transcript(&covered) },
    ]);
    let summary = match summarize(st, &req).await {
        Ok(s) if !s.trim().is_empty() => s,
        Ok(_) => {
            eprintln!("roll-up {id}: empty summary, keeping full history");
            return convo;
        }
        Err(e) => {
            eprintln!("roll-up {id}: {e}; keeping full history");
            return convo;
        }
    };
    let ask = make_message(id, "user", vec![json!({ "type": "compaction", "auto": true })]);
    let mut sum = make_message(id, "assistant", vec![text_part(&summary)]);
    sum["info"]["summary"] = json!(true);
    sum["info"]["mode"] = json!("compaction");
    sum["info"]["time"]["completed"] = json!(now_ms());
    let anchor = live[cut]["info"]["id"].clone();
    with_session(st, id, |s| {
        let at = s.messages.iter().position(|m| m["info"]["id"] == anchor).unwrap_or(s.messages.len());
        s.messages.splice(at..at, [ask.clone(), sum.clone()]);
    });
    for m in [&ask, &sum] {
        publish(st, "message.updated", json!({ "info": m["info"] }));
    }
    let before = rollup::est_tokens(&convo);
    let mut rolled: Vec<Value> = messages[..start + cut].to_vec();
    rolled.extend([ask, sum.clone()]);
    rolled.extend_from_slice(&live[cut..]);
    let convo = upstream_history(&rolled);
    let after = rollup::est_tokens(&convo);
    eprintln!("roll-up {id}: {cut} message(s) summarized, ~{before} -> ~{after} tokens");
    emit(st, tx, "session.compacted", json!({ "sessionID": id, "messageID": sum["info"]["id"],
        "summarized": cut, "tokensBefore": before, "tokensAfter": after })).await;
    convo
}

/// The roll-up's extra upstream call: no tools, no streaming to the client.
async fn summarize(st: &AppState, messages: &Value) -> Result<String, String> {
    let cfg = &st.config;
    if cfg.dialect == Dialect::Anthropic {
        return summarize_anthropic(st, messages).await;
    }
    let url = format!("{}/chat/completions", cfg.base_url.trim_end_matches('/'));
    let mut req = st.http.post(&url).json(&json!({ "model": cfg.model, "messages": messages, "stream": false }));
    if let Some(key) = &cfg.api_key {
        req = req.bearer_auth(key);
    }
    let resp = req.send().await.map_err(|e| format!("request failed: {e}"))?;
    let status = resp.status();
    let body = resp.text().await.map_err(|e| format!("read failed: {e}"))?;
    if !status.is_success() {
        return Err(format!("upstream {status}: {body}"));
    }
    if let Ok(v) = serde_json::from_str::<Value>(&body) {
        return Ok(v["choices"][0]["message"]["content"].as_str().unwrap_or_default().to_string());
    }
    // Some providers stream regardless of `stream: false`.
    Ok(body
        .lines()
        .filter_map(|l| l.trim().strip_prefix("data:"))
        .filter_map(|d| serde_json::from_str::<Value>(d.trim()).ok())
        .filter_map(|v| v["choices"][0]["delta"]["content"].as_str().map(String::from))
        .collect())
}

/// Executes one call: stores a running tool part, emits `message.part.updated`, runs it,
/// stores + emits the finished part, checkpoints the message to disk. Returns what the
/// model gets back.
async fn run_tool(st: &AppState, id: &str, tx: &mpsc::Sender<Event>, run: &mut Run, call: &ToolCall) -> String {
    let args = if call.arguments.trim().is_empty() { "{}" } else { call.arguments.as_str() };
    let parsed = serde_json::from_str::<Value>(args).map_err(|e| format!("invalid JSON arguments: {e}"));
    let input = parsed.as_ref().ok().cloned().unwrap_or_else(|| json!({ "raw": call.arguments }));
    let start = now_ms();
    let idx = run.push_part(json!({
        "type": "tool", "callID": call.id, "tool": call.name,
        "state": { "status": "running", "input": input, "time": { "start": start } },
    }));
    let part = run.msg["parts"][idx].clone();
    replace_message(st, id, &run.msg);
    emit(st, tx, "message.part.updated", json!({ "sessionID": id, "part": part })).await;

    let res = match parsed {
        Ok(input) => tools::run(&st.tools, &call.name, &input).await,
        Err(e) => tools::ToolResult { ok: false, title: call.name.clone(), output: e, metadata: json!({}) },
    };
    if call.name == "todowrite" && res.ok {
        let todos = res.metadata["todos"].as_array().cloned().unwrap_or_default();
        with_session(st, id, |s| s.todo = todos.clone());
        publish(st, "todo.updated", json!({ "sessionID": id, "todos": todos }));
    }
    let state = &mut run.msg["parts"][idx]["state"];
    state["status"] = json!(if res.ok { "completed" } else { "error" });
    state["title"] = json!(res.title);
    state["output"] = json!(res.output);
    if !res.ok {
        state["error"] = json!(res.output);
    }
    state["metadata"] = res.metadata;
    state["time"]["end"] = json!(now_ms());
    let content = tool_content(state);
    let part = run.msg["parts"][idx].clone();
    replace_message(st, id, &run.msg);
    emit(st, tx, "message.part.updated", json!({ "sessionID": id, "part": part })).await;
    content
}

/// One upstream call with `stream: true` (and the tool set): forwards each content delta
/// as an SSE event, accumulating it into `full` (an abort keeps the partial text), and
/// assembles streamed `tool_calls` fragments by index. Also accepts a non-streaming
/// JSON reply.
async fn relay(
    st: &AppState,
    session_id: &str,
    convo: &[Value],
    tx: &mpsc::Sender<Event>,
    full: &mut String,
) -> Result<Vec<ToolCall>, String> {
    let cfg = &st.config;
    if cfg.dialect == Dialect::Anthropic {
        return relay_anthropic(st, session_id, convo, tx, full).await;
    }
    let url = format!("{}/chat/completions", cfg.base_url.trim_end_matches('/'));
    let mut body = json!({ "model": cfg.model, "messages": convo, "stream": true });
    if cfg.tools_enabled {
        body["tools"] = tools::schemas();
    }
    let mut req = st.http.post(&url).json(&body);
    if let Some(key) = &cfg.api_key {
        req = req.bearer_auth(key);
    }
    let resp = req.send().await.map_err(|e| format!("request failed: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("upstream {status}: {body}"));
    }

    let mut calls: Vec<ToolCall> = Vec::new();
    let is_json = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|ct| ct.starts_with("application/json"));
    if is_json {
        let v: Value = resp.json().await.map_err(|e| format!("bad json: {e}"))?;
        let m = &v["choices"][0]["message"];
        let text = m["content"].as_str().unwrap_or_default();
        full.push_str(text);
        send_delta(st, session_id, tx, text).await;
        for tc in m["tool_calls"].as_array().into_iter().flatten() {
            calls.push(ToolCall {
                id: tc["id"].as_str().unwrap_or_default().into(),
                name: tc["function"]["name"].as_str().unwrap_or_default().into(),
                arguments: tc["function"]["arguments"].as_str().unwrap_or_default().into(),
            });
        }
        return Ok(calls);
    }

    let mut buf = String::new();
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("stream error: {e}"))?;
        buf.push_str(&String::from_utf8_lossy(&chunk));
        while let Some(nl) = buf.find('\n') {
            let line: String = buf.drain(..=nl).collect();
            let Some(data) = line.trim().strip_prefix("data:") else { continue };
            let data = data.trim();
            if data == "[DONE]" {
                return Ok(calls);
            }
            let Ok(v) = serde_json::from_str::<Value>(data) else { continue };
            let delta = &v["choices"][0]["delta"];
            if let Some(text) = delta["content"].as_str() {
                full.push_str(text);
                send_delta(st, session_id, tx, text).await;
            }
            for tc in delta["tool_calls"].as_array().into_iter().flatten() {
                let i = tc["index"].as_u64().unwrap_or(0) as usize;
                if calls.len() <= i {
                    calls.resize_with(i + 1, ToolCall::default);
                }
                let c = &mut calls[i];
                if let Some(id) = tc["id"].as_str() {
                    c.id = id.into();
                }
                if let Some(n) = tc["function"]["name"].as_str() {
                    c.name.push_str(n);
                }
                if let Some(a) = tc["function"]["arguments"].as_str() {
                    c.arguments.push_str(a);
                }
            }
        }
    }
    Ok(calls)
}

/// Slice 7: an anthropic-dialect request — `{base}/v1/messages`, the key as both
/// `x-api-key` and bearer (providers differ), `anthropic-version`.
fn anthropic_request(st: &AppState, convo: &[Value], tools: Option<&Value>, stream: bool) -> reqwest::RequestBuilder {
    let cfg = &st.config;
    let body = anthropic::body(&cfg.model, cfg.max_tokens, convo, tools, stream);
    let mut req = st.http.post(anthropic::messages_url(&cfg.base_url)).json(&body).header("anthropic-version", anthropic::VERSION);
    if let Some(key) = &cfg.api_key {
        req = req.header("x-api-key", key).bearer_auth(key);
    }
    req
}

/// `relay` in the anthropic dialect: same contract — text deltas forwarded and accumulated
/// into `full`, tool calls returned in block order. Tool-use ids are re-keyed to yggdrasil
/// `call_` ids (consistent within the conversation we send back), so a stored transcript
/// does not reveal which dialect served it.
async fn relay_anthropic(
    st: &AppState,
    session_id: &str,
    convo: &[Value],
    tx: &mpsc::Sender<Event>,
    full: &mut String,
) -> Result<Vec<ToolCall>, String> {
    let cfg = &st.config;
    let tools = cfg.tools_enabled.then(tools::schemas);
    let resp = anthropic_request(st, convo, tools.as_ref(), true).send().await.map_err(|e| format!("request failed: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("upstream {status}: {body}"));
    }
    let rekey = |calls: Vec<anthropic::Call>| -> Vec<ToolCall> {
        calls.into_iter().map(|c| ToolCall { id: new_id("call"), name: c.name, arguments: c.args }).collect()
    };
    let is_json = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|ct| ct.starts_with("application/json"));
    if is_json {
        let v: Value = resp.json().await.map_err(|e| format!("bad json: {e}"))?;
        if v["type"] == "error" {
            return Err(format!("upstream error: {}", v["error"]));
        }
        let (text, calls, stop) = anthropic::parse_message(&v);
        if stop.as_deref() == Some("max_tokens") {
            eprintln!("upstream stopped at max_tokens ({}); raise YGG_MAX_TOKENS", cfg.max_tokens);
        }
        full.push_str(&text);
        send_delta(st, session_id, tx, &text).await;
        return Ok(rekey(calls));
    }
    let (mut lines, mut dec) = (anthropic::SseLines::default(), anthropic::Stream::default());
    let mut stream = resp.bytes_stream();
    'read: while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("stream error: {e}"))?;
        for data in lines.push(&chunk) {
            let Ok(v) = serde_json::from_str::<Value>(&data) else { continue };
            if let Some(text) = dec.feed(&v)? {
                full.push_str(&text);
                send_delta(st, session_id, tx, &text).await;
            }
            if dec.stopped {
                break 'read;
            }
        }
    }
    if dec.stop_reason.as_deref() == Some("max_tokens") {
        eprintln!("upstream stopped at max_tokens ({}); raise YGG_MAX_TOKENS", cfg.max_tokens);
    }
    Ok(rekey(dec.calls))
}

/// The roll-up call in the anthropic dialect: the summarizer prompt rides in `system`.
async fn summarize_anthropic(st: &AppState, messages: &Value) -> Result<String, String> {
    let convo = messages.as_array().cloned().unwrap_or_default();
    let resp = anthropic_request(st, &convo, None, false).send().await.map_err(|e| format!("request failed: {e}"))?;
    let status = resp.status();
    let body = resp.text().await.map_err(|e| format!("read failed: {e}"))?;
    if !status.is_success() {
        return Err(format!("upstream {status}: {body}"));
    }
    if let Ok(v) = serde_json::from_str::<Value>(&body) {
        if v["type"] == "error" {
            return Err(format!("upstream error: {}", v["error"]));
        }
        return Ok(anthropic::parse_message(&v).0);
    }
    // Some providers stream regardless of `stream: false`.
    let mut dec = anthropic::Stream::default();
    let mut out = String::new();
    for data in anthropic::SseLines::default().push(format!("{body}\n").as_bytes()) {
        if let Ok(v) = serde_json::from_str::<Value>(&data) {
            out.push_str(&dec.feed(&v)?.unwrap_or_default());
        }
    }
    Ok(out)
}

async fn send_delta(st: &AppState, session_id: &str, tx: &mpsc::Sender<Event>, text: &str) {
    if text.is_empty() {
        return;
    }
    emit(st, tx, "message.part.delta", json!({ "sessionID": session_id, "text": text })).await;
}

fn load_catalog(model: &str) -> Value {
    if let Ok(path) = std::env::var("YGG_CATALOG") {
        let parsed = std::fs::read(&path)
            .map_err(|e| e.to_string())
            .and_then(|b| serde_json::from_slice::<Value>(&b).map_err(|e| e.to_string()));
        match parsed {
            Ok(c) => return c,
            Err(e) => {
                eprintln!("YGG_CATALOG {path}: {e}");
                std::process::exit(2);
            }
        }
    }
    json!({
        "providers": [{ "id": "yggdrasil", "name": "yggdrasil", "models": { model: { "id": model, "name": model, "providerID": "yggdrasil" } } }],
        "default": { "yggdrasil": model },
        "agents": [
            { "name": "build", "mode": "primary", "description": "default agent" },
            { "name": "plan", "mode": "primary", "description": "planning agent" },
        ],
    })
}

#[tokio::main]
async fn main() {
    let base_url = std::env::var("YGG_UPSTREAM_BASE_URL").ok().filter(|u| !u.is_empty()).unwrap_or_else(|| {
        eprintln!("YGG_UPSTREAM_BASE_URL is required");
        std::process::exit(2);
    });
    let model = std::env::var("YGG_UPSTREAM_MODEL").unwrap_or_else(|_| "gpt-4o-mini".into());
    let env_num = |k: &str, default: u64| -> u64 {
        match std::env::var(k) {
            Ok(v) if !v.is_empty() => v.parse().unwrap_or_else(|_| {
                eprintln!("{k}: not a number: {v}");
                std::process::exit(2);
            }),
            _ => default,
        }
    };
    let rollup_tokens = env_num("YGG_ROLLUP_TOKENS", 100_000);
    let dialect = match std::env::var("YGG_UPSTREAM_STYLE").unwrap_or_default().to_ascii_lowercase().as_str() {
        "" | "openai" => Dialect::OpenAi,
        "anthropic" => Dialect::Anthropic,
        other => {
            eprintln!("YGG_UPSTREAM_STYLE: unknown dialect {other:?} (openai | anthropic)");
            std::process::exit(2);
        }
    };
    let upstream_url = match dialect {
        Dialect::OpenAi => format!("{}/chat/completions", base_url.trim_end_matches('/')),
        Dialect::Anthropic => anthropic::messages_url(&base_url),
    };
    eprintln!("upstream: {dialect:?} dialect, POST {upstream_url}");
    let config = Config {
        base_url,
        dialect,
        max_tokens: env_num("YGG_MAX_TOKENS", 16_384).max(1),
        api_key: std::env::var("YGG_UPSTREAM_API_KEY").ok().filter(|k| !k.is_empty()),
        catalog: load_catalog(&model),
        model,
        max_steps: env_num("YGG_MAX_STEPS", 100).max(1) as usize,
        tools_enabled: std::env::var("YGG_TOOLS").map_or(true, |v| v != "0"),
        rollup_tokens: rollup_tokens as usize,
        rollup_keep_tokens: env_num("YGG_ROLLUP_KEEP_TOKENS", rollup_tokens / 4) as usize,
    };
    let project_dir = match std::env::var("YGG_PROJECT_DIR") {
        Ok(d) if !d.is_empty() => PathBuf::from(d),
        _ => std::env::current_dir().expect("cwd"),
    };
    let project_dir = project_dir.canonicalize().unwrap_or_else(|e| {
        eprintln!("YGG_PROJECT_DIR {}: {e}", project_dir.display());
        std::process::exit(2);
    });
    let http = reqwest::Client::new();
    let tool_env = tools::ToolEnv {
        project_dir,
        bash_timeout: Duration::from_millis(env_num("YGG_BASH_TIMEOUT_MS", 120_000)),
        http: http.clone(),
    };
    eprintln!("tools {} in {}", if config.tools_enabled { "on" } else { "off" }, tool_env.project_dir.display());
    let listen = std::env::var("YGG_LISTEN").unwrap_or_else(|_| "127.0.0.1:4096".into());
    let data_dir = PathBuf::from(std::env::var("YGG_DATA_DIR").unwrap_or_else(|_| "./data".into()));
    std::fs::create_dir_all(data_dir.join("session")).expect("create YGG_DATA_DIR");
    let sessions = load_sessions(&data_dir);
    eprintln!("loaded {} session(s) from {}", sessions.len(), data_dir.display());

    let state = AppState {
        sessions: Arc::new(Mutex::new(sessions)),
        running: Arc::default(),
        run_locks: Arc::default(),
        bus: broadcast::channel(1024).0,
        data_dir: Arc::new(data_dir),
        config: Arc::new(config),
        http,
        tools: Arc::new(tool_env),
    };
    let app = Router::new()
        .route("/session", get(list_sessions).post(create_session))
        .route("/session/status", get(session_status))
        .route("/session/{id}", get(get_session).patch(patch_session).delete(delete_session))
        .route("/session/{id}/message", get(list_messages).post(post_message))
        .route("/session/{id}/abort", post(abort_session))
        .route("/session/{id}/todo", get(get_todo))
        .route("/api/session/{id}/model", post(switch_model))
        .route("/api/session/{id}/agent", post(switch_agent))
        .route("/config/providers", get(config_providers))
        .route("/agent", get(list_agents))
        .route("/event", get(events))
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(&listen).await.expect("bind");
    eprintln!("yggdrasil listening on {listen}");
    axum::serve(listener, app).await.unwrap();
}
