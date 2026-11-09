//! `bridge` subcommand: run the v0.9 bridge from a config file.

use std::net::{SocketAddr, TcpListener, UdpSocket};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use crate::bridge::{self, BridgeConfig};
use crate::config;

pub fn run(path: &str) -> Result<(), String> {
    // str0m speaks tracing; surface ICE/DTLS state changes in the log
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("str0m=info,is=info,warn")),
        )
        .with_writer(std::io::stderr)
        .try_init();
    let loaded = config::load(path)?;
    println!("bifrost-net bridge '{}' (config: {})", loaded.config.node.name, loaded.path);
    let cfg = loaded
        .config
        .bridge
        .as_ref()
        .ok_or("config has no [bridge] section")?
        .clone();

    let candidates: Vec<_> = cfg.candidates.iter().filter_map(|c| c.parse().ok()).collect();
    let handle = bridge::start(BridgeConfig {
        http: cfg
            .http
            .parse()
            .map_err(|e| format!("bridge.http: {e}"))?,
        media: cfg
            .media
            .parse()
            .map_err(|e| format!("bridge.media: {e}"))?,
        tokens_file: cfg.tokens_file.clone().into(),
        opencode_url: cfg.opencode_url.clone(),
        speaches_url: cfg.speaches_url.clone(),
        stt_model: cfg.stt_model.clone(),
        tts_model: cfg.tts_model.clone(),
        tts_voice: cfg.tts_voice.clone(),
        candidates,
        // v4 root-link: [bridge.root-link] + root_link_secret (fail closed)
        root_link_secret: cfg.root_link_secret.as_ref().map(|s| s.as_bytes().to_vec()),
        root_ids: cfg.root_ids.clone(),
        root_link_enabled: cfg.root_link.as_ref().map(|rl| rl.enabled).unwrap_or(false),
        root_link_listen: cfg.root_link.as_ref().and_then(|rl| rl.listen.clone()),
        root_link_ping_secs: cfg.root_link.as_ref().map(|rl| rl.ping_secs).unwrap_or(15),
        root_link_max_inflight: cfg.root_link.as_ref().map(|rl| rl.max_inflight).unwrap_or(1),
    })?;

    println!(
        "  bridge: signaling http://{} (POST /offer, Bearer required) + media udp {} — LIVE",
        handle.http, handle.media
    );
    println!(
        "  bridge: opencode {} | speaches {} | tokens {}",
        cfg.opencode_url, cfg.speaches_url, cfg.tokens_file
    );
    println!("bifrost-net bridge serving — Ctrl-C to stop");

    let stop = Arc::new(AtomicBool::new(false));
    let _ = stop;
    loop {
        std::thread::sleep(Duration::from_secs(3600));
    }
}
