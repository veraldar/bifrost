//! Slice 7: the anthropic upstream dialect (`YGG_UPSTREAM_STYLE=anthropic`).
//!
//! The run keeps ONE internal conversation shape — the OpenAI-shaped list that
//! `upstream_history`, the agent loop, roll-up and prune already build — and this module
//! translates it at the wire boundary only. Roll-up thresholds are estimated on the
//! internal shape, so both dialects take the same roll-up/prune decisions and store the
//! same transcript.
//!
//! Request (`POST {base}/v1/messages`, `{model, max_tokens, system?, messages, tools?, stream}`):
//! - `system`-role messages (only the roll-up's summarizer prompt today) → top-level
//!   `system` string, joined with blank lines; omitted when empty. The stored roll-up
//!   summary itself is NOT a system message: it stays the opencode-shaped pair (user
//!   "What did we do so far?" + assistant summary), which maps to two ordinary turns.
//! - user text → `{type:text}` block; assistant text + `tool_calls` → `text` + `tool_use`
//!   blocks (`input` = the parsed arguments object; unparsable arguments → `{"raw": ...}`);
//!   each `tool` message → a `tool_result` block in the next user turn (empty output →
//!   "(no output)"; errors keep the "Error: ..." text the OpenAI dialect sends).
//! - consecutive same-role turns are merged (the API wants strict alternation): tool
//!   results open their user turn, so they always come first.
//! - empty/whitespace text blocks are dropped (the API rejects them); tool ids are
//!   sanitized to `[A-Za-z0-9_-]` (ids minted by other providers may not fit the pattern).
//! - tools: `{type:function, function:{name, description, parameters}}` →
//!   `{name, description, input_schema}`.
//!
//! Response: block SSE (`message_start`, `content_block_start/delta/stop` with `text_delta`
//! and `input_json_delta`, `message_delta` with `stop_reason`, `message_stop`, `ping`,
//! `error`) or a plain JSON message. `thinking` blocks are ignored, like the OpenAI
//! dialect ignores reasoning deltas (reasoning passthrough = slice 6c).

use std::collections::HashMap;

use serde_json::{Value, json};

pub const VERSION: &str = "2023-06-01";

/// `{base}/v1/messages`; a base that already ends in `/v1` gets only `/messages`.
pub fn messages_url(base: &str) -> String {
    let base = base.trim_end_matches('/');
    if base.ends_with("/v1") { format!("{base}/messages") } else { format!("{base}/v1/messages") }
}

pub fn body(model: &str, max_tokens: u64, convo: &[Value], tools: Option<&Value>, stream: bool) -> Value {
    let (system, messages) = convert(convo);
    let mut b = json!({ "model": model, "max_tokens": max_tokens, "messages": messages, "stream": stream });
    if !system.is_empty() {
        b["system"] = json!(system);
    }
    if let Some(t) = tools {
        b["tools"] = self::tools(t);
    }
    b
}

pub fn tools(openai: &Value) -> Value {
    let out: Vec<Value> = openai
        .as_array()
        .into_iter()
        .flatten()
        .map(|t| {
            let f = &t["function"];
            json!({ "name": f["name"], "description": f["description"], "input_schema": f["parameters"] })
        })
        .collect();
    json!(out)
}

pub fn sanitize_id(id: &str) -> String {
    let s: String = id.chars().map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' }).collect();
    if s.is_empty() { "call".into() } else { s }
}

fn text_blocks(content: &Value) -> Vec<Value> {
    match content.as_str() {
        Some(t) if !t.trim().is_empty() => vec![json!({ "type": "text", "text": t })],
        _ => Vec::new(),
    }
}

