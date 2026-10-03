//! Branch names (spec #2 §9.1: "validated live with git's check-ref-format --branch rules").

/// git's ref-name rules (`check-ref-format` on `refs/heads/<name>`), plus the two `--branch`
/// adds: not `HEAD`, not starting with `-`. The reason, for the dialog. The explicit rules are
/// `ui/src/branches/branchName.ts`'s, word for word; gix's validation is the last word on the rest.
pub fn branch_name_error(name: &str) -> Option<&'static str> {
    if name.is_empty() {
        return Some("Enter a branch name");
    }
    if name == "HEAD" {
        return Some("HEAD isn't a branch name");
    }
    if name.starts_with('-') {
        return Some("A branch name can't start with -");
    }
    if name.chars().any(|c| (c as u32) <= 0x20 || c == '\u{7f}' || "~^:?*[\\".contains(c)) {
        return Some("A branch name can't contain spaces or ~ ^ : ? * [ \\");
    }
    if name.contains("..") {
        return Some("A branch name can't contain ..");
    }
    if name.contains("@{") || name == "@" {
        return Some("A branch name can't be @ or contain @{");
    }
    if name.starts_with('/') || name.ends_with('/') || name.contains("//") {
        return Some("A branch name can't have an empty part between slashes");
    }
    if name.ends_with('.') {
        return Some("A branch name can't end with .");
    }
    if name.split('/').any(|c| c.starts_with('.') || c.ends_with(".lock")) {
        return Some("No part of a branch name can start with . or end with .lock");
    }
    let full = format!("refs/heads/{name}");
    gix::refs::FullName::try_from(full.as_str()).is_err().then_some("Not a valid branch name")
}

/// The same ref-name rules for a tag (`git tag` refuses a leading `-` too), said of a tag:
/// `ui/src/tags/tagName.ts`'s words.
pub fn tag_name_error(name: &str) -> Option<String> {
    branch_name_error(name).map(|m| m.replace("branch", "tag"))
}

#[cfg(test)]
mod tests {
    use super::branch_name_error;
    use crate::testing::TestRepo;

    /// The same table as `ui/src/branches/branchName.test.ts`; git itself is the oracle.
    #[test]
    fn branch_names_follow_git() {
        let table = ["feature/x", "release.1/ü-x", "a..b", "a b", "a~b", "a^b", "a:b", "a?b", "a*b", "a[b", "a\\b", "a@{b", "a/", "a//b", "a.", ".a", "a/.b", "a.lock", "a/b.lock/c", "head", "x\u{7f}y"];
        let r = TestRepo::new();
        for name in table {
            let git_ok = r.try_git(&["check-ref-format", &format!("refs/heads/{name}")]).is_ok();
            assert_eq!(branch_name_error(name).is_none(), git_ok, "{name:?}");
        }
        assert_eq!(branch_name_error(""), Some("Enter a branch name"));
        assert_eq!(branch_name_error("HEAD"), Some("HEAD isn't a branch name"));
        assert_eq!(branch_name_error("-x"), Some("A branch name can't start with -"));
        assert_eq!(branch_name_error("@"), Some("A branch name can't be @ or contain @{"));
    }

    #[test]
    fn tag_names_follow_the_same_rules_said_of_a_tag() {
        assert_eq!(super::tag_name_error("").as_deref(), Some("Enter a tag name"));
        assert_eq!(super::tag_name_error("a..b").as_deref(), Some("A tag name can't contain .."));
        assert_eq!(super::tag_name_error("-x").as_deref(), Some("A tag name can't start with -"));
        assert_eq!(super::tag_name_error("v1.2.0"), None);
        assert_eq!(super::tag_name_error("release/ü-1"), None);
    }
}
