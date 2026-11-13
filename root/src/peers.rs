//! Roots (root-coord, 11-12): several yggdrasil roots — on one machine or many — work as one
//! tree. A peer is just another root's HTTP API, reached over whatever private line carries it
//! (the trunk: tailnet today, an SSH or bifrost-net line to the VPS). Nothing here knows the
//! transport; a peer is `name=url`.
//!
//! - A session started on a peer is a PROXY here (`info.remote = {root, id}`) under the asking
//!   session; the real one lives on the peer with `info.report_to = {root, session}`.
//! - The peer digests its own turns (it has the facts) and POSTs the event to `/tree/report` on
//!   the asking root, which cards the proxy and delivers to its parent like any local report.
//! - Talking to a proxy (tree tools or the phone) forwards to the peer; reading it reads there.
//! - `GET /root` describes a root (models + tiers, profiles, hardware, load, note), so the
//!   coordinator can place work where the hardware fits; peers are polled every 60 s.
//!
//! Env: YGG_ROOT_NAME (default: hostname) · YGG_PEERS `name=url,…` · YGG_PEER_TOKEN shared
//! secret (sent as `x-ygg-peer`, required on `/tree/report` when set) · YGG_ROOT_NOTE free text.

use std::{collections::HashMap, sync::Mutex, time::Duration};

use serde_json::{Value, json};

use crate::{AppState, now_ms};

pub struct Peers {
    pub me: String,
    pub list: Vec<(String, String)>,
    pub token: Option<String>,
    pub note: String,
    /// name → (fetched ms, GET /root body)
    pub seen: Mutex<HashMap<String, (u64, Value)>>,
}

impl Peers {
    pub fn load() -> Peers {
        let host = std::fs::read_to_string("/etc/hostname").map(|h| h.trim().to_string()).unwrap_or_else(|_| "root".into());
        let list = std::env::var("YGG_PEERS")
            .unwrap_or_default()
            .split(',')
            .filter_map(|p| p.split_once('=').map(|(n, u)| (n.trim().to_string(), u.trim().trim_end_matches('/').to_string())))
            .filter(|(n, u)| !n.is_empty() && !u.is_empty())
            .collect();
        Peers {
            me: std::env::var("YGG_ROOT_NAME").ok().filter(|n| !n.is_empty()).unwrap_or(host),
            list,
            token: std::env::var("YGG_PEER_TOKEN").ok().filter(|t| !t.is_empty()),
            note: std::env::var("YGG_ROOT_NOTE").unwrap_or_default(),
            seen: Mutex::new(HashMap::new()),
        }
    }

    pub fn url(&self, name: &str) -> Option<&str> {
        self.list.iter().find(|(n, _)| n == name).map(|(_, u)| u.as_str())
    }

    pub fn authorized(&self, headers: &axum::http::HeaderMap) -> bool {
        match &self.token {
            None => true,
            Some(t) => headers.get("x-ygg-peer").and_then(|v| v.to_str().ok()) == Some(t.as_str()),
        }
    }
}

/// One call to a peer root. `timeout` covers the whole exchange.
pub async fn call(st: &AppState, root: &str, method: &str, path: &str, body: Option<Value>, timeout: u64) -> Result<Value, String> {
    let p = &st.config.peers;
    let base = p.url(root).ok_or_else(|| format!("unknown root {root:?} (known: {})", p.list.iter().map(|(n, _)| n.as_str()).collect::<Vec<_>>().join(", ")))?;
    let mut req = match method {
        "GET" => st.http.get(format!("{base}{path}")),
        "PATCH" => st.http.patch(format!("{base}{path}")),
        "DELETE" => st.http.delete(format!("{base}{path}")),
        _ => st.http.post(format!("{base}{path}")),
    }
    .timeout(Duration::from_secs(timeout));
    if let Some(t) = &p.token {
        req = req.header("x-ygg-peer", t);
    }
    if let Some(b) = body {
        req = req.json(&b);
    }
    let resp = req.send().await.map_err(|e| format!("root {root} unreachable: {e}"))?;
    // any answer proves the line is up: keep the [roots] view fresh between polls
    if let Some(e) = p.seen.lock().unwrap().get_mut(root) {
        e.0 = now_ms();
    }
    let status = resp.status();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("root {root}: {status} {}", text.chars().take(200).collect::<String>()));
    }
    Ok(serde_json::from_str(&text).unwrap_or(Value::Null))
}

fn mem_gb() -> u64 {
    std::fs::read_to_string("/proc/meminfo")
        .ok()
        .and_then(|m| m.lines().find(|l| l.starts_with("MemTotal:")).and_then(|l| l.split_whitespace().nth(1)).and_then(|k| k.parse::<u64>().ok()))
        .map(|kb| kb / 1_048_576)
        .unwrap_or(0)
}

/// `GET /root` — what this root is and can do right now.
pub fn describe(st: &AppState) -> Value {
    let running = st.running.lock().unwrap().len();
    let sessions = st.sessions.lock().unwrap().len();
    let models: Vec<Value> = st.config.models.iter().map(|m| json!({ "id": m, "tier": crate::model_tier(st, m) })).collect();
    let profiles: Vec<Value> = st.config.profiles.read().unwrap().by_name.values().map(|p| json!({ "name": p.name, "description": p.description, "harness": p.harness })).collect();
    json!({
        "name": st.config.peers.me, "note": st.config.peers.note, "models": models, "profiles": profiles,
        "hardware": { "os": std::env::consts::OS, "arch": std::env::consts::ARCH,
            "cpus": std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1), "mem_gb": mem_gb() },
        "load": { "running": running, "sessions": sessions },
        "peers": st.config.peers.list.iter().map(|(n, _)| n.clone()).collect::<Vec<_>>(),
    })
}

