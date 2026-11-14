//! YGGDRASIL (slices 1-7): an opencode-compatible surface that bifrost's PWA proxy can
//! drive unchanged. Sessions + message relay to an OpenAI- or Anthropic-compatible endpoint;
//! abort; global `/event` bus; on-disk store; per-session run serialization;
//! session get/patch/delete, busy map, model/agent catalog + v2 switches.
//!
//! Env:
//!   YGG_UPSTREAM_BASE_URL  e.g. https://api.openai.com/v1  (required; `/chat/completions` is appended)
//!   YGG_UPSTREAM_API_KEY   bearer token (optional; omitted header if unset; the anthropic
//!                          dialect sends it as `x-api-key` AND `Authorization: Bearer`)
//!   YGG_UPSTREAM_STYLE     slice 7: `openai` (default: `{base}/chat/completions`) | `anthropic`
//!                          (`{base}/v1/messages`, block SSE; `anthropic.rs`)
//!   YGG_MAX_TOKENS         anthropic dialect's required `max_tokens` (default 16384)
//!   YGG_DEFAULT_VARIANT    thinking variant stamped on every NEW session as `info.model.variant`:
//!                          `high` (default) | `low` | `off`. Anthropic dialect only: `high` adds
//!                          `thinking:{type:enabled,budget_tokens:YGG_THINK_HIGH}` to the body, low/off
//!                          omit it. Resolved once at session create (cache law: constant for the
//!                          session's life; a model switch keeps it; unstamped legacy sessions follow
//!                          this default, so `off` here is the one-line rollback for them too)
//!   YGG_THINK_HIGH         thinking budget_tokens for `high` (default 8192; must be < YGG_MAX_TOKENS)
//!   YGG_UPSTREAM_MODEL     model name (default: gpt-4o-mini)
//!   YGG_LISTEN             bind address (default: 127.0.0.1:4096)
//!   YGG_DATA_DIR           on-disk store (default: ./data); one `session/<id>.json` per session
//!   YGG_CATALOG            JSON file `{providers:[...], agents:[...]}` served as
//!                          `/config/providers` + `/agent` (default: one provider = the upstream model,
//!                          agents build + plan)
//!   YGG_PROJECT_DIR        slice 6a: where tools run / relative paths resolve (default: cwd)
//!   YGG_MAIN_BASH_TIMEOUT_MS / YGG_MAIN_MAX_STEPS  caps for sessions titled [MAIN] (default 15000 ms / 6 steps)
//!   YGG_MAX_STEPS          upstream calls per run before the loop gives up (default: 100)
//!   YGG_BASH_TIMEOUT_MS    default bash tool timeout (default: 120000)
//!   YGG_TOOLS              `0` = don't declare tools (plain relay, for tool-less upstreams)
//!   YGG_ROLLUP_TOKENS      slice 6b: estimated-token limit for the upstream history (default 200000,
//!                          `0` = off); over it, older history is summarized (`rollup.rs`)
//!   YGG_ROLLUP_KEEP_TOKENS recent history kept verbatim at a roll-up (default: limit / 4)
//!
//! Slice 6a: each run is an agent loop — the upstream gets the tool set (`tools.rs`); its
//! tool_calls are executed serially, fed back as `tool` messages, repeated until a reply
//! with no tool calls. Every call is stored on the assistant message as an opencode
//! `{"type":"tool", callID, tool, state:{status, input, output, ...}}` part and announced
//! on `message.part.updated` (running, then completed|error).
//!
//! Slice 7: `YGG_UPSTREAM_STYLE=anthropic` speaks the Anthropic Messages API instead. The run
//! keeps the same internal (OpenAI-shaped) conversation; `anthropic.rs` translates it at the
//! wire, decodes the block SSE back into the same deltas + tool calls, and the relay re-keys
//! tool-use ids — stored transcripts and client events are identical in both dialects.
//!
//! `POST /session/:id/message` answers like opencode (blocks, returns the final assistant
//! message as JSON) unless the request sends `Accept: text/event-stream`, which gets the
//! slice-1 per-request SSE relay.

use std::{
    collections::{HashMap, HashSet},
    convert::Infallible,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use axum::{
    Json, Router,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode, header},
    response::{
        IntoResponse, Response,
        sse::{Event, KeepAlive, Sse},
    },
    routing::{get, post},
};
use futures::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::{Notify, broadcast, mpsc, oneshot};
use tokio_stream::wrappers::{BroadcastStream, ReceiverStream};

mod anthropic;
mod ext;
mod gate;
mod harness;
mod peers;
mod profiles;
mod rollup;
mod tools;
mod tree;

// ── TIME-AWARENESS (owner ADD to the 200k context-cap slice, 11-05) ─────────
// Every turn carries a compact clock header to the upstream model: current
// UTC time, the gap since the session's last USER turn, and (gap > 4h) a
// capped ≤3-line meanwhile summary of what landed since (lane-watcher lines
// from /tmp/sub-status.tsv + artifact mtimes). Adaptation rules ride INSIDE
// the header, stated once: <1h continuous flow · 1–24h brief re-anchor if
// state changed · >24h lead with a meanwhile-summary and re-anchor stale
// state. Injected per turn (never stored), AFTER roll-up sizing — it does not
// count against the 200k ceiling.
struct Utc { year: i64, month: u32, day: u32, hour: u32, min: u32, sec: u32 }

/// Days-from-civil algorithm (Howard Hinnant): pure-std UTC from unix seconds.
fn utc_from_unix(secs: i64) -> Utc {
    let days = secs.div_euclid(86_400);
    let sod = secs.rem_euclid(86_400);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    Utc { year: if m <= 2 { y + 1 } else { y }, month: m, day: d, hour: (sod / 3600) as u32, min: (sod % 3600 / 60) as u32, sec: (sod % 60) as u32 }
}

/// "2026-11-05T15:42:07Z" — compact, machine-additive, one line.
fn utc_stamp(unix: i64) -> String {
    let t = utc_from_unix(unix);
    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z", t.year, t.month, t.day, t.hour, t.min, t.sec)
}

/// ≤3 newest `done`-ish lane lines from the coordinator's sub-status TSV,
/// newest first (the file appends; older lines stay at the top).
fn watcher_lines(capped_at: i64, max: usize) -> Vec<String> {
    let mut out = Vec::new();
    if let Ok(s) = std::fs::read_to_string("/tmp/sub-status.tsv") {
        for line in s.lines().rev() {
            if out.len() >= max { break; }
            if let Some(ts) = line.rsplit('\t').next().and_then(|t| {
                // last TSV field is "YYYY-MM-DDTHH:MM:SS+01:00" or "YYYY-MM-DD"
                let (d, tm) = match t.split_once('T') {
                    Some((d, tm)) => (d, Some(tm)),
                    None => (t, None),
                };
                let mut it = d.split('-');
                let (y, mo, da) = (it.next()?.parse::<i32>().ok()?, it.next()?.parse::<u32>().ok()?, it.next()?.parse::<u32>().ok()?);
                let (h, mi, se) = match tm {
                    Some(tm) => {
                        let tm = tm.trim_end_matches(&format!("+{:02}:00", fixed_offset_hours()));
                        let mut it = tm.split(':');
                        (it.next()?.parse::<u32>().ok()?, it.next()?.parse::<u32>().ok()?, it.next().and_then(|x| x.parse::<u32>().ok()).unwrap_or(0))
                    }
                    None => (0, 0, 0),
                };
                Some(civil_to_unix(y, mo, da, h, mi, se))
            }) {
                if ts > capped_at {
                    let l = line.trim();
                    if !l.is_empty() { out.push(l.chars().take(160).collect()); }
                }
            }
        }
    }
    out
}

fn fixed_offset_hours() -> i32 {
    // local timestamps in the TSV carry a fixed +HH:00 offset; parse lazily
    // from TZ once per call — the box never changes zones mid-run
    1 // Europe/Stockholm/Oslo CET (+01:00) — the TSV writer's fixed offset
}

fn civil_to_unix(y: i32, m: u32, d: u32, h: u32, mi: u32, se: u32) -> i64 {
    let days = civil_days(y as i64, m, d);
    days * 86_400 + h as i64 * 3600 + mi as i64 * 60 + se as i64
}

fn civil_days(y: i64, m: u32, d: u32) -> i64 {
    let yy = if m <= 2 { y - 1 } else { y };
    let era = if yy >= 0 { yy } else { yy - 399 } / 400;
    let yoe = yy - era * 400;
    let mp = if m > 2 { m - 3 } else { m + 9 } as i64;
    let doy = (153 * mp + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// Newest-first artifact names (files in the artifacts folder — YGG_ARTIFACTS_DIR, else
/// ~/Work/bifrost/artifacts — newer than `capped_at`); the names alone carry the lane story
/// for a meanwhile summary.
fn artifact_names(capped_at: i64, max: usize) -> Vec<String> {
    let mut out: Vec<(i64, String)> = Vec::new();
    let dir = std::env::var("YGG_ARTIFACTS_DIR")
        .ok()
        .filter(|d| !d.trim().is_empty())
        .unwrap_or_else(|| format!("{}/Work/bifrost/artifacts", std::env::var("HOME").unwrap_or_default()));
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            if let Ok(md) = e.metadata() {
                if let Ok(t) = md.modified() {
                    let ts = t.duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
                    if ts > capped_at {
                        if let Some(name) = e.file_name().to_str() {
                            out.push((ts, name.to_string()));
                        }
                    }
                }
            }
        }
    }
    out.sort_by(|a, b| b.0.cmp(&a.0));
    out.truncate(max);
    out.into_iter().map(|(_, n)| n).collect()
}

fn fmt_gap(gap_secs: i64) -> String {
    let h = gap_secs / 3600;
    let m = (gap_secs % 3600) / 60;
    if h >= 48 { format!("{}d", h / 24) } else if h >= 1 { format!("{}h{}m", h, m) } else { format!("{}m", m.max(1)) }
}

/// "2026-11-05T15:42:07Z" → unix seconds (None = unparseable).
/// Test/sim helper: the two-turn gap sim re-parses a tampered stamp.
fn parse_stamp(s: &str) -> Option<i64> {
    let (d, tm) = s.strip_suffix('Z')?.split_once('T')?;
    let mut di = d.split('-');
    let y = di.next()?.parse::<i32>().ok()?;
    let mo = di.next()?.parse::<u32>().ok()?;
    let da = di.next()?.parse::<u32>().ok()?;
    let mut ti = tm.split(':');
    let h = ti.next()?.parse::<u32>().ok()?;
    let mi = ti.next()?.parse::<u32>().ok()?;
    let se = ti.next().and_then(|x| x.parse::<u32>().ok()).unwrap_or(0);
    Some(civil_to_unix(y, mo, da, h, mi, se))
}

/// Meanwhile lines for a user message whose previous user turn was `prev_ms`:
/// ≤3 lines, only for gaps ≥4h, newer than the previous turn. Called ONCE at
/// message creation; the result is stored on the message
/// (`info.time.meanwhile`) and never recomputed at render time.
fn meanwhile_for(prev_ms: Option<i64>) -> Vec<String> {
    let Some(prev) = prev_ms else { return Vec::new() };
    let last = prev / 1000;
    if (clock_now_ms() / 1000 - last).max(0) < 4 * 3600 {
        return Vec::new();
    }
    let mut lines = watcher_lines(last, 3);
    lines.extend(artifact_names(last, 3));
    lines.truncate(3);
    lines
}

/// THE HEADER — one compact line (plus ≤3 meanwhile lines when the gap is
/// long). Rules live inside the header text so the model reads them with the
/// data, once per turn. Pure: the meanwhile lines are INPUT (frozen on the
/// stored message at creation), never read from live state here.
fn clock_header(now_unix: i64, last_user_unix: Option<i64>, meanwhile: &[String]) -> String {
    let mut hdr = format!("[clock {}]", utc_stamp(now_unix));
    if let Some(last) = last_user_unix {
        let gap = (now_unix - last).max(0);
        hdr.push_str(&format!(" [gap since last user turn {}]", fmt_gap(gap)));
        if gap >= 4 * 3600 {
            hdr.push_str(" [rules: <1h continuous flow; 1-24h brief re-anchor if state changed; >24h lead with a meanwhile-summary of what changed and re-anchor stale state]");
            if !meanwhile.is_empty() {
                hdr.push_str(" [meanwhile]");
                for l in meanwhile.iter().take(3) { hdr.push_str(&format!("\n[clock] {l}")); }
            }
        }
    }
    hdr
}

/// Stamps `info.time.created` of new messages — the headers derive from it.
/// YGG_CLOCK_EPOCH_MS / YGG_CLOCK_SHIFT_SECS: TEST/SIM ONLY (the MOCK_LATENCY
/// precedent) — a frozen "now" or a synthetic shift so the two-turn gap sim
/// can produce a REAL server-side 26h gap; absent in production. They write
/// into stored `created`, so main() warns loudly when either is set.
fn clock_now_ms() -> i64 {
    let now = now_ms() as i64;
    if let Ok(e) = std::env::var("YGG_CLOCK_EPOCH_MS") {
        if let Ok(ms) = e.parse::<i64>() {
            if ms > 0 {
                return ms;
            }
        }
    }
    if let Ok(s) = std::env::var("YGG_CLOCK_SHIFT_SECS") {
        if let Ok(sh) = s.parse::<i64>() {
            return now + sh * 1000;
        }
    }
    now
}

/// CACHE LAW (latency round 1, 11-08): the provider prefix-caches by exact
/// byte prefix; any mutating content before the tail invalidates the key.
/// Two rules keep the prefix append-only across turns:
/// 1. The STATIC system preamble sits at position 0 (terse rule included);
///    the clock header rides INSIDE each user turn (a tail-position system
///    message would be hoisted into the top-level `system` string by
///    `convert()` and break the key all the same).
/// 2. Every header is a PURE FUNCTION of stored data: for a user message,
///    `clock_header(created_s, created_s of the previous non-compaction user
///    message, stored meanwhile)`. `upstream_history` marks those messages with
///    private `_ts` / `_prev` / `_mw` fields (so the chain survives a compaction
///    boundary); nothing is written back at render time, so headers are
///    byte-identical across turns, restarts and old sessions — including the
///    meanwhile lines, which are computed once at message creation and frozen
///    on the record (`info.time.meanwhile`; old sessions lack it and render
///    none). The private fields are stripped before send.
/// Editing this constant resets every session's provider cache once.
/// root-coord (11-13): the preamble is the opening of the SHARED prompt (profiles::default_shared,
/// editable once for every agent); tests use the bare preamble.
#[cfg(test)]
const SYSTEM_PREAMBLE: &str = profiles::PREAMBLE;

/// Prepends the shared prompt (static for the session's life), then the derived header to every
/// user message carrying `_ts` (compaction asks carry none), then strips every `_`-prefixed key so
/// nothing private rides upstream (either dialect).
fn apply_clock_headers(convo: &mut Vec<Value>, shared: &str) {
    convo.insert(0, json!({ "role": "system", "content": shared }));
    for m in convo.iter_mut() {
        if m["role"] != "user" { continue; }
        let Some(ts) = m["_ts"].as_i64() else { continue };
        let mw: Vec<String> = m["_mw"]
            .as_array()
            .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
            .unwrap_or_default();
        let hdr = clock_header(ts / 1000, m["_prev"].as_i64().map(|p| p / 1000), &mw);
        prefix_text(m, &hdr);
    }
    strip_private(convo);
}

/// "[context ≈ 43k tokens · rolls up at 200k]" — what a session knows of its own size each turn.
fn context_line(tokens: usize, limit: usize) -> String {
    let k = |n: usize| if n >= 1000 { format!("{}k", (n + 500) / 1000) } else { n.to_string() };
    if limit == 0 {
        format!("[context ≈ {} tokens]", k(tokens))
    } else {
        format!("[context ≈ {} tokens · rolls up at {}]", k(tokens), k(limit))
    }
}

/// Puts `pre` + newline in front of a message's text (string content, or its first text part).
fn prefix_text(m: &mut Value, pre: &str) {
    if let Some(c) = m["content"].as_str() {
        m["content"] = json!(format!("{pre}\n{c}"));
    } else if let Some(t) = m["content"].as_array_mut().and_then(|ps| ps.iter_mut().find(|p| p["type"] == "text")) {
        t["text"] = json!(format!("{pre}\n{}", t["text"].as_str().unwrap_or_default()));
    }
}

/// Appends `\n\n` + `post` to a message's text (string content, or its first text part).
fn append_text(m: &mut Value, post: &str) {
    if let Some(c) = m["content"].as_str() {
        m["content"] = json!(format!("{c}\n\n{post}"));
    } else if let Some(t) = m["content"].as_array_mut().and_then(|ps| ps.iter_mut().find(|p| p["type"] == "text")) {
        t["text"] = json!(format!("{}\n\n{post}", t["text"].as_str().unwrap_or_default()));
    }
}

/// Removes every `_`-prefixed key from the top level of each message.
fn strip_private(convo: &mut [Value]) {
    for m in convo.iter_mut() {
        if let Some(o) = m.as_object_mut() {
            o.retain(|k, _| !k.starts_with('_'));
        }
    }
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum Dialect {
    OpenAi,
    Anthropic,
}

struct Config {
    base_url: String,
    dialect: Dialect,
    max_tokens: u64,
    api_key: Option<String>,
    /// the default upstream model; a session may run any model in `models`
    model: String,
    models: Vec<String>,
    catalog: Value,
    max_steps: usize,
    /// root-coord: the agents — what each session is (role prompt, tools, model, harness…);
    /// editable at runtime (PUT /agent/:name), persisted to YGG_PROFILES
    profiles: std::sync::RwLock<profiles::Profiles>,
    tree: tree::TreeCfg,
    /// OG-ctx (10-27, restored 11-12): the AGENTS.md chain, re-read every run
    context_files: Vec<PathBuf>,
    /// root-coord: the other roots this one works with (peers.rs)
    peers: peers::Peers,
    /// extensions: tools served by processes outside the core (ext.rs, YGG_EXTENSIONS)
    ext: ext::Extensions,
    /// lite models (YGG_MODELS `id:lite`): the short role + the lean tool set; unmarked = full
    tiers: HashMap<String, &'static str>,
    /// models that can see images (YGG_VISION_MODELS): a turn carrying an image runs on the first
    /// of them when the session's own model cannot (the door's glm-5.3 cannot; glm-5.3-flash can)
    vision: Vec<String>,
    tools_enabled: bool,
    rollup_tokens: usize,
    rollup_keep_tokens: usize,
    /// Voice-first mode: speech-shaped system prompt + speech sanitizer on stored text.
    voice: bool,
    voice_max_words: usize,
    /// variant stamped on new sessions (high|low|off) + the `high` thinking budget
    default_variant: String,
    think_high: u64,
}

/// `YGG_DEFAULT_VARIANT` → a valid variant (empty = `high`).
fn resolve_variant(raw: &str) -> Result<String, String> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "" => Ok("high".into()),
        v @ ("high" | "low" | "off") => Ok(v.into()),
        other => Err(format!("YGG_DEFAULT_VARIANT: unknown variant {other:?} (high | low | off)")),
    }
}

/// PER-TURN voice note (voice-turn-brevity): appended as the tail of every
/// stored user message with `info.modality == "voice"` when the upstream
/// conversation is built. Never in the system prompt / position 0 (cache law:
/// text turns and the cached prefix stay byte-identical). Independent of the
/// brain-wide YGG_VOICE / VOICE_PROMPT path below. Editing resets caches once.
const VOICE_TURN_NOTE: &str = "[voice turn] This reply will be spoken aloud: plain speech, leading with the answer, with no lists, bullets, tables, headers, markdown, or code. Keep it to a few short, concrete sentences — unless the user asked for more (a story, details, something read out): then give what they asked for. They can say stop, pause, faster or slower while it plays.";

fn is_voice_turn(msg: &Value) -> bool {
    msg["info"]["modality"] == "voice"
}

/// QUIET-ASSESS law (owner 11-10): the turn being answered was an automated
/// verdict request (`info.meta.auto`), so its reply is stamped `info.meta.autoReply`
/// and the deck does not speak it (unless it carries OWNER-ACTION:).
#[cfg(test)]
fn is_auto_turn(history: &[Value]) -> bool {
    history
        .iter()
        .rev()
        .find(|m| m["info"]["role"] == "user" && !is_compaction(m))
        .is_some_and(|m| m["info"]["meta"]["auto"] == true)
}

/// OG-ctx (opencode parity, 10-27; lost in the 11-10 merge, restored by root-coord): the layered
/// AGENTS.md chain as a system message, so a fresh session knows where it is without exploring.
/// Re-read every run (an edited file lands on the next turn); each file capped at 64 KiB;
/// missing or empty files are skipped.
fn context_prompt(files: &[PathBuf]) -> Option<String> {
    const CAP: usize = 64 * 1024;
    let parts: Vec<String> = files
        .iter()
        .filter_map(|f| {
            let mut text = std::fs::read_to_string(f).ok()?;
            if text.len() > CAP {
                let mut cut = CAP;
                while !text.is_char_boundary(cut) {
                    cut -= 1;
                }
                text.truncate(cut);
            }
            let text = text.trim();
            (!text.is_empty()).then(|| format!("Instructions from: {}\n{text}", f.display()))
        })
        .collect();
    (!parts.is_empty()).then(|| parts.join("\n\n"))
}

/// A session's profile name: its stamped agent if known, `coordinator` for [MAIN], else the
/// default (legacy sessions carry no agent).
fn profile_name_of(st: &AppState, info: &Value) -> String {
    let agents = st.config.profiles.read().unwrap();
    if let Some(a) = info["agent"].as_str().filter(|a| agents.get(a).is_some()) {
        return a.to_string();
    }
    if is_main_title(info["title"].as_str().unwrap_or_default()) {
        return "coordinator".into();
    }
    agents.default_agent.clone()
}

/// An agent by name (a copy: agents can be edited while sessions run).
fn agent(st: &AppState, name: &str) -> Option<profiles::Profile> {
    st.config.profiles.read().unwrap().get(name).cloned()
}

fn session_profile(st: &AppState, id: &str) -> profiles::Profile {
    let name = st.sessions.lock().unwrap().get(id).map(|s| s.info.clone()).map(|i| profile_name_of(st, &i));
    let agents = st.config.profiles.read().unwrap();
    let name = name.unwrap_or_else(|| agents.default_agent.clone());
    agents.get(&name).or_else(|| agents.get("build")).cloned().expect("build profile")
}

