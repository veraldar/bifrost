//! Speaches STT/TTS client — the OpenAI-shaped speech API the agent worker
//! already uses (SPEACHES_URL). Local docker on :8000; Mac Studio via LAN.
//! STT:  POST /v1/audio/transcriptions (multipart: file=wav, model)
//! TTS:  POST /v1/audio/speech (json: model, input, voice, response_format=wav)

use std::io::Write as _;
use std::time::Duration;

use ureq::{Agent, AgentBuilder};

#[derive(Clone)]
pub struct SpeechClient {
    base: String,
    http: Agent,
    pub stt_model: String,
    pub tts_model: String,
    pub tts_voice: String,
}

/// Raw PCM16 mono samples + sample rate (decoded from a WAV body).
pub struct Pcm {
    pub samples: Vec<i16>,
    pub rate: u32,
}

pub fn encode_wav_mono16(pcm: &[i16], rate: u32) -> Vec<u8> {
    let data_len = pcm.len() * 2;
    let mut w = Vec::with_capacity(44 + data_len);
    w.extend(b"RIFF");
    w.extend(&((36 + data_len) as u32).to_le_bytes());
    w.extend(b"WAVE");
    w.extend(b"fmt ");
    w.extend(&16u32.to_le_bytes());
    w.extend(&1u16.to_le_bytes()); // PCM
    w.extend(&1u16.to_le_bytes()); // mono
    w.extend(&rate.to_le_bytes());
    w.extend(&(rate * 2).to_le_bytes()); // byte rate
    w.extend(&2u16.to_le_bytes()); // block align
    w.extend(&16u16.to_le_bytes()); // bits
    w.extend(b"data");
    w.extend(&(data_len as u32).to_le_bytes());
    for s in pcm {
        w.extend(&s.to_le_bytes());
    }
    w
}

pub fn decode_wav_mono16(bytes: &[u8]) -> Result<Pcm, String> {
    if bytes.len() < 44 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err("not a WAV file".into());
    }
    let mut off = 12usize;
    let mut rate = 48000u32;
    let mut channels = 1u16;
    let mut bits = 16u16;
    let mut data: Option<&[u8]> = None;
    while off + 8 <= bytes.len() {
        let id = &bytes[off..off + 4];
        let len = u32::from_le_bytes(bytes[off + 4..off + 8].try_into().unwrap()) as usize;
        let body = &bytes[off + 8..(off + 8 + len).min(bytes.len())];
        match id {
            b"fmt " => {
                if body.len() >= 16 {
                    channels = u16::from_le_bytes(body[2..4].try_into().unwrap());
                    rate = u32::from_le_bytes(body[4..8].try_into().unwrap());
                    bits = u16::from_le_bytes(body[14..16].try_into().unwrap());
                }
            }
            b"data" => data = Some(body),
            _ => {}
        }
        off += 8 + len + (len & 1);
    }
    let data = data.ok_or("WAV without data chunk")?;
    if bits != 16 {
        return Err(format!("only pcm16 supported, got {bits} bits"));
    }
    let mut samples: Vec<i16> = data
        .chunks_exact(2)
        .map(|c| i16::from_le_bytes([c[0], c[1]]))
        .collect();
    if channels > 1 {
        samples = samples
            .chunks(channels as usize)
            .map(|ch| {
                let sum: i32 = ch.iter().map(|s| *s as i32).sum();
                (sum / ch.len() as i32) as i16
            })
            .collect();
    }
    Ok(Pcm { samples, rate })
}

impl SpeechClient {
    pub fn new(base: impl Into<String>, stt_model: &str, tts_model: &str, tts_voice: &str) -> Self {
        let http = AgentBuilder::new()
            .timeout(Duration::from_secs(120))
            .build();
        SpeechClient {
            base: base.into().trim_end_matches('/').to_string(),
            http,
            stt_model: stt_model.to_string(),
            tts_model: tts_model.to_string(),
            tts_voice: tts_voice.to_string(),
        }
    }

    /// PCM16 mono in → transcript text out.
    pub fn transcribe(&self, pcm: &Pcm) -> Result<String, String> {
        let wav = encode_wav_mono16(&pcm.samples, pcm.rate);
        let boundary = "bfn0tls";
        let mut body: Vec<u8> = vec![];
        let part = |name: &str, value: &str| {
            format!(
                "--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n"
            )
        };
        body.extend(part("model", &self.stt_model).as_bytes());
        body.extend(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"audio.wav\"\r\nContent-Type: audio/wav\r\n\r\n").as_bytes());
        body.extend(&wav);
        body.extend(format!("\r\n--{boundary}--\r\n").as_bytes());

        let r = self
            .http
            .post(&format!("{}/audio/transcriptions", self.base))
            .set("Content-Type", &format!("multipart/form-data; boundary={boundary}"))
            .send(&body[..])
            .map_err(|e| format!("speaches STT: {e}"))?;
        let v: serde_json::Value = r
            .into_json()
            .map_err(|e| format!("speaches STT body: {e}"))?;
        Ok(v.get("text")
            .and_then(|t| t.as_str())
            .unwrap_or_default()
            .trim()
            .to_string())
    }

    /// Text → PCM16 mono (whatever rate the TTS model returns).
    pub fn tts(&self, text: &str) -> Result<Pcm, String> {
        let body = serde_json::json!({
            "model": self.tts_model,
            "input": text,
            "voice": self.tts_voice,
            "response_format": "wav",
        });
        let r = self
            .http
            .post(&format!("{}/audio/speech", self.base))
            .send_json(body)
            .map_err(|e| format!("speaches TTS: {e}"))?;
        let bytes = {
            use std::io::Read as _;
            let mut v = vec![];
            r.into_reader()
                .read_to_end(&mut v)
                .map_err(|e| format!("speaches TTS body: {e}"))?;
            v
        };
        decode_wav_mono16(&bytes)
    }
}

/// Linear resample to 48k mono (v0.9: honest cheap resample — the phone
/// output is 48k Opus; Kokoro returns 24k).
pub fn resample_to_48k(pcm: &Pcm) -> Vec<i16> {
    if pcm.rate == 48000 {
        return pcm.samples.clone();
    }
    let from = pcm.rate as f64;
    let to = 48000f64;
    let ratio = to / from;
    let out_len = ((pcm.samples.len() as f64) * ratio) as usize;
    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let pos = i as f64 / ratio;
        let i0 = pos as usize;
        let i1 = (i0 + 1).min(pcm.samples.len() - 1);
        let frac = pos - i0 as f64;
        let s = (1.0 - frac) * pcm.samples[i0] as f64 + frac * pcm.samples[i1] as f64;
        out.push(s.clamp(i16::MIN as f64, i16::MAX as f64) as i16);
    }
    out
}
