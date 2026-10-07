//! The harness's integration tests, in one binary: each old `tests/<name>.rs` is a module here, so
//! a test is `<module>::<test>` (e.g. `forge_stacks::retarget_…`). One binary links once, where
//! sixteen each linked the whole core, forge and harness. Run one module with
//! `cargo test -p gitbolt-harness --test it forge_stacks::`.

mod askpass;
mod crlf;
mod details_latency;
mod fake_forge;
mod fake_forge_create;
mod fake_forge_stacks;
mod forge_accounts;
mod forge_author_names;
mod forge_comment_actions;
mod forge_cache;
mod forge_forks_paging;
mod forge_github;
mod forge_github_create;
mod forge_github_prs;
mod forge_gitlab;
mod forge_gitlab_create;
mod forge_gitlab_mrs;
mod forge_mrs;
mod forge_poll_cost;
mod forge_stacks;
mod markdown_images;
mod ws;
