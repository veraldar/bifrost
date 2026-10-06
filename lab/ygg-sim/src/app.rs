//! The Android app as a simulated client — the sim contains the app, the app
//! evolves, the sim evolves with it.
//!
//! The app is the bifrost shell (pwa/android, sim v5): a minimal WebView wrap
//! that loads the PWA, holds RECORD_AUDIO natively, grants WebView audio
//! capture to the paired origin only, verifies its pairing against the
//! bridge's /offer, and exposes a native notification bridge. Hand-built by
//! `pwa/android/build.sh` (no Gradle) → `pwa/android/app/build/outputs/apk/
//! debug/app-debug.apk` (YGG_SIM_APK overrides).
//!
//! Hosts (in detection order):
//! - `local`   — adb from YGG_SIM_ADB, `$ANDROID_HOME/platform-tools`,
//!   `~/Android/Sdk/platform-tools` (pwa/android/setup-sdk.sh) or PATH. This
//!   box has /dev/kvm: the sim boots its OWN headless AVD (`ygg-sim`, a child
//!   process it shuts down at the end of the matrix) when none is booted —
//!   media-capable (real UDP), the only host for mic/audio scenarios.
//! - `ssh-mac` — adb on the Mac Studio (android-lab AVD) over ssh; TCP-only
//!   tunnels, HTTP-surface scenarios only.
//!
//! Reachability: everything the device needs is served on the host's
//! 127.0.0.1 and mapped with `adb reverse` to the device's localhost —
//! http://localhost is a secure context (getUserMedia allowed), nothing ever
//! listens beyond loopback.
//!
//! Pairing contract (pwa/app/pair + pwa/app/bridge + the bridge token store):
//! `bifrost://pair?token=<raw>&url=<pwa url>&bridge=<bridge url>` → the shell
//! stores it, POSTs `{bridge}/offer` with the Bearer token (401 = refused,
//! 400 = accepted: the token passed and the empty SDP did not) and hands the
//! token to the page via localStorage `bifrost_device` / `bifrost_bridge`.

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

pub const SHELL_PKG: &str = "net.bifrost.shell";

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum AppHost {
    Local,
    SshMac,
}

impl AppHost {
    pub fn name(&self) -> &'static str {
        match self {
            AppHost::Local => "local-adb",
            AppHost::SshMac => "ssh-mac-adb",
        }
    }
}

pub struct AppDriver {
    pub host: AppHost,
    /// device serial every command is pinned to (empty = adb's default)
    pub device: String,
}

pub fn sdk_root() -> PathBuf {
    std::env::var_os("ANDROID_HOME")
        .or_else(|| std::env::var_os("ANDROID_SDK_ROOT"))
        .map(PathBuf::from)
        .unwrap_or_else(|| home().join("Android/Sdk"))
}

fn home() -> PathBuf {
    std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/"))
}

pub fn adb_binary() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("YGG_SIM_ADB") {
        let p = PathBuf::from(p);
        return p.exists().then_some(p);
    }
    let sdk = sdk_root().join("platform-tools/adb");
    if sdk.exists() {
        return Some(sdk);
    }
    Some(PathBuf::from("adb"))
}

/// mac adb inside the android-lab SDK layout (docs/android-lab.md)
const MAC_ADB: &str = "$HOME/Library/Android/sdk/platform-tools/adb";

impl AppDriver {
    /// Detect a usable adb host. Does not require a booted emulator — use
    /// `ensure_device()` for that.
    pub fn detect() -> Result<(AppDriver, String), String> {
        if let Some(adb) = adb_binary() {
            if let Ok(o) = Command::new(&adb).arg("version").output() {
                if o.status.success() {
                    return Ok((
                        AppDriver { host: AppHost::Local, device: String::new() },
                        format!("local adb at {}", adb.display()),
                    ));
                }
            }
        }
        let probe = Command::new("ssh")
            .args(["-o", "ConnectTimeout=4", "-o", "BatchMode=yes", "mac"])
            .arg(format!("[ -x {MAC_ADB} ] && echo OK"))
            .output();
        if let Ok(o) = probe {
            if o.status.success() && String::from_utf8_lossy(&o.stdout).contains("OK") {
                return Ok((
                    AppDriver { host: AppHost::SshMac, device: String::new() },
                    "mac adb via ssh (android-lab SDK)".into(),
                ));
            }
        }
        Err("no adb host: run pwa/android/setup-sdk.sh (user-space SDK, no root) or set YGG_SIM_ADB".into())
    }

