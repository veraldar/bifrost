//! HTTP through the same chaos — REST and signaling calls drawn from the same
//! profile family as the wire. Honest simplification: shaping applies at
//! request granularity (RTT draw before + after, drop with retry), not per
//! packet — the wire owns per-packet reality; this owns the turn-level feel.

use std::time::Duration;

use crate::rng::Rng;
use crate::wire::FlowProfile;

pub struct ShapedHttp {
    rng: Rng,
    agent: ureq::Agent,
    prof: FlowProfile,
    /// latency samples collected (ms) — scenarios fold these into metrics
    pub latencies_ms: Vec<u64>,
}

impl ShapedHttp {
    pub fn new(seed: u64, prof: &FlowProfile) -> ShapedHttp {
        let agent = ureq::AgentBuilder::new()
            .timeout(Duration::from_secs(30))
            .build();
        ShapedHttp {
            rng: Rng::new(seed),
            agent,
            prof: prof.clone(),
            latencies_ms: vec![],
        }
    }

    fn rtt(&mut self) {
        let ms = self.prof.latency.as_millis() + self.rng.range_i64(0, self.prof.jitter.as_millis() as i64) as u128;
        std::thread::sleep(Duration::from_millis(ms as u64));
    }

    fn maybe_drop(&mut self) -> Result<(), String> {
        if self.prof.loss > 0.0 && self.rng.chance(self.prof.loss) {
            return Err("net drop (shaped)".into());
        }
        Ok(())
    }

    pub fn get(&mut self, url: &str) -> Result<String, String> {
        for _ in 0..3 {
            self.rtt();
            if self.maybe_drop().is_err() {
                continue;
            }
            let t0 = std::time::Instant::now();
            let res = self
                .agent
                .get(url)
                .call()
                .map_err(|e| format!("GET {url}: {e}"))
                .and_then(|r| r.into_string().map_err(|e| e.to_string()));
            self.latencies_ms.push(t0.elapsed().as_millis() as u64);
            match res {
                Ok(s) => return Ok(s),
                Err(e) => return Err(e),
            }
        }
        Err(format!("GET {url}: dropped 3x by shaped net"))
    }

    /// Returns the raw body; non-2xx is an Err carrying the status.
    pub fn post_json(&mut self, url: &str, body: &str) -> Result<String, String> {
        for _ in 0..3 {
            self.rtt();
            if self.maybe_drop().is_err() {
                continue;
            }
            let t0 = std::time::Instant::now();
            let res = self
                .agent
                .post(url)
                .set("Content-Type", "application/json")
                .send_string(body);
            self.latencies_ms.push(t0.elapsed().as_millis() as u64);
            match res {
                Ok(r) => {
                    return r
                        .into_string()
                        .map_err(|e| format!("POST {url} body: {e}"));
                }
                Err(ureq::Error::Status(code, r)) => {
                    let text = r.into_string().unwrap_or_default();
                    return Err(format!("POST {url}: status {code}: {text}"));
                }
                Err(e) => return Err(format!("POST {url}: {e}")),
            }
        }
        Err(format!("POST {url}: dropped 3x by shaped net"))
    }
}
