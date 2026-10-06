//! `app.*` scenarios — the Android side of bifrost on a real emulator
//! through real adb (see src/app.rs for hosts, the shell and its contracts).
//!
//! - `app.chrome-mic-origin` — Android Chrome itself (no APK): which origins
//!   may open the mic (https :443, https :8443, plain http on a non-loopback
//!   address, http://localhost) — the user's "a port kills the mic" question.
//! - `app.install-pair` / `app.push-notification` / `app.background-audio` /
//!   `app.hot-reload` — the bifrost shell APK (pwa/android) driven live.
//!
//! Missing pieces (no adb, no AVD, no APK, no node) SKIP loudly naming the
//! exact fix — never faked.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use serde_json::Value;

use crate::app::{qenc, AppDriver, PageServer, SHELL_PKG};
use crate::runner::{Metrics, Verdict};

pub fn registry() -> Vec<crate::runner::ScenarioDef> {
    vec![
        crate::runner::ScenarioDef {
            name: "app.chrome-mic-origin",
            device: "android",
            profile: "adb",
            run: chrome_mic_origin,
        },
        crate::runner::ScenarioDef {
            name: "app.install-pair",
            device: "android",
            profile: "adb",
            run: install_pair,
        },
        crate::runner::ScenarioDef {
            name: "app.push-notification",
            device: "android",
            profile: "adb",
            run: push_notification,
        },
        crate::runner::ScenarioDef {
            name: "app.background-audio",
            device: "android",
            profile: "adb",
            run: background_audio,
        },
        crate::runner::ScenarioDef {
            name: "app.hot-reload",
            device: "android",
            profile: "adb",
            run: hot_reload,
        },
    ]
}

/// adb host + booted emulator (the sim boots its own when none is) — the
/// device half of every gate.
fn device() -> Result<AppDriver, Verdict> {
    let (driver, _where) = crate::app::AppDriver::detect().map_err(|e| Verdict::Skip(format!("no adb host: {e}")))?;
    let serial = crate::app::ensure_device(&driver).map_err(Verdict::Skip)?;
    if std::env::var_os("YGG_SIM_DEBUG").is_some() {
        eprintln!("[app] {} {serial}", driver.host.name());
    }
    Ok(AppDriver { host: driver.host, device: serial })
}

/// device + the shell APK installed fresh (cleared data, runtime grants as a
/// user's one-time taps), logcat cleared, screen awake.
fn shell_gate() -> Result<(AppDriver, PathBuf), Verdict> {
    let apk = crate::app::apk_path().ok_or_else(|| Verdict::Skip(crate::app::skip_reason()))?;
    let d = device()?;
    d.install(&apk).map_err(|e| Verdict::Fail(format!("install: {e}")))?;
    let _ = d.shell(&format!("am force-stop {SHELL_PKG}"));
    let _ = d.shell(&format!("pm clear {SHELL_PKG}"));
    for p in ["RECORD_AUDIO", "POST_NOTIFICATIONS"] {
        let _ = d.shell(&format!("pm grant {SHELL_PKG} android.permission.{p}"));
    }
    let _ = d.run(&["logcat", "-c"]);
    wake(&d);
    Ok((d, apk))
}

fn wake(d: &AppDriver) {
    let _ = d.shell("input keyevent KEYCODE_WAKEUP");
    let _ = d.shell("wm dismiss-keyguard");
}

fn pair_link(token: &str, url: &str, bridge: &str) -> String {
    format!("bifrost://pair?token={}&url={}&bridge={}", qenc(token), qenc(url), qenc(bridge))
}

fn finish(d: &AppDriver, ports: &[u16]) {
    let _ = d.shell(&format!("am force-stop {SHELL_PKG}"));
    for p in ports {
        d.reverse_remove(*p);
    }
}

// ---------------------------------------------------------------------------