fn summary(r: &Value) -> String {
    let models: Vec<String> = r["models"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|m| format!("{}{}", m["id"].as_str().unwrap_or("?"), if m["tier"] == "lite" { " (lite)" } else { "" }))
        .collect();
    let harness: Vec<&str> = r["profiles"].as_array().into_iter().flatten().filter_map(|p| p["harness"].as_str().and(p["name"].as_str())).collect();
    let hw = &r["hardware"];
    format!(
        "{}: {}{} · {} cpu / {} GB {} · {} running · models {}{}",
        r["name"].as_str().unwrap_or("?"),
        r["note"].as_str().filter(|n| !n.is_empty()).unwrap_or("no note"),
        "",
        hw["cpus"],
        hw["mem_gb"],
        hw["os"].as_str().unwrap_or("?"),
        r["load"]["running"],
        models.join(", "),
        if harness.is_empty() { String::new() } else { format!(" · harnesses {}", harness.join(", ")) }
    )
}

/// The roots part of the [tree] view: this root and every peer seen in the last 3 minutes.
pub fn roots_view(st: &AppState) -> String {
    let p = &st.config.peers;
    if p.list.is_empty() {
        return String::new();
    }
    let mut out = format!("[roots] where sessions can run (session_start root=<name>; default = this one):\n- {} (this root)\n", summary(&describe(st)));
    let seen = p.seen.lock().unwrap();
    for (name, _) in &p.list {
        match seen.get(name) {
            Some((at, r)) if now_ms().saturating_sub(*at) < 180_000 => out.push_str(&format!("- {}\n", summary(r))),
            _ => out.push_str(&format!("- {name}: unreachable right now\n")),
        }
    }
    out
}

/// Polls every peer's `/root` — every 15 s until all have answered, then once a minute (the
/// view never waits on the network).
pub fn spawn_watch(st: &AppState) {
    if st.config.peers.list.is_empty() {
        return;
    }
    let st = st.clone();
    tokio::spawn(async move {
        loop {
            for (name, _) in st.config.peers.list.clone() {
                match call(&st, &name, "GET", "/root", None, 5).await {
                    Ok(v) => {
                        st.config.peers.seen.lock().unwrap().insert(name, (now_ms(), v));
                    }
                    Err(e) => eprintln!("peer {e}"),
                }
            }
            let all_seen = st.config.peers.list.iter().all(|(n, _)| st.config.peers.seen.lock().unwrap().contains_key(n));
            tokio::time::sleep(Duration::from_secs(if all_seen { 60 } else { 15 })).await;
        }
    });
}

/// The remote half of a proxy (`info.remote`), if `sid` is one.
pub fn remote_of(st: &AppState, sid: &str) -> Option<(String, String)> {
    let sessions = st.sessions.lock().unwrap();
    let r = &sessions.get(sid)?.info["remote"];
    Some((r["root"].as_str()?.to_string(), r["id"].as_str()?.to_string()))
}

/// Posts a turn to the peer side of a proxy, asynchronously (it reports back by itself).
pub async fn send(st: &AppState, root: &str, rid: &str, text: &str) -> Result<(), String> {
    call(st, root, "POST", &format!("/session/{rid}/message?async=1&origin=none"), Some(json!({ "parts": [{ "type": "text", "text": text }] })), 20)
        .await
        .map(|_| ())
}

/// Creates the real session on `root` and the proxy here; posts the brief there.
pub async fn start(st: &AppState, caller: &str, root: &str, title: &str, profile: &str, brief: &str, model: Option<&str>, variant: Option<&str>) -> Result<String, String> {
    let proxy = crate::new_session(st, title, Some(caller), Some(profile), None, None);
    let pid = proxy["id"].as_str().unwrap_or_default().to_string();
    let body = json!({ "title": title, "agent": profile, "model": model, "variant": variant,
        "report_to": { "root": st.config.peers.me, "session": pid } });
    let made = call(st, root, "POST", "/session", Some(body), 20).await;
    let rid = match made.as_ref().ok().and_then(|v| v["id"].as_str()) {
        Some(r) => r.to_string(),
        None => {
            crate::drop_session(st, &pid);
            return Err(made.err().unwrap_or_else(|| "peer returned no session".into()));
        }
    };
    crate::with_session(st, &pid, |s| {
        s.info["remote"] = json!({ "root": root, "id": rid });
        s.info["card"] = json!({ "topic": title, "brief": brief.chars().take(600).collect::<String>(), "status": "working",
            "by": caller, "root": root, "created": now_ms(), "updated": now_ms() });
    });
    send(st, root, &rid, brief).await?;
    Ok(pid)
}

/// The peer side: a finished turn's event goes home to the root that asked for this session.
pub async fn report(st: &AppState, root: &str, proxy: &str, ev: Value) {
    let body = json!({ "proxy": proxy, "event": ev });
    for attempt in 0..3u64 {
        match call(st, root, "POST", "/tree/report", Some(body.clone()), 15).await {
            Ok(_) => return,
            Err(e) => {
                eprintln!("report to {root} failed ({}/3): {e}", attempt + 1);
                tokio::time::sleep(Duration::from_secs(5 * (attempt + 1))).await;
            }
        }
    }
}
