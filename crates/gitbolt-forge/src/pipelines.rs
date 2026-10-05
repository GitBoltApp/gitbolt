//! The list's pipelines by commit, per account: a list poll asks the forge for pipelines only
//! when a listed head is new, one of them is still running or pending, or what's kept is old.
//! A finished pipeline on a commit rarely changes (a re-run does), so it's kept a while.

use gitbolt_core::forge::{ForgePipeline, PipelineStatus};
use std::collections::HashMap;
use std::sync::Mutex;

/// A finished pipeline (success, failed, canceled, skipped, manual) is asked again after this long.
pub const SETTLED_SECS: i64 = 600;
/// A commit with no pipeline yet (just pushed: its checks may start any moment).
pub const NONE_SECS: i64 = 120;
/// Commits kept at most; the oldest go first.
pub const KEPT: usize = 2000;

#[derive(Default)]
pub struct PipelineCache {
    by_sha: Mutex<HashMap<String, (Option<ForgePipeline>, i64)>>,
}

fn running(p: &Option<ForgePipeline>) -> bool {
    p.as_ref().is_some_and(|p| matches!(p.status, PipelineStatus::Running | PipelineStatus::Pending))
}

impl PipelineCache {
    /// Some head in `shas` needs asking at `now`.
    pub fn needs<'a>(&self, shas: impl IntoIterator<Item = &'a str>, now: i64) -> bool {
        let m = self.by_sha.lock().expect("pipelines poisoned");
        shas.into_iter().any(|s| match m.get(&s.to_ascii_lowercase()) {
            None => true,
            Some((p, _)) if running(p) => true,
            Some((None, at)) => now.saturating_sub(*at) >= NONE_SECS,
            Some((_, at)) => now.saturating_sub(*at) >= SETTLED_SECS,
        })
    }

    pub fn put(&self, sha: &str, p: Option<ForgePipeline>, now: i64) {
        let mut m = self.by_sha.lock().expect("pipelines poisoned");
        m.insert(sha.to_ascii_lowercase(), (p, now));
        if m.len() > KEPT {
            let mut ats: Vec<i64> = m.values().map(|(_, at)| *at).collect();
            ats.sort_unstable();
            let cut = ats[m.len() - KEPT];
            m.retain(|_, (_, at)| *at >= cut);
        }
    }

    /// What's kept for `sha`, however old (a failed refresh keeps the last one shown).
    pub fn get(&self, sha: &str) -> Option<ForgePipeline> {
        self.by_sha.lock().expect("pipelines poisoned").get(&sha.to_ascii_lowercase()).and_then(|(p, _)| p.clone())
    }

    /// Whether `sha` has an answer kept (a pipeline or none).
    pub fn has(&self, sha: &str) -> bool {
        self.by_sha.lock().expect("pipelines poisoned").contains_key(&sha.to_ascii_lowercase())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(status: PipelineStatus) -> Option<ForgePipeline> {
        Some(ForgePipeline { status, web_url: None })
    }

    #[test]
    fn a_new_running_or_old_head_needs_asking() {
        let c = PipelineCache::default();
        assert!(c.needs(["a"], 0));
        c.put("A", p(PipelineStatus::Success), 0);
        c.put("b", p(PipelineStatus::Running), 0);
        c.put("c", None, 0);
        assert!(!c.needs(["a"], SETTLED_SECS - 1), "the case of a sha doesn't matter");
        assert!(c.needs(["a"], SETTLED_SECS));
        assert!(c.needs(["b"], 1), "a running one is asked every poll");
        assert!(!c.needs(["c"], NONE_SECS - 1));
        assert!(c.needs(["c"], NONE_SECS));
        assert_eq!(c.get("a").unwrap().status, PipelineStatus::Success);
        assert!(c.has("c") && c.get("c").is_none());
    }

    #[test]
    fn the_oldest_go_past_the_cap() {
        let c = PipelineCache::default();
        for i in 0..KEPT + 10 {
            c.put(&format!("{i}"), None, i as i64);
        }
        assert!(!c.has("0") && c.has(&format!("{}", KEPT + 9)));
    }
}
