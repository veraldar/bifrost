//! bifrost-net configuration — explicit, never auto-detected.
//!
//! The livekit.yaml scar (trunk/deploy/livekit.yaml): the incumbent auto-detected
//! docker-bridge IPs as ICE candidates and the phone had NO media path until
//! IPs were hand-pinned. Here, advertised candidates are config or nothing —
//! `check` warns loudly when they are missing.

use std::net::{IpAddr, SocketAddr, TcpListener, UdpSocket};

use serde::Deserialize;

use crate::keys;

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub node: NodeConfig,
    #[serde(default)]
    pub mesh: Option<MeshConfig>,
    #[serde(default)]
    pub webrtc: Option<WebRtcConfig>,
    #[serde(default)]
    pub bridge: Option<BridgeConfigSection>,
    /// dial OUT to an access point (bifrost-net ap) and serve browsers through it
    #[serde(default)]
    pub ap: Option<ApDialSection>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ApDialSection {
    /// the access point's bridge channel, e.g. "wss://ap.example.org/ap"
    pub url: String,
    /// the ap's identity: "sha-256 AA:BB:…" of its TLS public key (SPKI) —
    /// `bifrost-net ap-pin CERT.pem` prints it; survives renewals with --reuse-key
    pub pin: String,
    /// pairing-scoped credential the ap admits (its sha-256 sits in ap.toml)
    pub token: String,
    /// the local PWA browsers are served from
    #[serde(default = "default_ap_upstream")]
    pub upstream: String,
    /// LiveKit signaling: /rtc goes here when set (the voice path's websocket)
    #[serde(default)]
    pub livekit: Option<String>,
    /// raw TCP forwards the ap may name → local target, e.g. { livekit-ice = "127.0.0.1:7881" }
    #[serde(default)]
    pub tcp: std::collections::HashMap<String, String>,
    /// where a `/rootlink` stream from the ap goes (a remote root dialing
    /// wss://<ap>/rootlink): default = this bridge's root-link listener;
    /// "off" = /rootlink is not routed (it falls through to the app upstream)
    #[serde(default)]
    pub rootlink: Option<String>,
}

fn default_ap_upstream() -> String { "127.0.0.1:8090".into() }

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BridgeConfigSection {
    /// HTTP listen (signaling: POST /offer with Bearer device token)
    pub http: String,
    /// UDP bind for WebRTC media
    pub media: String,
    /// device tokens file (PWA mints, bridge verifies) — S1 seam
    pub tokens_file: String,
    #[serde(default = "default_opencode_url")]
    pub opencode_url: String,
    #[serde(default = "default_speaches_url")]
    pub speaches_url: String,
    #[serde(default = "default_stt_model")]
    pub stt_model: String,
    #[serde(default = "default_tts_model")]
    pub tts_model: String,
    #[serde(default = "default_tts_voice")]
    pub tts_voice: String,
    #[serde(default)]
    pub candidates: Vec<String>,
    /// v4 root-link: HMAC secret for link-tokens (absent = protocol
    /// DISABLED — fail closed; no secret, no dial-in).
    #[serde(default)]
    pub root_link_secret: Option<String>,
    /// v4: optional [bridge.root-link] dial-in plane config (absent or
    /// enabled=false = OFF — fail closed).
    #[serde(default, rename = "root-link")]
    pub root_link: Option<RootLinkConfig>,
    /// v4: root ids this trunk accepts ([roots] table + "local" implicit)
    #[serde(default)]
    pub root_ids: Vec<String>,
    /// v4 demo: [roots] table — local (opencode url) + remote entries.
    /// Remote entries carry NO endpoint: link-token dial-in only.
    #[serde(default)]
    pub roots: Vec<RootEntry>,
    /// persisted DTLS identity — its fingerprint is what the pairing QR pins.
    /// Unset = a fresh identity per run (every paired phone must re-scan).
    #[serde(default)]
    pub dtls_cert_file: Option<String>,
    /// the signaling URL phones dial (e.g. "http://192.168.1.10:7890")
    #[serde(default)]
    pub public_url: Option<String>,
}