/// Android Chrome: secure context + getUserMedia per origin, real permission
/// prompt (tapped through uiautomator), virtual mic.
fn chrome_mic_origin() -> (Verdict, Metrics) {
    let mut m = Metrics::new();
    let d = match device() {
        Ok(d) => d,
        Err(v) => return (v, m),
    };
    if std::process::Command::new("node").arg("--version").output().map(|o| !o.status.success()).unwrap_or(true) {
        return (Verdict::Skip("node not on PATH — the CDP probe (android/chrome-mic-origin.mjs) needs Node ≥ 22".into()), m);
    }
    // the tailnet host is discovered at runtime, never written down here
    let host = std::process::Command::new("tailscale")
        .args(["status", "--json"])
        .output()
        .ok()
        .and_then(|o| serde_json::from_slice::<Value>(&o.stdout).ok())
        .and_then(|v| v["Self"]["DNSName"].as_str().map(|s| s.trim_end_matches('.').to_string()))
        .filter(|s| !s.is_empty());
    let Some(host) = host else {
        return (Verdict::Skip("tailnet host not discoverable (tailscale status) — origins A/B (the question) cannot be probed".into()), m);
    };
    let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("android/chrome-mic-origin.mjs");
    let adb = crate::app::adb_binary().unwrap_or_else(|| "adb".into());
    let origins = format!("A=https://{host}/,B=https://{host}:8443/,C=@lan,D=@localhost");
    let t0 = Instant::now();
    let out = std::process::Command::new("node")
        .arg(&script)
        .args(["--adb", &adb.display().to_string(), "--serial", &d.device, "--origins", &origins, "--redact", &host])
        .output();
    let out = match out {
        Ok(o) => o,
        Err(e) => return (Verdict::Fail(format!("probe spawn: {e}")), m),
    };
    let v: Value = match serde_json::from_slice(&out.stdout) {
        Ok(v) => v,
        Err(_) => {
            return (
                Verdict::Fail(format!("probe output unreadable: {}", String::from_utf8_lossy(&out.stderr).lines().last().unwrap_or(""))),
                m,
            )
        }
    };
    // receipts (redacted: <tailnet-host>) — tracked evidence
    let _ = std::fs::write(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("report/chrome-mic-origin.json"),
        serde_json::to_string_pretty(&v).unwrap_or_default(),
    );
    let by = |id: &str| v["results"].as_array().and_then(|a| a.iter().find(|r| r["id"] == id)).cloned().unwrap_or(Value::Null);
    let secure = |r: &Value| r["pre"]["isSecureContext"].as_bool().unwrap_or(false);
    let gum_ok = |r: &Value| r["gum"]["ok"].as_bool().unwrap_or(false);
    let (a, b, c, dd) = (by("A"), by("B"), by("C"), by("D"));
    if a["navError"].is_string() || b["navError"].is_string() || !a["loaded"].as_bool().unwrap_or(false) {
        return (Verdict::Skip(format!("tailnet origins unreachable from the AVD: A {} / B {}", a["navError"], b["navError"])), m);
    }
    m = m
        .lat("gum-B-8443", b["gum"]["ms"].as_u64().unwrap_or(0))
        .lat("gum-A-443", a["gum"]["ms"].as_u64().unwrap_or(0))
        .lat("probe-wall", t0.elapsed().as_millis() as u64)
        .cnt("A-gum-ok", gum_ok(&a) as u64)
        .cnt("B-gum-ok", gum_ok(&b) as u64)
        .cnt("C-mediaDevices-undefined", (c["pre"]["mediaDevices"] == "undefined") as u64)
        .cnt("D-gum-ok", gum_ok(&dd) as u64)
        .cnt("B-perm-inherited-from-A", (b["pre"]["perm"] == "granted") as u64);
    let summary = format!(
        "Chrome {} / Android {}: A https:443 secure={} gum={} · B https:8443 secure={} gum={} prompt='{}' · C http LAN-class secure={} mediaDevices={} · D http://localhost secure={} gum={} · B perm before gUM '{}' (per-origin)",
        v["chrome"].as_str().unwrap_or("?"),
        v["android"].as_str().unwrap_or("?"),
        secure(&a),
        gum_ok(&a),
        secure(&b),
        gum_ok(&b),
        b["prompt"]["text"][0].as_str().unwrap_or("none"),
        secure(&c),
        c["pre"]["mediaDevices"].as_str().unwrap_or("?"),
        secure(&dd),
        gum_ok(&dd),
        b["pre"]["perm"].as_str().unwrap_or("?"),
    );
    eprintln!("[app.chrome-mic-origin] {summary}");
    let model_holds = secure(&a) && gum_ok(&a) && secure(&b) && gum_ok(&b) && !secure(&c) && c["pre"]["mediaDevices"] == "undefined" && secure(&dd) && gum_ok(&dd);
    if model_holds {
        return (Verdict::Pass, m);
    }
    if gum_ok(&a) && !gum_ok(&b) {
        return (Verdict::KnownIssue(format!("port origin refused the mic on Android Chrome — {summary}")), m);
    }
    (Verdict::Fail(format!("secure-context model broken — {summary}")), m)
}

