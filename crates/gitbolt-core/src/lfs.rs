//! Git LFS, for repositories that use it. Reads go through gix, so an LFS-tracked blob reads as
//! its pointer (`version https://git-lfs.github.com/spec/v1`, `oid sha256:…`, `size …`); the
//! readers here turn a pointer into the real file from the local LFS store, when it's there
//! (`blob::resolve`). Downloading, tracking and the rest are writes (`write/lfs.rs`), through
//! `git lfs`.

use crate::error::{GbError, GbErrorKind};
use crate::git::{GitCli, GitInvocation};
use serde::Serialize;
use std::path::{Path, PathBuf};
use ts_rs::TS;

/// git-lfs never treats a blob this large or larger as a pointer (its `blobSizeCutoff`).
pub const POINTER_MAX: u64 = 1024;

/// The pointer formats' `version` lines: the current one, and the pre-1.0 one git-lfs still reads.
const VERSIONS: [&str; 2] = ["https://git-lfs.github.com/spec/v1", "https://hawser.github.com/spec/v1"];

/// Where install instructions are (the status bar's notice links there).
pub const INSTALL_URL: &str = "https://git-lfs.com";

/// An LFS pointer file's object: its SHA-256 (lowercase hex) and the real file's size.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pointer {
    pub oid: String,
    pub size: u64,
}

/// `bytes` as an LFS pointer, if they're one: under `POINTER_MAX`, UTF-8, a known `version` line
/// first, then `key value` lines with a `sha256:` oid and a size.
pub fn parse_pointer(bytes: &[u8]) -> Option<Pointer> {
    if bytes.len() as u64 >= POINTER_MAX {
        return None;
    }
    let text = std::str::from_utf8(bytes).ok()?;
    let mut lines = text.lines();
    let version = lines.next()?.strip_prefix("version ")?;
    if !VERSIONS.contains(&version) {
        return None;
    }
    let (mut oid, mut size) = (None, None);
    for line in lines {
        let (key, value) = line.split_once(' ')?;
        if key.is_empty() || !key.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'.') {
            return None;
        }
        match key {
            "oid" => oid = Some(value.strip_prefix("sha256:")?.to_string()),
            "size" => size = Some(value.parse::<u64>().ok()?),
            _ => {}
        }
    }
    let oid = oid.filter(|o| o.len() == 64 && o.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))?;
    Some(Pointer { oid, size: size? })
}

/// The LFS store: `lfs.storage` (a relative one is inside the git directory), else
/// `<common dir>/lfs`. Every worktree shares the main one's.
pub fn storage_dir(repo: &gix::Repository) -> PathBuf {
    let common = repo.common_dir();
    match repo.config_snapshot().string("lfs.storage").map(|s| s.to_string()).filter(|s| !s.trim().is_empty()) {
        Some(s) if Path::new(&s).is_absolute() => PathBuf::from(s),
        Some(s) => common.join(s),
        None => common.join("lfs"),
    }
}

/// Where the store keeps `oid`: `objects/aa/bb/<oid>`.
pub fn object_path(storage: &Path, oid: &str) -> PathBuf {
    storage.join("objects").join(&oid[..2]).join(&oid[2..4]).join(oid)
}

/// The real file of `p` in the local store, when it's there in full (its size checked; hashing a
/// large file on every read would cost more than it's worth). A regular file only: a symlink
/// planted in the store is never followed.
pub fn cached(repo: &gix::Repository, p: &Pointer) -> Option<PathBuf> {
    let path = object_path(&storage_dir(repo), &p.oid);
    stored(&path).filter(|m| m.len() == p.size).map(|_| path)
}

/// The store's object at `path`, if it's a regular file (not followed if a symlink).
pub fn stored(path: &Path) -> Option<std::fs::Metadata> {
    std::fs::symlink_metadata(path).ok().filter(std::fs::Metadata::is_file)
}

/// A `.gitattributes` text that routes something through LFS: a `filter=lfs` on a line that isn't
/// a comment.
pub fn names_lfs(attributes: &[u8]) -> bool {
    !lfs_patterns(attributes).is_empty()
}

