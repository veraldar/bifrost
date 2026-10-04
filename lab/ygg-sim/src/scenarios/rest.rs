//! `rest.*` scenarios — the PWA-proxy view of the real yggdrasil.

use std::time::{Duration, Instant};

use serde_json::Value;

use crate::httpc::ShapedHttp;
use crate::runner::{Metrics, Verdict};
use crate::wire::{profile_home, profile_phone};
use crate::world::{World, WorldOpts};

pub fn registry() -> Vec<crate::runner::ScenarioDef> {
    vec![
        crate::runner::ScenarioDef {
            name: "rest.text-roundtrip",
            device: "desktop",
            profile: "home",
            run: text_roundtrip,
        },
        crate::runner::ScenarioDef {
            name: "rest.abort-mid-run",
            device: "desktop",
            profile: "home",
            run: abort_mid_run,
        },
        crate::runner::ScenarioDef {
            name: "rest.refresh-reread",
            device: "phone",
            profile: "phone-cell",
            run: refresh_reread,
        },
        crate::runner::ScenarioDef {
            name: "rest.marathon-rollup",
            device: "desktop",
            profile: "home",
            run: marathon_rollup,
        },
        crate::runner::ScenarioDef {
            name: "rest.upstream-down",
            device: "desktop",
            profile: "home",
            run: upstream_down,
        },
    ]
}

fn transcript_of(world: &World, http: &mut ShapedHttp, sid: &str) -> Result<Value, String> {
    let raw = http.get(&format!("{}/session/{sid}/message", world.ygg_url()))?;
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}

fn assistant_texts(v: &Value) -> Vec<String> {
    v.as_array()
        .map(|a| {
            a.iter()
                .filter(|m| m["info"]["role"] == "assistant")
                .map(message_text)
                .collect()
        })
        .unwrap_or_default()
}

fn message_text(m: &Value) -> String {
    m["parts"]
        .as_array()
        .map(|ps| {
            ps.iter()
                .filter(|p| p["type"] == "text")
                .filter_map(|p| p["text"].as_str())
                .collect::<Vec<_>>()
                .join("")
        })
        .unwrap_or_default()
}

fn create_session(world: &World, http: &mut ShapedHttp, title: &str) -> Result<String, String> {
    let raw = http.post_json(
        &format!("{}/session", world.ygg_url()),
        &serde_json::json!({ "title": title }).to_string(),
    )?;
    serde_json::from_str::<Value>(&raw)
        .map_err(|e| e.to_string())?
        .get("id")
        .and_then(|i| i.as_str())
        .map(String::from)
        .ok_or_else(|| format!("no id in {raw}"))
}

/// One full turn, prompt → final assistant message (opencode blocks like the
/// proxy path does when the PWA does not stream).
fn prompt_wait(
    world: &World,
    http: &mut ShapedHttp,
    sid: &str,
    text: &str,
) -> Result<(String, u64), String> {
    let t0 = Instant::now();
    let raw = http.post_json(
        &format!("{}/session/{sid}/message", world.ygg_url()),
        &serde_json::json!({ "parts": [{ "type": "text", "text": text }] }).to_string(),
    )?;
    Ok((raw, t0.elapsed().as_millis() as u64))
}

fn text_roundtrip() -> (Verdict, Metrics) {
    let mut m = Metrics::new();
    let world = match World::spawn(WorldOpts::default()) {
        Ok(w) => w,
        Err(e) => return (Verdict::Fail(format!("world: {e}")), m),
    };
    let mut http = ShapedHttp::new(0xA01, &profile_home().fwd);

    let sid = match create_session(&world, &mut http, "sim text roundtrip") {
        Ok(s) => s,
        Err(e) => return (Verdict::Fail(e), m),
    };
    let (reply, ms) = match prompt_wait(&world, &mut http, &sid, "hello from the matrix") {
        Ok(r) => r,
        Err(e) => return (Verdict::Fail(e), m),
    };
    if !reply.contains("MOCK-REPLY: you said 'hello from the matrix'") {
        return (Verdict::Fail(format!("wrong echo: {reply}")), m);
    }
    let tr = match transcript_of(&world, &mut http, &sid) {
        Ok(t) => t,
        Err(e) => return (Verdict::Fail(e), m),
    };
    if assistant_texts(&tr).len() != 1 {
        return (Verdict::Fail("expected exactly one assistant reply".into()), m);
    }
    m = m.lat("turn", ms);
    (Verdict::Pass, m)
}

