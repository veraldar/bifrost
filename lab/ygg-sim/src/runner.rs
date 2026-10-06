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
    pub headline: String,
    /// SLO budget checks (src/slo.rs) — already applied to `verdict`
    pub slo: Vec<crate::slo::SloCheck>,
}

pub struct ScenarioDef {
    pub name: &'static str,
    pub device: &'static str,
    pub profile: &'static str,
    pub run: fn() -> (Verdict, Metrics),
}

pub struct MatrixRun {
    pub seed: u64,
    pub results: Vec<ScenarioResult>,
}

/// Runs the whole matrix (or a filtered slice), prints the board, writes the
/// matrix reports. `run_matrix` and `cycle` both build on this.
pub fn collect(only: Option<&str>) -> MatrixRun {
    let all = crate::scenarios::registry();
    let list: Vec<&ScenarioDef> = match only {
        Some(want) => all.iter().filter(|s| s.name.contains(want)).collect(),
        None => all.iter().collect(),
    };
    if list.is_empty() {
        eprintln!("no scenario matches filter '{only:?}'");
        return MatrixRun {
            seed: 0,
            results: vec![],
        };
    }

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
        let headline = metrics.headline();
        // green = within budget, not just finished
        let slo = crate::slo::check(def.name, &metrics);
        let verdict = crate::slo::apply(verdict, &slo);
        println!(
            "{:<28} {:<8} {:<11} {:<9} {:<36} {:<16} {:>5}s",
            def.name,
            def.device,
            def.profile,
            verdict.tag(),
            headline,
            crate::slo::cell(&slo),
            wall / 1000
        );
        results.push(ScenarioResult {
            name: def.name,
            device: def.device,
            profile: def.profile,
            verdict,
            metrics,
            headline,
            slo,
        });
    }
    // the app family may have booted the sim's own AVD (a child) — stop it
    crate::app::shutdown_emulator();
    MatrixRun { seed, results }
}

pub fn summarize(run: &MatrixRun) -> (usize, usize, usize, usize, usize) {
    let results = &run.results;
    let pass = results.iter().filter(|r| matches!(r.verdict, Verdict::Pass)).count();
    let brk = results.iter().filter(|r| matches!(r.verdict, Verdict::ExpectedBreak(_))).count();
    let known = results.iter().filter(|r| matches!(r.verdict, Verdict::KnownIssue(_))).count();
    let skip = results.iter().filter(|r| matches!(r.verdict, Verdict::Skip(_))).count();
    let fail = results.iter().filter(|r| matches!(r.verdict, Verdict::Fail(_))).count();
    println!("──────────────────────────────────────────────────────────────────────────");
    println!(
        "MATRIX: {} ran · {pass} pass · {brk} break-as-expected · {known} known-issue · {skip} skip · {fail} FAIL",
        results.len()
    );
    let (held, total, over) = slo_tally(run);
    println!("SLO: {held}/{total} budgets held · {over} over product target (targets never fail a run)");
    write_report(run);
    (pass, brk, known, skip, fail)
}

/// (budgets held, budgets checked, over-target count) across the run
pub fn slo_tally(run: &MatrixRun) -> (usize, usize, usize) {
    let all: Vec<&crate::slo::SloCheck> = run.results.iter().flat_map(|r| r.slo.iter()).collect();
    let held = all.iter().filter(|c| c.within()).count();
    let over = all.iter().filter(|c| c.on_target() == Some(false)).count();
    (held, all.len(), over)
}

pub fn run_matrix(only: Option<&str>) -> i32 {
    let t0 = Instant::now();
    let run = collect(only);
    if run.results.is_empty() {
        return 2;
    }
    let (pass, brk, known, skip, fail) = summarize(&run);
    println!("wall {}s", t0.elapsed().as_secs());
    if fail > 0 {
        1
    } else {
        let _ = (pass, brk, known, skip);
        0
    }
}

/// The app this sim flies (pwa/package.json — the wrap wraps THIS app).
fn app_version() -> Option<String> {
    let txt = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../pwa/package.json"),
    )
    .ok()?;
    let v: serde_json::Value = serde_json::from_str(&txt).ok()?;
    let raw = v.get("version")?.as_str()?.to_string();
    // "0.6.0-152-g36b2482" → stable identity is the leading semver
    Some(raw.split('-').next().unwrap_or(&raw).to_string())
}

fn sim_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

/// The ledger's latest pairing: `app-version pairing: app <X> ↔ sim <Y>`.
fn paired_pairing() -> Option<(String, String)> {
    let txt = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("VERSIONS.md"),
    )
    .ok()?;
    parse_pairing(&txt)
}

fn parse_pairing(txt: &str) -> Option<(String, String)> {
    txt.lines()
        .filter(|l| l.contains("app-version pairing:"))
        .last()
        .and_then(|l| {
            let app = l.split("app ").nth(1)?.split_whitespace().next()?.to_string();
            let sim = l.split("sim ").nth(1)?.split_whitespace().next()?.to_string();
            Some((app, sim))
        })
}

