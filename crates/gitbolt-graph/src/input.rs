//! What a graph is built from, as plain data: the caller reads it from the repository (gix in the
//! core, isomorphic-git in the website demo, which sends it as JSON).

use crate::payload::{HostKind, InProgress, TagAnnotation, WipCounts};
use crate::Oid;
use serde::Deserialize;
use ts_rs::TS;
use std::collections::{BTreeMap, HashMap, HashSet};

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
#[ts(export, export_to = "../../demo/gen/")]
pub enum RefKind {
    Local,
    Remote { remote: String },
    Tag,
}

/// One branch, remote branch or tag (`refs::read_refs`'s `RefInfo`).
#[derive(Debug, Clone, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../demo/gen/")]
pub struct RefIn {
    pub full_name: String,
    pub short_name: String,
    pub kind: RefKind,
    /// The commit it peels to.
    #[ts(type = "string")]
    pub target: Oid,
    #[serde(default)]
    pub upstream: Option<String>,
    /// A local branch's upstream short name when its branch name differs.
    #[serde(default)]
    pub upstream_mismatch: Option<String>,
    /// An annotated tag's message and tagger.
    #[serde(default)]
    pub annotation: Option<TagAnnotation>,
}

/// The repository handle's own HEAD (the main worktree's).
#[derive(Debug, Clone, Default, Deserialize, TS)]
#[serde(rename_all = "camelCase", default)]
#[ts(export, export_to = "../../demo/gen/")]
pub struct HeadIn {
    pub branch: Option<String>,
    #[ts(type = "string | null")]
    pub target: Option<Oid>,
    pub detached: bool,
    pub unborn: bool,
}

/// `stash@{index}`, newest first.
#[derive(Debug, Clone, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../demo/gen/")]
pub struct StashIn {
    #[ts(type = "number")]
    pub index: usize,
    #[ts(type = "string")]
    pub id: Oid,
    pub message: String,
    #[ts(type = "number")]
    pub time: i64,
}

/// `refs::RepoRefs` as plain data.
#[derive(Debug, Clone, Default, Deserialize, TS)]
#[serde(rename_all = "camelCase", default)]
#[ts(export, export_to = "../../demo/gen/")]
pub struct RefsIn {
    pub head: HeadIn,
    /// In the order gix lists references (byte order of the full names when they're packed).
    pub refs: Vec<RefIn>,
    /// Remote → the branch its `refs/remotes/<remote>/HEAD` names.
    pub remote_heads: HashMap<String, String>,
    pub remote_hosts: HashMap<String, HostKind>,
    pub remote_host_names: HashMap<String, String>,
    pub stashes: Vec<StashIn>,
    /// A local branch (full name) → the remote it pushes to when set apart from its upstream.
    pub push_remotes: HashMap<String, String>,
    /// Each remote's project, as its fetch URL names it.
    pub remote_ids: HashMap<String, String>,
    /// The MR/PR heads Compare fetched: graph tips, with no label.
    #[ts(type = "Array<string>")]
    pub compare_heads: Vec<Oid>,
}

/// One worktree as `git worktree list` has it.
#[derive(Debug, Clone, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../demo/gen/")]
pub struct WorktreeIn {
    /// As the payload spells it (a WIP row's id, `worktreePath`).
    pub path: String,
    /// What it's compared by (`workdir`, `active`).
    pub canonical: String,
    #[ts(type = "string | null")]
    pub head: Option<Oid>,
    /// The full ref its HEAD names.
    pub branch: Option<String>,
    pub is_main: bool,
    pub bare: bool,
    pub prunable: bool,
    pub locked: bool,
}

/// The forge's cached data on the remotes' projects (`ForgeHub::cached_forks`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize, TS)]
#[serde(rename_all = "camelCase", default)]
#[ts(export, export_to = "../../demo/gen/")]
pub struct ForkFacts {
    /// Remote → the remote whose project it's a fork of.
    pub parents: HashMap<String, String>,
    /// Remotes whose project is known and isn't a fork.
    pub roots: HashSet<String>,
    /// Remotes on a host a forge account covers: whether they're forks is the forge's to say.
    pub covered: HashSet<String>,
}

