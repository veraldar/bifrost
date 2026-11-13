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
//!
//! Learned peers (roots-learn, 11-13): with YGG_PEERS_FROM=<url> (the hub's bridge:
//! `http://127.0.0.1:<bridge http>/_roots`, answering `[{"id","since"}]` for the roots linked to
//! the trunk right now), the watch loop reads that list every few seconds and adds a peer per
//! linked root: name = its id, url = YGG_PEERS_VIA with `{id}` replaced (default
//! `<scheme://host:port of YGG_PEERS_FROM>/_root/{id}`, the switchboard). Static YGG_PEERS win a
//! name clash; this root's own name is never added. A root that unlinks stays known, shown
//! unreachable like any down peer. A call naming a root not known yet reads the list once first.

use std::{collections::HashMap, sync::Mutex, time::Duration};

use serde_json::{Value, json};

use crate::{AppState, now_ms};

pub struct Peers {
    pub me: String,
    /// the static peers (YGG_PEERS); they win a name clash with a learned one
    pub list: Vec<(String, String)>,
    /// peers learned from YGG_PEERS_FROM, in the order they were first seen; never forgotten
    pub learned: Mutex<Vec<(String, String)>>,
    /// YGG_PEERS_FROM: where the linked roots are listed (`[{"id":…}]`); None = learn nothing
    pub from: Option<String>,
    /// YGG_PEERS_VIA: a learned root's url, `{id}` = its id
    pub via: String,
    pub token: Option<String>,
    pub note: String,
    /// name → (fetched ms, GET /root body)
    pub seen: Mutex<HashMap<String, (u64, Value)>>,
}

/// `name=url,…` → pairs (names and urls trimmed, a trailing `/` dropped, empty halves skipped).
pub fn parse_peers(s: &str) -> Vec<(String, String)> {
    s.split(',')
        .filter_map(|p| p.split_once('=').map(|(n, u)| (n.trim().to_string(), u.trim().trim_end_matches('/').to_string())))
        .filter(|(n, u)| !n.is_empty() && !u.is_empty())
        .collect()
}

/// `scheme://host[:port]` of a URL (None when it is not one).
pub fn origin(url: &str) -> Option<String> {
    let (scheme, rest) = url.trim().split_once("://")?;
    let host = &rest[..rest.find(['/', '?', '#']).unwrap_or(rest.len())];
    (!scheme.is_empty() && scheme.bytes().all(|b| b.is_ascii_alphabetic()) && !host.is_empty()).then(|| format!("{scheme}://{host}"))
}

/// A root id the trunk could hand out (its own `valid_root_id`): it becomes a peer name and a
/// url segment, so nothing else is taken.
pub fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
}

/// The ids in a YGG_PEERS_FROM answer (`[{"id":…,"since":…}]`); anything else in it is ignored.
pub fn linked_ids(v: &Value) -> Vec<String> {
    v.as_array().into_iter().flatten().filter_map(|r| r["id"].as_str()).filter(|id| valid_id(id)).map(str::to_string).collect()
}

/// Adds every linked root not known yet to `learned` (never `me`, never a static name); returns
/// the names it added. Nothing is ever removed.
pub fn merge(statics: &[(String, String)], learned: &mut Vec<(String, String)>, me: &str, via: &str, ids: &[String]) -> Vec<String> {
    let mut added = vec![];
    for id in ids {
        if id == me || statics.iter().any(|(n, _)| n == id) || learned.iter().any(|(n, _)| n == id) {
            continue;
        }
        learned.push((id.clone(), via.replace("{id}", id).trim_end_matches('/').to_string()));
        added.push(id.clone());
    }
    added
}

impl Peers {
    pub fn load() -> Peers {
        let host = std::fs::read_to_string("/etc/hostname").map(|h| h.trim().to_string()).unwrap_or_else(|_| "root".into());
        let env = |k: &str| std::env::var(k).ok().filter(|v| !v.trim().is_empty());
        let me = env("YGG_ROOT_NAME").unwrap_or(host);
        Peers::new(me, &env("YGG_PEERS").unwrap_or_default(), env("YGG_PEERS_FROM"), env("YGG_PEERS_VIA"), env("YGG_PEER_TOKEN"), env("YGG_ROOT_NOTE").unwrap_or_default())
    }

