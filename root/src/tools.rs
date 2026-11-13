//! Slice 6a: the tool set the agent loop declares upstream (OpenAI function calling)
//! and executes. Shapes follow opencode's tools (camelCase `filePath`, `oldString`, ...).
//!
//! Relative paths resolve against the project dir; absolute paths are taken as-is.
//! No permission prompts and no path sandbox — single-user box (see ASSESSMENT.md).

use std::{
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};

use futures::StreamExt;
use serde_json::{Value, json};

/// Max chars of one tool output that is stored and sent upstream. Real outputs reach
/// hundreds of KB (LIFE.md); opencode's bash cap is 30k too.
pub const MAX_OUTPUT: usize = 30_000;
const READ_DEFAULT_LIMIT: usize = 2000;
const READ_MAX_LINE: usize = 2000;
const LIST_LIMIT: usize = 100;
const WEBFETCH_MAX_BYTES: usize = 5 * 1024 * 1024;
const RG_TIMEOUT: Duration = Duration::from_secs(30);

pub struct ToolEnv {
    pub project_dir: PathBuf,
    pub bash_timeout: Duration,
    pub http: reqwest::Client,
}

pub struct ToolResult {
    pub ok: bool,
    pub title: String,
    pub output: String,
    pub metadata: Value,
}

/// The `tools` array sent with every upstream request.
pub fn schemas() -> Value {
    fn f(name: &str, description: &str, properties: Value, required: &[&str]) -> Value {
        json!({ "type": "function", "function": {
            "name": name, "description": description,
            "parameters": { "type": "object", "properties": properties, "required": required },
        }})
    }
    let s = |d: &str| json!({ "type": "string", "description": d });
    let n = |d: &str| json!({ "type": "integer", "description": d });
    json!([
        f("bash", "Run a shell command (bash -c) in the project directory. Returns stdout, stderr and the exit code.",
          json!({ "command": s("the command"), "timeout": n("timeout in ms (default 120000, max 600000)"),
                  "description": s("5-10 word summary of what the command does") }), &["command"]),
        f("read", "Read a text file. Output lines are numbered; use offset/limit for big files.",
          json!({ "filePath": s("path to the file"), "offset": n("0-based line to start at"),
                  "limit": n("number of lines (default 2000)") }), &["filePath"]),
        f("write", "Write a file (creates parent directories, overwrites).",
          json!({ "filePath": s("path to the file"), "content": s("full file content") }), &["filePath", "content"]),
        f("edit", "Replace an exact string in a file. oldString must match exactly once unless replaceAll; an empty oldString creates the file with newString.",
          json!({ "filePath": s("path to the file"), "oldString": s("exact text to replace"),
                  "newString": s("replacement text"), "replaceAll": { "type": "boolean" } }),
          &["filePath", "oldString", "newString"]),
        f("glob", "List files matching a glob pattern (gitignore-aware).",
          json!({ "pattern": s("glob, e.g. **/*.rs"), "path": s("directory to search (default: project dir)") }), &["pattern"]),
        f("grep", "Search file contents with a regex (ripgrep). Returns path:line:text.",
          json!({ "pattern": s("regex"), "path": s("file or directory (default: project dir)"),
                  "include": s("glob filter for files, e.g. *.ts") }), &["pattern"]),
        f("webfetch", "HTTP GET a URL and return its body as text.",
          json!({ "url": s("http(s) URL"), "format": { "type": "string", "enum": ["text", "markdown", "html"] },
                  "timeout": n("seconds (default 30, max 120)") }), &["url"]),
        f("todowrite", "Replace the session's todo list.",
          json!({ "todos": { "type": "array", "items": { "type": "object", "properties": {
              "id": { "type": "string" }, "content": { "type": "string" },
              "status": { "type": "string", "enum": ["pending", "in_progress", "completed", "cancelled"] },
              "priority": { "type": "string", "enum": ["high", "medium", "low"] } },
              "required": ["content", "status"] } } }), &["todos"]),
    ])
}

/// Executes one call. Errors become `ok: false` results (fed back to the model, never fatal).
pub async fn run(env: &ToolEnv, name: &str, input: &Value) -> ToolResult {
    let res = match name {
        "bash" => bash(env, input).await,
        "read" => read(env, input).await,
        "write" => write(env, input).await,
        "edit" => edit(env, input).await,
        "glob" => glob(env, input).await,
        "grep" => grep(env, input).await,
        "webfetch" => webfetch(env, input).await,
        "todowrite" => todowrite(input),
        _ => Err(format!("unknown tool: {name}")),
    };
    let title = title(name, input);
    match res {
        Ok((output, mut metadata)) => {
            let (output, truncated) = truncate(output);
            if truncated {
                metadata["truncated"] = json!(true);
            }
            ToolResult { ok: true, title, output, metadata }
        }
        Err(e) => ToolResult { ok: false, title, output: truncate(e).0, metadata: json!({}) },
    }
}