    fn argv<'a>(&'a self, args: &[&'a str]) -> Vec<String> {
        let mut v = vec![];
        if !self.device.is_empty() {
            v.push("-s".to_string());
            v.push(self.device.clone());
        }
        v.extend(args.iter().map(|s| s.to_string()));
        v
    }

    fn raw(&self, args: &[&str]) -> Result<std::process::Output, String> {
        match self.host {
            AppHost::Local => {
                let adb = adb_binary().ok_or("local adb vanished")?;
                Command::new(&adb).args(self.argv(args)).output().map_err(|e| e.to_string())
            }
            AppHost::SshMac => {
                let quoted: Vec<String> = self
                    .argv(args)
                    .iter()
                    .map(|a| format!("'{}'", a.replace('\'', "'\\''")))
                    .collect();
                Command::new("ssh")
                    .args(["-o", "BatchMode=yes", "mac", &format!("{MAC_ADB} {}", quoted.join(" "))])
                    .output()
                    .map_err(|e| e.to_string())
            }
        }
    }

    pub fn run(&self, args: &[&str]) -> Result<String, String> {
        let out = self.raw(args)?;
        if !out.status.success() {
            return Err(format!(
                "adb {} failed: {}{}",
                args.join(" "),
                String::from_utf8_lossy(&out.stderr),
                String::from_utf8_lossy(&out.stdout)
            ));
        }
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    }

    /// Booted devices/emulators — emulators preferred (the sim never drives a
    /// real phone by accident).
    pub fn booted(&self) -> Result<Option<String>, String> {
        let probe = AppDriver { host: self.host, device: String::new() };
        let out = probe.run(&["devices"])?;
        let mut serials = vec![];
        for line in out.lines().skip(1) {
            let mut parts = line.split_whitespace();
            if let (Some(serial), Some("device")) = (parts.next(), parts.next()) {
                serials.push(serial.to_string());
            }
        }
        Ok(serials.iter().find(|s| s.starts_with("emulator-")).cloned())
    }

    pub fn install(&self, apk: &Path) -> Result<(), String> {
        match self.host {
            AppHost::Local => {
                self.run(&["install", "-r", "-g", &apk.display().to_string()])?;
            }
            AppHost::SshMac => {
                let status = Command::new("scp")
                    .args(["-q", &apk.display().to_string(), "mac:.android-lab-sim.apk"])
                    .status()
                    .map_err(|e| e.to_string())?;
                if !status.success() {
                    return Err("scp APK to mac failed".into());
                }
                self.run(&["install", "-r", "-g", "/Users/yggdrasil/.android-lab-sim.apk"])?;
            }
        }
        Ok(())
    }

    /// device localhost:dport → adb-host hport (android-lab's reverse pattern)
    pub fn reverse_add(&self, dport: u16, hport: u16) -> Result<(), String> {
        self.run(&["reverse", &format!("tcp:{dport}"), &format!("tcp:{hport}")])?;
        Ok(())
    }

    pub fn reverse_remove(&self, dport: u16) {
        let _ = self.run(&["reverse", "--remove", &format!("tcp:{dport}")]);
    }

    pub fn shell(&self, cmd: &str) -> Result<String, String> {
        self.run(&["shell", cmd])
    }

    pub fn launch_deep_link(&self, url: &str) -> Result<(), String> {
        self.shell(&format!(
            "am start -W -a android.intent.action.VIEW -d '{}' {SHELL_PKG}",
            url.replace('\'', "")
        ))?;
        Ok(())
    }

