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

/// Number of parallel branches in `wide`.
pub const WIDE_BRANCHES: usize = 30;

/// A root commit on `main` with `WIDE_BRANCHES` unmerged branches forked from it, one commit
/// each: every branch holds its own lane down to the root, so the graph is `WIDE_BRANCHES`
/// lanes wide (no remote, so nothing is pinned). Used by the "no lane is clipped at the default
/// Graph width" Playwright check.
pub fn wide(r: &TestRepo) {
    r.commit("Root");
    for i in 0..WIDE_BRANCHES {
        r.switch_new(&format!("wide/{i:02}"));
        r.commit(&format!("Branch {i:02}"));
        r.switch("main");
    }
}

/// `git init` with no commits (unborn HEAD).
pub fn unborn(_r: &TestRepo) {}

/// A commit carrying a very long branch name plus a tag, so the label chip truncates and the
/// row picks up a `+1` badge. Used only by the connector/truncation and column Playwright
/// assertions. The root commit has a multi-line body, for the summary/body gap check and the
/// full-message tooltip.
pub fn long_labels(r: &TestRepo) {
    r.commit_as("Initial commit\n\nWith a body line\n\nA second paragraph,\nwrapped over two lines.", "Ada Lovelace", "ada@example.com");
    r.switch_new("feature/this-is-an-extremely-long-branch-name-designed-to-overflow-the-label-chip-and-force-truncation-in-the-commit-graph-ui");
    let tip = r.commit_as("Long label commit", "Ada Lovelace", "ada@example.com");
    r.tag("also-tagged-here", &tip);
}

/// The message of `details`' "Rename guide and update assets" commit.
pub const DETAILS_MESSAGE: &str = "Rename guide and update assets\n\nRefs !42 and group/sub/project!7, fixes #12.\nSee https://example.com/docs for details.\n\nCo-authored-by: Margaret Hamilton <margaret@example.com>\nco-authored-by: Linus Torvalds <linus@example.com>";

const SVG_OLD: &str = "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"16\" height=\"16\"><rect width=\"16\" height=\"16\" fill=\"#15a0bf\"/></svg>\n";
const SVG_NEW: &str = "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"16\" height=\"16\"><circle cx=\"8\" cy=\"8\" r=\"8\" fill=\"#f25d2e\"/></svg>\n";

/// 60 lines of PHP 8. `v2` changes line 5 (the enum) and line 55 (a `match` with `?->`). Line 3
/// is over 300 characters, for the word-wrap test.
fn php_source(v2: bool) -> String {
    let mut lines: Vec<String> = vec![
        "<?php".into(),
        "declare(strict_types=1);".into(),
        format!("// {}", "long line ".repeat(30)),
        String::new(),
        if v2 { "enum Suit: string { case Hearts = 'H'; case Spades = 'S'; }".into() } else { "enum Suit { case Hearts; case Spades; }".into() },
        String::new(),
        "#[Attribute]".into(),
        "final class Card {".into(),
        "    public function __construct(public readonly Suit $suit) {}".into(),
        "}".into(),
    ];
    lines.extend((11..=54).map(|i| format!("function filler{i}(): int {{ return {i}; }}")));
    lines.push(if v2 { "$label = match ($card?->suit) { Suit::Hearts => 'red', default => 'black' };".into() } else { "$label = 'unknown';".into() });
    lines.extend((56..=60).map(|i| format!("function tail{i}(): never {{ exit({i}); }}")));
    lines.join("\n") + "\n"
}

fn utf16le_with_bom(s: &str) -> Vec<u8> {
    let mut out = vec![0xFF, 0xFE];
    out.extend(s.encode_utf16().flat_map(u16::to_le_bytes));
    out
}

