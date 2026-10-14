//! The showcase repositories (`gitvolt-harness showcase <name>`): Orbital and the playground.

use gitvolt_core::testing::TestRepo;
use std::path::Path;
use std::process::Command;

pub fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .current_dir(dir)
        .args(args)
        .envs(gitvolt_core::testing::isolated_git_env())
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "git {args:?} in {}: {}",
        dir.display(),
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8(out.stdout)
        .unwrap()
        .trim_end()
        .to_string()
}

#[test]
fn orbital_ends_with_its_origin_teammate_stashes_working_tree_and_forge_data() {
    let dir = tempfile::tempdir().unwrap();
    let r = TestRepo::init_at(dir.path());
    gitvolt_harness::orbital::build(&r);
    let (repo, origin) = (r.path(), dir.path().join("origin.git"));

    assert_eq!(git(repo, &["branch", "--show-current"]), "main");
    assert!(
        git(repo, &["for-each-ref", "refs/orbital"]).is_empty(),
        "no scratch ref left"
    );
    assert_eq!(
        std::fs::read_to_string(origin.join("objects/info/alternates")).unwrap(),
        "../../repo/.git/objects\n"
    );
    assert_eq!(
        git(&origin, &["rev-parse", "main"]),
        git(repo, &["rev-parse", "origin/main"])
    );
    assert_eq!(
        git(
            &origin,
            &["rev-list", "--count", "main..refs/demo/teammate"]
        ),
        "1"
    );
    assert_eq!(
        git(
            &origin,
            &["log", "-1", "--format=%an|%s", "refs/demo/teammate"]
        ),
        "Noor Achterberg|Shrink the map markers a little"
    );
    assert_eq!(git(&origin, &["tag"]).lines().count(), 15);
    git(&origin, &["fsck", "--connectivity-only", "--no-progress"]);
    assert_eq!(
        git(
            repo,
            &["rev-parse", "--abbrev-ref", "feature/autopilot@{upstream}"]
        ),
        "origin/feature/autopilot"
    );
    assert_eq!(
        git(repo, &["symbolic-ref", "refs/remotes/origin/HEAD"]),
        "refs/remotes/origin/main"
    );

    let stashes = git(repo, &["stash", "list", "--format=%gs"]);
    assert_eq!(
        stashes.lines().collect::<Vec<_>>(),
        [
            "On main: Try a softer bloom threshold",
            "On feature/autopilot: PID gains from Thursday's playtest"
        ]
    );

    let status = git(repo, &["status", "--porcelain", "--untracked-files=all"]);
    for want in [
        "MM crates/orbital-game/src/hud.rs",
        "M  assets/sprites/ships/scout.png",
        " M assets/data/economy/commodities.csv",
        " M docs/controls.md",
        "?? notes/playtest-2026-10.md",
    ] {
        assert!(status.lines().any(|l| l == want), "{want:?} in\n{status}");
    }
    assert!(
        status.lines().any(|l| l.starts_with(" M docs/devlog/")),
        "{status}"
    );

    let wt = dir
        .path()
        .join(gitvolt_harness::orbital::finish::RELEASE_WORKTREE);
    assert_eq!(git(&wt, &["branch", "--show-current"]), "release/1.2");
    assert_eq!(
        git(&wt, &["status", "--porcelain", "--untracked-files=all"]),
        " M CHANGELOG.md\n M crates/orbital-core/src/body.rs"
    );
    assert_eq!(
        git(repo, &["worktree", "list", "--porcelain"])
            .lines()
            .filter(|l| l.starts_with("worktree "))
            .count(),
        2
    );

    assert_eq!(git(repo, &["remote", "get-url", "origin"]), "https://gitlab.example.com/orbital/orbital.git");
    let f = gitvolt_harness::forge_seed::read(dir.path()).expect("forge.json");
    assert_eq!((f.version, f.project.as_str(), f.me.as_str()), (1, "orbital/orbital", "you"));
    assert!(f.gitlab.tokens.is_empty());
    let mrs = &f.gitlab.merge_requests;
    assert!(mrs.len() >= 150, "{} MRs", mrs.len());
    assert!(mrs.iter().filter(|m| m.state == "merged").count() >= 140);
    assert!(mrs.iter().any(|m| m.title.starts_with("Draft: ")));
    for m in mrs.iter().filter(|m| m.state == "opened") {
        assert_eq!(m.head_sha, git(&origin, &["rev-parse", &format!("refs/heads/{}", m.source_branch)]), "!{}", m.iid);
        assert!(!m.diffs.is_empty(), "!{} has its diff", m.iid);
    }
    // The hd-sprites MR shows a project upload, which is listed and written beside forge.json.
    let hd = mrs.iter().find(|m| m.source_branch.ends_with("/hd-sprites")).unwrap();
    let (secret, file) = ("5c0a7e1d9b3f4a6c8e2d0b1a3c5e7f90", "scout-2x.png");
    assert!(f.gitlab.uploads.contains(&format!("orbital/orbital/{secret}/{file}")));
    assert!(hd.description.contains(&format!("![The scout at 2x](https://gitlab.example.com/orbital/orbital/uploads/{secret}/{file})")));
    assert!(std::fs::read(dir.path().join("forge-uploads").join(secret).join(file)).unwrap().starts_with(b"\x89PNG"));
    let merged = mrs.iter().find(|m| m.state == "merged").unwrap();
    assert_eq!(git(repo, &["cat-file", "-t", &merged.merge_commit_sha]), "commit");
    let threads: usize = mrs.iter().map(|m| m.discussions.len()).sum();
    assert!(threads >= 8, "{threads} threads");
    assert!(mrs.iter().flat_map(|m| &m.discussions).flat_map(|d| &d.notes).any(|n| n.position.is_some() && n.body.contains("```suggestion")));
    // The station screen's suggestion sits on the line it rewrites.
    let station = mrs.iter().find(|m| m.source_branch == "feature/station-ui").unwrap();
    let p = station.discussions.iter().find(|d| d.id == "o4").and_then(|d| d.notes[0].position.as_ref()).expect("o4 is a diff note");
    assert_eq!(p.new_line, gitvolt_harness::forge_seed::added_line_where(&station.diffs, &p.new_path, |l| l.trim_start().starts_with("let at = Vec2::new(")));
    gitvolt_harness::fake_forge::gitlab_mrs::check_merge_statuses(mrs).unwrap();
    let defined: Vec<&str> = f.gitlab.labels.iter().map(|l| l.name.as_str()).collect();
    for m in mrs {
        assert!(m.labels.len() <= 2 && m.labels.iter().all(|l| defined.contains(&l.as_str())), "!{}: {:?}", m.iid, m.labels);
    }
    assert!(mrs.iter().filter(|m| m.state == "opened").all(|m| !m.labels.is_empty()), "every open MR has a label");
    assert!(mrs.iter().filter(|m| m.state == "merged" && !m.labels.is_empty()).count() >= 100, "merged MRs have labels");
}

