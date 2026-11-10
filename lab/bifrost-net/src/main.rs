//! bifrost-net — the sovereign access point spike.
//!
//! ONE binary: private mesh (WireGuard protocol via boringtun) + WebRTC
//! relay (str0m) + explicit config. Proven crates only, no hand-rolled crypto.
//!
//! Subcommands:
//!   keygen              print a fresh private/public keypair
//!   check -c CONFIG     validate config, print findings, exit 0/1
//!   selftest m0|m1      run the verification suites (loopback)
//!   serve -c CONFIG     run the node (mesh + webrtc in one process)
//!   ap -c AP.TOML       run the access point (TLS edge; the bridge dials in)
//!   ap-token            mint a bridge pairing token (+ its sha-256 for ap.toml)
//!   ap-pin CERT.pem     print the pin bridge.toml [ap] must carry
//!   ap-cert DIR NAME..  self-signed cert+key for local runs (prints the pin)

mod ap;
mod bridge;
mod bridge_main;
mod config;
mod echo;
mod opencode;
mod region;
mod speech;
mod tokens;
mod keys;
mod mesh;
mod relay;
mod serve;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let code = match args.first().map(String::as_str) {
        Some("keygen") => cmd_keygen(),
        Some("check") => cmd_check(&args[1..]),
        Some("selftest") => cmd_selftest(&args[1..]),
        Some("serve") => cmd_serve(&args[1..]),
        Some("bridge") => cmd_bridge(&args[1..]),
        Some("ap") => cmd_ap(&args[1..]),
        Some("ap-token") => {
            let (raw, hash) = ap::new_token();
            println!("token = \"{raw}\"                      # bridge.toml [ap] — keep secret");
            println!("bridge_token_sha256 = \"{hash}\"   # ap.toml [ap]");
            0
        }
        Some("ap-pin") => match args.get(1).map(|p| ap::pin_of_pem(p)) {
            Some(Ok(pin)) => {
                println!("pin = \"{pin}\"");
                0
            }
            Some(Err(e)) => {
                eprintln!("ap-pin: {e}");
                1
            }
            None => {
                eprintln!("ap-pin: missing CERT.pem");
                2
            }
        },
        Some("ap-cert") => match args.get(1) {
            Some(dir) => match ap::self_signed(dir, args[2..].to_vec()) {
                Ok((cert, key, pin)) => {
                    println!("cert_path = \"{cert}\"\nkey_path = \"{key}\"\npin = \"{pin}\"");
                    0
                }
                Err(e) => {
                    eprintln!("ap-cert: {e}");
                    1
                }
            },
            None => {
                eprintln!("ap-cert: DIR NAME.. (e.g. ap-cert /tmp/ap localhost 127.0.0.1)");
                2
            }
        },
        _ => {
            eprintln!(
                "usage: bifrost-net keygen | check -c CONFIG | selftest m0|m1|v9|ap | serve -c CONFIG | bridge -c CONFIG | ap -c AP.TOML | ap-token | ap-pin CERT.pem | ap-cert DIR NAME.."
            );
            2
        }
    };
    std::process::exit(code);
}

fn cmd_keygen() -> i32 {
    let (priv_b64, pub_b64) = keys::generate();
    println!("private_key = \"{priv_b64}\"");
    println!("public_key  = \"{pub_b64}\"   # give this to peers");
    0
}

fn cmd_check(args: &[String]) -> i32 {
    let Some(path) = config_arg(args) else {
        eprintln!("check: missing -c CONFIG");
        return 2;
    };
    match config::load(path).and_then(|l| {
        let lines = l.config.check()?;
        Ok((l, lines))
    }) {
        Ok((l, lines)) => {
            println!("config {} — VALID", l.path);
            for line in lines {
                println!("  {line}");
            }
            0
        }
        Err(e) => {
            println!("config {path} — INVALID: {e}");
            1
        }
    }
}