/// A valid, uncompressed RGBA PNG of one solid colour (fixtures need no image crate).
pub fn tiny_png(width: u32, height: u32, rgba: [u8; 4]) -> Vec<u8> {
    fn crc32(bytes: &[u8]) -> u32 {
        let mut c = 0xFFFF_FFFFu32;
        for &b in bytes {
            c ^= b as u32;
            for _ in 0..8 {
                c = if c & 1 != 0 { 0xEDB8_8320 ^ (c >> 1) } else { c >> 1 };
            }
        }
        !c
    }
    fn chunk(out: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
        out.extend_from_slice(&(data.len() as u32).to_be_bytes());
        let start = out.len();
        out.extend_from_slice(kind);
        out.extend_from_slice(data);
        let crc = crc32(&out[start..]);
        out.extend_from_slice(&crc.to_be_bytes());
    }
    // Each scanline: filter byte 0 (none), then the pixels.
    let row: Vec<u8> = std::iter::once(0).chain(rgba.iter().copied().cycle().take(4 * width as usize)).collect();
    let raw = row.repeat(height as usize);
    assert!(raw.len() < 0xFFFF, "tiny_png is for tiny images (one stored deflate block)");
    let (mut a, mut b) = (1u32, 0u32);
    for &x in &raw {
        a = (a + x as u32) % 65521;
        b = (b + a) % 65521;
    }
    let len = raw.len() as u16;
    let mut zlib = vec![0x78, 0x01, 0x01];
    zlib.extend_from_slice(&len.to_le_bytes());
    zlib.extend_from_slice(&(!len).to_le_bytes());
    zlib.extend_from_slice(&raw);
    zlib.extend_from_slice(&((b << 16) | a).to_be_bytes());
    let mut ihdr = Vec::new();
    ihdr.extend_from_slice(&width.to_be_bytes());
    ihdr.extend_from_slice(&height.to_be_bytes());
    ihdr.extend_from_slice(&[8, 6, 0, 0, 0]); // 8-bit RGBA, deflate, no filter, no interlace
    let mut png = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
    chunk(&mut png, b"IHDR", &ihdr);
    chunk(&mut png, b"IDAT", &zlib);
    chunk(&mut png, b"IEND", &[]);
    png
}

/// Extra unchanged lines carried by every version of docs/guide.txt → docs/manual.txt, so its
/// rename stays above git's default 50% similarity threshold once the worktree's own unstaged
/// edit is included too (`-M` with no percentage; see `compare_matches_the_direct_diff...` and
/// `commit_against_worktree_mixes_index_and_worktree_sides` in `diff.rs`).
const GUIDE_PADDING: &str = "Step five.\nStep six.\nStep seven.\nStep eight.\nStep nine.\nStep ten.\n";

/// Plan 1B's reference repo; the full layout is in the plan's Task 1 Interfaces block. Newest
/// first: a dirty WIP, then "Merge branch 'feature/x'", then "Rename guide and update assets"
/// (Grace, committed by Ada, with co-authors and MR refs), then "Add feature file" (feature/x),
/// then "Initial commit". Remote `origin` (a GitLab URL) is never fetched.
pub fn details(r: &TestRepo) {
    r.write("src/app.php", &php_source(false));
    r.write("docs/guide.txt", &format!("Guide\n\nStep one.\nStep two.\nStep three.\n{GUIDE_PADDING}"));
    r.write_bytes("logo.png", &tiny_png(4, 4, [255, 0, 0, 255]));
    r.write("icon.svg", SVG_OLD);
    r.write_bytes("data.bin", b"BIN\0\x01\x02old");
    r.write("crlf.txt", "first\r\nsecond\r\nthird\r\n");
    r.write_bytes("latin1.txt", b"caf\xe9 cr\xe8me br\xfbl\xe9e\n");
    r.write_bytes("utf16.txt", &utf16le_with_bom("h\u{e9}llo w\u{f6}rld\n"));
    r.write("old.txt", "to be deleted\n");
    r.write("ws.txt", "fn main() {\n    let x = 1;\n    let y = 2;\n}\n");
    r.commit_all_as("Initial commit", "Ada Lovelace", "ada@example.com");
    r.git(&["remote", "add", "origin", "https://gitlab.example.com/group/project.git"]);

    r.switch_new("feature/x");
    r.write("feature.txt", "feature\n");
    r.commit_all_as("Add feature file", "Linus Torvalds", "linus@example.com");
    r.switch("main");

    r.git(&["mv", "docs/guide.txt", "docs/manual.txt"]);
    r.write("docs/manual.txt", &format!("Guide\n\nStep one.\nStep two, revised.\nStep three.\n{GUIDE_PADDING}"));
    r.write("src/app.php", &php_source(true));
    r.write_bytes("logo.png", &tiny_png(6, 4, [0, 0, 255, 255]));
    r.write("icon.svg", SVG_NEW);
    r.write_bytes("data.bin", b"BIN\0\x01\x02new!");
    r.write("crlf.txt", "first\nsecond\nthird\n");
    std::fs::remove_file(r.path().join("old.txt")).expect("remove old.txt");
    r.write("big.txt", &(0..80_000).map(|i| format!("line {i:05} of the big file\n")).collect::<String>());
    r.write("dir with space/\u{fc}n\u{ef}.txt", "unicode path\n");
    r.write("ws.txt", "fn main() {\n\tlet x = 1;\n\tlet y = 2;\n}\n");
    r.commit_all_as(DETAILS_MESSAGE, "Grace Hopper", "grace@example.com");
    r.merge("feature/x", "Merge branch 'feature/x'");

    r.write("src/app.php", &format!("{}// staged tweak\n", php_source(true)));
    r.git(&["add", "src/app.php"]);
    r.write("docs/manual.txt", &format!("Guide\n\nStep one.\nStep two, revised.\nStep three.\n{GUIDE_PADDING}Step four (unstaged).\n"));
    r.write("notes.txt", "untracked notes\n");
}

