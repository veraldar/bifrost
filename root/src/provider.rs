//! PROVIDER-WAVE (10-28): the root's provider layer — which brains a run may call, in which
//! order, and why one was skipped. opencode parity: the config file is opencode's `provider`
//! block (`{model, provider: {id: {npm?, name?, options: {baseURL, apiKey}, models}}}`), so a
//! user's opencode config pastes in; yggdrasil adds `fallback` (the degrade order) and
//! `dialect` (wire shape, else derived from `npm`).
//!
//! Sources, merged at boot and re-read when the file's mtime changes (an edit lands on the next
//! run, no restart; a broken edit keeps the last good registry and is reported):
//! - env: `YGG_UPSTREAM_*` = provider `yggdrasil` (the pre-wave single upstream, unchanged;
//!   `YGG_UPSTREAM_RESET_TZ=+08:00` = the zone its reset times are printed in, default by host);
//! - file: `YGG_PROVIDERS` (default `~/.config/yggdrasil/providers.json`, read only if present);
//! - `YGG_FALLBACK=pid/mid,…` overrides the file's `fallback`.
//!
//! Keys stay the user's (law: your-LLM-your-key): `apiKey` is `{env:NAME}` or `{file:path}`
//! (opencode's substitutions) or a literal; it is sent only to that provider's baseURL, never
//! served on any endpoint (status shows the key's SOURCE and whether it resolved).
//!
//! Every upstream failure is classified (`Kind`) with its reset time when the provider gives
//! one — z.ai's `[1310][... reset at 2026-10-29 03:44:03]` (UTC+8), `retry-after`,
//! `anthropic-ratelimit-*-reset`, OpenAI's `x-ratelimit-reset-*` / "try again in 20s". A
//! failure that another provider could answer (quota, rate limit, auth, overload, 5xx, down,
//! unknown model) cools the provider (until its reset, or a per-kind backoff) and the run
//! degrades to the next one in the chain; a request error or a mid-reply cut does not.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, SystemTime},
};

use serde_json::{Value, json};

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Dialect {
    OpenAi,
    Anthropic,
}

impl Dialect {
    pub fn parse(s: &str) -> Option<Dialect> {
        match s.to_ascii_lowercase().as_str() {
            "" | "openai" => Some(Dialect::OpenAi),
            "anthropic" => Some(Dialect::Anthropic),
            _ => None,
        }
    }
    pub fn name(self) -> &'static str {
        match self {
            Dialect::OpenAi => "openai",
            Dialect::Anthropic => "anthropic",
        }
    }
}

/// `provider/model`. The model part may itself contain `/` (openrouter ids).
#[derive(Clone, PartialEq, Debug)]
pub struct Ref {
    pub provider: String,
    pub model: String,
}

impl Ref {
    pub fn parse(s: &str) -> Option<Ref> {
        let (p, m) = s.trim().split_once('/')?;
        (!p.is_empty() && !m.is_empty()).then(|| Ref { provider: p.into(), model: m.into() })
    }
    pub fn show(&self) -> String {
        format!("{}/{}", self.provider, self.model)
    }
}

#[derive(Clone, Debug)]
pub struct Provider {
    pub id: String,
    pub name: String,
    pub dialect: Dialect,
    pub base_url: String,
    pub key: Option<String>,
    /// Where the key comes from, for display: `env:NAME`, `file:PATH`, `inline`, `none`.
    pub key_source: String,
    /// `(id, display name)` in file order.
    pub models: Vec<(String, String)>,
    pub max_tokens: Option<u64>,
    /// Offset (minutes east of UTC) for reset times the provider prints without a zone.
    pub reset_offset_min: i32,
}

impl Provider {
    fn has_model(&self, m: &str) -> bool {
        self.models.iter().any(|(id, _)| id == m)
    }
}

/// One concrete upstream call target.
#[derive(Clone, Debug)]
pub struct Route {
    pub provider: String,
    pub model: String,
    pub dialect: Dialect,
    pub base_url: String,
    pub key: Option<String>,
    pub key_source: String,
    pub max_tokens: Option<u64>,
    pub reset_offset_min: i32,
}

impl Route {
    pub fn show(&self) -> String {
        format!("{}/{}", self.provider, self.model)
    }
}

#[derive(Debug)]
pub struct Registry {
    pub providers: Vec<Provider>,
    pub default: Ref,
    pub fallback: Vec<Ref>,
    /// `env`, the file path, or both.
    pub source: String,
}

/// Known providers: base URL, dialect and the conventional key variable, so
/// `{"provider": {"ollama": {"models": {...}}}}` is a complete entry.
const KNOWN: &[(&str, &str, Dialect, &str)] = &[
    ("ollama", "http://127.0.0.1:11434/v1", Dialect::OpenAi, ""),
    ("anthropic", "https://api.anthropic.com", Dialect::Anthropic, "ANTHROPIC_API_KEY"),
    ("openai", "https://api.openai.com/v1", Dialect::OpenAi, "OPENAI_API_KEY"),
    ("openrouter", "https://openrouter.ai/api/v1", Dialect::OpenAi, "OPENROUTER_API_KEY"),
    ("zai", "https://api.z.ai/api/anthropic", Dialect::Anthropic, "ZAI_API_KEY"),
    ("zai-coding-plan", "https://api.z.ai/api/anthropic", Dialect::Anthropic, "ZAI_API_KEY"),
];

pub const ENV_PROVIDER: &str = "yggdrasil";

/// Env lookup, injectable for tests and for the CLI's `--env FILE`.
pub type Env<'a> = &'a dyn Fn(&str) -> Option<String>;

fn env_nonempty(env: Env, k: &str) -> Option<String> {
    env(k).filter(|v| !v.is_empty())
}