fn build_with_the_cli(name: &str) -> (tempfile::TempDir, std::path::PathBuf, std::time::Duration) {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join(name);
    let start = std::time::Instant::now();
    let out = Command::new(env!("CARGO_BIN_EXE_gitvolt-harness")).args(["showcase", name]).arg(&root).output().unwrap();
    let took = start.elapsed();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    let repo = std::path::PathBuf::from(String::from_utf8(out.stdout).unwrap().trim());
    assert_eq!(repo, root.join("repo"));
    assert!(root.join(gitvolt_core::testing::FIXTURE_MARKER).is_file());
    (dir, root, took)
}

fn lr(repo: &Path, branch: &str) -> String {
    git(repo, &["rev-list", "--left-right", "--count", &format!("{branch}...origin/{branch}")])
}

/// `git merge-tree` exits 1 on a conflict; the names of the conflicted files follow the tree id.
fn merge_tree(repo: &Path, args: &[&str]) -> (bool, String) {
    let out = Command::new("git").current_dir(repo).args(["merge-tree", "--write-tree", "--name-only"]).args(args).envs(gitvolt_core::testing::isolated_git_env()).output().unwrap();
    (out.status.code() == Some(1), String::from_utf8_lossy(&out.stdout).into_owned())
}

#[test]
fn orbital_history_has_its_shape_and_budget() {
    let (_dir, root, took) = build_with_the_cli("orbital");
    eprintln!("showcase orbital: {:.1} s (budget 20 s on the dev machine; 4.5 s measured)", took.as_secs_f32());
    assert!(took.as_secs() < 90, "{took:?}");
    let repo = root.join("repo");
    let r = repo.as_path();

    // Size of the history and its people.
    let commits: usize = git(r, &["rev-list", "--all", "--count"]).parse().unwrap();
    eprintln!("orbital shape: {commits} commits");
    assert!((1_100..=1_700).contains(&commits), "{commits} commits");
    assert!(git(r, &["rev-list", "--merges", "--count", "main"]).parse::<usize>().unwrap() >= 150);
    let mut emails: Vec<String> = git(r, &["log", "--all", "--format=%ae"]).lines().map(String::from).collect();
    emails.sort();
    emails.dedup();
    assert_eq!(emails.len(), 6, "{emails:?}");

    // Tags and branches.
    let tags = git(r, &["tag", "--sort=v:refname"]);
    assert_eq!(tags.lines().next(), Some("v0.1.0"));
    assert_eq!(tags.lines().last(), Some("v1.2.1"));
    assert_eq!(tags.lines().count(), 15);
    let heads = git(r, &["for-each-ref", "--format=%(refname:short)", "refs/heads"]);
    for b in ["main", "release/1.0", "release/1.1", "release/1.2", "experiment/multiplayer", "art/hd-sprites", "feature/autopilot", "feature/station-ui", "feature/trade-routes", "balance/fuel-rework", "feature/hud-polish", "feature/hud-gauges", "docs/press-kit-2", "feature/wormholes"] {
        assert!(heads.lines().any(|h| h == b), "{b} in\n{heads}");
    }

    // Ahead and behind.
    assert_eq!(lr(r, "main"), "0\t0");
    assert_eq!(lr(r, "feature/autopilot"), "2\t0");
    assert_eq!(lr(r, "feature/station-ui"), "0\t2");
    assert_eq!(lr(r, "feature/trade-routes"), "1\t2");
    let mp = git(r, &["rev-list", "--left-right", "--count", "experiment/multiplayer...main"]);
    let (ahead, behind) = mp.split_once('\t').map(|(a, b)| (a.parse::<u32>().unwrap(), b.parse::<u32>().unwrap())).unwrap();
    assert!(ahead >= 25 && behind >= 200, "{mp}");

    // The merge tool's branch: a text, a table and a binary conflict.
    let (conflicted, out) = merge_tree(r, &["main", "balance/fuel-rework"]);
    assert!(conflicted, "{out}");
    for f in ["crates/orbital-core/src/ship.rs", "assets/data/economy/commodities.csv", "assets/ui/icons/fuel.png"] {
        assert!(out.lines().any(|l| l == f), "{f} conflicts:\n{out}");
    }

    // The interactive rebase's branch.
    let c: Vec<String> = git(r, &["rev-list", "--reverse", "main..feature/hud-polish"]).lines().map(String::from).collect();
    assert_eq!(c.len(), 7);
    assert_eq!(git(r, &["log", "-1", "--format=%s", &c[1]]), "WIP");
    // Its stack's lower branch, on the reworded commit, so the rebase moves it along.
    for b in ["feature/hud-gauges", "origin/feature/hud-gauges"] {
        assert_eq!(git(r, &["rev-parse", b]), c[2], "{b}");
    }
    assert!(merge_tree(r, &["--merge-base", &format!("{}^", c[1]), "main", &c[1]]).0, "WIP conflicts onto main");
    assert!(merge_tree(r, &["--merge-base", &format!("{}^", c[5]), &c[0], &c[5]]).0, "moving the colour tweak above WIP conflicts");
    assert!(!merge_tree(r, &["--merge-base", &format!("{}^", c[3]), &c[0], &c[3]]).0, "the fixup moves up cleanly");

    // Every preview type at HEAD, and the reworks in history.
    let files = git(r, &["ls-tree", "-r", "--name-only", "HEAD"]);
    for ext in ["rs", "wgsl", "png", "gif", "ico", "svg", "wav", "ogg", "ttf", "csv", "tsv", "pdf", "html", "css", "md", "webm", "orbsave", "toml", "yml", "sh"] {
        assert!(files.lines().any(|f| f.ends_with(&format!(".{ext}"))), ".{ext} at HEAD");
    }
    let changes = |path: &str| git(r, &["log", "--format=%H", "main", "--", path]).lines().count();
    assert!(changes("assets/sprites/ships/scout.png") >= 2);
    assert!(changes("assets/fonts/OrbitalHud.ttf") >= 3);
    assert_eq!(changes("docs/design/orbital-design.pdf"), 2);
    assert!(changes("press/trailer.webm") >= 2 && changes("assets/data/economy/commodities.csv") >= 6);
    assert!(git(r, &["ls-files", "-s", "tools/pack-assets.sh"]).starts_with("100755"));

    // Dates: every commit after its parents, all within the two years.
    let log = git(r, &["log", "--all", "--format=%H %ct %P"]);
    let times: std::collections::HashMap<&str, i64> = log.lines().map(|l| { let f: Vec<&str> = l.split(' ').collect(); (f[0], f[1].parse().unwrap()) }).collect();
    let (start, end) = (gitvolt_harness::orbital::calendar::START, gitvolt_harness::orbital::calendar::END + 86_400);
    for l in log.lines() {
        let f: Vec<&str> = l.split(' ').collect();
        let t: i64 = f[1].parse().unwrap();
        assert!((start..=end).contains(&t), "{l}");
        for p in &f[2..] {
            assert!(times[p] <= t, "{} is dated before its parent {p}", f[0]);
        }
    }

    // Fictional: every text file at HEAD, and the forge data.
    for f in files.lines().filter(|f| [".rs", ".md", ".toml", ".yml", ".html", ".css", ".csv", ".tsv", ".wgsl", ".sh", ".svg"].iter().any(|e| f.ends_with(e))) {
        let text = git(r, &["show", &format!("HEAD:{f}")]);
        gitvolt_harness::orbital::corpus::check_fictional(&text).unwrap_or_else(|e| panic!("{f}: {e}"));
    }
    gitvolt_harness::orbital::corpus::check_fictional(&std::fs::read_to_string(root.join("forge.json")).unwrap()).unwrap();

    // Budget: packed history (the origin borrows the repo's objects) plus the working tree.
    git(r, &["repack", "-adq"]);
    git(&root.join("origin.git"), &["repack", "-adlq"]);
    let pack_kib = |dir: &Path| -> u64 { git(dir, &["count-objects", "-v"]).lines().find_map(|l| l.strip_prefix("size-pack: ")).unwrap().parse().unwrap() };
    let worktree: u64 = files.lines().map(|f| std::fs::metadata(r.join(f)).map(|m| m.len()).unwrap_or(0)).sum();
    let total = pack_kib(r) * 1024 + pack_kib(&root.join("origin.git")) * 1024 + worktree;
    eprintln!("orbital: {} KiB packed, {} KiB working tree", pack_kib(r), worktree / 1024);
    assert!(total < 6_000_000, "{total} bytes");
}

