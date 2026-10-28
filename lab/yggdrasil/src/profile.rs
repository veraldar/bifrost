//! TOOL-SCOPE (10-28): session tool profiles — opencode's agent permission ruleset, enforced
//! at tool dispatch.
//!
//! A profile is the `GET /agent` element shape opencode serves:
//! `{name, description?, mode, permission: [{permission, pattern, action}], override?}`.
//! - The **last matching rule wins**; no match = `ask`; `ask` is a denial (the root has no
//!   approval channel and never waits on anything but its own run).
//! - `write` and `edit` check the `edit` permission (opencode); every other tool its own name.
//! - The pattern is matched against the call's subject: the normalized path (relative to the
//!   project dir inside it, absolute outside) for read/write/edit, the `pattern` argument for
//!   glob/grep, the URL for webfetch, each simple command for bash. A path outside the project
//!   dir must also pass `external_directory`; an unquoted output redirection in bash must also
//!   pass `edit` for its target.
//! - A tool whose last rule by permission is a blanket `{pattern: "*", action: "deny"}` is not
//!   declared upstream (opencode's `disabled()`); it is still checked at dispatch.
//! - `override: {tool: {name?, description?}}` changes the surface the model sees (the
//!   surface-familiarity lab); rules are always written against the canonical names.
//!
//! A session picks its profile at `POST /session {profile}`; it is fixed for the session's
//! life. Profiles come from `YGG_PROFILES` (read once at boot) — never from the API.

use std::{
    collections::BTreeMap,
    path::{Component, Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

/// The canonical tool names (`tools.rs`).
pub const TOOLS: [&str; 8] = ["bash", "read", "write", "edit", "glob", "grep", "webfetch", "todowrite"];

/// Checked permissions that are not a tool's own name.
const DERIVED: [&str; 1] = ["external_directory"];

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Action {
    Allow,
    Deny,
    Ask,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Rule {
    pub permission: String,
    pub pattern: String,
    pub action: Action,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Override {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Profile {
    #[serde(default)]
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default = "primary")]
    pub mode: String,
    pub permission: Vec<Rule>,
    #[serde(default, rename = "override", skip_serializing_if = "BTreeMap::is_empty")]
    pub overrides: BTreeMap<String, Override>,
}

fn primary() -> String {
    "primary".into()
}

/// The permission a tool's calls are checked against.
pub fn permission_of(tool: &str) -> &str {
    if tool == "write" || tool == "edit" { "edit" } else { tool }
}

pub struct Profiles {
    pub default: String,
    pub all: BTreeMap<String, Profile>,
}

/// `YGG_PROFILES` file: the opencode.json keys (`agent`, `default_agent`), rules in array form.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct File {
    #[serde(default)]
    default_agent: Option<String>,
    agent: BTreeMap<String, Profile>,
}

impl Profiles {
    /// No `YGG_PROFILES`: one profile, `build` = every tool — the root's behavior before profiles.
    pub fn builtin() -> Self {
        let build = Profile {
            name: "build".into(),
            description: Some("every tool (built-in default)".into()),
            mode: primary(),
            permission: vec![Rule { permission: "*".into(), pattern: "*".into(), action: Action::Allow }],
            overrides: BTreeMap::new(),
        };
        Profiles { default: "build".into(), all: BTreeMap::from([("build".to_string(), build)]) }
    }

    /// Parses and validates a `YGG_PROFILES` file. Returns the profiles and boot warnings
    /// (rules whose permission matches no tool — likely typos; they enforce nothing).
    pub fn parse(bytes: &[u8]) -> Result<(Self, Vec<String>), String> {
        let file: File = serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
        let mut warnings = Vec::new();
        let mut all = BTreeMap::new();
        for (name, mut p) in file.agent {
            if name.is_empty() || !name.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c)) {
                return Err(format!("profile name {name:?}: use [A-Za-z0-9._-]"));
            }
            p.name = name.clone();
            for (tool, o) in &p.overrides {
                if !TOOLS.contains(&tool.as_str()) {
                    return Err(format!("profile {name}: override of unknown tool {tool:?}"));
                }
                if let Some(n) = &o.name {
                    let ok = !n.is_empty() && n.len() <= 64 && n.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
                    if !ok {
                        return Err(format!("profile {name}: override name {n:?} for {tool}: use [A-Za-z0-9_-], max 64"));
                    }
                }
            }
            let mut exposed: Vec<&str> = TOOLS.iter().map(|t| p.exposed(t)).collect();
            exposed.sort_unstable();
            if let Some(w) = exposed.windows(2).find(|w| w[0] == w[1]) {
                return Err(format!("profile {name}: two tools exposed as {:?}", w[0]));
            }
            for r in &p.permission {
                let hits = TOOLS.iter().map(|t| permission_of(t)).chain(DERIVED).any(|perm| wildcard(&r.permission, perm));
                if !hits {
                    warnings.push(format!("profile {name}: rule permission {:?} matches no tool (enforces nothing)", r.permission));
                }
            }
            all.insert(name, p);
        }
        let default = match file.default_agent {
            Some(d) => d,
            None if all.contains_key("build") => "build".into(),
            None => return Err("default_agent is required when no profile is named build".into()),
        };
        if !all.contains_key(&default) {
            return Err(format!("default_agent {default:?} is not a configured profile"));
        }
        Ok((Profiles { default, all }, warnings))
    }

    /// The profile a session runs under: its stored name, or the default (sessions created
    /// before profiles existed). A stored name that is no longer configured is an error —
    /// never a silent fallback to a wider profile.
    pub fn resolve(&self, name: Option<&str>) -> Result<&Profile, String> {
        let name = name.unwrap_or(&self.default);
        self.all.get(name).ok_or_else(|| format!("profile {name:?} is not configured on this root"))
    }

    /// `GET /profile` — the `GET /agent` element shape plus `default`.
    pub fn list(&self) -> Value {
        Value::Array(
            self.all
                .values()
                .map(|p| {
                    let mut v = serde_json::to_value(p).unwrap();
                    v["default"] = json!(p.name == self.default);
                    v
                })
                .collect(),
        )
    }
}

