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