pub fn default_path(env: Env) -> PathBuf {
    if let Some(p) = env_nonempty(env, "YGG_PROVIDERS") {
        return expand(&p);
    }
    let base = env_nonempty(env, "XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env("HOME").unwrap_or_default()).join(".config"));
    base.join("yggdrasil").join("providers.json")
}

fn expand(p: &str) -> PathBuf {
    match p.strip_prefix("~/") {
        Some(rest) => PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(rest),
        None => PathBuf::from(p),
    }
}

/// opencode's `{env:NAME}` / `{file:path}` substitutions, else a literal.
fn resolve_key(raw: &str, env: Env) -> (Option<String>, String) {
    if let Some(name) = raw.strip_prefix("{env:").and_then(|r| r.strip_suffix('}')) {
        return (env_nonempty(env, name), format!("env:{name}"));
    }
    if let Some(path) = raw.strip_prefix("{file:").and_then(|r| r.strip_suffix('}')) {
        let key = std::fs::read_to_string(expand(path)).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
        return (key, format!("file:{path}"));
    }
    if raw.is_empty() { (None, "none".into()) } else { (Some(raw.to_string()), "inline".into()) }
}

/// Zone for reset times printed without one: z.ai / bigmodel print Beijing time.
fn reset_offset_for(base_url: &str) -> i32 {
    let b = base_url.to_ascii_lowercase();
    if b.contains("z.ai") || b.contains("bigmodel.cn") { 8 * 60 } else { 0 }
}

fn parse_offset(s: &str) -> Option<i32> {
    let s = s.trim();
    if s.eq_ignore_ascii_case("utc") || s == "Z" {
        return Some(0);
    }
    let (sign, rest) = match s.as_bytes().first()? {
        b'+' => (1, &s[1..]),
        b'-' => (-1, &s[1..]),
        _ => return None,
    };
    let (h, m) = rest.split_once(':').unwrap_or((rest, "0"));
    Some(sign * (h.parse::<i32>().ok()? * 60 + m.parse::<i32>().ok()?))
}

fn env_provider(env: Env) -> Result<Option<Provider>, String> {
    let Some(base_url) = env_nonempty(env, "YGG_UPSTREAM_BASE_URL") else { return Ok(None) };
    let style = env("YGG_UPSTREAM_STYLE").unwrap_or_default();
    let dialect = Dialect::parse(&style)
        .ok_or_else(|| format!("YGG_UPSTREAM_STYLE: unknown dialect {style:?} (openai | anthropic)"))?;
    let model = env_nonempty(env, "YGG_UPSTREAM_MODEL").unwrap_or_else(|| "gpt-4o-mini".into());
    let key = env_nonempty(env, "YGG_UPSTREAM_API_KEY");
    // a proxy in front of z.ai prints z.ai's zone without z.ai's host: YGG_UPSTREAM_RESET_TZ=+08:00
    let reset_offset_min = match env_nonempty(env, "YGG_UPSTREAM_RESET_TZ") {
        Some(z) => parse_offset(&z).ok_or_else(|| format!("YGG_UPSTREAM_RESET_TZ {z:?}: want +HH:MM"))?,
        None => reset_offset_for(&base_url),
    };
    Ok(Some(Provider {
        id: ENV_PROVIDER.into(),
        name: ENV_PROVIDER.into(),
        dialect,
        reset_offset_min,
        base_url,
        key_source: if key.is_some() { "env:YGG_UPSTREAM_API_KEY".into() } else { "none".into() },
        key,
        models: vec![(model.clone(), model)],
        max_tokens: None,
    }))
}

fn file_provider(id: &str, p: &Value, env: Env) -> Result<Provider, String> {
    let known = KNOWN.iter().find(|k| k.0 == id);
    let opts = &p["options"];
    let base_url = opts["baseURL"]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(String::from)
        .or_else(|| known.map(|k| k.1.to_string()))
        .ok_or_else(|| format!("provider {id}: options.baseURL is required"))?;
    let dialect = match p["dialect"].as_str() {
        Some(d) => Dialect::parse(d).ok_or_else(|| format!("provider {id}: unknown dialect {d:?} (openai | anthropic)"))?,
        None => match p["npm"].as_str() {
            Some(npm) if npm.contains("anthropic") => Dialect::Anthropic,
            Some(_) => Dialect::OpenAi,
            None => known.map(|k| k.2).unwrap_or(Dialect::OpenAi),
        },
    };
    let (key, key_source) = match opts["apiKey"].as_str() {
        Some(raw) => resolve_key(raw, env),
        None => match known.map(|k| k.3).filter(|v| !v.is_empty()) {
            Some(var) => (env_nonempty(env, var), format!("env:{var}")),
            None => (None, "none".into()),
        },
    };
    let models: Vec<(String, String)> = match &p["models"] {
        Value::Object(m) => m
            .iter()
            .map(|(mid, v)| (mid.clone(), v["name"].as_str().unwrap_or(mid).to_string()))
            .collect(),
        _ => Vec::new(),
    };
    if models.is_empty() {
        return Err(format!("provider {id}: models is empty (name at least one model)"));
    }
    let reset_offset_min = match opts["resetTimezone"].as_str() {
        Some(z) => parse_offset(z).ok_or_else(|| format!("provider {id}: resetTimezone {z:?} (want +HH:MM)"))?,
        None => reset_offset_for(&base_url),
    };
    Ok(Provider {
        id: id.into(),
        name: p["name"].as_str().unwrap_or(id).into(),
        dialect,
        base_url,
        key,
        key_source,
        models,
        max_tokens: opts["maxTokens"].as_u64(),
        reset_offset_min,
    })
}

impl Registry {
    /// Env provider + the providers file (if it exists). `Ok(None)` = nothing configured.
    pub fn load(env: Env, path: &Path) -> Result<Option<Registry>, String> {
        let mut providers: Vec<Provider> = env_provider(env)?.into_iter().collect();
        let mut sources: Vec<String> = if providers.is_empty() { vec![] } else { vec!["env".into()] };
        let mut file = Value::Null;
        match std::fs::read(path) {
            Ok(b) => {
                file = serde_json::from_slice(&b).map_err(|e| format!("{}: {e}", path.display()))?;
                sources.push(path.display().to_string());
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("{}: {e}", path.display())),
        }
        if let Value::Object(ps) = &file["provider"] {
            for (id, p) in ps {
                let fp = file_provider(id, p, env)?;
                // a file entry named like the env provider replaces it
                providers.retain(|x| x.id != fp.id);
                providers.push(fp);
            }
        }
        if providers.is_empty() {
            return Ok(None);
        }
        let find = |r: &Ref| providers.iter().any(|p| p.id == r.provider && p.has_model(&r.model));
        let default = match file["model"].as_str() {
            Some(m) => {
                let r = Ref::parse(m).ok_or_else(|| format!("model {m:?}: want provider/model"))?;
                if !find(&r) {
                    return Err(format!("model {m}: no such provider/model in the catalog"));
                }
                r
            }
            None => {
                let p = providers.iter().find(|p| p.id == ENV_PROVIDER).unwrap_or(&providers[0]);
                Ref { provider: p.id.clone(), model: p.models[0].0.clone() }
            }
        };
        let fb_raw: Vec<String> = match env_nonempty(env, "YGG_FALLBACK") {
            Some(v) => v.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect(),
            None => file["fallback"].as_array().into_iter().flatten().filter_map(|v| v.as_str().map(String::from)).collect(),
        };
        let mut fallback = Vec::new();
        for f in fb_raw {
            let r = Ref::parse(&f).ok_or_else(|| format!("fallback {f:?}: want provider/model"))?;
            if !find(&r) {
                return Err(format!("fallback {f}: no such provider/model in the catalog"));
            }
            if r != default && !fallback.contains(&r) {
                fallback.push(r);
            }
        }
        Ok(Some(Registry { providers, default, fallback, source: sources.join(" + ") }))
    }

    pub fn provider(&self, id: &str) -> Option<&Provider> {
        self.providers.iter().find(|p| p.id == id)
    }

    pub fn knows(&self, r: &Ref) -> bool {
        self.provider(&r.provider).is_some_and(|p| p.has_model(&r.model))
    }

    pub fn route(&self, r: &Ref) -> Option<Route> {
        let p = self.provider(&r.provider).filter(|p| p.has_model(&r.model))?;
        Some(Route {
            provider: p.id.clone(),
            model: r.model.clone(),
            dialect: p.dialect,
            base_url: p.base_url.clone(),
            key: p.key.clone(),
            key_source: p.key_source.clone(),
            max_tokens: p.max_tokens,
            reset_offset_min: p.reset_offset_min,
        })
    }

    /// The run's call order: the session's pick (when it is in the catalog) or the default,
    /// then the fallback list, each target once.
    pub fn chain(&self, pick: Option<&Ref>) -> Vec<Route> {
        let first = pick.filter(|r| self.knows(r)).unwrap_or(&self.default);
        let mut refs = vec![first.clone()];
        for r in std::iter::once(&self.default).chain(&self.fallback) {
            if !refs.contains(r) {
                refs.push(r.clone());
            }
        }
        // the default joins the chain behind a session pick only when it is itself listed:
        // a pick without fallbacks fails as the pick, not silently as the default
        if pick.is_some_and(|p| self.knows(p) && *p != self.default) && !self.fallback.contains(&self.default) {
            refs.retain(|r| r != &self.default);
        }
        refs.iter().filter_map(|r| self.route(r)).collect()
    }

    /// opencode `/config/providers` shape. `default` holds ONE entry — the effective default
    /// (bifrost's brain-default reads a single entry as the model a turn uses).
    pub fn catalog(&self) -> Value {
        let providers: Vec<Value> = self
            .providers
            .iter()
            .map(|p| {
                let models: serde_json::Map<String, Value> = p
                    .models
                    .iter()
                    .map(|(id, name)| (id.clone(), json!({ "id": id, "name": name, "providerID": p.id })))
                    .collect();
                json!({ "id": p.id, "name": p.name, "models": models })
            })
            .collect();
        json!({ "providers": providers, "default": { self.default.provider.clone(): self.default.model } })
    }

    /// Provider list for status surfaces — no key material, only where it comes from.
    pub fn describe(&self) -> Value {
        let ps: Vec<Value> = self
            .providers
            .iter()
            .map(|p| {
                json!({ "id": p.id, "name": p.name, "dialect": p.dialect.name(), "baseURL": p.base_url,
                    "key": { "source": p.key_source, "resolved": p.key.is_some() },
                    "models": p.models.iter().map(|(id, _)| id.clone()).collect::<Vec<_>>() })
            })
            .collect();
        json!({ "providers": ps, "model": self.default.show(),
            "fallback": self.fallback.iter().map(Ref::show).collect::<Vec<_>>(), "source": self.source })
    }
}

// ---------------------------------------------------------------------------------------
// Classified upstream errors

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Kind {
    /// The plan/balance is used up (z.ai 1310/1113/1308, OpenAI insufficient_quota, 402).
    Quota,
    /// Too many requests right now (429 without a quota marker, z.ai 1302/1303).
    RateLimit,
    /// The key was refused (401/403).
    Auth,
    /// The provider is overloaded (529/503, overloaded_error, z.ai 1305).
    Overloaded,
    /// Other 5xx.
    Server,
    /// Connection refused/reset/timeout before any reply (Ollama not running).
    Network,
    /// 404: wrong base URL or the model is not there (Ollama: not pulled).
    Unavailable,
    /// The provider rejected the request itself (400/422): another provider would too.
    Request,
    /// The reply stream broke after it started (partial kept; no silent retry elsewhere).
    Stream,
}

impl Kind {
    pub fn name(self) -> &'static str {
        match self {
            Kind::Quota => "quota",
            Kind::RateLimit => "rate_limit",
            Kind::Auth => "auth",
            Kind::Overloaded => "overloaded",
            Kind::Server => "server",
            Kind::Network => "network",
            Kind::Unavailable => "unavailable",
            Kind::Request => "request",
            Kind::Stream => "stream",
        }
    }
    /// Could another provider answer this call?
    pub fn degrades(self) -> bool {
        !matches!(self, Kind::Request | Kind::Stream)
    }
    /// Health status a failure of this kind leaves the provider in.
    fn status(self) -> &'static str {
        match self {
            Kind::Quota => "exhausted",
            Kind::RateLimit => "limited",
            Kind::Auth => "auth",
            Kind::Network | Kind::Unavailable => "down",
            _ => "error",
        }
    }
    /// How long the provider is skipped when it gave no reset time.
    fn backoff_ms(self) -> Option<u64> {
        match self {
            Kind::Quota => Some(15 * 60_000),
            Kind::Auth => Some(10 * 60_000),
            Kind::RateLimit | Kind::Overloaded | Kind::Server => Some(30_000),
            Kind::Network | Kind::Unavailable => Some(15_000),
            Kind::Request | Kind::Stream => None,
        }
    }
}