/// Why a call was refused; `message` is what the model reads, `to_json` goes on the part.
#[derive(Debug)]
pub struct Denial {
    pub profile: String,
    pub permission: String,
    pub subject: String,
    pub action: Action,
    pub rule: Option<Rule>,
}

impl Denial {
    pub fn message(&self, allowed: &str) -> String {
        let why = match &self.rule {
            Some(r) => format!(
                "matched rule {{permission: {:?}, pattern: {:?}, action: {:?}}}",
                r.permission,
                r.pattern,
                action_name(r.action)
            ),
            None => "no rule allows it (unlisted = ask)".into(),
        };
        let verdict = match self.action {
            Action::Ask => "needs approval (action \"ask\") and this root has no approval channel, so it is denied",
            _ => "is denied",
        };
        format!(
            "Permission denied by profile \"{}\": {} `{}` {verdict} — {why}. Do not retry this call or a \
             workaround for it; this session cannot do it. {allowed}",
            self.profile, self.permission, self.subject
        )
    }

    pub fn to_json(&self) -> Value {
        json!({ "profile": self.profile, "permission": self.permission, "subject": self.subject,
                "action": action_name(self.action), "rule": self.rule })
    }
}

fn action_name(a: Action) -> &'static str {
    match a {
        Action::Allow => "allow",
        Action::Deny => "deny",
        Action::Ask => "ask",
    }
}

impl Profile {
    /// The name the model sees for a canonical tool.
    pub fn exposed<'a>(&'a self, tool: &'a str) -> &'a str {
        self.overrides.get(tool).and_then(|o| o.name.as_deref()).unwrap_or(tool)
    }

    /// The canonical tool behind a name the model called. `None` = a canonical name this
    /// profile renamed away (unknown to the model's surface). Names that are no tool at all
    /// pass through, so `tools::run` reports them as unknown.
    pub fn canonical<'a>(&'a self, called: &'a str) -> Option<&'a str> {
        match TOOLS.iter().copied().find(|t| self.exposed(t) == called) {
            Some(t) => Some(t),
            None if TOOLS.contains(&called) => None,
            None => Some(called),
        }
    }

    /// opencode's `disabled()`: the last rule for the tool's permission is a blanket deny.
    pub fn hidden(&self, tool: &str) -> bool {
        let perm = permission_of(tool);
        self.permission
            .iter()
            .rev()
            .find(|r| wildcard(&r.permission, perm))
            .is_some_and(|r| r.pattern == "*" && r.action == Action::Deny)
    }

    /// The tool list declared upstream: `all` (`tools::schemas()`) minus hidden tools, with
    /// overrides applied. `None` = declare nothing (no `tools` key at all).
    pub fn declare(&self, all: &Value) -> Option<Value> {
        let out: Vec<Value> = all
            .as_array()?
            .iter()
            .filter_map(|s| {
                let name = s["function"]["name"].as_str()?;
                if self.hidden(name) {
                    return None;
                }
                let mut s = s.clone();
                if let Some(o) = self.overrides.get(name) {
                    if let Some(n) = &o.name {
                        s["function"]["name"] = json!(n);
                    }
                    if let Some(d) = &o.description {
                        s["function"]["description"] = json!(d);
                    }
                }
                Some(s)
            })
            .collect();
        (!out.is_empty()).then_some(Value::Array(out))
    }

    fn eval(&self, perm: &str, subject: &str) -> (Action, Option<&Rule>) {
        match self.permission.iter().rev().find(|r| wildcard(&r.permission, perm) && wildcard(&r.pattern, subject)) {
            Some(r) => (r.action, Some(r)),
            None => (Action::Ask, None),
        }
    }

    /// Checks one call of a canonical tool. Every derived request must be allowed.
    pub fn check(&self, tool: &str, input: &Value, project_dir: &Path) -> Result<(), Denial> {
        for (perm, subject) in requests(tool, input, project_dir) {
            let (action, rule) = self.eval(perm, &subject);
            if action != Action::Allow {
                return Err(Denial {
                    profile: self.name.clone(),
                    permission: perm.into(),
                    subject,
                    action,
                    rule: rule.cloned(),
                });
            }
        }
        Ok(())
    }

