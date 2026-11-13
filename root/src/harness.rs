//! Harness sessions (root-coord, 11-12): a session whose engine is another agent harness —
//! Claude Code, opencode or OpenAI's Codex CLI — instead of the brain's own loop. Each turn runs
//! the harness non-interactively in the session's directory, RESUMING the harness's own session
//! (its id is kept on `info.harness.id`), so the conversation continues there with its full
//! context and tools. Text streams into the session like any reply; the harness's tool calls are
//! stored as completed tool parts; the turn then reports up the tree like any other.
//!
//! One adapter per harness = argv + a line parser over its JSON event stream. Nothing else.

use std::{path::Path, process::Stdio};

use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Kind {
    Claude,
    Opencode,
    Codex,
}

impl Kind {
    pub fn parse(s: &str) -> Option<Kind> {
        match s {
            "claude" | "claude-code" => Some(Kind::Claude),
            "opencode" => Some(Kind::Opencode),
            "codex" => Some(Kind::Codex),
            _ => None,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Kind::Claude => "claude",
            Kind::Opencode => "opencode",
            Kind::Codex => "codex",
        }
    }

    /// argv (program first) + whether the prompt goes on stdin.
    fn argv(self, model: Option<&str>, resume: Option<&str>, cwd: &Path, prompt: &str, system: Option<&str>) -> (Vec<String>, bool) {
        let mut a: Vec<String> = Vec::new();
        let mut push = |xs: &[&str]| a.extend(xs.iter().map(|x| x.to_string()));
        match self {
            Kind::Claude => {
                push(&["claude", "-p", "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions"]);
                if let Some(m) = model {
                    push(&["--model", m]);
                }
                if let Some(r) = resume {
                    push(&["--resume", r]);
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
        }
    }
}

/// What one event line meant.
#[derive(Clone, Debug, PartialEq)]
pub enum Ev {
    Session(String),
    Text(String),
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
    }
    out
}

pub struct Outcome {
    pub text: String,
    pub session: Option<String>,
}

/// Runs one turn. `on` sees every event as it arrives (stream text, store tools). The child is
/// killed when the returned future is dropped (an abort drops it).
pub async fn run(kind: Kind, model: Option<&str>, resume: Option<&str>, cwd: &Path, prompt: &str, system: Option<&str>, mut on: impl FnMut(&Ev)) -> Result<Outcome, String> {
    let (argv, stdin_prompt) = kind.argv(model, resume, cwd, prompt, system);
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
    while let Ok(Some(line)) = lines.next_line().await {
        let Ok(v) = serde_json::from_str::<Value>(line.trim()) else { continue };
        for ev in parse(kind, &v) {
            match &ev {
                Ev::Session(id) if !id.is_empty() => session = Some(id.clone()),
                Ev::Text(t) => {
                    if !text.is_empty() {
                        text.push_str("\n\n");
                    }
                    text.push_str(t);
                }
                Ev::Final(t) => fin = Some(t.clone()),
                Ev::Error(e) => error = Some(e.clone()),
                _ => {}
            }
            on(&ev);
        }
    }
    let status = child.wait().await.map_err(|e| e.to_string())?;
    let stderr = err_task.await.unwrap_or_default();
    let text = fin.filter(|f| !f.trim().is_empty()).unwrap_or(text);
    if let Some(e) = error {
        return Err(format!("{}: {e}", kind.name()));
    }
    if !status.success() && text.trim().is_empty() {
        let tail: String = stderr.lines().rev().take(6).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n");
        return Err(format!("{} exited {status}: {tail}", kind.name()));
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
        let (a, stdin) = Kind::Claude.argv(Some("sonnet"), Some("s1"), Path::new("/w"), "p", Some("be terse"));
        assert!(stdin && a.contains(&"--resume".to_string()) && a.contains(&"sonnet".to_string()));
        assert!(a.windows(2).any(|w| w[0] == "--append-system-prompt" && w[1] == "be terse"));
        let (a, stdin) = Kind::Opencode.argv(None, Some("ses_1"), Path::new("/w"), "do it", None);
        assert!(!stdin && a.ends_with(&["--".to_string(), "do it".to_string()]) && a.contains(&"--session".to_string()));
        let (a, _) = Kind::Codex.argv(None, Some("t1"), Path::new("/w"), "go", None);
        let i = a.iter().position(|x| x == "resume").unwrap();
        assert_eq!(&a[i + 1..], &["t1".to_string(), "go".to_string()]);
    }
}