#[derive(Clone, Debug)]
pub struct UpstreamError {
    pub kind: Kind,
    pub status: Option<u16>,
    pub code: Option<String>,
    /// The provider's own words, cleaned (z.ai's bracket envelope unwrapped).
    pub message: String,
    /// Raw body (capped) — `responseBody` in the stored error.
    pub body: String,
    pub resets_at: Option<u64>,
    pub provider: String,
    pub model: String,
    pub key_source: String,
}

const QUOTA_CODES: &[&str] = &["1113", "1304", "1308", "1309", "1310", "insufficient_quota", "billing_hard_limit_reached"];
const RATE_CODES: &[&str] = &["1302", "1303", "rate_limit_exceeded"];
const QUOTA_WORDS: &[&str] = &[
    "limit exhausted",
    "quota",
    "insufficient balance",
    "insufficient_quota",
    "billing",
    "credit balance",
    "usage limit",
    "recharge",
    "package expired",
    "exceeded your current",
];

fn str_or_num(v: &Value) -> Option<String> {
    match v {
        Value::String(s) if !s.is_empty() => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

/// z.ai wraps messages as `[1310][Weekly/Monthly Limit Exhausted. ...][request id]`:
/// the longest bracket segment is the sentence.
fn clean_message(m: &str) -> String {
    let m = m.trim();
    if !m.starts_with('[') {
        return m.to_string();
    }
    m.split(['[', ']']).map(str::trim).max_by_key(|s| s.len()).unwrap_or(m).to_string()
}

impl UpstreamError {
    fn base(route: &Route, kind: Kind, message: String) -> UpstreamError {
        UpstreamError {
            kind,
            status: None,
            code: None,
            message,
            body: String::new(),
            resets_at: None,
            provider: route.provider.clone(),
            model: route.model.clone(),
            key_source: route.key_source.clone(),
        }
    }

    /// A non-2xx reply (or a 200 whose body is an error object, `status` 200).
    pub fn from_response(route: &Route, status: u16, headers: &reqwest::header::HeaderMap, body: &str, now: u64) -> Self {
        let v: Value = serde_json::from_str(body).unwrap_or(Value::Null);
        let err = if v["error"].is_object() { &v["error"] } else { &v };
        let code = str_or_num(&err["code"]).or_else(|| str_or_num(&v["code"]));
        let etype = err["type"].as_str().unwrap_or_default().to_string();
        let raw_msg = err["message"]
            .as_str()
            .or_else(|| v["error"].as_str())
            .or_else(|| v["message"].as_str())
            .map(String::from)
            .unwrap_or_else(|| body.chars().take(300).collect());
        let message = clean_message(&raw_msg);
        let lower = raw_msg.to_ascii_lowercase();
        let code_is = |set: &[&str]| code.as_deref().is_some_and(|c| set.contains(&c));
        let kind = if status == 401 || status == 403 || etype == "authentication_error" || etype == "permission_error" {
            Kind::Auth
        } else if status == 402 || code_is(QUOTA_CODES) || QUOTA_WORDS.iter().any(|w| lower.contains(w)) {
            Kind::Quota
        } else if status == 429 || etype == "rate_limit_error" || code_is(RATE_CODES) {
            Kind::RateLimit
        } else if status == 529 || status == 503 || etype == "overloaded_error" || code.as_deref() == Some("1305") {
            Kind::Overloaded
        } else if status == 404 || etype == "not_found_error" {
            Kind::Unavailable
        } else if status >= 500 {
            Kind::Server
        } else {
            Kind::Request
        };
        let resets_at = reset_from_message(&raw_msg, route.reset_offset_min, now).or_else(|| reset_from_headers(headers, now));
        UpstreamError {
            status: Some(status),
            code,
            body: body.chars().take(2000).collect(),
            resets_at,
            ..Self::base(route, kind, message)
        }
    }

    pub fn network(route: &Route, e: &str) -> Self {
        Self::base(route, Kind::Network, e.to_string())
    }

    pub fn stream(route: &Route, e: &str) -> Self {
        Self::base(route, Kind::Stream, e.to_string())
    }

    /// An error event inside a reply stream (`{"type":"error","error":{...}}`): classified like
    /// a response (an `overloaded_error` before any text can still degrade).
    pub fn stream_event(route: &Route, err: &Value, now: u64) -> Self {
        let body = json!({ "error": err }).to_string();
        let mut e = Self::from_response(route, 200, &reqwest::header::HeaderMap::new(), &body, now);
        e.status = None;
        if e.kind == Kind::Request {
            e.kind = Kind::Stream;
        }
        e
    }

    /// The legacy one-line form (`upstream 429 Too Many Requests: {body}`), kept for logs and
    /// for clients that grep the message.
    pub fn line(&self) -> String {
        match (self.status, self.kind) {
            (Some(s), _) if !self.body.is_empty() => {
                let reason = reqwest::StatusCode::from_u16(s).ok().and_then(|c| c.canonical_reason()).unwrap_or("");
                format!("upstream {s} {reason}: {}", self.body)
            }
            (_, Kind::Network) => format!("request failed: {}", self.message),
            _ => self.message.clone(),
        }
    }

    /// The headline a person reads (banner, spoken reply).
    pub fn headline(&self, now: u64) -> String {
        let what = match self.kind {
            Kind::Quota => "provider limit exhausted",
            Kind::RateLimit => "provider rate-limited",
            Kind::Auth => "provider refused the key",
            Kind::Overloaded => "provider overloaded",
            Kind::Server => "provider error",
            Kind::Network => "provider unreachable",
            Kind::Unavailable => "provider has no such model",
            Kind::Request => "provider rejected the request",
            Kind::Stream => "provider dropped the reply",
        };
        match self.resets_at {
            Some(t) => format!("{what}, resets {} ({})", local_time(t), until(t, now)),
            None => what.to_string(),
        }
    }

    /// `provider/model: <status/code>: message`. A parsed reset is dropped from the provider's
    /// words: theirs is in THEIR zone (z.ai: UTC+8), the headline already says it in ours.
    pub fn detail(&self) -> String {
        let mut tag = Vec::new();
        if let Some(s) = self.status {
            tag.push(s.to_string());
        }
        if let Some(c) = &self.code {
            tag.push(format!("code {c}"));
        }
        let tag = if tag.is_empty() { String::new() } else { format!(" ({})", tag.join(", ")) };
        let words = if self.resets_at.is_some() { drop_reset_clause(&self.message) } else { self.message.clone() };
        let mut d = format!("{}/{}{tag}: {}", self.provider, self.model, words.chars().take(300).collect::<String>());
        if self.kind == Kind::Auth {
            d.push_str(&format!(" — the key is yours to fix: {}", self.key_source));
        }
        d
    }

    /// The `data` of the stored opencode-shaped error (`APIError` / `ProviderAuthError`).
    pub fn data(&self, now: u64) -> Value {
        let mut d = json!({
            "message": format!("{} — {}", self.headline(now), self.detail()),
            "providerID": self.provider, "modelID": self.model, "kind": self.kind.name(),
            "isRetryable": self.kind.degrades(),
        });
        if let Some(s) = self.status {
            d["statusCode"] = json!(s);
        }
        if let Some(c) = &self.code {
            d["code"] = json!(c);
        }
        if let Some(t) = self.resets_at {
            d["resetsAt"] = json!(t);
        }
        if !self.body.is_empty() {
            d["responseBody"] = json!(self.body);
        }
        d
    }

    pub fn error_name(&self) -> &'static str {
        if self.kind == Kind::Auth { "ProviderAuthError" } else { "APIError" }
    }
}

/// `Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-10-29 03:44:03` →
/// `Weekly/Monthly Limit Exhausted.` (the sentence holding the reset moment goes).
fn drop_reset_clause(m: &str) -> String {
    let lower = m.to_ascii_lowercase();
    for marker in ["reset at ", "resets at ", "reset on ", "resets on "] {
        let Some(i) = lower.find(marker) else { continue };
        let at = i + marker.len();
        if parse_datetime(&m[at..], 0).is_none() {
            continue;
        }
        let start = m[..i].rfind(['.', ';', ']']).map_or(0, |p| p + 1);
        let mut end = (at + 19).min(m.len());
        while end < m.len() && !m.is_char_boundary(end) {
            end += 1;
        }
        let tail = m[end..].strip_prefix('.').unwrap_or(&m[end..]);
        let out = format!("{}{}", &m[..start], tail).trim().to_string();
        return if out.is_empty() { m.to_string() } else { out };
    }
    m.to_string()
}

// ---------------------------------------------------------------------------------------
// Time: civil dates without a date crate.

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn num(s: &str) -> Option<i64> {
    (!s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())).then(|| s.parse().ok()).flatten()
}

