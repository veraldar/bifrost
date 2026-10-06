//! SLO budgets — "green" means WITHIN BUDGET, not just finished (sim v5).
//!
//! Every latency a scenario reports can carry:
//! - `budget` — a hard regression guard. A PASS whose metric exceeds it (or
//!   does not report it) becomes FAIL. Budgets are ≈2× the worst value seen
//!   in cycles 1–5 (the same 2× line the drift watch uses), rounded up — they
//!   catch regressions without flapping on box load.
//! - `target` — the product goal (where one is stated). Missing it never fails
//!   the run; the board shows the gap ("over target") so the distance between
//!   "works in the lab" and "feels right on the phone" stays visible.
//!   Targets marked here are PROPOSALS until the owner ratifies them.
//!
//! BREAK-OK / KNOWN / SKIP verdicts are recorded against the same table but
//! not changed by it: their semantics already say "not green". A KNOWN that
//! flips to PASS when its upstream fix lands is immediately held to budget
//! (e.g. bridge.prompt-run-done: run ≤ 5s once the 120s-timeout path is gone).

use crate::runner::{Metrics, Verdict};

pub struct Slo {
    pub metric: &'static str,
    pub budget_ms: u64,
    pub target_ms: Option<u64>,
}

// struct literals (not fn calls) so the table promotes to 'static
macro_rules! b {
    ($m:literal, $b:literal) => {
        Slo { metric: $m, budget_ms: $b, target_ms: None }
    };
}
macro_rules! t {
    ($m:literal, $b:literal, $t:literal) => {
        Slo { metric: $m, budget_ms: $b, target_ms: Some($t) }
    };
}

/// The table — one place to read every scenario's contract.
pub fn table(name: &str) -> &'static [Slo] {
    match name {
        "rest.text-roundtrip" => &[b!("turn", 500)],
        "rest.abort-mid-run" => &[b!("abort", 250), b!("post-abort-turn", 500)],
        "rest.refresh-reread" => &[b!("turn", 500)],
        "rest.marathon-rollup" => &[b!("turn-0", 6000), b!("post-rollup-turn", 500), b!("total", 18000)],
        "rest.upstream-down" => &[b!("recovery-turn", 500)],
        "rest.tool-loop" => &[b!("one-call", 500), b!("two-call", 1000)],
        "rest.parallel-sessions" => &[b!("wall-4-parallel", 500)],
        "rest.abort-mid-tool" => &[b!("abort", 250), b!("post-abort-turn", 500)],
        "rest.anthropic-dialect" => &[b!("turn-1", 500), b!("turn-2", 1000)],
        "bridge.data-roundtrip" => &[b!("ping-avg", 300), b!("ping-max", 600)],
        "bridge.prompt-run-done" => &[b!("run", 5000)],
        // voice turns: CPU speaches today (~17–23s); 8s = proposed hands-free target
        "bridge.handsfree-round" => &[t!("voice-turn", 45000, 8000)],
        "bridge.poor-network-turn" => &[t!("voice-turn", 45000, 10000)],
        "bridge.link-flap" => &[b!("recover-2s", 3000)],
        "bridge.mode-switch" => &[
            b!("keyboard-cycle", 17000),
            b!("ping-keyboard", 600),
            t!("voice-turn", 30000, 8000),
            b!("ping-after-voice", 600),
        ],
        "bridge.abort-mid-turn" => &[b!("fresh-connect", 3000), b!("idle-after-death", 3000)],
        "bridge.reconnect-after-switch" => &[b!("reconnect", 500)],
        "bridge.tts-paragraphs" => &[b!("essay-turn", 56000)],
        "bridge.bandwidth-starved" => &[b!("post-burst-ping", 5000)],
        "bridge.paced-uplink-starved" => &[b!("voice-turn", 100000)],
        "bridge.tool-loop" => &[b!("one-call", 1000), b!("two-call", 1000), b!("ping-1-tool-busy", 1500), t!("ping-2-tools-busy", 60000, 500)],
        "app.chrome-mic-origin" => &[b!("gum-B-8443", 15000), b!("probe-wall", 90000)],
        "app.install-pair" => &[t!("pair-verify", 5000, 3000), b!("token-in-page", 8000)],
        "app.push-notification" => &[t!("notify-visible", 8000, 3000)],
        "app.background-audio" => &[b!("gum-live", 10000)],
        "app.hot-reload" => &[t!("relaunch-to-v2", 6000, 3000)],
        // in-process STT (sim v5): lab6 bench RTF 0.224 on this CPU
        // v0.6.2 gate (docs/STABLE.md): transcript ≤ 2 s after a 10 s utterance
        "voice.stt-inprocess" => &[b!("model-load", 30000), t!("stt-utterance", 4000, 1000), t!("stt-10s-utterance", 10000, 2000)],
        _ => &[],
    }
}