#[test]
fn orbital_is_deterministic() {
    let fingerprint = |root: &Path| {
        let (repo, origin) = (root.join("repo"), root.join("origin.git"));
        [
            git(&repo, &["for-each-ref"]),
            git(&origin, &["for-each-ref"]),
            git(&repo, &["stash", "list", "--format=%H"]),
            git(&repo, &["rev-list", "--all", "--objects"]),
            git(&repo, &["rev-list", "--walk-reflogs", "--objects", "--all"]),
            git(&repo, &["ls-files", "-s"]),
            git(&repo, &["status", "--porcelain"]),
            git(&repo, &["diff"]),
            std::fs::read_to_string(root.join("forge.json")).unwrap(),
        ]
        .join("\n---\n")
    };
    let (_a, root_a, _) = build_with_the_cli("orbital");
    let (_b, root_b, _) = build_with_the_cli("orbital");
    assert_eq!(fingerprint(&root_a), fingerprint(&root_b));
}

#[test]
fn unknown_showcase_names_are_refused_with_the_list() {
    let dir = tempfile::tempdir().unwrap();
    let out = Command::new(env!("CARGO_BIN_EXE_gitvolt-harness")).args(["showcase", "nope"]).arg(dir.path().join("x")).output().unwrap();
    assert_eq!(out.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&out.stderr).contains("orbital"));
}