/// The phone resolves sessions by title slug (pwa lib/slug.ts): lowercase, whitespace → `-`,
/// only `[a-z0-9_-]`, 60 chars.
fn slug(title: &str) -> String {
    let s: String = title
        .to_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join("-")
        .chars()
        .filter(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == '_' || *c == '-')
        .collect();
    let s: String = s.chars().take(60).collect();
    if s.is_empty() { "session".into() } else { s }
}

/// Voice mode: shape model text for SPEECH — strip markdown, emoji and
/// typographic dashes, drop "if you want more — just ask" offer sentences,
/// cap at `max_words` on a sentence boundary. Reviewer finding: markdown and
/// emoji were being read aloud, and a one-tip question produced a 27s monologue.
fn sanitize_for_speech(s: &str, max_words: usize) -> String {
    let mut t = String::with_capacity(s.len());
    let mut in_fence = false;
    for line in s.lines() {
        let l = line.trim();
        if l.starts_with("```") {
            in_fence = !in_fence;
            continue;
        }
        if in_fence {
            continue;
        }
        if !t.is_empty() {
            t.push(' ');
        }
        t.push_str(l);
    }
    let mut t = t
        .replace('\u{2013}', " to ")
        .replace('\u{2014}', ", ")
        .replace(['*', '_', '`', '#', '>', '|', '[', ']'], "");
    // keep letters/digits/whitespace/plain punctuation — everything else (emoji,
    // pictographs, symbols) goes, so TTS never reads "sleeping face" aloud
    t = t
        .chars()
        .filter(|c| {
            c.is_whitespace() || c.is_alphanumeric() || ".,'!?;:()-%\"&/+".contains(*c)
        })
        .collect();
    let t = t.split_whitespace().collect::<Vec<_>>().join(" ");
    // drop offer/help-boilerplate sentences, then cap words at a sentence boundary
    let offer = |s: &str| {
        let l = s.to_lowercase();
        ["if you want", "if you need", "let me know", "feel free", "hope this", "just ask"]
            .iter()
            .any(|p| l.contains(p))
    };
    let mut out = String::new();
    let mut words = 0usize;
    for sent in t.split_inclusive(|c| c == '.' || c == '!' || c == '?') {
        let sent = sent.trim();
        if sent.is_empty() || offer(sent) {
            continue;
        }
        let w = sent.split_whitespace().count();
        if words > 0 && words + w > max_words {
            break;
        }
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(sent);
        words += w;
    }
    let mut kept: Vec<&str> = out.split_whitespace().collect();
    kept.truncate(max_words);
    kept.join(" ")
}

#[derive(Serialize, Deserialize)]
struct Session {
    info: Value,
    messages: Vec<Value>,
    /// Last `todowrite` list (opencode's `GET /session/:id/todo`).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    todo: Vec<Value>,
    /// root-coord: reports from the sessions this one manages (tree.rs) — never transcript turns.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    inbox: Vec<Value>,
}

#[derive(Clone)]
struct AppState {
    sessions: Arc<Mutex<HashMap<String, Session>>>,
    /// In-flight replies, keyed by session id; notified by `POST /session/:id/abort`.
    running: Arc<Mutex<HashMap<String, Arc<Notify>>>>,
    /// One run at a time per session (opencode serializes; stacked prompts wait their turn).
    /// Two-class gate: owner turns first, auto turns wait + coalesce (gate.rs).
    run_locks: Arc<Mutex<HashMap<String, Arc<gate::RunGate>>>>,
    /// Global event bus feeding `GET /event`: `{type, properties}` JSON, opencode-style.
    bus: broadcast::Sender<Value>,
    data_dir: Arc<PathBuf>,
    config: Arc<Config>,
    http: reqwest::Client,
    tools: Arc<tools::ToolEnv>,
    /// root-coord: upstream calls in flight across the whole tree (YGG_MAX_INFLIGHT)
    upstream: Arc<tokio::sync::Semaphore>,
    /// sessions with a tree wake pending (one at a time each)
    wakes: Arc<Mutex<HashSet<String>>>,
    /// harness processes (claude/opencode/codex) running at once (YGG_MAX_HARNESS)
    harness_slots: Arc<tokio::sync::Semaphore>,
    /// the models each harness offers (the agent editor's picker): claude's aliases, opencode's
    /// own `opencode models` (read at startup), codex's default until it is logged in
    harness_models: Arc<Mutex<HashMap<String, Vec<String>>>>,
    /// a short human label per harness model (picker hints): harness → model → label
    harness_labels: Arc<Mutex<HashMap<String, HashMap<String, String>>>>,
}

#[derive(Deserialize)]
struct PostMessage {
    #[serde(default)]
    parts: Vec<Value>,
    /// Per-turn modality of the sender ("voice" = the reply will be spoken).
    /// Absent/anything else = plain text turn.
    #[serde(default)]
    modality: Option<String>,
    /// Sender meta; only `auto` (an automated verdict request, not the owner
    /// speaking) is kept. QUIET-ASSESS law: such a turn's reply is stamped autoReply.
    #[serde(default)]
    meta: Option<Value>,
    /// silent-verdicts law: an internal turn (station/watcher traffic) is stored and
    /// reaches the agent context, but the owner-facing transcript omits it.
    /// Also accepted as `meta.internal` or `internal:true` on any part.
    #[serde(default)]
    internal: bool,
    /// ASYNC-DISPATCH: the requester session to call back (also `?origin=`); see `post_message`.
    #[serde(default)]
    origin: Option<String>,
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64
}

fn new_id(prefix: &str) -> String {
    format!("{prefix}_{}", uuid::Uuid::new_v4().simple())
}

/// `parts` without ids get them stamped, so stored messages look like opencode's.
fn make_message(session_id: &str, role: &str, parts: Vec<Value>) -> Value {
    let id = new_id("msg");
    let parts: Vec<Value> = parts
        .into_iter()
        .map(|mut p| {
            p["id"] = json!(new_id("prt"));
            p["messageID"] = json!(id);
            p["sessionID"] = json!(session_id);
            p
        })
        .collect();
    json!({
        "info": { "id": id, "sessionID": session_id, "role": role, "time": { "created": clock_now_ms() } },
        "parts": parts,
    })
}

fn text_part(text: &str) -> Value {
    json!({ "type": "text", "text": text })
}

fn message_text(msg: &Value) -> String {
    msg["parts"]
        .as_array()
        .map(|parts| {
            parts
                .iter()
                .filter(|p| p["type"] == "text")
                .filter_map(|p| p["text"].as_str())
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}

fn session_path(dir: &std::path::Path, id: &str) -> PathBuf {
    dir.join("session").join(format!("{id}.json"))
}

/// Writes the session atomically (tmp + rename). Called with the sessions lock held,
/// so writes for one session never interleave.
fn persist(dir: &std::path::Path, id: &str, session: &Session) {
    let path = session_path(dir, id);
    let tmp = path.with_extension("json.tmp");
    let res = serde_json::to_vec_pretty(session)
        .map_err(std::io::Error::other)
        .and_then(|bytes| std::fs::write(&tmp, bytes))
        .and_then(|_| std::fs::rename(&tmp, &path));
    if let Err(e) = res {
        eprintln!("persist {id}: {e}");
    }
}

fn load_sessions(dir: &std::path::Path) -> HashMap<String, Session> {
    let mut out = HashMap::new();
    let Ok(entries) = std::fs::read_dir(dir.join("session")) else { return out };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().is_none_or(|e| e != "json") {
            continue;
        }
        match std::fs::read(&path).map_err(|e| e.to_string()).and_then(|b| {
            serde_json::from_slice::<Session>(&b).map_err(|e| e.to_string())
        }) {
            Ok(mut s) => match s.info["id"].as_str().map(String::from) {
                Some(id) => {
                    // a session saved on Gemini CLI (gone 11-14) continues on Antigravity
                    if harness::migrate_session(&mut s.info) {
                        persist(dir, &id, &s);
                    }
                    out.insert(id, s);
                }
                None => eprintln!("skip {}: no info.id", path.display()),
            },
            Err(e) => eprintln!("skip {}: {e}", path.display()),
        }
    }
    out
}

/// Mutates one session under the lock, bumps `time.updated`, persists.
/// Returns `None` if the session is gone (deleted mid-run).
fn with_session<R>(st: &AppState, id: &str, f: impl FnOnce(&mut Session) -> R) -> Option<R> {
    let mut sessions = st.sessions.lock().unwrap();
    let s = sessions.get_mut(id)?;
    let r = f(s);
    s.info["time"]["updated"] = json!(now_ms());
    persist(&st.data_dir, id, s);
    Some(r)
}

/// Replaces a stored message (matched by `info.id`) — the assistant placeholder
/// is created at run start and filled in when the run ends.
fn replace_message(st: &AppState, sid: &str, msg: &Value) {
    with_session(st, sid, |s| {
        if let Some(slot) = s.messages.iter_mut().find(|m| m["info"]["id"] == msg["info"]["id"]) {
            *slot = msg.clone();
        } else {
            s.messages.push(msg.clone());
        }
    });
}

fn publish(st: &AppState, kind: &str, props: Value) {
    let _ = st.bus.send(json!({ "type": kind, "properties": props }));
}

/// Sends an event to the posting client's stream (named SSE event, slice-1 shape)
/// and to the global bus (`{type, properties}`).
async fn emit(st: &AppState, tx: &mpsc::Sender<Event>, kind: &str, props: Value) {
    publish(st, kind, props.clone());
    // The posting client may have gone away; the reply keeps going for /event listeners.
    let _ = tx.send(Event::default().event(kind).json_data(props).unwrap()).await;
}

fn not_found(id: &str) -> Response {
    (StatusCode::NOT_FOUND, Json(json!({ "name": "NotFoundError", "error": format!("session {id} not found") })))
        .into_response()
}

fn bad_request(msg: &str) -> Response {
    (StatusCode::BAD_REQUEST, Json(json!({ "error": msg }))).into_response()
}

/// Creates + stores a session. Profile (`agent`), model and thinking variant are stamped ONCE
/// here (cache law): explicit args win, then the profile's defaults, then the brain's.
fn new_session(st: &AppState, title: &str, parent: Option<&str>, agent: Option<&str>, model: Option<&str>, variant: Option<&str>) -> Value {
    let explicit_model = model;
    let id = new_id("ses");
    let now = now_ms();
    let mut info = json!({ "id": id, "title": title, "time": { "created": now, "updated": now } });
    // the coordinator is the door: MAIN's profile and no one else's (a "fix this" session started
    // from MAIN once inherited it — read-only, it could fix nothing)
    let agent_name = agent.filter(|a| *a != "coordinator" || is_main_title(title));
    if let Some(a) = agent_name.filter(|a| crate::agent(st, a).is_some()) {
        info["agent"] = json!(a);
    } else if is_main_title(title) {
        info["agent"] = json!("coordinator"); // the door is stamped, so the phone shows it right
    }
    let pname = profile_name_of(st, &info);
    // every session names its agent from birth (the default one included): the list's [TAG]
    info["agent"] = json!(pname);
    let prof = crate::agent(st, &pname);
    let prof = prof.as_ref();
    let model = model
        .filter(|m| st.config.models.iter().any(|x| x == m))
        .or(prof.and_then(|p| p.model.as_deref()).filter(|m| st.config.models.iter().any(|x| x == m)))
        .unwrap_or(&st.config.model);
    let variant = variant
        .and_then(|v| resolve_variant(v).ok())
        .or(prof.and_then(|p| p.variant.clone()))
        .unwrap_or_else(|| st.config.default_variant.clone());
    let provider = st.config.catalog["default"].as_object().and_then(|d| d.keys().next().cloned()).unwrap_or_else(|| "yggdrasil".into());
    info["model"] = json!({ "id": model, "providerID": provider, "variant": variant });
    // a harness session's model belongs to that harness (any id it accepts; none = its default)
    if let Some(h) = prof.and_then(|p| p.harness.clone()) {
        let hm = explicit_model.or(prof.and_then(|p| p.model.as_deref()));
        info["model"] = json!({ "id": hm.unwrap_or("default"), "providerID": h });
        info["harness"] = json!({ "kind": h });
    }
    if let Some(parent) = parent {
        info["parentID"] = json!(parent);
    }
    let session = Session { info: info.clone(), messages: Vec::new(), todo: Vec::new(), inbox: Vec::new() };
    {
        let mut sessions = st.sessions.lock().unwrap();
        persist(&st.data_dir, &id, &session);
        sessions.insert(id, session);
    }
    publish(st, "session.created", json!({ "info": info }));
    info
}

/// `POST /session` — body `{title?, parentID?, agent?, model?, variant?}` (opencode accepts an
/// empty body too; `model` may be a string or `{id}`). With `harness: {id}` + `cwd` it continues a
/// Claude Code conversation started in a terminal (`attach_claude`).
async fn create_session(State(st): State<AppState>, body: Option<Json<Value>>) -> Response {
    let body = body.map(|Json(b)| b).unwrap_or(Value::Null);
    if body["harness"]["id"].is_string() {
        return attach_claude(&st, &body);
    }
    let title = body["title"].as_str().filter(|t| !t.is_empty()).unwrap_or("New session");
    let model = body["model"].as_str().or(body["model"]["id"].as_str());
    let info = new_session(&st, title, body["parentID"].as_str(), body["agent"].as_str(), model, body["variant"].as_str());
    // a peer root asked for this session: its turns report home (peers.rs)
    if body["report_to"]["root"].is_string() && body["report_to"]["session"].is_string() {
        let id = info["id"].as_str().unwrap_or_default().to_string();
        if let Some(i) = with_session(&st, &id, |s| {
            s.info["report_to"] = body["report_to"].clone();
            s.info.clone()
        }) {
            return Json(i).into_response();
        }
    }
    Json(info).into_response()
}

/// `POST /session {agent?, harness: {id}, cwd}` — a session that continues the owner's own Claude
/// Code conversation `id` (started in a terminal in `cwd`) with its full context. The agent must run
/// on Claude Code (default AGI). Its first turn forks the conversation, so the terminal's transcript
/// is never written; Claude Code's permission guard stays on (harness.rs `Attach`).
fn attach_claude(st: &AppState, body: &Value) -> Response {
    let id = body["harness"]["id"].as_str().unwrap_or_default().trim();
    let agent_name = body["agent"].as_str().unwrap_or("AGI");
    match agent(st, agent_name) {
        Some(a) if a.harness.as_deref() == Some("claude") => {}
        Some(_) => return bad_request(&format!("agent {agent_name} does not run on Claude Code — continue a Claude Code session with AGI or another Claude Code agent")),
        None => return bad_request(&format!("unknown agent {agent_name}")),
    }
    if !harness::claude::is_uuid(id) {
        return bad_request(&format!("{id:?} is not a Claude Code session id (a uuid like 3f2a9c1e-0b4d-4e8f-9a6b-1c2d3e4f5a6b)"));
    }
    let Some(raw) = body["cwd"].as_str().map(str::trim).filter(|c| !c.is_empty()) else {
        return bad_request("cwd required: the folder the Claude Code session was started in");
    };
    let cwd = match raw.trim_end_matches('/') {
        "" => "/",
        c => c,
    };
    if !std::path::Path::new(cwd).is_absolute() || !std::path::Path::new(cwd).is_dir() {
        return bad_request(&format!("folder {cwd} does not exist on this root — the Claude Code session runs in the folder it was started in"));
    }
    let path = harness::claude::transcript(cwd, id);
    if !path.is_file() {
        return bad_request(&format!("no Claude Code session {id} was started in {cwd} (looked for {})", path.display()));
    }
    let title = harness::claude::meta(&path).and_then(|m| m["title"].as_str().map(String::from)).unwrap_or_else(|| "Claude Code session".into());
    let title = format!("{} · Claude Code", title.chars().take(40).collect::<String>().trim_end());
    let model = body["model"].as_str().or(body["model"]["id"].as_str());
    let info = new_session(st, &title, body["parentID"].as_str(), Some(agent_name), model, None);
    let sid = info["id"].as_str().unwrap_or_default().to_string();
    match with_session(st, &sid, |s| {
        s.info["harness"] = json!({ "kind": "claude", "id": id, "attached": true });
        s.info["cwd"] = json!(cwd);
        s.info.clone()
    }) {
        Some(info) => {
            publish(st, "session.updated", json!({ "info": info }));
            Json(info).into_response()
        }
        None => not_found(&sid),
    }
}

/// `GET /harness/claude/sessions` — the newest 20 Claude Code sessions on this box, to continue
/// one from the phone: `{id, cwd, modified, title}` (metadata only, harness.rs `claude`).
async fn claude_sessions() -> Json<Value> {
    Json(Value::Array(tokio::task::spawn_blocking(|| harness::claude::recent(20)).await.unwrap_or_default()))
}

/// `GET /tree` — every session's tree fields (id, title, parentID, agent, model, card, archived,
/// busy, depth), parents first; the phone draws the nested list from it.
async fn get_tree(State(st): State<AppState>) -> Json<Value> {
    let sessions = st.sessions.lock().unwrap();
    let running = st.running.lock().unwrap();
    let mut rows: Vec<Value> = sessions
        .iter()
        .map(|(id, s)| {
            json!({ "id": id, "title": s.info["title"], "parentID": s.info["parentID"], "agent": profile_name_of(&st, &s.info),
                "model": s.info["model"], "card": s.info["card"], "archived": s.info["archived"] == true,
                "busy": running.contains_key(id), "depth": tree::depth(&sessions, id),
                "inbox": s.inbox.iter().filter(|e| e["delivered"] != true).count(),
                "updated": s.info["time"]["updated"] })
        })
        .collect();
    rows.sort_by_key(|r| (r["depth"].as_u64().unwrap_or(0), std::cmp::Reverse(r["updated"].as_u64().unwrap_or(0))));
    Json(Value::Array(rows))
}

/// `GET /root` — what this root is (peers.rs).
async fn get_root(State(st): State<AppState>) -> Json<Value> {
    Json(peers::describe(&st))
}

/// `POST /tree/report` — a peer root reports a turn of a session this root asked it to run.
async fn tree_report(State(st): State<AppState>, headers: HeaderMap, Json(body): Json<Value>) -> Response {
    if !st.config.peers.authorized(&headers) {
        return (StatusCode::UNAUTHORIZED, Json(json!({ "error": "peer token" }))).into_response();
    }
    let Some(proxy) = body["proxy"].as_str() else { return bad_request("proxy required") };
    if tree::accept_report(&st, proxy, body["event"].clone()) { Json(true).into_response() } else { not_found(proxy) }
}

/// `POST /session/:id/close` — archive a session and its sub-sessions, aborting their runs.
async fn close_session(State(st): State<AppState>, Path(id): Path<String>, body: Option<Json<Value>>) -> Response {
    let reason = body.as_ref().and_then(|b| b["reason"].as_str()).unwrap_or("closed").to_string();
    match tree::archive_family(&st, &id, &reason) {
        Some(n) => Json(json!({ "closed": n })).into_response(),
        None => not_found(&id),
    }
}

/// A woken manager's "nothing worth saying" reply.
fn is_quiet(text: &str) -> bool {
    text.trim().trim_matches(|c: char| c == '.' || c == '*').eq_ignore_ascii_case("(quiet)")
}

/// Does the newest user turn of an upstream conversation contain `needle`?
fn last_user_has(convo: &[Value], needle: &str) -> bool {
    convo.iter().rev().find(|m| m["role"] == "user").is_some_and(|m| match &m["content"] {
        Value::String(s) => s.contains(needle),
        parts => parts.as_array().into_iter().flatten().any(|p| p["text"].as_str().is_some_and(|t| t.contains(needle))),
    })
}

/// The agent's system block as a model of `tier` reads it (`None` = nothing to say).
fn role_block(prof: &profiles::Profile, tier: &str) -> Option<String> {
    let role = prof.role_for(tier);
    (!role.trim().is_empty()).then(|| format!("[agent: {}]\n{role}", prof.name))
}

/// `lite` | `full` for a model id (YGG_MODELS `id:lite`; unmarked = full).
fn model_tier(st: &AppState, model: &str) -> &'static str {
    st.config.tiers.get(model).copied().unwrap_or("full")
}

/// Forgets a session (record + file) — a proxy whose peer refused the create.
fn drop_session(st: &AppState, id: &str) {
    st.sessions.lock().unwrap().remove(id);
    let _ = std::fs::remove_file(session_path(&st.data_dir, id));
}

/// `GET /session/:id/inbox` — the reports filed with this session (newest last).
async fn get_inbox(State(st): State<AppState>, Path(id): Path<String>) -> Response {
    match st.sessions.lock().unwrap().get(&id) {
        Some(s) => Json(Value::Array(s.inbox.clone())).into_response(),
        None => not_found(&id),
    }
}

/// `GET /session` — newest-updated first, like opencode.
async fn list_sessions(State(st): State<AppState>) -> Json<Value> {
    let mut infos: Vec<Value> = st.sessions.lock().unwrap().values().map(|s| s.info.clone()).collect();
    infos.sort_by_key(|i| std::cmp::Reverse(i["time"]["updated"].as_u64().unwrap_or(0)));
    infos.iter_mut().for_each(|i| with_agent(&st, i));
    Json(Value::Array(infos))
}

/// A session made before agents were stamped at birth names the agent it actually runs.
fn with_agent(st: &AppState, info: &mut Value) {
    if info["agent"].is_null() {
        info["agent"] = json!(profile_name_of(st, info));
    }
}

async fn get_session(State(st): State<AppState>, Path(id): Path<String>) -> Response {
    let info = st.sessions.lock().unwrap().get(&id).map(|s| s.info.clone());
    match info {
        Some(mut i) => {
            with_agent(&st, &mut i);
            Json(i).into_response()
        }
        None => not_found(&id),
    }
}

/// `PATCH /session/:id` — `{title}`.
async fn patch_session(State(st): State<AppState>, Path(id): Path<String>, Json(body): Json<Value>) -> Response {
    let info = with_session(&st, &id, |s| {
        if let Some(t) = body["title"].as_str() {
            s.info["title"] = json!(t);
        }
        s.info.clone()
    });
    match info {
        Some(info) => {
            publish(&st, "session.updated", json!({ "info": info }));
            Json(info).into_response()
        }
        None => not_found(&id),
    }
}