/// Long files edited well below the first screen (plan 1B feedback lane V's e2e). "Edit far
/// down" changes line 120, deletes lines 150-152 and inserts a line after line 180 of the
/// 200-line `long.txt`; in the 200-line `mixed.txt` (whose unchanged line 20 is long enough to
/// wrap) it deletes lines 50-52 (50 and 51 are long enough to wrap), re-indents 120-127 and
/// 150-153 (whitespace only), and changes lines 135 and 175.
pub fn diff_view(r: &TestRepo) {
    let lines = |f: &dyn Fn(usize) -> Vec<String>| (1..=200).flat_map(f).map(|l| l + "\n").collect::<String>();
    r.write("long.txt", &lines(&|i| vec![format!("line {i:03}")]));
    // mixed.txt: lines 20, 50 and 51 are long (they wrap under Word wrap) and 50-52 get deleted;
    // the blocks 120-127 and 150-153 are re-indented (spaces to a tab), whitespace-only changes.
    let mixed_old = |i: usize| match i {
        20 | 50 | 51 => vec![format!("long {i:03} {}", "wrapping words ".repeat(40))],
        120..=127 | 150..=153 => vec![format!("    row {i:03}")],
        _ => vec![format!("row {i:03}")],
    };
    r.write("mixed.txt", &lines(&mixed_old));
    r.commit_all_as("Add long file", "Ada Lovelace", "ada@example.com");
    r.write(
        "mixed.txt",
        &lines(&|i| match i {
            50..=52 => vec![],
            120..=127 | 150..=153 => vec![format!("\trow {i:03}")],
            135 | 175 => vec![format!("row {i:03} changed")],
            _ => mixed_old(i),
        }),
    );
    r.write(
        "long.txt",
        &lines(&|i| match i {
            120 => vec!["line 120 changed".into()],
            150..=152 => vec![],
            180 => vec!["line 180".into(), "inserted line".into()],
            _ => vec![format!("line {i:03}")],
        }),
    );
    r.commit_all_as("Edit far down", "Grace Hopper", "grace@example.com");
}

/// A `dev` trunk whose merge is newer than the branches forked under it (K79, the merge
/// lock). Newest first, with the lanes the layout gives them:
///   WIP (main worktree, dirty)         lane 0, dashed down to "Initial commit"
///   spike:       "Spike: streaming"    lane 1
///   dev:         "Merge branch 'feature/parser' into dev"   lane 2, merging lane 3
///   spike:       "Spike: tokens"       lane 1, curving right into "Parser"
///   feature/parser: "Parser"           lane 3 (locked by the merge)
///   feature/retry:  "Retry policy"     lane 1, curving right into "Config loader"
///   dev:         "Config loader"       lane 2 (locked by the merge)
///   main:        "Initial commit"      lane 0
/// No remote, so nothing is pinned. Before K79 "Parser" and "Config loader" took the left-most
/// lane waiting for them (1), so every merge-in curve came from the right.
pub fn merge_lock(r: &TestRepo) {
    r.commit("Initial commit");
    r.switch_new("dev");
    r.commit_as("Config loader", "Grace Hopper", "grace@example.com");
    r.switch_new("feature/retry");
    r.commit_as("Retry policy", "Linus Torvalds", "linus@example.com");
    r.switch("dev");
    r.switch_new("feature/parser");
    r.commit_as("Parser", "Ada Lovelace", "ada@example.com");
    r.switch_new("spike");
    r.commit_as("Spike: tokens", "Margaret Hamilton", "margaret@example.com");
    r.switch("dev");
    r.merge("feature/parser", "Merge branch 'feature/parser' into dev");
    r.switch("spike");
    r.commit_as("Spike: streaming", "Margaret Hamilton", "margaret@example.com");
    r.switch("main");
    r.write("file_0.txt", "main change\n");
}