#[test]
fn the_playground_repos_have_their_shapes() {
    for name in ["basic", "sync", "conflicts", "stack", "wip_staging", "rebase_lab"] {
        let (_dir, root, _) = build_with_the_cli(name);
        let r = root.join("repo");
        let r = r.as_path();
        let authors = git(r, &["log", "--all", "--format=%an|%cn"]);
        assert!(authors.lines().all(|l| { let (a, c) = l.split_once('|').unwrap(); a == c }), "{name}: committer is the author");
        assert!(!authors.contains("Ada Lovelace") && !authors.contains("Grace Hopper"), "{name}: Orbital's people");
        match name {
            "basic" => {
                assert_eq!(git(r, &["branch", "--show-current"]), "main");
                assert!(root.join("wt-hotfix").is_dir());
                assert!(!git(&root.join("wt-hotfix"), &["status", "--porcelain"]).is_empty());
                assert_eq!(git(r, &["stash", "list"]).lines().count(), 1);
                assert_eq!(git(r, &["symbolic-ref", "refs/remotes/origin/HEAD"]), "refs/remotes/origin/main");
                assert_eq!(git(r, &["rev-list", "--count", "v1.0"]), "2");
                assert!(git(r, &["log", "-1", "--format=%s", "main"]).starts_with("Merge branch 'feature/press-page'"));
                assert!(!git(r, &["status", "--porcelain"]).is_empty());
            }
            "sync" => {
                git(r, &["fetch", "-q", "origin"]);
                assert_eq!(git(r, &["rev-list", "--count", "main..origin/main"]), "1");
                assert_eq!(git(r, &["rev-list", "--left-right", "--count", "feature/lua-hooks...origin/feature/lua-hooks"]), "1\t1");
                assert_eq!(git(r, &["rev-parse", "--abbrev-ref", "dev@{upstream}"]), "origin/dev");
                assert!(Command::new("git").current_dir(r).args(["rev-parse", "--abbrev-ref", "feature/mod-manifest@{upstream}"]).output().unwrap().status.code() != Some(0));
                assert!(std::fs::read_to_string(root.join("origin.git/hooks/post-receive")).unwrap().contains("orbital/modkit"));
            }
            "conflicts" => {
                let merge = Command::new("git").current_dir(r).args(["merge", "--no-edit", "feature/price-rework"]).envs(gitvolt_core::testing::isolated_git_env()).output().unwrap();
                assert!(!merge.status.success());
                assert_eq!(git(r, &["diff", "--name-only", "--diff-filter=U"]).lines().collect::<Vec<_>>(), ["data/commodities.csv", "docs/old-pricing.md", "icons/credits.png"]);
                assert_eq!(std::fs::read_to_string(r.join("data/commodities.csv")).unwrap().matches("<<<<<<<").count(), 2);
                git(r, &["merge", "--abort"]);
                git(r, &["-c", "user.name=T", "-c", "user.email=t@example.com", "merge", "--no-edit", "balance/station-list"]);
            }
            "stack" => {
                assert_eq!(git(r, &["branch", "--show-current"]), "feature/cargo-tests");
                assert_eq!(git(r, &["rev-list", "--count", "main..feature/cargo-tests"]), "3");
                assert_eq!(git(r, &["rev-list", "--count", "feature/cargo-tests..main"]), "1");
                assert_eq!(git(r, &["remote", "get-url", "origin"]), "https://gitlab.example.com/orbital/cargo.git");
                assert_eq!(git(&root.join("origin.git"), &["rev-parse", "feature/cargo-tests"]), git(r, &["rev-parse", "feature/cargo-tests"]));
                assert!(gitvolt_harness::forge_seed::read(&root).is_some_and(|f| f.project == "orbital/cargo" && f.gitlab.merge_requests.is_empty()));
            }
            "wip_staging" => {
                let status = git(r, &["status", "--porcelain"]);
                for want in [" M src/ship.rs", "MM NOTES.md", " D old_controls.txt", " M \"docs/release notes.md\"", "?? src/autopilot.rs"] {
                    assert!(status.lines().any(|l| l == want), "{want:?} in\n{status}");
                }
                assert_eq!(git(r, &["diff", "--", "src/ship.rs"]).lines().filter(|l| l.starts_with("@@ ")).count(), 3);
                assert_eq!(git(r, &["config", "user.name"]), "Ilse Varga");
            }
            "rebase_lab" => {
                assert_eq!(git(r, &["branch", "--show-current"]), "feature/docking");
                let c: Vec<String> = git(r, &["rev-list", "--reverse", "main..feature/docking"]).lines().map(String::from).collect();
                assert_eq!(c.len(), 6);
                assert!(merge_tree(r, &["--merge-base", &format!("{}^", c[1]), "main", &c[1]]).0, "the second commit conflicts onto main");
                assert!(merge_tree(r, &["--merge-base", &format!("{}^", c[3]), &c[1], &c[3]]).0, "the fourth above the third conflicts");
                assert!(!merge_tree(r, &["--merge-base", &format!("{}^", c[4]), &c[0], &c[4]]).0);
            }
            _ => unreachable!(),
        }
    }
}

#[test]
fn the_media_repos_are_built_by_the_cli() {
    for name in ["previews", "submodules", "lfs"] {
        let (_dir, root, _) = build_with_the_cli(name);
        let r = root.join("repo");
        assert!(git(&r, &["log", "--all", "--format=%an"]).lines().all(|a| a.contains(' ') && a != "Ada Lovelace"), "{name}: Orbital's people");
    }
}
