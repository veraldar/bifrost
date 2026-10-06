//! The scenario matrix — every failure and usage pattern the fleet has hit,
//! each as a runnable scenario with expected outcomes.
//!
//! Families:
//! - `rest.*`   — the PWA-proxy view of yggdrasil (sessions, prompts, aborts,
//!                roll-up marathons, upstream failures)
//! - `bridge.*` — the phone's WebRTC path (auth, hands-free rounds, mode
//!                switches, poor networks, link flaps, multi-device)
//! - `voice.*`  — the voice edge itself (where STT runs: service vs in-process)
//! - `app.*`    — Android on a real emulator via adb: Chrome's mic-by-origin
//!                rules + the bifrost shell APK (install/pair, notifications,
//!                background audio, hot-reload)

mod app;
mod bridge;
mod rest;
mod voice;

pub fn registry() -> Vec<crate::runner::ScenarioDef> {
    let mut all = rest::registry();
    all.extend(bridge::registry());
    all.extend(voice::registry());
    all.extend(app::registry());
    all
}