/// `DELETE /session/:id` — aborts a live run, drops the record + file. Returns `true`.
async fn delete_session(State(st): State<AppState>, Path(id): Path<String>) -> Response {
    let Some(s) = st.sessions.lock().unwrap().remove(&id) else { return not_found(&id) };
    if let Some(n) = st.running.lock().unwrap().remove(&id) {
        n.notify_one();
    }
    let _ = std::fs::remove_file(session_path(&st.data_dir, &id));
    publish(&st, "session.deleted", json!({ "info": s.info }));
    Json(true).into_response()
}

/// `GET /session/:id/todo` — the last `todowrite` list.
async fn get_todo(State(st): State<AppState>, Path(id): Path<String>) -> Response {
    match st.sessions.lock().unwrap().get(&id) {
        Some(s) => Json(Value::Array(s.todo.clone())).into_response(),
        None => not_found(&id),
    }
}

/// `GET /session/status` — opencode's busy map: only sessions with a live run appear.
async fn session_status(State(st): State<AppState>) -> Json<Value> {
    let running = st.running.lock().unwrap();
    Json(Value::Object(running.keys().map(|k| (k.clone(), json!({ "type": "busy" }))).collect()))
}

/// Internal-flagged turn (silent-verdicts law): agent-visible, owner-hidden.
fn is_internal(m: &Value) -> bool {
    m["info"]["meta"]["internal"] == true
}

fn transcript(messages: &[Value], with_internal: bool) -> Vec<Value> {
    messages.iter().filter(|m| with_internal || !is_internal(m)).cloned().collect()
}

/// Owner-facing transcript: internal turns are dropped unless `?internal=1` (debug/e2e).
async fn list_messages(
    State(st): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    let with_internal = q.get("internal").is_some_and(|v| v == "1" || v == "true");
    // a proxy reads its peer: the phone opens a session on another root through this one
    if let Some((root, rid)) = peers::remote_of(&st, &id) {
        return match peers::call(&st, &root, "GET", &format!("/session/{rid}/message"), None, 20).await {
            Ok(v) => Json(v).into_response(),
            Err(e) => (StatusCode::BAD_GATEWAY, Json(json!({ "error": e }))).into_response(),
        };
    }
    match st.sessions.lock().unwrap().get(&id) {
        Some(s) => Json(Value::Array(transcript(&s.messages, with_internal))).into_response(),
        None => not_found(&id),
    }
}

/// `POST /session/:id/abort` — like opencode: returns `true` if a reply was in flight.
async fn abort_session(State(st): State<AppState>, Path(id): Path<String>) -> Response {
    if !st.sessions.lock().unwrap().contains_key(&id) {
        return not_found(&id);
    }
    let handle = st.running.lock().unwrap().get(&id).cloned();
    match handle {
        Some(n) => {
            n.notify_one();
            Json(true).into_response()
        }
        None => Json(false).into_response(),
    }
}

/// `GET /config/providers` — `{providers, default}` from the catalog.
async fn config_providers(State(st): State<AppState>) -> Json<Value> {
    let c = &st.config.catalog;
    Json(json!({ "providers": c["providers"], "default": c.get("default").cloned().unwrap_or(json!({})) }))
}

/// `GET /agent` — `[{name, mode, description, ...}]`: the profiles (root-coord).
async fn list_agents(State(st): State<AppState>) -> Json<Value> {
    Json(st.config.profiles.read().unwrap().catalog())
}

/// `POST /api/session/:id/model` — v2 switch, `{model:{id, providerID}}` → 204.
/// The model must exist in the catalog. Recorded on the session; the upstream call
/// still goes to the one configured upstream model (single-provider relay).
async fn switch_model(State(st): State<AppState>, Path(id): Path<String>, Json(body): Json<Value>) -> Response {
    let (Some(mid), Some(pid)) = (body["model"]["id"].as_str(), body["model"]["providerID"].as_str()) else {
        return bad_request("model needs id + providerID");
    };
    // a session on a harness picks from that harness's models (providerID = the harness)
    if matches!(pid, "claude" | "opencode" | "codex" | "antigravity") {
        let on = st.sessions.lock().unwrap().get(&id).and_then(|s| s.info["harness"]["kind"].as_str().map(String::from));
        if on.as_deref() != Some(pid) {
            return bad_request(&format!("this session does not run on {pid}"));
        }
        let offered = models_for(&st, pid);
        let open = offered.len() == 1 && offered[0] == "default";
        if !open && !offered.iter().any(|m| m == mid) {
            return bad_request(&format!("{pid} does not offer {mid} ({})", offered.join(", ")));
        }
        return match with_session(&st, &id, |s| s.info["model"] = json!({ "id": mid, "providerID": pid })) {
            Some(()) => StatusCode::NO_CONTENT.into_response(),
            None => not_found(&id),
        };
    }
    let known = st.config.catalog["providers"]
        .as_array()
        .into_iter()
        .flatten()
        .any(|p| p["id"] == pid && p["models"].get(mid).is_some());
    if !known {
        return bad_request(&format!("unknown model {pid}/{mid}"));
    }
    // the phone's think picker sends a derived id `<model>-think-<level>`: a level is a variant
    let (mid, level) = match mid.rsplit_once("-think-") {
        Some((base, lvl)) if resolve_variant(lvl).is_ok() => (base, Some(lvl.to_string())),
        _ => (mid, None),
    };
    let mut model = json!({ "id": mid, "providerID": pid });
    match with_session(&st, &id, |s| {
        // an explicit level re-stamps thinking; otherwise the stamp survives the model switch
        match &level {
            Some(l) => model["variant"] = json!(l),
            None => {
                if let Some(v) = s.info["model"].get("variant").cloned() {
                    model["variant"] = v;
                }
            }
        }
        s.info["model"] = model
    }) {
        Some(()) => StatusCode::NO_CONTENT.into_response(),
        None => not_found(&id),
    }
}

/// `POST /api/session/:id/agent` — v2 switch, `{agent}` → 204. The session takes the agent's
/// defaults at once — its model and thinking level, and its harness (a different harness starts
/// a fresh harness session) — and keeps its history; the model can still be changed afterwards.
async fn switch_agent(State(st): State<AppState>, Path(id): Path<String>, Json(body): Json<Value>) -> Response {
    let Some(name) = body["agent"].as_str() else { return bad_request("agent required") };
    let main = st.sessions.lock().unwrap().get(&id).is_some_and(|s| is_main_title(s.info["title"].as_str().unwrap_or_default()));
    if name == "coordinator" && !main {
        return bad_request("the coordinator is MAIN's alone — pick build, lead, research, plan or a harness");
    }
    if main && name != "coordinator" {
        return bad_request("MAIN is the coordinator — it routes work to sessions; give the work to a session with this agent instead");
    }
    let Some(target) = agent(&st, name) else {
        return bad_request(&format!("unknown agent {name}"));
    };
    let stamp = agent_model_stamp(&st, &target);
    match with_session(&st, &id, |s| {
        s.info["agent"] = json!(name);
        s.info["model"] = stamp.clone();
        match &target.harness {
            Some(h) if s.info["harness"]["kind"].as_str() == Some(h.as_str()) => {}
            Some(h) => s.info["harness"] = json!({ "kind": h }),
            None => {
                if let Some(o) = s.info.as_object_mut() {
                    o.remove("harness");
                }
            }
        }
        s.info.clone()
    }) {
        Some(info) => {
            publish(&st, "session.updated", json!({ "info": info }));
            StatusCode::NO_CONTENT.into_response()
        }
        None => not_found(&id),
    }
}

/// The `info.model` an agent gives a session: its model (a root agent's must be one this
/// upstream serves) and thinking level, else the brain's defaults; a harness agent's model is
/// the harness's own (none = its default).
fn agent_model_stamp(st: &AppState, a: &profiles::Profile) -> Value {
    match &a.harness {
        Some(h) => json!({ "id": a.model.clone().unwrap_or_else(|| "default".into()), "providerID": h }),
        None => {
            let model = a.model.clone().filter(|m| st.config.models.contains(m)).unwrap_or_else(|| st.config.model.clone());
            let variant = a.variant.clone().unwrap_or_else(|| st.config.default_variant.clone());
            json!({ "id": model, "providerID": "yggdrasil", "variant": variant })
        }
    }
}

/// The shared prompt every agent reads first: the owner's (stored once) + what the extensions that
/// are up ask agents to know (their manifest `prompt`).
fn shared_prompt(st: &AppState) -> String {
    let shared = st.config.profiles.read().unwrap().shared.clone();
    match st.config.ext.prompt() {
        Some(x) => format!("{shared}\n\n{x}"),
        None => shared,
    }
}

/// What a Claude Code agent appends to Claude Code's own prompt: the shared prompt, then its role.
fn harness_system(shared: &str, prof: &profiles::Profile) -> String {
    let role = prof.role_for("full");
    if role.trim().is_empty() { shared.to_string() } else { format!("{shared}\n\n{role}") }
}

/// `GET /shared-prompt` — what every agent reads first; `custom` = edited by the owner.
async fn get_shared(State(st): State<AppState>) -> Json<Value> {
    let shared = st.config.profiles.read().unwrap().shared.clone();
    let default = profiles::default_shared();
    Json(json!({ "prompt": shared, "default": default, "custom": shared != default }))
}

/// `PUT /shared-prompt` `{prompt}` — edit it for every agent at once (empty = the default).
async fn put_shared(State(st): State<AppState>, Json(body): Json<Value>) -> Response {
    let res = st.config.profiles.write().unwrap().set_shared(body["prompt"].as_str().unwrap_or_default());
    match res {
        Ok(()) => {
            publish(&st, "agent.updated", json!({ "name": "*" }));
            get_shared(State(st)).await.into_response()
        }
        Err(e) => bad_request(&e),
    }
}

/// `GET /agent/:name` — everything the agent editor shows (+ what it may change).
async fn get_agent(State(st): State<AppState>, Path(name): Path<String>) -> Response {
    let detail = st.config.profiles.read().unwrap().detail(&name);
    match detail {
        Some(mut d) => {
            // everything the model reads before the conversation (read-only in the editor): the
            // preamble, the AGENTS.md chain, then the role (+ the intent section); a lite model, if
            // this root serves one, reads the short role
            let prof = agent(&st, &name).expect("detail implies the agent");
            let shared = shared_prompt(&st);
            d["system"] = json!(match &prof.harness {
                None => ["full", "lite"]
                    .iter()
                    .filter_map(|t| {
                        let models: Vec<&String> = st.config.models.iter().filter(|m| model_tier(&st, m) == *t).collect();
                        let mut parts = vec![shared.clone()];
                        parts.extend(context_prompt(&st.config.context_files));
                        parts.extend(role_block(&prof, t));
                        (!models.is_empty()).then(|| json!({ "tier": t, "models": models, "text": parts.join("\n\n") }))
                    })
                    .collect::<Vec<_>>(),
                Some(h) => vec![json!({ "tier": h, "models": [], "text": if h == "claude" {
                    format!("Claude Code brings its own system prompt; this agent adds:\n\n{}", harness_system(&shared, &prof))
                } else if h == "antigravity" {
                    format!("Antigravity brings its own system prompt; this agent's first message adds:\n\n{}", harness_system(&shared, &prof))
                } else {
                    format!("{h} brings its own system prompt (it takes no extra instructions)")
                } })],
            });
            // the models this agent can pick from: the upstream's for a root agent, else its harness's
            d["models"] = json!(models_for(&st, d["harness"].as_str().unwrap_or("root")));
            // every harness's list, so the editor's picker follows a harness change before saving
            d["models_by_harness"] = json!(["root", "claude", "opencode", "codex", "antigravity"].iter().map(|h| (h.to_string(), json!(models_for(&st, h)))).collect::<serde_json::Map<_, _>>());
            d["model_labels"] = json!(st.harness_labels.lock().unwrap().clone());
            Json(d).into_response()
        }
        None => (StatusCode::NOT_FOUND, Json(json!({ "error": format!("no agent {name}") }))).into_response(),
    }
}

/// `PUT /agent/:name` — create or edit (partial body); answers the new detail.
async fn put_agent(State(st): State<AppState>, Path(name): Path<String>, Json(body): Json<Value>) -> Response {
    if let Some(m) = body["model"].as_str().filter(|m| !m.is_empty()) {
        let harness = body["harness"].as_str().map(String::from).unwrap_or_else(|| {
            agent(&st, &name).and_then(|a| a.harness).unwrap_or_else(|| "root".into())
        });
        let offered = models_for(&st, &harness);
        // a harness whose list is only "default" (not logged in, list not read) takes any id
        let open = offered.len() == 1 && offered[0] == "default";
        if !open && !offered.iter().any(|x| x == m) {
            return bad_request(&format!("model {m} is not offered by {harness} ({})", offered.join(", ")));
        }
    }
    let res = st.config.profiles.write().unwrap().upsert(&name, &body);
    match res {
        Ok(()) => {
            publish(&st, "agent.updated", json!({ "name": name }));
            get_agent(State(st), Path(name)).await
        }
        Err(e) => bad_request(&e),
    }
}

/// The models an agent on `harness` can use (root = what this upstream serves).
fn models_for(st: &AppState, harness: &str) -> Vec<String> {
    if harness == "root" {
        return st.config.models.clone();
    }
    st.harness_models.lock().unwrap().get(harness).cloned().unwrap_or_else(|| vec!["default".into()])
}

/// Reads each harness's own model list once at startup: `opencode models` (its providers'
/// `provider/model` ids) and `codex debug models` (its catalog: listed slugs by priority, with
/// display names). A harness that cannot be read keeps "default" (any id then accepted).
fn spawn_harness_models(app: &AppState) {
    let st = app.clone();
    tokio::spawn(async move {
        let run = |cmd: &'static str, args: &'static [&'static str]| async move {
            tokio::time::timeout(Duration::from_secs(90), tokio::process::Command::new(cmd).args(args).output())
                .await
                .ok()
                .and_then(Result::ok)
                .filter(|o| o.status.success())
                .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
        };
        if let Some(out) = run("opencode", &["models"]).await {
            let list: Vec<String> = out.lines().map(str::trim).filter(|l| l.contains('/') && !l.contains(' ')).map(String::from).collect();
            if !list.is_empty() {
                eprintln!("harness models: opencode offers {}", list.len());
                st.harness_models.lock().unwrap().insert("opencode".into(), list);
            }
        }
        if let Some(out) = run("codex", &["debug", "models"]).await {
            let v: Value = serde_json::from_str(&out).unwrap_or(Value::Null);
            let mut ms: Vec<&Value> = v["models"].as_array().into_iter().flatten().filter(|m| m["visibility"] == "list" && m["slug"].is_string()).collect();
            ms.sort_by_key(|m| m["priority"].as_i64().unwrap_or(999));
            let list: Vec<String> = ms.iter().filter_map(|m| m["slug"].as_str().map(String::from)).collect();
            let labels: HashMap<String, String> = ms
                .iter()
                .filter_map(|m| {
                    let first = m["description"].as_str().unwrap_or_default().split(". ").next().unwrap_or_default().trim_end_matches('.');
                    Some((m["slug"].as_str()?.to_string(), format!("{} — {first}", m["display_name"].as_str().unwrap_or_default())))
                })
                .collect();
            if !list.is_empty() {
                eprintln!("harness models: codex offers {}", list.len());
                st.harness_models.lock().unwrap().insert("codex".into(), list);
                st.harness_labels.lock().unwrap().insert("codex".into(), labels);
            }
        }
    });
    // `agy models` (`slug<TAB>label` lines; exit 1 when signed out), on its own (it needs no wait
    // for the others), merged with Google's current models — the floor stays when agy says nothing
    let st = app.clone();
    tokio::spawn(async move {
        let out = tokio::time::timeout(Duration::from_secs(60), tokio::process::Command::new("agy").arg("models").kill_on_drop(true).output())
            .await
            .ok()
            .and_then(Result::ok)
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).to_string());
        let (list, labels) = harness::antigravity::models(out.as_deref(), harness::antigravity::api_key());
        eprintln!("harness models: antigravity offers {}{}", list.len(), if out.is_some() { "" } else { " (agy did not list: Google's current models)" });
        st.harness_models.lock().unwrap().insert("antigravity".into(), list);
        st.harness_labels.lock().unwrap().insert("antigravity".into(), labels);
    });
}

/// `DELETE /agent/:name` — only agents you made.
async fn delete_agent(State(st): State<AppState>, Path(name): Path<String>) -> Response {
    let res = st.config.profiles.write().unwrap().remove(&name);
    match res {
        Ok(()) => {
            publish(&st, "agent.updated", json!({ "name": name, "deleted": true }));
            Json(true).into_response()
        }
        Err(e) => bad_request(&e),
    }
}

/// `GET /event` — global SSE stream of every event for every session.
async fn events(State(st): State<AppState>) -> Response {
    let rx = st.bus.subscribe();
    let hello = futures::stream::once(async { json!({ "type": "server.connected", "properties": {} }) });
    // Lagged receivers just skip what they missed.
    let stream = hello
        .chain(BroadcastStream::new(rx).filter_map(|r| async move { r.ok() }))
        .map(|v| Ok::<_, Infallible>(Event::default().json_data(v).unwrap()));
    Sse::new(stream).keep_alive(KeepAlive::default()).into_response()
}

/// ASYNC-DISPATCH (owner law 11-12: post it, it posts back on done). `?async=1` answers at once
/// with `{turn_id, origin, sessionID, status:"queued"}` (turn_id = the stored user message id)
/// instead of holding the POST until the run ends. When that turn finishes, the brain posts a
/// completion auto-turn to the ORIGIN session (`meta.auto` → its reply is stamped autoReply,
/// QUIET-ASSESS law) carrying the turn id + terminal status. Origin = `?origin=<sid>` or body
/// `origin`; absent = the `[MAIN]` coordinator (same rule as watch-landings); `none` = no callback.
async fn post_message(
    State(st): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
    Json(body): Json<PostMessage>,
) -> Response {
    let is_async = q.get("async").is_some_and(|v| v == "1" || v == "true");
    // a proxy forwards to its peer (the peer reports the turn home by itself)
    if let Some((root, rid)) = peers::remote_of(&st, &id) {
        let body = json!({ "parts": body.parts, "modality": body.modality });
        let path = if is_async { format!("/session/{rid}/message?async=1&origin=none") } else { format!("/session/{rid}/message") };
        with_session(&st, &id, |s| s.info["card"]["status"] = json!("working"));
        return match peers::call(&st, &root, "POST", &path, Some(body), 900).await {
            Ok(v) => Json(v).into_response(),
            Err(e) => (StatusCode::BAD_GATEWAY, Json(json!({ "error": e }))).into_response(),
        };
    }
    let origin = if is_async {
        match resolve_origin(&st, &id, q.get("origin").or(body.origin.as_ref()).map(String::as_str)) {
            Ok(o) => o,
            Err(r) => return r,
        }
    } else {
        None
    };
    let want_sse = headers
        .get(header::ACCEPT)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|a| a.contains("text/event-stream"));
    let auto_turn = body.meta.as_ref().is_some_and(|m| m["auto"] == true);
    let internal = body.internal
        || body.meta.as_ref().is_some_and(|m| m["internal"] == true)
        || body.parts.iter().any(|p| p["internal"] == true);
    // root-coord: automation posting to the door (watcher landings, lane verdict requests)
    // becomes an inbox report, digested like a session's turn — not a turn in MAIN's
    // transcript. The POST answers at once with the stored (internal) record.
    let door = st.sessions.lock().unwrap().get(&id).map(|s| profile_name_of(&st, &s.info)).as_deref() == Some("coordinator");
    if door && auto_turn && !is_async {
        let text = body.parts.iter().filter(|p| p["type"] == "text").filter_map(|p| p["text"].as_str()).collect::<Vec<_>>().join("\n");
        if text.trim().is_empty() {
            return bad_request("no text parts");
        }
        let mut rec = make_message(&id, "user", vec![json!({ "type": "text", "text": text, "internal": true })]);
        rec["info"]["meta"] = json!({ "auto": true, "internal": true, "inbox": true });
        // stored for the audit trail only: folded so it never reaches the coordinator's context
        let mut stub = make_message(&id, "assistant", vec![text_part("(filed in the inbox)")]);
        stub["info"]["meta"] = json!({ "autoReply": true, "internal": true, "folded": true });
        stub["info"]["time"]["completed"] = json!(now_ms());
        if with_session(&st, &id, |s| {
            s.messages.push(rec.clone());
            s.messages.push(stub.clone());
        })
        .is_none()
        {
            return not_found(&id);
        }
        tree::external_report(&st, &id, &text);
        return Json(stub).into_response();
    }
    let turn = Turn { parts: body.parts, modality: body.modality, auto_turn, internal, origin: origin.clone(), completes: None };
    let (user_msg, rx, done_rx) = match submit(&st, &id, turn) {
        Ok(t) => t,
        Err(r) => return r,
    };
    if is_async {
        return Json(json!({ "turn_id": user_msg["info"]["id"], "origin": origin, "sessionID": id, "status": "queued" }))
            .into_response();
    }
    if want_sse {
        return Sse::new(ReceiverStream::new(rx).map(Ok::<_, Infallible>)).into_response();
    }
    // opencode shape: the POST resolves when the run ends, with the assistant message.
    drop(rx);
    match done_rx.await {
        Ok(Ok(msg)) => Json(msg).into_response(),
        Ok(Err(e)) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e }))).into_response(),
        Err(_) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": "run task died" }))).into_response(),
    }
}

/// The async callback target: an explicit origin must exist and differ from the target;
/// absent = the newest `[MAIN]` (unless it is the target); `none`/empty = no callback.
fn resolve_origin(st: &AppState, target: &str, asked: Option<&str>) -> Result<Option<String>, Response> {
    let sessions = st.sessions.lock().unwrap();
    match asked {
        Some("") | Some("none") => Ok(None),
        Some(o) if o == target => Err(bad_request("origin is the target session (a turn cannot call itself back)")),
        Some(o) if !sessions.contains_key(o) => Err(bad_request(&format!("unknown origin session {o}"))),
        Some(o) => Ok(Some(o.to_string())),
        None => Ok(sessions
            .values()
            .filter(|s| is_main_title(s.info["title"].as_str().unwrap_or_default()))
            .max_by_key(|s| s.info["time"]["updated"].as_u64().unwrap_or(0))
            .and_then(|s| s.info["id"].as_str().map(String::from))
            .filter(|m| m != target)),
    }
}

/// One posted turn, as `submit` takes it (HTTP POST or a brain-made completion turn).
struct Turn {
    parts: Vec<Value>,
    modality: Option<String>,
    auto_turn: bool,
    internal: bool,
    /// ASYNC-DISPATCH: post the completion auto-turn here when this turn ends.
    origin: Option<String>,
    /// ASYNC-DISPATCH: this turn IS a completion — stored as `meta.async`.
    completes: Option<Value>,
}

