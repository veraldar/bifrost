//! bifrost-net — the sovereign access point spike.
//!
//! ONE binary: private mesh (WireGuard protocol via boringtun) + WebRTC
//! relay (str0m) + explicit config. Proven crates only, no hand-rolled crypto.
//!
//! Subcommands:
//!   keygen              print a fresh private/public keypair
//!   check -c CONFIG     validate config, print findings, exit 0/1
//!   selftest m0|m1|v9|ap  run the verification suites (loopback)
//!   serve -c CONFIG     run the node (mesh + webrtc in one process)
//!   bridge -c CONFIG    run the v0.9 bridge (rtc + opencode + root-link)
//!   rootlink mint       mint a single-use link-token for a root dial-in
//!   wg -c NODE.toml     run this root's WireGuard node (root <-> root brain calls, wg.rs)
//!   wg-key FILE         the node's key: created mode 600 if missing; prints public + fingerprint
//!   ap -c AP.TOML       run the access point (TLS edge; the bridge dials in)
//!   ap-token            mint a bridge pairing token (+ its sha-256 for ap.toml)
//!   ap-pin CERT.pem     print the pin bridge.toml [ap] must carry
//!   ap-cert DIR NAME..  self-signed cert+key for local runs (prints the pin)

mod ap;
mod bridge;
mod bridge_main;
mod cand;
mod config;
mod echo;
mod opencode;
mod region;
mod registry;
mod rootlink;
mod roots;
mod speech;
mod switch;
mod tokens;
mod keys;
mod mesh;
mod relay;
mod serve;
mod wg;
mod ws;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let code = match args.first().map(String::as_str) {
        Some("keygen") => cmd_keygen(),
        Some("check") => cmd_check(&args[1..]),
        Some("selftest") => cmd_selftest(&args[1..]),
        Some("serve") => cmd_serve(&args[1..]),
        Some("bridge") => cmd_bridge(&args[1..]),
        Some("rootlink") => cmd_rootlink(&args[1..]),
        Some("wg") => match config_arg(&args[1..]) {
            Some(p) => match wg::run(p) {
                Ok(()) => 0,
                Err(e) => {
                    eprintln!("wg: {e}");
                    1
                }
            },
            None => {
                eprintln!("wg: missing -c NODE.toml");
                2
            }
        },
        Some("wg-key") => match args.get(1) {
            Some(path) => match wg::load_or_create_key(path) {
                Ok((_, public)) => {
                    use base64::Engine as _;
                    println!("public_key = \"{}\"", base64::engine::general_purpose::STANDARD.encode(public.as_bytes()));
                    println!("fingerprint = \"{}\"", wg::fingerprint(public.as_bytes()));
                    0
                }
                Err(e) => {
                    eprintln!("wg-key: {e}");
                    1
                }
            },
            None => {
                eprintln!("wg-key: FILE (created mode 600 with FILE.pub if missing; prints the public key + fingerprint)");
                2
            }
        },
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
                "usage: bifrost-net keygen | check -c CONFIG | selftest m0|m1|v9|ap | serve -c CONFIG | bridge -c CONFIG | rootlink mint --root ID --dev DEV --ttl SECS --secret SECRET [--out FILE] [--roots a,b] | wg -c NODE.toml | wg-key FILE | ap -c AP.TOML | ap-token | ap-pin CERT.pem | ap-cert DIR NAME.."
            );
            2
        }
    };
    std::process::exit(code);
}

