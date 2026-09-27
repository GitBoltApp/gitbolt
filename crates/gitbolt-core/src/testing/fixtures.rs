//! Named repositories shared by unit tests, the harness and Playwright.
//!
//! `basic` history (newest first once built):
//!   stash "On main: Experiment"        (on top of the merge)
//!   hotfix: "Hotfix: null check"       (local only; checked out in worktree wt-hotfix, which is dirty)
//!   main:   "Merge branch 'feature/login'"  == origin/main, main worktree is dirty
//!           "Fix typo"
//!   feature/login: "Login validation" == origin/feature/login, "Login form"
//!           "Add readme"  (tag v1.0)
//!           "Initial commit"

use super::TestRepo;

pub fn basic(r: &TestRepo) {
    r.commit_as("Initial commit", "Ada Lovelace", "ada@example.com");
    let readme = r.commit_as("Add readme", "Grace Hopper", "grace@example.com");
    r.add_origin();
    r.push("main");
    r.git(&["remote", "set-head", "origin", "main"]);
    r.tag("v1.0", &readme);
    r.switch_new("feature/login");
    r.commit_as("Login form", "Linus Torvalds", "linus@example.com");
    r.commit_as("Login validation", "Linus Torvalds", "linus@example.com");
    r.push("feature/login");
    r.switch("main");
    r.commit_as("Fix typo", "Ada Lovelace", "ada@example.com");
    r.merge("feature/login", "Merge branch 'feature/login'");
    r.push("main");
    r.switch_new("hotfix");
    r.commit_as("Hotfix: null check", "Grace Hopper", "grace@example.com");
    r.switch("main");
    r.stash("Experiment");
    let wt = r.add_worktree("hotfix", "hotfix");
    std::fs::write(wt.join("file_0.txt"), "worktree change\n").expect("write worktree file");
    r.write("file_1.txt", "main change\n");
}

/// `git init` with no commits (unborn HEAD).
pub fn unborn(_r: &TestRepo) {}

/// A commit carrying a very long branch name plus a tag, so the label chip truncates and the
/// row picks up a `+1` badge. Used only by the connector/truncation Playwright assertions.
pub fn long_labels(r: &TestRepo) {
    r.commit_as("Initial commit", "Ada Lovelace", "ada@example.com");
    r.switch_new("feature/this-is-an-extremely-long-branch-name-designed-to-overflow-the-label-chip-and-force-truncation-in-the-commit-graph-ui");
    let tip = r.commit_as("Long label commit", "Ada Lovelace", "ada@example.com");
    r.tag("also-tagged-here", &tip);
}
