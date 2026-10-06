//! The world — spawns the REAL stack under test as child processes:
//! the real `yggdrasil` binary (own port + own data dir, pointed at the
//! deterministic mock upstream) and, when asked, the real `bifrost-net
//! bridge` binary (own token file, pointed at that yggdrasil).
//!
//! Nothing here touches the live production services (:4096 opencode,
//! :4100 live yggdrasil) — the sim world is fully hermetic on ephemeral
//! 127.0.0.1 ports with a temp data dir, wiped on drop.

use std::net::{SocketAddr, TcpListener, UdpSocket};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use sha2::{Digest, Sha256};

use crate::mockup::MockUpstream;
use crate::rng::Rng;

pub struct WorldOpts {
    /// force YGG_ROLLUP_TOKENS (marathon scenarios set this low)
    pub rollup_tokens: Option<usize>,
    pub with_bridge: bool,
    /// speaches base URL for the bridge's voice pipeline (real TTS/STT)
    pub speaches_url: String,
    /// YGG_UPSTREAM_STYLE: "openai" (default) or "anthropic" (the dialect scenarios)
    pub upstream_style: Option<String>,
}

impl Default for WorldOpts {
    fn default() -> Self {
        WorldOpts {
            rollup_tokens: None,
            with_bridge: false,
            speaches_url: "http://127.0.0.1:8000/v1".into(),
            upstream_style: None,
        }
    }
}

pub struct BridgeInfo {
    /// signaling (POST /offer, Bearer required)
    pub http: SocketAddr,
    /// WebRTC media UDP — the address the wire forwards to
    pub media: SocketAddr,
    /// raw device token (the sim is the paired device)
    pub token: String,
    /// the tokens file — revocation scenarios rewrite it (the bridge re-reads
    /// it mtime-aware within ~1s, that's the S1 contract)
    pub tokens_file: PathBuf,
}

pub struct World {
    pub tmp: PathBuf,
    /// the deterministic upstream — scenarios drive failure injection through it
    #[allow(dead_code)]
    pub mock: MockUpstream,
    pub ygg: SocketAddr,
    pub bridge: Option<BridgeInfo>,
    ygg_child: Child,
    bridge_child: Option<Child>,
}

pub fn ygg_bin() -> PathBuf {
    std::env::var_os("YGG_SIM_YGG_BIN")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../yggdrasil/target/release/yggdrasil")
        })
}

pub fn bridge_bin() -> PathBuf {
    std::env::var_os("YGG_SIM_BRIDGE_BIN")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../bifrost-net/target/release/bifrost-net")
        })
}

fn free_port() -> Result<u16, String> {
    let s = UdpSocket::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    Ok(s.local_addr().map_err(|e| e.to_string())?.port())
}

fn free_tcp_port() -> Result<u16, String> {
    let l = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    Ok(l.local_addr().map_err(|e| e.to_string())?.port())
}

fn uniq() -> String {
    let n = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("ygg-sim-{:x}", n)
}

