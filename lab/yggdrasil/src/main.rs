//! YGGDRASIL slice 3: an opencode-compatible surface that bifrost's PWA proxy can
//! drive unchanged. Sessions + message relay to an OpenAI-compatible chat endpoint;
//! abort; global `/event` bus; on-disk store; per-session run serialization;
//! session get/patch/delete, busy map, model/agent catalog + v2 switches.
//!
//! Env:
//!   YGG_UPSTREAM_BASE_URL  e.g. https://api.openai.com/v1  (required; `/chat/completions` is appended)
//!   YGG_UPSTREAM_API_KEY   bearer token (optional; omitted header if unset)
//!   YGG_UPSTREAM_MODEL     model name (default: gpt-4o-mini)
//!   YGG_LISTEN             bind address (default: 127.0.0.1:4096)
//!   YGG_DATA_DIR           on-disk store (default: ./data); one `session/<id>.json` per session
//!   YGG_CATALOG            JSON file `{providers:[...], agents:[...]}` served as
//!                          `/config/providers` + `/agent` (default: one provider = the upstream model,
//!                          agents build + plan)
//!
//! `POST /session/:id/message` answers like opencode (blocks, returns the final assistant
//! message as JSON) unless the request sends `Accept: text/event-stream`, which gets the
//! slice-1 per-request SSE relay.

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

struct Config {
    base_url: String,
    api_key: Option<String>,
    model: String,
    catalog: Value,
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
    /// One run at a time per session (opencode serializes; stacked prompts wait their turn).
    run_locks: Arc<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>>,
    /// Global event bus feeding `GET /event`: `{type, properties}` JSON, opencode-style.
    bus: broadcast::Sender<Value>,
    data_dir: Arc<PathBuf>,
    config: Arc<Config>,
    http: reqwest::Client,
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
    let session = Session { info: info.clone(), messages: Vec::new() };
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

/// One run, called with the session's run lock held: snapshot history, create the
/// un-completed assistant placeholder, relay upstream (abortable), store the outcome,
/// then `session.idle`. Returns the final assistant message (aborted ones included).
async fn run_turn(st: &AppState, id: &str, tx: &mpsc::Sender<Event>) -> Result<Value, String> {
    let history: Option<Vec<Value>> = st.sessions.lock().unwrap().get(id).map(|s| {
        s.messages
            .iter()
            .map(|m| (m["info"]["role"].clone(), message_text(m)))
            .filter(|(_, text)| !text.is_empty())
            .map(|(role, text)| json!({ "role": role, "content": text }))
            .collect()
    });
    let Some(history) = history else { return Err(format!("session {id} not found")) };

    let cancel = Arc::new(Notify::new());
    st.running.lock().unwrap().insert(id.to_string(), cancel.clone());
    publish(st, "session.status", json!({ "sessionID": id, "status": { "type": "busy" } }));
    let mut msg = make_message(id, "assistant", vec![text_part("")]);
    replace_message(st, id, &msg);
    publish(st, "message.updated", json!({ "info": msg["info"] }));

    let mut partial = String::new();
    let outcome = {
        let fut = relay(st, id, history, tx, &mut partial);
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
    msg["info"]["time"]["completed"] = json!(now_ms());
    let result = match outcome {
        Some(Ok(reply)) => {
            msg["parts"][0]["text"] = json!(reply);
            replace_message(st, id, &msg);
            publish(st, "message.updated", json!({ "info": msg["info"] }));
            emit(st, tx, "message.completed", msg.clone()).await;
            Ok(msg)
        }
        Some(Err(e)) => {
            eprintln!("upstream error: {e}");
            msg["parts"][0]["text"] = json!(partial);
            msg["info"]["error"] = json!({ "name": "UnknownError", "data": { "message": e } });
            replace_message(st, id, &msg);
            emit(st, tx, "error", json!({ "sessionID": id, "error": e })).await;
            Err(e)
        }
        None => {
            // Keep whatever was streamed, flagged the way opencode flags it.
            msg["parts"][0]["text"] = json!(partial);
            msg["info"]["error"] = json!({ "name": "MessageAbortedError", "data": { "message": "aborted" } });
            replace_message(st, id, &msg);
            publish(st, "message.updated", json!({ "info": msg["info"] }));
            emit(st, tx, "message.aborted", msg.clone()).await;
            Ok(msg)
        }
    };
    publish(st, "session.idle", json!({ "sessionID": id }));
    result
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
    let mut req = st.http.post(&url).json(&json!({ "model": cfg.model, "messages": history, "stream": true }));
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
    let config = Config {
        base_url,
        api_key: std::env::var("YGG_UPSTREAM_API_KEY").ok().filter(|k| !k.is_empty()),
        catalog: load_catalog(&model),
        model,
    };
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
        http: reqwest::Client::new(),
    };
    let app = Router::new()
        .route("/session", get(list_sessions).post(create_session))
        .route("/session/status", get(session_status))
        .route("/session/{id}", get(get_session).patch(patch_session).delete(delete_session))
        .route("/session/{id}/message", get(list_messages).post(post_message))
        .route("/session/{id}/abort", post(abort_session))
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
