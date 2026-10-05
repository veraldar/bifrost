//! The Capacitor-wrapped Android app as a simulated client — the sim contains
//! the app, the app evolves, the sim evolves with it.
//!
//! Hosts (in detection order):
//! - `local`   — adb on PATH or YGG_SIM_ADB; this box has /dev/kvm, so a local
//!   x86_64 emulator can carry MEDIA scenarios (real UDP WebRTC).
//! - `ssh-mac` — adb on the Mac Studio (`~/Library/Android/sdk/platform-tools`,
//!   the android-lab AVD); reachable over ssh; tunnels are TCP-only, so the
//!   WebRTC media leg CANNOT cross it — HTTP-surface scenarios only (install,
//!   pair, push, hot-reload receipts).
//!
//! APK (the wrap, parallel lane): YGG_SIM_APK or the standard Capacitor
//! output `pwa/android/app/build/outputs/apk/debug/app-debug.apk`. Until the
//! wrap lane lands, app scenarios SKIP loudly naming exactly what would flip
//! them live — they never fake.
//!
//! Pairing contract (matches pwa/app/pair + the bridge's token store): the
//! sim mints the raw device token when it spawns the bridge; the app receives
//! it via deep link `bifrost://pair?token=<raw>&url=<bridge http url>` (the QR
//! on /pair carries the same raw token). Paired = the app holds the token and
//! the bridge's /offer accepts it — the sim asserts both sides.

use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum AppHost {
    Local,
    SshMac,
}

impl AppHost {
    #[allow(dead_code)] // printed in receipts when the wrap lands
    pub fn name(&self) -> &'static str {
        match self {
            AppHost::Local => "local-adb",
            AppHost::SshMac => "ssh-mac-adb",
        }
    }
}

pub struct AppDriver {
    pub host: AppHost,
    /// emulator serial (set by the scenario gate when an AVD is booted)
    #[allow(dead_code)] // used by the live paths once the wrap lands
    pub device: String,
}

fn adb_binary() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("YGG_SIM_ADB") {
        let p = PathBuf::from(p);
        if p.exists() {
            return Some(p);
        }
        return None;
    }
    Some(PathBuf::from("adb"))
}

/// mac adb inside the android-lab SDK layout (docs/android-lab.md)
const MAC_ADB: &str = "$HOME/Library/Android/sdk/platform-tools/adb";

impl AppDriver {
    /// Detect a usable adb host. Does not require a booted emulator — use
    /// `devices()` for that.
    pub fn detect() -> Result<(AppDriver, String), String> {
        // 1. local adb
        if let Some(adb) = adb_binary() {
            let out = Command::new(&adb).arg("version").output();
            if let Ok(o) = out {
                if o.status.success() {
                    return Ok((
                        AppDriver {
                            host: AppHost::Local,
                            device: String::new(),
                        },
                        format!("local adb at {}", adb.display()),
                    ));
                }
            }
        }
        // 2. ssh-mac adb (android-lab's SDK path)
        let probe = Command::new("ssh")
            .args(["-o", "ConnectTimeout=4", "mac"])
            .arg(format!("[ -x {MAC_ADB} ] && echo OK"))
            .output();
        if let Ok(o) = probe {
            if o.status.success() && String::from_utf8_lossy(&o.stdout).contains("OK") {
                return Ok((
                    AppDriver {
                        host: AppHost::SshMac,
                        device: String::new(),
                    },
                    "mac adb via ssh (android-lab SDK)".into(),
                ));
            }
        }
        Err("no adb host: install platform-tools locally (YGG_SIM_ADB) or run scripts/android-lab/01-mac-setup.sh".into())
    }

    fn run(&self, args: &[&str]) -> Result<String, String> {
        let out = match self.host {
            AppHost::Local => {
                let adb = adb_binary().ok_or("local adb vanished")?;
                Command::new(&adb).args(args).output().map_err(|e| e.to_string())?
            }
            AppHost::SshMac => Command::new("ssh")
                .args(["mac", &format!("{MAC_ADB} {}", args.join(" "))])
                .output()
                .map_err(|e| e.to_string())?,
        };
        if !out.status.success() {
            return Err(format!(
                "adb {} failed: {}",
                args.join(" "),
                String::from_utf8_lossy(&out.stderr)
            ));
        }
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    }

