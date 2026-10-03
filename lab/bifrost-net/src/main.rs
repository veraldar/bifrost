//! bifrost-net M0 — de-risk spike for the sovereign access point.
//!
//! THE QUESTION: can a correctly-prompted AGI assemble tailscale+webrtc from
//! PROVEN Rust crates (boringtun + str0m), one binary, country-pinned VPS?
//! M0 proves the two critical seams, small:
//!   1. mesh: two nodes connect privately via WireGuard protocol (boringtun)
//!   2. echo: WebRTC media relays through a str0m middle peer
//!
//! NO hand-rolled crypto. Safety claim under test = auditable smallness +
//! country-pinned hosting + self-hosted — NOT "safer than tailscale".

mod echo;
mod mesh;

fn main() {
    println!("bifrost-net M0 — boringtun mesh + str0m echo");
    let mut failed = false;

    print!("M0.1 mesh : ");
    match mesh::run() {
        Ok(()) => println!("M0.1 PASS — two nodes connected privately (WireGuard protocol)"),
        Err(e) => {
            failed = true;
            println!("M0.1 FAIL — {e}");
        }
    }

    print!("M0.2 echo : ");
    match echo::run() {
        Ok(()) => println!("M0.2 PASS — WebRTC media relayed and byte-verified"),
        Err(e) => {
            failed = true;
            println!("M0.2 FAIL — {e}");
        }
    }

    if failed {
        std::process::exit(1);
    }
    println!("M0 VERDICT: GREEN — both seams proven");
}
