//! `bridge` subcommand: run the v0.9 bridge from a config file.

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
        root_link_result_secs: cfg.root_link.as_ref().map(|rl| rl.result_secs).unwrap_or(20),
        // v0.9 pairing identity: /identity publishes the persisted DTLS fingerprint
        name: loaded.config.node.name.clone(),
        dtls_cert_file: cfg.dtls_cert_file.clone().map(Into::into),
        public_url: cfg.public_url.clone(),
    })?;

    println!(
        "  bridge: signaling http://{} (POST /offer, Bearer required) + media udp {} — LIVE",
        handle.http, handle.media
    );
    println!(
        "  bridge: opencode {} | speaches {} | tokens {}",
        cfg.opencode_url, cfg.speaches_url, cfg.tokens_file
    );
    println!("  bridge: identity {} (GET /identity → the pairing QR pins it)", handle.fingerprint);
    match handle.root_link_port {
        Some(p) => println!("  bridge: root-link dial-in ws on port {p} (link-token first frame)"),
        None => println!("  bridge: root-link dial-in off"),
    }
    println!(
        "  bridge: switchboard — http://{}/_root/<root>/<path> (loopback) reaches a linked root's brain; `local` = {}",
        handle.http, cfg.opencode_url
    );
    if let Some(apc) = loaded.config.ap.as_ref() {
        println!("  bridge: access point {} → browsers served from {} (dial-out, pinned)", apc.url, apc.upstream);
        // a remote root dials wss://<ap>/rootlink: that stream goes to the
        // root-link listener (an unspecified bind is reached on loopback)
        let rootlink = match apc.rootlink.as_deref() {
            Some("off") => None,
            Some(t) => Some(t.to_string()),
            None => handle.root_link_addr.map(|a| {
                let ip = if a.ip().is_unspecified() {
                    if a.is_ipv4() { std::net::IpAddr::from([127, 0, 0, 1]) } else { std::net::Ipv6Addr::LOCALHOST.into() }
                } else {
                    a.ip()
                };
                std::net::SocketAddr::new(ip, a.port()).to_string()
            }),
        };
        match &rootlink {
            Some(t) => println!("  bridge: access point /rootlink → root-link {t} (link-token auth, no device gate)"),
            None => println!("  bridge: access point /rootlink not routed (root-link off)"),
        }
        // a paired phone names a root over HTTPS: POST /branch reaches this
        // bridge's own listener (device token checked in the phone's region)
        let own = handle.http;
        let branch = std::net::SocketAddr::new(
            if own.ip().is_unspecified() {
                if own.is_ipv4() { std::net::IpAddr::from([127, 0, 0, 1]) } else { std::net::Ipv6Addr::LOCALHOST.into() }
            } else {
                own.ip()
            },
            own.port(),
        )
        .to_string();
        println!("  bridge: access point /branch → {branch} (device token, the phone's region)");
        crate::ap::spawn_dialer(crate::ap::DialConfig {
            url: apc.url.clone(),
            pin: apc.pin.clone(),
            token: apc.token.clone(),
            upstream: apc.upstream.clone(),
            livekit: apc.livekit.clone(),
            tcp: apc.tcp.clone(),
            rootlink,
            branch: Some(branch),
            tokens: std::sync::Arc::new(crate::tokens::TokenStore::open(cfg.tokens_file.clone())),
        });
    }
    println!("bifrost-net bridge serving — Ctrl-C to stop");

    loop {
        std::thread::sleep(Duration::from_secs(3600));
    }
}
