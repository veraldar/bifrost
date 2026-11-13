//! Two-class run gate (coordinator ≤5s law, item 3i). One per session. Owner messages
//! run first, in arrival order; auto turns (`info.meta.auto`) wait while any owner turn is
//! queued or running, and N pending autos coalesce into ONE turn (the turn snapshots the
//! whole stored history, so every stored auto message is answered by it).
use std::sync::{Arc, Mutex};

use serde_json::Value;
use tokio::sync::{Notify, OwnedMutexGuard, oneshot};

pub type TurnResult = Result<Value, String>;

#[derive(Default)]
pub struct RunGate {
    lock: Arc<tokio::sync::Mutex<()>>,
    state: Mutex<State>,
    notify: Notify,
}

#[derive(Default)]
struct State {
    /// owner turns queued or running
    owners: usize,
    /// Some = an auto leader is waiting for its slot; followers park their senders here.
    autos: Option<Vec<oneshot::Sender<TurnResult>>>,
}

/// Counted at post time (synchronously) so a queued owner turn is visible at once.
pub struct Ticket {
    gate: Arc<RunGate>,
    auto: bool,
}

impl Drop for Ticket {
    fn drop(&mut self) {
        if !self.auto {
            self.gate.state.lock().unwrap().owners -= 1;
            self.gate.notify.notify_waiters();
        }
    }
}

/// Holds the run slot; `finish` hands the result to coalesced followers.
pub struct Permit {
    _guard: OwnedMutexGuard<()>,
    followers: Vec<oneshot::Sender<TurnResult>>,
}

impl Permit {
    pub fn finish(&mut self, r: &TurnResult) {
        for f in self.followers.drain(..) {
            let _ = f.send(r.clone());
        }
    }
}

pub enum Admit {
    Go(Permit),
    /// Folded into another auto turn; await its result.
    Coalesced(oneshot::Receiver<TurnResult>),
}

impl RunGate {
    pub fn ticket(self: &Arc<Self>, auto: bool) -> Ticket {
        if !auto {
            self.state.lock().unwrap().owners += 1;
        }
        Ticket { gate: self.clone(), auto }
    }

    pub async fn admit(self: &Arc<Self>, t: &Ticket) -> Admit {
        if !t.auto {
            return Admit::Go(Permit { _guard: self.lock.clone().lock_owned().await, followers: vec![] });
        }
        let mut leader = false;
        let rx = {
            let mut s = self.state.lock().unwrap();
            match s.autos.as_mut() {
                Some(v) => {
                    let (tx, rx) = oneshot::channel();
                    v.push(tx);
                    Some(rx)
                }
                None => {
                    s.autos = Some(vec![]);
                    leader = true;
                    None
                }
            }
        };
        if !leader {
            return Admit::Coalesced(rx.unwrap());
        }
        loop {
            let notified = self.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.state.lock().unwrap().owners > 0 {
                notified.await;
                continue;
            }
            let guard = self.lock.clone().lock_owned().await;
            let mut s = self.state.lock().unwrap();
            if s.owners > 0 {
                continue; // an owner slipped in while we queued for the lock: let it go first
            }
            let followers = s.autos.take().unwrap_or_default();
            return Admit::Go(Permit { _guard: guard, followers });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::time::Duration;

    /// Runs one "turn" through the gate; returns the order log entry.
    async fn turn(g: Arc<RunGate>, t: Ticket, name: &'static str, log: Arc<Mutex<Vec<&'static str>>>, ms: u64) -> TurnResult {
        match g.admit(&t).await {
            Admit::Go(mut p) => {
                log.lock().unwrap().push(name);
                tokio::time::sleep(Duration::from_millis(ms)).await;
                let r = Ok(json!({ "by": name }));
                p.finish(&r);
                r
            }
            Admit::Coalesced(rx) => rx.await.unwrap_or(Err("dropped".into())),
        }
    }

    #[tokio::test]
    async fn owner_runs_before_queued_auto() {
        let g = Arc::new(RunGate::default());
        let log = Arc::new(Mutex::new(vec![]));
        let t1 = g.ticket(false);
        let h1 = tokio::spawn(turn(g.clone(), t1, "owner1", log.clone(), 80));
        tokio::time::sleep(Duration::from_millis(10)).await;
        let ta = g.ticket(true);
        let ha = tokio::spawn(turn(g.clone(), ta, "auto", log.clone(), 10));
        tokio::time::sleep(Duration::from_millis(10)).await;
        let t2 = g.ticket(false); // arrives AFTER the auto, must still go first
        let h2 = tokio::spawn(turn(g.clone(), t2, "owner2", log.clone(), 10));
        for h in [h1, ha, h2] {
            h.await.unwrap().unwrap();
        }
        assert_eq!(*log.lock().unwrap(), vec!["owner1", "owner2", "auto"]);
    }

    #[tokio::test]
    async fn pending_autos_coalesce_to_one_turn() {
        let g = Arc::new(RunGate::default());
        let log = Arc::new(Mutex::new(vec![]));
        let t1 = g.ticket(false);
        let h1 = tokio::spawn(turn(g.clone(), t1, "owner", log.clone(), 80));
        tokio::time::sleep(Duration::from_millis(10)).await;
        let mut hs = vec![];
        for _ in 0..4 {
            let t = g.ticket(true);
            hs.push(tokio::spawn(turn(g.clone(), t, "auto", log.clone(), 10)));
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        h1.await.unwrap().unwrap();
        for h in hs {
            assert_eq!(h.await.unwrap().unwrap()["by"], "auto"); // every poster gets the one reply
        }
        assert_eq!(*log.lock().unwrap(), vec!["owner", "auto"]); // 4 autos = ONE run
    }

    #[tokio::test]
    async fn auto_after_idle_runs_alone_and_next_auto_runs_again() {
        let g = Arc::new(RunGate::default());
        let log = Arc::new(Mutex::new(vec![]));
        for _ in 0..2 {
            let t = g.ticket(true);
            turn(g.clone(), t, "auto", log.clone(), 5).await.unwrap();
        }
        assert_eq!(*log.lock().unwrap(), vec!["auto", "auto"]);
    }
}
