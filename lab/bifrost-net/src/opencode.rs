//! Minimal opencode REST client (the seam the PWA proxy uses today).
//! Endpoints verified against the live server via the PWA's own traffic:
//!   GET  /session                 → [{id, title, ...}]
//!   POST /session                 → {title} → session
//!   GET  /session/:id/message     → [messages, oldest first]
//!   POST /session/:id/message     → {parts:[{type:'text',text}]} → run starts

use std::time::Duration;

use ureq::{Agent, AgentBuilder};

#[derive(Clone)]
pub struct OpencodeClient {
    base: String,
    http: Agent,
}

#[derive(serde::Deserialize, Clone)]
pub struct SessionInfo {
    pub id: String,
    #[serde(default)]
    pub title: Option<String>,
}

#[derive(serde::Deserialize, serde::Serialize, Clone, Debug)]
pub struct MessageInfo {
    #[serde(default)]
    pub role: Option<String>,
    #[serde(default)]
    pub parts: Option<serde_json::Value>,
}

impl OpencodeClient {
    pub fn new(base: impl Into<String>) -> OpencodeClient {
        let http = AgentBuilder::new()
            .timeout(Duration::from_secs(30))
            .build();
        OpencodeClient {
            base: base.into().trim_end_matches('/').to_string(),
            http,
        }
    }

    fn get_json(&self, path: &str) -> Result<serde_json::Value, String> {
        let url = format!("{}{path}", self.base);
        let r = self
            .http
            .get(&url)
            .call()
            .map_err(|e| format!("opencode GET {path}: {e}"))?;
        r.into_json::<serde_json::Value>()
            .map_err(|e| format!("opencode GET {path} body: {e}"))
    }

    pub fn list_sessions(&self) -> Result<Vec<SessionInfo>, String> {
        let v = self.get_json("/session")?;
        serde_json::from_value(v).map_err(|e| format!("session list: {e}"))
    }

    pub fn create_session(&self, name: &str) -> Result<SessionInfo, String> {
        let body = serde_json::json!({ "title": name });
        let r = self
            .http
            .post(&format!("{}/session", self.base))
            .send_json(body)
            .map_err(|e| format!("opencode create session: {e}"))?;
        let v: serde_json::Value = r
            .into_json()
            .map_err(|e| format!("opencode create session body: {e}"))?;
        serde_json::from_value(v).map_err(|e| format!("created session: {e}"))
    }

    pub fn transcript(&self, sid: &str) -> Result<Vec<MessageInfo>, String> {
        let v = self.get_json(&format!("/session/{sid}/message"))?;
        serde_json::from_value(v).map_err(|e| format!("transcript: {e}"))
    }

    /// Fire a prompt. Returns when opencode ACCEPTED it (the run is async).
    pub fn prompt(&self, sid: &str, text: &str) -> Result<(), String> {
        let body = serde_json::json!({ "parts": [{ "type": "text", "text": text }] });
        let r = self
            .http
            .post(&format!("{}/session/{sid}/message", self.base))
            .send_json(body)
            .map_err(|e| format!("opencode prompt: {e}"))?;
        if r.status() >= 400 {
            return Err(format!("opencode prompt status {}", r.status()));
        }
        Ok(())
    }

    pub fn resolve(&self, id_or_slug: &str) -> Result<String, String> {
        if id_or_slug.starts_with("ses_") {
            return Ok(id_or_slug.to_string());
        }
        let sessions = self.list_sessions()?;
        let want = slugify(id_or_slug);
        sessions
            .into_iter()
            .find(|s| slugify(s.title.as_deref().unwrap_or("")) == want)
            .map(|s| s.id)
            .ok_or_else(|| format!("no session for slug {id_or_slug}"))
    }
}

pub fn slugify(title: &str) -> String {
    title
        .to_lowercase()
        .trim()
        .replace(' ', "-")
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect::<String>()
        .chars()
        .take(60)
        .collect()
}