/// 60 linear commits ("Commit 00" … "Commit 59"): enough rows for the graph to scroll (plan 1B's
/// "Esc keeps the scroll position" e2e).
pub fn long_history(r: &TestRepo) {
    for i in 0..60 {
        r.commit(&format!("Commit {i:02}"));
    }
}

/// The WIP panel's working set (2B e2e), with a repo-local identity so the app can commit:
/// - `src/app.txt` (40 lines): three unstaged hunks, at lines 5, 20 and 35;
/// - `notes.txt` (40 lines): line 3 staged, line 30 unstaged (partially staged);
/// - `gone.txt`: deleted, unstaged;
/// - `space name.txt`: a line added, unstaged;
/// - `new.txt`: untracked, 3 lines.
pub fn wip_staging(r: &TestRepo) {
    r.git(&["config", "user.name", "Ada Lovelace"]);
    r.git(&["config", "user.email", "ada@example.com"]);
    let lines = |f: &dyn Fn(usize) -> String| (1..=40).map(f).map(|l| l + "\n").collect::<String>();
    r.write("src/app.txt", &lines(&|i| format!("app {i:02}")));
    r.write("notes.txt", &lines(&|i| format!("note {i:02}")));
    r.write("gone.txt", "bye\n");
    r.write("space name.txt", "one\n");
    r.commit_all_as("Base", "Ada Lovelace", "ada@example.com");
    r.write("src/app.txt", &lines(&|i| if matches!(i, 5 | 20 | 35) { format!("app {i:02} changed") } else { format!("app {i:02}") }));
    r.write("notes.txt", &lines(&|i| if i == 3 { "note 03 staged".into() } else { format!("note {i:02}") }));
    r.git(&["add", "notes.txt"]);
    r.write("notes.txt", &lines(&|i| match i {
        3 => "note 03 staged".into(),
        30 => "note 30 unstaged".into(),
        _ => format!("note {i:02}"),
    }));
    std::fs::remove_file(r.path().join("gone.txt")).expect("remove gone.txt");
    r.write("space name.txt", "one\ntwo\n");
    r.write("new.txt", "fresh 1\nfresh 2\nfresh 3\n");
}

/// File History and Blame (spec #3 §3.10, e2e flow 5). `story.txt` (8 lines) is started by Ada,
/// its middle rewritten by Grace, moved under `src/` (line 6 changed) by Linus, and its opening
/// sharpened by Ada; one unrelated commit sits in between. Blame at HEAD has six groups:
/// [1 Sharpen] [2 Start] [3-4 Middle] [5 Start] [6 Move] [7-8 Start].
pub fn file_history(r: &TestRepo) {
    let story = |lines: [&str; 8]| lines.iter().map(|l| format!("{l}\n")).collect::<String>();
    let mut v = ["Once upon a time", "there was a repository.", "It had a few commits", "and a branch or two.", "Nobody blamed anyone,", "until the day it moved.", "The end.", "(really)"];
    r.write("story.txt", &story(v));
    r.commit_all_as("Start the story", "Ada Lovelace", "ada@example.com");
    r.write("other.txt", "unrelated\n");
    r.commit_all_as("Unrelated change", "Linus Torvalds", "linus@example.com");
    v[2] = "It grew a middle part";
    v[3] = "with a twist or two.";
    r.write("story.txt", &story(v));
    r.commit_all_as("Add the middle", "Grace Hopper", "grace@example.com");
    std::fs::create_dir_all(r.path().join("src")).expect("create src");
    r.git(&["mv", "story.txt", "src/story.txt"]);
    v[5] = "until the day it moved under src.";
    r.write("src/story.txt", &story(v));
    r.commit_all_as("Move the story under src", "Linus Torvalds", "linus@example.com");
    v[0] = "Once upon a sharper time";
    r.write("src/story.txt", &story(v));
    r.commit_all_as("Sharpen the opening", "Ada Lovelace", "ada@example.com");
}

