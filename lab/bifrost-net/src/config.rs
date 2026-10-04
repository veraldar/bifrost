//! bifrost-net configuration — explicit, never auto-detected.
//!
//! The livekit.yaml scar (deploy/livekit.yaml): the incumbent auto-detected
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
}

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
}

fn default_opencode_url() -> String { "http://127.0.0.1:4096".into() }
fn default_speaches_url() -> String { "http://127.0.0.1:8000/v1".into() }
fn default_stt_model() -> String { "speaches-ai/whisper-large-v3-turbo".into() }
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
                for c in &w.candidates {
                    let _: IpAddr = c
                        .parse()
                        .map_err(|e| format!("webrtc.candidates: '{c}': {e}"))?;
                }
                lines.push(format!(
                    "webrtc: {} candidate(s) pinned: {}",
                    w.candidates.len(),
                    w.candidates.join(", ")
                ));
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
        }

        if self.mesh.is_none() && self.webrtc.is_none() && self.bridge.is_none() {
            return Err("config enables nothing: add [mesh], [webrtc] and/or [bridge]".into());
        }

        Ok(lines)
    }
}
