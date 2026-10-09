//! The forge layer's contract (spec #4 §3.1–§3.3). Core defines it and never depends on an HTTP
//! client (as `avatar.rs`): the normalized types the UI sees, the `ForgeProvider` trait
//! `gitbolt-forge` implements per forge kind, and the token store and connector the app injects.

pub mod provider;
pub mod types;
pub mod version;
// --- 4A T5 ---
pub mod accounts;
pub mod hub;
#[cfg(test)]
pub(crate) mod fake;
// --- end 4A T5 ---
// --- 4D T1 ---
pub mod stack;
// --- end 4D T1 ---
// --- 4C T1 ---
pub mod create;
// --- end 4C T1 ---
// --- 4B T1 ---
pub mod mrs;
pub mod cache;
// --- end 4B T1 ---
// --- 5A T1 ---
pub mod image;
pub use image::{image_host, ForgeImage};
// --- end 5A T1 ---
// --- review comments ---
pub mod review;
// --- end review comments ---

pub use provider::*;
pub use types::*;
pub use version::*;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::avatar::AvatarPayload;
    use crate::error::GbErrorKind;
    use std::sync::Arc;

    pub(crate) fn sample_project() -> ForgeProject {
        ForgeProject {
            kind: ForgeKind::GitLab, id: 42, host: "gitlab.example.com".into(), path: "group/project".into(), name: "project".into(),
            owner: "group".into(), web_url: "https://gitlab.example.com/group/project".into(), default_branch: Some("main".into()),
            clone_https: "https://gitlab.example.com/group/project.git".into(), clone_ssh: "git@gitlab.example.com:group/project.git".into(),
            fork_of: None, updated_at: Some(1_791_115_200), archived: false, owner_avatar_url: None,
        }
    }

    /// Implements only what 4A's providers must: the rest are the defaults.
    struct Minimal;
    impl ForgeProvider for Minimal {
        fn kind(&self) -> ForgeKind { ForgeKind::GitLab }
        fn host(&self) -> &str { "gitlab.example.com" }
        fn rate_limit(&self) -> RateLimitState { RateLimitState::default() }
        fn check_token(&self) -> ForgeFuture<'_, TokenCheck> { unsupported("Checking a token") }
        fn current_user(&self) -> ForgeFuture<'_, ForgeUser> { unsupported("Reading the user") }
        fn version(&self) -> ForgeFuture<'_, Option<String>> { Box::pin(async { Ok(None) }) }
        fn project<'a>(&'a self, _path: &'a str) -> ForgeFuture<'a, Fresh<ForgeProject>> { Box::pin(async { Ok(Fresh::new(sample_project(), 7)) }) }
        fn project_settings<'a>(&'a self, _p: &'a ForgeProject) -> ForgeFuture<'a, ForgeProjectSettings> { unsupported("Project settings") }
        fn forks<'a>(&'a self, _p: &'a ForgeProject) -> ForgeFuture<'a, Vec<ForgeProject>> { Box::pin(async { Ok(vec![]) }) }
        fn avatar_for_email<'a>(&'a self, _e: &'a str) -> ForgeFuture<'a, Option<AvatarPayload>> { Box::pin(async { Ok(None) }) }
    }

    #[tokio::test]
    async fn the_merge_request_methods_refuse_until_a_plan_implements_them() {
        let p: Arc<dyn ForgeProvider> = Arc::new(Minimal);
        let project = sample_project();
        let e = p.open_mrs(&project, MrFilter::All).await.unwrap_err();
        assert_eq!(e.kind, GbErrorKind::InvalidInput);
        assert_eq!(e.message, "Listing merge requests isn't supported by this forge yet");
        assert!(p.retarget(&project, 3, "main").await.is_err());
        assert!(p.create_mr(&project, &CreateMr { source: SourceRef { project: "group/project".into(), branch: "x".into() }, target_branch: "main".into(), title: "t".into(), description: String::new(), draft: false, reviewers: vec![], assignees: vec![], labels: vec![], squash: None, delete_source_branch: None }).await.is_err());
        assert_eq!(p.project("group/project").await.unwrap().fetched_at, 7);
    }

    #[test]
    fn forge_kinds_and_states_serialize_as_the_ui_reads_them() {
        assert_eq!(serde_json::to_value(ForgeKind::GitLab).unwrap(), "gitlab");
        assert_eq!(serde_json::to_value(ForgeKind::GitHub).unwrap(), "github");
        assert_eq!(ForgeKind::from_host_kind(crate::remotes::HostKind::Generic), None);
        assert_eq!(ForgeKind::from_host_kind(crate::remotes::HostKind::GitHub), Some(ForgeKind::GitHub));
        assert_eq!(serde_json::to_value(MrState::Draft).unwrap(), "draft");
        assert_eq!(serde_json::to_value(SquashOption::DefaultOn).unwrap(), "defaultOn");
        assert_eq!(serde_json::to_value(MergeMethod::SemiLinear).unwrap(), "semiLinear");
        assert_eq!(serde_json::to_value(WriteAccess::No { missing: "api".into() }).unwrap(), serde_json::json!({"kind": "no", "missing": "api"}));
        assert_eq!(serde_json::to_value(MergeStatus::Blocked { reason: "Pipeline failed".into() }).unwrap(), serde_json::json!({"kind": "blocked", "reason": "Pipeline failed"}));
        let v = serde_json::to_value(sample_project()).unwrap();
        assert_eq!(v["cloneHttps"], "https://gitlab.example.com/group/project.git");
        assert_eq!(v["defaultBranch"], "main");
        assert!(v.get("forkOf").is_some(), "{v}");
        let fresh = Fresh::new(1u32, 5).map(|n| n + 1);
        assert_eq!((fresh.value, fresh.fetched_at, fresh.not_modified), (2, 5, false));
    }

    #[test]
    fn the_keyring_account_is_profile_slash_host() {
        let k = AccountKey { profile: "default".into(), host: "gitlab.example.com".into() };
        assert_eq!(k.keyring_account(), "default/gitlab.example.com");
        assert_eq!(KEYRING_SERVICE, "gitbolt");
    }

    #[test]
    fn native_stacked_mrs_need_gitlab_19_1() {
        assert!(version_at_least("19.1.0-ee", 19, 1));
        assert!(version_at_least("20.0.0-pre", 19, 1));
        assert!(!version_at_least("18.9.1", 19, 1));
        assert!(!version_at_least("19.0", 19, 1));
        assert!(!version_at_least("garbage", 19, 1));
        assert!(native_stacked_mrs(ForgeKind::GitLab, Some("19.1.2")));
        assert!(!native_stacked_mrs(ForgeKind::GitLab, None));
        assert!(!native_stacked_mrs(ForgeKind::GitHub, Some("19.1.2")));
    }
}
