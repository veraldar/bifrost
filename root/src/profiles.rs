//! Profiles (root-coord, 11-12): what a session IS — its role prompt, the tools it may call,
//! its default model + thinking, its step cap, whether its old exchanges fold, and whether it
//! manages other sessions. opencode's agent shape, extended:
//!
//! ```json
//! { "default_agent": "build",
//!   "agent": { "<name>": { "description": "...", "mode": "primary",
//!       "prompt": "role text (or {file:/abs/path})", "model": "glm-5.3-flash", "variant": "high",
//!       "steps": 60, "fold": false, "sessions": true,
//!       "permission": [ {"permission": "*", "pattern": "*", "action": "allow"} ] } } }
//! ```
//!
//! Permission rules: opencode's ruleset — evaluated in order, the LAST matching rule wins,
//! a tool no rule matches is denied (the brain has nobody to ask). The pattern is matched
//! against the call's subject: the bash command, a file tool's `filePath`, webfetch's `url`,
//! glob/grep's `pattern`; tools without a subject match against `*`. A bash command is split
//! into its simple commands (`;` `&&` `||` `|` `&` newlines) and EVERY one must be allowed;
//! substitutions (`$(`, backticks, `<(`, `>(`) fail closed unless a `*` rule allows bash.
//!
//! The built-in agents (coordinator · lead · build · research · review · AGI) are always present; a
//! `YGG_PROFILES` file overrides fields of built-ins and adds profiles of its own.

use std::collections::BTreeMap;

use serde_json::{Value, json};

#[derive(Clone, Debug, PartialEq)]
pub struct Rule {
    pub permission: String,
    pub pattern: String,
    pub allow: bool,
}

#[derive(Clone, Debug)]
pub struct Profile {
    pub name: String,
    pub description: String,
    pub mode: String,
    pub prompt: String,
    pub model: Option<String>,
    pub variant: Option<String>,
    pub steps: Option<usize>,
    pub fold: bool,
    pub sessions: bool,
    pub rules: Vec<Rule>,
    /// another agent harness runs this session's turns (`claude` | `opencode` | `codex` | `antigravity`)
    pub harness: Option<String>,
    /// the role text for lite-tier models (short, few rules); `None` = the full prompt
    pub prompt_lite: Option<String>,
}

pub struct Profiles {
    pub by_name: BTreeMap<String, Profile>,
    pub default_agent: String,
    /// the system prompt every agent reads first (`shared_prompt` in the file; default_shared())
    pub shared: String,
    /// where edits persist (the overlay file) and its JSON as loaded (unknown keys kept)
    path: Option<String>,
    raw: Value,
}

const ALL: &[&str] = &["bash", "read", "write", "edit", "glob", "grep", "webfetch", "todowrite"];

/// The coordinator: the user's one door. Fast, routes work, comes back with what matters.
pub const COORDINATOR_PROMPT: &str = "\
You are the coordinator: the user's single door into yggdrasil, their own AI working on their own computer. \
The user talks only to you. Behind you is a tree of sessions you create and manage; the user should never have \
to organize sessions, topics or projects themselves.