/// Internal (OpenAI-shaped) conversation → `(system, messages)`.
pub fn convert(convo: &[Value]) -> (String, Vec<Value>) {
    let mut system: Vec<String> = Vec::new();
    let mut out: Vec<Value> = Vec::new();
    for m in convo {
        let role = m["role"].as_str().unwrap_or("user");
        let blocks = match role {
            "system" => {
                if let Some(t) = m["content"].as_str().filter(|t| !t.trim().is_empty()) {
                    system.push(t.to_string());
                }
                continue;
            }
            "tool" => {
                let content = m["content"].as_str().filter(|c| !c.is_empty()).unwrap_or("(no output)");
                vec![json!({ "type": "tool_result",
                    "tool_use_id": sanitize_id(m["tool_call_id"].as_str().unwrap_or_default()), "content": content })]
            }
            "assistant" => {
                let mut b = text_blocks(&m["content"]);
                for tc in m["tool_calls"].as_array().into_iter().flatten() {
                    let args = tc["function"]["arguments"].as_str().unwrap_or_default();
                    let input = match serde_json::from_str::<Value>(args) {
                        Ok(v @ Value::Object(_)) => v,
                        _ if args.trim().is_empty() => json!({}),
                        _ => json!({ "raw": args }),
                    };
                    b.push(json!({ "type": "tool_use", "id": sanitize_id(tc["id"].as_str().unwrap_or_default()),
                        "name": tc["function"]["name"], "input": input }));
                }
                b
            }
            _ => text_blocks(&m["content"]),
        };
        if blocks.is_empty() {
            continue;
        }
        let role = if role == "assistant" { "assistant" } else { "user" };
        match out.last_mut() {
            Some(prev) if prev["role"] == role => prev["content"].as_array_mut().unwrap().extend(blocks),
            _ => out.push(json!({ "role": role, "content": blocks })),
        }
    }
    // A trailing assistant turn is a prefill: the API rejects trailing whitespace there.
    if let Some(last) = out.last_mut().filter(|m| m["role"] == "assistant") {
        let blocks = last["content"].as_array_mut().unwrap();
        if let Some(t) = blocks.last_mut().filter(|b| b["type"] == "text") {
            let trimmed = t["text"].as_str().unwrap_or_default().trim_end().to_string();
            t["text"] = json!(trimmed);
        }
        blocks.retain(|b| b["type"] != "text" || !b["text"].as_str().unwrap_or_default().is_empty());
        if blocks.is_empty() {
            out.pop();
        }
    }
    (system.join("\n\n"), out)
}

/// A tool call as the upstream sent it. Its upstream id is not kept: the relay re-keys
/// calls to yggdrasil ids.
#[derive(Default, Debug)]
pub struct Call {
    pub name: String,
    pub args: String,
    /// `args` came whole from `content_block_start` (streamed deltas replace it).
    seeded: bool,
}

/// Block-SSE decoder: feed every `data:` JSON in order.
#[derive(Default)]
pub struct Stream {
    pub calls: Vec<Call>,
    open: HashMap<u64, usize>,
    pub stop_reason: Option<String>,
    pub stopped: bool,
}

impl Stream {
    /// Returns the text delta carried by this event, if any.
    pub fn feed(&mut self, v: &Value) -> Result<Option<String>, String> {
        let index = v["index"].as_u64().unwrap_or(0);
        match v["type"].as_str() {
            Some("content_block_start") => {
                let b = &v["content_block"];
                match b["type"].as_str() {
                    Some("tool_use") => {
                        let seed = match &b["input"] {
                            Value::Object(o) if !o.is_empty() => b["input"].to_string(),
                            _ => String::new(),
                        };
                        self.open.insert(index, self.calls.len());
                        self.calls.push(Call {
                            name: b["name"].as_str().unwrap_or_default().into(),
                            seeded: !seed.is_empty(),
                            args: seed,
                        });
                    }
                    Some("text") => return Ok(b["text"].as_str().filter(|t| !t.is_empty()).map(String::from)),
                    _ => {}
                }
            }
            Some("content_block_delta") => {
                let d = &v["delta"];
                match d["type"].as_str() {
                    Some("text_delta") => return Ok(d["text"].as_str().filter(|t| !t.is_empty()).map(String::from)),
                    Some("input_json_delta") => {
                        if let Some(&c) = self.open.get(&index) {
                            let call = &mut self.calls[c];
                            if call.seeded {
                                call.args.clear();
                                call.seeded = false;
                            }
                            call.args.push_str(d["partial_json"].as_str().unwrap_or_default());
                        }
                    }
                    _ => {}
                }
            }
            Some("message_delta") => {
                if let Some(r) = v["delta"]["stop_reason"].as_str() {
                    self.stop_reason = Some(r.into());
                }
            }
            Some("message_stop") => self.stopped = true,
            Some("error") => return Err(format!("upstream stream error: {}", v["error"])),
            _ => {} // message_start, content_block_stop, ping
        }
        Ok(None)
    }
}

/// A non-streamed message: `(text, calls, stop_reason)`.
pub fn parse_message(v: &Value) -> (String, Vec<Call>, Option<String>) {
    let mut text = String::new();
    let mut calls = Vec::new();
    for b in v["content"].as_array().into_iter().flatten() {
        match b["type"].as_str() {
            Some("text") => text.push_str(b["text"].as_str().unwrap_or_default()),
            Some("tool_use") => calls.push(Call {
                name: b["name"].as_str().unwrap_or_default().into(),
                args: b["input"].to_string(),
                seeded: false,
            }),
            _ => {}
        }
    }
    (text, calls, v["stop_reason"].as_str().map(String::from))
}

/// Splits a streamed body into SSE `data:` payloads. Lines are decoded whole, so a
/// multi-byte character split across network chunks survives.
#[derive(Default)]
pub struct SseLines {
    buf: Vec<u8>,
}

