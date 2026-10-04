//! Add a remote (spec #4 §4 "4A": the Remote panel's +, a fork in a click). `git remote add`
//! writes only the repository's config, and isn't journaled (spec #2 §5.3 "Not journaled"):
//! 4A has no Remove remote to undo it with. The fetch that follows is its own request (`fetch`
//! with `remote`), so a failed fetch leaves the remote added and says why.

use crate::error::{GbError, GbErrorKind};
use crate::events::{ChangeKind, OpKind};
use crate::journal::UndoKind;
use crate::write::names::remote_name_error;
use crate::write::{Plan, Pre, Staging, WriteCx, WriteIntent};
use gix::bstr::ByteSlice;

pub(crate) struct AddRemote {
    pub name: String,
    pub url: String,
}

/// Why `url` can't be a remote's URL: empty; a leading `-`, which git would read as an option;
/// whitespace or control characters (a pasted line break).
pub fn remote_url_error(url: &str) -> Option<&'static str> {
    if url.is_empty() {
        return Some("Enter the remote's URL");
    }
    if url.starts_with('-') {
        return Some("A remote URL can't start with -");
    }
    if url.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Some("A remote URL can't contain spaces or control characters");
    }
    None
}

impl WriteIntent for AddRemote {
    type Outcome = ();
    fn kind(&self) -> OpKind {
        OpKind::Branch
    }
    /// Never the URL: it may carry credentials.
    fn label(&self) -> String {
        format!("add remote {}", self.name)
    }
    fn undo(&self) -> Option<UndoKind> {
        None
    }
    fn staging(&self) -> Staging {
        Staging::Keep
    }
    async fn plan(&self, pre: &Pre<'_>) -> Result<Plan, GbError> {
        if let Some(why) = remote_name_error(&self.name) {
            return Err(GbError::new(GbErrorKind::InvalidInput, why));
        }
        if let Some(why) = remote_url_error(&self.url) {
            return Err(GbError::new(GbErrorKind::InvalidInput, why));
        }
        let repo = gix::open(pre.root).map_err(crate::error::gix_err)?;
        if repo.remote_names().into_iter().any(|n| n.to_str_lossy() == self.name.as_str()) {
            return Err(GbError::new(GbErrorKind::InvalidInput, format!("A remote named {} already exists", self.name)));
        }
        Ok(Plan::default())
    }
    async fn run(&self, cx: &mut WriteCx<'_>) -> Result<(), GbError> {
        let inv = cx.git(["remote", "add", "--", self.name.as_str(), self.url.as_str()]);
        cx.run_git(inv).await?;
        cx.touch(ChangeKind::Config);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use crate::error::GbErrorKind;
    use crate::testing::TestRepo;
    use crate::write::test_support::{api, call, open, repo, wt};
    use serde_json::json;

    #[tokio::test]
    async fn adds_a_remote_without_a_journal_entry_and_fetches_only_it() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        // A remote whose fetch would fail: proves the fetch below doesn't run `--all`.
        r.git(&["remote", "add", "broken", "/nonexistent/broken.git"]);
        let fork = TestRepo::new();
        fork.commit("Fork work");
        let fork_branch = fork.git(&["branch", "--show-current"]);
        let api = api(data.path());
        let id = open(&api, &r).await;
        let url = fork.path().display().to_string();
        let res = call(&api, "addRemote", json!({"repo": id, "worktree": wt(r.path()), "name": "alice", "url": url})).await.unwrap();
        assert!(res["outcome"].is_null());
        assert_eq!(r.git(&["remote", "get-url", "alice"]), url);
        assert!(res["journal"]["undo"].is_null(), "not journaled");
        let fetched = call(&api, "fetch", json!({"repo": id, "background": false, "remote": "alice"})).await.unwrap();
        assert_eq!(fetched["status"], "done");
        assert_eq!(r.git(&["rev-parse", &format!("refs/remotes/alice/{fork_branch}")]), fork.git(&["rev-parse", "HEAD"]));
        // The handle was reopened: the sidebar knows the new remote and lists its branch.
        let sidebar = call(&api, "sidebar", json!({"repo": id})).await.unwrap();
        let alice = sidebar["remotes"].as_array().unwrap().iter().find(|g| g["name"] == "alice").cloned().unwrap_or_else(|| panic!("{sidebar}"));
        assert_eq!(alice["branches"][0]["name"], fork_branch.as_str());
        let remotes = call(&api, "remotes", json!({"repo": id})).await.unwrap();
        assert!(remotes.as_array().unwrap().iter().any(|r| r["name"] == "alice"), "{remotes}");
        let unknown = call(&api, "fetch", json!({"repo": id, "background": false, "remote": "nope"})).await.unwrap_err();
        assert_eq!((unknown.kind, unknown.message.as_str()), (GbErrorKind::NotFound, "No remote nope"));
    }

    #[tokio::test]
    async fn refuses_a_taken_name_a_bad_name_and_an_option_like_or_broken_url() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        r.git(&["remote", "add", "origin", "/nonexistent/origin.git"]);
        let api = api(data.path());
        let id = open(&api, &r).await;
        let before = r.git(&["config", "--local", "--list"]);
        for (name, url, why) in [
            ("origin", "/tmp/x.git", "A remote named origin already exists"),
            ("a b", "/tmp/x.git", "A remote name can't contain spaces or ~ ^ : ? * [ \\"),
            ("-x", "/tmp/x.git", "A remote name can't start with -"),
            ("ok", "", "Enter the remote's URL"),
            ("ok", "--upload-pack=touch /tmp/pwned", "A remote URL can't start with -"),
            ("ok", "https://gitlab.example.com/a b.git", "A remote URL can't contain spaces or control characters"),
            ("ok", "https://gitlab.example.com/a.git\n", "A remote URL can't contain spaces or control characters"),
        ] {
            let e = call(&api, "addRemote", json!({"repo": id, "worktree": wt(r.path()), "name": name, "url": url})).await.unwrap_err();
            assert_eq!((e.kind, e.message.as_str()), (GbErrorKind::InvalidInput, why), "{name:?} {url:?}");
        }
        assert_eq!(r.git(&["config", "--local", "--list"]), before, "nothing written");
    }

    #[test]
    fn remote_names_follow_git_said_of_a_remote() {
        use crate::write::names::remote_name_error;
        assert_eq!(remote_name_error("").as_deref(), Some("Enter a remote name"));
        assert_eq!(remote_name_error("a..b").as_deref(), Some("A remote name can't contain .."));
        assert_eq!(remote_name_error("alice"), None);
        assert_eq!(remote_name_error("team/alice"), None);
    }
}