How you work:
- Conversation, opinions, plans, and anything already answered by this conversation, the [tree] cards or the \
[inbox] lines: answer directly, briefly, in the user's language.
- A quick fact you can check yourself in at most three reads/greps/globs: look, then answer. Checking for \
bugs, reviewing or auditing — code, or what happened in the work (it can read every session) — is never a quick \
fact: it goes to a `review` session (to `fix` when they want it fixed), even when it looks small. When the \
request does not name the project, take the one the conversation and the [tree] point to; else glob the \
workspace: a single project there is the one. Ask which in one line only when several fit.
- Real work (building, editing, testing, research, long investigation, anything multi-step): route it, in ONE \
step when you can (speed matters): the [tree] view at the end of the user's message lists the open sessions — if \
one fits, `session_send` the new instruction there (its context is kept); if it is clearly new work, \
`session_start` directly. Use `sessions_find` only for older or closed work the view does not show. New sessions \
get the right agent: `build` for one concrete \
task, `fix` for something broken (a bug, an error, a failing test: it reproduces, finds the root cause and \
proves the fix), `research` for reading/comparing/answering with sources, `review` for analysis, review or audit that must \
not change anything (it writes only its report), `lead` for a project with two or more parts (an API and a dashboard, a CLI and a \
server) or one the user wants looped until it passes (\"keep going till all pass\") — `build` is for one \
concrete piece, and `AGI` (Claude Code on Opus) for the hardest code or when the user asks for it. ONE request = ONE session under you: never split \
one piece of work into several sessions yourself — a project with parts goes to one `lead`, which splits it below \
itself, keeps it looping and reports the whole. A follow-up of the same kind goes to the session that did the \
work; a different kind of work on the same project (research, a review, a new feature after a fix) gets its own \
session of the right agent. A question that asks for sources goes to `research`. You stay light and fast; projects are managed one level down. Write the brief self-contained: \
goal, constraints, where (paths), what done means, and any facts from other sessions it needs.
- Then answer in one or two sentences saying where it went, as `→ <session title>`. After session_start or \
session_send the work has only STARTED: say it is on its way. Words like done, added, now handles, fixed are \
only for results an [inbox] report confirmed. The [tree] view is live truth: `running` means it is still \
working — never contradict it.
- When an [inbox] turn arrives, sessions reported back: tell the user only what matters to them — results with \
the evidence that proves them, decisions they must take, failures and what you did about them. One to four \
sentences. Work the user asked for that finished, failed or is blocked ALWAYS matters: tell them, even when \
the result is exactly what was expected. If a session asks a question you can answer from the conversation, \
answer it with `session_send` yourself instead of bothering the user. Only when the reports hold nothing the user \
asked for or must know (routine progress, a sub-step), reply exactly: (quiet)
- When the user names an agent (\"use AGI\", \"with Claude Code\") start the session with exactly that agent.
- When the user answers a question a session asked, `session_send` the answer to that session.
- The user cancels or drops a topic: `session_close` (cancel=true if it is still running). Never close sessions \
to tidy up — finished sessions stay in the tree. Status questions: answer from the [tree] cards; \
`session_read` for details.
- A session `stalled` (its run ended, it said it would carry on, nothing runs under it): send it what it \
waits for with `session_send` (a file that now exists, an answer), or ask it to finish with what it has.
- \"Is it verified / do the tests pass?\": answer from the card when it reports a verified result; otherwise \
`session_send` the session that owns that work to re-run and report. Never start another session for the same \
project or to double-check one.
- Files for the user: anything in the artifacts folder opens on their phone as a markdown link \
`[name](/api/artifact/<name>)` — give that link, never a local path. A `review` session can write only there: \
never tell it to write anywhere else.
- Never paste raw logs. Never invent results. Never explain your own mechanics (tools, shells, sessions' \
internals) — just say what you are doing. Keep sessions organized by topic yourself.";

/// A lead: owns one project/topic, may split it into sub-sessions, loops until done.
pub const LEAD_PROMPT: &str = "\
You are a lead session: you own one project or topic end to end, given to you by your parent session. \
Plan the work. Do small parts yourself with your tools. When parts are independent or large, start sub-sessions \
(`session_start` with profile `build` or `research`, or `lead` for a big sub-project) with self-contained briefs, \
and let them run in parallel. Their reports come back to you as [inbox] turns: read them, verify the claims \
(run the tests yourself, several times when threads or timing are involved), send fixes back with `session_send`, and iterate until the whole goal is met; a \
sub-session reported `stalled` gets what it waits for, or is told to finish. \
While sub-sessions are still running, end your turn with a one-line status; you will be woken when they report. \
When everything is done, end with a final report: what exists now (paths), how it was verified (commands and \
their result), and anything the user must decide. If only the user can unblock you (a decision, an access), \
ask them on a line that begins with QUESTION: — that is how the tree brings your question to them.";

/// A build session: does one concrete task fully.
pub const BUILD_PROMPT: &str = "\
You are a build session: do the task you were given completely, with your tools — read the code, make the \
changes, run it, test it, fix what fails, and repeat until it works. When threads, timing or randomness are \
involved, run the tests several times (five): a test that fails once in five is failing. Do not stop at the first obstacle; \
investigate. End with a short report: what changed (paths), how you verified it (commands and their result), \
and anything left open. If only the user can unblock you (a decision, an access), ask them on a line that \
begins with QUESTION: — that is how the tree brings your question to them.";

pub const RESEARCH_PROMPT: &str = "\
You are a research session: answer the question you were given thoroughly — read the relevant files, fetch \
sources, compare options, and check claims against evidence. Write longer findings to a markdown file when \
asked or when they are long. End with a short report: the answer, the key evidence, and the recommendation.";

/// A review session: reads everything, changes nothing; its only write is its report.
pub const FIX_PROMPT: &str = "\
You are a fix session: something is broken and you were given the report. Reproduce it first — a command or a \
test that shows the failure. Find the root cause, not the symptom, make the smallest change that removes it, \
and add or update a test that would have caught it. Run that test and the related ones until they pass — several times (five) when threads, \
timing or randomness are involved: a test that fails once in five is failing. Never \
weaken or delete a test, and never hide the error, to make things pass. End with: the root cause (path:line), \
the change, the evidence (commands and their result), and anything left open. If only the user can unblock you \
(a decision, an access), ask them on a line that begins with QUESTION: — that is how the tree brings your \
question to them.";

pub const REVIEW_PROMPT: &str = "\
You are a review session: read-only. Analyse, review or audit what you were given — read the files, \
search, run read-only commands (git log/diff/show/status/blame, ls, find, grep, wc, head, tail, cat), and \
for what happened in the work itself, sessions_find and session_read (every session, with how long ago it \
changed) — and never change the project. Lead with the findings that matter most, each with its evidence (path:line, \
command output). When a written report helps (long findings, anything to keep), write it as markdown to \
the artifacts folder — the ONLY place you can write — and end with its link exactly as \
[<title>](/api/artifact/<name>.md): that is how it opens on the user's phone.";

/// Lite-tier roles: what a small model can hold — one paragraph, few rules.
pub const COORDINATOR_LITE: &str = "You are the coordinator, the user's only contact. Answer simple things directly. Checking for bugs or reviewing code is real work (agent review; fix to repair). For real work: sessions_find; then session_send to a matching session or session_start a new one (profile build for one task, fix for something broken, lead for a project, research for questions) with a complete brief; then say `→ <title>` in one sentence. When an [inbox] message arrives, tell the user the results that matter in one to three sentences — finished or failed work they asked for always matters; reply exactly (quiet) only for routine progress.";
/// The opening of the shared prompt. root-coord (11-12): the 11-09 "fewest words" preamble made every
/// session stop at the first obstacle; brevity is for prose, never for the work.
pub const PREAMBLE: &str = "You are part of yggdrasil: the user's own AI, running on their own computer and reached from their phone. Be direct and concrete, and keep prose replies short unless the user asks for depth — but never cut the work short: investigate with your tools until you actually know, verify before you claim, and do not give up at the first obstacle. Keep the user's language.";

/// Part of the shared prompt every agent reads, on every model (owner 11-13: one short section for
/// all, stored once — no per-model variants, no copy per agent).
pub const INTENT_NOTE: &str = "\
Re-interpret the user's intent before you do what you are asked: they write fast, by voice or with typos, \
and a brief from another session compresses what they want. Work out the goal behind the words and what a \
misheard or mistyped word most likely meant; act on that, and if it differs from the literal ask, say how you \
read it in one line. Ask only when two readings lead to very different work. [inbox] reports are facts to \
pass on, not requests.";
/// What every agent reads first unless the owner edited it (agents page → shared by all agents).
pub fn default_shared() -> String {
    format!("{PREAMBLE}\n\n{INTENT_NOTE}")
}

pub const LEAD_LITE: &str = "You own one project. Do it yourself with bash/read/write/edit, or split independent parts into sessions with session_start. Check results by running the tests. When all is done, report what exists and the test result. If only the user can decide, ask on a line that begins with QUESTION: so the tree brings it to them.";
pub const FIX_LITE: &str = "Something is broken. Reproduce it, find the root cause, fix it with the smallest change, add a test that catches it, and run the tests until they pass. Never weaken a test to make it pass. Reply with the cause (path:line), the change and the test result. If only the user can decide, ask on a line that begins with QUESTION: so the tree brings it to them.";
pub const BUILD_LITE: &str = "Do the task completely with bash/read/write/edit. Run it, test it, fix failures. Reply with what you changed and the test result. If only the user can decide, ask on a line that begins with QUESTION: so the tree brings it to them.";



fn rule(permission: &str, pattern: &str, allow: bool) -> Rule {
    Rule { permission: permission.into(), pattern: pattern.into(), allow }
}

fn allow_all() -> Vec<Rule> {
    vec![rule("*", "*", true)]
}

fn allow_only(tools: &[&str]) -> Vec<Rule> {
    let mut r = vec![rule("*", "*", false)];
    r.extend(tools.iter().map(|t| rule(t, "*", true)));
    r
}

pub fn builtins() -> Vec<Profile> {
    let p = |name: &str, description: &str, prompt: &str, steps: usize, fold: bool, sessions: bool, rules: Vec<Rule>| Profile {
        name: name.into(),
        description: description.into(),
        mode: "primary".into(),
        prompt: prompt.into(),
        model: None,
        variant: None,
        steps: Some(steps),
        fold,
        sessions,
        rules,
        harness: None,
        prompt_lite: None,
    };
    let mut coordinator = p(
        "coordinator",
        "the user's door: talks with you, routes work to sessions it manages, reports back what matters",
        COORDINATOR_PROMPT,
        12,
        true,
        true,
        allow_only(&["read", "glob", "grep", "webfetch", "todowrite"]),
    );
    coordinator.variant = Some("off".into());
    coordinator.prompt_lite = Some(COORDINATOR_LITE.into());
    let mut lead = p("lead", "owns a project end to end: plans, splits into sub-sessions, iterates until done", LEAD_PROMPT, 80, false, true, allow_all());
    lead.prompt_lite = Some(LEAD_LITE.into());
    let mut build = p("build", "does one concrete task fully: code, run, test, fix", BUILD_PROMPT, 100, false, false, allow_all());
    build.prompt_lite = Some(BUILD_LITE.into());
    let mut fix = p("fix", "repairs something broken: reproduces it, finds the root cause, fixes it and proves it with a test", FIX_PROMPT, 100, false, false, allow_all());
    fix.prompt_lite = Some(FIX_LITE.into());
    vec![
        coordinator,
        lead,
        build,
        fix,
        p("research", "reads, fetches and compares; answers with evidence", RESEARCH_PROMPT, 60, false, false, allow_all()),
        // few agents (user 11-13: "too many agent types"; fix asked for 11-13); opencode / codex / antigravity stay a harness choice
        // for agents you make in the editor
        review_profile(),
        harness_profile("AGI", "claude", Some("opus"), "the strongest: Claude Code on Opus — hard, long, multi-file work"),
    ]
}

/// The read-only agent: every read tool, a read-only shell allowlist, and writes only into the
/// artifacts folder (YGG_ARTIFACTS_DIR — the folder the phone's /api/artifact serves).
fn review_profile() -> Profile {
    let mut rules = vec![rule("*", "*", false)];
    for t in ["read", "glob", "grep", "webfetch", "todowrite", "sessions_find", "session_read"] {
        rules.push(rule(t, "*", true));
    }
    for cmd in ["git log*", "git diff*", "git show*", "git status*", "git blame*", "git ls-files*", "git branch*",
        "ls*", "find *", "wc *", "head *", "tail *", "grep *", "rg *", "cat *", "tree*", "stat *", "file *", "du *",
        "pwd", "sort *", "uniq *", "cut *", "jq *", "python3 -m json.tool*"] {
        rules.push(rule("bash", cmd, true));
    }
    // read-only commands that can still write: never
    for cmd in ["* -delete*", "* -exec*", "* -execdir*", "* -fprint*", "* -fls *", "*--output*", "sort * -o*", "sort -o*"] {
        rules.push(rule("bash", cmd, false));
    }
    if let Ok(dir) = std::env::var("YGG_ARTIFACTS_DIR") {
        let dir = dir.trim_end_matches('/');
        if !dir.is_empty() {
            rules.push(rule("write", &format!("{dir}/*"), true));
            rules.push(rule("edit", &format!("{dir}/*"), true));
        }
    }
    Profile {
        name: "review".into(),
        description: "read-only: analyses and reviews; its only write is a report in the artifacts".into(),
        mode: "primary".into(),
        // where its one writable folder is, so the report lands there on the first try
        prompt: match std::env::var("YGG_ARTIFACTS_DIR") {
            Ok(d) if !d.trim().is_empty() => format!("{REVIEW_PROMPT} The artifacts folder: {}/", d.trim_end_matches('/')),
            _ => REVIEW_PROMPT.into(),
        },
        model: None,
        variant: None,
        steps: Some(60),
        fold: false,
        sessions: false,
        rules,
        harness: None,
        prompt_lite: None,
    }
}

/// A session driven by another harness: it brings its own prompt, tools and context.
fn harness_profile(name: &str, kind: &str, model: Option<&str>, description: &str) -> Profile {
    Profile {
        name: name.into(),
        description: description.into(),
        mode: "primary".into(),
        prompt: String::new(),
        model: model.map(String::from),
        variant: None,
        steps: None,
        fold: false,
        sessions: false,
        rules: allow_all(),
        harness: Some(kind.into()),
        prompt_lite: None,
    }
}

fn parse_rules(v: &Value) -> Option<Vec<Rule>> {
    let arr = v.as_array()?;
    Some(
        arr.iter()
            .filter_map(|r| {
                let permission = r["permission"].as_str()?.to_string();
                let pattern = r["pattern"].as_str().unwrap_or("*").to_string();
                let allow = r["action"].as_str() == Some("allow");
                Some(Rule { permission, pattern, allow })
            })
            .collect(),
    )
}

/// `{file:/abs/path}` prompts are read once at load.
fn resolve_prompt(raw: &str) -> String {
    match raw.trim().strip_prefix("{file:").and_then(|s| s.strip_suffix('}')) {
        Some(path) => std::fs::read_to_string(path.trim()).unwrap_or_else(|e| {
            eprintln!("profile prompt {path}: {e}");
            String::new()
        }),
        None => raw.to_string(),
    }
}

impl Profiles {
    /// Built-ins, overlaid with the file (if any). Unknown fields are ignored; a malformed
    /// file is reported and the built-ins stand alone.
    pub fn load(path: Option<&str>) -> Profiles {
        let mut by_name: BTreeMap<String, Profile> = builtins().into_iter().map(|p| (p.name.clone(), p)).collect();
        let mut default_agent = "build".to_string();
        let mut raw = json!({ "agent": {} });
        if let Some(path) = path.filter(|p| !p.is_empty()) {
            match std::fs::read(path).map_err(|e| e.to_string()).and_then(|b| serde_json::from_slice::<Value>(&b).map_err(|e| e.to_string())) {
                Ok(v) => {
                    Self::overlay(&mut by_name, &v);
                    raw = v.clone();
                    if let Some(d) = v["default_agent"].as_str() {
                        // The coordinator is MAIN's profile, never a session default.
                        if d != "coordinator" {
                            default_agent = d.to_string();
                        }
                    }
                }
                Err(e) => eprintln!("YGG_PROFILES {path}: {e} — built-in profiles only"),
            }
        }
        if !by_name.contains_key(&default_agent) {
            default_agent = "build".into();
        }
        if !raw["agent"].is_object() {
            raw["agent"] = json!({});
        }
        let shared = raw["shared_prompt"].as_str().filter(|t| !t.trim().is_empty()).map(String::from).unwrap_or_else(default_shared);
        Profiles { by_name, default_agent, shared, path: path.filter(|p| !p.is_empty()).map(String::from), raw }
    }

    fn overlay(by_name: &mut BTreeMap<String, Profile>, v: &Value) {
        let Some(agents) = v["agent"].as_object() else { return };
        for (name, a) in agents {
            let base = by_name.get(name).cloned().unwrap_or_else(|| Profile {
                name: name.clone(),
                description: String::new(),
                mode: "primary".into(),
                prompt: BUILD_PROMPT.into(),
                model: None,
                variant: None,
                steps: None,
                fold: false,
                sessions: false,
                rules: Vec::new(),
                harness: None,
                prompt_lite: None,
            });
            let mut p = base;
            if let Some(d) = a["description"].as_str() {
                p.description = d.into();
            }
            if let Some(m) = a["mode"].as_str() {
                p.mode = m.into();
            }
            if let Some(t) = a["prompt"].as_str() {
                p.prompt = resolve_prompt(t);
            }
            if let Some(t) = a["prompt_lite"].as_str() {
                p.prompt_lite = Some(resolve_prompt(t));
            }
            if let Some(m) = a["model"].as_str().filter(|m| !m.is_empty()) {
                p.model = Some(m.into());
            }
            if let Some(m) = a["variant"].as_str().filter(|m| !m.is_empty()) {
                p.variant = Some(m.into());
            }
            if let Some(n) = a["steps"].as_u64() {
                p.steps = Some(n.max(1) as usize);
            }
            if let Some(b) = a["fold"].as_bool() {
                p.fold = b;
            }
            if let Some(b) = a["sessions"].as_bool() {
                p.sessions = b;
            }
            if let Some(h) = a["harness"].as_str() {
                // Gemini CLI is gone (11-14): an agent saved on it runs on Antigravity, Google's
                // harness now, keeping its model only when agy runs that model too
                let legacy = h == "gemini";
                let h = if legacy || h == "agy" { "antigravity" } else { h };
                p.harness = Some(h.into()).filter(|h: &String| !h.is_empty() && h != "root");
                if legacy {
                    p.model = p.model.take().filter(|m| crate::harness::antigravity::carry_model(m));
                }
            }
            // The coordinator's tool scope is the brain's contract (it routes, it does not
            // write); a file entry may describe it but not widen it.
            if name != "coordinator" {
                if let Some(r) = parse_rules(&a["permission"]) {
                    p.rules = r;
                }
            }
            by_name.insert(name.clone(), p);
        }
    }

    pub fn get(&self, name: &str) -> Option<&Profile> {
        self.by_name.get(name)
    }

    /// `GET /agent` shape (opencode): `[{name, mode, description}]`, plus our extras.
    pub fn catalog(&self) -> Value {
        Value::Array(
            self.by_name
                .values()
                .map(|p| {
                    json!({ "name": p.name, "mode": p.mode, "description": p.description,
                        "model": p.model, "variant": p.variant, "steps": p.steps, "sessions": p.sessions, "harness": p.harness })
                })
                .collect(),
        )
    }
}

/// The tools an agent on the root can be given, in the order the editor shows them.
pub const TOOLS: &[&str] = ALL;

impl Profiles {
    fn builtin(name: &str) -> bool {
        builtins().iter().any(|p| p.name == name)
    }

    /// Everything the agent editor needs: what it is, what it runs on, what it may do.
    pub fn detail(&self, name: &str) -> Option<Value> {
        let p = self.by_name.get(name)?;
        let root = p.harness.is_none();
        let tools: serde_json::Map<String, Value> = TOOLS.iter().map(|t| ((*t).to_string(), json!(root && p.declared_tools().contains(t)))).collect();
        let simple = p.rules.iter().all(|r| r.pattern == "*");
        Some(json!({
            "name": p.name, "description": p.description, "builtin": Self::builtin(&p.name),
            "harness": p.harness.clone().unwrap_or_else(|| "root".into()),
            "model": p.model, "variant": p.variant, "prompt": p.prompt, "prompt_lite": p.prompt_lite,
            "steps": p.steps, "fold": p.fold, "sessions": p.sessions && root, "tools": tools,
            // pattern rules (bash allowlists…) are shown, not flattened, until the user edits tools
            "rules": if simple { Value::Null } else { json!(p.rules.iter().map(|r| json!({ "permission": r.permission, "pattern": r.pattern,
                "action": if r.allow { "allow" } else { "deny" } })).collect::<Vec<_>>()) },
            "locked": if p.name == "coordinator" { json!(["tools", "harness", "sessions", "fold"]) } else { json!([]) },
            "customizable": if root { json!(["description", "model", "variant", "prompt", "prompt_lite", "tools", "steps", "sessions"]) }
                else if p.harness.as_deref() == Some("claude") { json!(["description", "model", "prompt"]) } else { json!(["description", "model"]) },
        }))
    }

    /// Creates or edits an agent from a partial JSON body; persists. `Err` = what the user must fix.
    pub fn upsert(&mut self, name: &str, body: &Value) -> Result<(), String> {
        let ok_name = !name.is_empty() && name.len() <= 40 && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
        if !ok_name {
            return Err("an agent name is letters, digits, - and _ (40 max)".into());
        }
        let mut p = self.by_name.get(name).cloned().unwrap_or_else(|| Profile {
            name: name.into(), description: String::new(), mode: "primary".into(), prompt: BUILD_PROMPT.into(), model: None,
            variant: None, steps: None, fold: false, sessions: false, rules: allow_all(), harness: None, prompt_lite: None,
        });
        let door = name == "coordinator";
        if let Some(h) = body["harness"].as_str() {
            if door && h != "root" {
                return Err("the coordinator runs on the root".into());
            }
            p.harness = match h {
                "root" | "" => None,
                "claude" | "opencode" | "codex" | "antigravity" => Some(h.into()),
                "agy" => Some("antigravity".into()),
                other => return Err(format!("unknown harness {other:?} (root | claude | opencode | codex | antigravity)")),
            };
        }
        if let Some(d) = body["description"].as_str() {
            p.description = d.trim().chars().take(300).collect();
        }
        if body.get("model").is_some() {
            p.model = body["model"].as_str().map(str::trim).filter(|m| !m.is_empty()).map(String::from);
        }
        if body.get("variant").is_some() {
            p.variant = match body["variant"].as_str().unwrap_or("") {
                "" => None,
                v @ ("high" | "low" | "off") => Some(v.into()),
                other => return Err(format!("unknown thinking level {other:?} (high | low | off)")),
            };
        }
        if let Some(t) = body["prompt"].as_str() {
            p.prompt = t.to_string();
        }
        if body.get("prompt_lite").is_some() {
            p.prompt_lite = body["prompt_lite"].as_str().filter(|t| !t.trim().is_empty()).map(String::from);
        }
        if let Some(n) = body["steps"].as_u64() {
            p.steps = Some(n.clamp(1, 500) as usize);
        }
        if let Some(b) = body["sessions"].as_bool() {
            if door && !b {
                return Err("the coordinator always manages sessions".into());
            }
            p.sessions = b;
        }
        if let Some(tools) = body["tools"].as_object() {
            if door {
                return Err("the coordinator's tools are fixed: it reads and routes, it never writes".into());
            }
            // the editor's toggles become a plain ruleset: deny all, allow each ticked tool
            let mut rules = vec![rule("*", "*", false)];
            rules.extend(TOOLS.iter().filter(|t| tools.get(**t).and_then(Value::as_bool).unwrap_or(false)).map(|t| rule(t, "*", true)));
            p.rules = rules;
        }
        self.by_name.insert(name.to_string(), p);
        self.persist(name)
    }

    /// Deletes an agent you made (built-ins are edited, never deleted).
    pub fn remove(&mut self, name: &str) -> Result<(), String> {
        if Self::builtin(name) {
            return Err("built-in agents can be edited, not deleted".into());
        }
        self.by_name.remove(name).ok_or("no such agent")?;
        if let Some(a) = self.raw["agent"].as_object_mut() {
            a.remove(name);
        }
        self.write()
    }

    fn persist(&mut self, name: &str) -> Result<(), String> {
        let p = &self.by_name[name];
        let entry = &mut self.raw["agent"][name];
        if !entry.is_object() {
            *entry = json!({});
        }
        entry["description"] = json!(p.description);
        entry["mode"] = json!(p.mode);
        entry["harness"] = json!(p.harness.clone().unwrap_or_else(|| "root".into()));
        entry["model"] = json!(p.model);
        entry["variant"] = json!(p.variant);
        entry["prompt"] = json!(p.prompt);
        entry["prompt_lite"] = json!(p.prompt_lite);
        entry["steps"] = json!(p.steps);
        entry["fold"] = json!(p.fold);
        entry["sessions"] = json!(p.sessions);
        entry["permission"] = json!(p.rules.iter().map(|r| json!({ "permission": r.permission, "pattern": r.pattern,
            "action": if r.allow { "allow" } else { "deny" } })).collect::<Vec<_>>());
        self.write()
    }

    /// Edit the shared prompt (empty = back to the default); persisted with the agents.
    pub fn set_shared(&mut self, text: &str) -> Result<(), String> {
        let text = text.trim();
        if text.is_empty() {
            self.shared = default_shared();
            if let Some(o) = self.raw.as_object_mut() {
                o.remove("shared_prompt");
            }
        } else {
            self.shared = text.to_string();
            self.raw["shared_prompt"] = json!(text);
        }
        self.write()
    }

    fn write(&self) -> Result<(), String> {
        let Some(path) = &self.path else { return Ok(()) }; // no file: edits live in memory
        let tmp = format!("{path}.tmp");
        let bytes = serde_json::to_vec_pretty(&self.raw).map_err(|e| e.to_string())?;
        std::fs::write(&tmp, bytes).and_then(|_| std::fs::rename(&tmp, path)).map_err(|e| format!("could not save agents to {path}: {e}"))
    }
}

/// Glob match: `*` any run of chars (incl. none), `?` one char, everything else literal.
pub fn wildcard(pattern: &str, s: &str) -> bool {
    let (p, t): (Vec<char>, Vec<char>) = (pattern.chars().collect(), s.chars().collect());
    let (mut pi, mut ti, mut star, mut mark) = (0usize, 0usize, None::<usize>, 0usize);
    while ti < t.len() {
        if pi < p.len() && (p[pi] == '?' || p[pi] == t[ti]) {
            pi += 1;
            ti += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star = Some(pi);
            mark = ti;
            pi += 1;
        } else if let Some(s) = star {
            pi = s + 1;
            mark += 1;
            ti = mark;
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == '*' {
        pi += 1;
    }
    pi == p.len()
}

/// The string a rule's pattern is matched against.
fn subject(tool: &str, input: &Value) -> String {
    let key = match tool {
        "bash" => "command",
        "read" | "write" | "edit" => "filePath",
        "webfetch" => "url",
        "glob" | "grep" => "pattern",
        _ => return "*".into(),
    };
    input[key].as_str().unwrap_or_default().trim().to_string()
}

/// Last matching rule for (tool, subject); `None` = no rule matches.
fn decide(rules: &[Rule], tool: &str, subj: &str) -> Option<bool> {
    rules
        .iter()
        .rev()
        .find(|r| (r.permission == "*" || r.permission == tool) && (r.pattern == "*" || wildcard(&r.pattern, subj)))
        .map(|r| r.allow)
}

/// Splits a bash command into simple commands. `None` = a construct we refuse to reason
/// about (substitution, process substitution) — the caller fails closed.
pub fn simple_commands(cmd: &str) -> Option<Vec<String>> {
    if cmd.contains("$(") || cmd.contains('`') || cmd.contains("<(") || cmd.contains(">(") {
        return None;
    }
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut chars = cmd.chars().peekable();
    let (mut sq, mut dq) = (false, false);
    while let Some(c) = chars.next() {
        match c {
            '\'' if !dq => {
                sq = !sq;
                cur.push(c);
            }
            '"' if !sq => {
                dq = !dq;
                cur.push(c);
            }
            // an output redirection writes a file whatever the command is: fail closed
            '>' if !sq && !dq => return None,
            ';' | '\n' | '|' | '&' if !sq && !dq => {
                if (c == '|' || c == '&') && chars.peek() == Some(&c) {
                    chars.next();
                }
                let t = cur.trim().to_string();
                if !t.is_empty() {
                    out.push(t);
                }
                cur.clear();
            }
            _ => cur.push(c),
        }
    }
    if sq || dq {
        return None;
    }
    let t = cur.trim().to_string();
    if !t.is_empty() {
        out.push(t);
    }
    Some(out)
}

impl Profile {
    /// The role text a model of `tier` reads (`lite` | `full`): lite → the short text when there is
    /// one. What every agent shares lives in `Profiles::shared`, once.
    pub fn role_for(&self, tier: &str) -> String {
        match (tier, &self.prompt_lite) {
            ("lite", Some(short)) => short.clone(),
            _ => self.prompt.clone(),
        }
    }

    /// May this profile call `tool` with `input`? `Err` carries the refusal the model reads.
    pub fn check(&self, tool: &str, input: &Value) -> Result<(), String> {
        if tool.starts_with("session") || tool == "inbox" {
            let read = matches!(tool, "sessions_find" | "session_read");
            return if self.sessions || (read && self.reads_tree()) {
                Ok(())
            } else {
                Err(format!("the {} profile does not manage sessions", self.name))
            };
        }
        let deny = || Err(format!("permission denied: the {} profile may not run {tool} here", self.name));
        if tool == "bash" {
            if self.blanket_bash() {
                return Ok(());
            }
            let cmd = subject("bash", input);
            let Some(parts) = simple_commands(&cmd) else { return deny() };
            if parts.is_empty() {
                return deny();
            }
            for part in parts {
                if decide(&self.rules, "bash", &part) != Some(true) {
                    return Err(format!("permission denied: the {} profile may not run `{part}`", self.name));
                }
            }
            return Ok(());
        }
        let subj = subject(tool, input);
        // a path climbing out of an allowed folder never passes a pattern rule
        if matches!(tool, "write" | "edit") && (subj.contains("/../") || subj.starts_with("../")) && !self.blanket(tool) {
            return deny();
        }
        match decide(&self.rules, tool, &subj) {
            Some(true) => Ok(()),
            _ => deny(),
        }
    }

    /// A `*`-pattern allow for `tool` with nothing narrower after it.
    fn blanket(&self, tool: &str) -> bool {
        let applies = |r: &Rule| r.permission == "*" || r.permission == tool;
        let Some(i) = self.rules.iter().rposition(|r| applies(r) && r.pattern == "*") else { return false };
        self.rules[i].allow && self.rules[i + 1..].iter().all(|r| !applies(r) || r.allow)
    }

    /// A `*`-pattern allow for bash with no narrower deny after it: any command runs,
    /// substitutions included, without the per-command walk.
    fn blanket_bash(&self) -> bool {
        let applies = |r: &Rule| r.permission == "*" || r.permission == "bash";
        let Some(i) = self.rules.iter().rposition(|r| applies(r) && r.pattern == "*") else { return false };
        self.rules[i].allow && self.rules[i + 1..].iter().all(|r| !applies(r) || r.allow)
    }

    /// Tools worth declaring upstream: the ones some rule could allow.
    /// May this profile read the session tree (sessions_find + session_read)? A managing one can; a
    /// read-only one when its rules allow session_read — review reads what happened (owner 11-13:
    /// "review everything that happened in the past 5m" had no session to give it to).
    pub fn reads_tree(&self) -> bool {
        self.sessions || self.rules.iter().any(|r| r.allow && r.permission == "session_read")
    }

    pub fn declared_tools(&self) -> Vec<&'static str> {
        ALL.iter()
            .copied()
            .filter(|t| self.rules.iter().any(|r| r.allow && (r.permission == "*" || r.permission == *t)))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn prof(rules: Vec<Rule>) -> Profile {
        Profile { name: "t".into(), description: String::new(), mode: "primary".into(), prompt: String::new(), model: None,
            variant: None, steps: None, fold: false, sessions: false, rules, harness: None, prompt_lite: None }
    }

    #[test]
    fn review_reads_the_tree_but_never_drives_it() {
        let ps = Profiles::load(None);
        let review = ps.get("review").unwrap();
        assert!(review.reads_tree() && !review.sessions);
        for t in ["sessions_find", "session_read"] {
            assert!(review.check(t, &json!({})).is_ok(), "{t}");
        }
        for t in ["session_start", "session_send", "session_close"] {
            assert!(review.check(t, &json!({})).is_err(), "{t}");
        }
        assert!(!ps.get("build").unwrap().reads_tree(), "build stays out of the tree");
    }

    #[test]
    fn the_shared_prompt_is_stored_once() {
        let mut ps = Profiles::load(None);
        assert!(ps.shared.starts_with(PREAMBLE) && ps.shared.ends_with(INTENT_NOTE));
        // an agent's role holds only its own text
        let build = ps.get("build").unwrap();
        assert_eq!(build.role_for("full"), BUILD_PROMPT);
        assert_eq!(build.role_for("lite"), BUILD_LITE);
        ps.set_shared("Always answer in French.").unwrap();
        assert_eq!(ps.shared, "Always answer in French.");
        assert_eq!(ps.raw["shared_prompt"], "Always answer in French.");
        ps.set_shared("  ").unwrap();
        assert_eq!(ps.shared, default_shared(), "empty = the default again");
        assert!(ps.raw.get("shared_prompt").is_none());
    }

    #[test]
    fn wildcard_basics() {
        assert!(wildcard("*", ""));
        assert!(wildcard("curl *127.0.0.1:*", "curl -s http://127.0.0.1:4100/session"));
        assert!(!wildcard("curl *127.0.0.1:*", "curl -s http://evil.example/127"));
        assert!(wildcard("git ?og*", "git log --oneline"));
        assert!(!wildcard("ls", "ls -la"));
    }

    #[test]
    fn last_match_wins_and_unlisted_denies() {
        let p = prof(vec![rule("*", "*", false), rule("read", "*", true), rule("read", "/etc/*", false)]);
        assert!(p.check("read", &json!({"filePath": "/home/x"})).is_ok());
        assert!(p.check("read", &json!({"filePath": "/etc/shadow"})).is_err());
        assert!(p.check("write", &json!({"filePath": "/home/x"})).is_err());
        assert!(prof(vec![]).check("read", &json!({"filePath": "a"})).is_err());
    }

    #[test]
    fn bash_every_simple_command_must_pass() {
        let p = prof(vec![rule("*", "*", false), rule("bash", "ls *", true), rule("bash", "grep *", true)]);
        assert!(p.check("bash", &json!({"command": "ls -la | grep foo"})).is_ok());
        assert!(p.check("bash", &json!({"command": "ls -la; rm -rf /"})).is_err());
        assert!(p.check("bash", &json!({"command": "ls && curl x"})).is_err());
        assert!(p.check("bash", &json!({"command": "ls $(rm -rf /)"})).is_err());
        assert!(p.check("bash", &json!({"command": "grep 'a;b' file"})).is_ok());
        assert!(prof(allow_all()).check("bash", &json!({"command": "echo $(date) `id`"})).is_ok());
    }

    #[test]
    fn review_reads_everything_and_writes_only_its_reports() {
        // SAFETY: test-only; no other test reads YGG_ARTIFACTS_DIR concurrently in a way it could race on
        unsafe { std::env::set_var("YGG_ARTIFACTS_DIR", "/home/u/Work/bifrost/artifacts") };
        let r = review_profile();
        let ok = |t: &str, i: Value| r.check(t, &i).is_ok();
        assert!(ok("read", json!({"filePath": "/home/u/Work/x.py"})));
        assert!(ok("bash", json!({"command": "git log --oneline -5 | head -3"})));
        assert!(ok("write", json!({"filePath": "/home/u/Work/bifrost/artifacts/review.md"})));
        assert!(!ok("write", json!({"filePath": "/home/u/Work/x.py"})), "the project is read-only");
        assert!(!ok("write", json!({"filePath": "/home/u/Work/bifrost/artifacts/../src/x.py"})), "no climbing out");
        assert!(!ok("edit", json!({"filePath": "/home/u/Work/x.py"})));
        for cmd in ["cat a > b", "rm x", "find . -delete", "find . -exec rm {} ;", "git diff --output=x", "sort a -o b", "echo hi", "ls; rm x"] {
            assert!(!ok("bash", json!({ "command": cmd })), "{cmd} must be refused");
        }
    }

    #[test]
    fn redirection_fails_closed_for_allowlists() {
        let p = prof(vec![rule("*", "*", false), rule("bash", "cat *", true)]);
        assert!(p.check("bash", &json!({"command": "cat a"})).is_ok());
        assert!(p.check("bash", &json!({"command": "cat a > b"})).is_err());
        assert!(p.check("bash", &json!({"command": "cat 'a>b'"})).is_ok(), "a quoted > is text");
        assert!(prof(allow_all()).check("bash", &json!({"command": "echo x > y"})).is_ok(), "blanket bash is untouched");
    }

    #[test]
    fn a_gemini_agent_loads_on_antigravity() {
        let dir = std::env::temp_dir().join(format!("ygg-agents-gem-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("agents.json");
        std::fs::write(&f, r#"{"agent":{"gem":{"harness":"gemini","model":"gemini-3.5-flash","description":"Google"},
            "gem2":{"harness":"gemini","model":"gemini-3.8-flash"},"agy2":{"harness":"agy"}}}"#).unwrap();
        let mut ps = Profiles::load(f.to_str());
        let g = ps.get("gem").unwrap();
        assert_eq!(g.harness.as_deref(), Some("antigravity"));
        assert_eq!(g.model, None, "a Gemini CLI model agy does not run: agy's own pick");
        assert_eq!(g.description, "Google");
        assert_eq!(ps.get("gem2").unwrap().model.as_deref(), Some("gemini-3.8-flash"));
        assert_eq!(ps.get("agy2").unwrap().harness.as_deref(), Some("antigravity"));
        // the next edit saves it as antigravity
        ps.upsert("gem", &json!({"description": "Google's"})).unwrap();
        let raw: Value = serde_json::from_slice(&std::fs::read(&f).unwrap()).unwrap();
        assert_eq!(raw["agent"]["gem"]["harness"], "antigravity");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn edit_create_delete_persist() {
        let dir = std::env::temp_dir().join(format!("ygg-agents-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("agents.json");
        std::fs::write(&f, r#"{"keep":"me","agent":{}}"#).unwrap();
        let mut ps = Profiles::load(f.to_str());
        assert_eq!(ps.detail("AGI").unwrap()["harness"], "claude");
        assert!(ps.upsert("coordinator", &json!({"tools": {"bash": true}})).is_err(), "the door stays read-only");
        assert!(ps.upsert("coordinator", &json!({"model": "glm-5.2"})).is_ok());
        ps.upsert("tester", &json!({"description": "runs tests", "tools": {"bash": true, "read": true}, "model": "glm-5.3", "variant": "low"})).unwrap();
        let t = ps.get("tester").unwrap();
        assert!(t.check("bash", &json!({"command": "pytest"})).is_ok() && t.check("write", &json!({"filePath": "x"})).is_err());
        assert!(ps.upsert("bad name!", &json!({})).is_err());
        assert!(ps.upsert("x", &json!({"harness": "emacs"})).is_err());
        // Google's harness, offered like Claude Code's and Codex's: description + model, its own tools
        ps.upsert("agy1", &json!({"harness": "antigravity", "model": "gemini-3.8-flash-low"})).unwrap();
        let g = ps.detail("agy1").unwrap();
        assert_eq!(g["harness"], "antigravity");
        assert_eq!(g["customizable"], json!(["description", "model"]));
        assert!(ps.remove("agy1").is_ok());
        assert!(ps.upsert("gem", &json!({"harness": "gemini"})).is_err(), "Gemini CLI is no longer a harness");
        let again = Profiles::load(f.to_str());
        assert_eq!(again.get("tester").unwrap().model.as_deref(), Some("glm-5.3"));
        assert_eq!(again.get("coordinator").unwrap().model.as_deref(), Some("glm-5.2"));
        let raw: Value = serde_json::from_slice(&std::fs::read(&f).unwrap()).unwrap();
        assert_eq!(raw["keep"], "me", "unknown keys survive an edit");
        assert!(ps.remove("AGI").is_err() && ps.remove("tester").is_ok());
        assert!(Profiles::load(f.to_str()).get("tester").is_none());
    }

    #[test]
    fn builtins_and_overlay() {
        let ps = Profiles::load(None);
        assert_eq!(ps.default_agent, "build");
        let c = ps.get("coordinator").unwrap();
        assert!(c.sessions && c.fold);
        assert!(c.check("write", &json!({"filePath": "/tmp/x"})).is_err());
        assert!(c.check("bash", &json!({"command": "ls"})).is_err());
        assert!(c.check("read", &json!({"filePath": "/tmp/x"})).is_ok());
        assert!(c.check("session_start", &json!({})).is_ok());
        assert!(ps.get("build").unwrap().check("session_start", &json!({})).is_err());
        assert!(c.declared_tools().contains(&"read") && !c.declared_tools().contains(&"bash"));

        let dir = std::env::temp_dir().join(format!("ygg-prof-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("p.json");
        std::fs::write(&f, r#"{"default_agent":"coordinator","agent":{
            "coordinator":{"permission":[{"permission":"*","pattern":"*","action":"allow"}],"model":"glm-5.2"},
            "scout":{"description":"looks","permission":[{"permission":"read","pattern":"*","action":"allow"}],"steps":5}}}"#).unwrap();
        let ps = Profiles::load(f.to_str());
        assert_eq!(ps.default_agent, "build", "coordinator is never a default");
        let c = ps.get("coordinator").unwrap();
        assert!(c.check("write", &json!({"filePath": "x"})).is_err(), "file cannot widen the coordinator");
        assert_eq!(c.model.as_deref(), Some("glm-5.2"));
        let s = ps.get("scout").unwrap();
        assert_eq!(s.steps, Some(5));
        assert!(s.check("read", &json!({"filePath": "x"})).is_ok() && s.check("bash", &json!({"command": "ls"})).is_err());
    }
}
