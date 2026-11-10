//! Slice 6b: context roll-up for marathon sessions (LIFE.md pattern 1: a 148k-token
//! history can't go upstream raw every turn).
//!
//! Two mechanisms, both keyed on `YGG_ROLLUP_TOKENS` (estimated tokens, 0 = off):
//! - **Roll-up** (run start, one extra upstream call): the older part of the history is
//!   summarized and the summary is stored opencode-style — a user message with a
//!   `{"type":"compaction","auto":true}` part, then an assistant message with
//!   `info.summary: true` carrying the summary text. Upstream history starts at the latest
//!   compaction; the recent tail (`YGG_ROLLUP_KEEP_TOKENS`) stays verbatim.
//! - **Prune** (inside one run, no extra call): when a single run's tool outputs push the
//!   conversation over the limit, older tool results are replaced by a stub in the upstream
//!   view only. The stored parts keep the full output.
//!
//! Token counts are estimates (bytes of the JSON request / 4). There's no tokenizer for
//! every upstream, and the limit only needs to be in the right range.

use serde_json::{Value, json};

/// What the compaction user message says upstream (opencode's wording).
pub const COMPACTION_ASK: &str = "What did we do so far?";
/// Replaces an old tool result in the upstream view.
pub const PRUNED: &str = "[old tool output pruned by roll-up; re-run the tool if you need it]";
/// Max chars of one tool result inside the summary transcript.
const TRANSCRIPT_TOOL_CHARS: usize = 2_000;

pub const PROMPT: &str = "[yggdrasil roll-up] You are compressing an agent conversation so it can continue \
in a fresh context. Write a dense summary that a coding agent can resume from: the user's goals and \
preferences, decisions made, files and commands touched (exact paths), results of tool runs that still \
matter, errors and how they were resolved, the current state, and open tasks. Plain text, no preamble.";

pub fn est_tokens(convo: &[Value]) -> usize {
    serde_json::to_string(convo).map_or(0, |s| s.len()) / 4
}

/// Prunes old tool results (oldest first, never the latest step's) until the estimate
/// fits `limit`. Returns how many were pruned.
pub fn prune(convo: &mut [Value], limit: usize) -> usize {
    let mut est = est_tokens(convo);
    if est <= limit {
        return 0;
    }
    let latest_step = convo.iter().rposition(|m| m["role"] == "assistant" && m.get("tool_calls").is_some());
    let end = latest_step.unwrap_or(convo.len());
    let mut n = 0;
    for m in convo[..end].iter_mut() {
        if est <= limit {
            break;
        }
        if m["role"] != "tool" || m["content"] == PRUNED {
            continue;
        }
        let old = m["content"].as_str().map_or(0, str::len);
        m["content"] = json!(PRUNED);
        est = est.saturating_sub(old.saturating_sub(PRUNED.len()) / 4);
        n += 1;
    }
    n
}

/// Renders upstream messages as a plain transcript for the summarizer.
pub fn transcript(convo: &[Value]) -> String {
    let mut out = String::new();
    for m in convo {
        let role = m["role"].as_str().unwrap_or("?");
        if let Some(c) = m["content"].as_str().filter(|c| !c.is_empty()) {
            let c = if role == "tool" { clip(c, TRANSCRIPT_TOOL_CHARS) } else { c.to_string() };
            out.push_str(&format!("{}: {c}\n\n", role.to_uppercase()));
        }
        for tc in m["tool_calls"].as_array().into_iter().flatten() {
            let f = &tc["function"];
            out.push_str(&format!("ASSISTANT called {}({})\n\n", f["name"].as_str().unwrap_or("?"),
                clip(f["arguments"].as_str().unwrap_or(""), TRANSCRIPT_TOOL_CHARS)));
        }
    }
    out
}

fn clip(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut cut = max;
    while !s.is_char_boundary(cut) {
        cut -= 1;
    }
    format!("{} [... {} more bytes]", &s[..cut], s.len() - cut)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prune_spares_latest_step() {
        let big = "x".repeat(4000);
        let mut c = vec![
            json!({"role":"user","content":"go"}),
            json!({"role":"assistant","content":null,"tool_calls":[{"id":"a"}]}),
            json!({"role":"tool","tool_call_id":"a","content":big}),
            json!({"role":"assistant","content":null,"tool_calls":[{"id":"b"}]}),
            json!({"role":"tool","tool_call_id":"b","content":big}),
        ];
        assert_eq!(prune(&mut c, 100), 1);
        assert_eq!(c[2]["content"], PRUNED);
        assert_eq!(c[4]["content"].as_str().unwrap().len(), 4000);
        assert_eq!(prune(&mut c, 100_000), 0);
    }
}
