//! YGGDRASIL slice 2: sessions + message relay to an OpenAI-compatible chat
//! endpoint, streamed back as SSE; abort; global `/event` bus; on-disk store.
//!
//! Env:
//!   YGG_UPSTREAM_BASE_URL  e.g. https://api.openai.com/v1  (required; `/chat/completions` is appended)
//!   YGG_UPSTREAM_API_KEY   bearer token (optional; omitted header if unset)
//!   YGG_UPSTREAM_MODEL     model name (default: gpt-4o-mini)
//!   YGG_LISTEN             bind address (default: 127.0.0.1:4096)
//!   YGG_DATA_DIR           on-disk store (default: ./data); one `session/<id>.json` per session

use std::{
    collections::HashMap,
    convert::Infallible,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

use axum::{
    Json, Router,
    extract::{Path, State},
    http::StatusCode,
    response::{
        IntoResponse, Response,
        sse::{Event, KeepAlive, Sse},
    },
    routing::{get, post},
};
use futures::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::{Notify, broadcast, mpsc};
use tokio_stream::wrappers::{BroadcastStream, ReceiverStream};

struct Config {
    base_url: String,
    api_key: Option<String>,
    model: String,
}

#[derive(Serialize, Deserialize)]
struct Session {
    info: Value,
    messages: Vec<Value>,
}

#[derive(Clone)]
struct AppState {
    sessions: Arc<Mutex<HashMap<String, Session>>>,
    /// In-flight replies, keyed by session id; notified by `POST /session/:id/abort`.
    running: Arc<Mutex<HashMap<String, Arc<Notify>>>>,
    /// Global event bus feeding `GET /event`: `{type, properties}` JSON, opencode-style.
    bus: broadcast::Sender<Value>,
    data_dir: Arc<PathBuf>,
    config: Arc<Config>,
    http: reqwest::Client,
}

#[derive(Deserialize)]
struct PostMessage {
    #[serde(default)]
    parts: Vec<Part>,
}

#[derive(Deserialize)]
struct Part {
    #[serde(rename = "type", default)]
    kind: String,
    #[serde(default)]
    text: String,
}

fn now_ms() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis()
}

fn new_id(prefix: &str) -> String {
    format!("{prefix}_{}", uuid::Uuid::new_v4().simple())
}

fn make_message(session_id: &str, role: &str, text: &str) -> Value {
    let id = new_id("msg");
    json!({
        "info": { "id": id, "sessionID": session_id, "role": role, "time": { "created": now_ms() } },
        "parts": [ { "id": new_id("prt"), "messageID": id, "sessionID": session_id, "type": "text", "text": text } ],
    })
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

/// Appends a message to a session and persists it. Returns false if the session is gone.
fn push_message(st: &AppState, id: &str, msg: Value) -> bool {
    let mut sessions = st.sessions.lock().unwrap();
    let Some(s) = sessions.get_mut(id) else { return false };
    s.messages.push(msg);
    persist(&st.data_dir, id, s);
    true
}

/// Sends an event to the posting client's stream (named SSE event, slice-1 shape)
/// and to the global bus (`{type, properties}`).
async fn emit(st: &AppState, tx: &mpsc::Sender<Event>, kind: &str, props: Value) {
    let _ = st.bus.send(json!({ "type": kind, "properties": props }));
    // The posting client may have gone away; the reply keeps going for /event listeners.
    let _ = tx.send(Event::default().event(kind).json_data(props).unwrap()).await;
}

async fn create_session(State(st): State<AppState>) -> Json<Value> {
    let id = new_id("ses");
    let info = json!({ "id": id, "title": "New session", "time": { "created": now_ms() } });
    let session = Session { info: info.clone(), messages: Vec::new() };
    {
        let mut sessions = st.sessions.lock().unwrap();
        persist(&st.data_dir, &id, &session);
        sessions.insert(id, session);
    }
    let _ = st.bus.send(json!({ "type": "session.created", "properties": { "info": info } }));
    Json(info)
}

async fn list_sessions(State(st): State<AppState>) -> Json<Value> {
    let sessions = st.sessions.lock().unwrap();
    let mut infos: Vec<Value> = sessions.values().map(|s| s.info.clone()).collect();
    infos.sort_by_key(|i| i["time"]["created"].as_u64().unwrap_or(0));
    Json(Value::Array(infos))
}

async fn list_messages(State(st): State<AppState>, Path(id): Path<String>) -> Response {
    match st.sessions.lock().unwrap().get(&id) {
        Some(s) => Json(Value::Array(s.messages.clone())).into_response(),
        None => not_found(&id),
    }
}

fn not_found(id: &str) -> Response {
    (StatusCode::NOT_FOUND, Json(json!({ "error": format!("session {id} not found") }))).into_response()
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

/// `GET /event` — global SSE stream of every event for every session.
async fn events(State(st): State<AppState>) -> Response {
    let rx = st.bus.subscribe();
    let hello = futures::stream::once(async {
        json!({ "type": "server.connected", "properties": {} })
    });
    // Lagged receivers just skip what they missed.
    let stream = hello
        .chain(BroadcastStream::new(rx).filter_map(|r| async move { r.ok() }))
        .map(|v| Ok::<_, Infallible>(Event::default().json_data(v).unwrap()));
    Sse::new(stream).keep_alive(KeepAlive::default()).into_response()
}

async fn post_message(
    State(st): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<PostMessage>,
) -> Response {
    let text = body
        .parts
        .iter()
        .filter(|p| p.kind == "text")
        .map(|p| p.text.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    if text.is_empty() {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "no text parts" }))).into_response();
    }

    // Append the user message and snapshot history for the upstream call.
    let user_msg = make_message(&id, "user", &text);
    let history: Vec<Value> = {
        let mut sessions = st.sessions.lock().unwrap();
        let Some(session) = sessions.get_mut(&id) else { return not_found(&id) };
        session.messages.push(user_msg.clone());
        persist(&st.data_dir, &id, session);
        session
            .messages
            .iter()
            .map(|m| json!({ "role": m["info"]["role"], "content": message_text(m) }))
            .collect()
    };
    let _ = st.bus.send(json!({ "type": "message.updated", "properties": user_msg }));

    let cancel = Arc::new(Notify::new());
    st.running.lock().unwrap().insert(id.clone(), cancel.clone());

    let (tx, rx) = mpsc::channel::<Event>(64);
    tokio::spawn(async move {
        let mut partial = String::new();
        let outcome = {
            let fut = relay(&st, &id, history, &tx, &mut partial);
            tokio::select! {
                r = fut => Some(r),
                _ = cancel.notified() => None,
            }
        };
        // Only clear our own entry; a newer post may have replaced it.
        {
            let mut running = st.running.lock().unwrap();
            if running.get(&id).is_some_and(|n| Arc::ptr_eq(n, &cancel)) {
                running.remove(&id);
            }
        }
        match outcome {
            Some(Ok(reply)) => {
                let msg = make_message(&id, "assistant", &reply);
                push_message(&st, &id, msg.clone());
                emit(&st, &tx, "message.completed", msg).await;
            }
            Some(Err(e)) => {
                eprintln!("upstream error: {e}");
                emit(&st, &tx, "error", json!({ "sessionID": id, "error": e })).await;
            }
            None => {
                // Keep whatever was streamed, flagged the way opencode flags it.
                let mut msg = make_message(&id, "assistant", &partial);
                msg["info"]["error"] = json!({ "name": "MessageAbortedError", "data": { "message": "aborted" } });
                push_message(&st, &id, msg.clone());
                emit(&st, &tx, "message.aborted", msg).await;
            }
        }
    });

    Sse::new(ReceiverStream::new(rx).map(Ok::<_, Infallible>)).into_response()
}