/// `YYYY-MM-DD[ T]HH:MM:SS[.frac][Z|±HH:MM]` at the start of `s` → epoch ms. No zone =
/// `default_offset_min`.
pub fn parse_datetime(s: &str, default_offset_min: i32) -> Option<u64> {
    let s = s.trim_start();
    if s.len() < 19 {
        return None;
    }
    let b = s.as_bytes();
    if b[4] != b'-' || b[7] != b'-' || !(b[10] == b' ' || b[10] == b'T') || b[13] != b':' || b[16] != b':' {
        return None;
    }
    let (y, mo, d) = (num(&s[0..4])?, num(&s[5..7])?, num(&s[8..10])?);
    let (h, mi, se) = (num(&s[11..13])?, num(&s[14..16])?, num(&s[17..19])?);
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 23 || mi > 59 || se > 60 {
        return None;
    }
    let mut rest = &s[19..];
    if let Some(r) = rest.strip_prefix('.') {
        rest = r.trim_start_matches(|c: char| c.is_ascii_digit());
    }
    let offset = if rest.starts_with('Z') {
        0
    } else if rest.starts_with('+') || rest.starts_with('-') {
        parse_offset(rest.get(0..6).unwrap_or(rest)).unwrap_or(default_offset_min)
    } else {
        default_offset_min
    };
    let secs = days_from_civil(y, mo, d) * 86_400 + h * 3600 + mi * 60 + se - offset as i64 * 60;
    (secs >= 0).then(|| secs as u64 * 1000)
}

/// RFC 7231 `Wed, 21 Oct 2015 07:28:00 GMT` → epoch ms.
fn parse_http_date(s: &str) -> Option<u64> {
    const MON: [&str; 12] = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
    let f: Vec<&str> = s.split_whitespace().collect();
    if f.len() < 5 {
        return None;
    }
    let d = num(f[1])?;
    let mo = MON.iter().position(|m| f[2].eq_ignore_ascii_case(m))? as i64 + 1;
    let y = num(f[3])?;
    let t: Vec<i64> = f[4].split(':').map(num).collect::<Option<Vec<_>>>()?;
    if t.len() != 3 {
        return None;
    }
    let secs = days_from_civil(y, mo, d) * 86_400 + t[0] * 3600 + t[1] * 60 + t[2];
    (secs >= 0).then(|| secs as u64 * 1000)
}

/// Go-style durations as OpenAI sends them: `6m0s`, `1s`, `20ms`, `1h2m3.5s`, or bare seconds.
pub fn parse_duration_ms(s: &str) -> Option<u64> {
    let s = s.trim();
    if let Ok(secs) = s.parse::<f64>() {
        return (secs >= 0.0).then(|| (secs * 1000.0) as u64);
    }
    let (mut total, mut i, b) = (0f64, 0, s.as_bytes());
    let mut any = false;
    while i < b.len() {
        let start = i;
        while i < b.len() && (b[i].is_ascii_digit() || b[i] == b'.') {
            i += 1;
        }
        let n: f64 = s[start..i].parse().ok()?;
        let ustart = i;
        while i < b.len() && b[i].is_ascii_alphabetic() {
            i += 1;
        }
        let mult = match &s[ustart..i] {
            "h" => 3_600_000.0,
            "m" => 60_000.0,
            "s" => 1000.0,
            "ms" => 1.0,
            _ => return None,
        };
        total += n * mult;
        any = true;
    }
    any.then_some(total as u64)
}

/// A reset moment the provider wrote into its message: `reset at <datetime>` (z.ai) or
/// `try again in <duration>` (OpenAI).
pub fn reset_from_message(msg: &str, offset_min: i32, now: u64) -> Option<u64> {
    let lower = msg.to_ascii_lowercase();
    for marker in ["reset at ", "resets at ", "reset on ", "resets on ", "available at "] {
        if let Some(i) = lower.find(marker) {
            if let Some(t) = parse_datetime(&msg[i + marker.len()..], offset_min) {
                return Some(t);
            }
        }
    }
    if let Some(i) = lower.find("try again in ") {
        let tail: String = msg[i + 13..].chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '.').collect();
        if let Some(d) = parse_duration_ms(tail.trim_end_matches('.')) {
            return Some(now + d);
        }
    }
    None
}

/// Reset hints in headers; the LATEST one wins (whichever limit ran out is the binding one).
pub fn reset_from_headers(h: &reqwest::header::HeaderMap, now: u64) -> Option<u64> {
    let get = |k: &str| h.get(k).and_then(|v| v.to_str().ok()).map(str::trim);
    let mut best: Option<u64> = None;
    let mut take = |t: Option<u64>| {
        if let Some(t) = t {
            best = Some(best.map_or(t, |b| b.max(t)));
        }
    };
    if let Some(v) = get("retry-after") {
        take(v.parse::<u64>().ok().map(|s| now + s * 1000).or_else(|| parse_http_date(v)));
    }
    for k in [
        "anthropic-ratelimit-requests-reset",
        "anthropic-ratelimit-tokens-reset",
        "anthropic-ratelimit-input-tokens-reset",
        "anthropic-ratelimit-output-tokens-reset",
    ] {
        take(get(k).and_then(|v| parse_datetime(v, 0)));
    }
    for k in ["x-ratelimit-reset-requests", "x-ratelimit-reset-tokens"] {
        take(get(k).and_then(parse_duration_ms).map(|d| now + d));
    }
    best
}

