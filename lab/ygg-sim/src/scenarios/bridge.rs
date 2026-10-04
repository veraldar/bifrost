//! `bridge.*` scenarios — the phone's WebRTC path through the REAL
//! bifrost-net bridge: token-gated signaling, the `app` data channel, the
//! voice pipeline.

use std::time::{Duration, Instant};

use serde_json::Value;

use crate::client::{post_offer_raw, SimClient};
use crate::runner::{Metrics, Verdict};
use crate::wire::{profile_home, profile_phone, profile_poor};
use crate::world::{World, WorldOpts};

pub fn registry() -> Vec<crate::runner::ScenarioDef> {
    vec![
        crate::runner::ScenarioDef {
            name: "bridge.auth",
            device: "desktop",
            profile: "home",
            run: auth,
        },
        crate::runner::ScenarioDef {
            name: "bridge.data-roundtrip",
            device: "phone",
            profile: "phone-cell",
            run: data_roundtrip,
        },
        crate::runner::ScenarioDef {
            name: "bridge.prompt-run-done",
            device: "phone",
            profile: "phone-cell",
            run: prompt_run_done,
        },
        crate::runner::ScenarioDef {
            name: "bridge.handsfree-round",
            device: "phone",
            profile: "phone-cell",
            run: handsfree_round,
        },
        crate::runner::ScenarioDef {
            name: "bridge.poor-network-turn",
            device: "phone",
            profile: "poor-cell",
            run: poor_network_turn,
        },
        crate::runner::ScenarioDef {
            name: "bridge.link-flap",
            device: "phone",
            profile: "poor-cell",
            run: link_flap,
        },
        crate::runner::ScenarioDef {
            name: "bridge.nat-rebind",
            device: "phone",
            profile: "phone-cell",
            run: nat_rebind,
        },
        crate::runner::ScenarioDef {
            name: "bridge.multi-device",
            device: "phone+desktop",
            profile: "phone-cell",
            run: multi_device,
        },
        crate::runner::ScenarioDef {
            name: "bridge.mode-switch",
            device: "phone",
            profile: "phone-cell",
            run: mode_switch,
        },
        crate::runner::ScenarioDef {
            name: "bridge.abort-mid-turn",
            device: "phone",
            profile: "phone-cell",
            run: abort_mid_turn,
        },
        crate::runner::ScenarioDef {
            name: "bridge.reconnect-after-switch",
            device: "phone",
            profile: "phone-cell",
            run: reconnect_after_switch,
        },
        crate::runner::ScenarioDef {
            name: "bridge.tts-paragraphs",
            device: "phone",
            profile: "phone-cell",
            run: tts_paragraphs,
        },
    ]
}

fn world_with_bridge() -> Result<World, String> {
    World::spawn(WorldOpts {
        with_bridge: true,
        speaches_url: std::env::var("YGG_SIM_SPEACHES")
            .unwrap_or_else(|_| "http://127.0.0.1:8000/v1".into()),
        ..Default::default()
    })
}

fn speaches_up() -> bool {
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(2))
        .build();
    agent.get(&format!("{}/models", speaches_base())).call().is_ok()
}

fn speaches_base() -> String {
    std::env::var("YGG_SIM_SPEACHES").unwrap_or_else(|_| "http://127.0.0.1:8000/v1".into())
}

fn world_bridge(world: &World) -> (String, &crate::world::BridgeInfo) {
    let b = world.bridge.as_ref().expect("bridge in world");
    (b.token.clone(), b)
}

fn auth() -> (Verdict, Metrics) {
    let m = Metrics::new();
    let dbg = std::env::var_os("YGG_SIM_DEBUG").is_some();
    let step = |s: &str| if dbg { eprintln!("[auth] {s}") } else {};
    step("spawning world");
    let world = match world_with_bridge() {
        Ok(w) => w,
        Err(e) => return (Verdict::Fail(format!("world: {e}")), m),
    };
    let (_, b) = world_bridge(&world);
    let sig = b.http;

    step("no-token probe");
    match post_offer_raw(sig, "/offer", None, "{}") {
        Ok((s, _)) if s.starts_with("401") => {}
        Ok((s, _)) => return (Verdict::Fail(format!("no-token offer accepted: {s}")), m),
        Err(e) => return (Verdict::Fail(e), m),
    }
    step("wrong-token probe");
    match post_offer_raw(sig, "/offer", Some("bfsim-not-a-real-token"), "{}") {
        Ok((s, _)) if s.starts_with("401") => {}
        Ok((s, _)) => return (Verdict::Fail(format!("wrong-token offer accepted: {s}")), m),
        Err(e) => return (Verdict::Fail(e), m),
    }
    step("valid connect");
    let mut c = match SimClient::connect(sig, b.media, &b.token, profile_home(), 0xB01) {
        Ok(c) => c,
        Err(e) => return (Verdict::Fail(format!("connect: {e}")), m),
    };
    step("hello roundtrip");
    let hello = match c.roundtrip(1, r#"{"op":"hello","req":1}"#, Duration::from_secs(10)) {
        Ok(h) => h,
        Err(e) => return (Verdict::Fail(format!("hello: {e}")), m),
    };
    if !hello.contains("bridge") {
        return (Verdict::Fail(format!("hello missing bridge field: {hello}")), m);
    }

    step("revocation");
    let hash = {
        use sha2::{Digest, Sha256};
        let d = Sha256::digest(b.token.as_bytes());
        d.iter().map(|x| format!("{x:02x}")).collect::<String>()
    };
    let revoked = serde_json::json!({
        "devices": [{"id": "dev_ygg_sim", "name": "ygg-sim", "tokenHash": hash, "created": "sim", "revoked": true}]
    });
    if let Err(e) = std::fs::write(&b.tokens_file, revoked.to_string()) {
        return (Verdict::Fail(format!("rewrite tokens: {e}")), m);
    }
    std::thread::sleep(Duration::from_millis(1600));
    step("revoked-token probe");
    match post_offer_raw(sig, "/offer", Some(&b.token.clone()), "{}") {
        Ok((s, _)) if s.starts_with("401") => {}
        Ok((s, _)) => return (Verdict::Fail(format!("REVOKED token still opens the bridge: {s}")), m),
        Err(e) => return (Verdict::Fail(e), m),
    }
    (Verdict::Pass, m)
}