    pub fn new(me: String, peers: &str, from: Option<String>, via: Option<String>, token: Option<String>, note: String) -> Peers {
        let from = from.map(|f| f.trim().to_string()).filter(|f| {
            let ok = origin(f).is_some();
            if !ok {
                eprintln!("peers: YGG_PEERS_FROM={f:?} is not a URL — learning no peers");
            }
            ok
        });
        let fallback = from.as_deref().and_then(origin).map(|o| format!("{o}/_root/{{id}}")).unwrap_or_default();
        let via = match via.map(|v| v.trim().to_string()) {
            Some(v) if v.contains("{id}") && origin(&v).is_some() => v,
            Some(v) => {
                eprintln!("peers: YGG_PEERS_VIA={v:?} is not a URL holding {{id}} — using {fallback}");
                fallback
            }
            None => fallback,
        };
        Peers { me, list: parse_peers(peers), learned: Mutex::new(vec![]), from, via, token, note, seen: Mutex::new(HashMap::new()) }
    }

    /// Every peer: the static ones, then the learned ones.
    pub fn all(&self) -> Vec<(String, String)> {
        let mut v = self.list.clone();
        v.extend(self.learned.lock().unwrap().iter().cloned());
        v
    }

    pub fn names(&self) -> Vec<String> {
        self.all().into_iter().map(|(n, _)| n).collect()
    }

    pub fn url(&self, name: &str) -> Option<String> {
        self.all().into_iter().find(|(n, _)| n == name).map(|(_, u)| u)
    }

    pub fn authorized(&self, headers: &axum::http::HeaderMap) -> bool {
        match &self.token {
            None => true,
            Some(t) => headers.get("x-ygg-peer").and_then(|v| v.to_str().ok()) == Some(t.as_str()),
        }
    }
}