/// The patterns of a `.gitattributes` text's lines that route files through LFS, in order.
pub fn lfs_patterns(attributes: &[u8]) -> Vec<String> {
    let text = String::from_utf8_lossy(attributes);
    let rules = text.lines().map(str::trim).filter(|l| !l.starts_with('#'));
    rules.filter_map(|l| {
        let mut words = l.split_whitespace();
        let pattern = words.next()?;
        words.any(|a| a == "filter=lfs").then(|| pattern.to_string())
    })
    .collect()
}

/// The working tree's top `.gitattributes`' LFS patterns (`lfs_patterns`): where `git lfs track`
/// writes, and so what Stop tracking can remove.
pub fn top_patterns(root: &Path) -> Vec<String> {
    std::fs::read(root.join(".gitattributes")).map(|b| lfs_patterns(&b)).unwrap_or_default()
}

/// Whether the repository uses LFS, cheaply, with no git-lfs: a `.gitattributes` anywhere in the
/// index (or the working tree's top one, `info/attributes`) routes files through LFS, or the
/// LFS store already holds objects. (Without that, `git lfs ls-files` would read every small blob
/// of the tree to find pointers.)
pub fn uses_lfs(repo: &gix::Repository) -> bool {
    if let Ok(index) = repo.index_or_empty() {
        let attrs = index.entries().iter().filter(|e| {
            let p = e.path(&index);
            p == ".gitattributes" || p.ends_with(b"/.gitattributes")
        });
        for e in attrs {
            if repo.find_object(e.id).is_ok_and(|o| names_lfs(&o.data)) {
                return true;
            }
        }
    }
    let files = [repo.workdir().map(|w| w.join(".gitattributes")), Some(repo.common_dir().join("info").join("attributes"))];
    if files.into_iter().flatten().any(|f| std::fs::read(f).is_ok_and(|b| names_lfs(&b))) {
        return true;
    }
    let objects = storage_dir(repo).join("objects");
    std::fs::read_dir(objects).is_ok_and(|mut d| d.next().is_some())
}

/// The remote git-lfs fetches from when a command names refs (and so must name one too), as
/// git-lfs picks it: `remote.lfsdefault`, HEAD's branch's remote, `origin`, else the only remote.
pub fn default_remote(repo: &gix::Repository) -> Option<String> {
    let names: Vec<String> = repo.remote_names().into_iter().map(|n| n.to_string()).collect();
    let known = |n: String| names.contains(&n).then_some(n);
    let config = repo.config_snapshot();
    let branch_remote = || crate::write::integrate::head_branch(repo).and_then(|b| config.string(format!("branch.{b}.remote").as_str())).map(|s| s.to_string());
    config
        .string("remote.lfsdefault")
        .map(|s| s.to_string())
        .and_then(known)
        .or_else(|| branch_remote().and_then(known))
        .or_else(|| known("origin".into()))
        .or_else(|| (names.len() == 1).then(|| names[0].clone()))
}

/// git-lfs is set up for the repository: `git lfs install` configured its `filter.lfs.*` (in any
/// config file the repository reads). Without it git-lfs checks nothing out, and new files of a
/// tracked type are committed whole.
pub fn filter_configured(repo: &gix::Repository) -> bool {
    let config = repo.config_snapshot();
    ["filter.lfs.process", "filter.lfs.smudge"].into_iter().any(|k| config.string(k).is_some())
}

/// `git lfs version`'s `git-lfs/3.4.1 (GitHub; linux amd64; go 1.21.5)`: `3.4.1`.
pub fn parse_version(out: &str) -> Option<String> {
    let v = out.trim().strip_prefix("git-lfs/")?.split_whitespace().next()?;
    (!v.is_empty()).then(|| v.to_string())
}

/// git-lfs's version, or `None` when it isn't installed (git says `lfs` isn't a git command).
pub async fn installed(cli: &GitCli, cwd: &Path) -> Option<String> {
    let out = cli.run(GitInvocation::new(cwd, ["lfs", "version"])).await.ok()?;
    parse_version(&String::from_utf8_lossy(&out.stdout))
}