    #[allow(dead_code)] // evidence helper (manual runs)
    pub fn screencap(&self, local_path: &Path) -> Result<(), String> {
        let out = self.raw(&["exec-out", "screencap", "-p"])?;
        std::fs::write(local_path, &out.stdout).map_err(|e| e.to_string())
    }

    /// Notification dump — the notification-arrival assertion surface.
    pub fn notifications(&self) -> Result<String, String> {
        self.shell("dumpsys notification --noredact")
    }

    /// Shell lifecycle lines (tag BifrostShell) since the last `logcat -c`.
    pub fn shell_log(&self) -> String {
        self.run(&["logcat", "-d", "-s", "BifrostShell:I"]).unwrap_or_default()
    }

    /// Poll the shell log for a line containing `needle`.
    pub fn wait_log(&self, needle: &str, timeout: Duration) -> Option<String> {
        let t0 = Instant::now();
        while t0.elapsed() < timeout {
            if let Some(l) = self.shell_log().lines().find(|l| l.contains(needle)) {
                return Some(l.to_string());
            }
            std::thread::sleep(Duration::from_millis(300));
        }
        None
    }
}

// ---------------------------------------------------------------------------
// the sim's own emulator (a child process, never detached)

struct OwnedEmu {
    child: Child,
    serial: String,
}

fn owned() -> &'static Mutex<Option<OwnedEmu>> {
    static EMU: OnceLock<Mutex<Option<OwnedEmu>>> = OnceLock::new();
    EMU.get_or_init(|| Mutex::new(None))
}

pub fn avd_name() -> String {
    std::env::var("YGG_SIM_AVD").unwrap_or_else(|_| "ygg-sim".into())
}

/// A booted emulator serial: an already-booted one, or the sim boots its own
/// AVD as a child (local host only) and owns it until `shutdown_emulator()`.
pub fn ensure_device(driver: &AppDriver) -> Result<String, String> {
    if let Some(e) = owned().lock().unwrap().as_ref() {
        return Ok(e.serial.clone());
    }
    if let Some(s) = driver.booted()? {
        return Ok(s);
    }
    if driver.host != AppHost::Local {
        return Err("no booted emulator on the ssh-mac host (scripts/android-lab/02-boot-avd.sh)".into());
    }
    let emu = sdk_root().join("emulator/emulator");
    let avd = avd_name();
    if !emu.exists() || !home().join(format!(".android/avd/{avd}.avd")).exists() {
        return Err(format!(
            "no booted emulator and no local AVD '{avd}' — run pwa/android/setup-sdk.sh (boots nothing by itself)"
        ));
    }
    let port: u16 = std::env::var("YGG_SIM_EMU_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(5580);
    let serial = format!("emulator-{port}");
    let log = std::fs::File::create(std::env::temp_dir().join("ygg-sim-emulator.log")).map_err(|e| e.to_string())?;
    let err = log.try_clone().map_err(|e| e.to_string())?;
    let child = Command::new(&emu)
        .args(["-avd", &avd, "-port", &port.to_string(), "-no-window", "-no-snapshot", "-no-boot-anim"])
        .args(["-gpu", "swiftshader_indirect", "-netdelay", "none", "-netspeed", "full"])
        .env("ANDROID_HOME", sdk_root())
        .env("ANDROID_SDK_ROOT", sdk_root())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(err))
        .spawn()
        .map_err(|e| format!("spawn emulator: {e}"))?;
    *owned().lock().unwrap() = Some(OwnedEmu { child, serial: serial.clone() });
    eprintln!("[app] booting own AVD '{avd}' as {serial} (child process; shut down at matrix end)");
    let d = AppDriver { host: AppHost::Local, device: serial.clone() };
    let t0 = Instant::now();
    while t0.elapsed() < Duration::from_secs(240) {
        if let Some(e) = owned().lock().unwrap().as_mut() {
            if let Ok(Some(st)) = e.child.try_wait() {
                return Err(format!("emulator exited during boot ({st}) — see ygg-sim-emulator.log in the temp dir"));
            }
        }
        if d.shell("getprop sys.boot_completed").map(|s| s.trim() == "1").unwrap_or(false) {
            // settle: package manager + launcher come up just after the flag
            std::thread::sleep(Duration::from_secs(5));
            eprintln!("[app] {serial} booted in {}s", t0.elapsed().as_secs());
            return Ok(serial);
        }
        std::thread::sleep(Duration::from_secs(2));
    }
    Err(format!("own AVD '{avd}' did not boot within 240s"))
}

