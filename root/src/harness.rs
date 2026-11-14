//! Harness sessions (root-coord, 11-12): a session whose engine is another agent harness —
//! Claude Code, opencode, OpenAI's Codex CLI or Google's Gemini CLI — instead of the brain's own loop. Each turn runs
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
    Gemini,
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
            "gemini" => Some(Kind::Gemini),
            _ => None,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Kind::Claude => "claude",
            Kind::Opencode => "opencode",
            Kind::Codex => "codex",
            Kind::Gemini => "gemini",
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
            // Gemini CLI: headless when stdin is not a terminal (the prompt goes on stdin, verified
            // with 0.68.0), every tool approved like the others (yolo), the session dir trusted
            Kind::Gemini => {
                push(&["gemini", "--output-format", "stream-json", "--approval-mode", "yolo", "--skip-trust"]);
                if let Some(m) = model {
                    push(&["--model", m]);
                }
                if let Some(r) = resume {
                    push(&["--resume", r]);
                }
                (a, true)
            }
        }
    }
}

/// What one event line meant.
#[derive(Clone, Debug, PartialEq)]
pub enum Ev {
    Session(String),
    /// a whole block of text (Claude Code, opencode, Codex)
    Text(String),
    /// a streamed chunk of text, joined as is (Gemini CLI's `delta` messages)
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
        // gemini-cli's stream-json (0.68.0, nonInteractiveCli): init · message (user, then the
        // assistant's text in `delta` chunks) · tool_use · tool_result · error (warning | error) ·
        // result (success | error; it carries no text — the reply is the joined chunks)
        Kind::Gemini => match v["type"].as_str() {
            Some("init") => out.push(Ev::Session(s(&v["session_id"]))),
            Some("message") if v["role"] == "assistant" && !s(&v["content"]).is_empty() => out.push(Ev::Delta(s(&v["content"]))),
            Some("tool_use") => out.push(Ev::Tool { name: s(&v["tool_name"]), input: v["parameters"].clone(), output: String::new() }),
            Some("error") if v["severity"] == "error" => out.push(Ev::Error(s(&v["message"]))),
            Some("result") if v["status"] == "error" => {
                out.push(Ev::Error(v["error"]["message"].as_str().filter(|m| !m.is_empty()).unwrap_or("the Gemini CLI run failed").into()))
            }
            _ => {}
        },
    }
    out
}

/// What the owner reads when a harness is not signed in (the session's error).
pub const GEMINI_SIGNED_OUT: &str = "Gemini CLI is not signed in — add GEMINI_API_KEY=<key> to the brain's environment, or sign in once by running `gemini` in a terminal (Login with Google)";