    /// One line for the model: which tools (and, for narrowed tools, which patterns) work here.
    pub fn allowed_summary(&self) -> String {
        let mut items = Vec::new();
        for tool in TOOLS {
            if self.hidden(tool) {
                continue;
            }
            let perm = permission_of(tool);
            let rules: Vec<&Rule> = self.permission.iter().filter(|r| wildcard(&r.permission, perm)).collect();
            let blanket = rules.iter().rposition(|r| r.pattern == "*");
            let base = blanket.map(|i| rules[i].action).unwrap_or(Action::Ask);
            let later = &rules[blanket.map_or(0, |i| i + 1)..];
            let name = self.exposed(tool);
            if base == Action::Allow {
                let narrowed = later.iter().any(|r| r.action != Action::Allow);
                items.push(if narrowed { format!("{name} (some patterns denied)") } else { name.to_string() });
            } else {
                let mut pats: Vec<&str> = later.iter().filter(|r| r.action == Action::Allow).map(|r| r.pattern.as_str()).collect();
                pats.dedup();
                if pats.is_empty() {
                    continue;
                }
                let more = pats.len() > 12;
                pats.truncate(12);
                items.push(format!("{name} (only: {}{})", pats.join(", "), if more { ", …" } else { "" }));
            }
        }
        if items.is_empty() { "No tools are allowed in this session.".into() } else { format!("Allowed in this session: {}.", items.join("; ")) }
    }
}

/// (permission, subject) pairs one call must pass.
fn requests(tool: &str, input: &Value, dir: &Path) -> Vec<(&'static str, String)> {
    let arg = |k: &str| input[k].as_str().unwrap_or_default();
    let mut out = Vec::new();
    match tool {
        "bash" => {
            let (cmds, writes) = split_commands(arg("command"));
            if cmds.is_empty() {
                out.push(("bash", arg("command").trim().to_string()));
            }
            out.extend(cmds.into_iter().map(|c| ("bash", c)));
            for w in writes {
                path_requests(&mut out, "edit", &w, dir);
            }
        }
        "read" => path_requests(&mut out, "read", arg("filePath"), dir),
        "write" | "edit" => path_requests(&mut out, "edit", arg("filePath"), dir),
        "glob" | "grep" => {
            out.push((if tool == "glob" { "glob" } else { "grep" }, arg("pattern").to_string()));
            if let Some(p) = input["path"].as_str() {
                let abs = normalize(&dir.join(p));
                if !abs.starts_with(dir) {
                    out.push(("external_directory", abs.display().to_string()));
                }
            }
        }
        "webfetch" => out.push(("webfetch", arg("url").to_string())),
        "todowrite" => out.push(("todowrite", "*".into())),
        _ => {}
    }
    out
}

fn path_requests(out: &mut Vec<(&'static str, String)>, perm: &'static str, raw: &str, dir: &Path) {
    let abs = normalize(&dir.join(raw)); // join keeps an absolute `raw` as-is
    match abs.strip_prefix(dir) {
        Ok(rel) => out.push((perm, rel.display().to_string())),
        Err(_) => {
            let a = abs.display().to_string();
            out.push((perm, a.clone()));
            out.push(("external_directory", a));
        }
    }
}

/// Lexical normal form: `.` dropped, `..` pops (symlinks are not followed).
fn normalize(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other),
        }
    }
    out
}

/// opencode's wildcard: `*` = any run of characters (`/` included), `?` = one character,
/// anchored; a pattern ending in ` *` also matches the bare command (`git *` matches `git`).
pub fn wildcard(pattern: &str, s: &str) -> bool {
    if pattern.strip_suffix(" *").is_some_and(|head| head == s) {
        return true;
    }
    let (p, s): (Vec<char>, Vec<char>) = (pattern.chars().collect(), s.chars().collect());
    let (mut pi, mut si) = (0, 0);
    let mut star: Option<(usize, usize)> = None;
    while si < s.len() {
        if pi < p.len() && p[pi] == '*' {
            star = Some((pi, si));
            pi += 1;
        } else if pi < p.len() && (p[pi] == '?' || p[pi] == s[si]) {
            pi += 1;
            si += 1;
        } else if let Some((sp, ss)) = star {
            pi = sp + 1;
            si = ss + 1;
            star = Some((sp, ss + 1));
        } else {
            return false;
        }
    }
    p[pi..].iter().all(|&c| c == '*')
}

/// Splits a bash command into the simple commands rules are matched against, plus the
/// targets of unquoted output redirections. Quote-aware; `$(…)`, backtick, `<(…)`/`>(…)`
/// bodies are split recursively and added; heredoc bodies are data, not commands; leading
/// shell keywords and variable assignments are stripped. A guardrail, not a parser: what it
/// cannot make sense of stays in a command's text, where a narrow allow rule fails to match.
pub fn split_commands(cmd: &str) -> (Vec<String>, Vec<String>) {
    let mut sp = Splitter::default();
    sp.run(&cmd.chars().collect::<Vec<_>>());
    (sp.cmds, sp.writes)
}

#[derive(Default)]
struct Splitter {
    cmds: Vec<String>,
    writes: Vec<String>,
    cur: String,
}