/// What a repository's LFS needs from the UI, read once per repository opened (`lfsStatus`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct LfsStatusPayload {
    /// The repository uses LFS (`uses_lfs`): nothing about LFS shows otherwise.
    pub used: bool,
    /// git-lfs's version; `None`: not installed (LFS files then check out as pointers).
    pub version: Option<String>,
    /// Install instructions, for the "isn't installed" notice.
    pub install_url: String,
    /// The main working tree's top `.gitattributes` LFS patterns (`top_patterns`): Stop
    /// tracking is offered for a `*.<ext>` among them.
    pub patterns: Vec<String>,
    /// git-lfs is set up here (`filter_configured`); else Track warns to run `git lfs install`.
    pub filter: bool,
}

/// An LFS-stored side of a diff (`BlobPayload::lfs`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct LfsSide {
    pub oid: String,
    /// The real file's size.
    #[ts(type = "number")]
    pub size: u64,
    /// The real file is in the local store, and the side's contents are its. `false`: the side
    /// has no contents (the UI shows "not downloaded" and Download).
    pub downloaded: bool,
    /// The pointer as stored, for "Show pointer".
    pub pointer: String,
}

/// `git check-attr -z --stdin filter` output (`path NUL filter NUL value NUL` per path): the paths
/// whose `filter` is `lfs`.
pub fn lfs_paths(out: &[u8]) -> Vec<String> {
    let fields: Vec<&[u8]> = out.split(|b| *b == 0).collect();
    fields.chunks(3).filter(|t| t.len() == 3 && t[1] == b"filter" && t[2] == b"lfs").map(|t| String::from_utf8_lossy(t[0]).into_owned()).collect()
}

/// Which of `paths` LFS stores, by the worktree's attributes: one `check-attr` for them all.
pub async fn tracked(cli: &GitCli, root: &Path, paths: &[String]) -> Result<Vec<String>, GbError> {
    if paths.is_empty() {
        return Ok(Vec::new());
    }
    for p in paths {
        crate::blob::check_relative(p)?;
    }
    let mut stdin = Vec::new();
    for p in paths {
        stdin.extend_from_slice(p.as_bytes());
        stdin.push(0);
    }
    let out = cli.run(GitInvocation::new(root, ["check-attr", "-z", "--stdin", "filter"]).stdin(stdin)).await?;
    Ok(lfs_paths(&out.stdout))
}

/// A Track / Stop tracking pattern: `*.<ext>`, as the file menu offers it. Anything else (a
/// path, a glob with `/`, a leading `-` git-lfs would read as an option) is refused.
pub fn check_pattern(pattern: &str) -> Result<(), GbError> {
    let ext = pattern.strip_prefix("*.").unwrap_or("");
    let ok = !ext.is_empty() && ext.len() <= 64 && !ext.chars().any(|c| c.is_whitespace() || c.is_control() || "/\\*?[]!#\"'".contains(c));
    if ok { Ok(()) } else { Err(GbError::new(GbErrorKind::InvalidInput, format!("not an extension pattern: {pattern:?}"))) }
}