type Submitted = (Value, mpsc::Receiver<Event>, oneshot::Receiver<Result<Value, String>>);

/// Stores the user message at once, takes a gate ticket, spawns the run. Returns the stored
/// user message, the per-request event stream, and the run's result.
fn submit(st: &AppState, id: &str, turn: Turn) -> Result<Submitted, Response> {
    let Turn { parts, modality, auto_turn, internal, origin, completes } = turn;
    // Text parts go upstream; file parts (data: URLs) are stored so the transcript keeps them.
    let parts: Vec<Value> = parts
        .into_iter()
        .filter(|p| (p["type"] == "text" && p["text"].is_string()) || (p["type"] == "file" && p["url"].is_string()))
        .collect();
    if parts.is_empty() {
        return Err(bad_request("no text or file parts"));
    }

    // The user message lands at once (a stacked prompt is visible while it waits its turn).
    let mut user_msg = make_message(id, "user", parts);
    if internal {
        for p in user_msg["parts"].as_array_mut().unwrap() {
            p["internal"] = json!(true);
        }
    }
    if modality.as_deref() == Some("voice") {
        // stored on the message: the note renders from history on EVERY later
        // turn too, so the cached prefix never changes (see VOICE_TURN_NOTE)
        user_msg["info"]["modality"] = json!("voice");
    }
    if auto_turn {
        user_msg["info"]["meta"] = json!({ "auto": true });
    }
    if internal {
        user_msg["info"]["meta"]["internal"] = json!(true);
    }
    if let Some(o) = &origin {
        user_msg["info"]["meta"]["origin"] = json!(o);
    }
    if let Some(c) = completes {
        user_msg["info"]["meta"]["async"] = c;
    }
    let prof = session_profile(st, id);
    // root-coord: the door's owner turn carries every undelivered report, frozen on the
    // message at creation (rendered as `[inbox since your last turn]` — cache law)
    if prof.name == "coordinator" && !auto_turn && !internal {
        let lines = tree::owner_inbox_lines(st, id);
        if !lines.is_empty() {
            user_msg["info"]["meta"]["inbox_lines"] = json!(lines);
        }
    }
    let stored = with_session(st, id, |s| {
        // Freeze the meanwhile lines at creation (same moment as `created`).
        let prev = s
            .messages
            .iter()
            .filter(|m| m["info"]["role"] == "user" && !is_compaction(m))
            .filter_map(|m| m["info"]["time"]["created"].as_i64())
            .last();
        let mw = meanwhile_for(prev);
        if !mw.is_empty() {
            user_msg["info"]["time"]["meanwhile"] = json!(mw);
        }
        s.messages.push(user_msg.clone());
        // folding is a profile choice (the door's speed law), never a brain-wide one: a
        // working session keeps its whole history (roll-up summarizes it when it is long)
        if prof.fold {
            collapse_stale_station(&mut s.messages);
            collapse_stale_owner(&mut s.messages);
        }
    });
    if stored.is_none() {
        return Err(not_found(id));
    }
    if !internal {
        publish(st, "message.updated", json!({ "info": user_msg["info"] }));
    }

    let enqueued = std::time::Instant::now(); // LAT queue_ms: enqueue → run slot
    let gate = st.run_locks.lock().unwrap().entry(id.to_string()).or_default().clone();
    let ticket = gate.ticket(auto_turn);
    let (tx, rx) = mpsc::channel::<Event>(64);
    let (done_tx, done_rx) = oneshot::channel::<Result<Value, String>>();
    let (st, id, turn_id) = (st.clone(), id.to_string(), user_msg["info"]["id"].as_str().unwrap_or_default().to_string());
    tokio::spawn(async move {
        let result = match gate.admit(&ticket).await {
            gate::Admit::Go(mut permit) => {
                let queue_ms = enqueued.elapsed().as_millis() as u64;
                let result = run_turn(&st, &id, &tx, queue_ms, auto_turn).await;
                permit.finish(&result);
                let _ = done_tx.send(result.clone());
                // roll-up runs AFTER the reply, still inside the run slot (item 2)
                rollup_after_reply(&st, &id, &tx).await;
                result
            }
            gate::Admit::Coalesced(rx) => {
                let result = rx.await.unwrap_or_else(|_| Err("coalesced auto turn dropped".into()));
                let _ = done_tx.send(result.clone());
                result
            }
        };
        drop(ticket);
        // root-coord: a session under a manager reports into its inbox (digest + card + wake);
        // a plain async origin outside the tree keeps the 11-12 completion turn
        match tree::report_target(&st, &id, origin.as_deref()) {
            Some(target) => tree::on_turn_end(&st, &id, target, result),
            None => {
                if let Some(origin) = origin {
                    post_completion(&st, &origin, &id, &turn_id, &result);
                }
            }
        }
    });
    Ok((user_msg, rx, done_rx))
}

/// Terminal status of a finished turn: `completed` | `error` | `aborted` | `failed` (no reply).
fn async_status(result: &Result<Value, String>) -> &'static str {
    match result {
        Err(_) => "failed",
        Ok(m) if m["info"]["error"]["name"] == "MessageAbortedError" => "aborted",
        Ok(m) if !m["info"]["error"].is_null() => "error",
        Ok(_) => "completed",
    }
}

/// The completion auto-turn's text part: one header line the coordinator reads, then the
/// reply's head (or the failure) so it can assess without a fetch.
fn completion_text(target: &str, title: &str, turn_id: &str, result: &Result<Value, String>) -> String {
    let status = async_status(result);
    let (reply_id, body) = match result {
        Ok(m) => {
            let err = m["info"]["error"]["data"]["message"].as_str().map(|e| format!("error: {e}\n")).unwrap_or_default();
            (m["info"]["id"].as_str().unwrap_or("-").to_string(), format!("{err}{}", message_text(m)))
        }
        Err(e) => ("-".to_string(), format!("error: {e}")),
    };
    let mut body: String = body.trim().chars().take(600).collect();
    if body.is_empty() {
        body = "(no reply text)".into();
    }
    format!("ASYNC-DONE turn={turn_id} session={target} title={title:?} status={status} reply={reply_id}\n{body}")
}

/// Posts the completion auto-turn to the origin (`meta.auto` + `meta.async` = {turn_id,
/// sessionID, status, replyID}); the origin runs it as an auto-class turn (gate: behind owner
/// turns, coalesced with other pending autos), its reply stamped autoReply. Never async itself.
fn post_completion(st: &AppState, origin: &str, target: &str, turn_id: &str, result: &Result<Value, String>) {
    let title = st.sessions.lock().unwrap().get(target).and_then(|s| s.info["title"].as_str().map(String::from)).unwrap_or_default();
    let status = async_status(result);
    let reply_id = result.as_ref().ok().and_then(|m| m["info"]["id"].as_str()).unwrap_or_default().to_string();
    let text = completion_text(target, &title, turn_id, result);
    let done = json!({ "turn_id": turn_id, "sessionID": target, "status": status, "replyID": reply_id });
    let turn = Turn { parts: vec![text_part(&text)], modality: None, auto_turn: true, internal: false, origin: None,
        completes: Some(done.clone()) };
    match submit(st, origin, turn) {
        Ok((msg, _, _)) => {
            let cid = msg["info"]["id"].clone();
            eprintln!("async {turn_id}: {target} {status} -> completion {} posted to {origin}", cid.as_str().unwrap_or_default());
            publish(st, "async.completed", json!({ "origin": origin, "completionID": cid, "async": done }));
        }
        Err(_) => eprintln!("async {turn_id}: {target} {status} -> origin {origin} gone, completion dropped"),
    }
}

/// A restart kills every run in flight: their placeholders (assistant, never completed) are
/// closed as errors so the transcript and the tree stop waiting on them. Returns their sessions.
fn close_interrupted(sessions: &mut HashMap<String, Session>, data_dir: &std::path::Path) -> Vec<String> {
    let mut out = Vec::new();
    for (id, s) in sessions.iter_mut() {
        let Some(last) = s.messages.last_mut() else { continue };
        if last["info"]["role"] != "assistant" || last["info"]["time"]["completed"].is_number() {
            continue;
        }
        last["info"]["time"]["completed"] = json!(now_ms());
        last["info"]["error"] = json!({ "name": "UnknownError", "data": { "message": "interrupted by a brain restart" } });
        if s.info["card"].is_object() {
            s.info["card"]["status"] = json!("failed");
        }
        persist(data_dir, id, s);
        out.push(id.clone());
    }
    out
}

/// Rebuilds the upstream conversation from stored messages. Assistant messages replay
/// their steps: text, then the step's tool calls, then one `tool` message per result —
/// a tool part closes a step, the next text part opens a new one. Unfinished tool parts
/// (no result) are skipped: the upstream rejects a call without its result.
fn upstream_history(messages: &[Value]) -> Vec<Value> {
    fn flush(out: &mut Vec<Value>, text: &mut String, calls: &mut Vec<Value>, results: &mut Vec<Value>) {
        if text.is_empty() && calls.is_empty() {
            return;
        }
        let content = if text.is_empty() { Value::Null } else { json!(text) };
        let mut a = json!({ "role": "assistant", "content": content });
        if !calls.is_empty() {
            a["tool_calls"] = json!(std::mem::take(calls));
        }
        out.push(a);
        out.append(results);
        text.clear();
    }
    let mut out = Vec::new();
    let start = last_compaction(messages);
    // images ride the newest two user turns as image parts (older ones as a one-line note):
    // what the model is asked about now, without re-sending every photo of the session
    let users: Vec<usize> = (0..messages.len()).filter(|&i| messages[i]["info"]["role"] == "user" && !is_compaction(&messages[i])).collect();
    let recent_from = users.len().checked_sub(2).map(|k| users[k]).unwrap_or(0);
    // previous non-compaction user message's created ms; the chain runs over
    // the whole stored session so it survives the compaction boundary
    let mut prev: Option<i64> = None;
    let mut skip_reply = false;
    for (i, m) in messages.iter().enumerate() {
        let role = m["info"]["role"].as_str().unwrap_or("user");
        let compaction = is_compaction(m);
        let created = m["info"]["time"]["created"].as_i64();
        let this_prev = prev;
        if role == "user" && !compaction && created.is_some() {
            prev = created;
        }
        if i < start {
            continue;
        }
        // root-coord: automation records filed in the inbox never reach a model
        if m["info"]["meta"]["inbox"] == true {
            continue;
        }
        if role == "user" && !compaction {
            skip_reply = false;
            if let Some(d) = m["info"]["meta"]["digest"].as_str() {
                // frozen one-line station turn; its autoReply is folded into the line
                out.push(json!({ "role": "user", "content": d }));
                skip_reply = true;
                continue;
            }
        }
        if role == "assistant" && ((skip_reply && m["info"]["meta"]["autoReply"] == true) || m["info"]["meta"]["folded"] == true) {
            continue;
        }
        if role != "assistant" {
            let mut text = if compaction { rollup::COMPACTION_ASK.to_string() } else { message_text(m) };
            if role == "user" && !compaction {
                if let Some(lines) = m["info"]["meta"]["inbox_lines"].as_array().filter(|l| !l.is_empty()) {
                    // frozen at creation (tree::owner_inbox_lines): byte-stable every turn
                    let mut pre = String::from("[inbox since your last turn]\n");
                    for l in lines.iter().filter_map(|l| l.as_str()) {
                        pre.push_str(&format!("- {l}\n"));
                    }
                    text = format!("{pre}{text}");
                }
            }
            if role == "user" && !compaction && !text.is_empty() && is_voice_turn(m) {
                // last text block of the stored voice turn; a pure function of
                // stored history, so earlier bytes never change (cache law)
                text.push('\n');
                text.push_str(VOICE_TURN_NOTE);
            }
            let images: Vec<&str> = if role == "user" && !compaction {
                m["parts"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|p| p["type"] == "file" && p["mime"].as_str().is_some_and(|t| t.starts_with("image/")))
                    .filter_map(|p| p["url"].as_str().filter(|u| u.starts_with("data:")))
                    .collect()
            } else {
                Vec::new()
            };
            if !images.is_empty() && i < recent_from {
                text = format!("{text}\n[{} image(s) attached earlier]", images.len());
            }
            if !text.is_empty() || !images.is_empty() {
                let content = if images.is_empty() || i < recent_from {
                    json!(text)
                } else {
                    let mut parts = vec![json!({ "type": "text", "text": if text.is_empty() { "(image)".to_string() } else { text.clone() } })];
                    parts.extend(images.iter().map(|u| json!({ "type": "image_url", "image_url": { "url": u } })));
                    Value::Array(parts)
                };
                let mut u = json!({ "role": role, "content": content });
                // Private header vehicle for apply_clock_headers (stripped before send).
                if role == "user" && !compaction {
                    if let Some(ts) = created { u["_ts"] = json!(ts); }
                    if let Some(p) = this_prev { u["_prev"] = json!(p); }
                    if let Some(mw) = m["info"]["time"].get("meanwhile") { u["_mw"] = mw.clone(); }
                }
                out.push(u);
            }
            continue;
        }
        let (mut text, mut calls, mut results) = (String::new(), Vec::new(), Vec::new());
        for p in m["parts"].as_array().into_iter().flatten() {
            match p["type"].as_str() {
                Some("text") => {
                    if !calls.is_empty() {
                        flush(&mut out, &mut text, &mut calls, &mut results);
                    }
                    let t = p["text"].as_str().unwrap_or_default();
                    if !text.is_empty() && !t.is_empty() {
                        text.push('\n');
                    }
                    text.push_str(t);
                }
                Some("tool") => {
                    let state = &p["state"];
                    let status = state["status"].as_str().unwrap_or_default();
                    if status != "completed" && status != "error" {
                        continue;
                    }
                    calls.push(json!({ "id": p["callID"], "type": "function",
                        "function": { "name": p["tool"], "arguments": state["input"].to_string() } }));
                    results.push(json!({ "role": "tool", "tool_call_id": p["callID"], "content": tool_content(state) }));
                }
                _ => {}
            }
        }
        flush(&mut out, &mut text, &mut calls, &mut results);
    }
    out
}

/// Station turns (auto user message + its reply) kept verbatim in the upstream view.
/// fold-tighten-r1: 3 -> 2 (upstream prefill dominated MAIN's p95).
const STATION_KEEP: usize = 2;
/// Owner exchanges (owner user message + its reply, tool steps included) kept verbatim.
/// fold-tighten-r1: 3 -> 2.
const OWNER_KEEP: usize = 2;

fn first_line(s: &str, max: usize) -> String {
    let l = s.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or_default();
    let mut out: String = l.chars().take(max).collect();
    if l.chars().count() > max {
        out.push('…');
    }
    out
}

/// Item 2 (cache law): freeze each station turn older than the last `STATION_KEEP` into one
/// line, stored on the user message (`info.meta.digest`) at store time. A digest is written
/// once and never recomputed, so every later request renders the same bytes there. Owner turns
/// and anything unanswered stay verbatim; the stored transcript (UI) is untouched.
fn collapse_stale_station(messages: &mut [Value]) {
    let autos: Vec<usize> = (0..messages.len())
        .filter(|&i| messages[i]["info"]["role"] == "user" && messages[i]["info"]["meta"]["auto"] == true)
        .collect();
    if autos.len() <= STATION_KEEP {
        return;
    }
    for &i in &autos[..autos.len() - STATION_KEEP] {
        if messages[i]["info"]["meta"]["digest"].is_string() {
            continue;
        }
        let answered = messages[i + 1..]
            .iter()
            .any(|m| m["info"]["role"] == "assistant" && m["info"]["time"]["completed"].is_number());
        if !answered {
            continue;
        }
        // fold-tighten-r1 hard fold: every reply up to the next user turn (autoReply or not,
        // tool steps included) goes into the one digest line and is marked folded.
        let end = (i + 1..messages.len())
            .find(|&j| messages[j]["info"]["role"] == "user" && !is_compaction(&messages[j]))
            .unwrap_or(messages.len());
        let replies: Vec<usize> = (i + 1..end).filter(|&j| messages[j]["info"]["role"] == "assistant").collect();
        let first_done = replies.iter().copied().find(|&j| messages[j]["info"]["time"]["completed"].is_number());
        let line = match first_done {
            Some(j) => format!("[station turn] {} => {}", first_line(&message_text(&messages[i]), 160), first_line(&message_text(&messages[j]), 160)),
            None => format!("[station turn] {}", first_line(&message_text(&messages[i]), 160)),
        };
        messages[i]["info"]["meta"]["digest"] = json!(line);
        for j in replies {
            messages[j]["info"]["meta"]["folded"] = json!(true);
        }
    }
}

/// p95-fold-r1 (cache law): same mechanism for owner/coordinator exchanges older than the last
/// `OWNER_KEEP`. The user message gets a frozen `info.meta.digest` line and its reply is marked
/// `info.meta.folded` (skipped by `upstream_history`; the stored transcript stays whole). Runs at
/// store time only; a fold is written once and never reversed, so each aging exchange costs one
/// cache miss, then the prefix is stable again.
fn collapse_stale_owner(messages: &mut [Value]) {
    let owners: Vec<usize> = (0..messages.len())
        .filter(|&i| {
            messages[i]["info"]["role"] == "user"
                && messages[i]["info"]["meta"]["auto"] != true
                && !is_compaction(&messages[i])
        })
        .collect();
    if owners.len() <= OWNER_KEEP {
        return;
    }
    let aged = owners.len() - OWNER_KEEP;
    for k in 0..aged {
        let i = owners[k];
        if messages[i]["info"]["meta"]["digest"].is_string() {
            continue;
        }
        // everything this owner turn caused: up to (not including) the next owner turn
        let end = owners[k + 1];
        let replies: Vec<usize> = (i + 1..end)
            .filter(|&j| messages[j]["info"]["role"] == "assistant" && messages[j]["info"]["meta"]["autoReply"] != true)
            .collect();
        let first_done = replies.iter().copied().find(|&j| messages[j]["info"]["time"]["completed"].is_number());
        let line = match first_done {
            Some(j) => format!("[earlier turn] {} => {}", first_line(&message_text(&messages[i]), 160), first_line(&message_text(&messages[j]), 160)),
            None => format!("[earlier turn] {} => (no reply recorded)", first_line(&message_text(&messages[i]), 160)),
        };
        messages[i]["info"]["meta"]["digest"] = json!(line);
        for j in replies {
            messages[j]["info"]["meta"]["folded"] = json!(true);
        }
    }
}

fn is_compaction(msg: &Value) -> bool {
    msg["parts"].as_array().is_some_and(|ps| ps.iter().any(|p| p["type"] == "compaction"))
}

/// Index of the latest compaction message (the upstream history starts there), or 0.
fn last_compaction(messages: &[Value]) -> usize {
    messages.iter().rposition(is_compaction).unwrap_or(0)
}

/// What the model sees for a finished tool part.
fn tool_content(state: &Value) -> String {
    let output = state["output"].as_str().unwrap_or_default();
    if state["status"] == "error" { format!("Error: {output}") } else { output.to_string() }
}

#[derive(Default)]
struct ToolCall {
    id: String,
    name: String,
    arguments: String,
}

/// A run in progress: the assistant message being built (parts appended per step) and
/// the current step's streamed text. Lives outside the loop future so an abort (which
/// drops that future) keeps everything produced so far.
struct Run {
    msg: Value,
    text: String,
    started: std::time::Instant,
    /// Reviewer metric gap closed: ms from run start to the first streamed
    /// content delta — the REAL time-to-first-sound the voice user feels.
    first_delta_ms: Option<u64>,
    /// SPEED LAW (11-05, owner [RUN]): upstream calls this run made, how many
    /// needed a resilience retry, and where the first token came from. These
    /// ride the one-line latency log and the message's info.time.
    upstream_calls: u32,
    retries: u32,
    /// true when the FIRST content token arrived — a run whose first step
    /// streamed zero text but later steps did is exactly the slow shape
    /// the 31s-fallback bug wore.
    first_token_seen: bool,
    /// the turn being answered carried VOICE_TURN_NOTE (LAT voice_note=0|1)
    voice_note: bool,
    /// chars of upstream `thinking` this run (LAT reasoning_chars)
    reasoning_chars: usize,
    /// LAT session=<id> queue_ms=<enqueue→run slot> (coordinator ≤5s law)
    session: String,
    queue_ms: u64,
    /// LAT think=<budget_tokens sent upstream, 0 = no thinking param> (wire proof)
    think: u64,
    /// root-coord: this run's steps go out with thinking off (the empty-step retry)
    think_off: bool,
    /// the turn being answered carries an image: it runs on a vision model
    vision: bool,
}

impl Run {
    fn push_part(&mut self, part: Value) -> usize {
        let mut part = part;
        part["id"] = json!(new_id("prt"));
        part["messageID"] = self.msg["info"]["id"].clone();
        part["sessionID"] = self.msg["info"]["sessionID"].clone();
        let parts = self.msg["parts"].as_array_mut().unwrap();
        parts.push(part);
        parts.len() - 1
    }

    /// Lands the streamed text of the current step as a text part.
    fn flush_text(&mut self, voice: Option<(bool, usize)>) {
        let text = std::mem::take(&mut self.text);
        if !text.is_empty() {
            let text = match voice {
                Some((true, max)) => sanitize_for_speech(&text, max),
                _ => text,
            };
            if !text.is_empty() {
                self.push_part(text_part(&text));
            }
        }
    }

    /// Closes the message: pending text kept, interrupted tool calls marked as errors,
    /// and at least one text part (the PWA reads the reply from text parts).
    fn finish(&mut self, interrupted: &str) {
        self.flush_text(None);
        let now = now_ms();
        let mut has_text = false;
        for p in self.msg["parts"].as_array_mut().unwrap() {
            has_text |= p["type"] == "text";
            if p["type"] == "tool" && p["state"]["status"] == "running" {
                p["state"]["status"] = json!("error");
                p["state"]["error"] = json!(interrupted);
                p["state"]["output"] = json!(interrupted);
                p["state"]["time"]["end"] = json!(now);
            }
        }
        if !has_text {
            self.push_part(text_part(""));
        }
        self.msg["info"]["time"]["completed"] = json!(now);
    }