#[derive(Clone, Debug)]
pub struct SloCheck {
    pub metric: &'static str,
    pub value: Option<u64>,
    pub budget_ms: u64,
    pub target_ms: Option<u64>,
}

impl SloCheck {
    pub fn within(&self) -> bool {
        self.value.map(|v| v <= self.budget_ms).unwrap_or(false)
    }
    pub fn on_target(&self) -> Option<bool> {
        match (self.value, self.target_ms) {
            (Some(v), Some(t)) => Some(v <= t),
            _ => None,
        }
    }
    pub fn json(&self) -> serde_json::Value {
        serde_json::json!({
            "metric": self.metric, "value": self.value, "budget_ms": self.budget_ms,
            "target_ms": self.target_ms, "within": self.within(), "on_target": self.on_target(),
        })
    }
}

pub fn check(name: &str, m: &Metrics) -> Vec<SloCheck> {
    table(name)
        .iter()
        .map(|s| SloCheck {
            metric: s.metric,
            value: m.latencies_ms.iter().find(|(l, _)| l == s.metric).map(|(_, v)| *v),
            budget_ms: s.budget_ms,
            target_ms: s.target_ms,
        })
        .collect()
}

/// PASS → FAIL on a budget breach or an unreported budgeted metric.
pub fn apply(v: Verdict, checks: &[SloCheck]) -> Verdict {
    if !matches!(v, Verdict::Pass) {
        return v;
    }
    for c in checks {
        match c.value {
            None => return Verdict::Fail(format!("SLO: budgeted metric '{}' not reported", c.metric)),
            Some(x) if x > c.budget_ms => {
                return Verdict::Fail(format!("SLO breach: {} {}ms > budget {}ms", c.metric, x, c.budget_ms))
            }
            _ => {}
        }
    }
    Verdict::Pass
}

/// board cell: "slo 2/2" · "slo 2/2 tgt 0/1" · "" when no budgets
pub fn cell(checks: &[SloCheck]) -> String {
    if checks.is_empty() {
        return String::new();
    }
    let within = checks.iter().filter(|c| c.within()).count();
    let tg: Vec<bool> = checks.iter().filter_map(|c| c.on_target()).collect();
    let mut s = format!("slo {within}/{}", checks.len());
    if !tg.is_empty() {
        s.push_str(&format!(" tgt {}/{}", tg.iter().filter(|x| **x).count(), tg.len()));
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn budget_turns_pass_into_fail_only_when_breached() {
        let m = Metrics::new().lat("turn", 120);
        let c = check("rest.text-roundtrip", &m);
        assert!(matches!(apply(Verdict::Pass, &c), Verdict::Pass));
        let slow = Metrics::new().lat("turn", 900);
        let c = check("rest.text-roundtrip", &slow);
        assert!(matches!(apply(Verdict::Pass, &c), Verdict::Fail(_)));
        // missing metric on a PASS = FAIL (a budget can't silently vanish)
        let c = check("rest.text-roundtrip", &Metrics::new());
        assert!(matches!(apply(Verdict::Pass, &c), Verdict::Fail(_)));
        // non-PASS verdicts keep their own semantics
        let c = check("rest.text-roundtrip", &slow);
        assert!(matches!(apply(Verdict::KnownIssue("x".into()), &c), Verdict::KnownIssue(_)));
    }

    #[test]
    fn target_never_fails_but_shows() {
        let m = Metrics::new().lat("voice-turn", 18000);
        let c = check("bridge.handsfree-round", &m);
        assert!(matches!(apply(Verdict::Pass, &c), Verdict::Pass));
        assert_eq!(cell(&c), "slo 1/1 tgt 0/1");
    }
}
