//! The demo's and the playground's repositories (`gitvolt-harness showcase <name> <dir>`):
//! Orbital, and the playground's nine in Orbital's world. Named like the core's test fixtures
//! but separate from them: tests keep their fixtures; these are for people to look at.

use gitvolt_core::testing::TestRepo;

pub const NAMES: [&str; 10] = ["orbital", "basic", "sync", "conflicts", "stack", "wip_staging", "rebase_lab", "previews", "submodules", "lfs"];

/// Builds showcase `name` into `r`; false if it isn't one (yet).
pub fn build(name: &str, r: &TestRepo) -> bool {
    match name {
        "orbital" => crate::orbital::build(r),
        "basic" => crate::playground::basic(r),
        "sync" => crate::playground::sync(r),
        "conflicts" => crate::playground::conflicts(r),
        "stack" => crate::playground::stack(r),
        "wip_staging" => crate::playground::wip_staging(r),
        "rebase_lab" => crate::playground::rebase_lab(r),
        "previews" => crate::playground::previews(r),
        "submodules" => crate::playground::submodules(r),
        "lfs" => crate::playground::lfs(r),
        _ => return false,
    }
    true
}