impl Splitter {
    fn run(&mut self, c: &[char]) {
        let at = |i: usize| c.get(i).copied().unwrap_or('\0');
        let mut heredocs: Vec<(String, bool)> = Vec::new();
        let mut i = 0;
        while i < c.len() {
            match c[i] {
                '\\' => {
                    self.cur.extend(&c[i..(i + 2).min(c.len())]);
                    i += 2;
                }
                '\'' => {
                    let end = (i + 1..c.len()).find(|&j| c[j] == '\'').unwrap_or(c.len() - 1);
                    self.cur.extend(&c[i..=end]);
                    i = end + 1;
                }
                '"' => {
                    self.cur.push('"');
                    i += 1;
                    while i < c.len() && c[i] != '"' {
                        match c[i] {
                            '\\' => {
                                self.cur.extend(&c[i..(i + 2).min(c.len())]);
                                i += 2;
                            }
                            '$' if at(i + 1) == '(' => {
                                self.cur.push('$');
                                i = self.subst(c, i + 1, true);
                            }
                            '`' => i = self.backtick(c, i),
                            ch => {
                                self.cur.push(ch);
                                i += 1;
                            }
                        }
                    }
                    if i < c.len() {
                        self.cur.push('"');
                        i += 1;
                    }
                }
                '`' => i = self.backtick(c, i),
                '$' | '<' | '>' if at(i + 1) == '(' => {
                    self.cur.push(c[i]);
                    i = self.subst(c, i + 1, c[i] == '$');
                }
                ';' => {
                    self.end();
                    i += 1;
                }
                '\n' => {
                    self.end();
                    i += 1;
                    for (delim, strip_tabs) in heredocs.drain(..) {
                        // skip body lines up to and including the delimiter line
                        while i < c.len() {
                            let eol = (i..c.len()).find(|&j| c[j] == '\n').unwrap_or(c.len());
                            let line: String = c[i..eol].iter().collect();
                            i = eol + 1;
                            let line = if strip_tabs { line.trim_start_matches('\t') } else { &line };
                            if line.trim_end() == delim {
                                break;
                            }
                        }
                    }
                }
                '&' if at(i + 1) == '&' => {
                    self.end();
                    i += 2;
                }
                '&' if at(i + 1) == '>' => {
                    self.cur.push('&');
                    i = self.redirect(c, i + 1);
                }
                '&' => {
                    self.end();
                    i += 1;
                }
                '|' => {
                    self.end();
                    i += if matches!(at(i + 1), '|' | '&') { 2 } else { 1 };
                }
                '>' => i = self.redirect(c, i),
                '<' if at(i + 1) == '<' && at(i + 2) == '<' => {
                    // here-string: its word is data, and no lines are skipped
                    self.cur.push_str("<<<");
                    i += 3;
                }
                '<' if at(i + 1) == '<' => {
                    self.cur.push_str("<<");
                    i += 2;
                    let strip_tabs = at(i) == '-';
                    if strip_tabs {
                        self.cur.push('-');
                        i += 1;
                    }
                    let (word, next) = word_at(c, i);
                    self.cur.extend(&c[i..next]);
                    i = next;
                    if !word.is_empty() {
                        heredocs.push((word, strip_tabs));
                    }
                }
                ch => {
                    self.cur.push(ch);
                    i += 1;
                }
            }
        }
        self.end();
    }

    /// `c[i] == '('` after `$`, `<` or `>`: copies the balanced `(…)` into the current text and
    /// splits its body. `$((…))` is arithmetic, not a command (bash's rule: the inner `(` closes
    /// right before the outer `)`; otherwise it is a command substitution holding a subshell) —
    /// only the substitutions inside it are split.
    fn subst(&mut self, c: &[char], i: usize, dollar: bool) -> usize {
        let end = close_paren(c, i);
        self.cur.extend(&c[i..(end + 1).min(c.len())]);
        let body = &c[i + 1..end.min(c.len())];
        if dollar && c.get(i + 1) == Some(&'(') && end < c.len() && close_paren(c, i + 1) + 1 == end {
            self.arith(&body[1..body.len() - 1]);
        } else {
            self.nested(body);
        }
        end + 1
    }

    /// The command substitutions inside an arithmetic expression (the expression is no command).
    fn arith(&mut self, body: &[char]) {
        let mut k = 0;
        while k < body.len() {
            let mut sub = Splitter::default();
            k = match body[k] {
                '$' if body.get(k + 1) == Some(&'(') => sub.subst(body, k + 1, true),
                '`' => sub.backtick(body, k),
                _ => k + 1,
            };
            self.cmds.extend(sub.cmds);
            self.writes.extend(sub.writes);
        }
    }

    /// `c[i] == '`'`: copies through the closing backtick, splits the body.
    fn backtick(&mut self, c: &[char], i: usize) -> usize {
        let mut j = i + 1;
        while j < c.len() && c[j] != '`' {
            j += if c[j] == '\\' { 2 } else { 1 };
        }
        let end = j.min(c.len());
        self.cur.extend(&c[i..(end + 1).min(c.len())]);
        self.nested(&c[(i + 1).min(end)..end]);
        end + 1
    }

    fn nested(&mut self, body: &[char]) {
        let mut inner = Splitter::default();
        inner.run(body);
        self.cmds.extend(inner.cmds);
        self.writes.extend(inner.writes);
    }

    /// `c[i] == '>'`: an output redirection. The text stays in the command; a file target
    /// (not an fd dup, not /dev/null & co) is recorded as a write.
    fn redirect(&mut self, c: &[char], mut i: usize) -> usize {
        self.cur.push('>');
        i += 1;
        if matches!(c.get(i), Some('>') | Some('|')) {
            self.cur.push(c[i]);
            i += 1;
        }
        let dup = c.get(i) == Some(&'&');
        if dup {
            self.cur.push('&');
            i += 1;
        }
        while i < c.len() && (c[i] == ' ' || c[i] == '\t') {
            self.cur.push(c[i]);
            i += 1;
        }
        let (target, next) = word_at(c, i);
        self.cur.extend(&c[i..next]);
        let fd = dup && (target == "-" || (!target.is_empty() && target.chars().all(|ch| ch.is_ascii_digit())));
        let device = ["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty"].contains(&target.as_str()) || target.starts_with("/dev/fd/");
        if !target.is_empty() && !fd && !device {
            self.writes.push(target);
        }
        next
    }