impl World {
    pub fn spawn(opts: WorldOpts) -> Result<World, String> {
        let tmp = std::env::temp_dir().join(uniq());
        std::fs::create_dir_all(tmp.join("data")).map_err(|e| e.to_string())?;

        let mock = MockUpstream::start()?;

        let ygg_port = free_tcp_port()?;
        let ygg_addr: SocketAddr = format!("127.0.0.1:{ygg_port}").parse().unwrap();
        let ygg_log = std::fs::File::create(tmp.join("yggdrasil.log")).map_err(|e| e.to_string())?;
        let ygg_err = ygg_log.try_clone().map_err(|e| e.to_string())?;

        let bin = ygg_bin();
        if !bin.exists() {
            return Err(format!(
                "real yggdrasil binary not found at {} — build it: cd lab/yggdrasil && cargo build --release",
                bin.display()
            ));
        }
        let mut cmd = Command::new(&bin);
        cmd.env("YGG_UPSTREAM_BASE_URL", format!("http://{}", mock.addr))
            .env("YGG_UPSTREAM_API_KEY", "sk-ygg-sim")
            .env("YGG_UPSTREAM_MODEL", "sim-1")
            .env("YGG_LISTEN", ygg_addr.to_string())
            .env("YGG_DATA_DIR", tmp.join("data"))
            .current_dir(&tmp)
            .stdout(Stdio::from(ygg_log))
            .stderr(Stdio::from(ygg_err));
        if let Some(rt) = opts.rollup_tokens {
            cmd.env("YGG_ROLLUP_TOKENS", rt.to_string())
                .env("YGG_ROLLUP_KEEP_TOKENS", (rt / 4).to_string());
        }
        if let Some(style) = &opts.upstream_style {
            cmd.env("YGG_UPSTREAM_STYLE", style);
        }
        let mut ygg_child = cmd.spawn().map_err(|e| format!("spawn yggdrasil: {e}"))?;

        // health: GET /session answers
        let ygg_url = format!("http://{ygg_addr}");
        let agent = ureq::AgentBuilder::new().timeout(Duration::from_secs(2)).build();
        let mut up = false;
        for _ in 0..100 {
            if agent.get(&format!("{ygg_url}/session")).call().is_ok() {
                up = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        if !up {
            let _ = ygg_child.kill();
            return Err("real yggdrasil did not come up on its port (see yggdrasil.log in the sim tmpdir)".into());
        }

        let (bridge, bridge_child) = if opts.with_bridge {
            let b = spawn_bridge(&tmp, &mock, &ygg_addr, &opts)?;
            (Some(b.0), Some(b.1))
        } else {
            (None, None)
        };

        Ok(World {
            tmp,
            mock,
            ygg: ygg_addr,
            bridge,
            ygg_child,
            bridge_child,
        })
    }

    pub fn ygg_url(&self) -> String {
        format!("http://{}", self.ygg)
    }
}

impl Drop for World {
    fn drop(&mut self) {
        let _ = self.ygg_child.kill();
        let _ = self.ygg_child.wait();
        if let Some(c) = &mut self.bridge_child {
            let _ = c.kill();
            let _ = c.wait();
        }
        let _ = std::fs::remove_dir_all(&self.tmp);
    }
}

fn spawn_bridge(
    tmp: &Path,
    mock: &MockUpstream,
    ygg: &SocketAddr,
    opts: &WorldOpts,
) -> Result<(BridgeInfo, Child), String> {
    let bin = bridge_bin();
    if !bin.exists() {
        return Err(format!(
            "real bifrost-net binary not found at {} — build it: cd lab/bifrost-net && cargo build --release",
            bin.display()
        ));
    }

    let http_port = free_tcp_port()?;
    let media_port = free_port()?;
    let http_addr: SocketAddr = format!("127.0.0.1:{http_port}").parse().unwrap();
    let media_addr: SocketAddr = format!("127.0.0.1:{media_port}").parse().unwrap();

    // device token — same contract as bifrost-net tokens.rs (sha256 hex of raw)
    let mut key = [0u8; 32];
    Rng::new(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos() as u64,
    )
    .fill_bytes(&mut key);
    let raw = format!(
        "bfsim-{}",
        key.iter().map(|b| format!("{b:02x}")).collect::<String>()
    );
    let hash = {
        let d = Sha256::digest(raw.as_bytes());
        d.iter().map(|b| format!("{b:02x}")).collect::<String>()
    };
    let devices = json_devs(&hash);
    let tokens_path = tmp.join("devices.json");
    std::fs::write(&tokens_path, devices).map_err(|e| e.to_string())?;

    let priv_b64 = base64::engine::general_purpose::STANDARD.encode(key);
    let cfg = format!(
        "[node]\nname = \"ygg-sim-bridge\"\nprivate_key = \"{priv_b64}\"\n\n\
         [bridge]\nhttp = \"127.0.0.1:{http_port}\"\nmedia = \"127.0.0.1:{media_port}\"\n\
         tokens_file = \"{}\"\nopencode_url = \"http://{ygg}\"\n\
         speaches_url = \"{}\"\ncandidates = [\"127.0.0.1\"]\n",
        tokens_path.display(),
        opts.speaches_url.trim_end_matches('/'),
    );
    let cfg_path = tmp.join("bridge.toml");
    std::fs::write(&cfg_path, cfg).map_err(|e| e.to_string())?;

    let out = std::fs::File::create(tmp.join("bridge.log")).map_err(|e| e.to_string())?;
    let err = out.try_clone().map_err(|e| e.to_string())?;
    let child = Command::new(&bin)
        .args(["bridge", "-c"])
        .arg(&cfg_path)
        .stdout(Stdio::from(out))
        .stderr(Stdio::from(err))
        .spawn()
        .map_err(|e| format!("spawn bifrost-net bridge: {e}"))?;

    // health: signaling must answer 401 to a tokenless offer
    let agent = ureq::AgentBuilder::new().timeout(Duration::from_secs(2)).build();
    let mut up = false;
    for _ in 0..50 {
        match agent
            .post(&format!("http://{http_addr}/offer"))
            .send_string("{}")
        {
            Err(ureq::Error::Status(401, _)) => {
                up = true;
                break;
            }
            _ => std::thread::sleep(Duration::from_millis(100)),
        }
    }
    if !up {
        return Err("real bridge signaling did not come up (see bridge.log in the sim tmpdir)".into());
    }
    let _ = mock; // bridge talks to yggdrasil, not the mock directly
    Ok((
        BridgeInfo {
            http: http_addr,
            media: media_addr,
            token: raw,
            tokens_file: tokens_path,
        },
        child,
    ))
}

fn json_devs(hash: &str) -> String {
    // contract check against the PWA's own file (pwa/.devices.json): the
    // bridge's serde rename_all=camelCase means the real key is tokenHash
    serde_json::json!({
        "devices": [{
            "id": "dev_ygg_sim",
            "name": "ygg-sim",
            "tokenHash": hash,
            "created": "sim",
            "revoked": false,
        }]
    })
    .to_string()
}
