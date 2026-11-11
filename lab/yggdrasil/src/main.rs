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
//!   YGG_ROLLUP_TOKENS      slice 6b: estimated-token limit for the upstream history (default 100000,
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
    collections::HashMap,
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
mod gate;
mod rollup;
mod tools;

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

/// Newest-first artifact names (files in ~/Work/bifrost/artifacts, capped at
/// `capped_at`); the names alone carry the lane story for a meanwhile summary.
fn artifact_names(capped_at: i64, max: usize) -> Vec<String> {
    let mut out: Vec<(i64, String)> = Vec::new();
    if let Ok(rd) = std::fs::read_dir("/home/dweeb_xyz/Work/bifrost/artifacts") {
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
const SYSTEM_PREAMBLE: &str = "You are the brain of a personal assistant stack. Answer in the fewest words the question allows — short and direct unless the question itself is broad. Keep the user's language. Applies to prose replies, not to tool arguments, code, or file contents.";

/// Prepends the static preamble, then the derived header to every user message
/// carrying `_ts` (compaction asks carry none), then strips every `_`-prefixed
/// key so nothing private rides upstream (either dialect).
fn apply_clock_headers(convo: &mut Vec<Value>) {
    convo.insert(0, json!({ "role": "system", "content": SYSTEM_PREAMBLE }));
    for m in convo.iter_mut() {
        if m["role"] != "user" { continue; }
        let Some(ts) = m["_ts"].as_i64() else { continue };
        let mw: Vec<String> = m["_mw"]
            .as_array()
            .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
            .unwrap_or_default();
        let hdr = clock_header(ts / 1000, m["_prev"].as_i64().map(|p| p / 1000), &mw);
        if let Some(c) = m["content"].as_str() {
            m["content"] = json!(format!("{hdr}\n{c}"));
        }
    }
    strip_private(convo);
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
    model: String,
    catalog: Value,
    max_steps: usize,
    /// [MAIN]-titled sessions (the coordinator) get a hard leash: bash timeout cap + step cap.
    main_bash_timeout_ms: u64,
    main_max_steps: usize,
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
const VOICE_TURN_NOTE: &str = "[voice turn] This reply will be spoken aloud: answer in 2 to 4 short, concrete sentences of plain speech, leading with the answer, with no lists, bullets, tables, headers, markdown, or code.";

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

/// Coordinator law (owner 11-11): the `[MAIN]` session answers from its own context and
/// delegates everything else as ONE detached agi-run lane. MAIN-only system note after the
/// preamble/voice note. Editing this constant resets [MAIN]'s provider cache once.
const COORDINATOR_NOTE: &str = "You are the coordinator. If the answer is already in this conversation, answer it directly. Anything else (reading code or files, research, building, editing, testing) you do not do yourself: delegate it in ONE bash call, exactly `cd /home/dweeb_xyz/Work/bifrost && AGI_DETACH=1 bash scripts/agi-run.sh -s <short-name> -m sonnet -a /home/dweeb_xyz/Work/bifrost/.agi-log/artifacts/<short-name>.md -b <minutes> '<self-contained brief>'` (no ; | & $ ` > inside the brief), then reply in one line naming the lane. Never write or edit files yourself.";

const VOICE_PROMPT: &str = "You are answering by voice. Answer in at most two short sentences. One thought per reply. No markdown, no emoji, no lists, no parentheses, no offers of more help. Plain words only.";

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
            Ok(s) => match s.info["id"].as_str() {
                Some(id) => {
                    out.insert(id.to_string(), s);
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

/// `POST /session` — body `{title?, parentID?}` (opencode accepts an empty body too).
async fn create_session(State(st): State<AppState>, body: Option<Json<Value>>) -> Json<Value> {
    let body = body.map(|Json(b)| b).unwrap_or(Value::Null);
    let id = new_id("ses");
    let now = now_ms();
    let title = body["title"].as_str().filter(|t| !t.is_empty()).unwrap_or("New session");
    let mut info = json!({ "id": id, "title": title, "time": { "created": now, "updated": now } });
    // variant stamp: resolved ONCE here, never per turn (cache law)
    let provider = st.config.catalog["default"].as_object().and_then(|d| d.keys().next().cloned()).unwrap_or_else(|| "yggdrasil".into());
    info["model"] = json!({ "id": st.config.model, "providerID": provider, "variant": st.config.default_variant });
    if let Some(parent) = body["parentID"].as_str() {
        info["parentID"] = json!(parent);
    }
    let session = Session { info: info.clone(), messages: Vec::new(), todo: Vec::new() };
    {
        let mut sessions = st.sessions.lock().unwrap();
        persist(&st.data_dir, &id, &session);
        sessions.insert(id, session);
    }
    publish(&st, "session.created", json!({ "info": info }));
    Json(info)
}

/// `GET /session` — newest-updated first, like opencode.
async fn list_sessions(State(st): State<AppState>) -> Json<Value> {
    let sessions = st.sessions.lock().unwrap();
    let mut infos: Vec<Value> = sessions.values().map(|s| s.info.clone()).collect();
    infos.sort_by_key(|i| std::cmp::Reverse(i["time"]["updated"].as_u64().unwrap_or(0)));
    Json(Value::Array(infos))
}

async fn get_session(State(st): State<AppState>, Path(id): Path<String>) -> Response {
    match st.sessions.lock().unwrap().get(&id) {
        Some(s) => Json(s.info.clone()).into_response(),
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

/// `GET /agent` — `[{name, mode, description}]` from the catalog.
async fn list_agents(State(st): State<AppState>) -> Json<Value> {
    Json(st.config.catalog["agents"].clone())
}

/// `POST /api/session/:id/model` — v2 switch, `{model:{id, providerID}}` → 204.
/// The model must exist in the catalog. Recorded on the session; the upstream call
/// still goes to the one configured upstream model (single-provider relay).
async fn switch_model(State(st): State<AppState>, Path(id): Path<String>, Json(body): Json<Value>) -> Response {
    let (Some(mid), Some(pid)) = (body["model"]["id"].as_str(), body["model"]["providerID"].as_str()) else {
        return bad_request("model needs id + providerID");
    };
    let known = st.config.catalog["providers"]
        .as_array()
        .into_iter()
        .flatten()
        .any(|p| p["id"] == pid && p["models"].get(mid).is_some());
    if !known {
        return bad_request(&format!("unknown model {pid}/{mid}"));
    }
    let mut model = json!({ "id": mid, "providerID": pid });
    match with_session(&st, &id, |s| {
        // the variant stamp survives a model switch (thinking stays constant per session)
        if let Some(v) = s.info["model"].get("variant").cloned() {
            model["variant"] = v;
        }
        s.info["model"] = model
    }) {
        Some(()) => StatusCode::NO_CONTENT.into_response(),
        None => not_found(&id),
    }
}

/// `POST /api/session/:id/agent` — v2 switch, `{agent}` → 204. Must be a catalog agent.
async fn switch_agent(State(st): State<AppState>, Path(id): Path<String>, Json(body): Json<Value>) -> Response {
    let Some(name) = body["agent"].as_str() else { return bad_request("agent required") };
    let known = st.config.catalog["agents"].as_array().into_iter().flatten().any(|a| a["name"] == name);
    if !known {
        return bad_request(&format!("unknown agent {name}"));
    }
    match with_session(&st, &id, |s| s.info["agent"] = json!(name)) {
        Some(()) => StatusCode::NO_CONTENT.into_response(),
        None => not_found(&id),
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

async fn post_message(
    State(st): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<PostMessage>,
) -> Response {
    let modality = body.modality.clone();
    let auto_turn = body.meta.as_ref().is_some_and(|m| m["auto"] == true);
    let internal = body.internal
        || body.meta.as_ref().is_some_and(|m| m["internal"] == true)
        || body.parts.iter().any(|p| p["internal"] == true);
    // Text parts go upstream; file parts (data: URLs) are stored so the transcript keeps them.
    let parts: Vec<Value> = body
        .parts
        .into_iter()
        .filter(|p| (p["type"] == "text" && p["text"].is_string()) || (p["type"] == "file" && p["url"].is_string()))
        .collect();
    if parts.is_empty() {
        return bad_request("no text or file parts");
    }
    let want_sse = headers
        .get(header::ACCEPT)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|a| a.contains("text/event-stream"));

    // The user message lands at once (a stacked prompt is visible while it waits its turn).
    let mut user_msg = make_message(&id, "user", parts);
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
    let stored = with_session(&st, &id, |s| {
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
        collapse_stale_station(&mut s.messages);
    });
    if stored.is_none() {
        return not_found(&id);
    }
    if !internal {
        publish(&st, "message.updated", json!({ "info": user_msg["info"] }));
    }

    let enqueued = std::time::Instant::now(); // LAT queue_ms: enqueue → run slot
    let gate = st.run_locks.lock().unwrap().entry(id.clone()).or_default().clone();
    let ticket = gate.ticket(auto_turn);
    let (tx, rx) = mpsc::channel::<Event>(64);
    let (done_tx, done_rx) = oneshot::channel::<Result<Value, String>>();
    tokio::spawn(async move {
        match gate.admit(&ticket).await {
            gate::Admit::Go(mut permit) => {
                let queue_ms = enqueued.elapsed().as_millis() as u64;
                let result = run_turn(&st, &id, &tx, queue_ms, auto_turn).await;
                permit.finish(&result);
                let _ = done_tx.send(result);
                // roll-up runs AFTER the reply, still inside the run slot (item 2)
                rollup_after_reply(&st, &id, &tx).await;
            }
            gate::Admit::Coalesced(rx) => {
                let _ = done_tx.send(rx.await.unwrap_or_else(|_| Err("coalesced auto turn dropped".into())));
            }
        }
        drop(ticket);
    });

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
        if role == "user" && !compaction {
            skip_reply = false;
            if let Some(d) = m["info"]["meta"]["digest"].as_str() {
                // frozen one-line station turn; its autoReply is folded into the line
                out.push(json!({ "role": "user", "content": d }));
                skip_reply = true;
                continue;
            }
        }
        if role == "assistant" && skip_reply && m["info"]["meta"]["autoReply"] == true {
            continue;
        }
        if role != "assistant" {
            let mut text = if compaction { rollup::COMPACTION_ASK.to_string() } else { message_text(m) };
            if role == "user" && !compaction && !text.is_empty() && is_voice_turn(m) {
                // last text block of the stored voice turn; a pure function of
                // stored history, so earlier bytes never change (cache law)
                text.push('\n');
                text.push_str(VOICE_TURN_NOTE);
            }
            if !text.is_empty() {
                let mut u = json!({ "role": role, "content": text });
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

/// Station turns (auto user message + its autoReply) kept verbatim in the upstream view.
const STATION_KEEP: usize = 3;

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
        let reply = messages.get(i + 1).filter(|m| m["info"]["meta"]["autoReply"] == true && m["info"]["time"]["completed"].is_number());
        let line = match reply {
            Some(r) => format!("[station turn] {} => {}", first_line(&message_text(&messages[i]), 160), first_line(&message_text(r), 160)),
            None => format!("[station turn] {}", first_line(&message_text(&messages[i]), 160)),
        };
        messages[i]["info"]["meta"]["digest"] = json!(line);
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
    };
    let outcome = {
        let fut = agent_loop(st, id, history, tx, &mut run);
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
    apply_clock_headers(&mut convo);
    if st.config.voice {
        convo.insert(1, json!({ "role": "system", "content": VOICE_PROMPT }));
    }
    let main = session_is_main(st, id);
    if main {
        convo.insert(if st.config.voice { 2 } else { 1 }, json!({ "role": "system", "content": COORDINATOR_NOTE }));
    }
    let max = step_cap(st.config.max_steps, st.config.main_max_steps, main);
    for _ in 0..max {
        if st.config.rollup_tokens > 0 {
            let n = rollup::prune(&mut convo, st.config.rollup_tokens);
            if n > 0 {
                eprintln!("roll-up: pruned {n} old tool output(s) in session {id}");
            }
        }
        let calls = relay(st, id, &convo, tx, run).await?;
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
        run.flush_text(Some((st.config.voice, st.config.voice_max_words)));
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

fn session_is_main(st: &AppState, id: &str) -> bool {
    st.sessions.lock().unwrap().get(id).is_some_and(|s| is_main_title(s.info["title"].as_str().unwrap_or_default()))
}

/// Upstream-call cap for a run: the MAIN cap never raises the global one.
fn step_cap(global: usize, main_cap: usize, main: bool) -> usize {
    if main { main_cap.min(global) } else { global }
}

/// Clamp a bash call's timeout to `cap_ms` (an absent timeout means the tool default).
fn cap_bash_input(input: &mut Value, cap_ms: u64, default_ms: u64) {
    let want = input["timeout"].as_u64().unwrap_or(default_ms);
    if let Some(o) = input.as_object_mut() {
        o.insert("timeout".into(), json!(want.min(cap_ms)));
    }
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
        Ok(mut input) => {
            if call.name == "bash" && session_is_main(st, id) {
                cap_bash_input(&mut input, st.config.main_bash_timeout_ms, st.tools.bash_timeout.as_millis() as u64);
            }
            tools::run(&st.tools, &call.name, &input).await
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
    let resp = req
        .try_clone()
        .ok_or("request not cloneable")?
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;
    let code = resp.status().as_u16();
    if code == 529 || code == 503 {
        *retries += 1;
        tokio::time::sleep(std::time::Duration::from_millis(1800)).await;
        eprintln!("LAT-RETRY upstream {code} — transient, retrying once after 1.8s (retry #{retries})");
        return req
            .try_clone()
            .ok_or("request not cloneable")?
            .send()
            .await
            .map_err(|e| format!("request failed: {e}"));
    }
    Ok(resp)
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
    let mut body = json!({ "model": cfg.model, "messages": convo, "stream": true });
    if cfg.tools_enabled {
        body["tools"] = tools::schemas();
    }
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
    convo: &[Value],
    tools: Option<&Value>,
    stream: bool,
    thinking: Option<&Value>,
) -> reqwest::RequestBuilder {
    let cfg = &st.config;
    let body = anthropic::body(&cfg.model, cfg.max_tokens, convo, tools, stream, thinking);
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
    let tools = cfg.tools_enabled.then(tools::schemas);
    // thinking: the session's create-time stamp; an unstamped legacy session follows YGG_DEFAULT_VARIANT
    let variant = st.sessions.lock().unwrap().get(session_id).and_then(|s| s.info["model"]["variant"].as_str().map(String::from));
    let thinking = anthropic::thinking_for(Some(variant.as_deref().unwrap_or(&cfg.default_variant)), cfg.think_high);
    run.think = thinking.as_ref().and_then(|t| t["budget_tokens"].as_u64()).unwrap_or(0);
    let req = anthropic_request(st, convo, tools.as_ref(), true, thinking.as_ref());
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
    let resp = anthropic_request(st, &convo, None, false, None).send().await.map_err(|e| format!("request failed: {e}"))?;
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
    let rollup_tokens = env_num("YGG_ROLLUP_TOKENS", 100_000);
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
    let config = Config {
        default_variant,
        think_high,
        base_url,
        dialect,
        max_tokens,
        api_key: std::env::var("YGG_UPSTREAM_API_KEY").ok().filter(|k| !k.is_empty()),
        catalog: load_catalog(&model),
        model,
        max_steps: env_num("YGG_MAX_STEPS", 100).max(1) as usize,
        main_bash_timeout_ms: env_num("YGG_MAIN_BASH_TIMEOUT_MS", 15_000).max(1) as u64,
        main_max_steps: env_num("YGG_MAIN_MAX_STEPS", 6).max(1) as usize,
        tools_enabled: std::env::var("YGG_TOOLS").map_or(true, |v| v != "0"),
        voice: std::env::var("YGG_VOICE").map_or(false, |v| v == "1"),
        voice_max_words: env_num("YGG_VOICE_MAX_WORDS", 60).max(5) as usize,
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
    let listen = std::env::var("YGG_LISTEN").unwrap_or_else(|_| "127.0.0.1:4096".into());
    let data_dir = PathBuf::from(std::env::var("YGG_DATA_DIR").unwrap_or_else(|_| "./data".into()));
    std::fs::create_dir_all(data_dir.join("session")).expect("create YGG_DATA_DIR");
    let sessions = load_sessions(&data_dir);
    eprintln!("loaded {} session(s) from {}", sessions.len(), data_dir.display());

    let state = AppState {
        sessions: Arc::new(Mutex::new(sessions)),
        running: Arc::default(),
        run_locks: Arc::default(),
        bus: broadcast::channel(1024).0,
        data_dir: Arc::new(data_dir),
        config: Arc::new(config),
        http,
        tools: Arc::new(tool_env),
    };
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
        .route("/event", get(events))
        .with_state(state);

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
        apply_clock_headers(&mut convo);
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
        apply_clock_headers(&mut convo);
        assert_eq!(convo[1]["content"], json!([{"type": "text", "text": "x"}]));
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
        assert_eq!(step_cap(100, 6, true), 6);
        assert_eq!(step_cap(100, 6, false), 100);
        assert_eq!(step_cap(4, 6, true), 4); // never raises the global cap
        let mut a = json!({ "command": "sleep 600", "timeout": 600000 });
        cap_bash_input(&mut a, 15000, 120000);
        assert_eq!(a["timeout"], json!(15000));
        let mut b = json!({ "command": "ls" }); // absent = tool default 120s, still capped
        cap_bash_input(&mut b, 15000, 120000);
        assert_eq!(b["timeout"], json!(15000));
        let mut c = json!({ "command": "ls", "timeout": 2000 });
        cap_bash_input(&mut c, 15000, 120000);
        assert_eq!(c["timeout"], json!(2000)); // shorter requests untouched
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
    fn station_history_collapses_beyond_last_three_and_is_frozen() {
        let mut msgs: Vec<Value> = vec![];
        msgs.extend(pair(0, false)); // owner turn: verbatim forever
        for n in 1..=5 {
            msgs.extend(pair(n, true));
        }
        collapse_stale_station(&mut msgs);
        let h = upstream_history(&msgs);
        // owner pair (2) + 2 collapsed single lines + 3 verbatim pairs (6)
        assert_eq!(h.len(), 2 + 2 + 6);
        assert_eq!(h[2]["content"], json!("[station turn] landing 1 => verdict 1"));
        assert_eq!(h[3]["content"], json!("[station turn] landing 2 => verdict 2"));
        assert_eq!(h[0]["content"], json!("landing 0\nsecond line"));
        assert!(h[4]["content"].as_str().unwrap().contains("landing 3"));
        // append-only: another station turn only changes the digest of the one aging out
        let before = h[..4].to_vec();
        msgs.extend(pair(6, true));
        collapse_stale_station(&mut msgs);
        let h2 = upstream_history(&msgs);
        assert_eq!(&h2[..4], &before[..]);
        assert_eq!(h2[4]["content"], json!("[station turn] landing 3 => verdict 3"));
        // idempotent
        let snap = upstream_history(&msgs);
        collapse_stale_station(&mut msgs);
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
        collapse_stale_station(&mut msgs);
        assert!(msgs.iter().all(|m| m["info"]["meta"]["digest"].is_null()));
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
        apply_clock_headers(&mut convo);
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
        };
        run.lat_log("ok"); // the eprintln row ends voice_note=1; must not panic
    }
}