/// Reads YGG_PEERS_FROM once and learns the roots linked there; returns the names added.
pub async fn learn(st: &AppState) -> Result<Vec<String>, String> {
    let p = &st.config.peers;
    let Some(from) = &p.from else { return Ok(vec![]) };
    let resp = st.http.get(from).timeout(Duration::from_secs(5)).send().await.map_err(|e| format!("{from} unreachable: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("{from}: {}", resp.status()));
    }
    let v: Value = resp.json().await.map_err(|e| format!("{from}: {e}"))?;
    let added = merge(&p.list, &mut p.learned.lock().unwrap(), &p.me, &p.via, &linked_ids(&v));
    for n in &added {
        eprintln!("peers: learned root {n} = {} (linked at {from})", p.url(n).unwrap_or_default());
    }
    Ok(added)
}

/// Whether an answer came from the peer's side of the line: a gateway error (502/503/504) is the
/// trunk's switchboard saying the root is not there, so it proves nothing.
pub fn proves_line_up(status: u16) -> bool {
    !matches!(status, 502..=504)
}

/// One call to a peer root. `timeout` covers the whole exchange.
pub async fn call(st: &AppState, root: &str, method: &str, path: &str, body: Option<Value>, timeout: u64) -> Result<Value, String> {
    let p = &st.config.peers;
    let mut base = p.url(root);
    if base.is_none() && p.from.is_some() {
        // linked a moment ago, before the watch read the list: read it now
        if let Err(e) = learn(st).await {
            eprintln!("peers: {e}");
        }
        base = p.url(root);
    }
    let base = base.ok_or_else(|| format!("unknown root {root:?} (known: {})", p.names().join(", ")))?;
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
    let status = resp.status();
    // any answer from the peer proves the line is up: keep the [roots] view fresh between polls
    if proves_line_up(status.as_u16()) {
        if let Some(e) = p.seen.lock().unwrap().get_mut(root) {
            e.0 = now_ms();
        }
    }
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
        "peers": st.config.peers.names(),
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
    let peers = p.all();
    if peers.is_empty() {
        return String::new();
    }
    let me = summary(&describe(st));
    view(&me, &peers, &p.seen.lock().unwrap(), now_ms())
}

fn view(me: &str, peers: &[(String, String)], seen: &HashMap<String, (u64, Value)>, now: u64) -> String {
    let mut out = format!("[roots] where sessions can run (session_start root=<name>; default = this one):\n- {me} (this root)\n");
    for (name, _) in peers {
        match seen.get(name) {
            Some((at, r)) if now.saturating_sub(*at) < 180_000 => out.push_str(&format!("- {}\n", summary(r))),
            _ => out.push_str(&format!("- {name}: unreachable right now\n")),
        }
    }
    out
}

/// When a peer's `/root` is read next: a minute after it answered (or once it has ever answered),
/// 15 s while it never has.
fn next_poll(now: u64, answered: bool, ever_seen: bool) -> u64 {
    now + if answered || ever_seen { 60_000 } else { 15_000 }
}

/// Polls every peer's `/root` — every 15 s until it has answered, then once a minute (the view
/// never waits on the network). With YGG_PEERS_FROM it also reads the linked roots every 5 s, so
/// a root that just joined the trunk shows up within seconds.
pub fn spawn_watch(st: &AppState) {
    if st.config.peers.list.is_empty() && st.config.peers.from.is_none() {
        return;
    }
    let st = st.clone();
    tokio::spawn(async move {
        let p = &st.config.peers;
        let mut due: HashMap<String, u64> = HashMap::new();
        let mut last_err = String::new();
        loop {
            if p.from.is_some() {
                match learn(&st).await {
                    Ok(_) => last_err.clear(),
                    Err(e) if e != last_err => {
                        eprintln!("peers: {e}");
                        last_err = e;
                    }
                    Err(_) => {}
                }
            }
            for (name, _) in p.all() {
                if due.get(&name).is_some_and(|t| *t > now_ms()) {
                    continue;
                }
                let answered = match call(&st, &name, "GET", "/root", None, 5).await {
                    Ok(v) => {
                        p.seen.lock().unwrap().insert(name.clone(), (now_ms(), v));
                        true
                    }
                    Err(e) => {
                        eprintln!("peer {e}");
                        false
                    }
                };
                let ever = p.seen.lock().unwrap().contains_key(&name);
                due.insert(name, next_poll(now_ms(), answered, ever));
            }
            tokio::time::sleep(Duration::from_secs(5)).await;
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

#[cfg(test)]
mod tests {
    use super::*;

    fn pairs(v: &[(&str, &str)]) -> Vec<(String, String)> {
        v.iter().map(|(n, u)| (n.to_string(), u.to_string())).collect()
    }

    #[test]
    fn static_peers_parse() {
        assert_eq!(parse_peers(" mac = http://a:1/_root/mac/ ,, =x, y= ,lab=http://b:2"), pairs(&[("mac", "http://a:1/_root/mac"), ("lab", "http://b:2")]));
        assert!(parse_peers("").is_empty());
    }

    #[test]
    fn via_defaults_to_the_switchboard_of_from() {
        assert_eq!(origin("http://127.0.0.1:18398/_roots").as_deref(), Some("http://127.0.0.1:18398"));
        assert_eq!(origin("https://box.local?x").as_deref(), Some("https://box.local"));
        assert_eq!(origin("127.0.0.1:1/_roots"), None);
        assert_eq!(origin("http:///x"), None);
        let p = Peers::new("home".into(), "", Some("http://127.0.0.1:18398/_roots".into()), None, None, String::new());
        assert_eq!(p.via, "http://127.0.0.1:18398/_root/{id}");
        let p = Peers::new("home".into(), "", Some("http://127.0.0.1:1/_roots".into()), Some("http://10.0.0.2:9/r/{id}/".into()), None, String::new());
        assert_eq!(p.via, "http://10.0.0.2:9/r/{id}/");
        // a VIA without {id} would send every root to one place: the default instead
        let p = Peers::new("home".into(), "", Some("http://127.0.0.1:1/_roots".into()), Some("http://10.0.0.2:9/r".into()), None, String::new());
        assert_eq!(p.via, "http://127.0.0.1:1/_root/{id}");
        // a FROM that is not a URL learns nothing
        let p = Peers::new("home".into(), "", Some("/_roots".into()), None, None, String::new());
        assert!(p.from.is_none());
    }

    #[test]
    fn linked_list_parses_only_root_ids() {
        let v = json!([{ "id": "mac", "since": 1 }, { "id": "lab-2.x" }, { "id": "a/b" }, { "id": "" }, { "id": 7 }, "mac", { "name": "x" }]);
        assert_eq!(linked_ids(&v), vec!["mac".to_string(), "lab-2.x".to_string()]);
        assert!(linked_ids(&json!({ "error": "x" })).is_empty());
        assert!(!valid_id(&"a".repeat(65)) && valid_id(&"a".repeat(64)));
    }

    #[test]
    fn merge_learns_new_roots_static_wins_never_me_never_forgets() {
        let statics = pairs(&[("lab", "http://10.0.0.5:4100")]);
        let via = "http://127.0.0.1:18398/_root/{id}";
        let mut learned = vec![];
        let ids = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(merge(&statics, &mut learned, "home", via, &ids(&["mac", "home", "lab"])), ids(&["mac"]));
        assert_eq!(learned, pairs(&[("mac", "http://127.0.0.1:18398/_root/mac")]));
        // the same list again adds nothing; a new root is added after the first
        assert!(merge(&statics, &mut learned, "home", via, &ids(&["mac"])).is_empty());
        assert_eq!(merge(&statics, &mut learned, "home", via, &ids(&["pi", "mac"])), ids(&["pi"]));
        // mac unlinked: it stays known
        assert!(merge(&statics, &mut learned, "home", via, &[]).is_empty());
        assert_eq!(learned.iter().map(|(n, _)| n.as_str()).collect::<Vec<_>>(), vec!["mac", "pi"]);
    }

    #[test]
    fn learned_peers_resolve_like_static_ones() {
        let p = Peers::new("home".into(), "lab=http://10.0.0.5:4100", Some("http://127.0.0.1:18398/_roots".into()), None, None, String::new());
        merge(&p.list, &mut p.learned.lock().unwrap(), &p.me, &p.via, &["mac".to_string(), "lab".to_string()]);
        assert_eq!(p.names(), vec!["lab".to_string(), "mac".to_string()]);
        assert_eq!(p.url("mac").as_deref(), Some("http://127.0.0.1:18398/_root/mac"));
        assert_eq!(p.url("lab").as_deref(), Some("http://10.0.0.5:4100"));
        assert_eq!(p.url("home"), None);
    }

    #[test]
    fn view_lists_learned_roots_and_shows_a_gone_one_unreachable() {
        let peers = pairs(&[("lab", "http://10.0.0.5:4100"), ("mac", "http://127.0.0.1:1/_root/mac")]);
        let mac = json!({ "name": "mac", "note": "", "models": [{ "id": "m1", "tier": "full" }], "profiles": [],
            "hardware": { "os": "macos", "cpus": 10, "mem_gb": 32 }, "load": { "running": 0 } });
        let mut seen = HashMap::new();
        seen.insert("mac".to_string(), (1_000_000u64, mac));
        let v = view("home: no note", &peers, &seen, 1_000_000 + 60_000);
        assert!(v.starts_with("[roots] where sessions can run"), "{v}");
        assert!(v.contains("- home: no note (this root)\n"), "{v}");
        assert!(v.contains("- mac: no note · 10 cpu / 32 GB macos · 0 running · models m1\n"), "{v}");
        assert!(v.contains("- lab: unreachable right now\n"), "{v}");
        // 3 minutes without an answer: unreachable, still listed
        let v = view("home: no note", &peers, &seen, 1_000_000 + 180_000);
        assert!(v.contains("- mac: unreachable right now\n"), "{v}");
    }

    #[test]
    fn polling_cadence_and_gateway_errors() {
        assert_eq!(next_poll(0, false, false), 15_000);
        assert_eq!(next_poll(0, true, true), 60_000);
        assert_eq!(next_poll(0, false, true), 60_000);
        assert!(proves_line_up(200) && proves_line_up(404) && proves_line_up(500));
        assert!(!proves_line_up(502) && !proves_line_up(503) && !proves_line_up(504));
    }
}