fn abort_mid_run() -> (Verdict, Metrics) {
    let mut m = Metrics::new();
    let world = match World::spawn(WorldOpts::default()) {
        Ok(w) => w,
        Err(e) => return (Verdict::Fail(format!("world: {e}")), m),
    };
    let mut http = ShapedHttp::new(0xA02, &profile_home().fwd);

    let sid = match create_session(&world, &mut http, "sim abort") {
        Ok(s) => s,
        Err(e) => return (Verdict::Fail(e), m),
    };

    // fire a slow run (the mock streams for ~10s) from its own thread — the
    // plain post BLOCKS until the run ends, which is exactly how the PWA's
    // proxy experiences it; abort arrives from this thread mid-run.
    let url = world.ygg_url();
    let sid_t = sid.clone();
    let handle = std::thread::spawn(move || {
        let agent = ureq::AgentBuilder::new()
            .timeout(Duration::from_secs(30))
            .build();
        agent
            .post(&format!("{url}/session/{sid_t}/message"))
            .set("Content-Type", "application/json")
            .send_string(r#"{ "parts": [{ "type": "text", "text": "slow please" }] }"#)
    });
    std::thread::sleep(Duration::from_millis(1500));

    // the run must be visible as busy
    match http.get(&format!("{}/session/status", world.ygg_url())) {
        Ok(s) if s.contains(&sid) => {}
        Ok(s) => return (Verdict::Fail(format!("run not busy: {s}")), m),
        Err(e) => return (Verdict::Fail(e), m),
    }

    let t0 = Instant::now();
    match http.post_json(&format!("{}/session/{sid}/abort", world.ygg_url()), "{}") {
        Ok(s) if s.contains("true") => {}
        Ok(s) => return (Verdict::Fail(format!("abort returned {s}")), m),
        Err(e) => return (Verdict::Fail(format!("abort: {e}")), m),
    }
    m = m.lat("abort", t0.elapsed().as_millis() as u64);

    // busy map must clear within 3s
    let mut cleared = false;
    for _ in 0..30 {
        if let Ok(s) = http.get(&format!("{}/session/status", world.ygg_url())) {
            if !s.contains(&sid) {
                cleared = true;
                break;
            }
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    if !cleared {
        return (Verdict::Fail("session still busy 3s after abort".into()), m);
    }

    // the prompt thread gets its (partial) reply and the session must not wedge
    let _ = handle.join();
    let (_, ms2) = match prompt_wait(&world, &mut http, &sid, "post-abort turn") {
        Ok(r) => r,
        Err(e) => return (Verdict::Fail(format!("session wedged after abort: {e}")), m),
    };
    if !assistant_texts(&transcript_of(&world, &mut http, &sid).unwrap_or(Value::Null))
        .iter()
        .any(|t| t.contains("post-abort turn") || t.contains("MOCK-REPLY"))
    {
        return (Verdict::Fail("post-abort reply missing".into()), m);
    }
    m = m.lat("post-abort-turn", ms2);
    (Verdict::Pass, m)
}

fn refresh_reread() -> (Verdict, Metrics) {    let mut m = Metrics::new();
    let world = match World::spawn(WorldOpts::default()) {
        Ok(w) => w,
        Err(e) => return (Verdict::Fail(format!("world: {e}")), m),
    };
    let mut http_a = ShapedHttp::new(0xA03, &profile_phone().fwd);
    let mut http_b = ShapedHttp::new(0xA04, &profile_phone().fwd); // the "reload"

    let sid = match create_session(&world, &mut http_a, "sim refresh") {
        Ok(s) => s,
        Err(e) => return (Verdict::Fail(e), m),
    };
    let (_, ms) = match prompt_wait(&world, &mut http_a, &sid, "before the refresh") {
        Ok(r) => r,
        Err(e) => return (Verdict::Fail(e), m),
    };

    // a BRAND-NEW connection (phone killed the page, PWA re-opened) reads the
    // same transcript
    let tr_b = match transcript_of(&world, &mut http_b, &sid) {
        Ok(t) => t,
        Err(e) => return (Verdict::Fail(format!("fresh reader: {e}")), m),
    };
    let tr_a = match transcript_of(&world, &mut http_a, &sid) {
        Ok(t) => t,
        Err(e) => return (Verdict::Fail(e), m),
    };
    if assistant_texts(&tr_a) != assistant_texts(&tr_b) || tr_a.as_array().map(|a| a.len()) != tr_b.as_array().map(|a| a.len()) {
        return (Verdict::Fail("fresh reader saw a different transcript".into()), m);
    }
    let texts = assistant_texts(&tr_b);
    if texts.len() != 1 || !texts[0].contains("before the refresh") {
        return (Verdict::Fail(format!("unexpected transcript: {texts:?}")), m);
    }
    m = m.lat("turn", ms);
    (Verdict::Pass, m)
}

/// The 400K-token marathon mechanism, scaled-down deterministically: force the
/// roll-up threshold low, grow the history with big turns, and require the
/// compaction pair (compaction part + MOCK-SUMMARY) plus a correct final echo.
/// This is the proof the mechanism survives long sessions; the 400K scale on
/// the live upstream costs real tokens, so the hermetic sim proves the seam.
fn marathon_rollup() -> (Verdict, Metrics) {
    let mut m = Metrics::new();
    let world = match World::spawn(WorldOpts {
        rollup_tokens: Some(3000),
        ..Default::default()
    }) {
        Ok(w) => w,
        Err(e) => return (Verdict::Fail(format!("world: {e}")), m),
    };
    let mut http = ShapedHttp::new(0xA05, &profile_home().fwd);

    let sid = match create_session(&world, &mut http, "sim marathon") {
        Ok(s) => s,
        Err(e) => return (Verdict::Fail(e), m),
    };

    let t0 = Instant::now();
    let mut rolled = false;
    for turn in 0..5 {
        let big = format!("pad-{turn} {}", "lorem-ipsum-dolor ".repeat(280));
        let (reply, ms) = match prompt_wait(&world, &mut http, &sid, &big) {
            Ok(r) => r,
            Err(e) => return (Verdict::Fail(format!("turn {turn}: {e}")), m),
        };
        if !reply.contains(&format!("pad-{turn}")) {
            return (Verdict::Fail(format!("turn {turn}: echo lost")), m);
        }
        m = m.lat(&format!("turn-{turn}"), ms);
        let tr = match transcript_of(&world, &mut http, &sid) {
            Ok(t) => t,
            Err(e) => return (Verdict::Fail(e), m),
        };
        if tr.to_string().contains("MOCK-SUMMARY") {
            rolled = true;
            if turn >= 2 {
                break; // roll-up seen, enough turns
            }
        }
    }
    let total = t0.elapsed().as_millis() as u64;

    if !rolled {
        return (Verdict::Fail("5 big turns and no roll-up fired".into()), m);
    }
    // the compaction pair is stored opencode-style
    let tr = match transcript_of(&world, &mut http, &sid) {
        Ok(t) => t,
        Err(e) => return (Verdict::Fail(e), m),
    };
    let has_compaction = tr
        .as_array()
        .map(|a| {
            a.iter().any(|msg| {
                msg["parts"].as_array().map(|ps| {
                    ps.iter().any(|p| p["type"] == "compaction" && p["auto"] == true)
                }) == Some(true)
            })
        })
        .unwrap_or(false);
    if !has_compaction {
        return (Verdict::Fail("MOCK-SUMMARY seen but no compaction pair stored".into()), m);
    }
    let (_, summary_calls, _) = world.mock.calls();
    if summary_calls == 0 {
        return (Verdict::Fail("no summarizer call reached the upstream".into()), m);
    }

    // and the session keeps working past the roll-up
    let (_, ms) = match prompt_wait(&world, &mut http, &sid, "post-marathon sanity") {
        Ok(r) => r,
        Err(e) => return (Verdict::Fail(format!("post-rollup turn: {e}")), m),
    };
    m = m.cnt("rollups", summary_calls).lat("post-rollup-turn", ms).lat("total", total);
    (Verdict::Pass, m)
}

/// The upstream provider dies mid-life: the run fails LOUDLY (500 to the
/// caller), the busy map clears, the session is not bricked, and the next
/// prompt after recovery works.
fn upstream_down() -> (Verdict, Metrics) {
    let mut m = Metrics::new();
    let world = match World::spawn(WorldOpts::default()) {
        Ok(w) => w,
        Err(e) => return (Verdict::Fail(format!("world: {e}")), m),
    };
    let mut http = ShapedHttp::new(0xA06, &profile_home().fwd);

    let sid = match create_session(&world, &mut http, "sim upstream-down") {
        Ok(s) => s,
        Err(e) => return (Verdict::Fail(e), m),
    };

    world.mock.control(2, 0);
    let failed = match prompt_wait(&world, &mut http, &sid, "this will fail") {
        Ok((reply, _)) => {
            // a run-level failure may come back as a 200 with an error part — accept both
            !reply.contains("MOCK-REPLY")
        }
        Err(_) => true, // HTTP error — the loud path
    };
    if !failed {
        return (Verdict::Fail("upstream failure was not surfaced to the caller".into()), m);
    }
    world.mock.control(0, 0);

    // busy map must be clean
    let mut cleared = false;
    for _ in 0..30 {
        if let Ok(s) = http.get(&format!("{}/session/status", world.ygg_url())) {
            if !s.contains(&sid) {
                cleared = true;
                break;
            }
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    if !cleared {
        return (Verdict::Fail("session still busy after upstream failure".into()), m);
    }

    // recovery: same session, next turn works
    let t0 = Instant::now();
    let (reply, ms) = match prompt_wait(&world, &mut http, &sid, "recovered?") {
        Ok(r) => r,
        Err(e) => return (Verdict::Fail(format!("session bricked after upstream failure: {e}")), m),
    };
    if !reply.contains("recovered?") {
        return (Verdict::Fail(format!("recovery echo wrong: {reply}")), m);
    }
    m = m.lat("recovery-turn", ms).lat("recover-total", t0.elapsed().as_millis() as u64);
    (Verdict::Pass, m)
}