    fn end(&mut self) {
        let text = std::mem::take(&mut self.cur);
        if let Some(cmd) = clean(&text) {
            self.cmds.push(cmd);
        }
    }
}

/// Index of the `)` closing the `(` at `c[i]` (quote-aware); `c.len()` if it never closes.
fn close_paren(c: &[char], i: usize) -> usize {
    let (mut depth, mut j, mut quote) = (0usize, i, None::<char>);
    while j < c.len() {
        let ch = c[j];
        match quote {
            Some(q) if ch == q => quote = None,
            Some(_) if ch == '\\' => j += 1,
            Some(_) => {}
            None => match ch {
                '\'' | '"' => quote = Some(ch),
                '\\' => j += 1,
                '(' => depth += 1,
                ')' => {
                    depth -= 1;
                    if depth == 0 {
                        return j;
                    }
                }
                _ => {}
            },
        }
        j += 1;
    }
    c.len()
}

/// One shell word starting at `i` (quotes removed for the value). Returns (word, next index).
fn word_at(c: &[char], mut i: usize) -> (String, usize) {
    let mut w = String::new();
    while i < c.len() {
        match c[i] {
            ' ' | '\t' | '\n' | ';' | '&' | '|' | '<' | '>' | '(' | ')' => break,
            q @ ('\'' | '"') => {
                i += 1;
                while i < c.len() && c[i] != q {
                    w.push(c[i]);
                    i += 1;
                }
                i += 1;
            }
            '\\' if i + 1 < c.len() => {
                w.push(c[i + 1]);
                i += 2;
            }
            ch => {
                w.push(ch);
                i += 1;
            }
        }
    }
    (w, i.min(c.len()))
}

/// A simple command's text with the shell grammar around it removed: leading keywords /
/// `(` `{` `!`, leading `NAME=value` assignments, a trailing ` )`/` }`. `for` headers, closers,
/// arithmetic commands and pure assignments are no command (their substitutions were split
/// already).
fn clean(text: &str) -> Option<String> {
    const LEAD: [&str; 10] = ["then", "else", "elif", "do", "if", "while", "until", "time", "!", "{"];
    let mut s = text.trim();
    if s.starts_with("((") {
        return None; // an arithmetic command; substitutions inside it were split already
    }
    let mut opened = 0; // subshell `(`s stripped in front; their `)`s come off the end
    loop {
        let before = s;
        if let Some(rest) = s.strip_prefix('(') {
            s = rest.trim_start();
            opened += 1;
        }
        for kw in LEAD {
            if let Some(rest) = s.strip_prefix(kw)
                && (rest.is_empty() || rest.starts_with(char::is_whitespace))
            {
                s = rest.trim_start();
            }
        }
        s = strip_assignment(s).trim_start();
        if s == before {
            break;
        }
    }
    let mut s = s.trim_end();
    for _ in 0..opened {
        if let Some(rest) = s.strip_suffix(')') {
            s = rest.trim_end();
        }
    }
    while let Some(rest) = s.strip_suffix(" )").or_else(|| s.strip_suffix(" }")) {
        s = rest.trim_end();
    }
    let first = s.split_whitespace().next().unwrap_or("");
    // `for` headers are data (their substitutions were split already); `case` arms are NOT
    // dropped — `case $x in a) rm f;;` keeps `rm f` inside a command a narrow rule refuses
    if s.is_empty() || matches!(first, "fi" | "done" | "esac" | "}" | ")" | "for") {
        return None;
    }
    Some(s.to_string())
}

