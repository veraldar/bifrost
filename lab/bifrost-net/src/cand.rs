//! v2c candidate hygiene — the vps-trunk v2b scar.
//!
//! v2b media plane went RED two ways at once: the trunk's SDP advertised
//! stale 127.0.0.1:8239 alongside the public candidate, and ICE checks
//! targeted 100.104.229.17 — a tailscale CGNAT address learned from session
//! state (trickle/SDP-embedded candidates of a previous topology). Neither
//! address can ever carry media from outside. Law (owner [RUN] vps-trunk-v2c):
//!
//! 1. NEVER offer loopback (127/8, ::1), CGNAT (100.64/10), link-local
//!    (169.254/16, fe80::/10) or unspecified (0.0.0.0/::) as ICE candidates —
//!    filtered at emission, before any SDP is written.
//! 2. Stored peer transport addresses in those classes are purged on
//!    ingestion (trickle array AND offer SDP). For the actual media path the
//!    relay uses the address each packet really arrives from: str0m/is creates
//!    a peer-reflexive remote candidate from the source of the first valid
//!    STUN binding request (is-0.11.1 agent.rs, handle_stun_request), so the
//!   learned address IS the packet source — no stale state involved.
//!
//! Config may still list junk (deploy templates carry "127.0.0.1" for dev) —
//! emission is the choke point, and `check()` warns loudly.

use std::net::{IpAddr, Ipv4Addr, SocketAddr};

/// Is this IP in a class that must never be advertised or trusted from state?
pub fn forbidden(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            v4.is_loopback() || v4.is_link_local() || v4.is_unspecified() || cgnat_v4(v4)
        }
        IpAddr::V6(v6) => {
            v6.is_loopback() || v6.is_unspecified() || v6.is_unicast_link_local()
        }
    }
}

/// 100.64.0.0/10 — RFC 6598 CGNAT (tailscale's range). Unroutable from
/// outside the tailnet; the v2b RED checks burned 15s of ICE on exactly this.
fn cgnat_v4(v4: Ipv4Addr) -> bool {
    let o = v4.octets();
    o[0] == 100 && (o[1] & 0b1100_0000) == 0b0100_0000
}

/// Filter a configured candidate list for EMISSION. Returns the usable list
/// (public/first pinned first — str0m nominates the highest-priority pair,
/// so the reachable path must lead) plus everything dropped, for logging.
/// If EVERY candidate is forbidden we keep loopback: that is dev/selftest
/// mode (same-host clients), and str0m needs at least one local candidate
/// for STUN destination matching — an empty answer SDP is a worse failure.
pub fn filter_advertised(ips: &[IpAddr]) -> (Vec<IpAddr>, Vec<IpAddr>) {
    let mut ok: Vec<IpAddr> = ips.iter().filter(|ip| !forbidden(**ip)).copied().collect();
    let dropped: Vec<IpAddr> = ips.iter().filter(|ip| forbidden(**ip)).copied().collect();
    if ok.is_empty() {
        ok.push(IpAddr::from([127, 0, 0, 1]));
    }
    (ok, dropped)
}

/// Gate one remembered peer transport address, whatever its container:
/// a trickle/SDP `a=candidate:` line, or any future persisted session
/// state. Malformed lines pass through (str0m's parser rejects them
/// anyway); anything carrying a forbidden IP is dropped — that remembered
/// address is stale state. Packet SOURCE addresses are never run through
/// this: learn-from-source is the whole point (str0m/is creates a
/// peer-reflexive remote candidate from the first valid STUN request's
/// source), this gates only remembered/advertised addresses.
pub fn usable_candidate_line(line: &str) -> bool {
    line.split_whitespace()
        .find_map(|t| t.parse::<IpAddr>().ok())
        .map(forbidden)
        .map(|bad| !bad)
        .unwrap_or(true)
}