/// Everything but the commits.
#[derive(Debug, Clone, Default, Deserialize, TS)]
#[serde(rename_all = "camelCase", default)]
#[ts(export, export_to = "../../demo/gen/")]
pub struct GraphInput {
    pub refs: RefsIn,
    pub worktrees: Vec<WorktreeIn>,
    /// (index into `worktrees`, its counts) for every worktree with a WIP row, in worktree order.
    #[ts(type = "Array<[number, import('./WipCounts').WipCounts]>")]
    pub wip: Vec<(usize, WipCounts)>,
    /// Each worktree's operation in progress, keyed by its `path`. Copied into the payload as
    /// given: the caller lists only usable worktrees (neither bare nor prunable).
    pub in_progress: BTreeMap<String, InProgress>,
    /// The canonical worktree the graph is built in (the handle's), spelled as a `WorktreeIn`'s
    /// `canonical` is: the core canonicalises it, keeping the path as given when that fails.
    pub workdir: String,
    /// The canonical worktree laid out as the open one, canonicalised as `workdir` is; `None`:
    /// `workdir`. One that matches no worktree still stands for the open one: no row or label is
    /// then "here", and HEAD stays the handle's.
    pub active: Option<String>,
    pub pinned_ref: Option<String>,
    /// The pin setting `off`: nothing pinned, `pinned_ref` ignored.
    pub no_pin: bool,
    pub forks: ForkFacts,
}

/// `build`'s input: the graph input and how many commits to walk.
#[derive(Debug, Clone, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../demo/gen/")]
pub struct GraphRequest {
    #[serde(flatten)]
    pub input: GraphInput,
    #[ts(type = "number")]
    pub limit: usize,
}

/// A commit as the demo reads it: headers parsed, the message whole (`CommitMeta::from_message`).
#[derive(Debug, Clone, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../demo/gen/")]
pub struct CommitIn {
    #[ts(type = "string")]
    pub id: Oid,
    #[ts(type = "Array<string>")]
    pub parents: Vec<Oid>,
    pub author_name: String,
    pub author_email: String,
    #[ts(type = "number")]
    pub author_time: i64,
    #[ts(type = "number")]
    pub committer_time: i64,
    pub message: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_request_reads_from_the_demos_json() {
        let a = "a".repeat(40);
        let json = format!(
            r#"{{"limit": 5, "workdir": "/demo/x", "noPin": true, "wip": [[0, {{"modified": 2}}]],
                "refs": {{"head": {{"branch": "refs/heads/main", "target": "{a}"}},
                          "refs": [{{"fullName": "refs/remotes/origin/main", "shortName": "origin/main", "kind": {{"type": "remote", "remote": "origin"}}, "target": "{a}"}},
                                   {{"fullName": "refs/tags/v1", "shortName": "v1", "kind": {{"type": "tag"}}, "target": "{a}"}}]}},
                "worktrees": [{{"path": "/demo/x", "canonical": "/demo/x", "head": "{a}", "branch": "refs/heads/main", "isMain": true, "bare": false, "prunable": false, "locked": false}}]}}"#
        );
        let r: GraphRequest = serde_json::from_str(&json).unwrap();
        assert_eq!((r.limit, r.input.workdir.as_str(), r.input.no_pin, r.input.active.clone()), (5, "/demo/x", true, None));
        assert_eq!(r.input.wip, [(0, WipCounts { modified: 2, ..Default::default() })]);
        assert_eq!(r.input.refs.refs[0].kind, RefKind::Remote { remote: "origin".into() });
        assert_eq!(r.input.refs.refs[1].kind, RefKind::Tag);
        assert_eq!(r.input.refs.head.target, Oid::from_hex(&a));
        assert!(r.input.worktrees[0].is_main);
    }
}