/// v4 [bridge.root-link] — the root dial-in ws plane (rootlink.rs).
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RootLinkConfig {
    /// dial-in is OFF unless explicitly true (fail closed)
    #[serde(default)]
    pub enabled: bool,
    /// ws listen for root dial-in (default: bridge http port + 1)
    #[serde(default)]
    pub listen: Option<String>,
    /// trunk ping interval (secs); a conn is reaped after 2 missed pongs
    #[serde(default = "default_root_ping_secs")]
    pub ping_secs: u64,
    /// v4c GAP-A: per-root in-flight cap (default 1; 0 = unlimited). A root
    /// AT its cap gets an immediate 429-style error — never a queued slot.
    #[serde(default = "default_max_inflight")]
    pub max_inflight: u64,
    /// how long a branch turn waits for the root's `root.result` (secs) —
    /// a turn on a real brain can take minutes; default 20
    #[serde(default = "default_result_secs")]
    pub result_secs: u64,
}

fn default_result_secs() -> u64 {
    20
}

fn default_root_ping_secs() -> u64 {
    15
}

fn default_max_inflight() -> u64 {
    1
}

/// v4 [roots] table entry. `local` names the trunk's own opencode; every
/// other entry is a REMOTE root identified only by its link-token.
#[derive(Debug, Clone, Deserialize)]
pub struct RootEntry {
    pub name: String,
    /// "local" (trunk's own opencode) — remote roots omit any endpoint
    pub kind: String,
    #[serde(default)]
    pub opencode_url: Option<String>,
}

