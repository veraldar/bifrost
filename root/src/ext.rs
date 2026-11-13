//! Extensions (root-coord, 11-13): capabilities that live OUTSIDE the core — their own process, any
//! language, improved and added independently (the librarian is the first). The core only knows
//! this interface. An extension is an HTTP service listed in `YGG_EXTENSIONS` (`name=url,…`):
//!
//! - `GET {url}/manifest` → `{"name", "description", "prompt"?, "tools": [{"name", "description",
//!   "parameters": <JSON schema>, "scope": "self" | "world"}]}` — read again every 60 s, so an
//!   extension started (or upgraded) later shows up without restarting the root. `prompt` (one or
//!   two sentences: when agents should reach for it) joins the shared prompt while it is up.
//! - `POST {url}/call/{tool}` `{"input": {…}, "session": "<caller id>", "root": "<root name>"}` →
//!   `{"output": "text"}` or `{"error": "text"}`.
//! - Agents see the tools as `<extension>_<tool>` (`librarian_search`). A `self` tool only reads
//!   or writes the extension's own data: every agent may use it. A `world` tool changes things
//!   outside (files, devices, services): only agents whose rules allow it (a blanket `*`, or the
//!   tool's name), like any other tool.
//! - An extension reads the root through the root's normal HTTP API. `YGG_EXT_TOKEN`, when set,
//!   rides every call as `x-ygg-ext`.

use std::{collections::HashMap, sync::Mutex, time::Duration};

use serde_json::{Value, json};

use crate::{AppState, profiles::Profile, tools::ToolResult};

pub struct Extensions {
    pub list: Vec<(String, String)>,
    token: Option<String>,
    /// name → manifest, for the extensions that answered their last poll
    pub manifests: Mutex<HashMap<String, Value>>,
}

/// One extension tool as an agent sees it.
struct Found {
    ext: String,
    tool: String,
    world: bool,
}

impl Extensions {
    pub fn load() -> Extensions {
        let list = std::env::var("YGG_EXTENSIONS")
            .unwrap_or_default()
            .split(',')
            .filter_map(|p| p.split_once('=').map(|(n, u)| (n.trim().to_string(), u.trim().trim_end_matches('/').to_string())))
            .filter(|(n, u)| !n.is_empty() && !u.is_empty() && n.chars().all(|c| c.is_ascii_alphanumeric()))
            .collect();
        Extensions { list, token: std::env::var("YGG_EXT_TOKEN").ok().filter(|t| !t.is_empty()), manifests: Mutex::default() }
    }

    fn find(&self, name: &str) -> Option<Found> {
        let m = self.manifests.lock().unwrap();
        m.iter().find_map(|(ext, man)| {
            let tool = name.strip_prefix(ext.as_str())?.strip_prefix('_')?;
            let t = man["tools"].as_array()?.iter().find(|t| t["name"] == tool)?;
            Some(Found { ext: ext.clone(), tool: tool.to_string(), world: t["scope"] != "self" })
        })
    }

    pub fn owns(&self, name: &str) -> bool {
        self.find(name).is_some()
    }

    /// May `prof` use the extension tool `name`? (`self` tools: everyone; `world`: its rules.)
    pub fn allows(&self, prof: &Profile, name: &str) -> bool {
        self.find(name).is_some_and(|f| !f.world || prof.check(name, &json!({})).is_ok())
    }

    /// The function schemas of every extension tool `prof` may use.
    pub fn schemas(&self, prof: &Profile) -> Vec<Value> {
        let tools: Vec<(String, Value)> = {
            let m = self.manifests.lock().unwrap();
            m.iter()
                .flat_map(|(ext, man)| man["tools"].as_array().cloned().unwrap_or_default().into_iter().map(move |t| (ext.clone(), t)))
                .collect()
        };
        tools
            .into_iter()
            .filter_map(|(ext, t)| {
                let name = format!("{ext}_{}", t["name"].as_str()?);
                self.allows(prof, &name).then(|| {
                    let params = if t["parameters"].is_object() { t["parameters"].clone() } else { json!({ "type": "object", "properties": {} }) };
                    json!({ "type": "function", "function": {
                        "name": name,
                        "description": format!("[{ext} extension] {}", t["description"].as_str().unwrap_or_default()),
                        "parameters": params,
                    }})
                })
            })
            .collect()
    }

    /// What the extensions that are up ask every agent to know (their manifest `prompt`), as one
    /// block for the shared prompt — `None` when there is nothing to say.
    pub fn prompt(&self) -> Option<String> {
        let m = self.manifests.lock().unwrap();
        let mut lines: Vec<String> = m
            .iter()
            .filter_map(|(n, man)| man["prompt"].as_str().filter(|p| !p.trim().is_empty()).map(|p| format!("- {n}: {}", p.trim())))
            .collect();
        lines.sort();
        (!lines.is_empty()).then(|| format!("[extensions]\n{}", lines.join("\n")))
    }