/// Graceful shutdown of the sim's own emulator: `adb emu kill`, then SIGTERM
/// if it lingers. Never SIGKILL (AVD userdata survives).
pub fn shutdown_emulator() {
    let Some(mut e) = owned().lock().unwrap().take() else { return };
    let d = AppDriver { host: AppHost::Local, device: e.serial.clone() };
    let _ = d.run(&["emu", "kill"]);
    for i in 0..40 {
        if let Ok(Some(_)) = e.child.try_wait() {
            eprintln!("[app] own AVD {} shut down", e.serial);
            return;
        }
        if i == 20 {
            let _ = Command::new("kill").args(["-TERM", &e.child.id().to_string()]).status();
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    eprintln!("[app] own AVD {} still exiting after 20s (pid {})", e.serial, e.child.id());
}

/// Where the shell's APK is (pwa/android/build.sh output).
pub fn apk_path() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("YGG_SIM_APK") {
        let p = PathBuf::from(p);
        return p.exists().then_some(p);
    }
    let p = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../pwa/android/app/build/outputs/apk/debug/app-debug.apk");
    p.exists().then_some(p)
}

/// What a scenario needs to go live, phrased as the missing pieces.
pub fn skip_reason() -> String {
    let mut missing = vec![];
    if let Err(e) = AppDriver::detect() {
        missing.push(e);
    }
    if apk_path().is_none() {
        missing.push(format!(
            "shell APK not built: run pwa/android/build.sh (expects {})",
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../pwa/android/app/build/outputs/apk/debug/app-debug.apk")
                .display()
        ));
    }
    format!("app scenarios live when: {}", missing.join("; "))
}

// ---------------------------------------------------------------------------
// the page the shell loads (served on 127.0.0.1, adb-reversed to device localhost)

pub struct PageState {
    pub marker: String,
    /// (arrival on the host, beacon json)
    pub beacons: Vec<(Instant, serde_json::Value)>,
}

pub struct PageServer {
    pub port: u16,
    pub state: Arc<Mutex<PageState>>,
    stop: Arc<AtomicBool>,
}

impl PageServer {
    pub fn start(marker: &str) -> Result<PageServer, String> {
        let server = tiny_http::Server::http("127.0.0.1:0").map_err(|e| e.to_string())?;
        let port = server.server_addr().to_ip().map(|a| a.port()).ok_or("page server addr")?;
        let state = Arc::new(Mutex::new(PageState { marker: marker.into(), beacons: vec![] }));
        let stop = Arc::new(AtomicBool::new(false));
        let (st, sp) = (state.clone(), stop.clone());
        std::thread::spawn(move || {
            while !sp.load(Ordering::SeqCst) {
                let Ok(Some(mut rq)) = server.recv_timeout(Duration::from_millis(100)) else { continue };
                let url = rq.url().to_string();
                if rq.method() == &tiny_http::Method::Post && url.starts_with("/beacon") {
                    let mut body = String::new();
                    let _ = rq.as_reader().read_to_string(&mut body);
                    if let Ok(v) = serde_json::from_str(&body) {
                        st.lock().unwrap().beacons.push((Instant::now(), v));
                    }
                    let _ = rq.respond(tiny_http::Response::from_string("ok"));
                } else if url.starts_with("/app/") {
                    let marker = st.lock().unwrap().marker.clone();
                    let html = PAGE.replace("__MARKER__", &marker);
                    let resp = tiny_http::Response::from_string(html)
                        .with_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"text/html; charset=utf-8"[..]).unwrap())
                        .with_header(tiny_http::Header::from_bytes(&b"Cache-Control"[..], &b"no-cache"[..]).unwrap());
                    let _ = rq.respond(resp);
                } else {
                    let _ = rq.respond(tiny_http::Response::from_string("not found").with_status_code(404));
                }
            }
        });
        Ok(PageServer { port, state, stop })
    }

    /// the origin as the DEVICE sees it (via adb reverse)
    pub fn origin(&self) -> String {
        format!("http://localhost:{}", self.port)
    }

    pub fn set_marker(&self, m: &str) {
        self.state.lock().unwrap().marker = m.into();
    }

    pub fn beacons(&self) -> Vec<(Instant, serde_json::Value)> {
        self.state.lock().unwrap().beacons.clone()
    }

    /// first beacon (arrived after `since`) matching `pred`
    pub fn wait_beacon(
        &self,
        since: Instant,
        timeout: Duration,
        pred: impl Fn(&serde_json::Value) -> bool,
    ) -> Option<(Instant, serde_json::Value)> {
        let t0 = Instant::now();
        while t0.elapsed() < timeout {
            if let Some(b) = self.beacons().into_iter().find(|(t, v)| *t >= since && pred(v)) {
                return Some(b);
            }
            std::thread::sleep(Duration::from_millis(200));
        }
        None
    }
}

