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

mod httpc;
mod mockup;
mod m0;
mod rng;
mod wire;
mod world;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let code = match args.first().map(String::as_str) {
        Some("m0") => m0::run(),
        Some(cmd) => {
            eprintln!("ygg-sim: unknown command '{cmd}' (known: m0)");
            2
        }
        None => {
            eprintln!("usage: ygg-sim m0");
            2
        }
    };
    std::process::exit(code);
}