/// THE EVOLUTION RULE: every app version bump gets matching scenario updates —
/// the sim tracks the app. An app change without a sim bump fails the cycle.
/// Returns Err(violation) when the ledger is stale. Pure core (tested below).
fn check_rule(app: &str, sim: &str, ledger_pairing: Option<(String, String)>) -> Result<(), String> {
    let Some(paired) = ledger_pairing else {
        return Ok(()); // first pairing happens at the next landing
    };
    if app != paired.0 && sim == paired.1 {
        return Err(format!(
            "EVOLUTION RULE VIOLATION: app moved {} → {} but the sim is still {} (paired). Bump the sim version + add scenario updates, then re-run the cycle",
            paired.0, app, paired.1
        ));
    }
    Ok(())
}

fn check_evolution_rule() -> Result<(), String> {
    match app_version() {
        Some(app) => check_rule(&app, sim_version(), paired_pairing()),
        None => Ok(()), // no app version visible → nothing to track yet
    }
}
/// trailing number of a headline like "ping-avg 150ms" → 150
fn headline_ms(h: &str) -> Option<u64> {
    let num: String = h
        .split_whitespace()
        .last()?
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect();
    num.parse().ok()
}

/// The loop's mechanized half: run + validate + diff vs the previous cycle
/// snapshot + THE EVOLUTION RULE (app bumps need sim bumps). The
/// proposal/build half is the agent's; this command hands it the evidence.
pub fn run_cycle() -> i32 {
    // evolution gate BEFORE burning three minutes on the matrix
    if let Err(v) = check_evolution_rule() {
        eprintln!("CYCLE INVALID — {v}");
        return 1;
    }
    let t0 = Instant::now();
    let run = collect(None);
    if run.results.is_empty() {
        return 2;
    }
    let (pass, brk, known, skip, fail) = summarize(&run);

    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("report/cycles");
    let _ = std::fs::create_dir_all(&dir);
    let prev_n = (1..)
        .take_while(|n| dir.join(format!("cycle-{n}.json")).exists())
        .count();
    let this_n = prev_n + 1;

    let snap = |n: u32| -> Option<serde_json::Value> {
        let txt = std::fs::read_to_string(dir.join(format!("cycle-{n}.json"))).ok()?;
        serde_json::from_str(&txt).ok()
    };
    let mut digest_lines = vec![];
    if prev_n == 0 {
        digest_lines.push(format!("first cycle on record (cycle-{this_n})"));
    } else if let Some(prev) = snap(prev_n as u32) {
        let prev_scn = prev["scenarios"].as_array().cloned().unwrap_or_default();
        let prev_names: Vec<String> = prev_scn
            .iter()
            .filter_map(|s| s["name"].as_str().map(String::from))
            .collect();
        let this_names: Vec<&str> = run.results.iter().map(|r| r.name).collect();
        let added: Vec<&str> = this_names
            .iter()
            .filter(|n| !prev_names.iter().any(|p| p == **n))
            .copied()
            .collect();
        let gone: Vec<&String> = prev_names.iter().filter(|p| !this_names.contains(&p.as_str())).collect();
        let mut verdict_changes = 0;
        for r in &run.results {
            if let Some(ps) = prev_scn.iter().find(|s| s["name"] == r.name) {
                let pv = ps["verdict"].as_str().unwrap_or("");
                if pv != r.verdict.tag() {
                    verdict_changes += 1;
                    digest_lines.push(format!(
                        "verdict shift: {} {} → {}",
                        r.name,
                        pv,
                        r.verdict.tag()
                    ));
                }
            }
        }
        if !added.is_empty() {
            digest_lines.push(format!("+{} scenarios: {}", added.len(), added.join(", ")));
        }
        if !gone.is_empty() {
            digest_lines.push(format!("-{} scenarios: {}", gone.len(), gone.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(", ")));
        }
        // metric-drift watch: same-scenario headline numbers moving >2×
        // (warn-level — latencies legitimately vary with machine load, but a
        // 2× jump across cycles is a signal the agent should look at)
        for r in &run.results {
            if let Some(ps) = prev_scn.iter().find(|s| s["name"] == r.name) {
                let pv = ps["headline"].as_str().unwrap_or("");
                if let (Some(a), Some(b)) = (headline_ms(pv), headline_ms(&r.headline)) {
                    if a > 0 {
                        let ratio = b as f64 / a as f64;
                        if ratio > 2.0 || ratio < 0.5 {
                            digest_lines.push(format!(
                                "metric drift: {} {}ms → {}ms ({:.1}×)",
                                r.name, a, b, ratio
                            ));
                        }
                    }
                }
            }
        }
        if verdict_changes == 0 && added.is_empty() && gone.is_empty() {
            digest_lines.push("no delta vs previous cycle".into());
        }
    }

    // snapshot this cycle
    let mut json = serde_json::json!({
        "cycle": this_n,
        "seed": format!("{:#x}", run.seed),
        "app_version": app_version(),
        "sim_version": sim_version(),
        "ran": run.results.len(),
        "pass": pass, "break_ok": brk, "known": known, "skip": skip, "fail": fail,
        "slo": { "held": slo_tally(&run).0, "checked": slo_tally(&run).1, "over_target": slo_tally(&run).2 },
        "wall_s": t0.elapsed().as_secs(),
        "scenarios": [],
    });
    for r in &run.results {
        json["scenarios"].as_array_mut().unwrap().push(serde_json::json!({
            "name": r.name,
            "device": r.device,
            "profile": r.profile,
            "verdict": r.verdict.tag(),
            "headline": r.headline,
            "slo": r.slo.iter().map(|c| c.json()).collect::<Vec<_>>(),
        }));
    }
    let _ = std::fs::write(
        dir.join(format!("cycle-{this_n}.json")),
        serde_json::to_string_pretty(&json).unwrap(),
    );

    let (held, checked, over) = slo_tally(&run);
    digest_lines.push(format!("SLO {held}/{checked} budgets held, {over} over target"));
    println!("CYCLE {this_n} vs {prev_n}: {}", digest_lines.join(" · "));
    println!(
        "pairing: app {} ↔ sim {} (ledger-enforced)",
        app_version().unwrap_or_else(|| "?".into()),
        sim_version()
    );
    if fail > 0 {
        println!("CYCLE {this_n} INVALID — {fail} FAIL: fix before the next version step");
        1
    } else {
        println!(
            "CYCLE {this_n} VALID — green-except-documented ({pass} pass / {brk} break / {known} known / {skip} skip)"
        );
        0
    }
}

