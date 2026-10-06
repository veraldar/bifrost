//! The STT seam (sim v5) — where speech-to-text lives in bifrost's voice edge.
//!
//! Anticipates the decision "STT moves IN-PROCESS": today the edge (Python
//! agent; the Rust bridge's voice_pipeline) calls speaches over HTTP — a
//! separate service. The seam is the one call both edges make:
//!
//!   transcribe(mono PCM16 @ rate) → text
//!
//! - `ServiceStt`   — today: speaches /audio/transcriptions (whisper-small CPU)
//! - `InProcessStt` — the candidate: the model resident INSIDE the edge
//!   process (`voice/stt_edge.py`: onnx-asr + Parakeet Redux ONNX, what the
//!   Python agent would import). The Rust bridge's version is sherpa-onnx
//!   in-process behind the same trait — swap the impl, keep the scenario.

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::time::Instant;

use base64::Engine as _;

use crate::speech::Pcm;

pub trait SttEngine {
    fn name(&self) -> String;
    /// (text, engine-side milliseconds)
    fn transcribe(&mut self, pcm: &Pcm) -> Result<(String, u64), String>;
}

pub struct ServiceStt {
    pub client: crate::speech::SpeechClient,
}

impl SttEngine for ServiceStt {
    fn name(&self) -> String {
        "speaches (separate service, HTTP)".into()
    }
    fn transcribe(&mut self, pcm: &Pcm) -> Result<(String, u64), String> {
        let t0 = Instant::now();
        let text = self.client.transcribe(pcm)?;
        Ok((text, t0.elapsed().as_millis() as u64))
    }
}

pub struct InProcessStt {
    child: Child,
    stdin: Option<ChildStdin>,
    stdout: BufReader<ChildStdout>,
    pub model: String,
    pub load_ms: u64,
    pub rss_mb: u64,
    next: u64,
}

/// Python with onnx-asr: YGG_SIM_STT_PY, else the voice-lab venv (lab6 duel).
pub fn edge_python() -> Option<std::path::PathBuf> {
    if let Some(p) = std::env::var_os("YGG_SIM_STT_PY") {
        let p = std::path::PathBuf::from(p);
        return p.exists().then_some(p);
    }
    let home = std::path::PathBuf::from(std::env::var_os("HOME")?);
    let venv = home.join("Work/voice-lab/.venv/bin/python");
    venv.exists().then_some(venv)
}

impl InProcessStt {
    /// Boot the edge (model load + warm-up happen here, like an agent boot).
    pub fn boot() -> Result<InProcessStt, String> {
        let py = edge_python().ok_or("no python with onnx-asr (set YGG_SIM_STT_PY, or `uv sync` ~/Work/voice-lab — onnx-asr[cpu,hub])")?;
        let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("voice/stt_edge.py");
        let mut child = Command::new(py)
            .arg(script)
            .env("HF_HUB_OFFLINE", std::env::var("HF_HUB_OFFLINE").unwrap_or_else(|_| "1".into()))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("spawn stt edge: {e}"))?;
        let stdin = child.stdin.take().ok_or("edge stdin")?;
        let mut stdout = BufReader::new(child.stdout.take().ok_or("edge stdout")?);
        let mut line = String::new();
        stdout.read_line(&mut line).map_err(|e| format!("edge ready: {e}"))?;
        let v: serde_json::Value = serde_json::from_str(&line).map_err(|_| format!("edge said: {line}"))?;
        if v["ready"] != true {
            let _ = child.wait();
            return Err(format!("edge not ready: {}", v["error"].as_str().unwrap_or("?")));
        }
        Ok(InProcessStt {
            child,
            stdin: Some(stdin),
            stdout,
            model: v["model"].as_str().unwrap_or("?").into(),
            load_ms: v["load_ms"].as_u64().unwrap_or(0),
            rss_mb: v["rss_mb"].as_u64().unwrap_or(0),
            next: 1,
        })
    }
}

impl SttEngine for InProcessStt {
    fn name(&self) -> String {
        format!("in-process ({})", self.model)
    }
    fn transcribe(&mut self, pcm: &Pcm) -> Result<(String, u64), String> {
        let bytes: Vec<u8> = pcm.samples.iter().flat_map(|s| s.to_le_bytes()).collect();
        let id = self.next;
        self.next += 1;
        let req = serde_json::json!({
            "id": id, "rate": pcm.rate,
            "pcm16": base64::engine::general_purpose::STANDARD.encode(bytes),
        });
        let stdin = self.stdin.as_mut().ok_or("edge closed")?;
        writeln!(stdin, "{req}").map_err(|e| format!("edge write: {e}"))?;
        stdin.flush().map_err(|e| e.to_string())?;
        let mut line = String::new();
        self.stdout.read_line(&mut line).map_err(|e| format!("edge read: {e}"))?;
        let v: serde_json::Value = serde_json::from_str(&line).map_err(|_| format!("edge said: {line}"))?;
        if let Some(e) = v["error"].as_str() {
            return Err(format!("edge recognize: {e}"));
        }
        Ok((v["text"].as_str().unwrap_or("").trim().to_string(), v["ms"].as_u64().unwrap_or(0)))
    }
}

impl Drop for InProcessStt {
    fn drop(&mut self) {
        // closing stdin ends the edge loop (EOF → exit 0); SIGTERM if it lingers
        drop(self.stdin.take());
        for i in 0..30 {
            if let Ok(Some(_)) = self.child.try_wait() {
                return;
            }
            if i == 20 {
                let _ = Command::new("kill").args(["-TERM", &self.child.id().to_string()]).status();
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
    }
}

/// Word error rate (%) of `hyp` against `reference`, normalized (lowercase,
/// letters/digits only) — Levenshtein over words.
pub fn wer(reference: &str, hyp: &str) -> u64 {
    let norm = |s: &str| -> Vec<String> {
        s.to_lowercase()
            .split(|c: char| !c.is_alphanumeric() && c != '\'')
            .filter(|w| !w.is_empty())
            .map(String::from)
            .collect()
    };
    let (r, h) = (norm(reference), norm(hyp));
    if r.is_empty() {
        return if h.is_empty() { 0 } else { 100 };
    }
    let mut prev: Vec<usize> = (0..=h.len()).collect();
    for i in 1..=r.len() {
        let mut cur = vec![i; h.len() + 1];
        for j in 1..=h.len() {
            let sub = prev[j - 1] + usize::from(r[i - 1] != h[j - 1]);
            cur[j] = sub.min(prev[j] + 1).min(cur[j - 1] + 1);
        }
        prev = cur;
    }
    (prev[h.len()] * 100 / r.len()) as u64
}

#[cfg(test)]
mod tests {
    #[test]
    fn wer_counts_words() {
        assert_eq!(super::wer("hello bridge this is", "hello bridge this is"), 0);
        assert_eq!(super::wer("hello bridge this is", "Hello, bridge! This is."), 0);
        assert_eq!(super::wer("a b c d", "a x c d"), 25);
        assert_eq!(super::wer("a b c d", "a c d"), 25);
    }
}