/// A merge stopped on a conflict in `c.txt` (both modified), plus an unstaged edit of `side.txt`.
pub fn wip_conflict(r: &TestRepo) {
    r.git(&["config", "user.name", "Ada Lovelace"]);
    r.git(&["config", "user.email", "ada@example.com"]);
    r.write("c.txt", "base\n");
    r.write("side.txt", "side\n");
    r.commit_all_as("Base", "Ada Lovelace", "ada@example.com");
    r.switch_new("other");
    r.write("c.txt", "theirs\n");
    r.commit_all_as("Theirs", "Ada Lovelace", "ada@example.com");
    r.switch("main");
    r.write("c.txt", "ours\n");
    r.commit_all_as("Ours", "Ada Lovelace", "ada@example.com");
    let _ = r.try_git(&["merge", "-q", "--no-ff", "other"]); // stops on c.txt, on purpose
    r.write("side.txt", "side edited\n");
}

/// The origin's `post-receive` for `sync`: GitLab's merge-request boilerplate, a deploy line, and
/// for `dev` a failure-looking line (the user's integration-rebase script, spec #2 §12.4).
const SYNC_POST_RECEIVE: &str = r#"#!/bin/sh
while read old new ref; do
  branch=${ref#refs/heads/}
  echo ""
  echo "To create a merge request for $branch, visit:"
  echo "  http://gitlab.example/team/app/-/merge_requests/new?merge_request%5Bsource_branch%5D=$branch"
  echo ""
  if [ "$branch" = dev ]; then echo "integration: rebase onto dev failed: conflict in a.txt"; fi
  echo "Deployed preview for $branch"
done
"#;

/// Fetch, pull and push (spec #2 §12; `sync.spec`). See `Interfaces` in plan 2D Task 3.
pub fn sync(r: &TestRepo) {
    r.commit_as("Initial commit", "Ada Lovelace", "ada@example.com");
    r.commit_as("Add readme", "Grace Hopper", "grace@example.com");
    r.add_origin();
    r.push("main");
    r.git(&["remote", "set-head", "origin", "main"]);
    r.switch_new("dev");
    r.commit_as("Dev work", "Ada Lovelace", "ada@example.com");
    r.push("dev");
    r.switch("main");
    r.switch_new("diverged");
    r.commit_as("Shared start", "Ada Lovelace", "ada@example.com");
    r.push("diverged");
    r.write("local.txt", "local\n");
    r.git(&["add", "local.txt"]);
    r.git(&["commit", "-q", "-m", "Local side"]);
    r.switch("main");
    r.switch_new("feature/new");
    r.commit_as("New feature", "Linus Torvalds", "linus@example.com");
    r.switch("main");
    r.push_from_clone("main", "remote.txt", "remote\n", "Remote change");
    r.push_from_clone("diverged", "remote-side.txt", "remote\n", "Remote side");
    // Installed last, so the fixture's own pushes stay quiet.
    r.origin_hook("post-receive", SYNC_POST_RECEIVE);
}

/// 30 lines; `edits` replaces line `i` (0-based) with its text.
fn numbered(edits: &[(usize, &str)]) -> String {
    (0..30)
        .map(|i| edits.iter().find(|(j, _)| *j == i).map(|(_, t)| t.to_string()).unwrap_or_else(|| format!("line {i}")))
        .map(|l| l + "\n")
        .collect()
}

/// Conflicts (spec #2 §13; `conflicts.spec`). See `Interfaces` in plan 2D Task 3.
pub fn conflicts(r: &TestRepo) {
    r.write("a.txt", &numbered(&[]));
    r.write_bytes("logo.bin", &[0, 1, 2, 3, 0, 9]);
    r.write("gone.txt", "will be deleted on main\n");
    r.git(&["add", "a.txt", "logo.bin", "gone.txt"]);
    r.git(&["commit", "-q", "-m", "Base"]);
    r.switch_new("clean");
    r.write("clean.txt", "clean\n");
    r.git(&["add", "clean.txt"]);
    r.git(&["commit", "-q", "-m", "Clean change"]);
    r.switch("main");
    r.switch_new("feature/x");
    r.write("a.txt", &numbered(&[(3, "incoming three"), (15, "incoming fifteen")]));
    r.write_bytes("logo.bin", &[0, 7, 7, 7, 0, 9]);
    r.write("gone.txt", "modified on feature/x\n");
    r.git(&["commit", "-q", "-am", "Feature edits"]);
    r.switch("main");
    r.write("a.txt", &numbered(&[(3, "current three"), (15, "current fifteen")]));
    r.write_bytes("logo.bin", &[0, 5, 5, 5, 0, 9]);
    r.git(&["rm", "-q", "gone.txt"]);
    r.git(&["commit", "-q", "-am", "Main edits"]);
}

/// A three-branch stack (spec #2 §13.1): feature/a → b → c on main, main then moves.
pub fn stack(r: &TestRepo) {
    r.commit("Base");
    for b in ["feature/a", "feature/b", "feature/c"] {
        r.switch_new(b);
        r.commit(&format!("Work on {b}"));
    }
    r.switch("main");
    r.write("main.txt", "main\n");
    r.git(&["add", "main.txt"]);
    r.git(&["commit", "-q", "-m", "Main moves"]);
    r.switch("feature/c");
}

/// 60 one-file commits on `topic`, which `main` moved past: the rebase speed budget (§13.4, §16).
pub fn rebase60(r: &TestRepo) {
    r.commit("Base");
    r.switch_new("topic");
    for i in 0..60 {
        r.write(&format!("topic/{i:02}.txt"), &format!("{i}\n"));
        r.git(&["add", &format!("topic/{i:02}.txt")]);
        r.git(&["commit", "-q", "-m", &format!("Topic {i:02}")]);
    }
    r.switch("main");
    r.write("upstream.txt", "upstream\n");
    r.git(&["add", "upstream.txt"]);
    r.git(&["commit", "-q", "-m", "Upstream"]);
    r.switch("topic");
}

// --- 2C T10: the worktrees fixture ---
/// A history shaped like a busy product repo, for the worktree-switch budget (spec #2 §16):
/// 300 commits over six branches merged back into main, an origin, and three worktrees (main
/// and two linked), each dirty so each has a WIP row.
pub fn worktrees(r: &TestRepo) {
    r.commit_as("Initial commit", "Ada Lovelace", "ada@example.com");
    r.add_origin();
    for b in 0..6 {
        let name = format!("feature/f{b}");
        r.switch_new(&name);
        for i in 0..40 {
            r.commit(&format!("{name} step {i:02}"));
        }
        r.switch("main");
        r.merge(&name, &format!("Merge branch '{name}'"));
        for i in 0..9 {
            r.commit(&format!("main after {name} {i}"));
        }
    }
    r.push("main");
    r.git(&["branch", "wt-one", "feature/f4"]);
    r.git(&["branch", "wt-two", "feature/f5"]);
    for (name, branch) in [("one", "wt-one"), ("two", "wt-two")] {
        let wt = r.add_worktree(name, branch);
        std::fs::write(wt.join("file_0.txt"), format!("{name} change\n")).expect("write");
    }
    r.write("file_1.txt", "main change\n");
}
// --- end 2C T10 ---

// --- 3C T1: the interactive rebase's fixture ---
/// Spec #3 §7: `feature/a` → `feature/b` → `feature/c`, stacked on `main`. `main..feature/c` holds
/// 8 commits and one merge (`side`, merged into feature/b, then deleted). `C1` rewrites the line
/// `A2` added to `notes.txt`, so C1 moved below A2 conflicts. `B2` adds two files (Split's e2e).
/// main moved on. HEAD: feature/c.
pub fn irebase(r: &TestRepo) {
    r.write("notes.txt", "one\n");
    r.git(&["add", "notes.txt"]);
    r.git(&["commit", "-q", "-m", "Base"]);
    r.switch_new("feature/a");
    r.commit("A1 Add parser");
    r.write("notes.txt", "one\ntwo\n");
    r.git(&["commit", "-q", "-am", "A2 Edit notes"]);
    r.commit("A3 Add tests");
    r.switch_new("feature/b");
    r.commit("B1 Add lexer");
    r.switch_new("side");
    r.commit("S1 Side work");
    r.switch("feature/b");
    r.merge("side", "Merge side");
    r.git(&["branch", "-q", "-D", "side"]);
    r.write("lexer.txt", "lexer\n");
    r.write("lexer_test.txt", "lexer test\n");
    r.git(&["add", "lexer.txt", "lexer_test.txt"]);
    r.git(&["commit", "-q", "-m", "B2 Refine lexer"]);
    r.switch_new("feature/c");
    r.write("notes.txt", "one\ntwo, revised\nthree\n");
    r.git(&["commit", "-q", "-am", "C1 Edit notes again"]);
    r.commit("C2 Polish");
    r.switch("main");
    r.write("main.txt", "main\n");
    r.git(&["add", "main.txt"]);
    r.git(&["commit", "-q", "-m", "Main moves"]);
    r.switch("feature/c");
}
// --- end 3C T1 ---

#[cfg(test)]
mod tests {
    use super::*;

    // --- 2C T10 ---
    #[test]
    fn worktrees_has_three_dirty_worktrees_over_a_merged_history() {
        let r = TestRepo::new();
        worktrees(&r);
        let list = r.git(&["worktree", "list", "--porcelain"]);
        assert_eq!(list.lines().filter(|l| l.starts_with("worktree ")).count(), 3);
        assert!(list.contains("refs/heads/wt-one") && list.contains("refs/heads/wt-two"));
        assert!(r.git(&["rev-list", "--count", "main"]).parse::<u32>().unwrap() >= 300);
        for wt in ["wt-one", "wt-two"] {
            assert!(!r.git_in(&r.root().join(wt), &["status", "--porcelain"]).is_empty(), "{wt} is dirty");
        }
        assert!(!r.git(&["status", "--porcelain"]).is_empty());
    }
    // --- end 2C T10 ---

    #[test]
    fn sync_has_a_behind_main_a_diverged_branch_and_a_talking_origin() {
        let r = TestRepo::new();
        sync(&r);
        r.git(&["fetch", "-q", "origin"]);
        assert_eq!(r.git(&["rev-list", "--count", "main..origin/main"]), "1");
        assert_eq!(r.git(&["rev-list", "--left-right", "--count", "diverged...origin/diverged"]), "1\t1");
        assert_eq!(r.git(&["rev-parse", "--abbrev-ref", "dev@{upstream}"]), "origin/dev");
        assert!(r.try_git(&["rev-parse", "--abbrev-ref", "feature/new@{upstream}"]).is_err());
        assert!(r.git(&["status", "--porcelain"]).is_empty());
        let other = r.clone_origin("talk");
        r.git_in(&other, &["switch", "-q", "dev"]);
        std::fs::write(other.join("t.txt"), "t\n").unwrap();
        r.git_in(&other, &["add", "t.txt"]);
        r.git_in(&other, &["commit", "-q", "-m", "talk"]);
        let out = std::process::Command::new("git").current_dir(&other).args(["push", "origin", "dev"]).envs(crate::testing::isolated_git_env()).output().unwrap();
        let stderr = String::from_utf8_lossy(&out.stderr);
        assert!(stderr.contains("remote: To create a merge request for dev, visit:"), "{stderr}");
        assert!(stderr.contains("remote: integration: rebase onto dev failed: conflict in a.txt"), "{stderr}");
    }

    #[test]
    fn conflicts_conflict_in_text_binary_and_delete_modify() {
        let r = TestRepo::new();
        conflicts(&r);
        assert!(r.try_git(&["merge", "--no-edit", "feature/x"]).is_err());
        let unmerged = r.git(&["diff", "--name-only", "--diff-filter=U"]);
        assert_eq!(unmerged.lines().collect::<Vec<_>>(), ["a.txt", "gone.txt", "logo.bin"]);
        assert_eq!(std::fs::read_to_string(r.path().join("a.txt")).unwrap().matches("<<<<<<<").count(), 2, "two regions");
        r.git(&["merge", "--abort"]);
        r.git(&["merge", "--no-edit", "clean"]);
    }

    #[test]
    fn stack_and_rebase60_have_their_shapes() {
        let r = TestRepo::new();
        stack(&r);
        assert_eq!(r.git(&["branch", "--show-current"]), "feature/c");
        assert_eq!(r.git(&["rev-list", "--count", "main..feature/c"]), "3");
        let r = TestRepo::new();
        rebase60(&r);
        assert_eq!(r.git(&["rev-list", "--count", "main..topic"]), "60");
        assert_eq!(r.git(&["rev-list", "--count", "topic..main"]), "1");
    }

    #[test]
    fn file_history_moves_the_story_under_src() {
        let r = TestRepo::new();
        file_history(&r);
        let log = r.git(&["log", "--follow", "--format=%s", "--", "src/story.txt"]);
        assert_eq!(log.lines().collect::<Vec<_>>(), ["Sharpen the opening", "Move the story under src", "Add the middle", "Start the story"]);
        assert!(r.git(&["status", "--porcelain"]).is_empty());
    }
}

