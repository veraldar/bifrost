//! Scenario runner — one command, the whole matrix, a pass/fail board.

use std::time::Instant;

pub struct Metrics {
    pub latencies_ms: Vec<(String, u64)>,
    pub counters: Vec<(String, u64)>,
}

impl Metrics {
    pub fn new() -> Metrics {
        Metrics {
            latencies_ms: vec![],
            counters: vec![],
        }
    }
    pub fn lat(mut self, label: &str, ms: u64) -> Metrics {
        self.latencies_ms.push((label.into(), ms));
        self
    }
    pub fn cnt(mut self, label: &str, n: u64) -> Metrics {
        self.counters.push((label.into(), n));
        self
    }
    pub fn headline(&self) -> String {
        if let Some((l, v)) = self.latencies_ms.first() {
            format!("{l} {v}ms")
        } else if let Some((l, v)) = self.counters.first() {
            format!("{l} {v}")
        } else {
            String::new()
        }
    }
}

impl Default for Metrics {
    fn default() -> Self {
        Metrics::new()
    }
}

pub enum Verdict {
    Pass,
    /// the stack failed EXACTLY as the fleet expects it to today — the
    /// behavior is documented, not hidden (e.g. raw NAT rebind kills the path)
    ExpectedBreak(String),
    /// a KNOWN live defect in the real stack, caught by this scenario and
    /// tracked here so the matrix stays readable: when the fix lands upstream
    /// the verdict flips to PASS on its own
    KnownIssue(String),
    Skip(String),
    Fail(String),
}

impl Verdict {
    fn tag(&self) -> &'static str {
        match self {
            Verdict::Pass => "PASS",
            Verdict::ExpectedBreak(_) => "BREAK-OK",
            Verdict::KnownIssue(_) => "KNOWN",
            Verdict::Skip(_) => "SKIP",
            Verdict::Fail(_) => "FAIL",
        }
    }
}

pub struct ScenarioResult {
    pub name: &'static str,
    pub device: &'static str,
    pub profile: &'static str,
    pub verdict: Verdict,
    pub metrics: Metrics,
}

pub struct ScenarioDef {
    pub name: &'static str,
    pub device: &'static str,
    pub profile: &'static str,
    pub run: fn() -> (Verdict, Metrics),
}

pub fn run_matrix(only: Option<&str>) -> i32 {
    let all = crate::scenarios::registry();
    let list: Vec<&ScenarioDef> = match only {
        Some(want) => all
            .iter()
            .filter(|s| s.name.contains(want))
            .collect(),
        None => all.iter().collect(),
    };
    if list.is_empty() {
        eprintln!("no scenario matches filter '{only:?}'");
        return 2;
    }

    let t0 = Instant::now();
    let seed = std::env::var("YGG_SIM_SEED")
        .ok()
        .and_then(|s| u64::from_str_radix(s.trim_start_matches("0x"), 16).ok())
        .unwrap_or(0xC0FFEE);

    println!(
        "[LAB] ygg-sim — scenario matrix · seed {seed:#x} · hermetic (real yggdrasil + real bridge children, mock upstream)"
    );
    println!("──────────────────────────────────────────────────────────────────────────");

    let mut results = vec![];
    for def in list {
        let s0 = Instant::now();
        let (verdict, metrics) = (def.run)();
        let wall = s0.elapsed().as_millis() as u64;
        println!(
            "{:<28} {:<8} {:<11} {:<9} {:<44} {:>5}s",
            def.name,
            def.device,
            def.profile,
            verdict.tag(),
            metrics.headline(),
            wall / 1000
        );
        results.push(ScenarioResult {
            name: def.name,
            device: def.device,
            profile: def.profile,
            verdict,
            metrics,
        });
    }

    let pass = results.iter().filter(|r| matches!(r.verdict, Verdict::Pass)).count();
    let brk = results.iter().filter(|r| matches!(r.verdict, Verdict::ExpectedBreak(_))).count();
    let known = results.iter().filter(|r| matches!(r.verdict, Verdict::KnownIssue(_))).count();
    let skip = results.iter().filter(|r| matches!(r.verdict, Verdict::Skip(_))).count();
    let fail = results.iter().filter(|r| matches!(r.verdict, Verdict::Fail(_))).count();
    println!("──────────────────────────────────────────────────────────────────────────");
    println!(
        "MATRIX: {} ran · {pass} pass · {brk} break-as-expected · {known} known-issue · {skip} skip · {fail} FAIL · wall {}s",
        results.len(),
        t0.elapsed().as_secs()
    );

    write_report(&results, seed);
    if fail > 0 {
        1
    } else {
        0
    }
}

fn write_report(results: &[ScenarioResult], seed: u64) {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("report");
    let _ = std::fs::create_dir_all(&dir);

    let mut md = String::new();
    md.push_str(&format!(
        "# ygg-sim matrix report\n\nseed `{seed:#x}` · hermetic world (real yggdrasil + real bifrost-net bridge children, deterministic mock upstream)\n\n",
    ));
    md.push_str("| scenario | device | profile | verdict | metrics |\n|---|---|---|---|---|\n");
    for r in results {
        let note = match &r.verdict {
            Verdict::Pass => r.metrics.headline(),
            Verdict::ExpectedBreak(n) => format!("breaks as documented: {n}"),
            Verdict::KnownIssue(n) => format!("known issue (tracked): {n}"),
            Verdict::Skip(why) => format!("skip — {why}"),
            Verdict::Fail(why) => format!("**FAIL — {why}**"),
        };
        md.push_str(&format!(
            "| {} | {} | {} | {} | {} |\n",
            r.name,
            r.device,
            r.profile,
            r.verdict.tag(),
            note
        ));
    }
    for r in results {
        if r.metrics.latencies_ms.len() > 1 || r.metrics.counters.len() > 1 {
            md.push_str(&format!("\n### {}\n\n", r.name));
            for (l, v) in &r.metrics.latencies_ms {
                md.push_str(&format!("- {l}: {v}ms\n"));
            }
            for (l, v) in &r.metrics.counters {
                md.push_str(&format!("- {l}: {v}\n"));
            }
        }
    }
    let _ = std::fs::write(dir.join("matrix.md"), md);

    let mut json = serde_json::json!({ "seed": format!("{seed:#x}"), "scenarios": [] });
    for r in results {
        json["scenarios"].as_array_mut().unwrap().push(serde_json::json!({
            "name": r.name,
            "device": r.device,
            "profile": r.profile,
            "verdict": r.verdict.tag(),
            "latencies_ms": r.metrics.latencies_ms,
            "counters": r.metrics.counters,
        }));
    }
    let _ = std::fs::write(dir.join("matrix.json"), serde_json::to_string_pretty(&json).unwrap());
}