fn title(name: &str, input: &Value) -> String {
    let key = match name {
        "bash" if input["description"].is_string() => "description",
        "bash" => "command",
        "read" | "write" | "edit" => "filePath",
        "glob" | "grep" => "pattern",
        "webfetch" => "url",
        _ => return name.to_string(),
    };
    input[key].as_str().unwrap_or(name).to_string()
}

/// Keeps head and tail (build errors and test summaries live at the end).
pub fn truncate(s: String) -> (String, bool) {
    if s.len() <= MAX_OUTPUT {
        return (s, false);
    }
    let half = MAX_OUTPUT / 2;
    let mut head = half;
    while !s.is_char_boundary(head) {
        head -= 1;
    }
    let mut tail = s.len() - half;
    while !s.is_char_boundary(tail) {
        tail += 1;
    }
    let dropped = tail - head;
    (format!("{}\n\n[... {dropped} bytes truncated ...]\n\n{}", &s[..head], &s[tail..]), true)
}

fn str_arg<'a>(input: &'a Value, key: &str) -> Result<&'a str, String> {
    input[key].as_str().ok_or_else(|| format!("missing string argument `{key}`"))
}

fn resolve(env: &ToolEnv, p: &str) -> PathBuf {
    let p = Path::new(p);
    if p.is_absolute() { p.to_path_buf() } else { env.project_dir.join(p) }
}

/// SIGKILLs the command's whole process group on drop unless disarmed — covers timeouts
/// and aborts (the run future is dropped mid-tool), including grandchildren.
struct GroupKill(Option<u32>);

impl Drop for GroupKill {
    fn drop(&mut self) {
        if let Some(pid) = self.0 {
            unsafe {
                libc::kill(-(pid as i32), libc::SIGKILL);
            }
        }
    }
}

async fn bash(env: &ToolEnv, input: &Value) -> Result<(String, Value), String> {
    let command = str_arg(input, "command")?;
    let timeout = input["timeout"]
        .as_u64()
        .map(|ms| Duration::from_millis(ms.min(600_000)))
        .unwrap_or(env.bash_timeout);
    let mut cmd = tokio::process::Command::new("bash");
    cmd.arg("-c")
        .arg(command)
        .current_dir(&env.project_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0)
        .kill_on_drop(true);
    // Keep the upstream key out of the agent's shell.
    for (k, _) in std::env::vars() {
        if k.starts_with("YGG_") {
            cmd.env_remove(k);
        }
    }
    let child = cmd.spawn().map_err(|e| format!("spawn bash: {e}"))?;
    let mut guard = GroupKill(child.id());
    let out = match tokio::time::timeout(timeout, child.wait_with_output()).await {
        Ok(r) => r.map_err(|e| format!("bash: {e}"))?,
        Err(_) => return Err(format!("command timed out after {} ms (process group killed)", timeout.as_millis())),
    };
    guard.0 = None; // exited normally: leave intentional background jobs alone
    let mut text = String::from_utf8_lossy(&out.stdout).into_owned();
    if !out.stderr.is_empty() {
        if !text.is_empty() && !text.ends_with('\n') {
            text.push('\n');
        }
        text.push_str(&String::from_utf8_lossy(&out.stderr));
    }
    let exit = out.status.code();
    if exit != Some(0) {
        if !text.is_empty() && !text.ends_with('\n') {
            text.push('\n');
        }
        text.push_str(&match exit {
            Some(c) => format!("[exit code {c}]"),
            None => "[killed by signal]".into(),
        });
    }
    Ok((text, json!({ "exit": exit })))
}

async fn read(env: &ToolEnv, input: &Value) -> Result<(String, Value), String> {
    let path = resolve(env, str_arg(input, "filePath")?);
    let bytes = tokio::fs::read(&path).await.map_err(|e| format!("read {}: {e}", path.display()))?;
    if bytes[..bytes.len().min(8192)].contains(&0) {
        return Err(format!("{} looks binary; not reading", path.display()));
    }
    let text = String::from_utf8_lossy(&bytes);
    let offset = input["offset"].as_u64().unwrap_or(0) as usize;
    let limit = input["limit"].as_u64().map(|l| l as usize).unwrap_or(READ_DEFAULT_LIMIT);
    let total = text.lines().count();
    let mut out = String::new();
    for (i, line) in text.lines().enumerate().skip(offset).take(limit) {
        let line = match line.char_indices().nth(READ_MAX_LINE) {
            Some((cut, _)) => format!("{}...", &line[..cut]),
            None => line.to_string(),
        };
        out.push_str(&format!("{:>6}\t{line}\n", i + 1));
    }
    if offset + limit < total {
        out.push_str(&format!("\n(file has {total} lines; use offset={} to read more)\n", offset + limit));
    }
    Ok((out, json!({ "lines": total })))
}