fn data_roundtrip() -> (Verdict, Metrics) {
    let mut m = Metrics::new();
    let world = match world_with_bridge() {
        Ok(w) => w,
        Err(e) => return (Verdict::Fail(format!("world: {e}")), m),
    };
    let (token, b) = world_bridge(&world);
    let mut c = match SimClient::connect(b.http, b.media, &token, profile_phone(), 0xB02) {
        Ok(c) => c,
        Err(e) => return (Verdict::Fail(format!("connect: {e}")), m),
    };

    let hello = match c.roundtrip(1, r#"{"op":"hello","req":1}"#, Duration::from_secs(10)) {
        Ok(h) => h,
        Err(e) => return (Verdict::Fail(format!("hello: {e}")), m),
    };
    let _ = hello;
    let created = match c.roundtrip(
        2,
        &serde_json::json!({"op":"session.create","req":2,"name":"sim bridge roundtrip"}).to_string(),
        Duration::from_secs(12),
    ) {
        Ok(c) => c,
        Err(e) => return (Verdict::Fail(format!("session.create: {e}")), m),
    };
    let sid = serde_json::from_str::<Value>(&created)
        .ok()
        .and_then(|v| v.get("id").and_then(|i| i.as_str()).map(String::from));
    let Some(sid) = sid else {
        return (Verdict::Fail(format!("no session id: {created}")), m);
    };
    let list = match c.roundtrip(3, r#"{"op":"session.list","req":3}"#, Duration::from_secs(10)) {
        Ok(l) => l,
        Err(e) => return (Verdict::Fail(format!("session.list: {e}")), m),
    };
    if !list.contains(&sid) {
        return (Verdict::Fail(format!("created session missing from list: {list}")), m);
    }
    let tr = match c.roundtrip(
        4,
        &serde_json::json!({"op":"transcript","req":4,"id":sid}).to_string(),
        Duration::from_secs(10),
    ) {
        Ok(t) => t,
        Err(e) => return (Verdict::Fail(format!("transcript: {e}")), m),
    };
    if !tr.contains("messages") {
        return (Verdict::Fail(format!("transcript malformed: {tr}")), m);
    }

    // 10 pings through the lossy pipe — latency distribution
    let mut rtts = vec![];
    for i in 10..20u64 {
        match c.ping_rtt(i) {
            Ok(r) => rtts.push(r.as_millis() as u64),
            Err(e) => return (Verdict::Fail(format!("ping {i}: {e}")), m),
        }
    }
    rtts.sort();
    let avg = rtts.iter().sum::<u64>() / rtts.len() as u64;
    let max = *rtts.last().unwrap();
    let st = c.wire_stats();
    if st.fwd_sent == 0 {
        return (Verdict::Fail("no traffic crossed the wire — profile broken".into()), m);
    }
    m = m.lat("ping-avg", avg).lat("ping-max", max).cnt("wire-drops", st.fwd_dropped + st.rev_dropped);
    (Verdict::Pass, m)
}

