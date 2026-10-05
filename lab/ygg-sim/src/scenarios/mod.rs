//! The scenario matrix — every failure and usage pattern the fleet has hit,
//! each as a runnable scenario with expected outcomes.
//!
//! Families:
//! - `rest.*`   — the PWA-proxy view of yggdrasil (sessions, prompts, aborts,
//!                roll-up marathons, upstream failures)
//! - `bridge.*` — the phone's WebRTC path (auth, hands-free rounds, mode
//!                switches, poor networks, link flaps, multi-device)
//! - `app.*`    — the Capacitor-wrapped Android app (install, pair, push,
//!                background audio, hot-reload) — SKIP-loud until the wrap
//!                lands, then driven by real adb

mod app;
mod bridge;
mod rest;

pub fn registry() -> Vec<crate::runner::ScenarioDef> {
    let mut all = rest::registry();
    all.extend(bridge::registry());
    all.extend(app::registry());
    all
}