/// `2026-10-28 20:44 CET` in the root's local zone (the zone the phone's owner lives in).
pub fn local_time(ms: u64) -> String {
    let t = (ms / 1000) as libc::time_t;
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    unsafe extern "C" {
        fn tzset();
    }
    unsafe {
        tzset();
        if libc::localtime_r(&t, &mut tm).is_null() {
            return format!("{ms} ms");
        }
    }
    let zone = if tm.tm_zone.is_null() {
        String::new()
    } else {
        unsafe { std::ffi::CStr::from_ptr(tm.tm_zone) }.to_string_lossy().into_owned()
    };
    format!("{:04}-{:02}-{:02} {:02}:{:02} {zone}", tm.tm_year + 1900, tm.tm_mon + 1, tm.tm_mday, tm.tm_hour, tm.tm_min)
        .trim_end()
        .to_string()
}

/// `in 1 h 2 min` / `in 40 s` / `now`.
pub fn until(t: u64, now: u64) -> String {
    if t <= now {
        return "now".into();
    }
    let s = (t - now) / 1000;
    match s {
        0..=59 => format!("in {s} s"),
        60..=3599 => format!("in {} min", s.div_ceil(60)),
        _ => format!("in {} h {} min", s / 3600, (s % 3600) / 60),
    }
}

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).unwrap().as_millis() as u64
}

// ---------------------------------------------------------------------------------------
// Health: what each provider did last, and until when it is skipped.

#[derive(Clone, Debug, Default)]
pub struct Entry {
    pub status: String,
    pub until: Option<u64>,
    pub last_error: Option<UpstreamError>,
    pub last_ok: Option<u64>,
    pub last_model: String,
    pub since: u64,
}

#[derive(Default)]
pub struct Health {
    map: Mutex<HashMap<String, Entry>>,
}

impl Health {
    /// The provider is being skipped: its cached error (reset time included).
    pub fn cooling(&self, provider: &str, now: u64) -> Option<UpstreamError> {
        let map = self.map.lock().unwrap();
        let e = map.get(provider)?;
        (e.until.is_some_and(|u| u > now)).then(|| e.last_error.clone()).flatten()
    }

    /// Returns true when the status changed (worth an event).
    pub fn ok(&self, route: &Route, now: u64) -> bool {
        let mut map = self.map.lock().unwrap();
        let e = map.entry(route.provider.clone()).or_default();
        let changed = e.status != "ok";
        if changed {
            e.since = now;
        }
        e.status = "ok".into();
        e.until = None;
        e.last_ok = Some(now);
        e.last_model = route.model.clone();
        changed
    }

    pub fn fail(&self, err: &UpstreamError, now: u64) {
        let mut map = self.map.lock().unwrap();
        let e = map.entry(err.provider.clone()).or_default();
        let status = err.kind.status();
        if e.status != status {
            e.since = now;
        }
        e.status = status.into();
        e.until = err.resets_at.filter(|t| *t > now).or_else(|| err.kind.backoff_ms().map(|b| now + b));
        e.last_error = Some(err.clone());
        e.last_model = err.model.clone();
    }

    pub fn clear(&self, provider: &str) {
        self.map.lock().unwrap().remove(provider);
    }

    /// Auth cooldowns end when the config changes (the user fixed the key).
    pub fn clear_auth(&self) {
        self.map.lock().unwrap().retain(|_, e| e.status != "auth");
    }

    pub fn entry_json(e: &Entry, now: u64) -> Value {
        let mut v = json!({ "status": e.status, "since": e.since, "model": e.last_model });
        if let Some(u) = e.until.filter(|u| *u > now) {
            v["until"] = json!(u);
        }
        if let Some(t) = e.last_ok {
            v["lastOk"] = json!(t);
        }
        if let Some(err) = &e.last_error {
            v["lastError"] = err.data(now);
            v["headline"] = json!(err.headline(now));
            if let Some(t) = err.resets_at {
                v["resetsAt"] = json!(t);
            }
        }
        v
    }

    pub fn get(&self, provider: &str) -> Option<Entry> {
        self.map.lock().unwrap().get(provider).cloned()
    }

    /// Every provider in the registry: unused ones read `unknown`.
    pub fn snapshot(&self, reg: &Registry, now: u64) -> Value {
        let map = self.map.lock().unwrap();
        let mut out = serde_json::Map::new();
        for p in &reg.providers {
            let v = match map.get(&p.id) {
                Some(e) => Self::entry_json(e, now),
                None => json!({ "status": "unknown" }),
            };
            out.insert(p.id.clone(), v);
        }
        Value::Object(out)
    }
}

// ---------------------------------------------------------------------------------------
// The live registry: re-read when the file changes.

pub struct Providers {
    pub path: PathBuf,
    current: Mutex<(Arc<Registry>, Option<SystemTime>)>,
    /// Last reload failure (shown on `/provider`), cleared by a good reload.
    pub reload_error: Mutex<Option<String>>,
    pub health: Health,
}

fn mtime(p: &Path) -> Option<SystemTime> {
    std::fs::metadata(p).and_then(|m| m.modified()).ok()
}

fn process_env(k: &str) -> Option<String> {
    std::env::var(k).ok()
}

impl Providers {
    pub fn boot() -> Result<Providers, String> {
        let path = default_path(&process_env);
        let stamp = mtime(&path);
        let reg = Registry::load(&process_env, &path)?.ok_or_else(|| {
            format!("no provider configured: set YGG_UPSTREAM_BASE_URL or write {}", path.display())
        })?;
        Ok(Providers {
            path,
            current: Mutex::new((Arc::new(reg), stamp)),
            reload_error: Mutex::new(None),
            health: Health::default(),
        })
    }

    /// The registry, reloaded first if the file changed (or appeared/vanished).
    pub fn current(&self) -> Arc<Registry> {
        let stamp = mtime(&self.path);
        let mut cur = self.current.lock().unwrap();
        if stamp != cur.1 {
            cur.1 = stamp;
            match Registry::load(&process_env, &self.path) {
                Ok(Some(reg)) => {
                    eprintln!("providers: reloaded {} (default {}, fallback [{}])", reg.source, reg.default.show(),
                        reg.fallback.iter().map(Ref::show).collect::<Vec<_>>().join(", "));
                    cur.0 = Arc::new(reg);
                    *self.reload_error.lock().unwrap() = None;
                    self.health.clear_auth();
                }
                Ok(None) => {
                    let e = format!("{} removed and no env provider: keeping the last registry", self.path.display());
                    eprintln!("providers: {e}");
                    *self.reload_error.lock().unwrap() = Some(e);
                }
                Err(e) => {
                    eprintln!("providers: reload failed, keeping the last good registry: {e}");
                    *self.reload_error.lock().unwrap() = Some(e);
                }
            }
        }
        cur.0.clone()
    }
}

// ---------------------------------------------------------------------------------------
// Probes: the health check.

pub struct ProbeResult {
    pub ok: bool,
    pub status: String,
    pub detail: String,
    pub error: Option<UpstreamError>,
}

fn models_url(r: &Route) -> String {
    let base = r.base_url.trim_end_matches('/');
    match r.dialect {
        Dialect::OpenAi => format!("{base}/models"),
        Dialect::Anthropic if base.ends_with("/v1") => format!("{base}/models"),
        Dialect::Anthropic => format!("{base}/v1/models"),
    }
}

fn authed(req: reqwest::RequestBuilder, r: &Route) -> reqwest::RequestBuilder {
    let req = if r.dialect == Dialect::Anthropic { req.header("anthropic-version", "2023-06-01") } else { req };
    match &r.key {
        Some(k) if r.dialect == Dialect::Anthropic => req.header("x-api-key", k).bearer_auth(k),
        Some(k) => req.bearer_auth(k),
        None => req,
    }
}