impl Drop for PageServer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
    }
}

/// percent-encode a URL for a query parameter
pub fn qenc(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// The page: modes plain | mic | notify (?mode=), one beacon per second to
/// /beacon with everything the scenarios assert on.
const PAGE: &str = r#"<!doctype html><meta name=viewport content="width=device-width">
<title>ygg-sim app page</title>
<body style="font:15px sans-serif;background:#14161c;color:#ddd;padding:16px">
<h3>ygg-sim · __MARKER__</h3><pre id=s style="white-space:pre-wrap"></pre>
<script>
const MARKER='__MARKER__';const q=new URLSearchParams(location.search);const mode=q.get('mode')||'plain';
const N=window.BifrostNative;const st={frames:0,seq:0,gum:null,ended:0,mutes:0,notify:null};
async function mic(){try{const s=await navigator.mediaDevices.getUserMedia({audio:true});const tr=s.getAudioTracks()[0];
 const ctx=new AudioContext();const src=ctx.createMediaStreamSource(s);const sp=ctx.createScriptProcessor(4096,1,1);
 sp.onaudioprocess=()=>{st.frames++};src.connect(sp);sp.connect(ctx.destination);
 const osc=ctx.createOscillator();const g=ctx.createGain();g.gain.value=0.02;osc.connect(g);g.connect(ctx.destination);osc.start();
 if(ctx.state!=='running'){try{await ctx.resume()}catch(e){}}
 tr.onended=()=>{st.ended++};tr.onmute=()=>{st.mutes++};
 st.track=()=>({readyState:tr.readyState,muted:tr.muted,enabled:tr.enabled});st.ctx=()=>ctx.state;st.gum='ok';
}catch(e){st.gum=e.name+': '+e.message}}
function beacon(){st.seq++;const b={marker:MARKER,mode,seq:st.seq,t:Date.now(),secure:isSecureContext,
 shell:N?N.version():null,paired:N?N.paired():null,
 tokenTail:(localStorage.getItem('bifrost_device')||'').slice(-8),bridge:localStorage.getItem('bifrost_bridge')||'',
 vis:document.visibilityState,gum:st.gum,frames:st.frames,track:st.track?st.track():null,ctx:st.ctx?st.ctx():null,
 ended:st.ended,mutes:st.mutes,notify:st.notify,
 pushManager:'PushManager' in window,sw:'serviceWorker' in navigator,notification:typeof Notification};
 fetch('/beacon',{method:'POST',body:JSON.stringify(b),headers:{'content-type':'application/json'}}).catch(()=>{});
 document.getElementById('s').textContent=JSON.stringify(b,null,1)}
if(mode==='mic')mic();
if(mode==='notify'){const go=()=>{if(N&&N.paired()){st.notify=N.notify('bifrost','reply ready '+(q.get('nonce')||''))}else setTimeout(go,300)};go()}
setInterval(beacon,1000);beacon();
</script>"#;