    /// `GET /extensions`: every configured extension, whether it answers, and its tools.
    pub fn describe(&self) -> Value {
        let m = self.manifests.lock().unwrap();
        json!(self.list.iter().map(|(name, url)| {
            let man = m.get(name);
            json!({
                "name": name, "url": url, "up": man.is_some(),
                "description": man.and_then(|x| x["description"].as_str()).unwrap_or_default(),
                "tools": man.and_then(|x| x["tools"].as_array()).into_iter().flatten()
                    .map(|t| json!({ "name": t["name"], "scope": if t["scope"] == "self" { "self" } else { "world" }, "description": t["description"] }))
                    .collect::<Vec<_>>(),
            })
        }).collect::<Vec<_>>())
    }

    fn post(&self, st: &AppState, url: String, body: Value, timeout: u64) -> reqwest::RequestBuilder {
        let req = st.http.post(url).timeout(Duration::from_secs(timeout)).json(&body);
        match &self.token {
            Some(t) => req.header("x-ygg-ext", t),
            None => req,
        }
    }
}

/// Run an extension tool for session `caller`.
pub async fn call(st: &AppState, caller: &str, name: &str, input: &Value) -> ToolResult {
    let fail = |output: String| ToolResult { ok: false, title: name.to_string(), output, metadata: json!({}) };
    let x = &st.config.ext;
    let Some(f) = x.find(name) else { return fail(format!("no extension tool {name}")) };
    let Some((_, url)) = x.list.iter().find(|(n, _)| *n == f.ext) else { return fail(format!("extension {} is not configured", f.ext)) };
    let body = json!({ "input": input, "session": caller, "root": st.config.peers.me });
    let reply = match x.post(st, format!("{url}/call/{}", f.tool), body, 120).send().await {
        Ok(r) => r.json::<Value>().await.unwrap_or_else(|e| json!({ "error": format!("unreadable answer: {e}") })),
        Err(e) => return fail(format!("extension {} unreachable: {e}", f.ext)),
    };
    match reply["error"].as_str() {
        Some(e) => fail(e.to_string()),
        None => ToolResult { ok: true, title: name.to_string(), output: reply["output"].as_str().unwrap_or_default().to_string(), metadata: json!({ "extension": f.ext }) },
    }
}

/// Read every manifest: every 3 s until all answered once (an extension starting next to the root
/// is there by its first turns), then every 60 s.
pub fn spawn_watch(st: &AppState) {
    if st.config.ext.list.is_empty() {
        return;
    }
    let st = st.clone();
    tokio::spawn(async move {
        loop {
            for (name, url) in st.config.ext.list.clone() {
                let mut req = st.http.get(format!("{url}/manifest")).timeout(Duration::from_secs(5));
                if let Some(t) = &st.config.ext.token {
                    req = req.header("x-ygg-ext", t);
                }
                let man = match req.send().await {
                    Ok(r) if r.status().is_success() => r.json::<Value>().await.ok().filter(|m| m["tools"].is_array()),
                    _ => None,
                };
                let mut m = st.config.ext.manifests.lock().unwrap();
                match man {
                    Some(v) => {
                        if !m.contains_key(&name) {
                            eprintln!("extension {name} up: {} tool(s)", v["tools"].as_array().map_or(0, Vec::len));
                        }
                        m.insert(name, v);
                    }
                    None => {
                        if m.remove(&name).is_some() {
                            eprintln!("extension {name} down");
                        }
                    }
                }
            }
            let all = st.config.ext.list.iter().all(|(n, _)| st.config.ext.manifests.lock().unwrap().contains_key(n));
            tokio::time::sleep(Duration::from_secs(if all { 60 } else { 3 })).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::profiles::Profiles;

    fn with(manifest: Value) -> Extensions {
        let x = Extensions { list: vec![("librarian".into(), "http://x".into())], token: None, manifests: Mutex::default() };
        x.manifests.lock().unwrap().insert("librarian".into(), manifest);
        x
    }

    #[test]
    fn tools_are_namespaced_and_scoped() {
        let x = with(json!({ "tools": [
            { "name": "search", "description": "find", "scope": "self", "parameters": { "type": "object", "properties": { "query": { "type": "string" } } } },
            { "name": "flash_board", "description": "writes firmware" },
        ]}));
        let ps = Profiles::load(None);
        let (door, build, review) = (ps.get("coordinator").unwrap(), ps.get("build").unwrap(), ps.get("review").unwrap());
        assert!(x.owns("librarian_search") && x.owns("librarian_flash_board") && !x.owns("librarian_nope") && !x.owns("search"));
        // a self tool: every agent; a world tool (no scope = world): only where the rules allow
        for p in [door, build, review] {
            assert!(x.allows(p, "librarian_search"), "{}", p.name);
        }
        assert!(x.allows(build, "librarian_flash_board"));
        assert!(!x.allows(door, "librarian_flash_board") && !x.allows(review, "librarian_flash_board"));
        let names: Vec<String> = x.schemas(door).iter().map(|s| s["function"]["name"].as_str().unwrap().to_string()).collect();
        assert_eq!(names, vec!["librarian_search"]);
        assert!(x.schemas(build)[0]["function"]["description"].as_str().unwrap().starts_with("[librarian extension]"));
        assert_eq!(x.prompt(), None, "no manifest prompt, nothing added");
        x.manifests.lock().unwrap().get_mut("librarian").unwrap()["prompt"] = json!("Search past work before saying you don't know.");
        assert_eq!(x.prompt().as_deref(), Some("[extensions]\n- librarian: Search past work before saying you don't know."));
    }
}