impl SseLines {
    pub fn push(&mut self, chunk: &[u8]) -> Vec<String> {
        self.buf.extend_from_slice(chunk);
        let mut out = Vec::new();
        while let Some(nl) = self.buf.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = self.buf.drain(..=nl).collect();
            let line = String::from_utf8_lossy(&line);
            if let Some(data) = line.trim().strip_prefix("data:") {
                out.push(data.trim().to_string());
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url() {
        assert_eq!(messages_url("https://api.z.ai/api/anthropic"), "https://api.z.ai/api/anthropic/v1/messages");
        assert_eq!(messages_url("https://api.anthropic.com/"), "https://api.anthropic.com/v1/messages");
        assert_eq!(messages_url("http://h:1/v1"), "http://h:1/v1/messages");
    }

    #[test]
    fn converts_tool_loop_history() {
        let convo = vec![
            json!({"role":"system","content":"[sys]"}),
            json!({"role":"user","content":"go"}),
            json!({"role":"assistant","content":"step 0.","tool_calls":[
                {"id":"call_a","type":"function","function":{"name":"bash","arguments":"{\"command\":\"ls\"}"}},
                {"id":"functions.edit:1","type":"function","function":{"name":"edit","arguments":"{bad"}}]}),
            json!({"role":"tool","tool_call_id":"call_a","content":""}),
            json!({"role":"tool","tool_call_id":"functions.edit:1","content":"Error: nope"}),
            json!({"role":"user","content":"next"}),
            json!({"role":"assistant","content":null}),
            json!({"role":"user","content":"   "}),
        ];
        let (system, m) = convert(&convo);
        assert_eq!(system, "[sys]");
        assert_eq!(m.len(), 3, "{m:#?}");
        assert_eq!(m[0], json!({"role":"user","content":[{"type":"text","text":"go"}]}));
        let a = m[1]["content"].as_array().unwrap();
        assert_eq!(a[0], json!({"type":"text","text":"step 0."}));
        assert_eq!(a[1], json!({"type":"tool_use","id":"call_a","name":"bash","input":{"command":"ls"}}));
        assert_eq!(a[2]["id"], "functions_edit_1");
        assert_eq!(a[2]["input"], json!({"raw":"{bad"}));
        let u = m[2]["content"].as_array().unwrap();
        assert_eq!(u[0], json!({"type":"tool_result","tool_use_id":"call_a","content":"(no output)"}));
        assert_eq!(u[1], json!({"type":"tool_result","tool_use_id":"functions_edit_1","content":"Error: nope"}));
        assert_eq!(u[2], json!({"type":"text","text":"next"}));
        assert_eq!(u.len(), 3);
    }

    #[test]
    fn trailing_assistant_prefill_trimmed() {
        let (_, m) = convert(&[json!({"role":"user","content":"a"}), json!({"role":"assistant","content":"b \n"})]);
        assert_eq!(m[1]["content"][0]["text"], "b");
        let (_, m) = convert(&[json!({"role":"user","content":"a"}), json!({"role":"assistant","content":" "})]);
        assert_eq!(m.len(), 1);
    }

    #[test]
    fn decodes_block_stream() {
        let mut s = Stream::default();
        let evs = [
            json!({"type":"message_start","message":{"id":"m","content":[]}}),
            json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}),
            json!({"type":"ping"}),
            json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi "}}),
            json!({"type":"content_block_stop","index":0}),
            json!({"type":"content_block_start","index":1,"content_block":{"type":"thinking","thinking":""}}),
            json!({"type":"content_block_delta","index":1,"delta":{"type":"thinking_delta","thinking":"hmm"}}),
            json!({"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"toolu_1","name":"bash","input":{}}}),
            json!({"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\"comm"}}),
            json!({"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"and\":\"ls\"}"}}),
            json!({"type":"content_block_start","index":3,"content_block":{"type":"tool_use","id":"toolu_2","name":"read","input":{"filePath":"x"}}}),
            json!({"type":"message_delta","delta":{"stop_reason":"tool_use"}}),
            json!({"type":"message_stop"}),
        ];
        let text: String = evs.iter().filter_map(|e| s.feed(e).unwrap()).collect();
        assert_eq!(text, "hi ");
        assert!(s.stopped && s.stop_reason.as_deref() == Some("tool_use"));
        assert_eq!((s.calls[0].name.as_str(), s.calls[0].args.as_str()), ("bash", "{\"command\":\"ls\"}"));
        assert_eq!(s.calls[1].args, "{\"filePath\":\"x\"}");
        assert!(Stream::default().feed(&json!({"type":"error","error":{"type":"overloaded_error"}})).is_err());
    }

    #[test]
    fn sse_lines_keep_split_utf8() {
        let mut l = SseLines::default();
        let bytes = "event: x\ndata: {\"t\":\"é\"}\n\n".as_bytes();
        let cut = bytes.iter().position(|&b| b == 0xc3).unwrap() + 1; // inside "é"
        assert!(l.push(&bytes[..cut]).is_empty());
        assert_eq!(l.push(&bytes[cut..]), vec!["{\"t\":\"é\"}".to_string()]);
    }
}