fn default_opencode_url() -> String { "http://127.0.0.1:4096".into() }
fn default_speaches_url() -> String { "http://127.0.0.1:8000/v1".into() }
fn default_stt_model() -> String { "Systran/faster-whisper-small".into() }
fn default_tts_model() -> String { "speaches-ai/Kokoro-82M-v1.0-ONNX".into() }
fn default_tts_voice() -> String { "af_heart".into() }

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NodeConfig {
    pub name: String,
    /// base64 x25519 private key (`bifrost-net keygen` prints one)
    pub private_key: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MeshConfig {
    /// UDP listen address for WireGuard traffic
    pub listen: String,
    /// this node's own virtual IP, e.g. "10.7.0.1/24"
    pub address: String,
    #[serde(default)]
    pub peers: Vec<PeerConfig>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PeerConfig {
    pub name: String,
    /// base64 x25519 public key of the peer
    pub public_key: String,
    /// optional — dial this peer (responder nodes may omit it)
    pub endpoint: Option<String>,
    /// virtual IPs this peer owns, e.g. "10.7.0.2/32"
    pub allowed_ips: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WebRtcConfig {
    /// TCP listen address for SDP signaling (POST /offer)
    pub signaling: String,
    /// UDP bind address for WebRTC media
    pub media: String,
    /// IPs to advertise as ICE candidates. EMPTY = loopback-only dev mode.
    /// Never auto-detect — see the livekit.yaml scar.
    #[serde(default)]
    pub candidates: Vec<String>,
}

pub struct LoadedConfig {
    pub path: String,
    pub config: Config,
    pub secret: boringtun::x25519::StaticSecret,
}

pub fn load(path: &str) -> Result<LoadedConfig, String> {
    let raw = std::fs::read_to_string(path)
        .map_err(|e| format!("cannot read config {path}: {e}"))?;
    let config: Config =
        toml::from_str(&raw).map_err(|e| format!("config {path} invalid: {e}"))?;
    let secret = keys::decode_secret(&config.node.private_key)
        .map_err(|e| format!("node.private_key: {e}"))?;
    Ok(LoadedConfig {
        path: path.to_string(),
        config,
        secret,
    })
}

impl Config {
    /// Validate + return human-readable check report (one line per finding).
    pub fn check(&self) -> Result<Vec<String>, String> {
        let mut lines = vec![];

        if self.node.name.trim().is_empty() {
            return Err("node.name must not be empty".into());
        }
        lines.push(format!("node: '{}' — key ok (32-byte x25519)", self.node.name));

        let mut virtual_ips: Vec<String> = vec![];
        if let Some(mesh) = &self.mesh {
            let my_cidr = crate::mesh::parse_cidr(&mesh.address)
                .map_err(|e| format!("mesh.address: {e}"))?;
            let _ = my_cidr;
            let listen: SocketAddr = mesh
                .listen
                .parse()
                .map_err(|e| format!("mesh.listen: {e}"))?;
            // bind-and-drop proves the port is actually free/usable
            let _probe = UdpSocket::bind(listen).map_err(|e| format!("mesh.listen {listen}: {e}"))?;
            lines.push(format!("mesh: listen {listen} bindable, {} peer(s)", mesh.peers.len()));
            for p in &mesh.peers {
                keys::decode_public(&p.public_key)
                    .map_err(|e| format!("mesh.peers[{}].public_key: {e}", p.name))?;
                if let Some(ep) = &p.endpoint {
                    let _: SocketAddr = ep
                        .parse()
                        .map_err(|e| format!("mesh.peers[{}].endpoint: {e}", p.name))?;
                }
                if p.allowed_ips.is_empty() {
                    return Err(format!("mesh.peers[{}]: allowed_ips empty", p.name));
                }
                for cidr in &p.allowed_ips {
                    let (ip, _len) = crate::mesh::parse_cidr(cidr)
                        .map_err(|e| format!("mesh.peers[{}]: {e}", p.name))?;
                    if Some(ip) == Some(my_cidr.0) {
                        return Err(format!(
                            "mesh.peers[{}]: allowed_ip '{cidr}' collides with this node's own address {}",
                            p.name, mesh.address
                        ));
                    }
                    virtual_ips.push(ip.to_string());
                }
            }
            lines.push(format!(
                "mesh: peer keys ok, virtual net {}",
                virtual_ips.join(", ")
            ));
        }

        if let Some(w) = &self.webrtc {
            let sig: SocketAddr = w
                .signaling
                .parse()
                .map_err(|e| format!("webrtc.signaling: {e}"))?;
            let _probe = TcpListener::bind(sig)
                .map_err(|e| format!("webrtc.signaling {sig}: {e}"))?;
            let media: SocketAddr = w
                .media
                .parse()
                .map_err(|e| format!("webrtc.media: {e}"))?;
            let _probe = UdpSocket::bind(media).map_err(|e| format!("webrtc.media {media}: {e}"))?;
            lines.push(format!(
                "webrtc: signaling {sig} + media {media} bindable"
            ));
            if w.candidates.is_empty() {
                lines.push(
                    "webrtc: WARNING no candidates pinned — loopback-only mode \
                     (clients outside this host CANNOT get media). The livekit \
                     scar: auto-detect lies; pin the IPs peers actually reach."
                        .to_string(),
                );
            } else {
                let mut junk: Vec<String> = vec![];
                for c in &w.candidates {
                    let ip: IpAddr = c
                        .parse()
                        .map_err(|e| format!("webrtc.candidates: '{c}': {e}"))?;
                    // v2c candidate hygiene: these classes never carry media
                    // from outside; emission filters them, check() says why
                    if crate::cand::forbidden(ip) {
                        junk.push(c.clone());
                    }
                }
                if junk.is_empty() {
                    lines.push(format!(
                        "webrtc: {} candidate(s) pinned: {}",
                        w.candidates.len(),
                        w.candidates.join(", ")
                    ));
                } else {
                    lines.push(format!(
                        "webrtc: WARNING candidate(s) [{}] will NOT be advertised (loopback/CGNAT/link-local — the v2b scar: dead pairs race the public one); emission keeps only: {}",
                        junk.join(", "),
                        w.candidates.iter().filter(|c| !junk.contains(c)).cloned().collect::<Vec<_>>().join(", ")
                    ));
                }
            }
        }

        if let Some(b) = &self.bridge {
            let http: SocketAddr = b
                .http
                .parse()
                .map_err(|e| format!("bridge.http: {e}"))?;
            let _probe = TcpListener::bind(http).map_err(|e| format!("bridge.http {http}: {e}"))?;
            let media: SocketAddr = b
                .media
                .parse()
                .map_err(|e| format!("bridge.media: {e}"))?;
            let _probe = UdpSocket::bind(media).map_err(|e| format!("bridge.media {media}: {e}"))?;
            let tokens_ok = std::path::Path::new(&b.tokens_file).exists();
            lines.push(format!(
                "bridge: http {http} + media {media} bindable, tokens {}",
                if tokens_ok { "file present" } else { "FILE MISSING (all /offer 401 until the PWA pairs a device)" }
            ));
            if !tokens_ok {
                lines.push("bridge: WARNING tokens file missing — run the PWA /pair first".to_string());
            }
            if b.candidates.is_empty() {
                lines.push("bridge: WARNING no candidates pinned — loopback-only mode".to_string());
            }
            match &b.dtls_cert_file {
                Some(p) => lines.push(format!("bridge: DTLS identity persisted at {p} (GET /identity → the pairing QR pins it)")),
                None => lines.push(
                    "bridge: WARNING no dtls_cert_file — a fresh DTLS identity per run (every paired phone must re-scan)"
                        .to_string(),
                ),
            }
            if let Some(u) = &b.public_url {
                lines.push(format!("bridge: phones dial {u}"));
            }
            let rl_on = b.root_link.as_ref().is_some_and(|r| r.enabled);
            let rl_secret = b.root_link_secret.as_deref().is_some_and(|s| !s.trim().is_empty());
            lines.push(match (rl_on, rl_secret) {
                (true, true) => format!(
                    "bridge: root-link dial-in ON (ws {})",
                    b.root_link
                        .as_ref()
                        .and_then(|r| r.listen.clone())
                        .unwrap_or_else(|| format!("127.0.0.1:{}", http.port() + 1))
                ),
                (true, false) => "bridge: WARNING [bridge.root-link] enabled but root_link_secret is empty — dial-in stays OFF".to_string(),
                _ => "bridge: root-link dial-in off".to_string(),
            });
        }

        if let Some(a) = &self.ap {
            if self.bridge.is_none() {
                return Err("[ap] dials out FOR the bridge — it needs a [bridge] section".into());
            }
            lines.push(format!("ap: dial-out to {} (pinned), browsers served from {}", a.url, a.upstream));
        }

        if self.mesh.is_none() && self.webrtc.is_none() && self.bridge.is_none() {
            return Err("config enables nothing: add [mesh], [webrtc] and/or [bridge]".into());
        }

        Ok(lines)
    }
}

#[cfg(test)]
mod tests {
    use super::Config;

    /// root/install/install.sh writes exactly this shape (values aside) —
    /// every field it emits must parse (deny_unknown_fields stays on).
    #[test]
    fn installer_bridge_toml_parses() {
        let toml = r#"
[node]
name = "host"
private_key = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="

[bridge]
http = "0.0.0.0:7890"
media = "192.168.1.10:7891"
tokens_file = "/var/lib/bifrost/devices.json"
candidates = ["192.168.1.10"]
dtls_cert_file = "/var/lib/bifrost/bridge-dtls.json"
public_url = "http://192.168.1.10:7890"
"#;
        let c: Config = toml::from_str(toml).expect("installer bridge.toml must parse");
        let b = c.bridge.unwrap();
        assert_eq!(b.dtls_cert_file.as_deref(), Some("/var/lib/bifrost/bridge-dtls.json"));
        assert_eq!(b.public_url.as_deref(), Some("http://192.168.1.10:7890"));
    }

    /// both lines at once: root-link plane + pairing identity + [ap] dial-out
    /// (the section deploy-vps.sh writes) in one bridge.toml
    #[test]
    fn merged_bridge_toml_parses() {
        let toml = r#"
[node]
name = "host"
private_key = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="

[bridge]
http = "127.0.0.1:7890"
media = "127.0.0.1:7891"
tokens_file = "devices.json"
root_link_secret = "s"
dtls_cert_file = "dtls.json"
public_url = "http://127.0.0.1:7890"

[bridge.root-link]
enabled = true
ping_secs = 3
max_inflight = 1
result_secs = 300

[ap]
url = "wss://ap.example.org/ap"
pin = "sha-256 AA:BB"
token = "00"
upstream = "127.0.0.1:8090"
tcp = { livekit-ice = "127.0.0.1:7881" }
rootlink = "127.0.0.1:7892"
"#;
        let c: Config = toml::from_str(toml).expect("merged bridge.toml must parse");
        assert!(c.bridge.as_ref().unwrap().root_link.as_ref().unwrap().enabled);
        assert_eq!(c.bridge.as_ref().unwrap().root_link.as_ref().unwrap().result_secs, 300);
        assert_eq!(c.ap.as_ref().unwrap().rootlink.as_deref(), Some("127.0.0.1:7892"));
        assert_eq!(c.ap.unwrap().tcp.get("livekit-ice").map(String::as_str), Some("127.0.0.1:7881"));
    }

    #[test]
    fn unknown_bridge_field_still_rejected() {
        let toml = "[node]\nname = \"h\"\nprivate_key = \"k\"\n[bridge]\nhttp = \"a\"\nmedia = \"b\"\ntokens_file = \"c\"\nbogus = 1\n";
        assert!(toml::from_str::<Config>(toml).is_err());
    }
}