async fn write(env: &ToolEnv, input: &Value) -> Result<(String, Value), String> {
    let path = resolve(env, str_arg(input, "filePath")?);
    let content = str_arg(input, "content")?;
    let existed = path.exists();
    if let Some(dir) = path.parent() {
        tokio::fs::create_dir_all(dir).await.map_err(|e| format!("mkdir {}: {e}", dir.display()))?;
    }
    tokio::fs::write(&path, content).await.map_err(|e| format!("write {}: {e}", path.display()))?;
    Ok((format!("Wrote {} bytes to {}", content.len(), path.display()), json!({ "created": !existed })))
}

async fn edit(env: &ToolEnv, input: &Value) -> Result<(String, Value), String> {
    let path = resolve(env, str_arg(input, "filePath")?);
    let old = str_arg(input, "oldString")?;
    let new = str_arg(input, "newString")?;
    if old.is_empty() {
        if let Some(dir) = path.parent() {
            tokio::fs::create_dir_all(dir).await.map_err(|e| format!("mkdir {}: {e}", dir.display()))?;
        }
        tokio::fs::write(&path, new).await.map_err(|e| format!("write {}: {e}", path.display()))?;
        return Ok((format!("Created {}", path.display()), json!({ "replacements": 0, "created": true })));
    }
    if old == new {
        return Err("oldString and newString are identical".into());
    }
    let text = tokio::fs::read_to_string(&path).await.map_err(|e| format!("read {}: {e}", path.display()))?;
    let count = text.matches(old).count();
    let all = input["replaceAll"].as_bool().unwrap_or(false);
    if count == 0 {
        return Err(format!("oldString not found in {}", path.display()));
    }
    if count > 1 && !all {
        return Err(format!("oldString found {count} times in {}; add context or set replaceAll", path.display()));
    }
    let edited = if all { text.replace(old, new) } else { text.replacen(old, new, 1) };
    tokio::fs::write(&path, edited).await.map_err(|e| format!("write {}: {e}", path.display()))?;
    let n = if all { count } else { 1 };
    Ok((format!("Edited {}: {n} replacement(s)", path.display()), json!({ "replacements": n })))
}

/// Runs ripgrep with a timeout; returns (exit code, stdout, stderr).
async fn rg(dir: &Path, args: &[&str]) -> Result<(Option<i32>, String, String), String> {
    let child = tokio::process::Command::new("rg")
        .args(args)
        .current_dir(dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("spawn rg (ripgrep required): {e}"))?;
    let out = tokio::time::timeout(RG_TIMEOUT, child.wait_with_output())
        .await
        .map_err(|_| "ripgrep timed out".to_string())?
        .map_err(|e| format!("rg: {e}"))?;
    Ok((
        out.status.code(),
        String::from_utf8_lossy(&out.stdout).into_owned(),
        String::from_utf8_lossy(&out.stderr).into_owned(),
    ))
}

async fn glob(env: &ToolEnv, input: &Value) -> Result<(String, Value), String> {
    let pattern = str_arg(input, "pattern")?;
    let dir = input["path"].as_str().map(|p| resolve(env, p)).unwrap_or_else(|| env.project_dir.clone());
    let (code, out, err) = rg(&dir, &["--files", "--glob", pattern]).await?;
    if code == Some(2) {
        return Err(format!("rg: {err}"));
    }
    let mut files: Vec<String> = out.lines().map(|l| dir.join(l).display().to_string()).collect();
    files.sort();
    let count = files.len();
    if count == 0 {
        return Ok(("No files found".into(), json!({ "count": 0 })));
    }
    let mut text = files.iter().take(LIST_LIMIT).cloned().collect::<Vec<_>>().join("\n");
    if count > LIST_LIMIT {
        text.push_str(&format!("\n\n({count} files, first {LIST_LIMIT} shown; narrow the pattern)"));
    }
    Ok((text, json!({ "count": count })))
}

