//! Commit details for the right panel (spec §9.1), and the parsed remotes that forge links are
//! built from (§14.4, no network). The message itself (§9.2) is `commit::read_commit_message`.

use crate::commit::{parse_commit, Signature};
use crate::error::{gix_err, GbError, GbErrorKind};
use crate::payload::{CoAuthor, CommitDetailsPayload, PersonPayload, RemotePayload};
use crate::remotes::{host_kind, parse_remote_url, remote_url, HostKind};
use gix::bstr::ByteSlice;
use gix::remote::Direction;
use gix::ObjectId;
use regex::Regex;
use std::collections::HashSet;
use std::sync::LazyLock;

static CO_AUTHOR: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?im)^[ \t]*co-authored-by:[ \t]*(.*?)[ \t]*<([^<>\s]+)>[ \t]*$").expect("valid regex"));

/// `Co-authored-by: Name <email>` trailers, case-insensitive, deduplicated by email (spec §9.1).
pub fn co_authors(message: &str) -> Vec<CoAuthor> {
    let mut seen = HashSet::new();
    CO_AUTHOR
        .captures_iter(message)
        .filter(|c| seen.insert(c[2].to_ascii_lowercase()))
        .map(|c| CoAuthor { name: c[1].trim().to_string(), email: c[2].to_string() })
        .collect()
}

/// The raw bytes of commit `id`, read in-process with gix (read-only). A missing object is
/// `NotFound`; an object that isn't a commit is `InvalidInput`.
pub fn read_commit(repo: &gix::Repository, id: ObjectId) -> Result<Vec<u8>, GbError> {
    let obj = repo.try_find_object(id).map_err(gix_err)?.ok_or_else(|| GbError::new(GbErrorKind::NotFound, format!("no such commit: {id}")))?;
    if obj.kind != gix::object::Kind::Commit {
        return Err(GbError::new(GbErrorKind::InvalidInput, format!("not a commit: {id}")));
    }
    Ok(obj.detach().data)
}

fn person(s: Signature) -> PersonPayload {
    PersonPayload { name: s.name, email: s.email, time: s.time }
}

pub fn commit_details(repo: &gix::Repository, id: ObjectId) -> Result<CommitDetailsPayload, GbError> {
    let c = parse_commit(&read_commit(repo, id)?)?;
    Ok(CommitDetailsPayload {
        id: id.to_string(),
        parents: c.parents.iter().map(|p| p.to_string()).collect(),
        co_authors: co_authors(&c.message),
        author: person(c.author),
        committer: person(c.committer),
        signed: c.signed,
    })
}