/// Shallow: `GET models` (free on every provider that has it; a 404 there is not a verdict).
/// Deep: a 1-token completion on the route's model — it costs one request of the user's plan,
/// so only on demand.
pub async fn probe(http: &reqwest::Client, r: &Route, deep: bool) -> ProbeResult {
    let now = now_ms();
    let mk = |ok: bool, status: &str, detail: String, error: Option<UpstreamError>| ProbeResult {
        ok,
        status: status.into(),
        detail,
        error,
    };
    let req = if deep {
        let body = match r.dialect {
            Dialect::OpenAi => json!({ "model": r.model, "max_tokens": 1, "stream": false,
                "messages": [{ "role": "user", "content": "ping" }] }),
            Dialect::Anthropic => json!({ "model": r.model, "max_tokens": 1,
                "messages": [{ "role": "user", "content": [{ "type": "text", "text": "ping" }] }] }),
        };
        let url = match r.dialect {
            Dialect::OpenAi => format!("{}/chat/completions", r.base_url.trim_end_matches('/')),
            Dialect::Anthropic => crate::anthropic::messages_url(&r.base_url),
        };
        authed(http.post(url).json(&body), r)
    } else {
        authed(http.get(models_url(r)), r)
    };
    let resp = match req.timeout(Duration::from_secs(10)).send().await {
        Ok(x) => x,
        Err(e) => {
            let err = UpstreamError::network(r, &e.to_string());
            return mk(false, "down", format!("unreachable: {e}"), Some(err));
        }
    };
    let status = resp.status().as_u16();
    let headers = resp.headers().clone();
    let body = resp.text().await.unwrap_or_default();
    if (200..300).contains(&status) {
        let detail = if deep {
            format!("{} answered", r.model)
        } else {
            let v: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
            let ids: Vec<String> = v["data"]
                .as_array()
                .or_else(|| v["models"].as_array())
                .into_iter()
                .flatten()
                .filter_map(|m| m["id"].as_str().or_else(|| m["name"].as_str()).map(String::from))
                .collect();
            if ids.is_empty() {
                "reachable".into()
            } else if ids.iter().any(|i| i == &r.model) {
                format!("reachable, {} listed ({} models)", r.model, ids.len())
            } else {
                format!("reachable, but {} NOT among its {} models", r.model, ids.len())
            }
        };
        return mk(true, "ok", detail, None);
    }
    let err = UpstreamError::from_response(r, status, &headers, &body, now);
    if !deep && status == 404 {
        // no models endpoint (z.ai's anthropic door) — reachable, key unverified
        return mk(true, "reachable", "reachable (no models endpoint; `--deep` verifies the key)".into(), None);
    }
    mk(false, err.kind.status(), format!("{} — {}", err.headline(now), err.detail()), Some(err))
}

// ---------------------------------------------------------------------------------------
// CLI: `yggdrasil provider <list|check|status|use|fallback|add|remove>`