fn write_report(run: &MatrixRun) {    let results = &run.results;
    let seed = run.seed;
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("report");
    let _ = std::fs::create_dir_all(&dir);

    let mut md = String::new();
    md.push_str(&format!(
        "# ygg-sim matrix report\n\nseed `{seed:#x}` · hermetic world (real yggdrasil + real bifrost-net bridge children, deterministic mock upstream)\n\n",
    ));
    md.push_str("| scenario | device | profile | verdict | SLO | metrics |\n|---|---|---|---|---|---|\n");
    for r in results {
        let note = match &r.verdict {
            Verdict::Pass => r.metrics.headline(),
            Verdict::ExpectedBreak(n) => format!("breaks as documented: {n}"),
            Verdict::KnownIssue(n) => format!("known issue (tracked): {n}"),
            Verdict::Skip(why) => format!("skip — {why}"),
            Verdict::Fail(why) => format!("**FAIL — {why}**"),
        };
        md.push_str(&format!(
            "| {} | {} | {} | {} | {} | {} |\n",
            r.name,
            r.device,
            r.profile,
            r.verdict.tag(),
            crate::slo::cell(&r.slo),
            note
        ));
    }
    for r in results {
        if r.metrics.latencies_ms.len() > 1 || r.metrics.counters.len() > 1 || !r.slo.is_empty() {
            md.push_str(&format!("\n### {}\n\n", r.name));
            for (l, v) in &r.metrics.latencies_ms {
                let budget = r
                    .slo
                    .iter()
                    .find(|c| c.metric == l)
                    .map(|c| {
                        let tgt = c.target_ms.map(|t| format!(", target ≤{t}ms{}", if c.on_target() == Some(false) { " ✗" } else { "" })).unwrap_or_default();
                        format!(" (budget ≤{}ms{}{tgt})", c.budget_ms, if c.within() { " ✓" } else { " ✗" })
                    })
                    .unwrap_or_default();
                md.push_str(&format!("- {l}: {v}ms{budget}\n"));
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
            "slo": r.slo.iter().map(|c| c.json()).collect::<Vec<_>>(),
            "latencies_ms": r.metrics.latencies_ms,
            "counters": r.metrics.counters,
        }));
    }
    let _ = std::fs::write(dir.join("matrix.json"), serde_json::to_string_pretty(&json).unwrap());
}

#[cfg(test)]
mod tests {
    use super::*;

    const LEDGER: &str = "## v2 — landed\n\napp-version pairing: app 0.6.0 ↔ sim 0.3.0\n";

    #[test]
    fn pairing_parser_takes_the_last_line() {
        let txt = format!("{LEDGER}\n## v3\n\napp-version pairing: app 0.7.0 ↔ sim 0.4.0\n");
        assert_eq!(
            parse_pairing(&txt),
            Some(("0.7.0".into(), "0.4.0".into()))
        );
        assert_eq!(
            parse_pairing(LEDGER),
            Some(("0.6.0".into(), "0.3.0".into()))
        );
        assert_eq!(parse_pairing("no pairing here"), None);
    }

    #[test]
    fn evolution_rule_bites() {
        // app bumped, sim not → VIOLATION
        assert!(check_rule("0.7.0", "0.3.0", Some(("0.6.0".into(), "0.3.0".into()))).is_err());
        // both bumped → fine
        assert!(check_rule("0.7.0", "0.4.0", Some(("0.6.0".into(), "0.3.0".into()))).is_ok());
        // app unchanged → fine regardless
        assert!(check_rule("0.6.0", "0.3.0", Some(("0.6.0".into(), "0.3.0".into()))).is_ok());
        // no pairing yet → fine
        assert!(check_rule("0.9.0", "0.1.0", None).is_ok());
    }
}
