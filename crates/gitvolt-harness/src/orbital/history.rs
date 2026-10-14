//! Orbital's history as one `git fast-import` stream: deduplicated blobs, commits naming their
//! parents, authors, committers and dates, annotated tags, refs. 2,000 commits import in about
//! a second; running `git commit` 2,000 times took close to a minute (measured 2026-10-12).

use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::ffi::OsString;
use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};
use std::rc::Rc;

pub type Mark = u32;

#[derive(Clone, Copy, Debug)]
pub struct Sig<'a> {
    pub name: &'a str,
    pub email: &'a str,
    pub time: i64,
    pub tz_minutes: i32,
}

impl Sig<'_> {
    fn line(&self) -> String {
        format!(
            "{} <{}> {} {}",
            self.name,
            self.email,
            self.time,
            tz(self.tz_minutes)
        )
    }
}

pub fn tz(minutes: i32) -> String {
    let sign = if minutes < 0 { '-' } else { '+' };
    let m = minutes.abs();
    format!("{sign}{:02}{:02}", m / 60, m % 60)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Change {
    Put { path: String, mode: u32, blob: Mark },
    Delete(String),
}

/// The branch every commit is written on while the stream runs (each commit names its parents,
/// so this ref only has to exist). The stream deletes it at the end; deleting it again is a
/// no-op.
pub const SCRATCH: &str = "refs/orbital/scratch";

#[derive(Default)]
pub struct History {
    out: Vec<u8>,
    next: Mark,
    blobs: HashMap<[u8; 32], Mark>,
    commits: usize,
}

fn mode_for(path: &str) -> u32 {
    if path.ends_with(".sh") {
        0o100755
    } else {
        0o100644
    }
}

/// fast-import takes a path verbatim to the end of the line unless it starts with a quote or
/// holds a newline.
fn path_arg(path: &str) -> String {
    if path.starts_with('"') || path.contains('\n') {
        format!(
            "\"{}\"",
            path.replace('\\', "\\\\")
                .replace('"', "\\\"")
                .replace('\n', "\\n")
        )
    } else {
        path.to_string()
    }
}

impl History {
    pub fn new() -> History {
        History::default()
    }

    fn mark(&mut self) -> Mark {
        self.next += 1;
        self.next
    }

    fn data(&mut self, bytes: &[u8]) {
        self.out
            .extend_from_slice(format!("data {}\n", bytes.len()).as_bytes());
        self.out.extend_from_slice(bytes);
        self.out.push(b'\n');
    }

    pub fn blob(&mut self, bytes: &[u8]) -> Mark {
        let key: [u8; 32] = Sha256::digest(bytes).into();
        if let Some(&m) = self.blobs.get(&key) {
            return m;
        }
        let m = self.mark();
        self.out
            .extend_from_slice(format!("blob\nmark :{m}\n").as_bytes());
        self.data(bytes);
        self.blobs.insert(key, m);
        m
    }

    /// Each path rendered: a `Put` (`.sh` files executable) or, when it renders to nothing, a
    /// `Delete`.
    pub fn changes(
        &mut self,
        paths: impl IntoIterator<Item = String>,
        render: impl Fn(&str) -> Option<Rc<[u8]>>,
    ) -> Vec<Change> {
        paths
            .into_iter()
            .map(|path| match render(&path) {
                Some(bytes) => Change::Put {
                    mode: mode_for(&path),
                    blob: self.blob(&bytes),
                    path,
                },
                None => Change::Delete(path),
            })
            .collect()
    }

    fn header(&mut self, author: Sig, committer: Sig, message: &str) -> Mark {
        let m = self.mark();
        let head = format!(
            "commit {SCRATCH}\nmark :{m}\nauthor {}\ncommitter {}\n",
            author.line(),
            committer.line()
        );
        self.out.extend_from_slice(head.as_bytes());
        let msg = if message.ends_with('\n') {
            message.to_string()
        } else {
            format!("{message}\n")
        };
        self.data(msg.as_bytes());
        m
    }

    fn body(&mut self, changes: &[Change]) {
        for c in changes {
            let line = match c {
                Change::Put { path, mode, blob } => {
                    format!("M {mode:o} :{blob} {}\n", path_arg(path))
                }
                Change::Delete(path) => format!("D {}\n", path_arg(path)),
            };
            self.out.extend_from_slice(line.as_bytes());
        }
        self.out.push(b'\n');
        self.commits += 1;
    }

    /// A commit on the given parents, the first one's tree plus `changes`. No parents makes a
    /// root commit with only `changes` in its tree.
    pub fn commit(
        &mut self,
        parents: &[Mark],
        author: Sig,
        committer: Sig,
        message: &str,
        changes: &[Change],
    ) -> Mark {
        if parents.is_empty() {
            // Without a `from`, fast-import would build on the scratch branch's current tip.
            self.out
                .extend_from_slice(format!("reset {SCRATCH}\n\n").as_bytes());
        }
        let m = self.header(author, committer, message);
        if let Some(first) = parents.first() {
            self.out
                .extend_from_slice(format!("from :{first}\n").as_bytes());
        }
        for p in parents.iter().skip(1) {
            self.out
                .extend_from_slice(format!("merge :{p}\n").as_bytes());
        }
        self.body(changes);
        m
    }

    /// A commit on top of one already in the repository (a second stream: the teammate's push).
    pub fn commit_after(
        &mut self,
        parent_sha: &str,
        author: Sig,
        committer: Sig,
        message: &str,
        changes: &[Change],
    ) -> Mark {
        let m = self.header(author, committer, message);
        self.out
            .extend_from_slice(format!("from {parent_sha}\n").as_bytes());
        self.body(changes);
        m
    }

    /// An annotated tag; `name` is the short name (`v0.1.0`).
    pub fn tag(&mut self, name: &str, target: Mark, tagger: Sig, message: &str) {
        self.out.extend_from_slice(
            format!("tag {name}\nfrom :{target}\ntagger {}\n", tagger.line()).as_bytes(),
        );
        self.data(message.as_bytes());
    }

    /// Points a ref (in full: `refs/heads/main`) at a commit when the import ends.
    pub fn reset(&mut self, refname: &str, target: Mark) {
        self.out
            .extend_from_slice(format!("reset {refname}\nfrom :{target}\n\n").as_bytes());
    }

    pub fn commits(&self) -> usize {
        self.commits
    }

    pub fn finish(mut self) -> Vec<u8> {
        // A null `from` deletes the scratch branch. Leaving it would also make a second stream
        // into the same repository fail when its last commit doesn't descend from the first's.
        self.out.extend_from_slice(
            format!("reset {SCRATCH}\nfrom {}\n\ndone\n", "0".repeat(40)).as_bytes(),
        );
        self.out
    }
}

/// Runs `git fast-import` on `stream` in `git_dir` (a `.git` directory or a bare repository),
/// with the user's git config kept out. On failure, the error is git's own message.
pub fn fast_import(
    git_dir: &Path,
    stream: &[u8],
    export_marks: Option<&Path>,
) -> Result<(), String> {
    let mut cmd = Command::new("git");
    cmd.arg("--git-dir").arg(git_dir).args([
        "fast-import",
        "--quiet",
        "--done",
        "--date-format=raw",
    ]);
    if let Some(m) = export_marks {
        let mut arg = OsString::from("--export-marks=");
        arg.push(m);
        cmd.arg(arg);
    }
    let mut child = cmd
        .envs(crate::orbital::people::git_env())
        // fast-import writes a reflog entry as the committer, stamped now: pin all three.
        .env("GIT_COMMITTER_NAME", crate::orbital::people::person("rafe").name)
        .env("GIT_COMMITTER_EMAIL", crate::orbital::people::person("rafe").email)
        .env("GIT_COMMITTER_DATE", format!("@{} +0000", crate::orbital::calendar::END))
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("run git fast-import: {e}"))?;
    let mut stdin = child.stdin.take().expect("piped stdin");
    // Feed the stream from another thread so a git that fills its stderr pipe can't deadlock us.
    // If git stops early its stderr says why; a broken pipe on our side says nothing useful.
    let (written, out) = std::thread::scope(|s| {
        let writer = s.spawn(move || stdin.write_all(stream));
        let out = child.wait_with_output();
        (writer.join().expect("stream writer"), out)
    });
    let out = out.map_err(|e| format!("wait for git fast-import: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).into_owned());
    }
    written.map_err(|e| format!("write the fast-import stream: {e}"))
}

/// The marks file `fast_import` exported: mark → commit or blob id.
pub fn read_marks(path: &Path) -> HashMap<Mark, String> {
    std::fs::read_to_string(path)
        .expect("read the exported marks")
        .lines()
        .filter_map(|l| {
            let (m, sha) = l.strip_prefix(':')?.split_once(' ')?;
            Some((m.parse().ok()?, sha.to_string()))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;
    use std::time::Instant;

    fn git(dir: &Path, args: &[&str]) -> String {
        let out = Command::new("git")
            .current_dir(dir)
            .args(args)
            .envs(crate::orbital::people::git_env())
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8(out.stdout)
            .unwrap()
            .trim_end()
            .to_string()
    }

    fn ilse(time: i64) -> Sig<'static> {
        Sig {
            name: "Ilse Varga",
            email: "ilse.varga@example.com",
            time,
            tz_minutes: 60,
        }
    }

    #[test]
    fn a_small_history_imports_with_a_merge_a_tag_and_refs() {
        let dir = tempfile::tempdir().unwrap();
        git(dir.path(), &["init", "-q", "-b", "main"]);
        let mut h = History::new();
        let readme = h.blob(b"# Orbital\n");
        let script = h.blob(b"#!/bin/sh\necho hi\n");
        assert_eq!(h.blob(b"# Orbital\n"), readme, "blobs are deduplicated");
        let t = 1_728_300_000;
        let root = h.commit(
            &[],
            ilse(t),
            ilse(t),
            "Start Orbital",
            &[
                Change::Put {
                    path: "README.md".into(),
                    mode: 0o100644,
                    blob: readme,
                },
                Change::Put {
                    path: "tools/hi.sh".into(),
                    mode: 0o100755,
                    blob: script,
                },
            ],
        );
        let game = h.blob(b"fn main() {}\n");
        let side = h.commit(
            &[root],
            ilse(t + 60),
            ilse(t + 60),
            "Add the game",
            &[Change::Put {
                path: "src/main.rs".into(),
                mode: 0o100644,
                blob: game,
            }],
        );
        let readme2 = h.blob(b"# Orbital\n\nA game.\n");
        let main2 = h.commit(
            &[root],
            ilse(t + 120),
            ilse(t + 120),
            "Describe the game",
            &[
                Change::Put {
                    path: "README.md".into(),
                    mode: 0o100644,
                    blob: readme2,
                },
                Change::Delete("tools/hi.sh".into()),
            ],
        );
        let merge = h.commit(
            &[main2, side],
            ilse(t + 180),
            ilse(t + 180),
            "Merge branch 'feature/game' into 'main'\n\nAdd the game\n\nSee merge request orbital/orbital!1",
            &[Change::Put { path: "src/main.rs".into(), mode: 0o100644, blob: game }],
        );
        h.tag("v0.1.0", merge, ilse(t + 240), "Orbital 0.1.0\n");
        h.reset("refs/heads/main", merge);
        h.reset("refs/heads/feature/game", side);
        assert_eq!(h.commits(), 4);
        let marks = dir.path().join("marks");
        fast_import(&dir.path().join(".git"), &h.finish(), Some(&marks)).unwrap();
        let d = dir.path();
        assert_eq!(
            git(d, &["log", "--format=%s", "main"])
                .lines()
                .collect::<Vec<_>>(),
            [
                "Merge branch 'feature/game' into 'main'",
                "Describe the game",
                "Add the game",
                "Start Orbital"
            ]
        );
        assert_eq!(
            git(d, &["rev-list", "--parents", "-n1", "main"])
                .split(' ')
                .count(),
            3
        );
        assert_eq!(
            git(d, &["ls-tree", "--name-only", "-r", "main"])
                .lines()
                .collect::<Vec<_>>(),
            ["README.md", "src/main.rs"]
        );
        assert!(
            git(d, &["ls-tree", &read_marks(&marks)[&root], "tools/hi.sh"]).starts_with("100755")
        );
        assert_eq!(git(d, &["cat-file", "-t", "v0.1.0"]), "tag");
        assert_eq!(
            git(
                d,
                &["log", "-1", "--format=%an <%ae> %ad", "--date=raw", "main"]
            ),
            format!("Ilse Varga <ilse.varga@example.com> {} +0100", t + 180)
        );
        assert_eq!(read_marks(&marks)[&merge], git(d, &["rev-parse", "main"]));
        assert_eq!(
            git(d, &["rev-parse", "feature/game"]),
            read_marks(&marks)[&side]
        );
        assert_eq!(
            git(d, &["for-each-ref", "--format=%(refname)", SCRATCH]),
            "",
            "the scratch ref is gone"
        );
    }

    #[test]
    fn a_second_root_starts_its_own_tree() {
        let dir = tempfile::tempdir().unwrap();
        git(dir.path(), &["init", "-q", "-b", "main"]);
        let mut h = History::new();
        let a = h.blob(b"a\n");
        let b = h.blob(b"b\n");
        let put = |path: &str, blob| Change::Put {
            path: path.into(),
            mode: 0o100644,
            blob,
        };
        let one = h.commit(
            &[],
            ilse(1_728_300_000),
            ilse(1_728_300_000),
            "One",
            &[put("a", a)],
        );
        let other = h.commit(
            &[],
            ilse(1_728_300_060),
            ilse(1_728_300_060),
            "Other",
            &[put("b", b)],
        );
        h.reset("refs/heads/main", one);
        h.reset("refs/heads/pages", other);
        fast_import(&dir.path().join(".git"), &h.finish(), None).unwrap();
        assert_eq!(git(dir.path(), &["rev-list", "--count", "pages"]), "1");
        assert_eq!(git(dir.path(), &["ls-tree", "--name-only", "pages"]), "b");
    }

    #[test]
    fn a_second_stream_continues_from_a_sha() {
        let dir = tempfile::tempdir().unwrap();
        git(dir.path(), &["init", "-q", "-b", "main"]);
        let mut h = History::new();
        let b = h.blob(b"one\n");
        let root = h.commit(
            &[],
            ilse(1_728_300_000),
            ilse(1_728_300_000),
            "One",
            &[Change::Put {
                path: "f".into(),
                mode: 0o100644,
                blob: b,
            }],
        );
        h.reset("refs/heads/main", root);
        fast_import(&dir.path().join(".git"), &h.finish(), None).unwrap();
        let sha = git(dir.path(), &["rev-parse", "main"]);
        let mut h2 = History::new();
        let b2 = h2.blob(b"two\n");
        let next = h2.commit_after(
            &sha,
            ilse(1_728_300_600),
            ilse(1_728_300_600),
            "Two",
            &[Change::Put {
                path: "f".into(),
                mode: 0o100644,
                blob: b2,
            }],
        );
        h2.reset("refs/demo/next", next);
        fast_import(&dir.path().join(".git"), &h2.finish(), None).unwrap();
        assert_eq!(
            git(dir.path(), &["rev-list", "--count", "main..refs/demo/next"]),
            "1"
        );
    }

    #[test]
    fn a_bad_stream_reports_gits_error() {
        let dir = tempfile::tempdir().unwrap();
        git(dir.path(), &["init", "-q"]);
        let err = fast_import(
            &dir.path().join(".git"),
            b"commit refs/heads/x\nnonsense\n",
            None,
        )
        .unwrap_err();
        assert!(!err.is_empty());
    }

    #[test]
    fn timezones_format() {
        assert_eq!(
            (tz(60), tz(-480), tz(0), tz(330)),
            (
                "+0100".into(),
                "-0800".into(),
                "+0000".into(),
                "+0530".into()
            )
        );
    }

    #[test]
    fn changes_render_paths_with_modes_and_deletes() {
        let mut h = History::new();
        let changes = h.changes(
            [
                "tools/ci.sh".to_string(),
                "README.md".into(),
                "gone.txt".into(),
            ],
            |p| (p != "gone.txt").then(|| Rc::from(p.as_bytes())),
        );
        assert_eq!(
            changes,
            [
                Change::Put {
                    path: "tools/ci.sh".into(),
                    mode: 0o100755,
                    blob: 1
                },
                Change::Put {
                    path: "README.md".into(),
                    mode: 0o100644,
                    blob: 2
                },
                Change::Delete("gone.txt".into()),
            ]
        );
        assert_eq!(path_arg("a b/c.rs"), "a b/c.rs");
        assert_eq!(path_arg("\"odd\"\nname"), r#""\"odd\"\nname""#);
    }

    /// About 2,000 commits on a main line with a merged feature branch every tenth commit and a
    /// tag every two hundred, shaped like Orbital's history.
    fn synthetic(commits: usize) -> (Vec<u8>, Mark) {
        let people = [
            Sig {
                name: "Ilse Varga",
                email: "ilse.varga@example.com",
                time: 0,
                tz_minutes: 60,
            },
            Sig {
                name: "Wen Castellano",
                email: "wen.castellano@example.com",
                time: 0,
                tz_minutes: -480,
            },
        ];
        let at = |i: usize| Sig {
            time: 1_728_288_000 + i as i64 * 1_800,
            ..people[i % 2]
        };
        let mut h = History::new();
        let file = |h: &mut History, i: usize, n: usize| {
            let path = format!("src/mod{}.rs", n % 40);
            let blob = h.blob(
                format!("pub const STEP: u32 = {i};\n")
                    .repeat(1 + n % 7)
                    .as_bytes(),
            );
            Change::Put {
                path,
                mode: mode_for("x.rs"),
                blob,
            }
        };
        let first = file(&mut h, 0, 0);
        let mut main = h.commit(&[], at(0), at(0), "Start Orbital", &[first]);
        let mut i = 1;
        while i < commits {
            if i % 10 == 0 && i + 3 < commits {
                let mut side = main;
                for k in 0..2 {
                    let c = file(&mut h, i + k, i + k + 1);
                    side = h.commit(
                        &[side],
                        at(i + k),
                        at(i + k),
                        &format!("Feature step {}", i + k),
                        &[c],
                    );
                }
                let c = file(&mut h, i + 2, i);
                main = h.commit(
                    &[main],
                    at(i + 2),
                    at(i + 2),
                    &format!("Fix {}", i + 2),
                    &[c],
                );
                let msg = format!(
                    "Merge branch 'feature/f{i}' into 'main'\n\nFeature {i}\n\nSee merge request orbital/orbital!{i}"
                );
                let c = file(&mut h, i + 3, i + 1);
                main = h.commit(&[main, side], at(i + 3), at(i + 3), &msg, &[c]);
                i += 4;
            } else {
                let c = file(&mut h, i, i);
                main = h.commit(&[main], at(i), at(i), &format!("Tune step {i}"), &[c]);
                i += 1;
            }
            if i % 200 == 0 {
                h.tag(&format!("v0.{}.0", i / 200), main, at(i), "Release\n");
            }
        }
        h.reset("refs/heads/main", main);
        assert_eq!(h.commits(), commits);
        (h.finish(), main)
    }

    #[test]
    fn two_thousand_commits_import_fast_and_identically() {
        let (stream, tip) = synthetic(2_000);
        let mut ids = Vec::new();
        for _ in 0..2 {
            let dir = tempfile::tempdir().unwrap();
            git(dir.path(), &["init", "-q", "-b", "main"]);
            let marks = dir.path().join("marks");
            let started = Instant::now();
            fast_import(&dir.path().join(".git"), &stream, Some(&marks)).unwrap();
            let took = started.elapsed();
            eprintln!(
                "fast-import of 2,000 commits ({} bytes): {took:?}",
                stream.len()
            );
            assert!(took.as_secs() < 30, "2,000 commits took {took:?}");
            assert_eq!(git(dir.path(), &["rev-list", "--count", "main"]), "2000");
            assert_eq!(
                read_marks(&marks)[&tip],
                git(dir.path(), &["rev-parse", "main"])
            );
            let mut marks: Vec<_> = read_marks(&marks).into_iter().collect();
            marks.sort();
            ids.push((
                marks,
                git(
                    dir.path(),
                    &["for-each-ref", "--format=%(objectname) %(refname)"],
                ),
            ));
        }
        assert_eq!(
            ids[0], ids[1],
            "the same stream gives the same objects and refs"
        );
        assert_eq!(
            synthetic(2_000).0,
            stream,
            "the same history gives the same stream"
        );
    }
}