/// Calls the upstream with `stream: true`, forwarding each content delta as an SSE
/// event and accumulating it into `full` (so an abort can keep the partial text).
/// Also accepts a non-streaming JSON reply.
async fn relay(
    st: &AppState,
    session_id: &str,
    history: Vec<Value>,
    tx: &mpsc::Sender<Event>,
    full: &mut String,
) -> Result<String, String> {
    let cfg = &st.config;
    let url = format!("{}/chat/completions", cfg.base_url.trim_end_matches('/'));
    let mut req = st
        .http
        .post(&url)
        .json(&json!({ "model": cfg.model, "messages": history, "stream": true }));
    if let Some(key) = &cfg.api_key {
        req = req.bearer_auth(key);
    }
    let resp = req.send().await.map_err(|e| format!("request failed: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("upstream {status}: {body}"));
    }

    let is_json = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|ct| ct.starts_with("application/json"));
    if is_json {
        let v: Value = resp.json().await.map_err(|e| format!("bad json: {e}"))?;
        let text = v["choices"][0]["message"]["content"].as_str().unwrap_or_default();
        full.push_str(text);
        send_delta(st, session_id, tx, text).await;
        return Ok(full.clone());
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
                return Ok(full.clone());
            }
            let Ok(v) = serde_json::from_str::<Value>(data) else { continue };
            if let Some(delta) = v["choices"][0]["delta"]["content"].as_str() {
                full.push_str(delta);
                send_delta(st, session_id, tx, delta).await;
            }
        }
    }
    Ok(full.clone())
}

async fn send_delta(st: &AppState, session_id: &str, tx: &mpsc::Sender<Event>, text: &str) {
    if text.is_empty() {
        return;
    }
    emit(st, tx, "message.part.delta", json!({ "sessionID": session_id, "text": text })).await;
}

#[tokio::main]
async fn main() {
    let base_url = std::env::var("YGG_UPSTREAM_BASE_URL").unwrap_or_else(|_| {
        eprintln!("YGG_UPSTREAM_BASE_URL is required");
        std::process::exit(2);
    });
    let config = Config {
        base_url,
        api_key: std::env::var("YGG_UPSTREAM_API_KEY").ok().filter(|k| !k.is_empty()),
        model: std::env::var("YGG_UPSTREAM_MODEL").unwrap_or_else(|_| "gpt-4o-mini".into()),
    };
    let listen = std::env::var("YGG_LISTEN").unwrap_or_else(|_| "127.0.0.1:4096".into());
    let data_dir = PathBuf::from(std::env::var("YGG_DATA_DIR").unwrap_or_else(|_| "./data".into()));
    std::fs::create_dir_all(data_dir.join("session")).expect("create YGG_DATA_DIR");
    let sessions = load_sessions(&data_dir);
    eprintln!("loaded {} session(s) from {}", sessions.len(), data_dir.display());

    let state = AppState {
        sessions: Arc::new(Mutex::new(sessions)),
        running: Arc::default(),
        bus: broadcast::channel(1024).0,
        data_dir: Arc::new(data_dir),
        config: Arc::new(config),
        http: reqwest::Client::new(),
    };
    let app = Router::new()
        .route("/session", get(list_sessions).post(create_session))
        .route("/session/{id}/message", get(list_messages).post(post_message))
        .route("/session/{id}/abort", post(abort_session))
        .route("/event", get(events))
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(&listen).await.expect("bind");
    eprintln!("yggdrasil listening on {listen}");
    axum::serve(listener, app).await.unwrap();
}