/// `path` as a git-lfs pattern (`--include`, `checkout`) that matches it alone: its wildmatch
/// characters escaped with `\`. A comma separates `--include` patterns and can't be escaped, so
/// such a path is refused rather than widened to every file.
pub fn include_pattern(path: &str) -> Result<String, GbError> {
    if path.is_empty() || path.contains(',') {
        return Err(GbError::new(GbErrorKind::InvalidInput, format!("git-lfs can't download {path} on its own: its name has a comma")));
    }
    let mut out = String::with_capacity(path.len() + 4);
    for c in path.chars() {
        if "\\*?[]!#".contains(c) {
            out.push('\\');
        }
        out.push(c);
    }
    Ok(out)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::testing::TestRepo;

    pub(crate) const OID: &str = "4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393";

    pub(crate) fn pointer_text(oid: &str, size: u64) -> String {
        format!("version https://git-lfs.github.com/spec/v1\noid sha256:{oid}\nsize {size}\n")
    }

    #[test]
    fn parses_pointers_and_nothing_else() {
        let p = parse_pointer(pointer_text(OID, 12345).as_bytes()).unwrap();
        assert_eq!((p.oid.as_str(), p.size), (OID, 12345));
        let ext = format!("version https://git-lfs.github.com/spec/v1\next-0-foo sha256:{OID}\noid sha256:{OID}\nsize 3\n");
        assert_eq!(parse_pointer(ext.as_bytes()).unwrap().size, 3, "extension lines are allowed");
        let hawser = format!("version https://hawser.github.com/spec/v1\noid sha256:{OID}\nsize 1\n");
        assert!(parse_pointer(hawser.as_bytes()).is_some());
        for bad in [
            String::new(),
            "hello\n".to_string(),
            format!("version https://example.com/spec/v1\noid sha256:{OID}\nsize 1\n"),
            format!("version https://git-lfs.github.com/spec/v1\noid sha256:{OID}\n"),
            "version https://git-lfs.github.com/spec/v1\nsize 1\n".to_string(),
            format!("version https://git-lfs.github.com/spec/v1\noid sha1:{OID}\nsize 1\n"),
            format!("version https://git-lfs.github.com/spec/v1\noid sha256:{}\nsize 1\n", &OID[..60]),
            format!("version https://git-lfs.github.com/spec/v1\noid sha256:{}\nsize 1\n", OID.to_uppercase()),
            format!("version https://git-lfs.github.com/spec/v1\noid sha256:{OID}\nsize -1\n"),
            format!("version https://git-lfs.github.com/spec/v1\noid sha256:{OID}\nsize 1\nNot A Key\n"),
            format!("{}{}", pointer_text(OID, 1), "x ".repeat(600)),
        ] {
            assert!(parse_pointer(bad.as_bytes()).is_none(), "{bad:?}");
        }
    }

    #[test]
    fn the_store_is_in_the_common_dir_unless_configured() {
        let r = TestRepo::new();
        r.write("a.txt", "a\n");
        r.git(&["add", "a.txt"]);
        r.git(&["commit", "-q", "-m", "a"]);
        let repo = gix::open(r.path()).unwrap();
        let common = repo.common_dir().to_path_buf();
        assert_eq!(storage_dir(&repo), common.join("lfs"));
        assert_eq!(object_path(&storage_dir(&repo), OID), common.join("lfs/objects/4d/7a").join(OID));
        // A linked worktree shares it.
        let linked = r.root().join("linked");
        r.git(&["worktree", "add", "-q", "-b", "side", linked.to_str().unwrap()]);
        std::fs::create_dir_all(common.join("lfs")).unwrap();
        let canonical = |p: PathBuf| crate::platform::fs::canonicalize(p).unwrap();
        assert_eq!(canonical(storage_dir(&gix::open(&linked).unwrap())), canonical(common.join("lfs")));
        r.git(&["config", "lfs.storage", "elsewhere"]);
        assert_eq!(storage_dir(&gix::open(r.path()).unwrap()), common.join("elsewhere"));
        let abs = r.root().join("shared-lfs");
        r.git(&["config", "lfs.storage", abs.to_str().unwrap()]);
        assert_eq!(storage_dir(&gix::open(r.path()).unwrap()), abs);
    }

    #[test]
    fn a_cached_object_needs_its_full_size() {
        let r = TestRepo::new();
        let repo = gix::open(r.path()).unwrap();
        let p = Pointer { oid: OID.into(), size: 5 };
        assert_eq!(cached(&repo, &p), None);
        let path = object_path(&storage_dir(&repo), OID);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, b"1234").unwrap();
        assert_eq!(cached(&repo, &p), None, "a partial download isn't the file");
        std::fs::write(&path, b"12345").unwrap();
        assert_eq!(cached(&repo, &p), Some(path.clone()));
        #[cfg(unix)]
        {
            let elsewhere = r.root().join("elsewhere");
            std::fs::write(&elsewhere, b"12345").unwrap();
            std::fs::remove_file(&path).unwrap();
            std::os::unix::fs::symlink(&elsewhere, &path).unwrap();
            assert_eq!(cached(&repo, &p), None, "a symlink in the store isn't followed");
        }
    }

    #[test]
    fn uses_lfs_reads_attributes_and_the_store() {
        let r = TestRepo::new();
        r.write("a.txt", "a\n");
        r.write(".gitattributes", "*.txt text\n# *.psd filter=lfs\n");
        r.write("sub/.gitattributes", "*.md text\n");
        r.git(&["add", "."]);
        r.git(&["commit", "-q", "-m", "a"]);
        assert!(!uses_lfs(&gix::open(r.path()).unwrap()), "a comment isn't a rule");
        r.write("sub/.gitattributes", "*.psd filter=lfs diff=lfs merge=lfs -text\n");
        r.git(&["commit", "-qam", "lfs"]);
        assert!(uses_lfs(&gix::open(r.path()).unwrap()), "a nested .gitattributes counts");

        let fresh = TestRepo::new();
        assert!(!uses_lfs(&gix::open(fresh.path()).unwrap()));
        fresh.write(".gitattributes", "*.bin filter=lfs -text\n");
        assert!(uses_lfs(&gix::open(fresh.path()).unwrap()), "git lfs track's edit, not committed yet");
        let stored = TestRepo::new();
        std::fs::create_dir_all(stored.path().join(".git/lfs/objects/4d")).unwrap();
        assert!(uses_lfs(&gix::open(stored.path()).unwrap()), "objects in the store");
    }

    #[test]
    fn parses_versions_and_check_attr_output() {
        assert_eq!(parse_version("git-lfs/3.4.1 (GitHub; linux amd64; go 1.21.5)\n").as_deref(), Some("3.4.1"));
        assert_eq!(parse_version("git: 'lfs' is not a git command."), None);
        assert_eq!(lfs_paths(b"a.psd\0filter\0lfs\0b.txt\0filter\0unspecified\0c.bin\0filter\0lfs\0"), ["a.psd", "c.bin"]);
        let attrs = b"# *.zip filter=lfs\n*.psd filter=lfs diff=lfs merge=lfs -text\n*.txt text\n  assets/** filter=lfs\n";
        assert_eq!(lfs_patterns(attrs), ["*.psd", "assets/**"]);
        assert!(lfs_paths(b"").is_empty());
    }

    #[test]
    fn patterns_are_extension_globs_only() {
        for ok in ["*.psd", "*.tar.gz", "*.PNG", "*.blend1"] {
            assert!(check_pattern(ok).is_ok(), "{ok}");
        }
        for bad in ["", "*.", "psd", "*.ps d", "--global", "*.a/b", "*.*", "*.[ab]", "*.a\nb", "dir/*.psd", "*.!x"] {
            assert_eq!(check_pattern(bad).unwrap_err().kind, GbErrorKind::InvalidInput, "{bad:?}");
        }
        assert_eq!(include_pattern("assets/logo.psd").unwrap(), "assets/logo.psd");
        assert_eq!(include_pattern("art/a[1]*?.psd").unwrap(), r"art/a\[1\]\*\?.psd");
        assert_eq!(include_pattern(r"!#x\y.psd").unwrap(), r"\!\#x\\y.psd");
        let comma = include_pattern("a,b.psd").unwrap_err();
        assert!(comma.message.contains("comma"), "{}", comma.message);
    }

    #[tokio::test]
    async fn tracked_paths_come_from_check_attr() {
        let r = TestRepo::new();
        r.write(".gitattributes", "*.psd filter=lfs diff=lfs merge=lfs -text\nassets/** filter=lfs\n");
        let cli = GitCli::new(std::sync::Arc::new(crate::log::CommandLog::new(10))).with_env(crate::testing::isolated_git_env());
        let paths = ["a.psd", "b.txt", "assets/x.bin", "deep/c.psd"].map(String::from);
        assert_eq!(tracked(&cli, r.path(), &paths).await.unwrap(), ["a.psd", "assets/x.bin", "deep/c.psd"]);
        assert!(tracked(&cli, r.path(), &[]).await.unwrap().is_empty());
        assert_eq!(tracked(&cli, r.path(), &["../x.psd".to_string()]).await.unwrap_err().kind, GbErrorKind::InvalidInput);
    }
}
