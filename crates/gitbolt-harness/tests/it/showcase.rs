//! The showcase repositories (`gitbolt-harness showcase <name>`): Orbital and the playground.

use gitbolt_core::testing::TestRepo;
use std::path::Path;
use std::process::Command;

pub fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .current_dir(dir)
        .args(args)
        .envs(gitbolt_core::testing::isolated_git_env())
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
    gitbolt_harness::orbital::build(&r);
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
        "?? notes/playtest-2026-10.md",
    ] {
        assert!(status.lines().any(|l| l == want), "{want:?} in\n{status}");
    }
    assert!(
        status.lines().any(|l| l.starts_with(" M docs/devlog/")),
        "{status}"
    );

    let forge: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(dir.path().join("forge.json")).unwrap())
            .unwrap();
    assert_eq!(
        (forge["version"].as_u64(), forge["host"].as_str()),
        (Some(0), Some("gitlab.example.com"))
    );
    let mrs = forge["mergeRequests"].as_array().unwrap();
    assert!(mrs.len() >= 150, "{} MRs", mrs.len());
    let states: Vec<&str> = mrs.iter().map(|m| m["state"].as_str().unwrap()).collect();
    assert!(
        states.contains(&"opened")
            && states.contains(&"draft")
            && states.iter().filter(|s| **s == "merged").count() >= 140
    );
    let merged = mrs.iter().find(|m| m["state"] == "merged").unwrap();
    assert_eq!(
        git(
            repo,
            &["cat-file", "-t", merged["mergeCommit"].as_str().unwrap()]
        ),
        "commit"
    );
}

fn build_with_the_cli(name: &str) -> (tempfile::TempDir, std::path::PathBuf, std::time::Duration) {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join(name);
    let start = std::time::Instant::now();
    let out = Command::new(env!("CARGO_BIN_EXE_gitbolt-harness")).args(["showcase", name]).arg(&root).output().unwrap();
    let took = start.elapsed();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    let repo = std::path::PathBuf::from(String::from_utf8(out.stdout).unwrap().trim());
    assert_eq!(repo, root.join("repo"));
    assert!(root.join(gitbolt_core::testing::FIXTURE_MARKER).is_file());
    (dir, root, took)
}

fn lr(repo: &Path, branch: &str) -> String {
    git(repo, &["rev-list", "--left-right", "--count", &format!("{branch}...origin/{branch}")])
}

/// `git merge-tree` exits 1 on a conflict; the names of the conflicted files follow the tree id.
fn merge_tree(repo: &Path, args: &[&str]) -> (bool, String) {
    let out = Command::new("git").current_dir(repo).args(["merge-tree", "--write-tree", "--name-only"]).args(args).envs(gitbolt_core::testing::isolated_git_env()).output().unwrap();
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
    for b in ["main", "release/1.0", "release/1.1", "release/1.2", "experiment/multiplayer", "art/hd-sprites", "feature/autopilot", "feature/station-ui", "feature/trade-routes", "balance/fuel-rework", "feature/hud-polish", "docs/press-kit-2", "feature/wormholes"] {
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
    let (start, end) = (gitbolt_harness::orbital::calendar::START, gitbolt_harness::orbital::calendar::END + 86_400);
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
        gitbolt_harness::orbital::corpus::check_fictional(&text).unwrap_or_else(|e| panic!("{f}: {e}"));
    }
    gitbolt_harness::orbital::corpus::check_fictional(&std::fs::read_to_string(root.join("forge.json")).unwrap()).unwrap();

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
    let out = Command::new(env!("CARGO_BIN_EXE_gitbolt-harness")).args(["showcase", "nope"]).arg(dir.path().join("x")).output().unwrap();
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
                let merge = Command::new("git").current_dir(r).args(["merge", "--no-edit", "feature/price-rework"]).envs(gitbolt_core::testing::isolated_git_env()).output().unwrap();
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