    /// SPEED LAW one-line log + info.time latency fields. `phase` is the end
    /// state ("ok" / "aborted" / the error string). The brain-side numbers are
    /// queuing → upstream-connect → first-token → total; STT/TTS/transport
    /// land in the FULL-STACK breakdown (e2e + agent logs) and are joined in
    /// the LATENCY-BREAKDOWN artifact. msg_parts notes a zero-text first step
    /// (tool-only) — the shape that hid the 31s fallback.
    fn lat_log(&mut self, phase: &str) {
        let total = self.started.elapsed().as_millis() as u64;
        let ttfb = self.first_delta_ms.unwrap_or(0);
        let steps = self.msg["parts"].as_array().map(|p| p.len()).unwrap_or(0);
        let tool_steps = self
            .msg["parts"]
            .as_array()
            .map(|p| p.iter().filter(|x| x["type"] == "tool").count())
            .unwrap_or(0);
        eprintln!(
            "LAT phase={} total_ms={} ttfb_ms={} steps={} tool_steps={} msg_parts={} calls={} retries={} first_token={} voice_note={} reasoning_chars={} session={} queue_ms={} think={}",
            phase, total, ttfb, steps, tool_steps, steps, self.upstream_calls, self.retries, self.first_token_seen,
            self.voice_note as u8, self.reasoning_chars, self.session, self.queue_ms, self.think
        );
        self.msg["info"]["time"]["latency"] = json!({
            "total_ms": total,
            "queue_ms": self.queue_ms,
            "ttfb_ms": ttfb,
            "upstream_calls": self.upstream_calls,
            "retries": self.retries,
            "first_token": self.first_token_seen,
            "phase": phase,
        });
    }
}

/// One run, called with the session's run lock held: snapshot history, create the
/// un-completed assistant placeholder, run the agent loop (abortable), store the
/// outcome, then `session.idle`. Returns the final assistant message (aborted ones included).
async fn run_turn(st: &AppState, id: &str, tx: &mpsc::Sender<Event>, queue_ms: u64, auto_class: bool) -> Result<Value, String> {
    let history = st.sessions.lock().unwrap().get(id).map(|s| s.messages.clone());
    let Some(history) = history else { return Err(format!("session {id} not found")) };

    let cancel = Arc::new(Notify::new());
    st.running.lock().unwrap().insert(id.to_string(), cancel.clone());
    publish(st, "session.status", json!({ "sessionID": id, "status": { "type": "busy" } }));
    let placeholder = make_message(id, "assistant", vec![text_part("")]);
    replace_message(st, id, &placeholder);
    publish(st, "message.updated", json!({ "info": placeholder["info"] }));

    let mut msg = placeholder;
    msg["parts"] = json!([]);
    let voice_note = history
        .iter()
        .rev()
        .find(|m| m["info"]["role"] == "user" && !is_compaction(m))
        .is_some_and(is_voice_turn);
    // the gate class decides, not the newest stored user message: with owner-first ordering an
    // owner turn can run while a later auto message is already stored (and vice versa)
    let auto_turn = auto_class;
    let mut run = Run {
        msg,
        text: String::new(),
        started: std::time::Instant::now(),
        first_delta_ms: None,
        upstream_calls: 0,
        retries: 0,
        first_token_seen: false,
        voice_note,
        reasoning_chars: 0,
        session: id.to_string(),
        queue_ms,
        think: 0,
        think_off: false,
        vision: history
            .iter()
            .rev()
            .find(|m| m["info"]["role"] == "user" && !is_compaction(m))
            .and_then(|m| m["parts"].as_array())
            .is_some_and(|ps| ps.iter().any(|p| p["type"] == "file" && p["mime"].as_str().is_some_and(|t| t.starts_with("image/")))),
    };
    let harness = session_profile(st, id).harness.as_deref().and_then(harness::Kind::parse);
    let outcome = {
        let fut = async {
            match harness {
                Some(kind) => harness_loop(st, id, history, tx, &mut run, kind).await,
                None => agent_loop(st, id, history, tx, &mut run).await,
            }
        };
        tokio::select! {
            r = fut => Some(r),
            _ = cancel.notified() => None,
        }
    };
    // Only clear our own entry; a delete may already have removed it.
    {
        let mut running = st.running.lock().unwrap();
        if running.get(id).is_some_and(|n| Arc::ptr_eq(n, &cancel)) {
            running.remove(id);
        }
    }
    let result = match outcome {
        Some(Ok(())) => {
            if let Some(ms) = run.first_delta_ms {
                run.msg["info"]["time"]["first_delta"] = json!(ms);
            }
            run.finish("interrupted");
            run.lat_log("ok");
            if auto_turn {
                run.msg["info"]["meta"] = json!({ "autoReply": true });
                // a woken manager with nothing worth saying stays out of the transcript
                if is_quiet(&message_text(&run.msg)) {
                    run.msg["info"]["meta"]["internal"] = json!(true);
                }
            }
            replace_message(st, id, &run.msg);
            publish(st, "message.updated", json!({ "info": run.msg["info"] }));
            emit(st, tx, "message.completed", run.msg.clone()).await;
            Ok(run.msg)
        }
        Some(Err(e)) => {
            eprintln!("run error: {e}");
            run.finish(&e);
            run.lat_log(&format!("error: {}", &e[..e.len().min(120)]));
            run.msg["info"]["error"] = json!({ "name": "UnknownError", "data": { "message": e } });
            replace_message(st, id, &run.msg);
            emit(st, tx, "error", json!({ "sessionID": id, "error": e })).await;
            Err(e)
        }
        None => {
            // Keep whatever was streamed/executed, flagged the way opencode flags it.
            run.finish("aborted");
            run.lat_log("aborted");
            run.msg["info"]["error"] = json!({ "name": "MessageAbortedError", "data": { "message": "aborted" } });
            replace_message(st, id, &run.msg);
            publish(st, "message.updated", json!({ "info": run.msg["info"] }));
            emit(st, tx, "message.aborted", run.msg.clone()).await;
            Ok(run.msg)
        }
    };
    publish(st, "session.idle", json!({ "sessionID": id }));
    result
}

/// A harness session's turn: the newest user message goes to the harness, which resumes its own
/// session (`info.harness.id`). Its text streams as deltas, its tool calls land as completed tool
/// parts, its final answer is the reply; the harness session id is kept for the next turn.
async fn harness_loop(st: &AppState, id: &str, history: Vec<Value>, tx: &mpsc::Sender<Event>, run: &mut Run, kind: harness::Kind) -> Result<(), String> {
    let prompt = history.iter().rev().find(|m| m["info"]["role"] == "user" && !is_compaction(m)).map(message_text).unwrap_or_default();
    if prompt.trim().is_empty() {
        return Err("nothing to send".into());
    }
    let (model, resume, cwd, dir, h) = {
        let sessions = st.sessions.lock().unwrap();
        let info = sessions.get(id).map(|s| s.info.clone()).unwrap_or_default();
        let model = info["model"]["id"].as_str().filter(|m| *m != "default").map(String::from);
        let dir = info["cwd"].as_str().unwrap_or("?").to_string();
        let cwd = info["cwd"].as_str().map(PathBuf::from).filter(|p| p.is_dir());
        // only this harness's own session id resumes (another harness's would not be found)
        let resume = info["harness"]["id"].as_str().filter(|_| info["harness"]["kind"] == kind.name()).map(String::from);
        (model, resume, cwd, dir, info["harness"].clone())
    };
    // a conversation continued from the terminal: guarded always, forked on its first turn here
    let attached = kind == harness::Kind::Claude && h["attached"] == true;
    let attach = harness::Attach { guarded: attached, fork: attached && h["forked"] != true };
    let cwd = match cwd {
        Some(c) => c,
        // its folder is where Claude Code finds the conversation: never run it anywhere else
        None if attached => return Err(format!("the folder this Claude Code session was started in ({dir}) is gone")),
        None => st.tools.project_dir.clone(),
    };
    // the shared prompt + the agent's own instructions ride on top of the harness's (Claude Code)
    let system = Some(harness_system(&shared_prompt(st), &session_profile(st, id)));
    let _slot = st.harness_slots.acquire().await.map_err(|e| e.to_string())?;
    let (etx, mut erx) = mpsc::unbounded_channel::<harness::Ev>();
    let fut = harness::run(kind, model.as_deref(), resume.as_deref(), &cwd, &prompt, system.as_deref(), attach, move |ev| {
        let _ = etx.send(ev.clone());
    });
    tokio::pin!(fut);
    let result = loop {
        tokio::select! {
            r = &mut fut => break r,
            Some(ev) = erx.recv() => harness_event(st, id, tx, run, ev).await,
        }
    };
    while let Ok(ev) = erx.try_recv() {
        harness_event(st, id, tx, run, ev).await;
    }
    let out = result?;
    if let Some(sid) = &out.session {
        let next = if attached {
            // the fork is the session from now on; a turn that did not fork (same id back) forks again
            let forked = h["forked"] == true || (attach.fork && Some(sid) != resume.as_ref());
            let origin = h["origin"].as_str().map(String::from).or(resume.clone());
            json!({ "kind": kind.name(), "id": sid, "attached": true, "forked": forked, "origin": origin })
        } else {
            json!({ "kind": kind.name(), "id": sid })
        };
        with_session(st, id, |s| s.info["harness"] = next);
    }
    run.text = out.text;
    run.flush_text(None);
    Ok(())
}

async fn harness_event(st: &AppState, id: &str, tx: &mpsc::Sender<Event>, run: &mut Run, ev: harness::Ev) {
    match ev {
        harness::Ev::Text(t) => {
            if run.first_delta_ms.is_none() {
                run.first_delta_ms = Some(run.started.elapsed().as_millis() as u64);
                run.first_token_seen = true;
            }
            send_delta(st, id, tx, &format!("{t}\n\n")).await;
        }
        harness::Ev::Delta(t) => {
            if run.first_delta_ms.is_none() {
                run.first_delta_ms = Some(run.started.elapsed().as_millis() as u64);
                run.first_token_seen = true;
            }
            send_delta(st, id, tx, &t).await;
        }
        harness::Ev::Tool { name, input, output } => {
            let now = now_ms();
            let idx = run.push_part(json!({ "type": "tool", "callID": new_id("call"), "tool": name,
                "state": { "status": "completed", "input": input, "output": output, "title": name, "time": { "start": now, "end": now } } }));
            let part = run.msg["parts"][idx].clone();
            replace_message(st, id, &run.msg);
            emit(st, tx, "message.part.updated", json!({ "sessionID": id, "part": part })).await;
        }
        _ => {}
    }
}

/// The agent loop: call upstream; no tool calls → done; else execute each call
/// (serially, in order), append the results, call again. At most `max_steps` upstream
/// calls per run — the cap turns a model that never stops calling tools into an error.
async fn agent_loop(
    st: &AppState,
    id: &str,
    messages: Vec<Value>,
    tx: &mpsc::Sender<Event>,
    run: &mut Run,
) -> Result<(), String> {
    let mut convo = upstream_history(&messages); // roll-up runs AFTER the reply (rollup_after_reply)
    // TIME-AWARENESS + CACHE LAW: static preamble at position 0; each user
    // turn carries a header derived purely from stored created timestamps
    // (this turn's message was stamped ≈ now), so history is byte-stable.
    // Private `_` fields are stripped here, before ANY dialect sends.
    let prof = session_profile(st, id);
    if prof.fold {
        cap_digest_lines(&mut convo);
    }
    // root-coord: a managing session's newest turn carries the live [tree] view (only the
    // newest — earlier turns keep their bytes, so the cached prefix holds)
    if prof.sessions {
        if let Some(last) = convo.iter_mut().rev().find(|m| m["role"] == "user") {
            append_text(last, &tree::snapshot(st, id));
        }
    }
    apply_clock_headers(&mut convo, &shared_prompt(st));
    // static system block (cache law, all three are constant for the session's life):
    // preamble · the AGENTS.md chain (OG-ctx) · the profile's role. The 10-04 brain-wide voice
    // prompt is gone: voice brevity rides only the voice turns (VOICE_TURN_NOTE).
    let mut at = 1;
    if let Some(ctx) = context_prompt(&st.config.context_files) {
        convo.insert(at, json!({ "role": "system", "content": ctx }));
        at += 1;
    }
    // the role text fits the model's tier (cache law: the model is stamped per session, so the
    // bytes stay constant)
    let (model, _, _) = session_upstream(st, id);
    if let Some(role) = role_block(&prof, model_tier(st, &model)) {
        convo.insert(at, json!({ "role": "system", "content": role }));
    }
    // awareness (owner 11-13): the newest turn also says how big this session's context is, next to
    // the clock header's gap since the last user turn (only the newest: earlier turns keep their bytes)
    let tokens = rollup::est_tokens(&convo);
    if let Some(last) = convo.iter_mut().rev().find(|m| m["role"] == "user") {
        prefix_text(last, &context_line(tokens, st.config.rollup_tokens));
    }
    let max = prof.steps.unwrap_or(st.config.max_steps).min(st.config.max_steps).max(1);
    let mut quiet_nudged = false;
    for _ in 0..max {
        if st.config.rollup_tokens > 0 {
            let n = rollup::prune(&mut convo, st.config.rollup_tokens);
            if n > 0 {
                eprintln!("roll-up: pruned {n} old tool output(s) in session {id}");
            }
        }
        let calls = relay(st, id, &convo, tx, run).await?;
        // root-coord: a step that came back with nothing (GLM can spend the whole token cap
        // thinking: sim research-build 11-12, 273 s, 60k reasoning chars, no text, no tools)
        // is retried ONCE with thinking off and a one-line nudge to act
        if calls.is_empty() && run.text.trim().is_empty() && !run.think_off {
            run.think_off = true;
            eprintln!("LAT-EMPTY session={id} step came back empty (reasoning_chars={}) — retrying once with thinking off", run.reasoning_chars);
            convo.push(json!({ "role": "user", "content": "(Your previous response came back empty — the thinking ran out of room. Do not deliberate further: act now with your tools, or answer.)" }));
            continue;
        }
        // root-coord: a door answering an outcome wake with (quiet) is retried ONCE — the user is
        // waiting for that result (11-13: a MAIN whose history held a run of quiet replies kept
        // drifting into it even when the wake no longer offered it)
        if calls.is_empty() && !quiet_nudged && is_quiet(&run.text) && last_user_has(&convo, tree::OUTCOME_ASK) {
            quiet_nudged = true;
            eprintln!("TREE quiet-on-outcome session={id} — retrying once");
            run.text.clear();
            convo.push(json!({ "role": "assistant", "content": "(quiet)" }));
            convo.push(json!({ "role": "user", "content": "(quiet) is not an option here: the report above is a result the user is waiting for. Tell them now — the result and its evidence, in one to four sentences." }));
            continue;
        }
        if run.first_delta_ms.is_none() && calls.is_empty() {
            // SPEED LAW, loud: the final upstream step returned ZERO content
            // tokens — the exact shape that once hid a slow fallback behind
            // a tool-only first step. Never silent.
            eprintln!(
                "LAT-NO-TOKEN upstream_final_no_content total_ms={} ttfb_ms=0 calls={} retries={} first_token=false phase=error-text-empty",
                run.started.elapsed().as_millis(),
                run.upstream_calls,
                run.retries
            );
        }
        let text = run.text.clone();
        // speech shaping only when this reply will be spoken (a voice turn), never brain-wide
        run.flush_text(Some((st.config.voice && run.voice_note, st.config.voice_max_words)));
        if calls.is_empty() {
            return Ok(());
        }
        let calls: Vec<ToolCall> = calls
            .into_iter()
            .map(|mut c| {
                if c.id.is_empty() {
                    c.id = new_id("call");
                }
                c
            })
            .collect();
        convo.push(json!({
            "role": "assistant",
            "content": if text.is_empty() { Value::Null } else { json!(text) },
            "tool_calls": calls.iter().map(|c| json!({ "id": c.id, "type": "function",
                "function": { "name": c.name, "arguments": c.arguments } })).collect::<Vec<_>>(),
        }));
        for call in calls {
            let output = run_tool(st, id, tx, run, &call).await;
            convo.push(json!({ "role": "tool", "tool_call_id": call.id, "content": output }));
        }
    }
    Err(format!("agent loop hit the step cap ({max} upstream calls) without a final reply"))
}

/// The coordinator session is the one titled `[MAIN]` (same rule as watch-landings resolve_main).
fn is_main_title(title: &str) -> bool {
    title.trim() == "[MAIN]"
}

/// The door's context keeps between 12 and 23 one-line digests of older exchanges; the cut
/// moves every 12 turns, so the cached prefix changes once per 12 turns, not every turn.
fn cap_digest_lines(convo: &mut Vec<Value>) {
    const KEEP: usize = 12;
    let idx: Vec<usize> = convo
        .iter()
        .enumerate()
        .filter(|(_, m)| m["role"] == "user" && m["content"].as_str().is_some_and(|c| c.starts_with("[earlier turn]") || c.starts_with("[station turn]")))
        .map(|(i, _)| i)
        .collect();
    if idx.len() < 2 * KEEP {
        return;
    }
    let keep = KEEP + (idx.len() - KEEP) % KEEP;
    let drop: HashSet<usize> = idx[..idx.len() - keep].iter().copied().collect();
    let mut i = 0;
    convo.retain(|_| {
        let k = !drop.contains(&i);
        i += 1;
        k
    });
}

/// Roll-up moved out of the turn (item 2): the reply is already delivered, so the
/// synchronous summarize call never sits in the owner's latency.
async fn rollup_after_reply(st: &AppState, id: &str, tx: &mpsc::Sender<Event>) {
    let msgs = st.sessions.lock().unwrap().get(id).map(|s| s.messages.clone());
    if let Some(msgs) = msgs {
        let _ = rollup_if_needed(st, id, tx, msgs).await;
    }
}

/// Slice 6b. Over the token limit at run start: summarize everything before the recent
/// tail with one extra upstream call, store the compaction pair in front of the tail, and
/// return the shortened upstream history. Any failure keeps the full history (logged).
async fn rollup_if_needed(st: &AppState, id: &str, tx: &mpsc::Sender<Event>, messages: Vec<Value>) -> Vec<Value> {
    let convo = upstream_history(&messages);
    let limit = st.config.rollup_tokens;
    if limit == 0 || rollup::est_tokens(&convo) <= limit {
        return convo;
    }
    // The tail starts at a user message and fits the keep budget (the current prompt always stays).
    let start = last_compaction(&messages);
    let live = &messages[start..];
    let (mut cut, mut acc) = (None, 0);
    for i in (0..live.len()).rev() {
        acc += rollup::est_tokens(&upstream_history(&live[i..=i]));
        if acc > st.config.rollup_keep_tokens && cut.is_some() {
            break;
        }
        if live[i]["info"]["role"] == "user" && !is_compaction(&live[i]) {
            cut = Some(i);
        }
    }
    let cut = cut.unwrap_or(0);
    let covered = upstream_history(&live[..cut]);
    if !live[..cut].iter().any(|m| !is_compaction(m) && m["info"]["summary"] != true) {
        return convo; // nothing new to fold in; in-run pruning is all that's left
    }
    let req = json!([
        { "role": "system", "content": rollup::PROMPT },
        { "role": "user", "content": rollup::transcript(&covered) },
    ]);
    let summary = match summarize(st, &req).await {
        Ok(s) if !s.trim().is_empty() => s,
        Ok(_) => {
            eprintln!("roll-up {id}: empty summary, keeping full history");
            return convo;
        }
        Err(e) => {
            eprintln!("roll-up {id}: {e}; keeping full history");
            return convo;
        }
    };
    let ask = make_message(id, "user", vec![json!({ "type": "compaction", "auto": true })]);
    let mut sum = make_message(id, "assistant", vec![text_part(&summary)]);
    sum["info"]["summary"] = json!(true);
    sum["info"]["mode"] = json!("compaction");
    sum["info"]["time"]["completed"] = json!(now_ms());
    let anchor = live[cut]["info"]["id"].clone();
    with_session(st, id, |s| {
        let at = s.messages.iter().position(|m| m["info"]["id"] == anchor).unwrap_or(s.messages.len());
        s.messages.splice(at..at, [ask.clone(), sum.clone()]);
    });
    for m in [&ask, &sum] {
        publish(st, "message.updated", json!({ "info": m["info"] }));
    }
    let before = rollup::est_tokens(&convo);
    let mut rolled: Vec<Value> = messages[..start + cut].to_vec();
    rolled.extend([ask, sum.clone()]);
    rolled.extend_from_slice(&live[cut..]);
    let convo = upstream_history(&rolled);
    let after = rollup::est_tokens(&convo);
    eprintln!("roll-up {id}: {cut} message(s) summarized, ~{before} -> ~{after} tokens");
    emit(st, tx, "session.compacted", json!({ "sessionID": id, "messageID": sum["info"]["id"],
        "summarized": cut, "tokensBefore": before, "tokensAfter": after })).await;
    convo
}

/// The roll-up's extra upstream call: no tools, no streaming to the client.
async fn summarize(st: &AppState, messages: &Value) -> Result<String, String> {
    let cfg = &st.config;
    if cfg.dialect == Dialect::Anthropic {
        return summarize_anthropic(st, messages).await;
    }
    let url = format!("{}/chat/completions", cfg.base_url.trim_end_matches('/'));
    let mut req = st.http.post(&url).json(&json!({ "model": cfg.model, "messages": messages, "stream": false }));
    if let Some(key) = &cfg.api_key {
        req = req.bearer_auth(key);
    }
    let mut orphan_retries = 0u32;
    let resp = send_with_retry(&req, &mut orphan_retries).await?;
    let status = resp.status();
    let body = resp.text().await.map_err(|e| format!("read failed: {e}"))?;
    if !status.is_success() {
        return Err(format!("upstream {status}: {body}"));
    }
    if let Ok(v) = serde_json::from_str::<Value>(&body) {
        return Ok(v["choices"][0]["message"]["content"].as_str().unwrap_or_default().to_string());
    }
    // Some providers stream regardless of `stream: false`.
    Ok(body
        .lines()
        .filter_map(|l| l.trim().strip_prefix("data:"))
        .filter_map(|d| serde_json::from_str::<Value>(d.trim()).ok())
        .filter_map(|v| v["choices"][0]["delta"]["content"].as_str().map(String::from))
        .collect())
}