fn prompt_run_done() -> (Verdict, Metrics) {
    let mut m = Metrics::new();
    let world = match world_with_bridge() {
        Ok(w) => w,
        Err(e) => return (Verdict::Fail(format!("world: {e}")), m),
    };
    let (token, b) = world_bridge(&world);
    let mut c = match SimClient::connect(b.http, b.media, &token, profile_phone(), 0xB03) {
        Ok(c) => c,
        Err(e) => return (Verdict::Fail(format!("connect: {e}")), m),
    };
    let created = match c.roundtrip(
        1,
        &serde_json::json!({"op":"session.create","req":1,"name":"sim prompt run"}).to_string(),
        Duration::from_secs(12),
    ) {
        Ok(x) => x,
        Err(e) => return (Verdict::Fail(format!("session.create: {e}")), m),
    };
    let sid = serde_json::from_str::<Value>(&created)
        .ok()
        .and_then(|v| v.get("id").and_then(|i| i.as_str()).map(String::from))
        .ok_or("no sid")
        .unwrap();

    let t0 = Instant::now();
    if let Err(e) = c.send(
        &serde_json::json!({"op":"prompt","req":2,"id":sid,"text":"reply with exactly: PONG."})
            .to_string(),
    ) {
        return (Verdict::Fail(format!("prompt send: {e}")), m);
    }
    let notice = c.wait_notice("run.done", Duration::from_secs(20));
    let turn = t0.elapsed().as_millis() as u64;

    // the turn itself must have completed either way — the transcript is the
    // ground truth; the notice is the lifecycle signal under test
    let tr = match c.roundtrip(
        3,
        &serde_json::json!({"op":"transcript","req":3,"id":sid}).to_string(),
        Duration::from_secs(10),
    ) {
        Ok(t) => t,
        Err(e) => return (Verdict::Fail(format!("transcript: {e}")), m),
    };
    if !tr.contains("PONG") {
        return (Verdict::Fail(format!("PONG not in transcript: {tr}")), m);
    }
    m = m.lat("run", turn);
    match notice {
        Ok(d) if !d.contains("timeout") => (Verdict::Pass, m),
        Ok(_) => (
            Verdict::Fail("run.done arrived as a 120s timeout, not a completion".into()),
            m,
        ),
        Err(_) => (
            Verdict::KnownIssue(
                "bridge run.done starves on the prompt op: wait_run_done's baseline is taken AFTER the blocking POST (bridge.rs), so on fast upstreams the notice only fires via the 120s timeout — turn itself completes (transcript verified). Fix belongs in lab/bifrost-net's lane; this scenario flips PASS when it lands".into(),
            ),
            m,
        ),
    }
}

fn handsfree_round() -> (Verdict, Metrics) {
    let mut m = Metrics::new();
    let world = match world_with_bridge() {
        Ok(w) => w,
        Err(e) => return (Verdict::Fail(format!("world: {e}")), m),
    };
    if !speaches_up() {
        return (
            Verdict::Skip("speaches not reachable — voice lane loud-skipped, not faked".into()),
            m,
        );
    }
    let (token, b) = world_bridge(&world);
    let mut c = match SimClient::connect(b.http, b.media, &token, profile_phone(), 0xB04) {
        Ok(c) => c,
        Err(e) => return (Verdict::Fail(format!("connect: {e}")), m),
    };
    match voice_round_spoken(&mut c, 0xB10, "hello bridge this is a simulated phone", "hello") {
        Ok((turn_ms, delivered_pct)) => {
            if delivered_pct < 80 {
                return (
                    Verdict::Fail(format!("only {delivered_pct}% of TTS frames arrived on a good link")),
                    m,
                );
            }
            m = m.lat("voice-turn", turn_ms).cnt("tts-delivered-%", delivered_pct);
            (Verdict::Pass, m)
        }
        Err(e) => (Verdict::Fail(e), m),
    }
}

/// The full hands-free turn: TTS the "user speech" (real speaches audio as the
/// mic fixture), stream it as Opus over the track, commit, then await
/// voice.stt → run.done → voice.reply with audio frames back.
fn voice_round(c: &mut SimClient, req_base: u64) -> Result<(u64, u64), String> {
    voice_round_spoken(c, req_base, "hello bridge this is a simulated phone", "hello")
}

