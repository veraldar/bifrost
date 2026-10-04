//! The scenario matrix — every failure and usage pattern the fleet has hit,
//! each as a runnable scenario with expected outcomes.
//!
//! Families:
//! - `rest.*`   — the PWA-proxy view of yggdrasil (sessions, prompts, aborts,
//!                roll-up marathons, upstream failures)
//! - `bridge.*` — the phone's WebRTC path (auth, hands-free rounds, mode
//!                switches, poor networks, link flaps, multi-device)

mod bridge;
mod rest;

pub fn registry() -> Vec<crate::runner::ScenarioDef> {
    let mut all = rest::registry();
    all.extend(bridge::registry());
    all
}
