//! The three evolution sources (co-evolution law: the simulation is the
//! environment's model — reality surprising the model is the evolution
//! trigger):
//!
//! 1. INCIDENTS — the incident-to-scenario pipeline (INCIDENTS.md): every
//!    production incident becomes a scenario in the next version; an incident
//!    uncovered for more than one cycle fails the cycle.
//! 2. ENVIRONMENT — the manifest (ENVIRONMENT.md): provider/transport/store
//!    facts; drift vs the previous cycle = a new chaos profile or scenario
//!    dimension owed.
//! 3. USAGE — the live store (opencode SQLite): sessions, messages, deepest
//!    session. Shifts vs the previous cycle point the matrix at real life.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

fn lab_path(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join(name)
}

#[allow(dead_code)] // structured form kept for the v6+ registry tooling
pub struct Incident {
    pub id: String,
    pub class: String,
    pub covered_by: String,
    pub since: u32,
}

/// Parse the register; `covers` = the scenario names live in the registry, so
/// stale coverage (a renamed/removed scenario) counts as uncovered.
pub fn incidents(registry_names: &[&str]) -> (usize, Vec<String>) {
    let Ok(txt) = std::fs::read_to_string(lab_path("INCIDENTS.md")) else {
        return (0, vec!["INCIDENTS.md missing".to_string()]);
    };
    let total = txt.lines().filter(|l| l.trim_start().starts_with("- [")).count();
    let mut uncovered = vec![];
    for line in txt.lines().filter(|l| l.trim_start().starts_with("- [")) {
        let id = line
            .split("[")
            .nth(1)
            .and_then(|s| s.split("]").next())
            .unwrap_or("?")
            .to_string();
        let covered = line
            .split("covered-by:")
            .nth(1)
            .and_then(|s| s.split("|").next())
            .map(|s| s.trim().to_string())
            .unwrap_or_default();
        let since = line
            .split("since:")
            .nth(1)
            .and_then(|s| s.trim().parse::<u32>().ok())
            .unwrap_or(0);
        if covered == "none" || !registry_names.iter().any(|n| n.contains(covered.as_str())) {
            uncovered.push(format!("{id} (class {covered}, since cycle {since})"));
        }
        let _ = since;
    }
    (total, uncovered)
}

/// key: value pairs from ENVIRONMENT.md (comments and blanks skipped).
pub fn environment() -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    if let Ok(txt) = std::fs::read_to_string(lab_path("ENVIRONMENT.md")) {
        for line in txt.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            if let Some((k, v)) = line.split_once(':') {
                out.insert(k.trim().to_string(), v.trim().to_string());
            }
        }
    }
    out
}

/// The live store's usage shape: (sessions, messages, max messages in one
/// session). Read-only against opencode's SQLite; None when absent.
pub fn usage() -> Option<(u64, u64, u64)> {
    let db = std::env::var("YGG_SIM_STORE").unwrap_or_else(|_| {
        format!(
            "{}/.local/share/opencode/opencode.db",
            std::env::var("HOME").unwrap_or_default()
        )
    });
    if !Path::new(&db).exists() {
        return None;
    }
    let q = |sql: &str| -> Option<u64> {
        let out = Command::new("sqlite3")
            .arg(format!("file:{db}?mode=ro"))
            .args(["-noheader", "-nofilename", sql])
            .output()
            .ok()?;
        String::from_utf8_lossy(&out.stdout).trim().parse().ok()
    };
    let sessions = q("select count(*) from session;")?;
    let messages = q("select count(*) from message;")?;
    let deepest = q(
        "select coalesce(max(c),0) from (select count(*) c from message group by session_id);",
    )?;
    Some((sessions, messages, deepest))
}

use std::process::Command;
