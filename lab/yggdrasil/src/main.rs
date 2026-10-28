//! YGGDRASIL (slices 1-7): an opencode-compatible surface that bifrost's PWA proxy can
//! drive unchanged. Sessions + message relay to an OpenAI- or Anthropic-compatible endpoint;
//! abort; global `/event` bus; on-disk store; per-session run serialization;
//! session get/patch/delete, busy map, model/agent catalog + v2 switches.
//! Herdr fold (10-24): the run loop DECLARES a triad state per session — working / blocked
//! (reason: error | step-cap | interrupted) / idle — served on every session info (`state`),
//! as `GET /session/state` and the `session.state` event; the busy map is its projection.
//! A restart closes runs the dead process left open and declares them blocked/interrupted.
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
//!   YGG_CONTEXT_FILES      OG-ctx (10-27): `:`-separated context files injected as the run's system
//!                          message, re-read every run (default: `<project dir>/AGENTS.md`; missing = skipped)
//!   YGG_MAX_STEPS          upstream calls per run before the loop gives up (default: 100)
//!   YGG_BASH_TIMEOUT_MS    default bash tool timeout (default: 120000)
//!   YGG_TOOLS              `0` = don't declare tools (plain relay, for tool-less upstreams)
//!   YGG_ROLLUP_TOKENS      slice 6b: estimated-token limit for the upstream history (default 100000,
//!                          `0` = off); over it, older history is summarized (`rollup.rs`)
//!   YGG_ROLLUP_KEEP_TOKENS recent history kept verbatim at a roll-up (default: limit / 4)
//!   YGG_PROVIDERS          PROVIDER-WAVE (10-28): opencode-shaped providers file (default
//!                          `~/.config/yggdrasil/providers.json`, read if present, re-read on change):
//!                          more providers beside the env one, the default `model`, the `fallback` order
//!   YGG_FALLBACK           `pid/mid,…` — the degrade order, overrides the file's (`provider.rs`)
//!
//! PROVIDER-WAVE (10-28): each upstream call walks the chain (the session's model or the default,
//! then the fallbacks); a provider that answers quota/rate-limit/auth/overload/down is cooled until
//! its reset and the call degrades to the next one (`provider.fallback` event, `info.fallback`).
//! A run that still fails ends as an opencode-shaped error turn: `info.error` (`APIError` /
//! `ProviderAuthError` with `kind`, `statusCode`, `code`, `resetsAt`) plus a SYNTHETIC text part
//! (the headline a person reads, never sent upstream), the `session.error` event, and the POST
//! answers 200 with that message (opencode parity) — a quota stop is never an empty reply.
//! `GET /config` (`{model}`), `GET /provider`, `GET /provider/health`, `POST /provider/check`;
//! the CLI: `yggdrasil provider list|check|status|use|fallback|add|remove`.
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
    extract::{Path, Query, State},
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
mod provider;
mod rollup;
mod tools;

use provider::{Dialect, Route, UpstreamError};

