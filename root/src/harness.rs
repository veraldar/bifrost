//! Harness sessions (root-coord, 11-12): a session whose engine is another agent harness —
//! Claude Code, opencode, OpenAI's Codex CLI or Google's Antigravity CLI (`agy`) — instead of the brain's own loop. Each turn runs
//! the harness non-interactively in the session's directory, RESUMING the harness's own session
//! (its id is kept on `info.harness.id`), so the conversation continues there with its full
//! context and tools. Text streams into the session like any reply; the harness's tool calls are
//! stored as completed tool parts; the turn then reports up the tree like any other.
//!
//! One adapter per harness = argv + a line parser over its JSON event stream. Nothing else.
//!
//! An ATTACHED session (11-13) continues a Claude Code conversation the owner started in a
//! terminal: its first turn forks it (`--resume <id> --fork-session`, the terminal's transcript is
//! never written), later turns resume the fork, and Claude Code's permission guard stays on
//! (`--permission-mode auto`, never `--dangerously-skip-permissions`).

use std::{path::Path, process::Stdio};

use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Kind {
    Claude,
    Opencode,
    Codex,
    /// Google's Antigravity CLI (`agy`, 11-14) — it replaced Gemini CLI, which no longer serves
    /// personal accounts; an agent saved on "gemini" loads as this one
    Antigravity,
}

/// How a turn continues a session that came from the owner's terminal (Claude Code only).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Attach {
    /// the conversation came from a terminal: its permission guard stays on
    pub guarded: bool,
    /// the first turn on it: branch off into a new session, never write into its transcript
    pub fork: bool,
}

impl Kind {
    pub fn parse(s: &str) -> Option<Kind> {
        match s {
            "claude" | "claude-code" => Some(Kind::Claude),
            "opencode" => Some(Kind::Opencode),
            "codex" => Some(Kind::Codex),
            "antigravity" | "agy" => Some(Kind::Antigravity),
            _ => None,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Kind::Claude => "claude",
            Kind::Opencode => "opencode",
            Kind::Codex => "codex",
            Kind::Antigravity => "antigravity",
        }
    }