const USAGE: &str = "usage: yggdrasil provider <command> [--file PATH] [--env FILE]
  list                         the catalog, the default, the fallback order, key sources
  check [ID] [--deep]          probe providers (GET models; --deep = a 1-token reply, costs 1 request)
  status [--listen HOST:PORT]  the running root's provider health (GET /provider/health)
  use PROVIDER/MODEL           set the default model (the file's \"model\")
  fallback [P/M,P/M,...]       set the degrade order (empty = none)
  add ID --base-url URL --model M[,M...] [--dialect openai|anthropic] [--key-env NAME | --key-file PATH] [--name N]
  remove ID                    drop a provider from the file
The file: --file, else $YGG_PROVIDERS, else ~/.config/yggdrasil/providers.json.
--env FILE (default $YGG_ENV_FILE) loads KEY=VALUE lines first (the unit's EnvironmentFile), so the env provider and
{env:NAME} keys resolve the way the service sees them. Keys never go on the command line.";

fn parse_env_file(path: &str) -> Result<HashMap<String, String>, String> {
    let text = std::fs::read_to_string(expand(path)).map_err(|e| format!("{path}: {e}"))?;
    Ok(text
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .filter_map(|l| l.split_once('='))
        .map(|(k, v)| (k.trim().to_string(), v.trim().trim_matches('"').to_string()))
        .collect())
}

fn read_file(path: &Path) -> Result<Value, String> {
    match std::fs::read(path) {
        Ok(b) => serde_json::from_slice(&b).map_err(|e| format!("{}: {e}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(json!({})),
        Err(e) => Err(format!("{}: {e}", path.display())),
    }
}

/// Atomic, 0600 (the file may hold an inline key).
fn write_file(path: &Path, v: &Value) -> Result<(), String> {
    use std::os::unix::fs::OpenOptionsExt;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    }
    let tmp = path.with_extension("json.tmp");
    let mut bytes = serde_json::to_vec_pretty(v).map_err(|e| e.to_string())?;
    bytes.push(b'\n');
    std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&tmp)
        .and_then(|mut f| std::io::Write::write_all(&mut f, &bytes))
        .and_then(|_| std::fs::rename(&tmp, path))
        .map_err(|e| format!("{}: {e}", path.display()))
}

pub async fn cli(args: Vec<String>) -> i32 {
    match cli_inner(args).await {
        Ok(code) => code,
        Err(e) => {
            eprintln!("yggdrasil provider: {e}");
            2
        }
    }
}

async fn cli_inner(args: Vec<String>) -> Result<i32, String> {
    let mut pos: Vec<String> = Vec::new();
    let mut flags: HashMap<String, String> = HashMap::new();
    let mut it = args.into_iter();
    while let Some(a) = it.next() {
        match a.strip_prefix("--") {
            Some("deep") => {
                flags.insert("deep".into(), "1".into());
            }
            Some("help") => {
                println!("{USAGE}");
                return Ok(0);
            }
            Some(k) => {
                let v = it.next().ok_or_else(|| format!("--{k} needs a value"))?;
                flags.insert(k.into(), v);
            }
            None => pos.push(a),
        }
    }
    let env_file = flags.get("env").cloned().or_else(|| std::env::var("YGG_ENV_FILE").ok().filter(|v| !v.is_empty()));
    let file_env = match &env_file {
        Some(p) => parse_env_file(p)?,
        None => HashMap::new(),
    };
    let env = |k: &str| file_env.get(k).cloned().or_else(|| std::env::var(k).ok());
    // without the root's env the env provider (`yggdrasil`) is invisible: say so, once
    let no_env_note = || {
        if env("YGG_UPSTREAM_BASE_URL").is_none() {
            eprintln!("note: no YGG_UPSTREAM_* here — the env provider `{ENV_PROVIDER}` is not visible; pass --env <the root's EnvironmentFile> (or set YGG_ENV_FILE)");
        }
    };
    let path = match flags.get("file") {
        Some(p) => expand(p),
        None => default_path(&env),
    };
    let cmd = pos.first().map(String::as_str).unwrap_or("");
    if matches!(cmd, "list" | "check" | "use" | "fallback" | "add" | "remove") {
        no_env_note();
    }
    match cmd {
        "list" => {
            let Some(reg) = Registry::load(&env, &path)? else {
                println!("no provider configured (no YGG_UPSTREAM_BASE_URL, no {})", path.display());
                return Ok(1);
            };
            println!("source:   {}", reg.source);
            println!("default:  {}", reg.default.show());
            let fb: Vec<String> = reg.fallback.iter().map(Ref::show).collect();
            println!("fallback: {}", if fb.is_empty() { "(none — a quota stop ends the turn)".into() } else { fb.join(" → ") });
            for p in &reg.providers {
                let key = match (&p.key, p.key_source.as_str()) {
                    (_, "none") => "no key".to_string(),
                    (Some(_), s) => format!("key {s} ✓"),
                    (None, s) => format!("key {s} MISSING"),
                };
                let models: Vec<&str> = p.models.iter().map(|(id, _)| id.as_str()).collect();
                println!("  {:<16} {:<9} {:<40} {:<28} {}", p.id, p.dialect.name(), p.base_url, key, models.join(", "));
            }
            Ok(0)
        }
        "check" => {
            let reg = Registry::load(&env, &path)?.ok_or("no provider configured")?;
            let http = reqwest::Client::new();
            let deep = flags.contains_key("deep");
            let mut default_ok = true;
            let mut targets: Vec<Route> = reg.chain(None);
            for p in &reg.providers {
                if !targets.iter().any(|r| r.provider == p.id) {
                    targets.extend(reg.route(&Ref { provider: p.id.clone(), model: p.models[0].0.clone() }));
                }
            }
            if let Some(id) = pos.get(1) {
                targets.retain(|r| &r.provider == id);
                if targets.is_empty() {
                    return Err(format!("no provider {id}"));
                }
            }
            for r in &targets {
                let res = probe(&http, r, deep).await;
                if r.provider == reg.default.provider && !res.ok {
                    default_ok = false;
                }
                println!("{} {:<24} {:<10} {}", if res.ok { "✓" } else { "✗" }, r.show(), res.status, res.detail);
            }
            Ok(if default_ok { 0 } else { 1 })
        }
        "status" => {
            let listen = flags
                .get("listen")
                .cloned()
                .or_else(|| env("YGG_LISTEN"))
                .unwrap_or_else(|| "127.0.0.1:4096".into());
            let url = format!("http://{listen}/provider/health");
            let v: Value = reqwest::get(&url)
                .await
                .map_err(|e| format!("{url}: {e}"))?
                .json()
                .await
                .map_err(|e| format!("{url}: {e}"))?;
            println!("{}", serde_json::to_string_pretty(&v).unwrap_or_default());
            Ok(0)
        }
        "use" => {
            let r = pos.get(1).and_then(|s| Ref::parse(s)).ok_or("use PROVIDER/MODEL")?;
            let mut f = read_file(&path)?;
            let prev = f.get("model").cloned();
            f["model"] = json!(r.show());
            check_write(&env, &path, &f, prev.map(|p| format!("model was {p}")))
        }
        "fallback" => {
            let list: Vec<Value> = pos
                .get(1)
                .map(|s| s.split(',').map(str::trim).filter(|s| !s.is_empty()).map(|s| json!(s)).collect())
                .unwrap_or_default();
            let mut f = read_file(&path)?;
            f["fallback"] = json!(list);
            check_write(&env, &path, &f, None)
        }
        "add" => {
            let id = pos.get(1).ok_or("add ID --base-url URL --model M")?;
            if flags.contains_key("key") || flags.contains_key("api-key") {
                return Err("keys never go on the command line (shell history): --key-env NAME or --key-file PATH".into());
            }
            let models = flags.get("model").ok_or("--model M[,M...] is required")?;
            let mut opts = json!({});
            if let Some(b) = flags.get("base-url") {
                opts["baseURL"] = json!(b);
            }
            match (flags.get("key-env"), flags.get("key-file")) {
                (Some(n), None) => opts["apiKey"] = json!(format!("{{env:{n}}}")),
                (None, Some(p)) => opts["apiKey"] = json!(format!("{{file:{p}}}")),
                (Some(_), Some(_)) => return Err("--key-env or --key-file, not both".into()),
                (None, None) => {}
            }
            let mut entry = json!({ "options": opts, "models": {} });
            for m in models.split(',').map(str::trim).filter(|m| !m.is_empty()) {
                entry["models"][m] = json!({});
            }
            if let Some(d) = flags.get("dialect") {
                Dialect::parse(d).ok_or_else(|| format!("--dialect {d}: openai | anthropic"))?;
                entry["dialect"] = json!(d);
            }
            if let Some(n) = flags.get("name") {
                entry["name"] = json!(n);
            }
            let mut f = read_file(&path)?;
            if !f["provider"].is_object() {
                f["provider"] = json!({});
            }
            f["provider"][id.as_str()] = entry;
            check_write(&env, &path, &f, None)
        }
        "remove" => {
            let id = pos.get(1).ok_or("remove ID")?;
            let mut f = read_file(&path)?;
            let gone = f["provider"].as_object_mut().and_then(|m| m.remove(id.as_str())).is_some();
            if !gone {
                return Err(format!("no provider {id} in {}", path.display()));
            }
            check_write(&env, &path, &f, None)
        }
        _ => {
            println!("{USAGE}");
            Ok(if cmd.is_empty() { 0 } else { 2 })
        }
    }
}

/// Validates the edited file as the root would load it, writes only if it loads.
fn check_write(env: Env, path: &Path, f: &Value, note: Option<String>) -> Result<i32, String> {
    let dir = std::env::temp_dir().join(format!("ygg-provider-check-{}", std::process::id()));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let probe = dir.join("providers.json");
    write_file(&probe, f)?;
    let loaded = Registry::load(env, &probe);
    let _ = std::fs::remove_dir_all(&dir);
    let reg = loaded.map_err(|e| format!("refused (the root would not load it): {e}"))?.ok_or("refused: no provider left")?;
    write_file(path, f)?;
    println!("wrote {}", path.display());
    if let Some(n) = note {
        println!("{n}");
    }
    println!("default {} · fallback [{}] — a running root picks it up on its next run",
        reg.default.show(), reg.fallback.iter().map(Ref::show).collect::<Vec<_>>().join(", "));
    Ok(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env_of(pairs: &'static [(&'static str, &'static str)]) -> impl Fn(&str) -> Option<String> {
        move |k| pairs.iter().find(|(a, _)| *a == k).map(|(_, v)| v.to_string())
    }

    fn route(offset: i32) -> Route {
        Route {
            provider: "zai".into(),
            model: "glm-4.6".into(),
            dialect: Dialect::Anthropic,
            base_url: "https://api.z.ai/api/anthropic".into(),
            key: Some("k".into()),
            key_source: "env:ZAI_API_KEY".into(),
            max_tokens: None,
            reset_offset_min: offset,
        }
    }

    #[test]
    fn civil_dates() {
        assert_eq!(days_from_civil(1970, 1, 1), 0);
        assert_eq!(days_from_civil(2000, 3, 1), 11_017);
        // 2026-10-29 03:44:03 +08:00 == 2026-10-28 19:44:03 UTC
        let t = parse_datetime("2026-10-29 03:44:03", 480).unwrap();
        assert_eq!(t, parse_datetime("2026-10-28T19:44:03Z", 0).unwrap());
        assert_eq!(t / 1000, 1_793_216_643);
        assert_eq!(parse_datetime("2026-10-28T19:44:03.120+00:00", 480), Some(1_793_216_643_000));
        assert_eq!(parse_http_date("Wed, 28 Oct 2026 19:44:03 GMT"), Some(1_793_216_643_000));
        assert!(parse_datetime("not a date at all......", 0).is_none());
    }

    #[test]
    fn durations() {
        assert_eq!(parse_duration_ms("6m0s"), Some(360_000));
        assert_eq!(parse_duration_ms("1s"), Some(1000));
        assert_eq!(parse_duration_ms("20ms"), Some(20));
        assert_eq!(parse_duration_ms("1h2m3.5s"), Some(3_723_500));
        assert_eq!(parse_duration_ms("12"), Some(12_000));
        assert_eq!(parse_duration_ms("soon"), None);
    }

    #[test]
    fn zai_1310_is_quota_with_its_reset() {
        let body = r#"{"type":"error","error":{"type":"rate_limit_error","code":"1310","message":"[1310][Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-10-29 03:44:03][2026102903235075c9a8c7e055450c]"},"request_id":"2026102903235075c9a8c7e055450c"}"#;
        let e = UpstreamError::from_response(&route(480), 429, &reqwest::header::HeaderMap::new(), body, 0);
        assert_eq!(e.kind, Kind::Quota);
        assert_eq!(e.code.as_deref(), Some("1310"));
        assert_eq!(e.resets_at, Some(1_793_216_643_000));
        assert_eq!(e.message, "Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-10-29 03:44:03");
        assert!(e.headline(1_793_216_643_000 - 3_600_000).starts_with("provider limit exhausted, resets 2026-10-"));
        assert!(e.line().starts_with("upstream 429 Too Many Requests: {"));
        assert_eq!(e.detail(), "zai/glm-4.6 (429, code 1310): Weekly/Monthly Limit Exhausted.");
        let d = e.data(0);
        assert_eq!(d["resetsAt"], 1_793_216_643_000u64);
        assert_eq!(d["kind"], "quota");
        assert_eq!(d["statusCode"], 429);
    }

    #[test]
    fn classification_table() {
        let h = reqwest::header::HeaderMap::new();
        let r = route(0);
        let k = |s: u16, b: &str| UpstreamError::from_response(&r, s, &h, b, 0).kind;
        assert_eq!(k(429, r#"{"error":{"code":"1113","message":"Insufficient balance or no resource package. Please recharge."}}"#), Kind::Quota);
        assert_eq!(k(429, r#"{"error":{"type":"insufficient_quota","code":"insufficient_quota","message":"You exceeded your current quota"}}"#), Kind::Quota);
        assert_eq!(k(429, r#"{"type":"error","error":{"type":"rate_limit_error","message":"Number of request tokens has exceeded your per-minute rate limit"}}"#), Kind::RateLimit);
        assert_eq!(k(429, r#"{"error":{"code":"1302","message":"High concurrency"}}"#), Kind::RateLimit);
        assert_eq!(k(401, r#"{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}"#), Kind::Auth);
        assert_eq!(k(529, r#"{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}"#), Kind::Overloaded);
        assert_eq!(k(404, r#"{"error":"model 'qwen3' not found, try pulling it first"}"#), Kind::Unavailable);
        assert_eq!(k(502, "bad gateway"), Kind::Server);
        assert_eq!(k(400, r#"{"error":{"message":"messages: roles must alternate"}}"#), Kind::Request);
        assert!(!Kind::Request.degrades() && !Kind::Stream.degrades() && Kind::Quota.degrades());
    }

    #[test]
    fn reset_hints() {
        let now = 1_000_000;
        assert_eq!(reset_from_message("Please try again in 20s.", 0, now), Some(now + 20_000));
        assert_eq!(reset_from_message("limit will reset at 2026-10-28 19:44:03", 0, now), Some(1_793_216_643_000));
        let mut h = reqwest::header::HeaderMap::new();
        h.insert("retry-after", "30".parse().unwrap());
        h.insert("x-ratelimit-reset-tokens", "6m0s".parse().unwrap());
        assert_eq!(reset_from_headers(&h, now), Some(now + 360_000));
        let mut h = reqwest::header::HeaderMap::new();
        h.insert("anthropic-ratelimit-tokens-reset", "2026-10-28T19:44:03Z".parse().unwrap());
        assert_eq!(reset_from_headers(&h, now), Some(1_793_216_643_000));
    }

    #[test]
    fn registry_env_only_is_the_old_single_upstream() {
        let env = env_of(&[("YGG_UPSTREAM_BASE_URL", "https://api.z.ai/api/anthropic"), ("YGG_UPSTREAM_STYLE", "anthropic"),
            ("YGG_UPSTREAM_MODEL", "glm-4.6"), ("YGG_UPSTREAM_API_KEY", "sk")]);
        let reg = Registry::load(&env, Path::new("/nonexistent/providers.json")).unwrap().unwrap();
        assert_eq!(reg.default.show(), "yggdrasil/glm-4.6");
        assert_eq!(reg.catalog()["default"], json!({ "yggdrasil": "glm-4.6" }));
        let c = reg.chain(None);
        assert_eq!(c.len(), 1);
        assert_eq!((c[0].dialect, c[0].reset_offset_min, c[0].key.as_deref()), (Dialect::Anthropic, 480, Some("sk")));
        assert!(Registry::load(&env_of(&[]), Path::new("/nonexistent")).unwrap().is_none());
    }

    #[test]
    fn registry_file_merges_env_and_orders_the_chain() {
        let dir = std::env::temp_dir().join(format!("ygg-prov-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("providers.json");
        std::fs::write(&dir.join("key"), "sk-file\n").unwrap();
        std::fs::write(&f, json!({
            "fallback": ["ollama/qwen3:8b", "mine/m1"],
            "provider": {
                "ollama": { "models": { "qwen3:8b": {} } },
                "mine": { "npm": "@ai-sdk/anthropic", "options": { "baseURL": "http://h/x", "apiKey": format!("{{file:{}}}", dir.join("key").display()) },
                          "models": { "m1": { "name": "M One" }, "m2": {} } },
                "keyed": { "options": { "baseURL": "http://k/v1", "apiKey": "{env:MY_KEY}" }, "models": { "a": {} } }
            }
        }).to_string()).unwrap();
        let env = env_of(&[("YGG_UPSTREAM_BASE_URL", "http://e/v1"), ("YGG_UPSTREAM_MODEL", "em")]);
        let reg = Registry::load(&env, &f).unwrap().unwrap();
        assert_eq!(reg.default.show(), "yggdrasil/em");
        let chain: Vec<String> = reg.chain(None).iter().map(Route::show).collect();
        assert_eq!(chain, ["yggdrasil/em", "ollama/qwen3:8b", "mine/m1"]);
        let ollama = reg.provider("ollama").unwrap();
        assert_eq!((ollama.base_url.as_str(), ollama.dialect, ollama.key.is_none()), ("http://127.0.0.1:11434/v1", Dialect::OpenAi, true));
        let mine = reg.provider("mine").unwrap();
        assert_eq!((mine.dialect, mine.key.as_deref(), mine.key_source.starts_with("file:")), (Dialect::Anthropic, Some("sk-file"), true));
        let keyed = reg.provider("keyed").unwrap();
        assert_eq!((keyed.key.is_none(), keyed.key_source.as_str()), (true, "env:MY_KEY"));
        // a session pick leads; the default is not appended behind a pick unless listed
        let pick = Ref::parse("mine/m2").unwrap();
        let chain: Vec<String> = reg.chain(Some(&pick)).iter().map(Route::show).collect();
        assert_eq!(chain, ["mine/m2", "ollama/qwen3:8b", "mine/m1"]);
        // an unknown pick is ignored (the default leads)
        assert_eq!(reg.chain(Some(&Ref::parse("nope/x").unwrap()))[0].show(), "yggdrasil/em");
        // no key material in what the status surfaces print
        let d = reg.describe().to_string();
        assert!(!d.contains("sk-file"), "{d}");
        // YGG_FALLBACK overrides the file's order
        let env2 = env_of(&[("YGG_UPSTREAM_BASE_URL", "http://e/v1"), ("YGG_UPSTREAM_MODEL", "em"), ("YGG_FALLBACK", "mine/m2")]);
        let reg2 = Registry::load(&env2, &f).unwrap().unwrap();
        assert_eq!(reg2.fallback, vec![Ref::parse("mine/m2").unwrap()]);
        // bad references fail loud
        std::fs::write(&f, json!({ "model": "ghost/x", "provider": { "ollama": { "models": { "q": {} } } } }).to_string()).unwrap();
        assert!(Registry::load(&env, &f).unwrap_err().contains("ghost/x"));
        std::fs::write(&f, json!({ "provider": { "p": { "options": { "baseURL": "http://p" }, "models": {} } } }).to_string()).unwrap();
        assert!(Registry::load(&env, &f).unwrap_err().contains("models is empty"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn health_cools_until_the_reset() {
        let h = Health::default();
        let r = route(480);
        let body = r#"{"error":{"code":"1310","message":"[1310][Limit Exhausted. Your limit will reset at 2026-10-29 03:44:03][x]"}}"#;
        let now = 1_793_216_643_000 - 600_000;
        let e = UpstreamError::from_response(&r, 429, &reqwest::header::HeaderMap::new(), body, now);
        h.fail(&e, now);
        assert!(h.cooling("zai", now + 1000).is_some());
        assert!(h.cooling("zai", 1_793_216_643_000 + 1).is_none(), "cooling ends at the reset");
        assert_eq!(h.get("zai").unwrap().status, "exhausted");
        assert!(h.ok(&r, now + 2000));
        assert!(h.cooling("zai", now + 3000).is_none());
        // a request error never cools
        let bad = UpstreamError::from_response(&r, 400, &reqwest::header::HeaderMap::new(), "{}", now);
        h.fail(&bad, now);
        assert!(h.cooling("zai", now + 1).is_none());
    }
}