struct Config {
    max_tokens: u64,
    /// `YGG_CATALOG` (display catalog + agents) when set; else the provider registry's.
    catalog: Option<Value>,
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
    /// Harness-owned run state (herdr §1.1 triad), declared by the run loop: `working` while
    /// a run is in flight, `blocked` when a run stopped and needs the user (upstream error,
    /// step cap, interrupted by a restart); absent = `idle`. opencode's binary busy map
    /// (`GET /session/status`) is a projection of it.
    states: Arc<Mutex<HashMap<String, Value>>>,
    /// One run at a time per session (opencode serializes; stacked prompts wait their turn).
    run_locks: Arc<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>>,
    /// Global event bus feeding `GET /event`: `{type, properties}` JSON, opencode-style.
    bus: broadcast::Sender<Value>,
    data_dir: Arc<PathBuf>,
    config: Arc<Config>,
    http: reqwest::Client,
    tools: Arc<tools::ToolEnv>,
    /// PROVIDER-WAVE: the provider registry (hot-reloaded) + per-provider health.
    providers: Arc<provider::Providers>,
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

/// Declares a session's triad state (`working` | `blocked` + reason | `idle`) and announces
/// it as `session.state`. The opencode events (`session.status` busy, `session.idle`) keep
/// firing for clients that only know the binary map.
fn declare(st: &AppState, id: &str, state: &str, reason: Option<&str>, message: Option<&str>) {
    declare_with(st, id, state, reason, message, Value::Null);
}

/// `declare` plus extra fields on the state (PROVIDER-WAVE: a provider stop carries `kind`,
/// `providerID`, `resetsAt`, so a chip/banner can say why and until when without a fetch).
fn declare_with(st: &AppState, id: &str, state: &str, reason: Option<&str>, message: Option<&str>, extra: Value) {
    let mut v = json!({ "type": state, "since": now_ms() });
    if let Value::Object(x) = extra {
        for (k, val) in x {
            v[k] = val;
        }
    }
    if let Some(r) = reason {
        v["reason"] = json!(r);
    }
    if let Some(m) = message {
        v["message"] = json!(m.chars().take(300).collect::<String>());
    }
    {
        let mut states = st.states.lock().unwrap();
        if state == "idle" {
            states.remove(id);
        } else {
            states.insert(id.to_string(), v.clone());
        }
    }
    publish(st, "session.state", json!({ "sessionID": id, "state": v }));
}

/// A session's triad state for the wire (`{"type":"idle"}` when nothing is declared).
fn state_of(st: &AppState, id: &str) -> Value {
    st.states.lock().unwrap().get(id).cloned().unwrap_or_else(|| json!({ "type": "idle" }))
}

/// Boot half of the handoff boundary (herdr §1.5): sessions persist, runs in flight do not.
/// An assistant message the previous process never completed (it died mid-run) is closed
/// the way an abort closes one — partial kept, running tools marked error — and the session
/// is declared `blocked` (reason `interrupted`), never left looking busy forever.
fn close_interrupted(sessions: &mut HashMap<String, Session>, data_dir: &std::path::Path) -> Vec<String> {
    let mut hit = Vec::new();
    for (id, s) in sessions.iter_mut() {
        let Some(last) = s.messages.last_mut() else { continue };
        if last["info"]["role"] != "assistant" || last["info"]["time"]["completed"].is_u64() {
            continue;
        }
        let now = now_ms();
        last["info"]["time"]["completed"] = json!(now);
        last["info"]["error"] = json!({ "name": "MessageAbortedError",
            "data": { "message": "interrupted: the brain restarted mid-run" } });
        for p in last["parts"].as_array_mut().into_iter().flatten() {
            if p["type"] == "tool" && p["state"]["status"] == "running" {
                p["state"]["status"] = json!("error");
                p["state"]["error"] = json!("interrupted: the brain restarted mid-run");
                p["state"]["time"]["end"] = json!(now);
            }
        }
        persist(data_dir, id, s);
        hit.push(id.clone());
    }
    hit
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
    // each info carries its triad `state` (computed, never stored)
    let mut infos: Vec<Value> = sessions
        .values()
        .map(|s| {
            let mut i = s.info.clone();
            i["state"] = state_of(&st, i["id"].as_str().unwrap_or_default());
            i
        })
        .collect();
    infos.sort_by_key(|i| std::cmp::Reverse(i["time"]["updated"].as_u64().unwrap_or(0)));
    Json(Value::Array(infos))
}

async fn get_session(State(st): State<AppState>, Path(id): Path<String>) -> Response {
    let info = st.sessions.lock().unwrap().get(&id).map(|s| s.info.clone());
    match info {
        Some(mut i) => {
            i["state"] = state_of(&st, &id);
            Json(i).into_response()
        }
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
    st.states.lock().unwrap().remove(&id);
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

/// `GET /session/status` — opencode's busy map, now a projection of the triad: only
/// `working` sessions appear, as `busy` (opencode clients read every key as busy).
async fn session_status(State(st): State<AppState>) -> Json<Value> {
    let states = st.states.lock().unwrap();
    Json(Value::Object(
        states
            .iter()
            .filter(|(_, v)| v["type"] == "working")
            .map(|(k, _)| (k.clone(), json!({ "type": "busy" })))
            .collect(),
    ))
}

/// `GET /session/state` — the full triad for every non-idle session:
/// `{id: {type: working|blocked, reason?, message?, since}}` (absent = idle).
async fn session_states(State(st): State<AppState>) -> Json<Value> {
    Json(Value::Object(st.states.lock().unwrap().clone().into_iter().collect()))
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

/// The served catalog: `YGG_CATALOG` when set, else the provider registry's (opencode shape).
fn catalog(st: &AppState) -> Value {
    match &st.config.catalog {
        Some(c) => c.clone(),
        None => st.providers.current().catalog(),
    }
}

/// `GET /config/providers` — `{providers, default}` from the catalog.
async fn config_providers(State(st): State<AppState>) -> Json<Value> {
    let c = catalog(&st);
    Json(json!({ "providers": c["providers"], "default": c.get("default").cloned().unwrap_or(json!({})) }))
}

/// `GET /config` — opencode's global config, the part a client may see: `model` (the default a
/// turn without a session pick runs on) and the fallback order. Never keys.
async fn get_config(State(st): State<AppState>) -> Json<Value> {
    let reg = st.providers.current();
    Json(json!({ "model": reg.default.show(), "fallback": reg.fallback.iter().map(provider::Ref::show).collect::<Vec<_>>() }))
}

/// `GET /provider` — opencode's `{all, default, connected}` plus the root's view: the
/// providers (key SOURCE only), the chain, health, and the last reload error if any.
async fn get_provider(State(st): State<AppState>) -> Json<Value> {
    let reg = st.providers.current();
    let now = now_ms();
    let cat = reg.catalog();
    let connected: Vec<&str> =
        reg.providers.iter().filter(|p| p.key.is_some() || p.key_source == "none").map(|p| p.id.as_str()).collect();
    let mut v = json!({ "all": cat["providers"], "default": cat["default"], "connected": connected,
        "root": reg.describe(), "health": st.providers.health.snapshot(&reg, now) });
    if let Some(e) = st.providers.reload_error.lock().unwrap().clone() {
        v["reloadError"] = json!(e);
    }
    Json(v)
}

/// `GET /provider/health` — per provider: `status` (ok | exhausted | limited | auth | down |
/// error | unknown), `until` (skipped until), `resetsAt`, `headline`, `lastError`, `lastOk`.
/// `default` = the default's provider status, the one a banner reads first.
async fn provider_health(State(st): State<AppState>) -> Json<Value> {
    let reg = st.providers.current();
    let snap = st.providers.health.snapshot(&reg, now_ms());
    Json(json!({ "model": reg.default.show(), "default": snap[&reg.default.provider], "providers": snap,
        "chain": reg.chain(None).iter().map(Route::show).collect::<Vec<_>>() }))
}

/// `POST /provider/check[?deep=1]` — probes every provider (shallow = `GET models`; deep = a
/// 1-token reply on its chain model, one request of the user's plan). A good probe ends a
/// cooldown (the user upgraded the plan, fixed the key, started Ollama); a bad one sets it.
async fn provider_check(State(st): State<AppState>, Query(q): Query<HashMap<String, String>>) -> Json<Value> {
    let reg = st.providers.current();
    let deep = q.get("deep").is_some_and(|v| v == "1" || v == "true");
    let mut targets = reg.chain(None);
    for p in &reg.providers {
        if !targets.iter().any(|r| r.provider == p.id) {
            targets.extend(reg.route(&provider::Ref { provider: p.id.clone(), model: p.models[0].0.clone() }));
        }
    }
    let mut out = serde_json::Map::new();
    for r in &targets {
        let res = provider::probe(&st.http, r, deep).await;
        let now = now_ms();
        match &res.error {
            None if res.status == "ok" || deep => {
                st.providers.health.ok(r, now);
            }
            None => st.providers.health.clear(&r.provider), // reachable, key unverified: no verdict
            Some(e) => st.providers.health.fail(e, now),
        }
        publish_provider(&st, &r.provider);
        out.insert(r.provider.clone(), json!({ "ok": res.ok, "status": res.status, "detail": res.detail, "model": r.model }));
    }
    Json(json!({ "deep": deep, "results": out, "health": st.providers.health.snapshot(&reg, now_ms()) }))
}

/// `provider.status` on the bus: one provider's health changed.
fn publish_provider(st: &AppState, pid: &str) {
    let now = now_ms();
    let v = match st.providers.health.get(pid) {
        Some(e) => provider::Health::entry_json(&e, now),
        None => json!({ "status": "unknown" }),
    };
    publish(st, "provider.status", json!({ "providerID": pid, "health": v }));
}

/// `GET /agent` — `[{name, mode, description}]` from the catalog.
async fn list_agents(State(st): State<AppState>) -> Json<Value> {
    Json(match &st.config.catalog {
        Some(c) => c["agents"].clone(),
        None => default_agents(),
    })
}

/// `POST /api/session/:id/model` — v2 switch, `{model:{id, providerID}}` → 204.
/// The model must exist in the catalog. PROVIDER-WAVE: the session's model ROUTES its runs
/// (the chain starts there, then the fallbacks); before, every run went to the one upstream.
async fn switch_model(State(st): State<AppState>, Path(id): Path<String>, Json(body): Json<Value>) -> Response {
    let (Some(mid), Some(pid)) = (body["model"]["id"].as_str(), body["model"]["providerID"].as_str()) else {
        return bad_request("model needs id + providerID");
    };
    let known = catalog(&st)["providers"]
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
    let agents = match &st.config.catalog {
        Some(c) => c["agents"].clone(),
        None => default_agents(),
    };
    let known = agents.as_array().into_iter().flatten().any(|a| a["name"] == name);
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
                // an error turn's headline is for the person, never the model
                Some("text") if p["synthetic"] == true => {}
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
    /// The target that answered the latest step (`info.providerID/modelID`).
    answered: Option<Route>,
    /// Degrades taken this run, once per (from, to): `info.fallback`.
    fallbacks: Vec<Value>,
}

/// Why a run stopped short. `upstream` = the failed call (the chain's FIRST target's error when
/// every target failed — the one the user configured), `tried` = the fallbacks that failed too.
struct RunFail {
    msg: String,
    upstream: Option<UpstreamError>,
    tried: Vec<UpstreamError>,
}

impl From<String> for RunFail {
    fn from(msg: String) -> Self {
        RunFail { msg, upstream: None, tried: Vec::new() }
    }
}

/// The error turn's text: what a person reads on the page or hears from the voice agent.
fn error_turn_text(fail: &RunFail, now: u64) -> String {
    let Some(u) = &fail.upstream else { return format!("⚠ the run stopped: {}", fail.msg) };
    let mut t = format!("⚠ {}\n{}", u.headline(now), u.detail());
    for f in &fail.tried {
        t.push_str(&format!("\nfallback {}: {} — {}", f.model, f.headline(now), f.message.chars().take(160).collect::<String>()));
    }
    if u.kind.degrades() {
        t.push_str(if fail.tried.is_empty() {
            "\nNo fallback provider is set, so the turn stopped here. Add one (Ollama, or your own key): `yggdrasil provider add`, then `yggdrasil provider fallback`."
        } else {
            "\nEvery provider in the chain failed, so the turn stopped here."
        });
    }
    t
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

/// `info.providerID/modelID` = who answered; `info.fallback` = the degrades taken.
fn stamp_route(run: &mut Run) {
    if let Some(r) = &run.answered {
        run.msg["info"]["providerID"] = json!(r.provider);
        run.msg["info"]["modelID"] = json!(r.model);
    }
    if !run.fallbacks.is_empty() {
        run.msg["info"]["fallback"] = json!(run.fallbacks);
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
    declare(st, id, "working", None, None);
    publish(st, "session.status", json!({ "sessionID": id, "status": { "type": "busy" } }));
    let placeholder = make_message(id, "assistant", vec![text_part("")]);
    replace_message(st, id, &placeholder);
    publish(st, "message.updated", json!({ "info": placeholder["info"] }));

    let mut msg = placeholder;
    msg["parts"] = json!([]);
    let mut run = Run { msg, text: String::new(), answered: None, fallbacks: Vec::new() };
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
            stamp_route(&mut run);
            replace_message(st, id, &run.msg);
            publish(st, "message.updated", json!({ "info": run.msg["info"] }));
            emit(st, tx, "message.completed", run.msg.clone()).await;
            declare(st, id, "idle", None, None);
            Ok(run.msg)
        }
        Some(Err(fail)) => {
            let e = fail.msg.clone();
            eprintln!("run error: {e}");
            let now = now_ms();
            // the run stopped and needs the user — the third state, never a silent idle
            let reason = if e.contains("step cap") { "step-cap" } else { "error" };
            // the error turn (PROVIDER-WAVE): the partial stays, then the headline as a SYNTHETIC
            // text part — visible on every client (old PWAs read text parts), spoken by the voice
            // agent (it arrives as a delta before the error event), never sent upstream
            run.flush_text();
            let text = error_turn_text(&fail, now);
            send_delta(st, id, tx, &text).await;
            run.push_part(json!({ "type": "text", "text": text, "synthetic": true }));
            run.finish(&e);
            stamp_route(&mut run);
            let (name, data, extra) = match &fail.upstream {
                Some(u) => {
                    let mut d = u.data(now);
                    if !fail.tried.is_empty() {
                        d["tried"] = json!(fail.tried.iter().map(|t| t.data(now)).collect::<Vec<_>>());
                    }
                    run.msg["info"]["providerID"] = json!(u.provider);
                    run.msg["info"]["modelID"] = json!(u.model);
                    let mut x = json!({ "kind": u.kind.name(), "providerID": u.provider, "headline": u.headline(now) });
                    if let Some(t) = u.resets_at {
                        x["resetsAt"] = json!(t);
                    }
                    (u.error_name(), d, x)
                }
                None => ("UnknownError", json!({ "message": e }), Value::Null),
            };
            let shown = data["message"].as_str().unwrap_or(&e).to_string();
            declare_with(st, id, "blocked", Some(reason), Some(&shown), extra);
            run.msg["info"]["error"] = json!({ "name": name, "data": data });
            replace_message(st, id, &run.msg);
            publish(st, "message.updated", json!({ "info": run.msg["info"] }));
            // opencode's event for a failed run: clients that only listen on /event see it
            publish(st, "session.error", json!({ "sessionID": id, "error": run.msg["info"]["error"] }));
            emit(st, tx, "error", json!({ "sessionID": id, "error": e, "info": run.msg["info"] })).await;
            // opencode parity: the prompt resolves with the (errored) assistant message
            Ok(run.msg)
        }
        None => {
            // Keep whatever was streamed/executed, flagged the way opencode flags it.
            run.finish("aborted");
            run.msg["info"]["error"] = json!({ "name": "MessageAbortedError", "data": { "message": "aborted" } });
            replace_message(st, id, &run.msg);
            publish(st, "message.updated", json!({ "info": run.msg["info"] }));
            emit(st, tx, "message.aborted", run.msg.clone()).await;
            declare(st, id, "idle", None, None); // a stop is the user's own answer
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
) -> Result<(), RunFail> {
    let pick = session_model(st, id);
    let mut convo = rollup_if_needed(st, id, tx, messages, pick.as_ref()).await;
    if let Some(ctx) = context_prompt(&st.tools.project_dir) {
        convo.insert(0, json!({ "role": "system", "content": ctx }));
    }
    let max = st.config.max_steps;
    for _ in 0..max {
        if st.config.rollup_tokens > 0 {
            let n = rollup::prune(&mut convo, st.config.rollup_tokens);
            if n > 0 {
                eprintln!("roll-up: pruned {n} old tool output(s) in session {id}");
            }
        }
        let calls = relay_chain(st, id, &convo, tx, run, pick.as_ref()).await?;
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
    Err(format!("agent loop hit the step cap ({max} upstream calls) without a final reply").into())
}

/// The session's model pick (`POST /api/session/:id/model`), if any.
fn session_model(st: &AppState, id: &str) -> Option<provider::Ref> {
    let sessions = st.sessions.lock().unwrap();
    let m = &sessions.get(id)?.info["model"];
    Some(provider::Ref { provider: m["providerID"].as_str()?.into(), model: m["id"].as_str()?.into() })
}

/// One upstream call down the chain (PROVIDER-WAVE). The first target that answers wins. A
/// target cooling after an earlier failure is skipped without spending a request; a failure
/// another provider could answer (quota, rate limit, auth, overload, down) that came before
/// any text of this step cools the provider and the call moves on — a step that already
/// streamed text is never silently re-asked elsewhere.
async fn relay_chain(
    st: &AppState,
    id: &str,
    convo: &[Value],
    tx: &mpsc::Sender<Event>,
    run: &mut Run,
    pick: Option<&provider::Ref>,
) -> Result<Vec<ToolCall>, RunFail> {
    let reg = st.providers.current();
    let chain = reg.chain(pick);
    let mut failed: Vec<UpstreamError> = Vec::new();
    for route in &chain {
        if let Some(cached) = st.providers.health.cooling(&route.provider, now_ms()) {
            eprintln!("upstream {}: skipped, cooling ({})", route.show(), cached.headline(now_ms()));
            failed.push(UpstreamError { model: route.model.clone(), ..cached });
            continue;
        }
        let before = run.text.len();
        match relay(st, id, convo, tx, &mut run.text, route).await {
            Ok(calls) => {
                if st.providers.health.ok(route, now_ms()) {
                    publish_provider(st, &route.provider);
                }
                if let Some(first) = failed.first() {
                    let from = format!("{}/{}", first.provider, first.model);
                    if !run.fallbacks.iter().any(|f| f["from"] == from.as_str() && f["to"] == route.show().as_str()) {
                        let now = now_ms();
                        let mut note = json!({ "from": from, "to": route.show(), "kind": first.kind.name(),
                            "headline": first.headline(now), "at": now });
                        if let Some(t) = first.resets_at {
                            note["resetsAt"] = json!(t);
                        }
                        eprintln!("session {id}: degraded {from} -> {} ({})", route.show(), first.headline(now));
                        publish(st, "provider.fallback", json!({ "sessionID": id, "from": from, "to": route.show(),
                            "error": first.data(now) }));
                        run.fallbacks.push(note);
                    }
                }
                run.answered = Some(route.clone());
                return Ok(calls);
            }
            Err(e) => {
                eprintln!("upstream {}: {} [{}]", route.show(), e.line(), e.kind.name());
                let degrade = e.kind.degrades() && run.text.len() == before;
                st.providers.health.fail(&e, now_ms());
                publish_provider(st, &route.provider);
                failed.push(e);
                if !degrade {
                    break;
                }
            }
        }
    }
    let mut failed = failed.into_iter();
    let primary = failed.next().expect("the chain always holds the default");
    Err(RunFail { msg: primary.line(), upstream: Some(primary), tried: failed.collect() })
}

/// OG-ctx (opencode parity): the layered AGENTS.md chain as the run's system message, so a
/// fresh session knows where it is without exploring. Re-read every run: an edited file lands
/// on the next turn, no restart. Each file is capped at 64 KiB; missing or empty files are skipped.
fn context_prompt(project_dir: &std::path::Path) -> Option<String> {
    const CAP: usize = 64 * 1024;
    let files: Vec<PathBuf> = match std::env::var("YGG_CONTEXT_FILES") {
        Ok(v) if !v.is_empty() => v.split(':').filter(|f| !f.is_empty()).map(PathBuf::from).collect(),
        _ => vec![project_dir.join("AGENTS.md")],
    };
    let parts: Vec<String> = files
        .iter()
        .filter_map(|f| {
            let mut text = std::fs::read_to_string(f).ok()?;
            if text.len() > CAP {
                let mut cut = CAP;
                while !text.is_char_boundary(cut) {
                    cut -= 1;
                }
                text.truncate(cut);
            }
            let text = text.trim();
            (!text.is_empty()).then(|| format!("Instructions from: {}\n{text}", f.display()))
        })
        .collect();
    (!parts.is_empty()).then(|| parts.join("\n\n"))
}

/// Slice 6b. Over the token limit at run start: summarize everything before the recent
/// tail with one extra upstream call, store the compaction pair in front of the tail, and
/// return the shortened upstream history. Any failure keeps the full history (logged).
async fn rollup_if_needed(
    st: &AppState,
    id: &str,
    tx: &mpsc::Sender<Event>,
    messages: Vec<Value>,
    pick: Option<&provider::Ref>,
) -> Vec<Value> {
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
    let summary = match summarize(st, &req, pick).await {
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

/// The roll-up's extra upstream call: no tools, no streaming to the client. It goes to the
/// first target of the run's chain that is not cooling.
async fn summarize(st: &AppState, messages: &Value, pick: Option<&provider::Ref>) -> Result<String, String> {
    let now = now_ms();
    let route = st
        .providers
        .current()
        .chain(pick)
        .into_iter()
        .find(|r| st.providers.health.cooling(&r.provider, now).is_none())
        .ok_or("every provider is cooling")?;
    if route.dialect == Dialect::Anthropic {
        return summarize_anthropic(st, messages, &route).await;
    }
    let url = format!("{}/chat/completions", route.base_url.trim_end_matches('/'));
    let mut req = st.http.post(&url).json(&json!({ "model": route.model, "messages": messages, "stream": false }));
    if let Some(key) = &route.key {
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
    route: &Route,
) -> Result<Vec<ToolCall>, UpstreamError> {
    let cfg = &st.config;
    if route.dialect == Dialect::Anthropic {
        return relay_anthropic(st, session_id, convo, tx, full, route).await;
    }
    let url = format!("{}/chat/completions", route.base_url.trim_end_matches('/'));
    let mut body = json!({ "model": route.model, "messages": convo, "stream": true });
    if cfg.tools_enabled {
        body["tools"] = tools::schemas();
    }
    let mut req = st.http.post(&url).json(&body);
    if let Some(key) = &route.key {
        req = req.bearer_auth(key);
    }
    let resp = req.send().await.map_err(|e| UpstreamError::network(route, &e.to_string()))?;
    let status = resp.status();
    if !status.is_success() {
        let headers = resp.headers().clone();
        let body = resp.text().await.unwrap_or_default();
        return Err(UpstreamError::from_response(route, status.as_u16(), &headers, &body, now_ms()));
    }

    let mut calls: Vec<ToolCall> = Vec::new();
    let is_json = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|ct| ct.starts_with("application/json"));
    if is_json {
        let v: Value = resp.json().await.map_err(|e| UpstreamError::stream(route, &format!("bad json: {e}")))?;
        if v["error"].is_object() {
            return Err(UpstreamError::from_response(route, status.as_u16(), &reqwest::header::HeaderMap::new(), &v.to_string(), now_ms()));
        }
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
    let mut finished = false; // a choice carried finish_reason (some providers never send [DONE])
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| UpstreamError::stream(route, &format!("stream error: {e}")))?;
        buf.push_str(&String::from_utf8_lossy(&chunk));
        while let Some(nl) = buf.find('\n') {
            let line: String = buf.drain(..=nl).collect();
            let Some(data) = line.trim().strip_prefix("data:") else { continue };
            let data = data.trim();
            if data == "[DONE]" {
                return Ok(calls);
            }
            let Ok(v) = serde_json::from_str::<Value>(data) else { continue };
            // an error object inside the stream (openrouter, vLLM): classified like a response
            if v["error"].is_object() {
                return Err(UpstreamError::stream_event(route, &v["error"], now_ms()));
            }
            finished |= v["choices"][0]["finish_reason"].is_string();
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
    if !finished {
        return Err(UpstreamError::stream(route, CUT_OFF));
    }
    Ok(calls)
}

/// A provider that dies mid-reply closes the stream cleanly — EOF looked like the end, and
/// the cut-off text was stored as the complete answer (churn suite, 10-24). No end marker
/// (`[DONE]` / `finish_reason` / `message_stop`) = the run failed, partial kept.
const CUT_OFF: &str = "upstream stream ended mid-reply (the provider dropped the connection)";

/// Slice 7: an anthropic-dialect request — `{base}/v1/messages`, the key as both
/// `x-api-key` and bearer (providers differ), `anthropic-version`.
fn anthropic_request(st: &AppState, route: &Route, convo: &[Value], tools: Option<&Value>, stream: bool) -> reqwest::RequestBuilder {
    let max_tokens = route.max_tokens.unwrap_or(st.config.max_tokens);
    let body = anthropic::body(&route.model, max_tokens, convo, tools, stream);
    let mut req = st.http.post(anthropic::messages_url(&route.base_url)).json(&body).header("anthropic-version", anthropic::VERSION);
    if let Some(key) = &route.key {
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
    route: &Route,
) -> Result<Vec<ToolCall>, UpstreamError> {
    let cfg = &st.config;
    let max_tokens = route.max_tokens.unwrap_or(cfg.max_tokens);
    let tools = cfg.tools_enabled.then(tools::schemas);
    let resp = anthropic_request(st, route, convo, tools.as_ref(), true)
        .send()
        .await
        .map_err(|e| UpstreamError::network(route, &e.to_string()))?;
    let status = resp.status();
    if !status.is_success() {
        let headers = resp.headers().clone();
        let body = resp.text().await.unwrap_or_default();
        return Err(UpstreamError::from_response(route, status.as_u16(), &headers, &body, now_ms()));
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
        let v: Value = resp.json().await.map_err(|e| UpstreamError::stream(route, &format!("bad json: {e}")))?;
        if v["type"] == "error" {
            return Err(UpstreamError::from_response(route, status.as_u16(), &reqwest::header::HeaderMap::new(), &v.to_string(), now_ms()));
        }
        let (text, calls, stop) = anthropic::parse_message(&v);
        if stop.as_deref() == Some("max_tokens") {
            eprintln!("upstream stopped at max_tokens ({max_tokens}); raise YGG_MAX_TOKENS");
        }
        full.push_str(&text);
        send_delta(st, session_id, tx, &text).await;
        return Ok(rekey(calls));
    }
    let (mut lines, mut dec) = (anthropic::SseLines::default(), anthropic::Stream::default());
    let mut stream = resp.bytes_stream();
    'read: while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| UpstreamError::stream(route, &format!("stream error: {e}")))?;
        for data in lines.push(&chunk) {
            let Ok(v) = serde_json::from_str::<Value>(&data) else { continue };
            if v["type"] == "error" {
                return Err(UpstreamError::stream_event(route, &v["error"], now_ms()));
            }
            if let Some(text) = dec.feed(&v).map_err(|e| UpstreamError::stream(route, &e))? {
                full.push_str(&text);
                send_delta(st, session_id, tx, &text).await;
            }
            if dec.stopped {
                break 'read;
            }
        }
    }
    if !dec.stopped {
        return Err(UpstreamError::stream(route, CUT_OFF));
    }
    if dec.stop_reason.as_deref() == Some("max_tokens") {
        eprintln!("upstream stopped at max_tokens ({max_tokens}); raise YGG_MAX_TOKENS");
    }
    Ok(rekey(dec.calls))
}

/// The roll-up call in the anthropic dialect: the summarizer prompt rides in `system`.
async fn summarize_anthropic(st: &AppState, messages: &Value, route: &Route) -> Result<String, String> {
    let convo = messages.as_array().cloned().unwrap_or_default();
    let resp = anthropic_request(st, route, &convo, None, false).send().await.map_err(|e| format!("request failed: {e}"))?;
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

/// `YGG_CATALOG`, when set: a display catalog (+ agents) served as-is (exit 2 if unreadable).
fn load_catalog() -> Option<Value> {
    let path = std::env::var("YGG_CATALOG").ok().filter(|p| !p.is_empty())?;
    let parsed = std::fs::read(&path)
        .map_err(|e| e.to_string())
        .and_then(|b| serde_json::from_slice::<Value>(&b).map_err(|e| e.to_string()));
    match parsed {
        Ok(c) => Some(c),
        Err(e) => {
            eprintln!("YGG_CATALOG {path}: {e}");
            std::process::exit(2);
        }
    }
}

fn default_agents() -> Value {
    json!([
        { "name": "build", "mode": "primary", "description": "default agent" },
        { "name": "plan", "mode": "primary", "description": "planning agent" },
    ])
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("provider") {
        std::process::exit(provider::cli(args[2..].to_vec()).await);
    }
    let providers = provider::Providers::boot().unwrap_or_else(|e| {
        eprintln!("{e}");
        std::process::exit(2);
    });
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
    {
        let reg = providers.current();
        for r in reg.chain(None) {
            let url = match r.dialect {
                Dialect::OpenAi => format!("{}/chat/completions", r.base_url.trim_end_matches('/')),
                Dialect::Anthropic => anthropic::messages_url(&r.base_url),
            };
            eprintln!("upstream: {} — {:?} dialect, POST {url}", r.show(), r.dialect);
        }
        eprintln!("providers: {} (default {}, {} fallback)", reg.source, reg.default.show(), reg.fallback.len());
    }
    let config = Config {
        max_tokens: env_num("YGG_MAX_TOKENS", 16_384).max(1),
        catalog: load_catalog(),
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
    let mut sessions = load_sessions(&data_dir);
    eprintln!("loaded {} session(s) from {}", sessions.len(), data_dir.display());
    let interrupted = close_interrupted(&mut sessions, &data_dir);

    let state = AppState {
        sessions: Arc::new(Mutex::new(sessions)),
        running: Arc::default(),
        states: Arc::default(),
        run_locks: Arc::default(),
        bus: broadcast::channel(1024).0,
        data_dir: Arc::new(data_dir),
        config: Arc::new(config),
        http,
        tools: Arc::new(tool_env),
        providers: Arc::new(providers),
    };
    for id in &interrupted {
        eprintln!("session {id}: run interrupted by the restart — closed, declared blocked");
        declare(&state, id, "blocked", Some("interrupted"), Some("the brain restarted mid-run"));
    }
    let app = Router::new()
        .route("/session", get(list_sessions).post(create_session))
        .route("/session/status", get(session_status))
        .route("/session/state", get(session_states))
        .route("/session/{id}", get(get_session).patch(patch_session).delete(delete_session))
        .route("/session/{id}/message", get(list_messages).post(post_message))
        .route("/session/{id}/abort", post(abort_session))
        .route("/session/{id}/todo", get(get_todo))
        .route("/api/session/{id}/model", post(switch_model))
        .route("/api/session/{id}/agent", post(switch_agent))
        .route("/config/providers", get(config_providers))
        .route("/config", get(get_config))
        .route("/provider", get(get_provider))
        .route("/provider/health", get(provider_health))
        .route("/provider/check", post(provider_check))
        .route("/agent", get(list_agents))
        .route("/event", get(events))
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(&listen).await.expect("bind");
    eprintln!("yggdrasil listening on {listen}");
    axum::serve(listener, app).await.unwrap();
}
