//! Network region — mirror of pwa/lib/region.ts (change both or neither).
//! An access token is bound to the region it was issued in; the bridge checks
//! it against the REAL socket address of the signaling request and of the
//! peer's media path, which (unlike HTTP X-Forwarded-For) a client cannot fake.

use std::net::IpAddr;

pub fn region_of(ip: IpAddr) -> String {
    let ip = match ip {
        IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => IpAddr::V4(v4),
            None => IpAddr::V6(v6),
        },
        v4 => v4,
    };
    match ip {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            if o[0] == 127 {
                "loopback".into()
            } else if o[0] == 10 || (o[0] == 172 && (16..=31).contains(&o[1])) || (o[0] == 192 && o[1] == 168) {
                format!("lan:{}.{}.{}.0/24", o[0], o[1], o[2])
            } else if o[0] == 100 && (64..=127).contains(&o[1]) {
                "cgnat:100.64.0.0/10".into()
            } else if o[0] == 169 && o[1] == 254 {
                "link".into()
            } else {
                format!("net:{}.{}.0.0/16", o[0], o[1])
            }
        }
        IpAddr::V6(v6) => {
            let g = v6.segments();
            if v6.is_loopback() {
                "loopback".into()
            } else if g[0] & 0xfe00 == 0xfc00 {
                format!("lan6:{:04x}:{:04x}:{:04x}::/48", g[0], g[1], g[2])
            } else if g[0] & 0xffc0 == 0xfe80 {
                "link".into()
            } else {
                format!("net6:{:04x}:{:04x}::/32", g[0], g[1])
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::region_of;

    #[test]
    fn mirrors_the_pwa_classifier() {
        let r = |s: &str| region_of(s.parse().unwrap());
        assert_eq!(r("127.0.0.1"), "loopback");
        assert_eq!(r("::1"), "loopback");
        assert_eq!(r("::ffff:192.168.1.40"), "lan:192.168.1.0/24");
        assert_eq!(r("172.17.0.3"), "lan:172.17.0.0/24");
        assert_eq!(r("100.101.2.3"), "cgnat:100.64.0.0/10");
        assert_eq!(r("8.8.4.4"), "net:8.8.0.0/16");
        assert_eq!(r("fd12:3456:789a::1"), "lan6:fd12:3456:789a::/48");
        assert_eq!(r("2a01:e0a:1:2::3"), "net6:2a01:0e0a::/32");
    }
}