fn cmd_selftest(args: &[String]) -> i32 {
    match args.first().map(String::as_str) {
        Some("m0") => selftest_m0(),
        Some("m1") => selftest_m1(),
        Some("v9") => selftest_v9(),
        Some("ap") => selftest_ap(),
        _ => {
            eprintln!("selftest: suite must be m0 or m1");
            2
        }
    }
}

fn selftest_m0() -> i32 {
    println!("bifrost-net M0 — boringtun mesh + str0m echo");
    let mut failed = false;

    print!("M0.1 mesh : ");
    match mesh::m0_test() {
        Ok(()) => println!("M0.1 PASS — two nodes connected privately (WireGuard protocol)"),
        Err(e) => {
            failed = true;
            println!("M0.1 FAIL — {e}");
        }
    }

    print!("M0.2 echo : ");
    match echo::m0_test() {
        Ok(()) => println!("M0.2 PASS — WebRTC media relayed and byte-verified"),
        Err(e) => {
            failed = true;
            println!("M0.2 FAIL — {e}");
        }
    }

    if failed {
        1
    } else {
        println!("M0 VERDICT: GREEN — both seams proven");
        0
    }
}

fn selftest_m1() -> i32 {
    println!("bifrost-net M1 — service meshes + relay under one binary");
    let mut failed = false;

    print!("M1.1 mesh service : ");
    match mesh::service_test() {
        Ok(()) => println!("M1.1 PASS — config-driven mesh, timers+rekey+stats verified"),
        Err(e) => {
            failed = true;
            println!("M1.1 FAIL — {e}");
        }
    }

    print!("M1.2 webrtc relay : ");
    match relay::service_test() {
        Ok(()) => println!("M1.2 PASS — signaling+media relay cross-forwarded byte-exact"),
        Err(e) => {
            failed = true;
            println!("M1.2 FAIL — {e}");
        }
    }

    if failed {
        1
    } else {
        println!("M1 VERDICT: GREEN — full-build seams proven");
        0
    }
}

fn cmd_bridge(args: &[String]) -> i32 {
    let Some(path) = config_arg(args) else {
        eprintln!("bridge: missing -c CONFIG");
        return 2;
    };
    match crate::bridge_main::run(path) {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("bridge: {e}");
            1
        }
    }
}

fn selftest_v9() -> i32 {
    println!("bifrost-net v9 — bridge over the real seam");
    let mut failed = false;

    print!("V9.2 bridge : ");
    if let Err(e) = bridge::bridge_test() {
        failed = true;
        println!("V9.2 FAIL — {e}");
    } else {
        println!("V9.2 PASS — token-gated channel protocol round-trips against live opencode");
    }

    print!("V9.3 voice  : ");
    if let Err(e) = bridge::voice_test() {
        failed = true;
        println!("V9.3 FAIL — {e}");
    } else {
        println!("V9.3 PASS — mic-format voice pipeline verified against speaches");
    }

    if failed {
        1
    } else {
        println!("V9 VERDICT: GREEN — bridge seams proven");
        0
    }
}

fn selftest_ap() -> i32 {
    println!("bifrost-net ap — access point + dial-out bridge channel (loopback)");
    match ap::selftest() {
        Ok(detail) => {
            println!("AP.1 PASS — {detail}");
            println!("AP VERDICT: GREEN — edge + channel + gate proven");
            0
        }
        Err(e) => {
            println!("AP.1 FAIL — {e}");
            1
        }
    }
}

fn cmd_ap(args: &[String]) -> i32 {
    let Some(path) = config_arg(args) else {
        eprintln!("ap: missing -c AP.TOML");
        return 2;
    };
    match ap::run(path) {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("ap: {e}");
            1
        }
    }
}

fn cmd_serve(args: &[String]) -> i32 {
    let Some(path) = config_arg(args) else {
        eprintln!("serve: missing -c CONFIG");
        return 2;
    };
    match crate::serve::run(path) {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("serve: {e}");
            1
        }
    }
}

fn config_arg(args: &[String]) -> Option<&str> {
    args.windows(2)
        .find(|w| w[0] == "-c" || w[0] == "--config")
        .map(|w| w[1].as_str())
}