/// Drop `a=candidate:` lines carrying a forbidden IP from an SDP string
/// (non-trickle offers embed candidates). Everything else stays byte-identical.
/// Returns (sdp, lines_dropped).
pub fn strip_forbidden_sdp_lines(sdp: &str) -> (String, usize) {
    let mut dropped = 0usize;
    let kept: Vec<&str> = sdp
        .lines()
        .filter(|line| {
            let is_cand = line.trim_start().starts_with("a=candidate:");
            if !is_cand {
                return true;
            }
            // candidate:<foundation> <comp> <proto> <prio> <IP> <port> typ ...
            // the IP is the first whitespace token that parses as one
            let bad = line
                .split_whitespace()
                .find_map(|t| t.parse::<IpAddr>().ok())
                .map(forbidden)
                .unwrap_or(false);
            if bad {
                dropped += 1;
            }
            !bad
        })
        .collect();
    let mut out = kept.join("\n");
    if sdp.ends_with('\n') {
        out.push('\n');
    }
    (out, dropped)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    #[test]
    fn forbidden_classes() {
        for s in ["127.0.0.1", "127.8.8.8", "::1", "0.0.0.0", "::"] {
            assert!(forbidden(ip(s)), "{s} must be forbidden");
        }
        // CGNAT /10: 100.64.0.0 – 100.127.255.255
        for s in ["100.64.0.1", "100.104.229.17", "100.127.255.255"] {
            assert!(forbidden(ip(s)), "{s} must be forbidden (CGNAT)");
        }
        // just outside /10
        assert!(!forbidden(ip("100.128.0.1")));
        assert!(!forbidden(ip("100.63.255.255")));
        // link-local
        assert!(forbidden(ip("169.254.1.1")));
        assert!(forbidden(ip("fe80::1")));
        // real addresses pass
        assert!(!forbidden(ip("179.237.67.146")));
        assert!(!forbidden(ip("192.168.1.89"))); // RFC1918 is NOT forbidden
        assert!(!forbidden(ip("2620:fe::fe")));
    }

    #[test]
    fn filter_keeps_public_first() {
        let (ok, dropped) = filter_advertised(&[ip("127.0.0.1"), ip("179.237.67.146")]);
        assert_eq!(ok, vec![ip("179.237.67.146")]);
        assert_eq!(dropped, vec![ip("127.0.0.1")]);
    }

    #[test]
    fn filter_dev_fallback_keeps_loopback() {
        let (ok, dropped) = filter_advertised(&[ip("127.0.0.1")]);
        assert_eq!(ok, vec![ip("127.0.0.1")]); // dev/selftest mode
        assert_eq!(dropped.len(), 1);
    }

    #[test]
    fn sdp_strip_drops_only_forbidden() {
        let sdp = "v=0\no=- 1 1 IN IP4 127.0.0.1\n\
                   a=candidate:842163049 1 udp 1677729535 192.168.1.89 52147 typ host\n\
                   a=candidate:842163049 1 udp 1677729535 127.0.0.1 8239 typ host\n\
                   a=candidate:842163049 1 udp 1677729535 100.104.229.17 42311 typ host\n";
        let (out, n) = strip_forbidden_sdp_lines(sdp);
        assert_eq!(n, 2);
        assert!(out.contains("192.168.1.89"));
        assert!(!out.contains("127.0.0.1 8239"));
        assert!(!out.contains("100.104.229.17"));
        assert!(out.starts_with("v=0\no=- 1 1 IN IP4 127.0.0.1\n")); // o= line untouched
    }

    #[test]
    fn candidate_line_gate() {
        assert!(!usable_candidate_line(
            "candidate:842163049 1 udp 1677729535 100.104.229.17 42311 typ host"
        ));
        assert!(!usable_candidate_line(
            "candidate:1 1 udp 1 127.0.0.1 8239 typ host generation 0"
        ));
        assert!(usable_candidate_line(
            "candidate:842163049 1 udp 1677729535 179.237.67.146 8239 typ host"
        ));
        assert!(usable_candidate_line(
            "candidate:1 1 udp 1 192.168.1.89 52147 typ host generation 0"
        )); // RFC1918 fine
        assert!(usable_candidate_line("garbage line")); // malformed → str0m decides
    }
}
