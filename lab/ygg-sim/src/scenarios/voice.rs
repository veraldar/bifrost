//! `voice.*` scenarios — the voice edge itself: WHERE speech-to-text runs.
//!
//! `voice.stt-inprocess` anticipates the decision "STT moves in-process"
//! (inside bifrost's voice edge — the Python agent now, the Rust bridge
//! later — not a separate speaches service). Same mic audio, two engines
//! behind the src/stt.rs seam, measured side by side: the decision's gate
//! is ready before the decision is made.

use crate::runner::{Metrics, Verdict};
use crate::stt::{InProcessStt, ServiceStt, SttEngine};

pub fn registry() -> Vec<crate::runner::ScenarioDef> {
    vec![crate::runner::ScenarioDef {
        name: "voice.stt-inprocess",
        device: "edge",
        profile: "cpu",
        run: stt_inprocess,
    }]
}

/// Phone-style utterances (short commands + one sentence) — the edge's real load.
const PHRASES: &[&str] = &[
    "hello bridge this is a simulated phone",
    "open the last session and read me the summary",
    "reply with exactly pong",
    "long story please",
    "what changed in the build since this morning",
];

/// the v0.6.2 latency gate's shape: a ~10 s request (docs/STABLE.md:
/// transcript ≤ 2 s after you stop talking on a 10 s utterance)
const LONG: &str = "this is a longer request from the phone so please open the session about the bridge read me the last three messages and then summarize what changed in the build since this morning";

/// the v0.6.2 language gate: WER ≤ today's in English AND French
const PHRASES_FR: &[&str] = &[
    "bonjour ouvre la dernière session s'il te plaît",
    "quelle est la météo à zurich demain matin",
];

fn median(v: &mut [u64]) -> u64 {
    v.sort();
    v.get(v.len() / 2).copied().unwrap_or(0)
}

fn stt_inprocess() -> (Verdict, Metrics) {
    let mut m = Metrics::new();
    let base = std::env::var("YGG_SIM_SPEACHES").unwrap_or_else(|_| "http://127.0.0.1:8000/v1".into());
    let up = ureq::AgentBuilder::new()
        .timeout(std::time::Duration::from_secs(2))
        .build()
        .get(&format!("{base}/models"))
        .call()
        .is_ok();
    if !up {
        return (Verdict::Skip("speaches not reachable — no mic fixture (TTS) and no service baseline; voice lane loud-skipped".into()), m);
    }
    let mut edge = match InProcessStt::boot() {
        Ok(e) => e,
        Err(e) => return (Verdict::Skip(format!("in-process STT edge unavailable: {e}")), m),
    };
    let speech = crate::speech::SpeechClient::new(&base, "Systran/faster-whisper-small", "speaches-ai/Kokoro-82M-v1.0-ONNX", "af_heart");
    let speech_fr = crate::speech::SpeechClient::new(&base, "Systran/faster-whisper-small", "speaches-ai/Kokoro-82M-v1.0-ONNX", "ff_siwis");
    let mut service = ServiceStt {
        client: crate::speech::SpeechClient::new(&base, "Systran/faster-whisper-small", "speaches-ai/Kokoro-82M-v1.0-ONNX", "af_heart"),
    };

    let (mut in_ms, mut sv_ms, mut in_wer, mut sv_wer, mut audio_ms) = (vec![], vec![], vec![], vec![], vec![]);
    let mut misses = vec![];
    for phrase in PHRASES {
        let r = match duel(&speech, &mut edge, &mut service, phrase) {
            Ok(r) => r,
            Err(e) => return (Verdict::Fail(e), m),
        };
        if r.text_in.is_empty() || r.wer_in > 50 {
            misses.push(format!("'{phrase}' → '{}'", r.text_in));
        }
        in_ms.push(r.ms_in);
        sv_ms.push(r.ms_sv);
        in_wer.push(r.wer_in);
        sv_wer.push(r.wer_sv);
        audio_ms.push(r.audio_ms);
    }
    let long = match duel(&speech, &mut edge, &mut service, LONG) {
        Ok(r) => r,
        Err(e) => return (Verdict::Fail(e), m),
    };
    let (mut fr_in, mut fr_sv) = (vec![], vec![]);
    let mut fr_heard = vec![];
    for phrase in PHRASES_FR {
        let r = match duel(&speech_fr, &mut edge, &mut service, phrase) {
            Ok(r) => r,
            Err(e) => return (Verdict::Fail(e), m),
        };
        fr_heard.push(format!("'{}'", r.text_in));
        fr_in.push(r.wer_in);
        fr_sv.push(r.wer_sv);
    }
    let avg = |v: &[u64]| v.iter().sum::<u64>() / v.len().max(1) as u64;
    let (wi, ws) = (avg(&in_wer), avg(&sv_wer));
    let (mi, ms) = (median(&mut in_ms.clone()), median(&mut sv_ms.clone()));
    let (fi, fs) = (avg(&fr_in), avg(&fr_sv));
    m = m
        .lat("stt-utterance", mi)
        .lat("model-load", edge.load_ms)
        .lat("service-utterance", ms)
        .lat("stt-10s-utterance", long.ms_in)
        .lat("service-10s-utterance", long.ms_sv)
        .cnt("wer-inproc-%", wi)
        .cnt("wer-service-%", ws)
        .cnt("wer-10s-inproc-%", long.wer_in)
        .cnt("wer-fr-inproc-%", fi)
        .cnt("wer-fr-service-%", fs)
        .cnt("edge-rss-mb", edge.rss_mb)
        .cnt("audio-ms-median", median(&mut audio_ms))
        .cnt("audio-ms-long", long.audio_ms);
    if !misses.is_empty() || wi > ws + 10 {
        return (
            Verdict::KnownIssue(format!(
                "in-process candidate ({}) does not yet match the service on phone audio: WER {wi}% vs {ws}% — misses: {}",
                edge.name(),
                misses.join("; ")
            )),
            m,
        );
    }
    if fi > fs + 10 {
        return (
            Verdict::KnownIssue(format!(
                "v0.6.2 gate half-met: English parity (WER {wi}% vs service {ws}%, {mi}ms vs {ms}ms per utterance, 10s utterance {}ms), but FRENCH misses parity in-process: WER {fi}% vs service {fs}% (heard {}) with {} — the gate needs an in-process model that matches on French (swap via YGG_SIM_STT_MODEL / _QUANT; the scenario stays)",
                long.ms_in,
                fr_heard.join(", "),
                edge.model
            )),
            m,
        );
    }
    (Verdict::Pass, m)
}

