//! Forge versions (spec #4 §3.2): GitLab's gates its native stacked merge requests.

use crate::forge::types::ForgeKind;

/// GitLab's native stacked merge requests (spec #4 §2 "Stacks").
pub const NATIVE_STACKS_GITLAB: (u32, u32) = (19, 1);

/// `version` (`19.1.0-ee`, `20.0.0-pre`) is at least `major.minor`. Unreadable is no.
pub fn version_at_least(version: &str, major: u32, minor: u32) -> bool {
    let mut parts = version.trim().split(['.', '-']);
    let (Some(Ok(a)), Some(Ok(b))) = (parts.next().map(str::parse::<u32>), parts.next().map(str::parse::<u32>)) else { return false };
    (a, b) >= (major, minor)
}

pub fn native_stacked_mrs(kind: ForgeKind, version: Option<&str>) -> bool {
    kind == ForgeKind::GitLab && version.is_some_and(|v| version_at_least(v, NATIVE_STACKS_GITLAB.0, NATIVE_STACKS_GITLAB.1))
}
