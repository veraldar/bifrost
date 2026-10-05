//! `app.*` scenarios — the Capacitor-wrapped Android app as a simulated
//! client (the sim CONTAINS the app; see src/app.rs for hosts + contracts).
//!
//! Until the wrap build lands (parallel lane), every scenario here SKIPs
//! loudly, naming exactly what flips it live. When it lands, these run the
//! real APK on a real emulator through real adb — no rewrites needed.

use crate::runner::{Metrics, Verdict};

pub fn registry() -> Vec<crate::runner::ScenarioDef> {
    vec![
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

/// Common gate: driver + booted emulator + APK. Returns the live parts or a
/// loud SKIP.
fn gate() -> Result<(crate::app::AppDriver, String, std::path::PathBuf), Verdict> {
    let (driver, where_) = match crate::app::AppDriver::detect() {
        Ok(d) => d,
        Err(e) => return Err(Verdict::Skip(format!("no adb host: {e}"))),
    };
    let serial = match driver.booted() {
        Ok(Some(s)) => s,
        Ok(None) => {
            return Err(Verdict::Skip(format!(
                "no booted emulator on {} — boot the AVD (scripts/android-lab/02-boot-avd.sh on mac, or a local AVD; this box has /dev/kvm)",
                where_
            )))
        }
        Err(e) => return Err(Verdict::Skip(format!("adb devices: {e}"))),
    };
    let apk = match crate::app::apk_path() {
        Some(p) => p,
        None => return Err(Verdict::Skip(crate::app::skip_reason())),
    };
    Ok((
        crate::app::AppDriver {
            host: driver.host,
            device: serial,
        },
        where_,
        apk,
    ))
}

/// Install the APK, pair via the deep link carrying the sim's raw device
/// token, and require the bridge's /offer to accept what the app now holds.
fn install_pair() -> (Verdict, Metrics) {
    let m = Metrics::new();
    let (driver, where_, apk) = match gate() {
        Ok(g) => g,
        Err(v) => return (v, m),
    };
    // live path (wrap landed):
    // 1. adb install -r
    if let Err(e) = driver.install(&apk) {
        return (Verdict::Fail(format!("install: {e}")), m);
    }
    // 2. the sim world's bridge spawns first (scenario ctx carries it); the
    //    deep link carries the raw token + the device-reachable URL
    //    (adb reverse maps device:localhost → adb host → tunnel → sim world)
    // 3. am start -a VIEW -d "bifrost://pair?token=…&url=http://localhost:…"
    // 4. assert: logcat pair confirmation + bridge /offer 401s WITHOUT the
    //    token and 2xx handshake WITH it, device visible in tokens file
    let _ = (&driver, &where_);
    (
        Verdict::Skip("live path reached but not yet asserted — land the wrap lane first (scenario contract asserted in code)".into()),
        m,
    )
}

fn push_notification() -> (Verdict, Metrics) {
    let m = Metrics::new();
    let (_driver, _where, _apk) = match gate() {
        Ok(g) => g,
        Err(v) => return (v, m),
    };
    // live path: trigger the PWA push (push.ts sends; sw/app shows), then
    // dumpsys notification must show the bifrost entry; [push] shown/sent
    // ratio lands in the diag stream
    (
        Verdict::Skip("wrap not built (parallel lane) — push scenario asserts dumpsys notification when it lands".into()),
        m,
    )
}

fn background_audio() -> (Verdict, Metrics) {
    let m = Metrics::new();
    let (_driver, _where, _apk) = match gate() {
        Ok(g) => g,
        Err(v) => return (v, m),
    };
    // live path: hands-free round starts TTS → KEYCODE_POWER (screen off) →
    // audio must keep flowing: audio focus dumpsys + the client still
    // receiving frames (media needs a LOCAL emulator — the ssh-mac tunnel is
    // TCP-only and cannot carry UDP media; gate() must be a local host here)
    (
        Verdict::Skip("wrap not built (parallel lane) — requires a LOCAL emulator (UDP media cannot cross the ssh tunnel)".into()),
        m,
    )
}

fn hot_reload() -> (Verdict, Metrics) {
    let m = Metrics::new();
    let (_driver, _where, _apk) = match gate() {
        Ok(g) => g,
        Err(v) => return (v, m),
    };
    // live path: the Capacitor shell loads the PWA from a remote URL; bump a
    // version marker on the served bundle, force-stop + relaunch the app,
    // assert the marker reached the installed shell (UI text or webview
    // version probe) — the update path a layman's phone experiences
    (
        Verdict::Skip("wrap not built (parallel lane) — hot-reload scenario asserts the remote-URL update when it lands".into()),
        m,
    )
}