/// Install → deep-link pair against the REAL bridge (hermetic world) → the
/// shell verifies its token natively, the page receives it via the PWA's
/// localStorage contract, and a refused token is told apart.
fn install_pair() -> (Verdict, Metrics) {
    let mut m = Metrics::new();
    let (d, _apk) = match shell_gate() {
        Ok(g) => g,
        Err(v) => return (v, m),
    };
    let world = match crate::world::World::spawn(crate::world::WorldOpts { with_bridge: true, ..Default::default() }) {
        Ok(w) => w,
        Err(e) => return (Verdict::Fail(format!("world: {e}")), m),
    };
    let b = world.bridge.as_ref().expect("bridge");
    let bport = b.http.port();
    let page = match PageServer::start("pair-v1") {
        Ok(p) => p,
        Err(e) => return (Verdict::Fail(format!("page server: {e}")), m),
    };
    for p in [page.port, bport] {
        if let Err(e) = d.reverse_add(p, p) {
            return (Verdict::Fail(format!("adb reverse: {e}")), m);
        }
    }
    let bridge_url = format!("http://localhost:{bport}");
    let t0 = Instant::now();
    if let Err(e) = d.launch_deep_link(&pair_link(&b.token, &format!("{}/app/?mode=plain", page.origin()), &bridge_url)) {
        finish(&d, &[page.port, bport]);
        return (Verdict::Fail(format!("deep link: {e}")), m);
    }
    let verify = d.wait_log("BIFROST_PAIR verify status=", Duration::from_secs(20));
    let verify_ms = t0.elapsed().as_millis() as u64;
    let status: i64 = verify
        .as_deref()
        .and_then(|l| l.split("status=").nth(1))
        .and_then(|s| s.split_whitespace().next())
        .and_then(|s| s.parse().ok())
        .unwrap_or(-1);
    if status != 400 && status != 200 {
        finish(&d, &[page.port, bport]);
        return (Verdict::Fail(format!("bridge did not accept the paired token: {}", verify.unwrap_or_else(|| "no verify line".into()))), m);
    }
    // the bridge side of the contract: tokenless + wrong token stay 401
    for tok in [None, Some("bfsim-not-a-real-token")] {
        match crate::client::post_offer_raw(b.http, "/offer", tok, "{}") {
            Ok((s, _)) if s.starts_with("401") => {}
            other => {
                finish(&d, &[page.port, bport]);
                return (Verdict::Fail(format!("bridge accepted a bad token: {other:?}")), m);
            }
        }
    }
    // the page got the token through the PWA's own contract
    let tail: String = b.token.chars().rev().take(8).collect::<Vec<_>>().into_iter().rev().collect();
    let handed = page.wait_beacon(t0, Duration::from_secs(20), |v| v["tokenTail"] == tail.as_str() && v["bridge"] == bridge_url.as_str() && v["paired"] == true);
    let Some((t_page, _)) = handed else {
        let last = page.beacons().last().map(|(_, v)| v.to_string()).unwrap_or_default();
        finish(&d, &[page.port, bport]);
        return (Verdict::Fail(format!("token never reached the page's localStorage (bifrost_device/bifrost_bridge): {last}")), m);
    };
    // a refused token is told apart (re-pair with a wrong one)
    let _ = d.run(&["logcat", "-c"]);
    let _ = d.launch_deep_link(&pair_link("bfsim-wrong-token", &format!("{}/app/?mode=plain", page.origin()), &bridge_url));
    let refused = d.wait_log("BIFROST_PAIR verify status=", Duration::from_secs(20));
    finish(&d, &[page.port, bport]);
    if !refused.as_deref().unwrap_or("").contains("status=401") {
        return (Verdict::Fail(format!("shell did not report a refused token: {refused:?}")), m);
    }
    m = m
        .lat("pair-verify", verify_ms)
        .lat("token-in-page", t_page.duration_since(t0).as_millis() as u64)
        .cnt("verify-status", status as u64);
    (Verdict::Pass, m)
}