/// Every remote with its parsed host and project path. `origin` comes first, then the rest by
/// name, so the UI's "project remote" is simply the first one with a host.
pub fn remotes(repo: &gix::Repository) -> Vec<RemotePayload> {
    let mut out: Vec<RemotePayload> = repo
        .remote_names()
        .into_iter()
        .map(|n| {
            let name = n.to_str_lossy().into_owned();
            let parsed = remote_url(repo, &name, Direction::Fetch).and_then(|u| parse_remote_url(&u));
            let host_kind = parsed.as_ref().map(|u| host_kind(&u.host)).unwrap_or(HostKind::Generic);
            RemotePayload { host: parsed.as_ref().map(|u| u.host.clone()), path: parsed.map(|u| u.path), host_kind, name }
        })
        .collect();
    out.sort_by(|a, b| (a.name != "origin", &a.name).cmp(&(b.name != "origin", &b.name)));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::{fixtures, TestRepo};

    fn oid(s: &str) -> ObjectId {
        ObjectId::from_hex(s.as_bytes()).unwrap()
    }

    #[test]
    fn parses_co_author_trailers_case_insensitively() {
        let msg = "Fix\n\nBody\n\nCo-authored-by: Margaret Hamilton <margaret@example.com>\nco-authored-by: Linus Torvalds <linus@example.com>\nCO-AUTHORED-BY: Dup <MARGARET@example.com>\nSigned-off-by: X <x@y>\n";
        assert_eq!(
            co_authors(msg),
            vec![
                CoAuthor { name: "Margaret Hamilton".into(), email: "margaret@example.com".into() },
                CoAuthor { name: "Linus Torvalds".into(), email: "linus@example.com".into() },
            ]
        );
        assert!(co_authors("Co-authored-by: nobody").is_empty());
    }

    #[test]
    fn details_of_the_rename_commit() {
        let r = TestRepo::new();
        fixtures::details(&r);
        let repo = gix::open(r.path()).unwrap();
        let id = oid(&r.git(&["rev-parse", "HEAD^1"]));
        let d = commit_details(&repo, id).unwrap();
        assert_eq!(d.id, id.to_string());
        assert_eq!((d.author.name.as_str(), d.author.email.as_str()), ("Grace Hopper", "grace@example.com"));
        assert_eq!(d.committer.name, "Ada Lovelace");
        assert!(d.committer.time >= d.author.time);
        assert_eq!(d.co_authors.iter().map(|c| c.email.as_str()).collect::<Vec<_>>(), vec!["margaret@example.com", "linus@example.com"]);
        assert_eq!(d.parents, vec![r.git(&["rev-parse", "HEAD^1^1"])]);
        assert!(!d.signed);
        // The message itself is served by `commitMessage`; the fixture's round-trips exactly.
        assert_eq!(parse_commit(&read_commit(&repo, id).unwrap()).unwrap().message, fixtures::DETAILS_MESSAGE);
    }

    #[test]
    fn merge_commit_has_both_parents_in_order() {
        let r = TestRepo::new();
        fixtures::details(&r);
        let repo = gix::open(r.path()).unwrap();
        let d = commit_details(&repo, oid(&r.git(&["rev-parse", "HEAD"]))).unwrap();
        assert_eq!(d.parents, vec![r.git(&["rev-parse", "HEAD^1"]), r.git(&["rev-parse", "HEAD^2"])]);
        assert!(d.co_authors.is_empty());
    }

    #[test]
    fn missing_is_not_found_and_non_commit_is_invalid_input() {
        let r = TestRepo::new();
        fixtures::details(&r);
        let repo = gix::open(r.path()).unwrap();
        assert_eq!(commit_details(&repo, oid(&"1".repeat(40))).unwrap_err().kind, GbErrorKind::NotFound);
        let blob = oid(&r.git(&["rev-parse", "HEAD:feature.txt"]));
        assert_eq!(commit_details(&repo, blob).unwrap_err().kind, GbErrorKind::InvalidInput);
    }

    #[test]
    fn remotes_list_origin_first_with_host_kind() {
        let r = TestRepo::new();
        fixtures::details(&r);
        r.git(&["remote", "add", "backup", "/tmp/nowhere.git"]);
        let repo = gix::open(r.path()).unwrap();
        let list = remotes(&repo);
        assert_eq!(list[0], RemotePayload { name: "origin".into(), host: Some("gitlab.example.com".into()), path: Some("group/project".into()), host_kind: HostKind::GitLab });
        assert_eq!(list[1], RemotePayload { name: "backup".into(), host: None, path: None, host_kind: HostKind::Generic });
    }

    /// Deferred Rust minor #13: a remote configured through an `insteadOf` alias still gets a
    /// parsed host and forge links, since `remotes()` now goes through `remote_url` (gix's
    /// rewrite-aware lookup) instead of reading `remote.<name>.url` out of the config raw.
    #[test]
    fn remotes_resolve_instead_of_aliases() {
        let r = TestRepo::new();
        r.commit("a");
        r.git(&["config", "url.https://github.com/.insteadOf", "gh:"]);
        r.git(&["remote", "add", "origin", "gh:owner/repo.git"]);
        let repo = gix::open(r.path()).unwrap();
        let list = remotes(&repo);
        assert_eq!(list, vec![RemotePayload { name: "origin".into(), host: Some("github.com".into()), path: Some("owner/repo".into()), host_kind: HostKind::GitHub }]);
    }
}