    /// Booted devices/emulators (first serial returned).
    pub fn booted(&self) -> Result<Option<String>, String> {
        let out = self.run(&["devices"])?;
        for line in out.lines().skip(1) {
            let mut parts = line.split_whitespace();
            if let (Some(serial), Some(state)) = (parts.next(), parts.next()) {
                if state == "device" {
                    return Ok(Some(serial.to_string()));
                }
            }
        }
        Ok(None)
    }

    pub fn install(&self, apk: &Path) -> Result<(), String> {
        match self.host {
            AppHost::Local => {
                self.run(&["install", "-r", &apk.display().to_string()])?;
            }
            AppHost::SshMac => {
                // ship the APK to the Mac, then install
                let status = Command::new("scp")
                    .args(["-q", &apk.display().to_string(), "mac:.android-lab-sim.apk"])
                    .status()
                    .map_err(|e| e.to_string())?;
                if !status.success() {
                    return Err("scp APK to mac failed".into());
                }
                self.run(&["install", "-r", "/Users/yggdrasil/.android-lab-sim.apk"])?;
            }
        }
        Ok(())
    }

    /// device localhost:dport → adb-host hport (android-lab's reverse pattern)
    #[allow(dead_code)] // live path once the wrap lands
    pub fn reverse_add(&self, dport: u16, hport: u16) -> Result<(), String> {
        self.run(&["reverse", &format!("tcp:{dport}"), &format!("tcp:{hport}")])?;
        Ok(())
    }

    #[allow(dead_code)] // live path once the wrap lands
    pub fn shell(&self, cmd: &str) -> Result<String, String> {
        self.run(&["shell", cmd])
    }

    #[allow(dead_code)] // live path once the wrap lands
    pub fn launch_deep_link(&self, url: &str) -> Result<(), String> {
        self.run(&[
            "shell",
            "am",
            "start",
            "-a",
            "android.intent.action.VIEW",
            "-d",
            url,
        ])?;
        Ok(())
    }

    #[allow(dead_code)] // live path once the wrap lands
    pub fn screencap(&self, local_path: &Path) -> Result<(), String> {
        match self.host {
            AppHost::Local => {
                let adb = adb_binary().ok_or("local adb vanished")?;
                let out = Command::new(&adb)
                    .args(["exec-out", "screencap", "-p"])
                    .output()
                    .map_err(|e| e.to_string())?;
                std::fs::write(local_path, &out.stdout).map_err(|e| e.to_string())?;
            }
            AppHost::SshMac => {
                let out = Command::new("ssh")
                    .args(["mac", &format!("{MAC_ADB} exec-out screencap -p")])
                    .output()
                    .map_err(|e| e.to_string())?;
                std::fs::write(local_path, &out.stdout).map_err(|e| e.to_string())?;
            }
        }
        Ok(())
    }

    /// Notification dump — the push-arrival assertion surface.
    #[allow(dead_code)] // live path once the wrap lands
    pub fn notifications(&self) -> Result<String, String> {
        self.shell("dumpsys notification --noredact")
    }
}

/// Where the wrap's APK should be (parallel lane's build output).
pub fn apk_path() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("YGG_SIM_APK") {
        let p = PathBuf::from(p);
        if p.exists() {
            return Some(p);
        }
        return None;
    }
    let p = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../pwa/android/app/build/outputs/apk/debug/app-debug.apk");
    p.exists().then_some(p)
}

/// What a scenario needs to go live, phrased as the missing pieces.
pub fn skip_reason() -> String {
    let mut missing = vec![];
    match AppDriver::detect() {
        Ok(_) => {}
        Err(e) => missing.push(e),
    }
    match apk_path() {
        Some(p) => {
            missing.push(format!("APK present at {}", p.display()));
        }
        None => missing.push(format!(
            "wrap not built (parallel lane): no APK at {} (YGG_SIM_APK overrides)",
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../pwa/android/app/build/outputs/apk/debug/app-debug.apk")
                .display()
        )),
    }
    format!("app scenarios live when: {}", missing.join("; "))
}