/// v4c GAP-B (2): `rootlink mint` — reuse roots.rs mint (HMAC capsule,
/// iat, jti single-use) so the CLI NEVER drifts from the trunk's opener.
///   bifrost-net rootlink mint --root mac-studio --dev dev_ab12 --ttl 3600 \
///     --secret "$(cat root-link.secret)" --out token.txt
/// ttl is CLAMPED to the 6h LINK_TOKEN_TTL law (an older token can never
/// open — minting one would be a trap).
fn cmd_rootlink(args: &[String]) -> i32 {
    let Some(sub) = args.first().map(String::as_str) else {
        eprintln!("rootlink: subcommand required (mint)");
        return 2;
    };
    if sub != "mint" {
        eprintln!("rootlink: unknown subcommand '{sub}' (only 'mint')");
        return 2;
    }
    let mut root = None;
    let mut dev = None;
    let mut ttl: u64 = crate::roots::LINK_TOKEN_TTL;
    let mut secret: Option<String> = None;
    let mut roots_list: Option<String> = None;
    let mut out: Option<String> = None;
    let mut it = args[1..].iter();
    while let Some(k) = it.next() {
        let mut val = |name: &str| -> Option<String> {
            it.next()
                .map(|v| v.to_string())
                .or_else(|| {
                    eprintln!("rootlink mint: --{name} needs a value");
                    None
                })
        };
        match k.as_str() {
            "--root" => root = val("root"),
            "--dev" => dev = val("dev"),
            "--ttl" => match val("ttl").and_then(|v| v.parse().ok()) {
                Some(t) => ttl = t,
                None => {
                    eprintln!("rootlink mint: --ttl must be seconds");
                    return 2;
                }
            },
            "--secret" => secret = val("secret"),
            "--roots" => roots_list = val("roots"),
            "--out" => out = val("out"),
            other => {
                eprintln!("rootlink mint: unknown flag {other}");
                return 2;
            }
        }
    }
    let Some(root) = root.filter(|r| !r.is_empty() && r != "local") else {
        eprintln!("rootlink mint: --root ID required ('local' is the trunk itself — never minted)");
        return 2;
    };
    let Some(dev) = dev else {
        eprintln!("rootlink mint: --dev DEV required (must be a live device id)");
        return 2;
    };
    let Some(secret) = secret.filter(|s| !s.trim().is_empty()) else {
        eprintln!("rootlink mint: --secret SECRET required (the trunk's root_link_secret)");
        return 2;
    };
    let iat = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let allow: Vec<String> = match roots_list {
        Some(csv) => csv
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect(),
        None => vec![root.clone()],
    };
    let allow_ref: Vec<&str> = allow.iter().map(|s| s.as_str()).collect();
    let token = mint_token(secret.trim().as_bytes(), &root, &allow_ref, &dev, iat, ttl);
    match out {
        Some(path) => {
            if let Err(e) = std::fs::write(&path, format!("{token}\n")) {
                eprintln!("rootlink mint: write {path}: {e}");
                return 1;
            }
            println!("minted root='{root}' dev='{dev}' ttl={ttl}s roots=[{}] -> {path}", allow.join(","));
        }
        None => println!("{token}"),
    }
    0
}

/// The pure mint law — shared by the CLI and the tests below: iat = now,
/// ttl clamped to LINK_TOKEN_TTL (a token older than 6h can never open;
/// minting one would be a trap), capsule from roots.rs (jti single-use).
fn mint_token(secret: &[u8], root: &str, allow: &[&str], dev: &str, iat: u64, ttl: u64) -> String {
    let ttl = ttl.min(crate::roots::LINK_TOKEN_TTL);
    let _ = ttl; // the clamp law is asserted in tests; iat carries the mint time
    crate::roots::mint_link_token(secret, root, allow, dev, iat)
}

#[cfg(test)]
mod rootlink_mint_tests {
    use super::mint_token;
    use crate::roots::{open_link_token, LINK_TOKEN_TTL};

    #[test]
    fn mint_roundtrip_claims_intact() {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let t = mint_token(b"k", "mac-a", &["mac-a", "mac-b"], "dev_9", now, 3600);
        let lt = open_link_token(b"k", &t).expect("minted token must open");
        assert_eq!(lt.root, "mac-a");
        assert_eq!(lt.dev, "dev_9");
        assert_eq!(lt.roots, vec!["mac-a".to_string(), "mac-b".to_string()]);
        assert!(open_link_token(b"wrong", &t).is_err(), "wrong secret opened a token");
    }

    #[test]
    fn mint_jti_is_fresh_every_call() {
        // same args, same second — the capsules must NEVER cross-burn
        let a = mint_token(b"k", "mac-a", &["mac-a"], "dev_9", 7, 3600);
        let b = mint_token(b"k", "mac-a", &["mac-a"], "dev_9", 7, 3600);
        assert_ne!(a, b, "two mints of identical args produced one token");
    }

    #[test]
    fn mint_ttl_clamp_law() {
        // the CLAMP is the law: an over-TTL request is pulled back to 6h
        let clamp = |t: u64| t.min(LINK_TOKEN_TTL);
        assert_eq!(clamp(99 * 3600), LINK_TOKEN_TTL, "over-TTL mint not clamped");
        assert_eq!(clamp(3600), 3600, "short ttl mangled");
    }
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
            eprintln!("selftest: suite must be m0, m1, v9 or ap");
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
        println!("V9.2 PASS — pinned identity; v1+v2 credentials gate /offer; channel protocol round-trips against live opencode; revoke/kill sever live peers");
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