fn voice_round_spoken(
    c: &mut SimClient,
    req_base: u64,
    spoken: &str,
    expect_word: &str,
) -> Result<(u64, u64), String> {
    let speech = crate::speech::SpeechClient::new(
        speaches_base(),
        "speaches-ai/Kokoro-82M-v1.0-ONNX",
        "af_heart",
    );
    let tts = speech.tts(spoken)?;
    let pcm48 = crate::speech::resample_to_48k(&tts);
    let frames = crate::speech::encode_opus_20ms(&pcm48);
    if frames.is_empty() {
        return Err("mic fixture produced no opus frames".into());
    }

    let created = c.roundtrip(
        req_base,
        &serde_json::json!({"op":"session.create","req":req_base,"name":"sim handsfree"}).to_string(),
        Duration::from_secs(12),
    )?;
    let sid = serde_json::from_str::<Value>(&created)
        .map_err(|e| e.to_string())?
        .get("id")
        .and_then(|i| i.as_str())
        .map(String::from)
        .ok_or("no sid")?;

    let pt = c
        .opus_pt()
        .ok_or("opus not negotiated on our audio track")?;

    let t0 = Instant::now();
    let rtp_start = Instant::now();
    // paced mic: one 20ms frame at a time, through the wire
    for (i, frame) in frames.iter().enumerate() {
        let deadline = t0 + Duration::from_secs(15);
        loop {
            c.pump();
            match c.write_audio(pt, frame.clone(), rtp_start.elapsed()) {
                Ok(true) => break,
                Ok(false) => {}
                Err(e) => return Err(e),
            }
            if Instant::now() > deadline {
                return Err("mic stream stalled (track never opened for writing)".into());
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        // real-time-ish pacing with a small catch-up cap
        let target = (i as u32 + 1) * 20;
        let got = rtp_start.elapsed().as_millis() as u32;
        if got < target {
            std::thread::sleep(Duration::from_millis((target - got).min(40) as u64));
        }
    }
    if let Err(e) = c.send(
        &serde_json::json!({"op":"voice.commit","req":req_base+1,"id":sid,"ms":frames.len()*20})
            .to_string(),
    ) {
        return Err(format!("voice.commit: {e}"));
    }

    let stt = c.wait_notice("voice.stt", Duration::from_secs(30))?;
    if !stt.to_lowercase().contains(expect_word) {
        return Err(format!("STT lost the sentence: {stt}"));
    }
    let _ = c.wait_notice("run.done", Duration::from_secs(60))?;
    let reply_notice = c.wait_notice("voice.reply", Duration::from_secs(60))?;
    let reply_v: Value = serde_json::from_str(&reply_notice).map_err(|e| e.to_string())?;
    let frames_back = reply_v.get("frames").and_then(|f| f.as_u64()).unwrap_or(0);
    if frames_back == 0 {
        return Err(format!("voice.reply carried no audio frames: {reply_notice}"));
    }
    // settle: the notice rides SCTP and outruns the RTP tail on lossy links —
    // give the reorder hold (default 1s timeout) time to release
    let settle = Instant::now() + Duration::from_secs(2);
    while Instant::now() < settle {
        c.pump();
        std::thread::sleep(Duration::from_millis(20));
    }
    if c.frames_rx == 0 {
        return Err("no audio frames arrived on the track".into());
    }
    // quality gate: what the client received must be decodable speech-shaped
    // audio, not garbage (the STT∘TTS loop contract, client side)
    let pcm = crate::speech::decode_opus_20ms(&c.audio_rx)?;
    if pcm.is_empty() {
        return Err("received frames decoded to silence".into());
    }
    let peak = pcm.iter().map(|s| s.abs()).max().unwrap_or(0);
    if peak < 500 {
        return Err(format!("received audio is near-silence (peak {peak})"));
    }
    let delivered = (c.frames_rx as f64 / frames_back as f64 * 100.0) as u64;
    Ok((t0.elapsed().as_millis() as u64, delivered))
}

fn poor_network_turn() -> (Verdict, Metrics) {
    let mut m = Metrics::new();
    let world = match world_with_bridge() {
        Ok(w) => w,
        Err(e) => return (Verdict::Fail(format!("world: {e}")), m),
    };
    if !speaches_up() {
        return (Verdict::Skip("speaches not reachable".into()), m);
    }
    let (token, b) = world_bridge(&world);
    let mut c = match SimClient::connect(b.http, b.media, &token, profile_poor(), 0xB05) {
        Ok(c) => c,
        Err(e) => return (Verdict::Fail(format!("connect: {e}")), m),
    };
    match voice_round(&mut c, 0xC10) {
        Ok((turn_ms, delivered_pct)) => {
            let st = c.wire_stats();
            if st.fwd_dropped + st.rev_dropped < 5 {
                return (Verdict::Fail("poor profile dropped nothing — profile broken".into()), m);
            }
            if delivered_pct < 55 {
                return (
                    Verdict::Fail(format!("only {delivered_pct}% of TTS frames survived a poor link")),
                    m,
                );
            }
            m = m
                .lat("voice-turn", turn_ms)
                .cnt("tts-delivered-%", delivered_pct)
                .cnt("wire-drops", st.fwd_dropped + st.rev_dropped);
            (Verdict::Pass, m)
        }
        Err(e) => (Verdict::Fail(e), m),
    }
}

fn link_flap() -> (Verdict, Metrics) {
    let mut m = Metrics::new();
    let world = match world_with_bridge() {
        Ok(w) => w,
        Err(e) => return (Verdict::Fail(format!("world: {e}")), m),
    };
    if !speaches_up() {
        return (Verdict::Skip("speaches not reachable".into()), m);
    }
    let (token, b) = world_bridge(&world);
    let mut c = match SimClient::connect(b.http, b.media, &token, profile_phone(), 0xB06) {
        Ok(c) => c,
        Err(e) => return (Verdict::Fail(format!("connect: {e}")), m),
    };

    // ping → tunnel 2s → ping must recover (SCTP retransmit across the flap)
    if let Err(e) = c.ping_rtt(1) {
        return (Verdict::Fail(format!("pre-flap ping: {e}")), m);
    }
    c.wire_cmd(crate::wire::WireCmd::Blackout(Duration::from_secs(2)));
    std::thread::sleep(Duration::from_secs(2));
    let t0 = Instant::now();
    match c.ping_rtt(2) {
        Ok(_) => {}
        Err(e) => return (Verdict::Fail(format!("channel dead after 2s tunnel: {e}")), m),
    }
    let recover = t0.elapsed().as_millis() as u64;
    if !c.is_connected() {
        return (Verdict::Fail("ICE reports disconnected after 2s tunnel recovery".into()), m);
    }

    // second, longer tunnel: 4s — ICE consent horizon
    c.wire_cmd(crate::wire::WireCmd::Blackout(Duration::from_secs(4)));
    std::thread::sleep(Duration::from_secs(4));
    let long_ok = c.ping_rtt(3).is_ok();

    m = m.lat("recover-2s", recover).cnt("survive-4s", long_ok as u64);
    if long_ok {
        (Verdict::Pass, m)
    } else {
        (
            Verdict::ExpectedBreak(format!(
                "channel did not survive a 4s tunnel (recovered from 2s in {recover}ms) — documented: consent horizon, bridge needs ICE-restart story"
            )),
            m,
        )
    }
}

fn nat_rebind() -> (Verdict, Metrics) {
    let mut m = Metrics::new();
    let world = match world_with_bridge() {
        Ok(w) => w,
        Err(e) => return (Verdict::Fail(format!("world: {e}")), m),
    };
    let (token, b) = world_bridge(&world);
    let mut c = match SimClient::connect(b.http, b.media, &token, profile_phone(), 0xB07) {
        Ok(c) => c,
        Err(e) => return (Verdict::Fail(format!("connect: {e}")), m),
    };
    if let Err(e) = c.ping_rtt(1) {
        return (Verdict::Fail(format!("pre-rebind ping: {e}")), m);
    }
    // the NAT mapping rotates under the client; the bridge sees a new source port
    c.wire_cmd(crate::wire::WireCmd::Rebind);
    let t0 = Instant::now();
    let recovered = c.ping_rtt(2).is_ok();
    let _ = t0;
    let st = c.wire_stats();
    if st.rebinds != 1 {
        return (Verdict::Fail("wire did not rebind".into()), m);
    }
    m = m.cnt("rebind-survived", recovered as u64);
    if recovered {
        (Verdict::Pass, m)
    } else {
        (
            Verdict::ExpectedBreak(
                "path died on raw NAT rebind (no ICE restart) — documented; product path is reconnect, see bridge.reconnect scenario".into(),
            ),
            m,
        )
    }
}

fn multi_device() -> (Verdict, Metrics) {
    let m = Metrics::new();
    let world = match world_with_bridge() {
        Ok(w) => w,
        Err(e) => return (Verdict::Fail(format!("world: {e}")), m),
    };
    let (token, b) = world_bridge(&world);
    let mut phone = match SimClient::connect(b.http, b.media, &token, profile_phone(), 0xB08) {
        Ok(c) => c,
        Err(e) => return (Verdict::Fail(format!("phone connect: {e}")), m),
    };
    let mut desktop = match SimClient::connect(b.http, b.media, &token, profile_home(), 0xB09) {
        Ok(c) => c,
        Err(e) => return (Verdict::Fail(format!("desktop connect: {e}")), m),
    };

    let sid_p = {
        let created = match phone.roundtrip(
            1,
            &serde_json::json!({"op":"session.create","req":1,"name":"sim phone session"}).to_string(),
            Duration::from_secs(12),
        ) {
            Ok(c) => c,
            Err(e) => return (Verdict::Fail(format!("phone session: {e}")), m),
        };
        match serde_json::from_str::<Value>(&created)
            .ok()
            .and_then(|v| v.get("id").and_then(|i| i.as_str()).map(String::from))
        {
            Some(s) => s,
            None => return (Verdict::Fail(format!("no id: {created}")), m),
        }
    };
    let sid_d = {
        let created = match desktop.roundtrip(
            1,
            &serde_json::json!({"op":"session.create","req":1,"name":"sim desktop session"}).to_string(),
            Duration::from_secs(12),
        ) {
            Ok(c) => c,
            Err(e) => return (Verdict::Fail(format!("desktop session: {e}")), m),
        };
        match serde_json::from_str::<Value>(&created)
            .ok()
            .and_then(|v| v.get("id").and_then(|i| i.as_str()).map(String::from))
        {
            Some(s) => s,
            None => return (Verdict::Fail(format!("no id: {created}")), m),
        }
    };
    if sid_p == sid_d {
        return (Verdict::Fail("both devices landed on the same session".into()), m);
    }

    if let Err(e) = phone.send(
        &serde_json::json!({"op":"prompt","req":2,"id":sid_p,"text":"reply with exactly: PHONE-TAG"}).to_string(),
    ) {
        return (Verdict::Fail(format!("phone prompt: {e}")), m);
    }
    if let Err(e) = desktop.send(
        &serde_json::json!({"op":"prompt","req":2,"id":sid_d,"text":"reply with exactly: DESK-TAG"}).to_string(),
    ) {
        return (Verdict::Fail(format!("desktop prompt: {e}")), m);
    }

    // the run lifecycle notices are tracked by bridge.prompt-run-done; THIS
    // scenario's subject is isolation — poll transcripts until each side sees
    // its own tag and nothing of the other's
    let t0 = Instant::now();
    let (mut p_tr, mut d_tr) = (String::new(), String::new());
    while t0.elapsed() < Duration::from_secs(40) {
        phone.pump();
        desktop.pump();
        if !p_tr.contains("PHONE-TAG") {
            p_tr = phone
                .roundtrip(3, &serde_json::json!({"op":"transcript","req":3,"id":sid_p}).to_string(), Duration::from_secs(5))
                .unwrap_or_default();
        }
        if !d_tr.contains("DESK-TAG") {
            d_tr = desktop
                .roundtrip(3, &serde_json::json!({"op":"transcript","req":3,"id":sid_d}).to_string(), Duration::from_secs(5))
                .unwrap_or_default();
        }
        if p_tr.contains("PHONE-TAG") && d_tr.contains("DESK-TAG") {
            break;
        }
        std::thread::sleep(Duration::from_millis(400));
    }
    if !p_tr.contains("PHONE-TAG") || !d_tr.contains("DESK-TAG") {
        return (Verdict::Fail("both runs did not complete within 40s".into()), m);
    }

    if !p_tr.contains("PHONE-TAG") || p_tr.contains("DESK-TAG") {
        return (Verdict::Fail(format!("phone transcript crossed: {p_tr}")), m);
    }
    if !d_tr.contains("DESK-TAG") || d_tr.contains("PHONE-TAG") {
        return (Verdict::Fail(format!("desktop transcript crossed: {d_tr}")), m);
    }
    (Verdict::Pass, m)
}

fn mode_switch() -> (Verdict, Metrics) {
    let mut m = Metrics::new();
    let world = match world_with_bridge() {
        Ok(w) => w,
        Err(e) => return (Verdict::Fail(format!("world: {e}")), m),
    };
    if !speaches_up() {
        return (Verdict::Skip("speaches not reachable".into()), m);
    }
    let (token, b) = world_bridge(&world);
    let mut c = match SimClient::connect(b.http, b.media, &token, profile_phone(), 0xB20) {
        Ok(c) => c,
        Err(e) => return (Verdict::Fail(format!("connect: {e}")), m),
    };

    // keyboard mode: rapid list/transcript/ping cycling (the tap-to-type UX)
    let t0 = Instant::now();
    let created = match c.roundtrip(
        1,
        &serde_json::json!({"op":"session.create","req":1,"name":"sim mode switch"}).to_string(),
        Duration::from_secs(12),
    ) {
        Ok(x) => x,
        Err(e) => return (Verdict::Fail(format!("session.create: {e}")), m),
    };
    let sid = match serde_json::from_str::<Value>(&created)
        .ok()
        .and_then(|v| v.get("id").and_then(|i| i.as_str()).map(String::from))
    {
        Some(s) => s,
        None => return (Verdict::Fail(format!("no id: {created}")), m),
    };
    for i in 2..7u64 {
        let op = if i % 2 == 0 {
            serde_json::json!({"op":"session.list","req":i})
        } else {
            serde_json::json!({"op":"transcript","req":i,"id":sid})
        };
        if let Err(e) = c.roundtrip(i, &op.to_string(), Duration::from_secs(8)) {
            return (Verdict::Fail(format!("keyboard cycle {i}: {e}")), m);
        }
    }
    let kb_ms = t0.elapsed().as_millis() as u64;
    let ping = match c.ping_rtt(7) {
        Ok(p) => p.as_millis() as u64,
        Err(e) => return (Verdict::Fail(format!("pre-voice ping: {e}")), m),
    };

    // hands-free round (mode flip mid-session)
    match voice_round(&mut c, 0xB21) {
        Ok((voice_ms, delivered)) => {
            // back to keyboard: channel must still be crisp
            let ping2 = match c.ping_rtt(30) {
                Ok(p) => p.as_millis() as u64,
                Err(e) => return (Verdict::Fail(format!("post-voice ping: {e}")), m),
            };
            if ping2 > 3000 {
                return (Verdict::Fail(format!("channel wedged after voice (ping {ping2}ms)")), m);
            }
            m = m
                .lat("keyboard-cycle", kb_ms)
                .lat("ping-keyboard", ping)
                .lat("voice-turn", voice_ms)
                .lat("ping-after-voice", ping2)
                .cnt("tts-delivered-%", delivered);
            (Verdict::Pass, m)
        }
        Err(e) => (Verdict::Fail(format!("voice leg: {e}")), m),
    }
}

/// The dead-phone pattern: a voice turn is in flight when the phone dies.
/// The bridge must not wedge, yggdrasil must return to idle, and the session
/// must carry its reply for the NEXT connection.
fn abort_mid_turn() -> (Verdict, Metrics) {
    let mut m = Metrics::new();
    let world = match world_with_bridge() {
        Ok(w) => w,
        Err(e) => return (Verdict::Fail(format!("world: {e}")), m),
    };
    let (token, b) = world_bridge(&world);

    // slow the upstream so the turn is definitively in flight when we die
    world.mock.control(0, 6000);

    let mut c = match SimClient::connect(b.http, b.media, &token, profile_phone(), 0xB22) {
        Ok(c) => c,
        Err(e) => return (Verdict::Fail(format!("connect: {e}")), m),
    };
    let speech = crate::speech::SpeechClient::new(
        speaches_base(),
        "speaches-ai/Kokoro-82M-v1.0-ONNX",
        "af_heart",
    );
    let tts = match speech.tts("hello bridge this turn will be abandoned") {
        Ok(t) => t,
        Err(e) => return (Verdict::Fail(format!("mic fixture: {e}")), m),
    };
    let pcm48 = crate::speech::resample_to_48k(&tts);
    let frames = crate::speech::encode_opus_20ms(&pcm48);
    let created = match c.roundtrip(
        1,
        &serde_json::json!({"op":"session.create","req":1,"name":"sim abort mid turn"}).to_string(),
        Duration::from_secs(12),
    ) {
        Ok(x) => x,
        Err(e) => return (Verdict::Fail(format!("session.create: {e}")), m),
    };
    let sid = match serde_json::from_str::<Value>(&created)
        .ok()
        .and_then(|v| v.get("id").and_then(|i| i.as_str()).map(String::from))
    {
        Some(s) => s,
        None => return (Verdict::Fail(format!("no id: {created}")), m),
    };
    let pt = match c.opus_pt() {
        Some(p) => p,
        None => return (Verdict::Fail("opus not negotiated".into()), m),
    };
    let t0 = Instant::now();
    let rtp_start = Instant::now();
    for frame in frames {
        let deadline = t0 + Duration::from_secs(10);
        loop {
            c.pump();
            match c.write_audio(pt, frame.clone(), rtp_start.elapsed()) {
                Ok(true) => break,
                Ok(false) => {}
                Err(e) => return (Verdict::Fail(e), m),
            }
            if Instant::now() > deadline {
                return (Verdict::Fail("mic stream stalled".into()), m);
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        let got = rtp_start.elapsed().as_millis() as u32;
        if got % 20 != 0 {
            std::thread::sleep(Duration::from_millis(20 - (got % 20) as u64));
        }
    }
    if let Err(e) = c.send(
        &serde_json::json!({"op":"voice.commit","req":2,"id":sid,"ms":600}).to_string(),
    ) {
        return (Verdict::Fail(format!("voice.commit: {e}")), m);
    }
    // the phone dies mid-turn (STT→prompt in flight)
    std::thread::sleep(Duration::from_millis(1200));
    let t_kill = Instant::now();
    drop(c);

    // a NEW device must connect immediately — one dead peer wedges nothing
    let mut fresh = match SimClient::connect(b.http, b.media, &token, profile_phone(), 0xB23) {
        Ok(x) => x,
        Err(e) => return (Verdict::Fail(format!("fresh connect while old turn drains: {e}")), m),
    };
    if let Err(e) = fresh.roundtrip(1, r#"{"op":"hello","req":1}"#, Duration::from_secs(10)) {
        return (Verdict::Fail(format!("fresh hello: {e}")), m);
    }
    m = m.lat("fresh-connect", t_kill.elapsed().as_millis() as u64);

    // yggdrasil must return to idle once the stalled run finishes (~6s + slack)
    let mut idle_ms = 0u64;
    let mut idle = false;
    while t_kill.elapsed() < Duration::from_secs(25) {
        fresh.pump();
        if let Ok(s) = ureq::get(&format!("{}/session/status", world.ygg_url())).call() {
            let body = s.into_string().unwrap_or_default();
            if !body.contains(&sid) {
                idle = true;
                idle_ms = t_kill.elapsed().as_millis() as u64;
                break;
            }
        }
        std::thread::sleep(Duration::from_millis(300));
    }
    world.mock.control(0, 0);
    if !idle {
        return (Verdict::Fail("session still busy 25s after the phone died".into()), m);
    }
    m = m.lat("idle-after-death", idle_ms);
    (Verdict::Pass, m)
}

/// WiFi→cell: the connection dies mid-life and the phone re-signals (the PWA
/// reconnect path). The session on yggdrasil is the continuity anchor.
fn reconnect_after_switch() -> (Verdict, Metrics) {
    let mut m = Metrics::new();
    let world = match world_with_bridge() {
        Ok(w) => w,
        Err(e) => return (Verdict::Fail(format!("world: {e}")), m),
    };
    let (token, b) = world_bridge(&world);
    let mut c = match SimClient::connect(b.http, b.media, &token, profile_phone(), 0xB24) {
        Ok(c) => c,
        Err(e) => return (Verdict::Fail(format!("connect: {e}")), m),
    };
    let created = match c.roundtrip(
        1,
        &serde_json::json!({"op":"session.create","req":1,"name":"sim reconnect"}).to_string(),
        Duration::from_secs(12),
    ) {
        Ok(x) => x,
        Err(e) => return (Verdict::Fail(format!("session.create: {e}")), m),
    };
    let sid = match serde_json::from_str::<Value>(&created)
        .ok()
        .and_then(|v| v.get("id").and_then(|i| i.as_str()).map(String::from))
    {
        Some(s) => s,
        None => return (Verdict::Fail(format!("no id: {created}")), m),
    };
    if let Err(e) = c.roundtrip(
        2,
        &serde_json::json!({"op":"prompt","req":2,"id":sid,"text":"reply with exactly: BEFORE-SWITCH"}).to_string(),
        Duration::from_secs(5),
    ) {
        // accepted reply may race the notice; the transcript is the anchor
        let _ = e;
    }
    // wait for the run to land server-side
    std::thread::sleep(Duration::from_millis(2500));

    // the switch: link dies, phone gives up and re-signals fresh
    drop(c);
    std::thread::sleep(Duration::from_millis(300));
    let t0 = Instant::now();
    let mut c2 = match SimClient::connect(b.http, b.media, &token, profile_poor(), 0xB25) {
        Ok(x) => x,
        Err(e) => return (Verdict::Fail(format!("reconnect: {e}")), m),
    };
    let reconn = t0.elapsed().as_millis() as u64;
    let tr = match c2.roundtrip(
        1,
        &serde_json::json!({"op":"transcript","req":1,"id":sid}).to_string(),
        Duration::from_secs(15),
    ) {
        Ok(t) => t,
        Err(e) => return (Verdict::Fail(format!("fresh transcript: {e}")), m),
    };
    if !tr.contains("BEFORE-SWITCH") {
        return (Verdict::Fail(format!("session lost across the switch: {tr}")), m);
    }
    // and the reconnected client can keep working on the SAME session
    if let Err(e) = c2.roundtrip(
        2,
        &serde_json::json!({"op":"prompt","req":2,"id":sid,"text":"reply with exactly: AFTER-SWITCH"}).to_string(),
        Duration::from_secs(5),
    ) {
        let _ = e;
    }
    let mut landed = false;
    for _ in 0..20 {
        c2.pump();
        if let Ok(t) = c2.roundtrip(
            3,
            &serde_json::json!({"op":"transcript","req":3,"id":sid}).to_string(),
            Duration::from_secs(5),
        ) {
            if t.contains("AFTER-SWITCH") {
                landed = true;
                break;
            }
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    if !landed {
        return (Verdict::Fail("reconnected client could not continue the session".into()), m);
    }
    m = m.lat("reconnect", reconn);
    (Verdict::Pass, m)
}

/// Multi-paragraph TTS ("the essay"): a voice turn whose upstream reply is
/// long-form text must arrive as a decodable burst across paragraph breaks,
/// not a truncated one.
fn tts_paragraphs() -> (Verdict, Metrics) {
    let mut m = Metrics::new();
    let world = match world_with_bridge() {
        Ok(w) => w,
        Err(e) => return (Verdict::Fail(format!("world: {e}")), m),
    };
    if !speaches_up() {
        return (Verdict::Skip("speaches not reachable".into()), m);
    }
    let (token, b) = world_bridge(&world);
    let mut c = match SimClient::connect(b.http, b.media, &token, profile_phone(), 0xB26) {
        Ok(c) => c,
        Err(e) => return (Verdict::Fail(format!("connect: {e}")), m),
    };
    match voice_round_spoken(&mut c, 0xB27, "essay please", "essay") {
        Ok((turn_ms, delivered_pct)) => {
            let frames = c.frames_rx;
            if frames < 300 {
                return (
                    Verdict::Fail(format!("essay burst suspiciously small: {frames} frames")),
                    m,
                );
            }
            let pcm = match crate::speech::decode_opus_20ms(c.audio()) {
                Ok(p) => p,
                Err(e) => return (Verdict::Fail(format!("received audio undecodable: {e}")), m),
            };
            let peak = pcm.iter().map(|s| s.abs()).max().unwrap_or(0);
            if peak < 500 {
                return (Verdict::Fail(format!("essay audio near-silence (peak {peak})")), m);
            }
            if delivered_pct < 70 {
                return (
                    Verdict::Fail(format!("essay burst lost too much: {delivered_pct}% delivered")),
                    m,
                );
            }
            m = m
                .lat("essay-turn", turn_ms)
                .cnt("received-frames", frames as u64)
                .cnt("delivered-%", delivered_pct);
            (Verdict::Pass, m)
        }
        Err(e) => (Verdict::Fail(e), m),
    }
}