/// Drops one leading `NAME=value` (value: quotes and `$(…)` balanced) if present.
fn strip_assignment(s: &str) -> &str {
    let name_end = s.find(|c: char| !(c.is_ascii_alphanumeric() || c == '_')).unwrap_or(s.len());
    if name_end == 0 || s.as_bytes()[0].is_ascii_digit() {
        return s;
    }
    let rest = &s[name_end..];
    let Some(value) = rest.strip_prefix("+=").or_else(|| rest.strip_prefix('=')) else { return s };
    let (mut depth, mut quote) = (0i32, None::<char>);
    for (i, ch) in value.char_indices() {
        match quote {
            Some(q) if ch == q => quote = None,
            Some(_) => {}
            None => match ch {
                '\'' | '"' | '`' => quote = Some(ch),
                '(' => depth += 1,
                ')' => depth -= 1,
                c if c.is_whitespace() && depth <= 0 => return &value[i..],
                _ => {}
            },
        }
    }
    ""
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(permission: &str, pattern: &str, action: Action) -> Rule {
        Rule { permission: permission.into(), pattern: pattern.into(), action }
    }

    fn profile(rules: Vec<Rule>) -> Profile {
        Profile { name: "t".into(), description: None, mode: primary(), permission: rules, overrides: BTreeMap::new() }
    }

    fn coordinator() -> Profile {
        use Action::*;
        profile(vec![
            rule("*", "*", Deny),
            rule("read", "*", Allow),
            rule("glob", "*", Allow),
            rule("grep", "*", Allow),
            rule("bash", "curl *127.0.0.1:*", Allow),
            rule("bash", "sleep *", Allow),
            rule("bash", "echo *", Allow),
            rule("bash", "curl * -o *", Deny),
        ])
    }

    const DIR: &str = "/proj";

    fn check(p: &Profile, tool: &str, input: Value) -> Result<(), Denial> {
        p.check(tool, &input, Path::new(DIR))
    }

    #[test]
    fn wildcard_semantics() {
        assert!(wildcard("*", ""));
        assert!(wildcard("*", "a/b/c"));
        assert!(wildcard("*.env", "/x/y/.env"));
        assert!(!wildcard("*.env", "/x/y/.env.example"));
        assert!(wildcard("docs/*", "docs/a/b.md"));
        assert!(!wildcard("docs/*", "src/docs/a.md"));
        assert!(wildcard("git *", "git"));
        assert!(wildcard("git *", "git status"));
        assert!(!wildcard("git *", "gitk"));
        assert!(wildcard("a?c", "abc"));
        assert!(!wildcard("a?c", "ac"));
        assert!(wildcard("curl *127.0.0.1:*", "curl -s http://127.0.0.1:4121/session"));
        assert!(wildcard("é*", "été"));
        assert!(wildcard("*", "**/*.rs"), "a literal * in the subject is just a character");
        assert!(!wildcard("a*", "*a"));
    }

    #[test]
    fn last_match_wins_and_unlisted_is_ask() {
        use Action::*;
        let p = profile(vec![rule("*", "*", Allow), rule("read", "*.env", Deny), rule("read", "*.env.example", Allow)]);
        assert!(check(&p, "read", json!({"filePath": "a.txt"})).is_ok());
        assert_eq!(check(&p, "read", json!({"filePath": "x/.env"})).unwrap_err().action, Deny);
        assert!(check(&p, "read", json!({"filePath": "x/.env.example"})).is_ok());
        let empty = profile(vec![]);
        let d = check(&empty, "read", json!({"filePath": "a"})).unwrap_err();
        assert_eq!(d.action, Ask);
        assert!(d.rule.is_none());
        assert!(d.message("").contains("needs approval"));
    }

    #[test]
    fn default_profile_allows_everything_and_hides_nothing() {
        let b = Profiles::builtin();
        let p = b.resolve(None).unwrap();
        for t in TOOLS {
            assert!(!p.hidden(t));
        }
        let all = json!([{ "type": "function", "function": { "name": "bash" } }, { "type": "function", "function": { "name": "read" } }]);
        assert_eq!(p.declare(&all).unwrap(), all);
        assert!(check(p, "bash", json!({"command": "sed -i s/a/b/ x && rm -rf /tmp/x > /etc/passwd"})).is_ok());
        assert!(check(p, "write", json!({"filePath": "/etc/x", "content": ""})).is_ok());
    }

    #[test]
    fn write_and_edit_share_the_edit_permission() {
        let p = profile(vec![rule("*", "*", Action::Allow), rule("edit", "*", Action::Deny)]);
        assert!(p.hidden("write") && p.hidden("edit") && !p.hidden("read"));
        assert_eq!(check(&p, "write", json!({"filePath": "a"})).unwrap_err().permission, "edit");
    }

    #[test]
    fn hidden_follows_opencode_disabled() {
        let p = coordinator();
        for t in ["write", "edit", "webfetch", "todowrite"] {
            assert!(p.hidden(t), "{t}");
        }
        for t in ["read", "glob", "grep", "bash"] {
            assert!(!p.hidden(t), "{t}");
        }
        let zero = profile(vec![rule("*", "*", Action::Deny)]);
        let all = json!([{ "type": "function", "function": { "name": "bash" } }]);
        assert!(zero.declare(&all).is_none());
    }

    #[test]
    fn bash_segments_all_must_pass() {
        let p = coordinator();
        assert!(check(&p, "bash", json!({"command": "curl -s http://127.0.0.1:4121/session"})).is_ok());
        let d = check(&p, "bash", json!({"command": "curl -s http://127.0.0.1:4121/session && sed -i s/a/b/ x.md"})).unwrap_err();
        assert_eq!(d.subject, "sed -i s/a/b/ x.md");
        assert!(check(&p, "bash", json!({"command": "curl -s https://example.com"})).is_err());
        assert!(check(&p, "bash", json!({"command": "curl -s http://127.0.0.1:1/x -o out.json"})).is_err());
        // a polling loop of allowed commands passes; assignments and keywords are grammar
        let poll = "for i in $(seq 1 3); do st=$(curl -s http://127.0.0.1:4121/session/x); echo \"$st\"; sleep 2; done";
        let d = check(&p, "bash", json!({"command": poll})).unwrap_err();
        assert_eq!(d.subject, "seq 1 3"); // only the loop list's command is outside the profile
        let poll2 = "while true; do st=$(curl -s http://127.0.0.1:4121/s); echo \"$st\"; sleep 2; done";
        assert_eq!(check(&p, "bash", json!({"command": poll2})).unwrap_err().subject, "true");
    }

    #[test]
    fn splitter_shapes() {
        let (c, w) = split_commands("a | b && c || d; e & f\ng");
        assert_eq!(c, ["a", "b", "c", "d", "e", "f", "g"]);
        assert!(w.is_empty());
        let (c, _) = split_commands("echo 'x; y | z' \"a && b\"");
        assert_eq!(c, ["echo 'x; y | z' \"a && b\""]);
        let (c, _) = split_commands("echo $(sed -i s/a/b/ f) `rm x`");
        assert_eq!(c, ["sed -i s/a/b/ f", "rm x", "echo $(sed -i s/a/b/ f) `rm x`"]);
        let (c, _) = split_commands("echo \"$(cat f | wc -l)\"");
        assert_eq!(c, ["cat f", "wc -l", "echo \"$(cat f | wc -l)\""]);
        let (c, _) = split_commands("diff <(sort a) <(sort b)");
        assert_eq!(c, ["sort a", "sort b", "diff <(sort a) <(sort b)"]);
        let (c, _) = split_commands("FOO=1 BAR=\"x y\" cmd arg");
        assert_eq!(c, ["cmd arg"]);
        let (c, _) = split_commands("( cd x; make )");
        assert_eq!(c, ["cd x", "make"]);
        let (c, _) = split_commands("if [ -f x ]; then cat x; else echo no; fi");
        assert_eq!(c, ["[ -f x ]", "cat x", "echo no"]);
        let (c, _) = split_commands("x=$(curl -s u)");
        assert_eq!(c, ["curl -s u"]);
    }

    #[test]
    fn arithmetic_is_no_command() {
        let (c, _) = split_commands("echo $((1+2))");
        assert_eq!(c, ["echo $((1+2))"]);
        let (c, _) = split_commands("echo \"$t -> $(date -u -d @$((t/1000)) '+%F')\"");
        assert_eq!(c, ["date -u -d @$((t/1000)) '+%F'", "echo \"$t -> $(date -u -d @$((t/1000)) '+%F')\""]);
        let (c, _) = split_commands("echo $(( ($(date +%s) - 5) / 60 ))");
        assert_eq!(c, ["date +%s", "echo $(( ($(date +%s) - 5) / 60 ))"]);
        let (c, _) = split_commands("(( n = $(wc -l < f) + 1 )); echo $n");
        assert_eq!(c, ["wc -l < f", "echo $n"]);
        // `$((` that is not arithmetic (bash: a command substitution holding a subshell)
        let (c, _) = split_commands("echo $((rm -f x) ; (ls))");
        assert_eq!(c, ["rm -f x", "ls", "echo $((rm -f x) ; (ls))"]);
        // the live trace that tripped the first battery (tool-scope, 10-28)
        let p = coordinator();
        let poll = "now=1793209990543; for t in 179 178; do echo \"$t -> $(date -u -d @$((t/1000)) '+%F %T') (age: $(( (now - t) / 3600000 ))h)\"; done";
        let mut q = p.clone();
        q.permission.push(rule("bash", "date *", Action::Allow));
        assert!(check(&q, "bash", json!({"command": poll})).is_ok(), "{:?}", split_commands(poll));
        let (c, _) = split_commands("case $x in a) rm f;; esac");
        assert_eq!(c, ["case $x in a) rm f"], "a case arm stays inside a command (fail closed)");
    }

    #[test]
    fn splitter_never_panics() {
        const A: [char; 16] = ['a', ' ', '$', '(', ')', '`', '\'', '"', '\\', '<', '>', '&', '|', ';', '\n', '-'];
        let mut buf = String::new();
        for n in 0..=4u32 {
            for mut k in 0..16usize.pow(n) {
                buf.clear();
                for _ in 0..n {
                    buf.push(A[k % 16]);
                    k /= 16;
                }
                let (cmds, _) = split_commands(&buf);
                assert!(cmds.iter().all(|c| !c.trim().is_empty()), "{buf:?} -> {cmds:?}");
            }
        }
        let mut x: u64 = 0x9e3779b97f4a7c15;
        for _ in 0..20_000 {
            buf.clear();
            for _ in 0..(x % 48) {
                x ^= x << 13;
                x ^= x >> 7;
                x ^= x << 17;
                buf.push(A[(x % 16) as usize]);
            }
            split_commands(&buf);
        }
    }

    #[test]
    fn redirections_are_edits() {
        let (_, w) = split_commands("curl -s u > docs/x.md 2>&1; echo a >> log.txt; cmd &> all.txt; x > /dev/null; y 2>/dev/null >&2");
        assert_eq!(w, ["docs/x.md", "log.txt", "all.txt"]);
        let (_, w) = split_commands("curl -d '{\"t\":\"a -> b\"}' u; echo \"x > y\"");
        assert!(w.is_empty(), "quoted > is no redirection: {w:?}");
        let (c, w) = split_commands("cat > f.md <<'EOF'\nline; rm -rf /\nEOF\necho done");
        assert_eq!(w, ["f.md"]);
        assert_eq!(c, ["cat > f.md <<'EOF'", "echo done"]);
        let (c, _) = split_commands("cat <<< x\nsed -i y z\nx");
        assert_eq!(c, ["cat <<< x", "sed -i y z", "x"], "a here-string hides no lines");
        let (c, _) = split_commands("cat <<-EOF\n\tbody\n\tEOF\nrm f");
        assert_eq!(c, ["cat <<-EOF", "rm f"]);
        let (c, _) = split_commands("cat <<EOF\nnever closed; rm f");
        assert_eq!(c, ["cat <<EOF"], "an unclosed heredoc swallows the rest (bash does too)");
        let mut p = coordinator();
        p.permission.push(rule("bash", "cat *", Action::Allow));
        let d = check(&p, "bash", json!({"command": "cat > docs/brand.md <<EOF\nfixed\nEOF"})).unwrap_err();
        assert_eq!((d.permission.as_str(), d.subject.as_str()), ("edit", "docs/brand.md"));
        let d = check(&p, "bash", json!({"command": "curl -s http://127.0.0.1:9/x > /tmp/out.json"})).unwrap_err();
        assert_eq!(d.permission, "edit");
        p.permission.push(rule("edit", "/tmp/*", Action::Allow));
        p.permission.push(rule("external_directory", "/tmp/*", Action::Allow));
        assert!(check(&p, "bash", json!({"command": "curl -s http://127.0.0.1:9/x > /tmp/out.json"})).is_ok());
    }

    #[test]
    fn paths_normalize_and_external_directory() {
        use Action::*;
        let p = profile(vec![rule("*", "*", Deny), rule("read", "docs/*", Allow), rule("edit", "docs/*", Allow)]);
        assert!(check(&p, "read", json!({"filePath": "docs/a.md"})).is_ok());
        assert!(check(&p, "read", json!({"filePath": "/proj/docs/a.md"})).is_ok());
        assert!(check(&p, "read", json!({"filePath": "docs/../src/main.rs"})).is_err());
        let d = check(&p, "read", json!({"filePath": "docs/../../etc/passwd"})).unwrap_err();
        assert_eq!(d.subject, "/etc/passwd");
        let open = profile(vec![rule("*", "*", Allow), rule("external_directory", "*", Deny)]);
        assert_eq!(check(&open, "write", json!({"filePath": "/etc/x"})).unwrap_err().permission, "external_directory");
        assert!(check(&open, "write", json!({"filePath": "a/b"})).is_ok());
        assert!(check(&open, "grep", json!({"pattern": "x", "path": "/etc"})).is_err());
        assert!(check(&open, "glob", json!({"pattern": "**/*.rs"})).is_ok());
    }

    #[test]
    fn args_patterns_for_other_tools() {
        use Action::*;
        let p = profile(vec![rule("*", "*", Allow), rule("webfetch", "*", Deny), rule("webfetch", "https://docs.rs/*", Allow), rule("grep", "*password*", Deny)]);
        assert!(check(&p, "webfetch", json!({"url": "https://docs.rs/axum"})).is_ok());
        assert!(check(&p, "webfetch", json!({"url": "https://evil.example"})).is_err());
        assert!(check(&p, "grep", json!({"pattern": "password ="})).is_err());
    }

    #[test]
    fn override_renames_and_maps_back() {
        let mut p = profile(vec![rule("*", "*", Action::Allow)]);
        p.overrides.insert("bash".into(), Override { name: Some("shell".into()), description: Some("run it".into()) });
        let all = json!([{ "type": "function", "function": { "name": "bash", "description": "x" } },
                         { "type": "function", "function": { "name": "read", "description": "y" } }]);
        let d = p.declare(&all).unwrap();
        assert_eq!(d[0]["function"]["name"], "shell");
        assert_eq!(d[0]["function"]["description"], "run it");
        assert_eq!(d[1]["function"]["name"], "read");
        assert_eq!(p.canonical("shell"), Some("bash"));
        assert_eq!(p.canonical("bash"), None);
        assert_eq!(p.canonical("read"), Some("read"));
        assert_eq!(p.canonical("nosuch"), Some("nosuch"));
    }

    #[test]
    fn parse_validates() {
        let ok = br#"{"default_agent":"lead","agent":{
            "build":{"permission":[{"permission":"*","pattern":"*","action":"allow"}]},
            "lead":{"description":"d","permission":[{"permission":"*","pattern":"*","action":"deny"},
                    {"permission":"doom_loop","pattern":"*","action":"ask"}],
                    "override":{"bash":{"name":"shell"}}}}}"#;
        let (ps, warn) = Profiles::parse(ok).unwrap();
        assert_eq!(ps.default, "lead");
        assert_eq!(warn.len(), 1, "doom_loop enforces nothing: {warn:?}");
        let list = ps.list();
        assert_eq!(list.as_array().unwrap().len(), 2);
        assert!(list.as_array().unwrap().iter().any(|p| p["name"] == "lead" && p["default"] == true && p["override"]["bash"]["name"] == "shell"));
        assert!(ps.resolve(Some("nope")).is_err());
        for bad in [
            &br#"{"agent":{"x":{"permission":[]}}}"#[..],                                                   // no default
            br#"{"default_agent":"y","agent":{"x":{"permission":[]}}}"#,                                    // default unknown
            br#"{"agent":{"build":{"permission":[{"permission":"*","pattern":"*","action":"maybe"}]}}}"#, // bad action
            br#"{"agent":{"build":{"permission":[],"override":{"nosuch":{"name":"x"}}}}}"#,                // unknown tool
            br#"{"agent":{"build":{"permission":[],"override":{"bash":{"name":"read"}}}}}"#,               // name collision
            br#"{"agent":{"bad name":{"permission":[]}}}"#,
            br#"{"agent":{"build":{}}}"#,                                                                   // permission required
            br#"{"agents":{}}"#,
        ] {
            assert!(Profiles::parse(bad).is_err(), "{}", String::from_utf8_lossy(bad));
        }
    }

    #[test]
    fn summary_and_message_tell_the_model_what_works() {
        let p = coordinator();
        let s = p.allowed_summary();
        assert_eq!(s, "Allowed in this session: bash (only: curl *127.0.0.1:*, sleep *, echo *); read; glob; grep.");
        let d = check(&p, "edit", json!({"filePath": "docs/a.md", "oldString": "a", "newString": "b"})).unwrap_err();
        let m = d.message(&s);
        assert!(m.starts_with("Permission denied by profile \"t\": edit `docs/a.md` is denied"), "{m}");
        assert!(m.contains("pattern: \"*\", action: \"deny\""), "{m}");
        assert!(m.ends_with(&s));
        assert_eq!(d.to_json()["rule"]["action"], "deny");
        assert_eq!(profile(vec![rule("*", "*", Action::Deny)]).allowed_summary(), "No tools are allowed in this session.");
    }
}
