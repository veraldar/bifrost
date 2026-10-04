//! ygg-sim — the flight simulator for bifrost.
//!
//! Simulated clients (str0m, in-binary) fly against the REAL stack — the real
//! `yggdrasil` binary and the real `bifrost-net bridge` binary, spawned as
//! child processes — over a shaped wire (netem in binary: latency, jitter,
//! loss, reorder, duplication, bandwidth, blackouts, NAT re-binds), driven
//! through a deterministic scenario matrix. One command runs the matrix and
//! prints a pass/fail board.
//!
//! Everything external to the client is REAL except the upstream LLM (mocked
//! in-binary, deterministic) and, when absent, speaches (voice scenarios then
//! SKIP loudly).

mod client;
mod httpc;
mod mockup;
mod m0;
mod rng;
mod runner;
mod scenarios;
mod speech;
mod wire;
mod world;

use std::sync::atomic::{AtomicUsize, Ordering};

/// debug breadcrumb for the watchdog (YGG_SIM_DEBUG=1)
pub static STEP: AtomicUsize = AtomicUsize::new(0);

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if std::env::var_os("YGG_SIM_DEBUG").is_some() {
        std::thread::Builder::new()
            .name("ygg-sim-watchdog".into())
            .spawn(|| loop {
                std::thread::sleep(std::time::Duration::from_secs(2));
                let mut out = format!("[watchdog] step {}", STEP.load(Ordering::Relaxed));
                if let Ok(dir) = std::fs::read_dir("/proc/self/task") {
                    for t in dir.flatten() {
                        let tid = t.file_name();
                        let wchan = std::fs::read_to_string(format!(
                            "/proc/self/task/{}/wchan",
                            tid.display()
                        ))
                        .unwrap_or_default();
                        let stat = std::fs::read_to_string(format!(
                            "/proc/self/task/{}/stat",
                            tid.display()
                        ))
                        .unwrap_or_default();
                        let state = stat.split_whitespace().nth(2).unwrap_or("?").to_string();
                        out.push_str(&format!(
                            "\n  tid {} {} wchan={}",
                            tid.display(),
                            state,
                            wchan.trim()
                        ));
                    }
                }
                eprintln!("{out}");
            })
            .ok();
    }
    let code = match args.first().map(String::as_str) {
        Some("m0") => m0::run(),
        Some("matrix") => {
            let only = args
                .windows(2)
                .find(|w| w[0] == "--only")
                .map(|w| w[1].as_str());
            runner::run_matrix(only)
        }
        Some("cycle") => runner::run_cycle(),
        Some(cmd) => {
            eprintln!("ygg-sim: unknown command '{cmd}' (known: m0, matrix, cycle)");
            2
        }
        None => {
            eprintln!("usage: ygg-sim m0 | matrix [--only FILTER] | cycle");
            2
        }
    };
    std::process::exit(code);
}