/// Executes one call: stores a running tool part, emits `message.part.updated`, runs it,
/// stores + emits the finished part, checkpoints the message to disk. Returns what the
/// model gets back.
async fn run_tool(st: &AppState, id: &str, tx: &mpsc::Sender<Event>, run: &mut Run, call: &ToolCall) -> String {
    let args = if call.arguments.trim().is_empty() { "{}" } else { call.arguments.as_str() };
    let parsed = serde_json::from_str::<Value>(args).map_err(|e| format!("invalid JSON arguments: {e}"));
    let input = parsed.as_ref().ok().cloned().unwrap_or_else(|| json!({ "raw": call.arguments }));
    let start = now_ms();
    let idx = run.push_part(json!({
        "type": "tool", "callID": call.id, "tool": call.name,
        "state": { "status": "running", "input": input, "time": { "start": start } },
    }));
    let part = run.msg["parts"][idx].clone();
    replace_message(st, id, &run.msg);
    emit(st, tx, "message.part.updated", json!({ "sessionID": id, "part": part })).await;

    let res = match parsed {
        Ok(input) => {
            // root-coord: the session's profile decides, at dispatch (opencode ruleset); an
            // extension's tool by its scope (ext.rs)
            let prof = session_profile(st, id);
            if st.config.ext.owns(&call.name) {
                if st.config.ext.allows(&prof, &call.name) {
                    ext::call(st, id, &call.name, &input).await
                } else {
                    let refusal = format!("permission denied: the {} profile may not run {} here", prof.name, call.name);
                    tools::ToolResult { ok: false, title: call.name.clone(), output: refusal, metadata: json!({ "denied": true }) }
                }
            } else {
                match prof.check(&call.name, &input) {
                    Err(refusal) => tools::ToolResult { ok: false, title: call.name.clone(), output: refusal, metadata: json!({ "denied": true }) },
                    Ok(()) if tree::is_tree_tool(&call.name) => {
                        let o = tree::run(st, id, &call.name, &input).await;
                        tools::ToolResult { ok: o.ok, title: call.name.clone(), output: o.output, metadata: o.metadata }
                    }
                    Ok(()) => tools::run(&st.tools, &call.name, &input).await,
                }
            }
        }
        Err(e) => tools::ToolResult { ok: false, title: call.name.clone(), output: e, metadata: json!({}) },
    };
    if call.name == "todowrite" && res.ok {
        let todos = res.metadata["todos"].as_array().cloned().unwrap_or_default();
        with_session(st, id, |s| s.todo = todos.clone());
        publish(st, "todo.updated", json!({ "sessionID": id, "todos": todos }));
    }
    let state = &mut run.msg["parts"][idx]["state"];
    state["status"] = json!(if res.ok { "completed" } else { "error" });
    state["title"] = json!(res.title);
    state["output"] = json!(res.output);
    if !res.ok {
        state["error"] = json!(res.output);
    }
    state["metadata"] = res.metadata;
    state["time"]["end"] = json!(now_ms());
    let content = tool_content(state);
    let part = run.msg["parts"][idx].clone();
    replace_message(st, id, &run.msg);
    emit(st, tx, "message.part.updated", json!({ "sessionID": id, "part": part })).await;
    content
}

/// Provider resilience (measured: three 529-overloaded incidents in one night
/// cost real turns). One retry, 1.8s apart, ONLY on transient upstream states
/// (529 overloaded / 503 unavailable). 429 balance and 401 fail immediately —
/// a real account problem must not hide behind a retry.
async fn send_with_retry(req: &reqwest::RequestBuilder, retries: &mut u32) -> Result<reqwest::Response, String> {
    // root-coord: a RATE limit (429 rate_limit_error — a busy tree on one key) backs off and
    // retries (3, 8, 20, 45 s); a balance/quota 429 and a 401 still fail at once
    const BACKOFF_MS: [u64; 4] = [3000, 8000, 20_000, 45_000];
    let mut attempt = 0usize;
    loop {
        let resp = req
            .try_clone()
            .ok_or("request not cloneable")?
            .send()
            .await
            .map_err(|e| format!("request failed: {e}"))?;
        let code = resp.status().as_u16();
        let transient = code == 529 || code == 503;
        if code == 429 {
            let body = resp.text().await.unwrap_or_default();
            let low = body.to_lowercase();
            let quota = ["balance", "quota", "insufficient", "billing", "exceeded your"].iter().any(|k| low.contains(k));
            if quota || attempt >= BACKOFF_MS.len() {
                return Err(format!("upstream 429 Too Many Requests: {body}"));
            }
            eprintln!("LAT-RETRY upstream 429 rate limit — backing off {} ms (retry #{})", BACKOFF_MS[attempt], attempt + 1);
        } else if transient && attempt < 1 {
            eprintln!("LAT-RETRY upstream {code} — transient, retrying once after 1.8s (retry #{})", *retries + 1);
            tokio::time::sleep(std::time::Duration::from_millis(1800)).await;
            *retries += 1;
            attempt += 1;
            continue;
        } else {
            return Ok(resp);
        }
        tokio::time::sleep(std::time::Duration::from_millis(BACKOFF_MS[attempt])).await;
        *retries += 1;
        attempt += 1;
    }
}

/// What one session sends upstream: its model (any the upstream serves; else the default),
/// its thinking variant (create-time stamp, else its profile's, else the brain default) and
/// the tools its profile may call (+ the tree tools for managing profiles).
fn session_upstream(st: &AppState, id: &str) -> (String, String, Option<Value>) {
    let prof = session_profile(st, id);
    let (model, stamp) = st
        .sessions
        .lock()
        .unwrap()
        .get(id)
        .map(|s| (s.info["model"]["id"].as_str().map(String::from), s.info["model"]["variant"].as_str().map(String::from)))
        .unwrap_or((None, None));
    let model = model.filter(|m| st.config.models.iter().any(|x| x == m)).unwrap_or_else(|| st.config.model.clone());
    let variant = stamp.or(prof.variant.clone()).unwrap_or_else(|| st.config.default_variant.clone());
    let lite = model_tier(st, &model) == "lite";
    let tools = st.config.tools_enabled.then(|| {
        // a lite model gets the lean set: shell + files (and the tree tools if it manages)
        let allowed: Vec<&str> = prof.declared_tools().into_iter().filter(|t| !lite || matches!(*t, "bash" | "read" | "write" | "edit")).collect();
        let mut list: Vec<Value> = tools::schemas()
            .as_array()
            .into_iter()
            .flatten()
            .filter(|t| t["function"]["name"].as_str().is_some_and(|n| allowed.contains(&n)))
            .cloned()
            .collect();
        // a managing agent gets every tree tool; a read-only reader (review) only find + read
        // extension tools (not for a lite model's lean set)
        if !lite {
            list.extend(st.config.ext.schemas(&prof));
        }
        if prof.reads_tree() {
            let tree_tools = tree::schemas(&st.config.profiles.read().unwrap());
            list.extend(tree_tools.into_iter().filter(|t| prof.sessions || matches!(t["function"]["name"].as_str(), Some("sessions_find" | "session_read"))));
        }
        Value::Array(list)
    });
    (model, variant, tools.filter(|t| t.as_array().is_some_and(|a| !a.is_empty())))
}

/// A turn with an image runs on a model that can see (YGG_VISION_MODELS) when the session's own
/// model is not one of them; nothing changes when no vision model is configured.
fn vision_model(st: &AppState, model: String, image: bool) -> String {
    if !image || st.config.vision.is_empty() || st.config.vision.contains(&model) {
        return model;
    }
    st.config.vision[0].clone()
}

/// One non-streamed, tool-less upstream call (the tree's digest): `system` + one user message,
/// thinking off, behind the same in-flight cap as every run.
async fn upstream_once(st: &AppState, model: &str, system: &str, user: &str, max_tokens: u64) -> Result<String, String> {
    let _permit = st.upstream.acquire().await.map_err(|e| e.to_string())?;
    let cfg = &st.config;
    let convo = [json!({ "role": "system", "content": system }), json!({ "role": "user", "content": user })];
    if cfg.dialect == Dialect::Anthropic {
        let off = anthropic::thinking_for(Some("off"), cfg.think_high);
        let mut body = anthropic::body(model, max_tokens.min(cfg.max_tokens), &convo, None, false, off.as_ref());
        body["stream"] = json!(false);
        let mut req = st.http.post(anthropic::messages_url(&cfg.base_url)).json(&body).header("anthropic-version", anthropic::VERSION);
        if let Some(key) = &cfg.api_key {
            req = req.header("x-api-key", key).bearer_auth(key);
        }
        let mut retries = 0;
        let resp = send_with_retry(&req, &mut retries).await?;
        let status = resp.status();
        let body = resp.text().await.map_err(|e| format!("read failed: {e}"))?;
        if !status.is_success() {
            return Err(format!("upstream {status}: {}", body.chars().take(300).collect::<String>()));
        }
        let v: Value = serde_json::from_str(&body).map_err(|e| format!("bad json: {e}"))?;
        return Ok(anthropic::parse_message(&v).0);
    }
    let url = format!("{}/chat/completions", cfg.base_url.trim_end_matches('/'));
    let mut req = st.http.post(&url).json(&json!({ "model": model, "messages": convo, "stream": false, "max_tokens": max_tokens }));
    if let Some(key) = &cfg.api_key {
        req = req.bearer_auth(key);
    }
    let mut retries = 0;
    let resp = send_with_retry(&req, &mut retries).await?;
    let status = resp.status();
    let body = resp.text().await.map_err(|e| format!("read failed: {e}"))?;
    if !status.is_success() {
        return Err(format!("upstream {status}: {}", body.chars().take(300).collect::<String>()));
    }
    let v: Value = serde_json::from_str(&body).map_err(|e| format!("bad json: {e}"))?;
    Ok(v["choices"][0]["message"]["content"].as_str().unwrap_or_default().to_string())
}

/// One upstream call with `stream: true` (and the tool set): forwards each content delta
/// as an SSE event, accumulating it into `full` (an abort keeps the partial text), and
/// assembles streamed `tool_calls` fragments by index. Also accepts a non-streaming
/// JSON reply.
async fn relay(
    st: &AppState,
    session_id: &str,
    convo: &[Value],
    tx: &mpsc::Sender<Event>,
    run: &mut Run,
) -> Result<Vec<ToolCall>, String> {
    let started = run.started;
    let first_delta_ms = &mut run.first_delta_ms;
    let full = &mut run.text;
    let cfg = &st.config;
    if cfg.dialect == Dialect::Anthropic {
        return relay_anthropic(st, session_id, convo, tx, run).await;
    }
    let url = format!("{}/chat/completions", cfg.base_url.trim_end_matches('/'));
    let (model, _variant, tools) = session_upstream(st, session_id);
    let model = vision_model(st, model, run.vision);
    let mut body = json!({ "model": model, "messages": convo, "stream": true });
    if let Some(t) = tools {
        body["tools"] = t;
    }
    let _permit = st.upstream.acquire().await.map_err(|e| e.to_string())?;
    let mut req = st.http.post(&url).json(&body);
    if let Some(key) = &cfg.api_key {
        req = req.bearer_auth(key);
    }
    let t_req = std::time::Instant::now();
    let resp = send_with_retry(&req, &mut run.retries).await?;
    run.upstream_calls += 1;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        // SPEED LAW: a fast-failing upstream must be LOUD — a silent or
        // quiet fallback here was the 31s-every-commit bug's escape hatch.
        eprintln!(
            "LAT-FAIL upstream_connect total_ms={} ttfb_ms=0 calls={} retries={} first_token=false phase=error upstream {} : {}",
            t_req.elapsed().as_millis(),
            run.upstream_calls,
            run.retries,
            status,
            body.chars().take(300).collect::<String>()
        );
        return Err(format!("upstream {status}: {body}"));
    }

    let mut calls: Vec<ToolCall> = Vec::new();
    let is_json = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|ct| ct.starts_with("application/json"));
    if is_json {
        let v: Value = resp.json().await.map_err(|e| format!("bad json: {e}"))?;
        let m = &v["choices"][0]["message"];
        let text = m["content"].as_str().unwrap_or_default();
        full.push_str(text);
        if !text.is_empty() {
            run.first_token_seen = true;
        }
        if first_delta_ms.is_none() && !text.is_empty() {
            *first_delta_ms = Some(started.elapsed().as_millis() as u64);
        }
        send_delta(st, session_id, tx, text).await;
        for tc in m["tool_calls"].as_array().into_iter().flatten() {
            calls.push(ToolCall {
                id: tc["id"].as_str().unwrap_or_default().into(),
                name: tc["function"]["name"].as_str().unwrap_or_default().into(),
                arguments: tc["function"]["arguments"].as_str().unwrap_or_default().into(),
            });
        }
        return Ok(calls);
    }

    let mut buf = String::new();
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("stream error: {e}"))?;
        buf.push_str(&String::from_utf8_lossy(&chunk));
        while let Some(nl) = buf.find('\n') {
            let line: String = buf.drain(..=nl).collect();
            let Some(data) = line.trim().strip_prefix("data:") else { continue };
            let data = data.trim();
            if data == "[DONE]" {
                return Ok(calls);
            }
            let Ok(v) = serde_json::from_str::<Value>(data) else { continue };
            let delta = &v["choices"][0]["delta"];
            if let Some(text) = delta["content"].as_str() {
                full.push_str(text);
                if !text.is_empty() {
                    run.first_token_seen = true;
                }
                if first_delta_ms.is_none() && !text.is_empty() {
                    *first_delta_ms = Some(started.elapsed().as_millis() as u64);
                }
                send_delta(st, session_id, tx, text).await;
            }
            for tc in delta["tool_calls"].as_array().into_iter().flatten() {
                let i = tc["index"].as_u64().unwrap_or(0) as usize;
                if calls.len() <= i {
                    calls.resize_with(i + 1, ToolCall::default);
                }
                let c = &mut calls[i];
                if let Some(id) = tc["id"].as_str() {
                    c.id = id.into();
                }
                if let Some(n) = tc["function"]["name"].as_str() {
                    c.name.push_str(n);
                }
                if let Some(a) = tc["function"]["arguments"].as_str() {
                    c.arguments.push_str(a);
                }
            }
        }
    }
    Ok(calls)
}

/// Slice 7: an anthropic-dialect request — `{base}/v1/messages`, the key as both
/// `x-api-key` and bearer (providers differ), `anthropic-version`.
fn anthropic_request(
    st: &AppState,
    model: &str,
    convo: &[Value],
    tools: Option<&Value>,
    stream: bool,
    thinking: Option<&Value>,
) -> reqwest::RequestBuilder {
    let cfg = &st.config;
    let body = anthropic::body(model, cfg.max_tokens, convo, tools, stream, thinking);
    let mut req = st.http.post(anthropic::messages_url(&cfg.base_url)).json(&body).header("anthropic-version", anthropic::VERSION);
    if let Some(key) = &cfg.api_key {
        req = req.header("x-api-key", key).bearer_auth(key);
    }
    req
}

/// `relay` in the anthropic dialect: same contract — text deltas forwarded and accumulated
/// into `full`, tool calls returned in block order. Tool-use ids are re-keyed to yggdrasil
/// `call_` ids (consistent within the conversation we send back), so a stored transcript
/// does not reveal which dialect served it.
async fn relay_anthropic(
    st: &AppState,
    session_id: &str,
    convo: &[Value],
    tx: &mpsc::Sender<Event>,
    run: &mut Run,
) -> Result<Vec<ToolCall>, String> {
    let cfg = &st.config;
    let started = run.started;
    let first_delta_ms = &mut run.first_delta_ms;
    let full = &mut run.text;
    // model, thinking and tools: the session's stamps and profile (session_upstream)
    let (model, variant, tools) = session_upstream(st, session_id);
    let model = vision_model(st, model, run.vision);
    let variant = if run.think_off { "off".to_string() } else { variant };
    let thinking = anthropic::thinking_for(Some(&variant), cfg.think_high);
    run.think = thinking.as_ref().and_then(|t| t["budget_tokens"].as_u64()).unwrap_or(0);
    let req = anthropic_request(st, &model, convo, tools.as_ref(), true, thinking.as_ref());
    let _permit = st.upstream.acquire().await.map_err(|e| e.to_string())?;
    let t_req = std::time::Instant::now();
    let resp = send_with_retry(&req, &mut run.retries).await?;
    run.upstream_calls += 1;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        // SPEED LAW: loud upstream failure (same contract as the OpenAI relay).
        eprintln!(
            "LAT-FAIL upstream_connect total_ms={} ttfb_ms=0 calls={} retries={} first_token=false phase=error upstream {} : {}",
            t_req.elapsed().as_millis(),
            run.upstream_calls,
            run.retries,
            status,
            body.chars().take(300).collect::<String>()
        );
        return Err(format!("upstream {status}: {body}"));
    }
    let rekey = |calls: Vec<anthropic::Call>| -> Vec<ToolCall> {
        calls.into_iter().map(|c| ToolCall { id: new_id("call"), name: c.name, arguments: c.args }).collect()
    };
    let is_json = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|ct| ct.starts_with("application/json"));
    if is_json {
        let v: Value = resp.json().await.map_err(|e| format!("bad json: {e}"))?;
        if v["type"] == "error" {
            return Err(format!("upstream error: {}", v["error"]));
        }
        let (text, calls, stop) = anthropic::parse_message(&v);
        run.reasoning_chars += anthropic::reasoning_chars(&v);
        if stop.as_deref() == Some("max_tokens") {
            eprintln!("upstream stopped at max_tokens ({}); raise YGG_MAX_TOKENS", cfg.max_tokens);
        }
        full.push_str(&text);
        if !text.is_empty() {
            run.first_token_seen = true;
        }
        if first_delta_ms.is_none() && !text.is_empty() {
            *first_delta_ms = Some(started.elapsed().as_millis() as u64);
        }
        send_delta(st, session_id, tx, &text).await;
        return Ok(rekey(calls));
    }
    let (mut lines, mut dec) = (anthropic::SseLines::default(), anthropic::Stream::default());
    let mut stream = resp.bytes_stream();
    'read: while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("stream error: {e}"))?;
        for data in lines.push(&chunk) {
            let Ok(v) = serde_json::from_str::<Value>(&data) else { continue };
            if let Some(text) = dec.feed(&v)? {
                full.push_str(&text);
                run.first_token_seen = true;
                if first_delta_ms.is_none() && !text.is_empty() {
                    *first_delta_ms = Some(started.elapsed().as_millis() as u64);
                }
                send_delta(st, session_id, tx, &text).await;
            }
            if dec.stopped {
                break 'read;
            }
        }
    }
    run.reasoning_chars += dec.reasoning_chars;
    if dec.stop_reason.as_deref() == Some("max_tokens") {
        eprintln!("upstream stopped at max_tokens ({}); raise YGG_MAX_TOKENS", cfg.max_tokens);
    }
    Ok(rekey(dec.calls))
}

/// The roll-up call in the anthropic dialect: the summarizer prompt rides in `system`.
async fn summarize_anthropic(st: &AppState, messages: &Value) -> Result<String, String> {
    let convo = messages.as_array().cloned().unwrap_or_default();
    let off = anthropic::thinking_for(Some("off"), st.config.think_high);
    let _permit = st.upstream.acquire().await.map_err(|e| e.to_string())?;
    let resp = anthropic_request(st, &st.config.model, &convo, None, false, off.as_ref()).send().await.map_err(|e| format!("request failed: {e}"))?;
    let status = resp.status();
    let body = resp.text().await.map_err(|e| format!("read failed: {e}"))?;
    if !status.is_success() {
        return Err(format!("upstream {status}: {body}"));
    }
    if let Ok(v) = serde_json::from_str::<Value>(&body) {
        if v["type"] == "error" {
            return Err(format!("upstream error: {}", v["error"]));
        }
        return Ok(anthropic::parse_message(&v).0);
    }
    // Some providers stream regardless of `stream: false`.
    let mut dec = anthropic::Stream::default();
    let mut out = String::new();
    for data in anthropic::SseLines::default().push(format!("{body}\n").as_bytes()) {
        if let Ok(v) = serde_json::from_str::<Value>(&data) {
            out.push_str(&dec.feed(&v)?.unwrap_or_default());
        }
    }
    Ok(out)
}

async fn send_delta(st: &AppState, session_id: &str, tx: &mpsc::Sender<Event>, text: &str) {
    if text.is_empty() {
        return;
    }
    emit(st, tx, "message.part.delta", json!({ "sessionID": session_id, "text": text })).await;
}

/// The single-provider catalog over every model this upstream serves, plus the phone's derived
/// think ids (`<model>-think-<level>`) so its level picker can switch a session's variant.
fn models_catalog(default: &str, models: &[String], tiers: &HashMap<String, &'static str>) -> Value {
    let mut ms = serde_json::Map::new();
    for m in models {
        // the tier rides the name, so the session's model picker says which prompt a model gets
        let name = tiers.get(m).map_or(m.clone(), |t| format!("{m} · {t}"));
        ms.insert(m.clone(), json!({ "id": m, "name": name, "providerID": "yggdrasil" }));
        for l in ["high", "low", "off"] {
            let d = format!("{m}-think-{l}");
            ms.insert(d.clone(), json!({ "id": d, "name": format!("{m} (think {l})"), "providerID": "yggdrasil" }));
        }
    }
    json!({
        "providers": [{ "id": "yggdrasil", "name": "yggdrasil", "models": ms }],
        "default": { "yggdrasil": default },
    })
}

fn load_catalog(model: &str) -> Value {
    if let Ok(path) = std::env::var("YGG_CATALOG") {
        let parsed = std::fs::read(&path)
            .map_err(|e| e.to_string())
            .and_then(|b| serde_json::from_slice::<Value>(&b).map_err(|e| e.to_string()));
        match parsed {
            Ok(c) => return c,
            Err(e) => {
                eprintln!("YGG_CATALOG {path}: {e}");
                std::process::exit(2);
            }
        }
    }
    json!({
        "providers": [{ "id": "yggdrasil", "name": "yggdrasil", "models": { model: { "id": model, "name": model, "providerID": "yggdrasil" } } }],
        "default": { "yggdrasil": model },
        "agents": [
            { "name": "build", "mode": "primary", "description": "default agent" },
            { "name": "plan", "mode": "primary", "description": "planning agent" },
        ],
    })
}