async fn grep(env: &ToolEnv, input: &Value) -> Result<(String, Value), String> {
    let pattern = str_arg(input, "pattern")?;
    let path = input["path"].as_str().map(|p| resolve(env, p)).unwrap_or_else(|| env.project_dir.clone());
    let path_s = path.display().to_string();
    let mut args = vec!["-n", "--no-heading", "--color", "never", "--max-columns", "2000"];
    if let Some(inc) = input["include"].as_str() {
        args.extend(["--glob", inc]);
    }
    args.extend(["-e", pattern, "--", &path_s]);
    let (code, out, err) = rg(&env.project_dir, &args).await?;
    match code {
        Some(0) => Ok((out.trim_end().to_string(), json!({ "matches": out.lines().count() }))),
        Some(1) => Ok(("No matches found".into(), json!({ "matches": 0 }))),
        _ => Err(format!("rg: {}", err.trim())),
    }
}

async fn webfetch(env: &ToolEnv, input: &Value) -> Result<(String, Value), String> {
    let url = str_arg(input, "url")?;
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("url must start with http:// or https://".into());
    }
    let secs = input["timeout"].as_u64().unwrap_or(30).min(120);
    let fetch = async {
        let resp = env.http.get(url).send().await.map_err(|e| format!("fetch {url}: {e}"))?;
        let status = resp.status();
        let ctype = resp
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();
        let mut body = Vec::new();
        let mut stream = resp.bytes_stream();
        while let Some(chunk) = stream.next().await {
            body.extend_from_slice(&chunk.map_err(|e| format!("fetch {url}: {e}"))?);
            if body.len() > WEBFETCH_MAX_BYTES {
                return Err(format!("response exceeds {WEBFETCH_MAX_BYTES} bytes"));
            }
        }
        Ok::<_, String>((status, ctype, body))
    };
    let (status, ctype, body) = tokio::time::timeout(Duration::from_secs(secs), fetch)
        .await
        .map_err(|_| format!("fetch {url}: timed out after {secs}s"))??;
    if !status.is_success() {
        return Err(format!("fetch {url}: HTTP {status}"));
    }
    let text = String::from_utf8_lossy(&body).into_owned();
    let want_html = input["format"].as_str() == Some("html");
    let text = if ctype.contains("html") && !want_html { strip_html(&text) } else { text };
    Ok((text, json!({ "status": status.as_u16(), "contentType": ctype })))
}

/// Crude HTML → text: drops script/style bodies and tags, decodes common entities,
/// squeezes blank lines. Good enough for a model to read docs pages.
fn strip_html(html: &str) -> String {
    let lower = html.to_ascii_lowercase();
    let mut out = String::with_capacity(html.len() / 2);
    let mut i = 0;
    while i < html.len() {
        let rest = &lower[i..];
        if rest.starts_with("<script") || rest.starts_with("<style") {
            let close = if rest.starts_with("<script") { "</script>" } else { "</style>" };
            i += rest.find(close).map(|p| p + close.len()).unwrap_or(rest.len());
        } else if rest.starts_with('<') {
            let tag_end = rest.find('>').map(|p| p + 1).unwrap_or(rest.len());
            let tag = &rest[..tag_end];
            if ["<br", "<p", "</p", "<div", "</div", "<li", "<h", "</h", "<tr"].iter().any(|t| tag.starts_with(t)) {
                out.push('\n');
            }
            i += tag_end;
        } else {
            let next = rest.find('<').unwrap_or(rest.len());
            out.push_str(&html[i..i + next]);
            i += next;
        }
    }
    let out = out
        .replace("&nbsp;", " ")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&amp;", "&");
    let mut squeezed = String::new();
    let mut blank = 0;
    for line in out.lines().map(str::trim_end) {
        blank = if line.trim().is_empty() { blank + 1 } else { 0 };
        if blank <= 1 {
            squeezed.push_str(line);
            squeezed.push('\n');
        }
    }
    squeezed
}

/// Validates the list; the caller stores `metadata.todos` on the session.
fn todowrite(input: &Value) -> Result<(String, Value), String> {
    let todos = input["todos"].as_array().ok_or("missing array argument `todos`")?;
    let mut clean = Vec::new();
    for (i, t) in todos.iter().enumerate() {
        let content = t["content"].as_str().ok_or(format!("todo {i}: missing content"))?;
        let status = t["status"].as_str().unwrap_or("pending");
        if !["pending", "in_progress", "completed", "cancelled"].contains(&status) {
            return Err(format!("todo {i}: bad status {status}"));
        }
        clean.push(json!({
            "id": t["id"].as_str().map(String::from).unwrap_or_else(|| (i + 1).to_string()),
            "content": content,
            "status": status,
            "priority": t["priority"].as_str().unwrap_or("medium"),
        }));
    }
    let open = clean.iter().filter(|t| t["status"] != "completed" && t["status"] != "cancelled").count();
    let out = format!("{open} todos\n{}", serde_json::to_string_pretty(&clean).unwrap());
    Ok((out, json!({ "todos": clean })))
}