struct Duel {
    text_in: String,
    ms_in: u64,
    ms_sv: u64,
    wer_in: u64,
    wer_sv: u64,
    audio_ms: u64,
}

/// One utterance through both engines — the mic as the edge receives it:
/// TTS → 48k → Opus 20ms frames → decoded (what the bridge/agent hands STT).
fn duel(
    speech: &crate::speech::SpeechClient,
    edge: &mut InProcessStt,
    service: &mut ServiceStt,
    phrase: &str,
) -> Result<Duel, String> {
    let tts = speech.tts(phrase).map_err(|e| format!("mic fixture TTS: {e}"))?;
    let frames = crate::speech::encode_opus_20ms(&crate::speech::resample_to_48k(&tts));
    let pcm48 = crate::speech::decode_opus_20ms(&frames).map_err(|e| format!("opus round trip: {e}"))?;
    let audio_ms = pcm48.len() as u64 / 48;
    let pcm = crate::speech::Pcm { samples: pcm48, rate: 48000 };
    let (t_in, ms_in) = edge.transcribe(&pcm).map_err(|e| format!("in-process STT: {e}"))?;
    let (t_sv, ms_sv) = service.transcribe(&pcm).map_err(|e| format!("service STT: {e}"))?;
    let (w_in, w_sv) = (crate::stt::wer(phrase, &t_in), crate::stt::wer(phrase, &t_sv));
    if std::env::var_os("YGG_SIM_DEBUG").is_some() {
        eprintln!("[stt] '{phrase}' ({audio_ms}ms audio) | in-proc {ms_in}ms '{t_in}' ({w_in}%) | service {ms_sv}ms '{t_sv}' ({w_sv}%)");
    }
    Ok(Duel { text_in: t_in, ms_in, ms_sv, wer_in: w_in, wer_sv: w_sv, audio_ms })
}