#[tokio::main]
async fn main() {
    for k in ["YGG_CLOCK_EPOCH_MS", "YGG_CLOCK_SHIFT_SECS"] {
        if std::env::var_os(k).is_some() {
            eprintln!("WARNING: {k} is set — TEST/SIM ONLY; it writes synthetic times into stored message `created`. Unset it in production.");
        }
    }
    let base_url = std::env::var("YGG_UPSTREAM_BASE_URL").ok().filter(|u| !u.is_empty()).unwrap_or_else(|| {
        eprintln!("YGG_UPSTREAM_BASE_URL is required");
        std::process::exit(2);
    });
    let model = std::env::var("YGG_UPSTREAM_MODEL").unwrap_or_else(|_| "gpt-4o-mini".into());
    let env_num = |k: &str, default: u64| -> u64 {
        match std::env::var(k) {
            Ok(v) if !v.is_empty() => v.parse().unwrap_or_else(|_| {
                eprintln!("{k}: not a number: {v}");
                std::process::exit(2);
            }),
            _ => default,
        }
    };
    let rollup_tokens = env_num("YGG_ROLLUP_TOKENS", 200_000); // owner 11-13: 200k
    let dialect = match std::env::var("YGG_UPSTREAM_STYLE").unwrap_or_default().to_ascii_lowercase().as_str() {
        "" | "openai" => Dialect::OpenAi,
        "anthropic" => Dialect::Anthropic,
        other => {
            eprintln!("YGG_UPSTREAM_STYLE: unknown dialect {other:?} (openai | anthropic)");
            std::process::exit(2);
        }
    };
    let upstream_url = match dialect {
        Dialect::OpenAi => format!("{}/chat/completions", base_url.trim_end_matches('/')),
        Dialect::Anthropic => anthropic::messages_url(&base_url),
    };
    eprintln!("upstream: {dialect:?} dialect, POST {upstream_url}");
    let default_variant = resolve_variant(&std::env::var("YGG_DEFAULT_VARIANT").unwrap_or_default()).unwrap_or_else(|e| {
        eprintln!("{e}");
        std::process::exit(2);
    });
    let (max_tokens, think_high) = (env_num("YGG_MAX_TOKENS", 16_384).max(1), env_num("YGG_THINK_HIGH", 8192));
    if think_high >= max_tokens {
        eprintln!("YGG_THINK_HIGH ({think_high}) must be < YGG_MAX_TOKENS ({max_tokens})");
        std::process::exit(2);
    }
    // root-coord: every model this upstream serves (YGG_MODELS, comma list; the default first)
    let (mut models, mut tiers): (Vec<String>, HashMap<String, &'static str>) = (vec![model.clone()], HashMap::new());
    for entry in std::env::var("YGG_MODELS").unwrap_or_default().split(',').map(str::trim).filter(|m| !m.is_empty()) {
        let (m, tier) = entry.split_once(':').unwrap_or((entry, "full"));
        match tier {
            "lite" => drop(tiers.insert(m.to_string(), "lite")),
            "full" => {}
            other => eprintln!("YGG_MODELS {entry}: unknown tier {other} (lite | full) — read as full"),
        }
        if !models.iter().any(|x| x == m) {
            models.push(m.to_string());
        }
    }
    let profiles = profiles::Profiles::load(std::env::var("YGG_PROFILES").ok().as_deref());
    eprintln!("profiles: {} (default {})", profiles.by_name.keys().cloned().collect::<Vec<_>>().join(", "), profiles.default_agent);
    let catalog = if std::env::var("YGG_CATALOG").is_ok() { load_catalog(&model) } else { models_catalog(&model, &models, &tiers) };
    let tree_cfg = tree::TreeCfg {
        max_depth: env_num("YGG_TREE_MAX_DEPTH", 12).max(1) as usize,
        max_children: env_num("YGG_TREE_MAX_CHILDREN", 24).max(1) as usize,
        digest_model: std::env::var("YGG_DIGEST_MODEL").ok().filter(|m| !m.is_empty()),
        wake_debounce_ms: env_num("YGG_WAKE_DEBOUNCE_MS", 4000),
        max_wakes: env_num("YGG_TREE_MAX_WAKES", 60).max(1),
    };
    let config = Config {
        default_variant,
        think_high,
        base_url,
        dialect,
        max_tokens,
        api_key: std::env::var("YGG_UPSTREAM_API_KEY").ok().filter(|k| !k.is_empty()),
        catalog,
        model,
        models,
        profiles: std::sync::RwLock::new(profiles),
        tree: tree_cfg,
        context_files: Vec::new(),
        peers: peers::Peers::load(),
        ext: ext::Extensions::load(),
        tiers,
        vision: std::env::var("YGG_VISION_MODELS").unwrap_or_default().split(',').map(str::trim).filter(|m| !m.is_empty()).map(String::from).collect(),
        max_steps: env_num("YGG_MAX_STEPS", 100).max(1) as usize,
        tools_enabled: std::env::var("YGG_TOOLS").map_or(true, |v| v != "0"),
        voice: std::env::var("YGG_VOICE").map_or(false, |v| v == "1"),
        // a safety limit, not a style: the note keeps replies short, the voice commands control
        // playback, and a story asked for by voice must fit (owner 11-13: "about eight sentences")
        voice_max_words: env_num("YGG_VOICE_MAX_WORDS", 300).max(5) as usize,
        rollup_tokens: rollup_tokens as usize,
        rollup_keep_tokens: env_num("YGG_ROLLUP_KEEP_TOKENS", rollup_tokens / 4) as usize,
    };
    let project_dir = match std::env::var("YGG_PROJECT_DIR") {
        Ok(d) if !d.is_empty() => PathBuf::from(d),
        _ => std::env::current_dir().expect("cwd"),
    };
    let project_dir = project_dir.canonicalize().unwrap_or_else(|e| {
        eprintln!("YGG_PROJECT_DIR {}: {e}", project_dir.display());
        std::process::exit(2);
    });
    let http = reqwest::Client::new();
    let tool_env = tools::ToolEnv {
        project_dir,
        bash_timeout: Duration::from_millis(env_num("YGG_BASH_TIMEOUT_MS", 120_000)),
        http: http.clone(),
    };
    eprintln!("tools {} in {}", if config.tools_enabled { "on" } else { "off" }, tool_env.project_dir.display());
    let mut config = config;
    config.context_files = match std::env::var("YGG_CONTEXT_FILES") {
        Ok(v) if !v.is_empty() => v.split(':').filter(|f| !f.is_empty()).map(PathBuf::from).collect(),
        _ => vec![tool_env.project_dir.join("AGENTS.md")],
    };
    eprintln!("context: {}", config.context_files.iter().map(|f| f.display().to_string()).collect::<Vec<_>>().join(":"));
    let listen = std::env::var("YGG_LISTEN").unwrap_or_else(|_| "127.0.0.1:4096".into());
    let data_dir = PathBuf::from(std::env::var("YGG_DATA_DIR").unwrap_or_else(|_| "./data".into()));
    std::fs::create_dir_all(data_dir.join("session")).expect("create YGG_DATA_DIR");
    let mut sessions = load_sessions(&data_dir);
    eprintln!("loaded {} session(s) from {}", sessions.len(), data_dir.display());
    let interrupted = close_interrupted(&mut sessions, &data_dir);
    // root-coord migration: MAIN carries its profile explicitly (the phone shows the registry
    // default for unpinned sessions, and that default is `build` again)
    let door_model = config.profiles.read().unwrap().get("coordinator").and_then(|p| p.model.clone()).filter(|m| config.models.contains(m));
    let default_agent = config.profiles.read().unwrap().default_agent.clone();
    for (id, s) in sessions.iter_mut() {
        let main = is_main_title(s.info["title"].as_str().unwrap_or_default());
        if main && s.info["agent"] != "coordinator" {
            s.info["agent"] = json!("coordinator");
            // its old stamp was only the brain-wide default: it takes the door's model
            if let Some(m) = &door_model {
                s.info["model"]["id"] = json!(m);
            }
            persist(&data_dir, id, s);
        } else if !main && s.info["agent"] == "coordinator" {
            // the coordinator is MAIN's alone: a session stamped with it before that rule (a
            // "fix this" from MAIN, 11-13 morning) runs the default agent
            s.info["agent"] = json!(default_agent);
            persist(&data_dir, id, s);
        }
    }
    let max_inflight = env_num("YGG_MAX_INFLIGHT", 6).max(1) as usize;

    // Antigravity's picker before `agy models` answers (or when it cannot): Google's current models
    let floor_models = harness::antigravity::models(None, harness::antigravity::api_key());
    let state = AppState {
        sessions: Arc::new(Mutex::new(sessions)),
        running: Arc::default(),
        run_locks: Arc::default(),
        bus: broadcast::channel(1024).0,
        data_dir: Arc::new(data_dir),
        config: Arc::new(config),
        http,
        tools: Arc::new(tool_env),
        upstream: Arc::new(tokio::sync::Semaphore::new(max_inflight)),
        wakes: Arc::default(),
        harness_slots: Arc::new(tokio::sync::Semaphore::new(env_num("YGG_MAX_HARNESS", 3).max(1) as usize)),
        harness_models: Arc::new(Mutex::new(HashMap::from([
            ("claude".to_string(), vec!["opus".to_string(), "sonnet".to_string(), "haiku".to_string()]),
            ("opencode".to_string(), vec!["default".to_string()]),
            ("codex".to_string(), vec!["default".to_string()]),
            ("antigravity".to_string(), floor_models.0),
        ]))),
        harness_labels: Arc::new(Mutex::new(HashMap::from([
            (
                "claude".to_string(),
                HashMap::from([
                    ("opus".to_string(), "strongest — hard, long work".to_string()),
                    ("sonnet".to_string(), "balanced — most coding".to_string()),
                    ("haiku".to_string(), "fastest — small, quick tasks".to_string()),
                ]),
            ),
            ("antigravity".to_string(), floor_models.1),
        ]))),
    };
    if !interrupted.is_empty() {
        eprintln!("restart: closed {} run(s) the previous process left open", interrupted.len());
    }
    let app = Router::new()
        .route("/session", get(list_sessions).post(create_session))
        .route("/session/status", get(session_status))
        .route("/session/{id}", get(get_session).patch(patch_session).delete(delete_session))
        .route("/session/{id}/message", get(list_messages).post(post_message))
        .route("/session/{id}/abort", post(abort_session))
        .route("/session/{id}/todo", get(get_todo))
        .route("/api/session/{id}/model", post(switch_model))
        .route("/api/session/{id}/agent", post(switch_agent))
        .route("/config/providers", get(config_providers))
        .route("/agent", get(list_agents))
        .route("/shared-prompt", get(get_shared).put(put_shared))
        .route("/extensions", get(|State(st): State<AppState>| async move { Json(st.config.ext.describe()) }))
        .route("/agent/{name}", get(get_agent).put(put_agent).delete(delete_agent))
        .route("/harness/claude/sessions", get(claude_sessions))
        .route("/event", get(events))
        .route("/tree", get(get_tree))
        .route("/tree/report", post(tree_report))
        .route("/root", get(get_root))
        .route("/session/{id}/inbox", get(get_inbox))
        .route("/session/{id}/close", post(close_session))
        .with_state(state.clone());
    tree::recover(&state, interrupted);
    peers::spawn_watch(&state);
    ext::spawn_watch(&state);
    spawn_harness_models(&state);
    eprintln!(
        "root {} · peers: {}{}",
        state.config.peers.me,
        if state.config.peers.list.is_empty() { "none".to_string() } else { state.config.peers.list.iter().map(|(n, u)| format!("{n}={u}")).collect::<Vec<_>>().join(", ") },
        state.config.peers.from.as_ref().map(|f| format!(" · learning linked roots from {f} (via {})", state.config.peers.via)).unwrap_or_default()
    );

    let listener = tokio::net::TcpListener::bind(&listen).await.expect("bind");
    eprintln!("yggdrasil listening on {listen}");
    axum::serve(listener, app).await.unwrap();
}

#[cfg(test)]
mod time_awareness_tests {
    use super::*;

    #[test]
    fn utc_roundtrip_known_instants() {
        // 2026-11-05T15:42:07Z and leap-year edge 2024-02-29T23:59:59Z
        let t1 = civil_to_unix(2026, 11, 5, 15, 42, 7);
        let s1 = utc_stamp(t1);
        assert_eq!(s1, "2026-11-05T15:42:07Z");
        let t2 = civil_to_unix(2024, 2, 29, 23, 59, 59);
        assert_eq!(utc_stamp(t2), "2024-02-29T23:59:59Z");
        // unix epoch
        assert_eq!(utc_stamp(0), "1970-01-01T00:00:00Z");
        // roundtrip via utc_from_unix
        let t3 = civil_to_unix(2026, 1, 1, 0, 0, 1);
        let u = utc_from_unix(t3);
        assert_eq!((u.year, u.month, u.day, u.hour, u.min, u.sec), (2026, 1, 1, 0, 0, 1));
    }

    #[test]
    fn short_gap_no_rules_no_meanwhile() {
        let now = civil_to_unix(2026, 11, 5, 16, 0, 0);
        let last = now - 120; // 2min gap
        let h = clock_header(now, Some(last), &[]);
        assert!(h.starts_with("[clock 2026-11-05T16:00:00Z] [gap since last user turn 2m]"));
        assert!(!h.contains("rules:"), "no adaptation rules under 4h");
        assert!(!h.contains("meanwhile"));
        assert_eq!(h.lines().count(), 1, "compact single line under 4h");
    }

    #[test]
    fn long_gap_has_rules_and_meanwhile_capped() {
        let now = civil_to_unix(2026, 11, 5, 16, 0, 0);
        let last = now - 26 * 3600; // 26h synthetic gap
        let h = clock_header(now, Some(last), &[]);
        assert!(h.contains("gap since last user turn 26h0m"), "gap rendered: {h}");
        assert!(h.contains("rules: <1h continuous flow; 1-24h brief re-anchor if state changed; >24h lead with a meanwhile-summary of what changed and re-anchor stale state"));
        // meanwhile lines are capped ≤3 total
        let extra = h.lines().count() - 1;
        assert!(extra <= 3, "meanwhile lines ≤3, got {extra}");
    }

    #[test]
    fn first_turn_header_has_clock_only() {
        let now = civil_to_unix(2026, 11, 5, 16, 0, 0);
        let h = clock_header(now, None, &[]);
        assert!(h.starts_with("[clock 2026-11-05T16:00:00Z]"));
        assert!(!h.contains("gap"));
        assert_eq!(h.lines().count(), 1);
    }

    fn stored(role: &str, text: &str, created_ms: i64) -> Value {
        let mut m = make_message("s", role, vec![text_part(text)]);
        m["info"]["time"]["created"] = json!(created_ms);
        m
    }

    /// What agent_loop sends for a stored session (without the roll-up call).
    fn request_for(stored: &[Value]) -> Vec<Value> {
        let mut convo = upstream_history(stored);
        apply_clock_headers(&mut convo, SYSTEM_PREAMBLE);
        convo
    }

    #[test]
    fn headers_derive_from_stored_chain_not_from_now() {
        let t0 = civil_to_unix(2026, 11, 5, 16, 0, 0) * 1000;
        let msgs = vec![
            stored("user", "hello", t0),
            stored("assistant", "hi", t0 + 500),
            stored("user", "and now?", t0 + 120_000),
        ];
        let c = request_for(&msgs);
        assert_eq!(c.len(), 4);
        assert_eq!(c[0]["content"], SYSTEM_PREAMBLE, "position 0 = STATIC preamble");
        assert_eq!(c[1]["content"], format!("{}\nhello", clock_header(t0 / 1000, None, &[])));
        assert_eq!(c[3]["content"], format!("{}\nand now?", clock_header(t0 / 1000 + 120, Some(t0 / 1000), &[])));
    }

    #[test]
    fn cache_law_three_turns_real_store_path_prefix_stable() {
        // Non-zero gaps; turn 3 lands across a second boundary vs turn 2.
        let t1 = civil_to_unix(2026, 11, 5, 16, 0, 0) * 1000 + 400;
        let t2 = t1 + 90_700;
        let t3 = t2 + 61_900; // .4 + .7 + .9 crosses seconds
        let mut store: Vec<Value> = Vec::new();
        let mut reqs: Vec<Vec<Value>> = Vec::new();
        for (i, (t, q)) in [(t1, "one"), (t2, "two"), (t3, "three")].into_iter().enumerate() {
            store.push(stored("user", q, t));
            reqs.push(request_for(&store));
            store.push(stored("assistant", &format!("a{i}"), t + 300));
        }
        for n in 0..2 {
            let (a, b) = (&reqs[n], &reqs[n + 1]);
            assert!(b.len() > a.len());
            assert_eq!(serde_json::to_string(a).unwrap(), serde_json::to_string(&b[..a.len()]).unwrap(),
                "request {n} must be a byte-prefix of request {}", n + 1);
        }
        assert!(reqs[2][3]["content"].as_str().unwrap().contains("[gap since last user turn 1m]"), "{:?}", reqs[2][3]);
    }

    #[test]
    fn meanwhile_is_frozen_at_creation_and_prefix_stable_across_a_long_gap() {
        let t1 = civil_to_unix(2026, 11, 5, 8, 0, 0) * 1000;
        let t2 = t1 + 26 * 3600 * 1000; // turn 2 lands 26h after turn 1
        let t3 = t2 + 60_000;
        let mut store = vec![stored("user", "one", t1), stored("assistant", "a0", t1 + 300)];
        // What post_message does at creation: freeze the lines on the record.
        let mut two = stored("user", "two", t2);
        two["info"]["time"]["meanwhile"] = json!(["lane A done", "report.md"]);
        store.push(two);
        store.push(stored("assistant", "a1", t2 + 300));
        // (a) render
        let a = request_for(&store);
        let hdr2 = a[3]["content"].as_str().unwrap();
        assert!(hdr2.contains(" [meanwhile]\n[clock] lane A done\n[clock] report.md"), "{hdr2}");
        // (b) live watcher/artifact state changes — header rendering never reads it
        //     (clock_header takes the lines as input; nothing here touches the files).
        // (c) turn 3 arrives, render again
        store.push(stored("user", "three", t3));
        let c = request_for(&store);
        // (d) request (a) is a per-message byte-prefix of request (c)
        assert!(c.len() > a.len());
        for (i, m) in a.iter().enumerate() {
            assert_eq!(serde_json::to_string(m).unwrap(), serde_json::to_string(&c[i]).unwrap(), "message {i}");
        }
        // old sessions (no stored field) render no meanwhile lines, stably
        let mut old = store.clone();
        old[2]["info"]["time"].as_object_mut().unwrap().remove("meanwhile");
        assert!(!request_for(&old)[3]["content"].as_str().unwrap().contains("[meanwhile]"));
    }

    #[test]
    fn headers_survive_compaction_boundary_and_skip_compaction_ask() {
        let t0 = civil_to_unix(2026, 11, 5, 16, 0, 0) * 1000;
        let mut ask = make_message("s", "user", vec![json!({ "type": "compaction", "auto": true })]);
        ask["info"]["time"]["created"] = json!(t0 + 1000);
        let msgs = vec![
            stored("user", "old", t0),
            stored("assistant", "old-a", t0 + 100),
            ask,
            stored("assistant", "SUMMARY", t0 + 1100),
            stored("user", "new", t0 + 60_000),
        ];
        let c = request_for(&msgs);
        assert_eq!(c.len(), 4); // preamble, ask, summary, new
        assert_eq!(c[1]["content"], rollup::COMPACTION_ASK, "compaction ask gets no header");
        assert_eq!(c[3]["content"], format!("{}\nnew", clock_header(t0 / 1000 + 60, Some(t0 / 1000), &[])),
            "prev chain crosses the compaction boundary");
    }

    #[test]
    fn empty_text_user_does_not_shift_headers() {
        let t0 = civil_to_unix(2026, 11, 5, 16, 0, 0) * 1000;
        let msgs = vec![
            stored("user", "a", t0),
            stored("user", "", t0 + 60_000),
            stored("user", "b", t0 + 120_000),
        ];
        let c = request_for(&msgs);
        assert_eq!(c.len(), 3);
        assert_eq!(c[2]["content"], format!("{}\nb", clock_header(t0 / 1000 + 120, Some(t0 / 1000 + 60), &[])));
    }

    #[test]
    fn non_string_user_content_is_not_erased() {
        let mut convo = vec![json!({"role": "user", "content": [{"type": "text", "text": "x"}], "_ts": 1000})];
        apply_clock_headers(&mut convo, SYSTEM_PREAMBLE);
        // multi-part content (an image turn) is kept whole; the header rides its text part
        let parts = convo[1]["content"].as_array().expect("still parts");
        assert_eq!(parts.len(), 1);
        let t = parts[0]["text"].as_str().unwrap();
        assert!(t.starts_with("[clock ") && t.ends_with("\nx"), "{t}");
    }

    #[test]
    fn no_private_keys_reach_either_dialect() {
        let t0 = civil_to_unix(2026, 11, 5, 16, 0, 0) * 1000;
        let msgs = vec![
            stored("user", "hello", t0),
            stored("assistant", "hi", t0 + 500),
            stored("user", "again", t0 + 5000),
        ];
        let convo = request_for(&msgs);
        // OpenAI dialect: `convo` is serialized raw as body["messages"].
        for m in &convo {
            let keys: Vec<&String> = m.as_object().unwrap().keys().collect();
            assert!(keys.iter().all(|k| !k.starts_with('_')), "private key rides upstream: {keys:?}");
        }
        // Anthropic dialect: converted output.
        let (system, out) = anthropic::convert(&convo);
        let wire = serde_json::to_string(&(system, out)).unwrap();
        assert!(!wire.contains("\"_ts\"") && !wire.contains("\"_prev\""), "{wire}");
        // and the sources really did carry them before the strip
        assert!(upstream_history(&msgs)[0].get("_ts").is_some());
    }
}

/// SPEED LAW unit tests (11-05): the latency log fields and the format
/// helpers are pure; the loud-lines (LAT-FAIL / LAT-NO-TOKEN) and the
/// <10s fast-fail are proven end-to-end by mock/latency-sim.sh.
#[cfg(test)]
mod speed_law_tests {
    use super::*;

    fn test_run() -> Run {
        Run {
            msg: make_message("s", "assistant", vec![]),
            text: String::new(),
            started: std::time::Instant::now(),
            first_delta_ms: None,
            upstream_calls: 1,
            retries: 0,
            first_token_seen: false,
            voice_note: false,
            reasoning_chars: 0,
            session: "ses_t".into(),
            queue_ms: 42,
            think: 0,
            think_off: false,
            vision: false,
        }
    }

    #[test]
    fn lat_log_ok_row_has_all_fields() {
        let mut run = test_run();
        run.first_delta_ms = Some(1234);
        run.first_token_seen = true;
        run.msg["parts"] = json!([
            { "type": "text", "text": "hi" },
            { "type": "tool", "state": { "status": "completed" } },
        ]);
        run.lat_log("ok");
        let lat = &run.msg["info"]["time"]["latency"];
        assert_eq!(lat["ttfb_ms"], json!(1234));
        assert!(lat["total_ms"].as_u64().unwrap() >= 0);
        assert_eq!(lat["upstream_calls"], json!(1));
        assert_eq!(lat["retries"], json!(0));
        assert_eq!(lat["first_token"], json!(true));
        assert_eq!(lat["phase"], json!("ok"));
        assert_eq!(lat["queue_ms"], json!(42));
        assert_eq!(run.session, "ses_t");
    }

    #[test]
    fn lat_log_error_row_carries_phase() {
        let mut run = test_run();
        run.lat_log("error: upstream 400 Bad Request: {\"error\":{}}");
        let lat = &run.msg["info"]["time"]["latency"];
        assert_eq!(lat["ttfb_ms"], json!(0));
        assert_eq!(lat["first_token"], json!(false));
        assert!(lat["phase"].as_str().unwrap().starts_with("error:"));
    }

    #[test]
    fn lat_log_no_token_row_is_the_31s_shape() {
        // zero-text first step (tool-only): ttfb_ms=0 AND first_token=false —
        // the exact signature the model-400 fallback wore for weeks.
        let mut run = test_run();
        run.msg["parts"] = json!([{ "type": "tool", "state": { "status": "completed" } }]);
        run.lat_log("ok");
        let lat = &run.msg["info"]["time"]["latency"];
        assert_eq!(lat["ttfb_ms"], json!(0));
        assert_eq!(lat["first_token"], json!(false));
    }
}

/// coordinator ≤5s law: MAIN leash + station-turn collapse.
#[cfg(test)]
mod law_tests {
    use super::*;

    #[test]
    fn main_title_and_caps() {
        assert!(is_main_title("[MAIN]"));
        assert!(is_main_title(" [MAIN] "));
        assert!(!is_main_title("[FIX] lane"));
    }

    fn pair(n: usize, auto: bool) -> [Value; 2] {
        let mut u = make_message("s", "user", vec![text_part(&format!("landing {n}\nsecond line")) ]);
        u["info"]["time"]["created"] = json!(1000 + n as i64 * 10);
        let mut a = make_message("s", "assistant", vec![text_part(&format!("verdict {n}"))]);
        a["info"]["time"]["completed"] = json!(1001 + n as i64 * 10);
        if auto {
            u["info"]["meta"] = json!({ "auto": true });
            a["info"]["meta"] = json!({ "autoReply": true });
        }
        [u, a]
    }

    #[test]
    fn station_history_collapses_beyond_last_two_and_is_frozen() {
        let mut msgs: Vec<Value> = vec![];
        msgs.extend(pair(0, false)); // owner turn: verbatim forever
        for n in 1..=5 {
            msgs.extend(pair(n, true));
        }
        collapse_stale_station(&mut msgs);
        let h = upstream_history(&msgs);
        // owner pair (2) + 3 collapsed single lines + 2 verbatim pairs (4)
        assert_eq!(h.len(), 2 + 3 + 4);
        assert_eq!(h[2]["content"], json!("[station turn] landing 1 => verdict 1"));
        assert_eq!(h[3]["content"], json!("[station turn] landing 2 => verdict 2"));
        assert_eq!(h[4]["content"], json!("[station turn] landing 3 => verdict 3"));
        assert_eq!(h[0]["content"], json!("landing 0\nsecond line"));
        assert!(h[5]["content"].as_str().unwrap().contains("landing 4"));
        // append-only: another station turn only changes the digest of the one aging out
        let before = h[..5].to_vec();
        msgs.extend(pair(6, true));
        collapse_stale_station(&mut msgs);
        let h2 = upstream_history(&msgs);
        assert_eq!(&h2[..5], &before[..]);
        assert_eq!(h2[5]["content"], json!("[station turn] landing 4 => verdict 4"));
        // idempotent
        let snap = upstream_history(&msgs);
        collapse_stale_station(&mut msgs);
        assert_eq!(snap, upstream_history(&msgs));
    }

    fn fold_all(m: &mut [Value]) {
        collapse_stale_station(m);
        collapse_stale_owner(m);
    }

    #[test]
    fn owner_turns_fold_beyond_last_two_and_last_two_stay_verbatim() {
        let mut msgs: Vec<Value> = vec![];
        for n in 0..6 {
            msgs.extend(pair(n, false));
        }
        fold_all(&mut msgs);
        let h = upstream_history(&msgs);
        // 4 folded single lines + 2 verbatim pairs
        assert_eq!(h.len(), 4 + 4);
        // digest shape: tag, first line of the ask, arrow, first line of the reply
        assert_eq!(h[0]["content"], json!("[earlier turn] landing 0 => verdict 0"));
        assert_eq!(h[3]["content"], json!("[earlier turn] landing 3 => verdict 3"));
        assert_eq!(h[4]["content"], json!("landing 4\nsecond line"));
        assert_eq!(h[5]["content"], json!("verdict 4"));
        assert_eq!(h[7]["content"], json!("verdict 5"));
        // stored transcript (UI) untouched
        assert_eq!(msgs.len(), 12);
        assert_eq!(message_text(&msgs[1]), "verdict 0");
    }

    #[test]
    fn owner_fold_is_frozen_and_prefix_stable_until_a_turn_ages_in() {
        let mut msgs: Vec<Value> = vec![];
        for n in 0..4 {
            msgs.extend(pair(n, false));
        }
        fold_all(&mut msgs);
        let h = upstream_history(&msgs);
        assert_eq!(h[0]["content"], json!("[earlier turn] landing 0 => verdict 0"));
        assert_eq!(h[1]["content"], json!("[earlier turn] landing 1 => verdict 1"));
        // idempotent: re-running never changes a byte
        let snap = h.clone();
        fold_all(&mut msgs);
        assert_eq!(snap, upstream_history(&msgs));
        // next turn ages exactly one more exchange; the earlier prefix is unchanged
        msgs.extend(pair(4, false));
        fold_all(&mut msgs);
        let h2 = upstream_history(&msgs);
        assert_eq!(&h2[..2], &snap[..2]);
        assert_eq!(h2[2]["content"], json!("[earlier turn] landing 2 => verdict 2"));
        assert_eq!(h2.len(), 3 + 4);
    }

    #[test]
    fn mixed_auto_and_owner_fold_independently() {
        let mut msgs: Vec<Value> = vec![];
        for n in 0..5 {
            msgs.extend(pair(n, false)); // owner 0..4
            msgs.extend(pair(10 + n, true)); // station 10..14
        }
        fold_all(&mut msgs);
        let h = upstream_history(&msgs);
        let lines: Vec<&str> = h.iter().filter_map(|m| m["content"].as_str()).collect();
        assert!(lines.contains(&"[earlier turn] landing 0 => verdict 0"));
        assert!(lines.contains(&"[earlier turn] landing 1 => verdict 1"));
        assert!(lines.contains(&"[station turn] landing 10 => verdict 10"));
        assert!(lines.contains(&"[earlier turn] landing 2 => verdict 2"));
        assert!(lines.contains(&"[station turn] landing 11 => verdict 11"));
        assert!(lines.contains(&"[station turn] landing 12 => verdict 12"));
        // last 2 of each class stay whole
        for n in [3, 4, 13, 14] {
            assert!(lines.contains(&format!("landing {n}\nsecond line").as_str()), "landing {n}");
            assert!(lines.contains(&format!("verdict {n}").as_str()), "verdict {n}");
        }
        assert!(!lines.iter().any(|l| ["verdict 0", "verdict 2", "verdict 10", "verdict 12"].contains(l)));
    }

    #[test]
    fn reply_less_owner_turns_fold_with_marker_but_tail_stays() {
        let mut msgs: Vec<Value> = vec![];
        for n in 0..5 {
            msgs.push(make_message("s", "user", vec![text_part(&format!("queued {n}"))]));
        }
        fold_all(&mut msgs);
        let h = upstream_history(&msgs);
        assert_eq!(h.len(), 5);
        assert_eq!(h[0]["content"], json!("[earlier turn] queued 0 => (no reply recorded)"));
        assert_eq!(h[2]["content"], json!("[earlier turn] queued 2 => (no reply recorded)"));
        assert_eq!(h[3]["content"], json!("queued 3"));
        assert!(msgs[3]["info"]["meta"]["digest"].is_null());
    }

    #[test]
    fn interrupted_and_burst_exchanges_fold_and_orphan_reply_is_folded() {
        let mut msgs: Vec<Value> = vec![];
        msgs.extend(pair(0, false)); // normal
        msgs.push(make_message("s", "user", vec![text_part("burst a")])); // user, user, assistant
        msgs.push(make_message("s", "user", vec![text_part("burst b")]));
        let mut a = make_message("s", "assistant", vec![text_part("fat orphan reply")]);
        a["info"]["time"]["completed"] = json!(5000);
        msgs.push(a);
        msgs.push(make_message("s", "user", vec![text_part("interrupted ask")]));
        msgs.push(make_message("s", "assistant", vec![text_part("half done")])); // never completed
        for n in 7..10 {
            msgs.extend(pair(n, false)); // 7 ages out, tail = 8, 9
        }
        fold_all(&mut msgs);
        let h = upstream_history(&msgs);
        let lines: Vec<&str> = h.iter().filter_map(|m| m["content"].as_str()).collect();
        assert_eq!(&lines[..4], &[
            "[earlier turn] landing 0 => verdict 0",
            "[earlier turn] burst a => (no reply recorded)",
            "[earlier turn] burst b => fat orphan reply",
            "[earlier turn] interrupted ask => (no reply recorded)",
        ]);
        assert!(!lines.contains(&"fat orphan reply"));
        assert!(!lines.contains(&"half done"));
        assert_eq!(lines[4], "[earlier turn] landing 7 => verdict 7");
        assert_eq!(h.len(), 5 + 4);
        assert_eq!(lines[5], "landing 8\nsecond line");
        let snap = h.clone();
        fold_all(&mut msgs);
        assert_eq!(snap, upstream_history(&msgs));
    }

    #[test]
    fn unanswered_station_turn_is_not_collapsed() {
        let mut msgs: Vec<Value> = vec![];
        for n in 1..=3 {
            msgs.extend(pair(n, true));
        }
        let mut pending = make_message("s", "user", vec![text_part("queued")]);
        pending["info"]["meta"] = json!({ "auto": true });
        // an old unanswered auto (no completed assistant after it) stays verbatim
        let mut only = vec![pending.clone()];
        for _ in 0..3 {
            only.push(pending.clone());
        }
        collapse_stale_station(&mut only);
        assert!(only.iter().all(|m| m["info"]["meta"]["digest"].is_null()));
        // window 2: answered autos 1..3 + 3 pending -> 4 aged, only the 3 answered fold; the
        // aged pending one (and both in the window) stay verbatim
        for _ in 0..3 {
            msgs.push(pending.clone());
        }
        collapse_stale_station(&mut msgs);
        let digested: Vec<usize> = (0..msgs.len()).filter(|&i| msgs[i]["info"]["meta"]["digest"].is_string()).collect();
        assert_eq!(digested, vec![0, 2, 4]);
        assert!(msgs[6..].iter().all(|m| m["info"]["meta"]["digest"].is_null() && m["info"]["meta"]["folded"].is_null()));
        let h = upstream_history(&msgs);
        assert_eq!(h.iter().filter(|m| m["content"] == json!("queued")).count(), 3);
    }

    #[test]
    fn station_hard_fold_takes_the_whole_exchange_autoreply_or_not() {
        let mut msgs: Vec<Value> = vec![];
        let mut u = make_message("s", "user", vec![text_part("landing 0")]);
        u["info"]["meta"] = json!({ "auto": true });
        msgs.push(u);
        // a full (non-autoReply) reply with a tool step, then a second step message
        let mut step = make_message("s", "assistant", vec![text_part("checking"), json!({ "type": "tool", "tool": "bash", "callID": "c1",
            "state": { "status": "completed", "input": { "command": "ls" }, "output": "big tool output" } })]);
        step["info"]["time"]["completed"] = json!(2000);
        let mut fin = make_message("s", "assistant", vec![text_part("long verdict body")]);
        fin["info"]["time"]["completed"] = json!(2001);
        msgs.push(step);
        msgs.push(fin);
        for n in 1..=2 {
            msgs.extend(pair(n, true));
        }
        collapse_stale_station(&mut msgs);
        assert!(msgs[1]["info"]["meta"]["folded"] == true && msgs[2]["info"]["meta"]["folded"] == true);
        let h = upstream_history(&msgs);
        assert_eq!(h[0]["content"], json!("[station turn] landing 0 => checking"));
        let all = serde_json::to_string(&h).unwrap();
        assert!(!all.contains("big tool output") && !all.contains("long verdict body"));
        assert_eq!(h.len(), 1 + 4);
        // stored transcript (UI) untouched
        assert_eq!(msgs.len(), 7);
        assert_eq!(message_text(&msgs[2]), "long verdict body");
    }

    #[test]
    fn fold_counts_window_two_for_any_length() {
        for n in 0..9usize {
            let mut owners: Vec<Value> = vec![];
            let mut autos: Vec<Value> = vec![];
            for k in 0..n {
                owners.extend(pair(k, false));
                autos.extend(pair(k, true));
            }
            fold_all(&mut owners);
            fold_all(&mut autos);
            let want = n.min(2) * 2 + n.saturating_sub(2);
            assert_eq!(upstream_history(&owners).len(), want, "owner n={n}");
            assert_eq!(upstream_history(&autos).len(), want, "station n={n}");
        }
    }
}

/// voice-turn-brevity: the per-turn note is rendered from STORED modality, at
/// the tail of the voice user message only, and never disturbs earlier bytes.
#[cfg(test)]
mod voice_turn_tests {
    use super::*;

    fn stored(role: &str, text: &str, created_ms: i64, voice: bool) -> Value {
        let mut m = make_message("s", role, vec![text_part(text)]);
        m["info"]["time"]["created"] = json!(created_ms);
        if voice {
            m["info"]["modality"] = json!("voice");
        }
        m
    }

    fn request_for(stored: &[Value]) -> Vec<Value> {
        let mut convo = upstream_history(stored);
        apply_clock_headers(&mut convo, SYSTEM_PREAMBLE);
        convo
    }

    fn content(convo: &[Value], i: usize) -> String {
        convo[i]["content"].as_str().unwrap().to_string()
    }

    #[test]
    fn voice_message_carries_note_at_tail() {
        let msgs = vec![stored("user", "how do I reset my router?", 1_000_000, true)];
        let c = request_for(&msgs);
        let u = content(&c, 1);
        assert!(u.ends_with(VOICE_TURN_NOTE), "note is the last block: {u}");
        assert!(u.contains("how do I reset my router?\n[voice turn]"));
        // never in the system preamble
        assert!(!content(&c, 0).contains("[voice turn]"));
    }

    #[test]
    fn text_message_carries_no_note() {
        let msgs = vec![stored("user", "how do I reset my router?", 1_000_000, false)];
        let c = request_for(&msgs);
        assert!(!content(&c, 1).contains("[voice turn]"));
    }

    #[test]
    fn mixed_session_notes_only_voice_turns_and_prefix_is_byte_stable() {
        let t0 = civil_to_unix(2026, 11, 5, 16, 0, 0) * 1000;
        let mut msgs = vec![
            stored("user", "voice one", t0, true),
            stored("assistant", "reply one", t0 + 500, false),
        ];
        let before = request_for(&msgs);
        msgs.push(stored("user", "typed two", t0 + 60_000, false));
        let after = request_for(&msgs);
        // earlier positions keep identical bytes once the next turn is appended
        assert_eq!(before.len() + 1, after.len());
        for i in 0..before.len() {
            assert_eq!(before[i], after[i], "position {i} changed");
        }
        assert!(content(&after, 1).ends_with(VOICE_TURN_NOTE));
        assert!(!content(&after, 3).contains("[voice turn]"));
        // a second render of the same history is byte-identical
        assert_eq!(after, request_for(&msgs));
    }

    #[test]
    fn auto_turn_detected_from_last_user_message() {
        let mut auto = make_message("s", "user", vec![text_part("verdict?")]);
        auto["info"]["meta"] = json!({ "auto": true });
        let plain = make_message("s", "user", vec![text_part("hi")]);
        let reply = make_message("s", "assistant", vec![text_part("ok")]);
        assert!(is_auto_turn(&[auto.clone(), reply.clone()]));
        assert!(!is_auto_turn(&[auto, reply.clone(), plain]));
        assert!(!is_auto_turn(&[reply]));
    }

    #[test]
    fn internal_turn_in_agent_context_not_in_transcript() {
        let mut internal = make_message("s", "user", vec![text_part("AUTO-VERDICT lane x landed")]);
        internal["info"]["meta"] = json!({ "internal": true });
        internal["parts"][0]["internal"] = json!(true);
        let reply = make_message("s", "assistant", vec![text_part("noted")]);
        let plain = make_message("s", "user", vec![text_part("hi")]);
        let all = vec![internal, reply, plain];
        // stored form keeps the flag (persisted JSON round-trip)
        let rt: Vec<Value> = serde_json::from_str(&serde_json::to_string(&all).unwrap()).unwrap();
        assert!(is_internal(&rt[0]) && rt[0]["parts"][0]["internal"] == true);
        // agent context includes it
        let ctx = serde_json::to_string(&upstream_history(&rt)).unwrap();
        assert!(ctx.contains("AUTO-VERDICT lane x landed"), "{ctx}");
        // owner transcript omits it; normal turns stay
        let t = transcript(&rt, false);
        assert_eq!(t.len(), 2);
        assert!(t.iter().all(|m| !is_internal(m)));
        assert_eq!(transcript(&rt, true).len(), 3);
    }

    #[test]
    fn default_variant_resolution() {
        assert_eq!(resolve_variant(""), Ok("high".into()));
        assert_eq!(resolve_variant(" Low "), Ok("low".into()));
        assert_eq!(resolve_variant("off"), Ok("off".into()));
        assert!(resolve_variant("max").is_err());
    }

    #[test]
    fn lat_row_reports_voice_note() {
        let mut run = Run {
            msg: make_message("s", "assistant", vec![]),
            text: String::new(),
            started: std::time::Instant::now(),
            first_delta_ms: None,
            upstream_calls: 1,
            retries: 0,
            first_token_seen: false,
            voice_note: true,
            reasoning_chars: 0,
            session: "s".into(),
            queue_ms: 0,
            think: 0,
            think_off: false,
            vision: false,
        };
        run.lat_log("ok"); // the eprintln row ends voice_note=1; must not panic
    }

    #[test]
    fn async_completion_status_and_text() {
        let mut ok = make_message("t", "assistant", vec![text_part("lane landed GREEN")]);
        assert_eq!(async_status(&Ok(ok.clone())), "completed");
        let t = completion_text("ses_t", "[LANE] x", "msg_u", &Ok(ok.clone()));
        assert!(t.starts_with("ASYNC-DONE turn=msg_u session=ses_t title=\"[LANE] x\" status=completed reply=msg_"));
        assert!(t.ends_with("\nlane landed GREEN"));
        ok["info"]["error"] = json!({ "name": "MessageAbortedError", "data": { "message": "aborted" } });
        assert_eq!(async_status(&Ok(ok.clone())), "aborted");
        ok["info"]["error"] = json!({ "name": "UnknownError", "data": { "message": "upstream 500" } });
        assert_eq!(async_status(&Ok(ok.clone())), "error");
        assert!(completion_text("s", "", "u", &Ok(ok)).contains("status=error"));
        let f = completion_text("s", "", "u", &Err("session s not found".into()));
        assert!(f.contains("status=failed reply=-\nerror: session s not found"));
        let long = make_message("t", "assistant", vec![text_part(&"x".repeat(5000))]);
        assert!(completion_text("s", "", "u", &Ok(long)).len() < 800);
    }

}

#[cfg(test)]
mod image_tests {
    use super::*;

    fn user(text: &str, image: Option<&str>, at: i64) -> Value {
        let mut parts = vec![json!({ "type": "text", "text": text })];
        if let Some(u) = image {
            parts.push(json!({ "type": "file", "mime": "image/png", "url": u }));
        }
        json!({ "info": { "role": "user", "time": { "created": at } }, "parts": parts })
    }

    fn reply(text: &str, at: i64) -> Value {
        json!({ "info": { "role": "assistant", "time": { "created": at, "completed": at } }, "parts": [{ "type": "text", "text": text }] })
    }

    #[test]
    fn a_session_knows_its_size() {
        assert_eq!(context_line(43_210, 200_000), "[context ≈ 43k tokens · rolls up at 200k]");
        assert_eq!(context_line(800, 0), "[context ≈ 800 tokens]");
    }

    #[test]
    fn a_quiet_answer_to_an_outcome_is_recognised() {
        assert!(is_quiet(" (quiet). ") && is_quiet("**(Quiet)**") && !is_quiet("(quiet) but done"));
        let wake = format!("[inbox] ... (done) ...\n{}", crate::tree::OUTCOME_ASK);
        let parts = vec![json!({"role": "user", "content": [{"type": "text", "text": wake}]}), json!({"role": "assistant", "content": "(quiet)"})];
        assert!(last_user_has(&parts, crate::tree::OUTCOME_ASK));
        let routine = vec![json!({"role": "user", "content": "[inbox] ... or reply exactly (quiet)."})];
        assert!(!last_user_has(&routine, crate::tree::OUTCOME_ASK));
    }

    #[test]
    fn newest_turns_carry_images_older_ones_a_note() {
        let msgs = vec![
            user("old photo", Some("data:image/png;base64,OLD"), 1),
            reply("ok", 2),
            user("middle", None, 3),
            reply("ok", 4),
            user("what does it say?", Some("data:image/png;base64,NEW"), 5),
        ];
        let convo = upstream_history(&msgs);
        let old = &convo[0]["content"];
        assert!(old.as_str().is_some_and(|t| t.contains("[1 image(s) attached earlier]")), "{old}");
        let new = &convo[4]["content"];
        assert_eq!(new[1]["image_url"]["url"], "data:image/png;base64,NEW");
        let mut c = convo.clone();
        apply_clock_headers(&mut c, SYSTEM_PREAMBLE);
        assert!(c[5]["content"][0]["text"].as_str().unwrap().starts_with("[clock "), "header rides the text part");
        assert!(rollup::est_tokens(&convo) < 2000, "an image counts as ~1.6k tokens, not its bytes");
    }
}