    /// argv (program first) + whether the prompt goes on stdin.
    fn argv(self, model: Option<&str>, resume: Option<&str>, cwd: &Path, prompt: &str, system: Option<&str>, attach: Attach) -> (Vec<String>, bool) {
        let mut a: Vec<String> = Vec::new();
        let mut push = |xs: &[&str]| a.extend(xs.iter().map(|x| x.to_string()));
        match self {
            Kind::Claude => {
                push(&["claude", "-p", "--output-format", "stream-json", "--verbose"]);
                // a conversation continued from the terminal keeps the owner's safety guard on
                if attach.guarded {
                    push(&["--permission-mode", "auto"]);
                } else {
                    push(&["--dangerously-skip-permissions"]);
                }
                if let Some(m) = model {
                    push(&["--model", m]);
                }
                if let Some(r) = resume {
                    push(&["--resume", r]);
                    // first turn on a terminal's conversation: a fork, its transcript stays untouched
                    if attach.fork {
                        push(&["--fork-session"]);
                    }
                }
                // the agent's own instructions ride on top of Claude Code's (the editor's prompt)
                if let Some(sys) = system.filter(|s| !s.trim().is_empty()) {
                    push(&["--append-system-prompt", sys]);
                }
                (a, true)
            }
            Kind::Opencode => {
                push(&["opencode", "run", "--format", "json", "--dir", &cwd.to_string_lossy()]);
                if let Some(m) = model {
                    push(&["--model", m]);
                }
                if let Some(r) = resume {
                    push(&["--session", r]);
                }
                push(&["--", prompt]);
                (a, false)
            }
            Kind::Codex => {
                push(&["codex", "exec", "--json", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox", "-C", &cwd.to_string_lossy()]);
                if let Some(m) = model {
                    push(&["-m", m]);
                }
                if let Some(r) = resume {
                    push(&["resume", r]);
                }
                push(&[prompt]);
                (a, false)
            }
            Kind::Antigravity => (antigravity::argv(model, resume, antigravity::api_key()), true),
        }
    }

    /// What goes on the harness's stdin (only for those that read the prompt there).
    fn stdin(self, prompt: &str, system: Option<&str>, resume: Option<&str>) -> String {
        match self {
            // one NDJSON user message (`--input-format stream-json`): a prompt of any length or
            // shape stays one line. agy has no system-prompt flag, so the agent's instructions
            // ride on the conversation's first message (a resumed conversation already has them)
            Kind::Antigravity => {
                let text = match system.filter(|s| !s.trim().is_empty()) {
                    Some(sys) if resume.is_none() => format!("<instructions>\n{sys}\n</instructions>\n\n{prompt}"),
                    _ => prompt.to_string(),
                };
                format!("{}\n", json!({ "event": "user", "message": { "content": text } }))
            }
            _ => prompt.to_string(),
        }
    }
}

/// Google's Antigravity CLI (`agy`, verified against 1.5.9 — fixtures/antigravity/).
pub mod antigravity {
    use std::collections::HashMap;

    /// The brain runs agy on the Gemini API when GEMINI_API_KEY is in its environment: agy reads
    /// the key only with `modelProvider: "gemini"` (its changelog; seen against a fake API 11-14),
    /// so that setting rides on each turn (`--settings`, never saved). Else: the Google sign-in.
    pub fn api_key() -> bool {
        std::env::var_os("GEMINI_API_KEY").is_some_and(|k| !k.is_empty())
    }

    /// A turn, headless: the prompt as stream-json on stdin, stream-json out, every tool approved
    /// (like the other harnesses), the session's folder as the process cwd (agy's workspace).
    pub fn argv(model: Option<&str>, resume: Option<&str>, api_key: bool) -> Vec<String> {
        let mut a: Vec<String> = ["agy", "--input-format", "stream-json", "--output-format", "stream-json", "--dangerously-skip-permissions"]
            .map(String::from)
            .to_vec();
        if let Some(m) = model {
            a.extend(["--model".into(), m.into()]);
        }
        if let Some(r) = resume {
            a.extend(["--conversation".into(), r.into()]);
        }
        if api_key {
            a.extend(["--settings".into(), r#"{"modelProvider":"gemini"}"#.into()]);
        }
        a
    }

    /// Google's current text models (aistudio.google.com/docs/models, read 11-14), strongest →
    /// fastest, with Google's own one-liners: the picker's floor, shown even when `agy models` is
    /// short or unreadable. Only base slugs agy 1.5.9 accepts as `--model` (it picks the effort):
    /// gemini-3.5-flash-lite and the gemini-flash-latest alias are refused by agy, so not here.
    pub const FLOOR: &[(&str, &str)] = &[
        ("gemini-4-carbon", "Gemini 4 Carbon — strongest reasoning, complex software engineering"),
        ("gemini-4-argon", "Gemini 4 Argon — efficient frontier reasoning, faster than Carbon"),
        ("gemini-4-hydrogen", "Gemini 4 Hydrogen — speed for everyday coding and agentic work"),
        ("gemini-3.8-flash", "Gemini 3.8 Flash — software engineering, autonomous agents"),
        ("gemini-3.6-flash", "Gemini 3.6 Flash — speed for general agentic and everyday tasks"),
    ];

    /// A model this sign-in does not serve (agy refused it): Gemini 4 comes with a key.
    pub const NEEDS_KEY: &str = "needs GEMINI_API_KEY";

    /// `agy-model-high` → (`agy-model`, effort rank): the base slug sorts first, then max → low.
    fn family(slug: &str) -> (&str, usize) {
        for (i, e) in ["-max", "-xhigh", "-high", "-medium", "-low"].iter().enumerate() {
            if let Some(f) = slug.strip_suffix(e) {
                return (f, i + 1);
            }
        }
        (slug, 0)
    }

    /// The picker's list: "default" (agy's own pick) first, then Google's models strongest →
    /// fastest — the floor merged with what `agy models` printed (`slug<TAB>label` lines) — then
    /// the other models agy offers on this sign-in (Claude, GPT-OSS…) in its order. With agy's list
    /// read, a floor model it does not offer is labelled as needing a key (agy refuses it on a Google
    /// sign-in); on the API key, `agy models` does not describe what runs, so the floor is the list.
    pub fn models(agy: Option<&str>, api_key: bool) -> (Vec<String>, HashMap<String, String>) {
        let listed: Vec<(String, String)> = if api_key {
            Vec::new()
        } else {
            agy.unwrap_or_default()
                .lines()
                .filter_map(|l| {
                    let (slug, label) = l.split_once('\t')?;
                    let slug = slug.trim();
                    (!slug.is_empty() && !slug.contains(' ')).then(|| (slug.to_string(), label.trim().to_string()))
                })
                .collect()
        };
        let read = !listed.is_empty();
        let rank = |slug: &str| {
            let (f, e) = family(slug);
            FLOOR.iter().position(|(id, _)| *id == f).map_or((FLOOR.len(), 0), |i| (i, e))
        };
        let mut all: Vec<(String, String)> = FLOOR
            .iter()
            .map(|(id, label)| {
                let offered = !read || listed.iter().any(|(s, _)| family(s).0 == *id);
                (id.to_string(), if offered { label.to_string() } else { format!("{label} · {NEEDS_KEY}") })
            })
            .collect();
        all.extend(listed.into_iter().filter(|(s, _)| !FLOOR.iter().any(|(id, _)| id == s)));
        // stable: agy's own order is kept inside a rank (and among the models the floor does not know)
        all.sort_by_key(|(s, _)| rank(s));
        let mut labels: HashMap<String, String> = all.iter().cloned().collect();
        labels.insert("default".into(), "Antigravity's own pick (its /model setting)".into());
        let list = std::iter::once("default".to_string()).chain(all.into_iter().map(|(s, _)| s)).collect();
        (list, labels)
    }

    /// An agent or session saved on Gemini CLI keeps its model only when agy runs it too.
    pub fn carry_model(m: &str) -> bool {
        FLOOR.iter().any(|(id, _)| *id == m)
    }
}

/// A session saved while Gemini CLI was a harness (≤ 11-13) moves to Antigravity at load: its
/// Gemini CLI session id is dropped (agy cannot resume it — a new conversation starts), and its
/// model is kept only when agy runs it. `true` = changed.
pub fn migrate_session(info: &mut Value) -> bool {
    let mut changed = false;
    if info["harness"]["kind"] == "gemini" {
        info["harness"] = json!({ "kind": Kind::Antigravity.name() });
        changed = true;
    }
    if info["model"]["providerID"] == "gemini" {
        let id = info["model"]["id"].as_str().filter(|m| antigravity::carry_model(m)).unwrap_or("default").to_string();
        info["model"] = json!({ "id": id, "providerID": Kind::Antigravity.name() });
        changed = true;
    }
    changed
}

/// What one event line meant.
#[derive(Clone, Debug, PartialEq)]
pub enum Ev {
    Session(String),
    /// a whole block of text (Claude Code, opencode, Codex)
    Text(String),
    /// a streamed chunk of text, joined as is (Antigravity's `text_delta` chunks)
    Delta(String),
    Tool { name: String, input: Value, output: String },
    Final(String),
    Error(String),
}

/// One JSON line of a harness's event stream → zero or more events.
pub fn parse(kind: Kind, v: &Value) -> Vec<Ev> {
    let s = |x: &Value| x.as_str().unwrap_or_default().to_string();
    let mut out = Vec::new();
    match kind {
        Kind::Claude => {
            if let Some(id) = v["session_id"].as_str() {
                out.push(Ev::Session(id.into()));
            }
            match v["type"].as_str() {
                Some("assistant") => {
                    for b in v["message"]["content"].as_array().into_iter().flatten() {
                        match b["type"].as_str() {
                            Some("text") if !s(&b["text"]).is_empty() => out.push(Ev::Text(s(&b["text"]))),
                            Some("tool_use") => out.push(Ev::Tool { name: s(&b["name"]), input: b["input"].clone(), output: String::new() }),
                            _ => {}
                        }
                    }
                }
                Some("result") => {
                    if v["is_error"] == true {
                        out.push(Ev::Error(s(&v["result"])));
                    } else {
                        out.push(Ev::Final(s(&v["result"])));
                    }
                }
                _ => {}
            }
        }
        Kind::Opencode => {
            if let Some(id) = v["sessionID"].as_str() {
                out.push(Ev::Session(id.into()));
            }
            let p = &v["part"];
            match v["type"].as_str() {
                Some("text") if !s(&p["text"]).is_empty() => out.push(Ev::Text(s(&p["text"]))),
                Some("tool_use") | Some("tool") => out.push(Ev::Tool {
                    name: s(&p["tool"]),
                    input: p["state"]["input"].clone(),
                    output: s(&p["state"]["output"]).chars().take(4000).collect(),
                }),
                Some("error") => out.push(Ev::Error(v["error"]["data"]["message"].as_str().or(v["error"]["message"].as_str()).unwrap_or("opencode error").into())),
                _ => {}
            }
        }
        Kind::Codex => match v["type"].as_str() {
            Some("thread.started") => out.push(Ev::Session(s(&v["thread_id"]))),
            Some("item.completed") => {
                let it = &v["item"];
                match it["type"].as_str() {
                    Some("agent_message") => out.push(Ev::Text(s(&it["text"]))),
                    Some("command_execution") => out.push(Ev::Tool {
                        name: "bash".into(),
                        input: json!({ "command": it["command"] }),
                        output: s(&it["aggregated_output"]).chars().take(4000).collect(),
                    }),
                    Some(t) if t.ends_with("_change") || t == "file_change" => out.push(Ev::Tool { name: "edit".into(), input: it["changes"].clone(), output: String::new() }),
                    _ => {}
                }
            }
            Some("turn.failed") | Some("error") => out.push(Ev::Error(v["error"]["message"].as_str().or(v["message"].as_str()).unwrap_or("codex error").into())),
            _ => {}
        },
        // agy's stream-json (1.5.9, fixtures/antigravity/): {event, <event>: {...}} lines —
        // init (conversation_id) · step_update (user_input | agent_response text_delta chunks | tool
        // ACTIVE then DONE/ERROR with tool_info | system_message | error_message…) · result (status,
        // response = every text step joined, error)
        Kind::Antigravity => match v["event"].as_str() {
            Some("init") => out.push(Ev::Session(s(&v["conversation_id"]))),
            Some("step_update") => {
                let st = &v["step_update"];
                match st["step_type"].as_str() {
                    Some("agent_response") if !s(&st["text_delta"]).is_empty() => out.push(Ev::Delta(s(&st["text_delta"]))),
                    // a tool lands once, finished: its parameters, then its output or its error
                    Some("tool") if st["state"] != "ACTIVE" => {
                        let ti = &st["tool_info"];
                        let error = ti["error"]["message"].as_str().or(ti["error"].as_str()).filter(|e| !e.is_empty());
                        let output = error.map_or_else(|| s(&ti["output"]), |e| format!("error: {e}"));
                        out.push(Ev::Tool {
                            name: ti["name"].as_str().or(st["tool_name"].as_str()).unwrap_or("tool").into(),
                            input: ti["parameters"].clone(),
                            output: output.chars().take(4000).collect(),
                        });
                    }
                    _ => {}
                }
            }
            Some("result") => {
                let r = &v["result"];
                if let Some(id) = r["conversation_id"].as_str().filter(|id| !id.is_empty()) {
                    out.push(Ev::Session(id.into()));
                }
                match r["status"].as_str() {
                    Some("SUCCESS") => out.push(Ev::Final(s(&r["response"]))),
                    status => out.push(Ev::Error(
                        r["error"].as_str().filter(|e| !e.trim().is_empty()).map(String::from).unwrap_or_else(|| format!("the turn ended {}", status.unwrap_or("without a status"))),
                    )),
                }
            }
            _ => {}
        },
    }
    out
}

/// What the owner reads when Antigravity is not signed in (the session's error).
pub const ANTIGRAVITY_SIGNED_OUT: &str = "Antigravity is not signed in — run `agy` once in a terminal and sign in with Google, or set GEMINI_API_KEY in the brain's environment.";

/// A harness failure, said plainly (Antigravity's, as agy 1.5.9 words them): no credentials, a key
/// Google refuses, a model this sign-in does not serve.
fn explain(kind: Kind, msg: &str) -> Option<String> {
    if kind != Kind::Antigravity {
        return None;
    }
    if ["API_KEY_INVALID", "API key not valid"].iter().any(|n| msg.contains(n)) {
        return Some("Antigravity: Google refused the GEMINI_API_KEY in the brain's environment — set a valid key, or remove it and sign in by running `agy` once in a terminal.".into());
    }
    if ["authentication required", "authentication failed", "Please sign in", "not logged into Antigravity"].iter().any(|n| msg.contains(n)) {
        return Some(ANTIGRAVITY_SIGNED_OUT.into());
    }
    // `invalid model selection (…): model X is not recognized as a known model … Available models:\n  A\n  B`
    let (head, tail) = msg.split_once(" is not recognized as a known model")?;
    let model = head.rsplit("model ").next()?.trim();
    let offered: Vec<&str> = tail.split_once("Available models:").map(|(_, l)| l.lines().map(str::trim).filter(|l| !l.is_empty()).collect()).unwrap_or_default();
    let list = if offered.is_empty() { String::new() } else { format!(": {}", offered.join(", ")) };
    // a model of Google's list that the Google sign-in does not serve: a key unlocks it
    let key = if antigravity::carry_model(model) && !antigravity::api_key() { " (Google's newer models run with GEMINI_API_KEY in the brain's environment)" } else { "" };
    Some(format!("Antigravity does not offer {model} on this sign-in{key} — pick one it does{list}"))
}

/// Claude Code's own sessions on this box (11-13: "continue a Claude Code session from the phone").
/// Its transcripts live in `~/.claude/projects/<cwd, every non-alphanumeric char → '-'>/<id>.jsonl`.
/// Only metadata is read: the `cwd` field, the title lines (custom-title, ai-title, summary) and,
/// when there is no title, the first line the owner typed — never tool output, never more.
pub mod claude {
    use serde_json::{Value, json};
    use std::{
        io::{BufRead, BufReader, Read, Seek, SeekFrom},
        path::{Path, PathBuf},
        time::UNIX_EPOCH,
    };

    /// `$CLAUDE_CONFIG_DIR/projects`, else `~/.claude/projects`.
    pub fn projects_dir() -> PathBuf {
        let base = std::env::var_os("CLAUDE_CONFIG_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".claude"));
        base.join("projects")
    }

    /// The folder Claude Code files a cwd's sessions under.
    pub fn mangle(cwd: &str) -> String {
        cwd.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect()
    }

    /// 8-4-4-4-12 hex: a Claude Code session id.
    pub fn is_uuid(s: &str) -> bool {
        let parts: Vec<&str> = s.split('-').collect();
        parts.len() == 5
            && parts.iter().zip([8, 4, 4, 4, 12]).all(|(p, n)| p.len() == n && p.chars().all(|c| c.is_ascii_hexdigit()))
    }

    /// Where the transcript of session `id` started in `cwd` lives.
    pub fn transcript(cwd: &str, id: &str) -> PathBuf {
        projects_dir().join(mangle(cwd)).join(format!("{id}.jsonl"))
    }

    /// One line of what the owner typed: no tool results, no command echoes, no injected context.
    fn typed(v: &Value) -> Option<String> {
        if v["type"] != "user" || v["isMeta"] == true || v["isSidechain"] == true || v["isCompactSummary"] == true {
            return None;
        }
        let c = &v["message"]["content"];
        let text = match c {
            Value::String(t) => t.clone(),
            Value::Array(blocks) => {
                if blocks.iter().any(|b| b["type"] == "tool_result") {
                    return None;
                }
                blocks.iter().filter(|b| b["type"] == "text").filter_map(|b| b["text"].as_str()).collect::<Vec<_>>().join(" ")
            }
            _ => return None,
        };
        let t = text.split_whitespace().collect::<Vec<_>>().join(" ");
        (!t.is_empty() && !t.starts_with('<') && !t.starts_with("Caveat:")).then_some(t)
    }

    fn clip(t: &str, n: usize) -> String {
        if t.chars().count() <= n { t.to_string() } else { format!("{}…", t.chars().take(n - 1).collect::<String>()) }
    }

    #[derive(Default)]
    struct Seen {
        cwd: Option<String>,
        custom: Option<String>,
        ai: Option<String>,
        summary: Option<String>,
        first: Option<String>,
    }

    impl Seen {
        /// A line worth parsing: cheap substring checks first (lines can be megabytes of tool output).
        fn line(&mut self, l: &str) {
            let titled = l.contains("\"custom-title\"") || l.contains("\"ai-title\"") || l.contains("\"summary\"");
            let wanted = titled || (self.cwd.is_none() && l.contains("\"cwd\"")) || (self.first.is_none() && l.contains("\"user\""));
            if !wanted {
                return;
            }
            let Ok(v) = serde_json::from_str::<Value>(l) else { return };
            let s = |k: &str| v[k].as_str().map(str::trim).filter(|t| !t.is_empty()).map(String::from);
            match v["type"].as_str() {
                Some("custom-title") => self.custom = s("customTitle").or(self.custom.take()),
                Some("ai-title") => self.ai = s("aiTitle").or(self.ai.take()),
                Some("summary") => self.summary = s("summary").or(self.summary.take()),
                _ => {}
            }
            if self.cwd.is_none() {
                self.cwd = s("cwd");
            }
            if self.first.is_none() {
                self.first = typed(&v);
            }
        }
    }

    const HEAD: u64 = 512 * 1024;
    const TAIL: u64 = 256 * 1024;

    /// `{id, cwd, modified, title}` of one transcript, read from its head and its tail only.
    pub fn meta(path: &Path) -> Option<Value> {
        let id = path.file_stem()?.to_str()?.to_string();
        if !is_uuid(&id) {
            return None;
        }
        let md = std::fs::metadata(path).ok()?;
        let modified = md.modified().ok()?.duration_since(UNIX_EPOCH).ok()?.as_millis() as u64;
        let mut f = std::fs::File::open(path).ok()?;
        let mut seen = Seen::default();
        for l in BufReader::new((&mut f).take(HEAD)).lines().map_while(Result::ok) {
            seen.line(&l);
        }
        // the newest title sits near the end (Claude Code re-titles as the conversation goes)
        if md.len() > HEAD {
            let from = md.len().saturating_sub(TAIL).max(HEAD);
            if f.seek(SeekFrom::Start(from)).is_ok() {
                for l in BufReader::new(f).lines().skip(1).map_while(Result::ok) {
                    seen.line(&l);
                }
            }
        }
        let cwd = seen.cwd?;
        let title = seen.custom.or(seen.ai).or(seen.summary).or(seen.first).unwrap_or_else(|| "(untitled)".into());
        Some(json!({ "id": id, "cwd": cwd, "modified": modified, "title": clip(&title, 80) }))
    }

    /// The newest `n` sessions (by transcript change time) that name their folder.
    pub fn recent(n: usize) -> Vec<Value> {
        let mut files: Vec<(std::time::SystemTime, PathBuf)> = Vec::new();
        for dir in std::fs::read_dir(projects_dir()).into_iter().flatten().flatten() {
            for e in std::fs::read_dir(dir.path()).into_iter().flatten().flatten() {
                let p = e.path();
                if p.extension().is_some_and(|x| x == "jsonl") {
                    if let Ok(t) = e.metadata().and_then(|m| m.modified()) {
                        files.push((t, p));
                    }
                }
            }
        }
        files.sort_by(|a, b| b.0.cmp(&a.0));
        files.iter().filter_map(|(_, p)| meta(p)).take(n).collect()
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn mangles_like_claude_code() {
            assert_eq!(mangle("/home/user_x/.cache/root-sim/preview/work"), "-home-user-x--cache-root-sim-preview-work");
            assert_eq!(mangle("/tmp/tmp.AbC12"), "-tmp-tmp-AbC12");
            assert!(is_uuid("3b6f7db4-a74a-4425-a4dd-9f8c5b7b7e95"));
            assert!(!is_uuid("3b6f7db4-a74a-4425-a4dd-9f8c5b7b7e9") && !is_uuid("../../etc/passwd") && !is_uuid("ses_123"));
        }

        #[test]
        fn title_is_metadata_only() {
            let dir = std::env::temp_dir().join(format!("ygg-cc-meta-{}", std::process::id()));
            std::fs::create_dir_all(&dir).unwrap();
            let id = "0f1e2d3c-4b5a-4968-8776-655443322110";
            let p = dir.join(format!("{id}.jsonl"));
            let lines = [
                json!({"type":"queue-operation","operation":"enqueue"}),
                json!({"type":"user","cwd":"/w/proj","message":{"role":"user","content":"<command-name>/clear</command-name>"}}),
                json!({"type":"user","cwd":"/w/proj","isMeta":true,"message":{"role":"user","content":"Caveat: injected"}}),
                json!({"type":"user","cwd":"/w/proj","message":{"role":"user","content":[{"type":"tool_result","content":"SECRET TOOL OUTPUT"}]}}),
                json!({"type":"user","cwd":"/w/proj","message":{"role":"user","content":"  remember the word walrus;\n reply ok  "}}),
                json!({"type":"assistant","cwd":"/w/proj","message":{"content":[{"type":"text","text":"ok"}]}}),
            ];
            std::fs::write(&p, lines.iter().map(|l| l.to_string() + "\n").collect::<String>()).unwrap();
            let m = meta(&p).unwrap();
            assert_eq!(m["id"], id);
            assert_eq!(m["cwd"], "/w/proj");
            assert_eq!(m["title"], "remember the word walrus; reply ok");
            // a title line wins over the first typed line; the newest ai-title wins over older ones
            let more = [json!({"type":"ai-title","aiTitle":"Old title"}), json!({"type":"ai-title","aiTitle":"Walrus memory test"})];
            std::fs::write(&p, lines.iter().chain(more.iter()).map(|l| l.to_string() + "\n").collect::<String>()).unwrap();
            assert_eq!(meta(&p).unwrap()["title"], "Walrus memory test");
            let long = json!({"type":"custom-title","customTitle":"x".repeat(200)});
            std::fs::write(&p, lines.iter().chain([long].iter()).map(|l| l.to_string() + "\n").collect::<String>()).unwrap();
            assert_eq!(meta(&p).unwrap()["title"].as_str().unwrap().chars().count(), 80);
            // no cwd anywhere: not attachable, not listed
            std::fs::write(&p, json!({"type":"queue-operation"}).to_string() + "\n").unwrap();
            assert!(meta(&p).is_none());
            let _ = std::fs::remove_dir_all(&dir);
        }
    }
}

pub struct Outcome {
    pub text: String,
    pub session: Option<String>,
}

/// Runs one turn. `on` sees every event as it arrives (stream text, store tools). The child is
/// killed when the returned future is dropped (an abort drops it).
#[allow(clippy::too_many_arguments)]
pub async fn run(kind: Kind, model: Option<&str>, resume: Option<&str>, cwd: &Path, prompt: &str, system: Option<&str>, attach: Attach, mut on: impl FnMut(&Ev)) -> Result<Outcome, String> {
    let (argv, stdin_prompt) = kind.argv(model, resume, cwd, prompt, system, attach);
    let mut cmd = tokio::process::Command::new(&argv[0]);
    cmd.args(&argv[1..])
        .current_dir(cwd)
        .stdin(if stdin_prompt { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = cmd.spawn().map_err(|e| format!("{} not runnable: {e}", kind.name()))?;
    if stdin_prompt {
        let mut sin = child.stdin.take().ok_or("no stdin")?;
        sin.write_all(kind.stdin(prompt, system, resume).as_bytes()).await.map_err(|e| e.to_string())?;
        drop(sin);
    }
    let stderr = child.stderr.take();
    let err_task = tokio::spawn(async move {
        let mut buf = String::new();
        if let Some(e) = stderr {
            let mut lines = BufReader::new(e).lines();
            while let Ok(Some(l)) = lines.next_line().await {
                if buf.len() < 4000 {
                    buf.push_str(&l);
                    buf.push('\n');
                }
            }
        }
        buf
    });
    let mut lines = BufReader::new(child.stdout.take().ok_or("no stdout")?).lines();
    let (mut text, mut fin, mut session, mut error) = (String::new(), None::<String>, resume.map(String::from), None::<String>);
    let mut after_tool = false;
    while let Ok(Some(line)) = lines.next_line().await {
        let Ok(v) = serde_json::from_str::<Value>(line.trim()) else { continue };
        for mut ev in parse(kind, &v) {
            match &mut ev {
                Ev::Session(id) if !id.is_empty() => session = Some(id.clone()),
                Ev::Text(t) => {
                    if !text.is_empty() {
                        text.push_str("\n\n");
                    }
                    text.push_str(t);
                }
                // chunks join as they come; text after a tool call starts a new paragraph
                Ev::Delta(t) => {
                    if after_tool && !text.is_empty() {
                        let have = text.chars().rev().take_while(|c| *c == '\n').count();
                        t.insert_str(0, &"\n".repeat(2usize.saturating_sub(have)));
                    }
                    text.push_str(t);
                }
                Ev::Final(t) => fin = Some(t.clone()),
                // the first error is the specific one (a generic "failed" result may follow it)
                Ev::Error(e) => {
                    error.get_or_insert_with(|| e.clone());
                }
                _ => {}
            }
            after_tool = match &ev {
                Ev::Tool { .. } => true,
                Ev::Delta(_) | Ev::Text(_) => false,
                _ => after_tool,
            };
            on(&ev);
        }
    }
    let status = child.wait().await.map_err(|e| e.to_string())?;
    let stderr = err_task.await.unwrap_or_default();
    // the harness's final answer is the reply — unless it is the streamed text itself, whose
    // paragraph breaks the phone already shows (agy joins its text steps with a bare newline)
    let words = |t: &str| t.split_whitespace().collect::<Vec<_>>().join(" ");
    let text = match fin.filter(|f| !f.trim().is_empty()) {
        Some(f) if words(&f) != words(&text) => f,
        _ => text,
    };
    let text = text.trim_end().to_string();
    if let Some(e) = error {
        return Err(explain(kind, &e).unwrap_or_else(|| format!("{}: {e}", kind.name())));
    }
    if !status.success() && text.trim().is_empty() {
        let tail: String = stderr.lines().rev().take(6).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n");
        return Err(explain(kind, &stderr).unwrap_or_else(|| format!("{} exited {status}: {tail}", kind.name())));
    }
    Ok(Outcome { text, session })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_stream() {
        let init = json!({"type":"system","subtype":"init","session_id":"abc"});
        assert_eq!(parse(Kind::Claude, &init), vec![Ev::Session("abc".into())]);
        let a = json!({"type":"assistant","session_id":"abc","message":{"content":[{"type":"thinking","thinking":""},{"type":"text","text":"hi"},{"type":"tool_use","name":"Bash","input":{"command":"ls"}}]}});
        let evs = parse(Kind::Claude, &a);
        assert!(evs.contains(&Ev::Text("hi".into())));
        assert!(matches!(&evs[2], Ev::Tool { name, .. } if name == "Bash"));
        let r = json!({"type":"result","subtype":"success","is_error":false,"result":"done","session_id":"abc"});
        assert!(parse(Kind::Claude, &r).contains(&Ev::Final("done".into())));
    }

    #[test]
    fn opencode_stream() {
        let t = json!({"type":"text","sessionID":"ses_x","part":{"type":"text","text":"hi"}});
        assert_eq!(parse(Kind::Opencode, &t), vec![Ev::Session("ses_x".into()), Ev::Text("hi".into())]);
    }

    #[test]
    fn codex_stream() {
        assert_eq!(parse(Kind::Codex, &json!({"type":"thread.started","thread_id":"t1"})), vec![Ev::Session("t1".into())]);
        let m = json!({"type":"item.completed","item":{"type":"agent_message","text":"ok"}});
        assert_eq!(parse(Kind::Codex, &m), vec![Ev::Text("ok".into())]);
        let c = json!({"type":"item.completed","item":{"type":"command_execution","command":"ls","aggregated_output":"a\n"}});
        assert!(matches!(&parse(Kind::Codex, &c)[0], Ev::Tool { name, .. } if name == "bash"));
    }

    #[test]
    fn argv_shapes() {
        let none = Attach::default();
        let (a, stdin) = Kind::Claude.argv(Some("sonnet"), Some("s1"), Path::new("/w"), "p", Some("be terse"), none);
        assert!(stdin && a.contains(&"--resume".to_string()) && a.contains(&"sonnet".to_string()));
        assert!(a.windows(2).any(|w| w[0] == "--append-system-prompt" && w[1] == "be terse"));
        // a session the brain started itself: unchanged — no guard, no fork
        assert!(a.contains(&"--dangerously-skip-permissions".to_string()) && !a.contains(&"--fork-session".to_string()));
        assert!(!a.contains(&"--permission-mode".to_string()));
        let (a, stdin) = Kind::Opencode.argv(None, Some("ses_1"), Path::new("/w"), "do it", None, none);
        assert!(!stdin && a.ends_with(&["--".to_string(), "do it".to_string()]) && a.contains(&"--session".to_string()));
        let (a, _) = Kind::Codex.argv(None, Some("t1"), Path::new("/w"), "go", None, none);
        let i = a.iter().position(|x| x == "resume").unwrap();
        assert_eq!(&a[i + 1..], &["t1".to_string(), "go".to_string()]);
    }

    fn pair(a: &[String], k: &str, v: &str) -> bool {
        a.windows(2).any(|w| w[0] == k && w[1] == v)
    }

    #[test]
    fn attached_first_turn_forks_with_the_guard_on() {
        let t = "3f2a9c1e-0b4d-4e8f-9a6b-1c2d3e4f5a6b";
        let (a, stdin) = Kind::Claude.argv(Some("opus"), Some(t), Path::new("/w"), "p", None, Attach { guarded: true, fork: true });
        assert!(stdin);
        assert!(pair(&a, "--resume", t) && a.contains(&"--fork-session".to_string()), "{a:?}");
        assert!(pair(&a, "--permission-mode", "auto"), "{a:?}");
        assert!(!a.iter().any(|x| x.contains("dangerously")), "the guard stays on: {a:?}");
    }

    #[test]
    fn attached_later_turns_resume_the_fork_with_the_guard_on() {
        let fork = "9d8c7b6a-5f4e-4d3c-8b2a-0f1e2d3c4b5a";
        let (a, _) = Kind::Claude.argv(Some("opus"), Some(fork), Path::new("/w"), "p", None, Attach { guarded: true, fork: false });
        assert!(pair(&a, "--resume", fork) && !a.contains(&"--fork-session".to_string()), "{a:?}");
        assert!(pair(&a, "--permission-mode", "auto") && !a.iter().any(|x| x.contains("dangerously")), "{a:?}");
    }

    #[test]
    fn antigravity_argv() {
        assert_eq!(Kind::parse("antigravity"), Some(Kind::Antigravity));
        assert_eq!(Kind::parse("agy"), Some(Kind::Antigravity));
        assert_eq!(Kind::parse("gemini"), None, "Gemini CLI is gone (an agent saved on it loads as antigravity)");
        assert_eq!(Kind::Antigravity.name(), "antigravity");
        let first = antigravity::argv(Some("gemini-3.8-flash-low"), None, false);
        assert_eq!(first[0], "agy");
        assert!(pair(&first, "--input-format", "stream-json") && pair(&first, "--output-format", "stream-json"), "{first:?}");
        assert!(first.contains(&"--dangerously-skip-permissions".to_string()) && pair(&first, "--model", "gemini-3.8-flash-low"));
        assert!(!first.iter().any(|x| x == "--conversation" || x == "-p" || x == "--settings"), "{first:?}");
        let id = "c5d319b9-22e0-46b1-a22b-d34f40028fd2";
        let again = antigravity::argv(None, Some(id), false);
        assert!(pair(&again, "--conversation", id) && !again.contains(&"--model".to_string()), "{again:?}");
        let keyed = antigravity::argv(None, None, true);
        assert!(pair(&keyed, "--settings", r#"{"modelProvider":"gemini"}"#), "with a key agy runs on the Gemini API: {keyed:?}");
        // through Kind: the prompt never rides argv (stdin), whatever the process env says about a key
        let (a, stdin) = Kind::Antigravity.argv(Some("gemini-4-carbon"), Some(id), Path::new("/w"), "secret prompt", Some("sys"), Attach::default());
        assert!(stdin && pair(&a, "--conversation", id) && !a.iter().any(|x| x.contains("secret") || x == "sys"), "{a:?}");
    }

    #[test]
    fn antigravity_stdin_is_one_user_line() {
        let long = format!("line one\n\"quoted\"\n{}", "x".repeat(200_000));
        let first = Kind::Antigravity.stdin(&long, Some("be terse"), None);
        assert_eq!(first.matches('\n').count(), 1, "one NDJSON line, however long the prompt");
        let v: Value = serde_json::from_str(first.trim_end()).unwrap();
        assert_eq!(v["event"], "user");
        let text = v["message"]["content"].as_str().unwrap();
        assert!(text.starts_with("<instructions>\nbe terse\n</instructions>\n\n") && text.ends_with(&long), "the agent's instructions open the conversation");
        let later: Value = serde_json::from_str(Kind::Antigravity.stdin("hi", Some("be terse"), Some("c1")).trim_end()).unwrap();
        assert_eq!(later["message"]["content"], "hi", "a resumed conversation already has them");
        assert_eq!(Kind::Claude.stdin("hi", Some("x"), None), "hi");
    }

    fn agy(f: &str) -> Vec<Ev> {
        f.lines().filter_map(|l| serde_json::from_str::<Value>(l).ok()).flat_map(|v| parse(Kind::Antigravity, &v)).collect()
    }

    /// REAL (11-14, agy 1.5.9 signed in): a one-word turn.
    #[test]
    fn antigravity_real_turn() {
        let id = "c5d319b9-22e0-46b1-a22b-d34f40028fd2";
        assert_eq!(
            agy(include_str!("../fixtures/antigravity/pong.stream.jsonl")),
            vec![Ev::Session(id.into()), Ev::Delta("pong".into()), Ev::Delta("\n".into()), Ev::Session(id.into()), Ev::Final("pong\n".into())]
        );
        // resumed with --conversation: the same conversation goes on
        let evs = agy(include_str!("../fixtures/antigravity/resume.stream.jsonl"));
        assert_eq!(evs[0], Ev::Session(id.into()));
        assert_eq!(evs.last(), Some(&Ev::Final("pong\n".into())), "it remembered its last word: {evs:?}");
    }

    /// REAL: tool steps arrive ACTIVE then DONE — one tool part each, with its output.
    #[test]
    fn antigravity_real_tools() {
        let evs = agy(include_str!("../fixtures/antigravity/tools.stream.jsonl"));
        let tools: Vec<&Ev> = evs.iter().filter(|e| matches!(e, Ev::Tool { .. })).collect();
        assert_eq!(tools.len(), 2, "{evs:?}");
        assert!(matches!(tools[0], Ev::Tool { name, input, output } if name == "run_command" && input["CommandLine"] == "ls" && output.contains("a.txt  b.txt")), "{:?}", tools[0]);
        assert!(matches!(tools[1], Ev::Tool { name, input, .. } if name == "read_file" && input["Path"].as_str().unwrap().ends_with("tooldir/a.txt")));
        let text: String = evs.iter().filter_map(|e| if let Ev::Delta(t) = e { Some(t.as_str()) } else { None }).collect();
        assert!(text.starts_with("File count: 2") && text.contains("`hello`"), "{text:?}");
        assert!(matches!(evs.last(), Some(Ev::Final(f)) if f.starts_with("File count: 2")));
        // a failing tool: state ERROR, tool_info.error {type, message}
        let evs = agy(include_str!("../fixtures/antigravity/tool-error.stream.jsonl"));
        assert!(evs.iter().any(|e| matches!(e, Ev::Tool { name, output, .. } if name == "read_file" && output == "error: file does not exist")), "{evs:?}");
        assert!(!evs.iter().any(|e| matches!(e, Ev::Error(_))), "a failed tool is not a failed turn");
    }

    /// REAL failures, said plainly: signed out, a key Google refuses, a model this sign-in lacks.
    #[test]
    fn antigravity_real_failures() {
        let out = agy(include_str!("../fixtures/antigravity/signed-out.stream.jsonl"));
        assert_eq!(out, vec![Ev::Error("authentication failed or timed out".into())], "no conversation id: none kept");
        assert_eq!(explain(Kind::Antigravity, "authentication failed or timed out").as_deref(), Some(ANTIGRAVITY_SIGNED_OUT));
        assert_eq!(explain(Kind::Antigravity, include_str!("../fixtures/antigravity/signed-out.stderr.txt")).as_deref(), Some(ANTIGRAVITY_SIGNED_OUT));
        assert_eq!(explain(Kind::Antigravity, include_str!("../fixtures/antigravity/models.signed-out.stderr.txt")).as_deref(), Some(ANTIGRAVITY_SIGNED_OUT));
        assert!(ANTIGRAVITY_SIGNED_OUT.starts_with("Antigravity is not signed in — run `agy` once in a terminal and sign in with Google, or set GEMINI_API_KEY"));

        let bad = agy(include_str!("../fixtures/antigravity/bad-key.stream.jsonl"));
        let Some(Ev::Error(e)) = bad.iter().find(|e| matches!(e, Ev::Error(_))) else { panic!("{bad:?}") };
        assert!(explain(Kind::Antigravity, e).unwrap().contains("refused the GEMINI_API_KEY"));

        let unknown = agy(include_str!("../fixtures/antigravity/unknown-model.stream.jsonl"));
        let [Ev::Error(e)] = unknown.as_slice() else { panic!("{unknown:?}") };
        let said = explain(Kind::Antigravity, e).unwrap();
        assert!(said.starts_with("Antigravity does not offer no-such-model on this sign-in — pick one it does: Gemini 3.8 Flash (High), "), "{said}");
        assert!(said.contains("GPT-OSS 120B (Medium)") && !said.contains("GEMINI_API_KEY"), "{said}");
        if !antigravity::api_key() {
            let carbon = e.replace("no-such-model", "gemini-4-carbon");
            let said = explain(Kind::Antigravity, &carbon).unwrap();
            assert!(said.starts_with("Antigravity does not offer gemini-4-carbon on this sign-in (Google's newer models run with GEMINI_API_KEY in the brain's environment) — pick one it does: Gemini 3.8 Flash (High)"), "{said}");
        }
        assert_eq!(explain(Kind::Antigravity, "boom"), None);
        assert_eq!(explain(Kind::Claude, "authentication required"), None);
        // statuses other than SUCCESS fail the turn, with the status when there is no error text
        let canceled = json!({"event":"result","result":{"conversation_id":"","status":"CANCELED","response":""}});
        assert_eq!(parse(Kind::Antigravity, &canceled), vec![Ev::Error("the turn ended CANCELED".into())]);
    }

    /// The picker's list from REAL `agy models` output (Google sign-in, 11-14).
    #[test]
    fn antigravity_models() {
        let (list, labels) = antigravity::models(Some(include_str!("../fixtures/antigravity/models.signed-in.txt")), false);
        assert_eq!(
            list,
            [
                "default", "gemini-4-carbon", "gemini-4-argon", "gemini-4-hydrogen", "gemini-3.8-flash", "gemini-3.8-flash-high",
                "gemini-3.8-flash-medium", "gemini-3.8-flash-low", "gemini-3.6-flash", "claude-sonnet-4-6", "claude-opus-4-6-thinking", "gpt-oss-120b-medium",
            ]
        );
        assert_eq!(labels["gemini-3.8-flash-low"], "Gemini 3.8 Flash (Low)");
        assert_eq!(labels["gemini-3.8-flash"], "Gemini 3.8 Flash — software engineering, autonomous agents");
        assert!(labels["gemini-4-carbon"].starts_with("Gemini 4 Carbon — strongest") && labels["gemini-4-carbon"].ends_with(antigravity::NEEDS_KEY));
        assert!(labels["gemini-3.6-flash"].ends_with(antigravity::NEEDS_KEY) && !labels["gemini-3.8-flash"].contains(antigravity::NEEDS_KEY));
        assert!(labels["default"].starts_with("Antigravity's own pick"));
        // signed out / not installed: the floor, plain
        let (floor, labels) = antigravity::models(None, false);
        assert_eq!(floor, ["default", "gemini-4-carbon", "gemini-4-argon", "gemini-4-hydrogen", "gemini-3.8-flash", "gemini-3.6-flash"]);
        assert!(!labels.values().any(|l| l.contains(antigravity::NEEDS_KEY)));
        assert_eq!(antigravity::models(Some("Fetching available models...\n"), false).0, floor);
        // on the API key: the floor (all accepted by agy there — models.api-key.txt), nothing marked
        let (keyed, labels) = antigravity::models(Some(include_str!("../fixtures/antigravity/models.signed-in.txt")), true);
        assert_eq!(keyed, floor);
        assert!(!labels.values().any(|l| l.contains(antigravity::NEEDS_KEY)));
        let api: Vec<&str> = include_str!("../fixtures/antigravity/models.api-key.txt").lines().filter_map(|l| l.split('\t').next()).collect();
        for (id, _) in antigravity::FLOOR {
            assert!(api.iter().any(|s| s.starts_with(id)), "agy offers {id} on the API key");
        }
    }

    #[test]
    fn gemini_sessions_move_to_antigravity() {
        let mut s = json!({"id":"ses_1","harness":{"kind":"gemini","id":"5a0c1f9e-2b7d-4c55-9e0a-7f3b2d1c4e5f"},"model":{"id":"gemini-3.5-flash","providerID":"gemini"}});
        assert!(migrate_session(&mut s));
        assert_eq!(s["harness"], json!({"kind":"antigravity"}), "a Gemini CLI session id is not agy's: a new conversation starts");
        assert_eq!(s["model"], json!({"id":"default","providerID":"antigravity"}), "a model agy does not run falls back to its own pick");
        let mut s = json!({"harness":{"kind":"gemini"},"model":{"id":"gemini-3.8-flash","providerID":"gemini"}});
        assert!(migrate_session(&mut s));
        assert_eq!(s["model"]["id"], "gemini-3.8-flash");
        let mut c = json!({"harness":{"kind":"claude","id":"x"},"model":{"id":"opus","providerID":"claude"}});
        assert!(!migrate_session(&mut c));
        assert_eq!(c["harness"]["id"], "x");
    }

    /// run() end to end on a stand-in `agy` (a script replaying REAL output): the stdin line, the
    /// text joined with a paragraph after the tool, the conversation id kept; a signed-out run says so.
    #[tokio::test]
    async fn antigravity_run() {
        let dir = std::env::temp_dir().join(format!("ygg-agy-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let fx = Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/antigravity");
        let script = dir.join("agy");
        let put = |body: String| {
            std::fs::write(&script, body).unwrap();
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        };
        let stdin_file = dir.join("stdin.json");
        put(format!("#!/bin/sh\necho \"$@\" > '{}/argv'\ncat > '{}'\ncat '{}'\n", dir.display(), stdin_file.display(), fx.join("tool-error.stream.jsonl").display()));
        let path = format!("{}:{}", dir.display(), std::env::var("PATH").unwrap_or_default());
        // SAFETY: this test is the only one that runs an `agy`; PATH gains a directory in front
        unsafe { std::env::set_var("PATH", path) };
        let mut seen = Vec::new();
        let out = run(Kind::Antigravity, Some("gemini-3.8-flash-low"), None, &dir, "check missing.txt", Some("be terse"), Attach::default(), |e| seen.push(e.clone())).await.unwrap();
        assert_eq!(
            out.text,
            "I will check for the file in this directory.\n\nThe file [missing.txt](file:///home/user/.cache/tmp/agy-try/tooldir/missing.txt) could not be read because it does not exist."
        );
        assert_eq!(out.session.as_deref(), Some("e420cd9c-2b8b-4d5c-9b3a-80ab383516f3"));
        assert!(seen.contains(&Ev::Delta("\nThe file".into())), "the phone's stream gets the same paragraph break: {seen:?}");
        let sent: Value = serde_json::from_str(std::fs::read_to_string(&stdin_file).unwrap().trim_end()).unwrap();
        assert!(sent["event"] == "user" && sent["message"]["content"].as_str().unwrap().ends_with("</instructions>\n\ncheck missing.txt"));
        let argv = std::fs::read_to_string(dir.join("argv")).unwrap();
        assert!(argv.contains("--model gemini-3.8-flash-low") && !argv.contains("check missing"), "{argv}");

        put(format!("#!/bin/sh\ncat >/dev/null\ncat '{}'\ncat '{}' >&2\nexit 1\n", fx.join("signed-out.stream.jsonl").display(), fx.join("signed-out.stderr.txt").display()));
        let err = run(Kind::Antigravity, None, Some("c1"), &dir, "hi", None, Attach::default(), |_| {}).await.err();
        assert_eq!(err.as_deref(), Some(ANTIGRAVITY_SIGNED_OUT));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