/// Notification surface of the shell: the page asks BifrostNative.notify, the
/// notification must be in `dumpsys notification`. Records whether Web Push
/// exists in the WebView (it does not: remote push needs FCM in the shell).
fn push_notification() -> (Verdict, Metrics) {
    let mut m = Metrics::new();
    let (d, _apk) = match shell_gate() {
        Ok(g) => g,
        Err(v) => return (v, m),
    };
    let page = match PageServer::start("notify-v1") {
        Ok(p) => p,
        Err(e) => return (Verdict::Fail(format!("page server: {e}")), m),
    };
    if let Err(e) = d.reverse_add(page.port, page.port) {
        return (Verdict::Fail(format!("adb reverse: {e}")), m);
    }
    let nonce = format!("n{:x}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis());
    let t0 = Instant::now();
    let url = format!("{}/app/?mode=notify&nonce={nonce}", page.origin());
    if let Err(e) = d.launch_deep_link(&pair_link("bfsim-notify", &url, &page.origin())) {
        finish(&d, &[page.port]);
        return (Verdict::Fail(format!("deep link: {e}")), m);
    }
    let beacon = page.wait_beacon(t0, Duration::from_secs(20), |v| v["notify"] == true);
    let mut seen_ms = None;
    let deadline = Instant::now() + Duration::from_secs(15);
    while Instant::now() < deadline {
        if d.notifications().map(|n| n.contains(&nonce) && n.contains(SHELL_PKG)).unwrap_or(false) {
            seen_ms = Some(t0.elapsed().as_millis() as u64);
            break;
        }
        std::thread::sleep(Duration::from_millis(400));
    }
    let last = page.beacons().last().map(|(_, v)| v.clone()).unwrap_or(Value::Null);
    finish(&d, &[page.port]);
    let Some(ms) = seen_ms else {
        return (Verdict::Fail(format!("native notify bridge posted nothing (beacon notify={}, last={last})", beacon.is_some())), m);
    };
    let push_api = last["pushManager"].as_bool().unwrap_or(false);
    m = m
        .lat("notify-visible", ms)
        .cnt("web-push-api", push_api as u64)
        .cnt("web-notification-api", (last["notification"] != "undefined") as u64)
        .cnt("service-worker-api", last["sw"].as_bool().unwrap_or(false) as u64);
    if push_api {
        return (Verdict::Pass, m);
    }
    (
        Verdict::ExpectedBreak(format!(
            "WebView has no Web Push (PushManager absent, Notification={}) — the PWA's push.ts path cannot reach a wrapped app; the shell's native notify bridge DID post (nonce in dumpsys after {ms}ms). Remote push while closed needs FCM in the shell (pwa/android/README.md design note)",
            last["notification"].as_str().unwrap_or("?")
        )),
        m,
    )
}

fn recorder_line(d: &AppDriver) -> String {
    d.shell("dumpsys audio")
        .unwrap_or_default()
        .lines()
        .find(|l| l.contains("pack:net.bifrost.shell --"))
        .unwrap_or("")
        .to_string()
}

/// Screen off mid-capture: does the shell's mic keep flowing? Receipts from
/// both sides — the page (beacons, track state, frame counter) and the OS
/// (AudioService RecordActivityMonitor `silenced:` for the shell's recorder).
fn background_audio() -> (Verdict, Metrics) {
    let mut m = Metrics::new();
    let (d, _apk) = match shell_gate() {
        Ok(g) => g,
        Err(v) => return (v, m),
    };
    if d.host != crate::app::AppHost::Local {
        return (Verdict::Skip("background-audio needs a LOCAL emulator (UDP media + virtual mic); ssh-mac tunnels are TCP-only".into()), m);
    }
    let page = match PageServer::start("mic-v1") {
        Ok(p) => p,
        Err(e) => return (Verdict::Fail(format!("page server: {e}")), m),
    };
    if let Err(e) = d.reverse_add(page.port, page.port) {
        return (Verdict::Fail(format!("adb reverse: {e}")), m);
    }
    let t0 = Instant::now();
    let url = format!("{}/app/?mode=mic", page.origin());
    if let Err(e) = d.launch_deep_link(&pair_link("bfsim-mic", &url, &page.origin())) {
        finish(&d, &[page.port]);
        return (Verdict::Fail(format!("deep link: {e}")), m);
    }
    let on = page.wait_beacon(t0, Duration::from_secs(25), |v| v["gum"] == "ok" && v["frames"].as_u64().unwrap_or(0) > 10);
    if on.is_none() {
        let last = page.beacons().last().map(|(_, v)| v.to_string()).unwrap_or_default();
        finish(&d, &[page.port]);
        return (Verdict::Fail(format!("mic never flowed in the shell while ON (getUserMedia/grant broken): {last}")), m);
    }
    let gum_ms = t0.elapsed().as_millis() as u64;
    let before = recorder_line(&d);
    // screen OFF for 20s; sample the OS mid-window
    let _ = d.shell("input keyevent KEYCODE_SLEEP");
    let t_off = Instant::now();
    std::thread::sleep(Duration::from_secs(8));
    let asleep = d.shell("dumpsys power").unwrap_or_default().contains("mWakefulness=Asleep");
    let during = recorder_line(&d);
    std::thread::sleep(Duration::from_secs(12));
    let t_on = Instant::now();
    wake(&d);
    std::thread::sleep(Duration::from_secs(4));
    let after = recorder_line(&d);
    let bs = page.beacons();
    finish(&d, &[page.port]);
    if !asleep {
        return (Verdict::Fail("screen never went to sleep (KEYCODE_SLEEP ignored) — precondition".into()), m);
    }
    let window: Vec<&Value> = bs
        .iter()
        .filter(|(t, _)| *t >= t_off + Duration::from_secs(2) && *t <= t_on)
        .map(|(_, v)| v)
        .collect();
    let frames = |v: &Value| v["frames"].as_u64().unwrap_or(0);
    let frames_off = match (window.first(), window.last()) {
        (Some(a), Some(b)) => frames(b).saturating_sub(frames(a)),
        _ => 0,
    };
    let page_saw = window.iter().any(|v| v["track"]["muted"] == true || v["track"]["readyState"] != "live" || v["ended"].as_u64().unwrap_or(0) > 0);
    let hidden = window.iter().any(|v| v["vis"] == "hidden");
    let silenced_on = before.contains("silenced:true");
    let silenced_off = during.contains("silenced:true");
    let recovered = after.contains("silenced:false");
    m = m
        .lat("gum-live", gum_ms)
        .cnt("js-beacons-off", window.len() as u64)
        .cnt("mic-frames-off", frames_off)
        .cnt("os-silenced-off", silenced_off as u64)
        .cnt("page-saw-loss", page_saw as u64)
        .cnt("recovered-on-wake", recovered as u64);
    if silenced_on {
        return (Verdict::Fail(format!("mic silenced while the app was ON screen: {before}")), m);
    }
    if during.is_empty() {
        return (Verdict::Fail("no recorder for the shell in dumpsys audio during the off window".into()), m);
    }
    if !silenced_off && window.len() >= 10 && frames_off > 0 && !page_saw {
        return (Verdict::Pass, m);
    }
    (
        Verdict::ExpectedBreak(format!(
            "screen off 20s in the WebView shell: OS silenced={} (RECORD_AUDIO is while-in-use), page saw it={} (track stays live/unmuted, frames keep counting zeros: {} beacons, +{} frames, visibility hidden={}), un-silenced on wake={} — silent mic loss the page cannot detect; fix = microphone foreground service (pwa/android/README.md design note)",
            silenced_off, page_saw, window.len(), frames_off, hidden, recovered
        )),
        m,
    )
}

/// The update path: the shell loads the PWA from the box, so a new bundle on
/// the box must reach the installed app on its next start — no reinstall.
fn hot_reload() -> (Verdict, Metrics) {
    let mut m = Metrics::new();
    let (d, _apk) = match shell_gate() {
        Ok(g) => g,
        Err(v) => return (v, m),
    };
    let page = match PageServer::start("bundle-v1") {
        Ok(p) => p,
        Err(e) => return (Verdict::Fail(format!("page server: {e}")), m),
    };
    if let Err(e) = d.reverse_add(page.port, page.port) {
        return (Verdict::Fail(format!("adb reverse: {e}")), m);
    }
    let t0 = Instant::now();
    let url = format!("{}/app/?mode=plain", page.origin());
    if let Err(e) = d.launch_deep_link(&pair_link("bfsim-reload", &url, &page.origin())) {
        finish(&d, &[page.port]);
        return (Verdict::Fail(format!("deep link: {e}")), m);
    }
    if page.wait_beacon(t0, Duration::from_secs(20), |v| v["marker"] == "bundle-v1").is_none() {
        finish(&d, &[page.port]);
        return (Verdict::Fail("v1 bundle never loaded in the shell".into()), m);
    }
    // the box ships v2; the user just reopens the app
    page.set_marker("bundle-v2");
    let _ = d.shell(&format!("am force-stop {SHELL_PKG}"));
    let t1 = Instant::now();
    if let Err(e) = d.shell(&format!("am start -W -n {SHELL_PKG}/.MainActivity")) {
        finish(&d, &[page.port]);
        return (Verdict::Fail(format!("relaunch: {e}")), m);
    }
    let v2 = page.wait_beacon(t1, Duration::from_secs(20), |v| v["marker"] == "bundle-v2" && v["paired"] == true);
    let stale = page.beacons().iter().any(|(t, v)| *t >= t1 && v["marker"] == "bundle-v1");
    finish(&d, &[page.port]);
    let Some((tv2, _)) = v2 else {
        return (Verdict::Fail("v2 never reached the relaunched shell (or pairing lost on restart)".into()), m);
    };
    if stale {
        return (Verdict::Fail("relaunched shell served the STALE v1 bundle first".into()), m);
    }
    m = m.lat("relaunch-to-v2", tv2.duration_since(t1).as_millis() as u64);
    (Verdict::Pass, m)
}
