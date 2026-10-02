//! git never waits on the UI: `git.rs` drains stderr continuously into a channel, and this tap
//! reads it. It keeps only the last `Rebasing (n/m)` and emits at most one `opProgress` per tick,
//! so a fast rebase spins through at one update per ~100 ms. Nothing here sits between two of
//! git's commits.

use crate::events::{AppEvent, EventBus, ProgressStep};
use std::time::Duration;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

/// The coalescing period: ≤ 10 `opProgress` a second (§16).
pub(crate) const TICK: Duration = Duration::from_millis(100);

/// git's `Rebasing (23/60)` (it rewrites the line with `\r`; the stream splits on it).
pub(crate) fn parse_rebasing(line: &str) -> Option<(u32, u32)> {
    let rest = line.trim().strip_prefix("Rebasing (")?;
    let (n, rest) = rest.split_once('/')?;
    let m = rest.strip_suffix(')')?;
    Some((n.parse().ok()?, m.parse().ok()?))
}

pub(crate) struct ProgressTap {
    /// git's stderr goes here (`WriteCx::git_to`).
    pub tx: mpsc::UnboundedSender<String>,
    task: JoinHandle<Option<(u32, u32)>>,
}

impl ProgressTap {
    /// Once git is done (every sender dropped): the last step seen, after its final event.
    pub(crate) async fn finish(self) -> Option<(u32, u32)> {
        drop(self.tx);
        self.task.await.ok().flatten()
    }
}

pub(crate) fn tap(bus: EventBus, op: u64, phase: &'static str, branch: Option<String>, out: mpsc::UnboundedSender<String>, every: Duration, mut on_tick: impl FnMut() + Send + 'static) -> ProgressTap {
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    let task = tokio::spawn(async move {
        let mut last: Option<(u32, u32)> = None;
        let mut sent: Option<(u32, u32)> = None;
        let mut emit = |s: (u32, u32)| {
            let percent = Some(((u64::from(s.0) * 100) / u64::from(s.1.max(1))).min(100) as u8);
            bus.emit(AppEvent::OpProgress { op, phase: phase.to_string(), percent, step: Some(ProgressStep { n: s.0, m: s.1, branch: branch.clone() }) });
            on_tick();
        };
        let mut tick = tokio::time::interval(every);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        tick.tick().await;
        loop {
            tokio::select! {
                line = rx.recv() => match line {
                    Some(l) => match parse_rebasing(&l) {
                        Some(s) => last = Some(s),
                        None => {
                            let _ = out.send(l);
                        }
                    },
                    None => break,
                },
                _ = tick.tick() => {
                    if last != sent && let Some(s) = last {
                        emit(s);
                        sent = last;
                    }
                }
            }
        }
        if last != sent && let Some(s) = last {
            emit(s);
        }
        last
    });
    ProgressTap { tx, task }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::{AppEvent, EventBus};

    #[test]
    fn parses_gits_rebasing_line() {
        assert_eq!(parse_rebasing("Rebasing (23/60)"), Some((23, 60)));
        assert_eq!(parse_rebasing("  Rebasing (1/1)  "), Some((1, 1)));
        assert_eq!(parse_rebasing("Rebasing (x/60)"), None);
        assert_eq!(parse_rebasing("Successfully rebased and updated refs/heads/main."), None);
    }

    /// §16: at most 10 `opProgress` a second, however fast git goes; the last step always lands;
    /// every other line reaches Activity; `on_tick` follows each emitted step.
    #[tokio::test(start_paused = true)]
    async fn sixty_steps_in_a_fifth_of_a_second_emit_a_handful() {
        let bus = EventBus::new();
        let mut rx = bus.subscribe();
        let (out, mut activity) = tokio::sync::mpsc::unbounded_channel();
        let ticks = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let t = ticks.clone();
        let tap = tap(bus.clone(), 9, "Rebasing", None, out, TICK, move || {
            t.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        });
        for n in 1..=60 {
            tap.tx.send(format!("Rebasing ({n}/60)")).unwrap();
            if n == 30 {
                tap.tx.send("hint: a hook said hi".into()).unwrap();
            }
            tokio::time::sleep(std::time::Duration::from_millis(3)).await;
        }
        assert_eq!(tap.finish().await, Some((60, 60)));
        let mut steps = Vec::new();
        while let Ok(ev) = rx.try_recv() {
            if let AppEvent::OpProgress { op: 9, step: Some(s), percent, .. } = ev {
                steps.push((s.n, s.m, percent));
            }
        }
        assert!(steps.len() <= 3, "180 ms of steps → at most 2 ticks and the final one: {steps:?}");
        assert_eq!(steps.last(), Some(&(60, 60, Some(100))));
        assert_eq!(ticks.load(std::sync::atomic::Ordering::SeqCst), steps.len());
        assert_eq!(activity.try_recv().unwrap(), "hint: a hook said hi");
        assert!(activity.try_recv().is_err(), "no Rebasing line reaches Activity");
    }
}