/// A harness failure, said plainly: Gemini CLI's auth failures (exit 41 = FatalAuthenticationError,
/// "Please set an Auth method…", or a key the API refuses) become "not signed in".
fn explain(kind: Kind, code: Option<i32>, msg: &str) -> Option<String> {
    let signed_out = code == Some(41) || ["Please set an Auth method", "API_KEY_INVALID", "API key not valid"].iter().any(|n| msg.contains(n));
    (kind == Kind::Gemini && signed_out).then(|| GEMINI_SIGNED_OUT.to_string())
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
            assert_eq!(mangle("/home/dweeb_xyz/.cache/root-sim/preview/work"), "-home-dweeb-xyz--cache-root-sim-preview-work");
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
        sin.write_all(prompt.as_bytes()).await.map_err(|e| e.to_string())?;
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
                        t.insert_str(0, "\n\n");
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
    let text = fin.filter(|f| !f.trim().is_empty()).unwrap_or(text);
    if let Some(e) = error {
        return Err(explain(kind, status.code(), &e).unwrap_or_else(|| format!("{}: {e}", kind.name())));
    }
    if !status.success() && text.trim().is_empty() {
        let tail: String = stderr.lines().rev().take(6).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n");
        return Err(explain(kind, status.code(), &stderr).unwrap_or_else(|| format!("{} exited {status}: {tail}", kind.name())));
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
    fn gemini_argv() {
        let (a, stdin) = Kind::Gemini.argv(Some("gemini-3.5-flash"), None, Path::new("/w"), "hi", Some("x"), Attach::default());
        assert!(stdin, "the prompt goes on stdin");
        assert_eq!(a[0], "gemini");
        assert!(pair(&a, "--output-format", "stream-json") && pair(&a, "--approval-mode", "yolo") && a.contains(&"--skip-trust".to_string()));
        assert!(pair(&a, "--model", "gemini-3.5-flash") && !a.contains(&"--resume".to_string()) && !a.contains(&"hi".to_string()));
        let (a, _) = Kind::Gemini.argv(None, Some("5a0c1f9e-2b7d-4c55-9e0a-7f3b2d1c4e5f"), Path::new("/w"), "hi", None, Attach::default());
        assert!(pair(&a, "--resume", "5a0c1f9e-2b7d-4c55-9e0a-7f3b2d1c4e5f") && !a.contains(&"--model".to_string()));
        assert_eq!(Kind::parse("gemini"), Some(Kind::Gemini));
    }

    fn lines(f: &str) -> Vec<Ev> {
        f.lines().filter_map(|l| serde_json::from_str::<Value>(l).ok()).flat_map(|v| parse(Kind::Gemini, &v)).collect()
    }

    /// REAL output (11-13, a key the API refuses): init → user message → error result.
    #[test]
    fn gemini_real_error_stream() {
        let evs = lines(include_str!("../fixtures/gemini/bad-key.stream.jsonl"));
        assert_eq!(evs[0], Ev::Session("62d4572e-5e63-4dd0-9c04-5f756742afc7".into()));
        assert_eq!(evs.len(), 2, "the user's own message is not echoed back: {evs:?}");
        assert!(matches!(&evs[1], Ev::Error(m) if m.contains("API key not valid")), "{evs:?}");
        assert_eq!(explain(Kind::Gemini, Some(144), "API key not valid. Please pass a valid API key.").as_deref(), Some(GEMINI_SIGNED_OUT));
    }

    /// REAL (11-13, no auth at all): nothing on stdout, exit 41, this on stderr → "not signed in".
    #[test]
    fn gemini_signed_out_is_said_plainly() {
        let err = include_str!("../fixtures/gemini/signed-out.stderr.txt");
        assert_eq!(explain(Kind::Gemini, Some(41), err).as_deref(), Some(GEMINI_SIGNED_OUT));
        assert_eq!(explain(Kind::Gemini, Some(1), err).as_deref(), Some(GEMINI_SIGNED_OUT));
        assert!(GEMINI_SIGNED_OUT.starts_with("Gemini CLI is not signed in"));
        assert_eq!(explain(Kind::Gemini, Some(1), "boom"), None);
        assert_eq!(explain(Kind::Claude, Some(41), err), None);
    }

    /// The documented stream (a fixture — not seen live: the CLI is not signed in on this box).
    #[test]
    fn gemini_documented_stream() {
        let evs = lines(include_str!("../fixtures/gemini/documented.stream.jsonl"));
        assert_eq!(evs[0], Ev::Session("5a0c1f9e-2b7d-4c55-9e0a-7f3b2d1c4e5f".into()));
        assert_eq!(evs[1], Ev::Delta("I'll list ".into()));
        assert_eq!(evs[2], Ev::Delta("them.".into()));
        assert!(matches!(&evs[3], Ev::Tool { name, input, .. } if name == "run_shell_command" && input["command"] == "ls"), "{evs:?}");
        assert_eq!(evs[4], Ev::Delta("done".into()), "a warning is not an error; tool_result / success result add nothing");
        assert_eq!(evs.len(), 5);
        let fatal = json!({"type":"error","severity":"error","message":"Maximum session turns exceeded"});
        assert_eq!(parse(Kind::Gemini, &fatal), vec![Ev::Error("Maximum session turns exceeded".into())]);
        let bare = json!({"type":"result","status":"error","stats":{}});
        assert!(matches!(&parse(Kind::Gemini, &bare)[0], Ev::Error(_)));
    }

    /// run() end to end on a stand-in `gemini` (a script printing the documented stream): chunks
    /// join, the tool call starts a new paragraph, the session id is kept.
    #[tokio::test]
    async fn gemini_run_joins_chunks() {
        let dir = std::env::temp_dir().join(format!("ygg-gemini-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let fx = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/gemini/documented.stream.jsonl");
        let script = dir.join("gemini");
        std::fs::write(&script, format!("#!/bin/sh\ncat >/dev/null\ncat '{}'\n", fx.display())).unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let path = format!("{}:{}", dir.display(), std::env::var("PATH").unwrap_or_default());
        // SAFETY: this test is the only one that runs a `gemini`; PATH gains a directory in front
        unsafe { std::env::set_var("PATH", path) };
        let mut seen = Vec::new();
        let out = run(Kind::Gemini, None, None, &dir, "list the files, then say done", None, Attach::default(), |e| seen.push(e.clone())).await.unwrap();
        assert_eq!(out.text, "I'll list them.\n\ndone");
        assert_eq!(out.session.as_deref(), Some("5a0c1f9e-2b7d-4c55-9e0a-7f3b2d1c4e5f"));
        assert!(seen.contains(&Ev::Delta("\n\ndone".into())), "the phone's stream gets the same paragraph break: {seen:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
