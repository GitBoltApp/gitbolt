#!/usr/bin/env python3
"""GitBolt -> GitVolt, the mechanical part: one ordered mapping over every tracked text file and path.

  scripts/rename-gitvolt.py                    dry run: what would change
  scripts/rename-gitvolt.py --apply            rewrite the files, then git mv the paths
  scripts/rename-gitvolt.py --since REV        only the files `git diff --name-only REV...HEAD` lists
  scripts/rename-gitvolt.py --check            print nothing; exit 1 if anything would change
  scripts/rename-gitvolt.py --apply --full FILE...
                                               every rule on these files only (the updater's cleanup)
Run from the repository root. Idempotent: a second --apply changes nothing.

A line that already names GitVolt is left as it is and printed as `KEPT <file>:<line>: <text>`
(the 0.6.1 bridge's lines that mention both names). A branch that rebases onto the renamed main
runs `scripts/rename-gitvolt.py --apply --since main`.
"""
import re
import subprocess
import sys
from pathlib import Path

RULES = [  # (class, pattern, replacement), in this order: the more specific spellings first
    ("site", r"https://gitboltapp\.github\.io/gitbolt/", "https://gitvolt.com/"),
    ("site", r"gitboltapp\.github\.io/gitbolt/?", "gitvolt.com"),
    ("repo", r"GitBoltApp/gitbolt", "GitVoltApp/gitvolt"),
    ("repo", r"gitboltapp/gitbolt", "gitvoltapp/gitvolt"),
    ("repo", r"GitBoltApp", "GitVoltApp"),
    ("repo", r"gitboltapp", "gitvoltapp"),
    ("ident", r"(?<![A-Za-z])gitbolt([-_])(core|forge|graph[-_]wasm|graph|harness|app)(?![A-Za-z])", r"gitvolt\1\2"),
    ("ident", r"GITBOLT_", "GITVOLT_"),
    ("ident", r"user-agent: gitbolt/", "user-agent: gitvolt/"),
    ("name", r"dev\.gitbolt\.desktop", "com.gitvolt.desktop"),
    ("name", r"(?<![A-Za-z.])dev\.gitbolt(?![A-Za-z])", "com.gitvolt"),
    ("name", r"git-bolt", "git-volt"),
    ("name", r"Git Bolt", "Git Volt"),
    ("name", r"GITBOLT", "GITVOLT"),
    ("name", r"GitBolt", "GitVolt"),
    ("name", r"Gitbolt", "Gitvolt"),
    ("name", r"gitbolt", "gitvolt"),
]
RULES = [(c, re.compile(p), r) for c, p, r in RULES]
ALL = {"site", "repo", "ident", "name"}

# The allowlist: files this script never edits. History, and this file's own mapping. Task 12's
# scripts/name-allowlist.txt (one path per line, `#` comments) is read too, once it exists.
ALLOWLIST = {
    "CHANGELOG.md",
    "scripts/rename-gitvolt.py",
}
# Files that take identifiers only (none now; the updater's files did, until Task 7).
IDENT_ONLY = set()
# Both spellings of each path: a re-run, after the files have moved, must treat them the same way.
IDENT_ONLY |= {p.replace("gitbolt", "gitvolt") for p in IDENT_ONLY}
# A real past release: the repository moves (GitHub redirects), its files keep their names.
REPO_ONLY = {"site/data/release.json"}
# The same for one block of a file (1-based, inclusive): docs/website.md's example release.json.
REPO_ONLY_LINES = {"docs/website.md": (55, 80)}
KEEP_PARAGRAPHS = set()  # none now: Task 7 rewrote the bridge's paragraphs by hand
OLD = re.compile(r"git[ -]?bolt", re.IGNORECASE)
NEW = re.compile(r"gitvolt", re.IGNORECASE)


def allowlisted():
    out = set(ALLOWLIST)
    extra = Path("scripts/name-allowlist.txt")
    if extra.is_file():
        for line in extra.read_text().splitlines():
            line = line.split("#", 1)[0].strip()
            if line:
                out.add(line)
    return out


def classes_for(path, n, full):
    if full:
        return ALL
    if path in IDENT_ONLY:
        return {"ident"}
    if path in REPO_ONLY:
        return {"repo"}
    if path in REPO_ONLY_LINES and REPO_ONLY_LINES[path][0] <= n <= REPO_ONLY_LINES[path][1]:
        return {"repo"}
    return ALL


def kept_lines(path, lines, full):
    """Indexes of lines the mapping must not touch, and those of them that still take identifiers
    (crate paths, GITBOLT_ variables): a kept paragraph's lines that don't name GitVolt."""
    keep, para_only = set(), set()
    if full or path in IDENT_ONLY:
        return keep, para_only
    if path in KEEP_PARAGRAPHS:
        start = 0
        for i in range(len(lines) + 1):
            if i == len(lines) or not lines[i].strip():
                para = range(start, i)
                if any(NEW.search(lines[j]) for j in para):
                    keep.update(j for j in para if OLD.search(lines[j]))
                    para_only.update(j for j in para if OLD.search(lines[j]) and not NEW.search(lines[j]))
                start = i + 1
    for i, line in enumerate(lines):
        if OLD.search(line) and NEW.search(line) and classes_for(path, i + 1, full) == ALL:
            keep.add(i)
    return keep, para_only


def rename_text(text, path, full, kept):
    lines = text.splitlines(keepends=True)
    keep, para_only = kept_lines(path, lines, full)
    out = []
    for i, line in enumerate(lines):
        if i in keep:
            if i in para_only:
                for c, pat, rep in RULES:
                    if c == "ident":
                        line = pat.sub(rep, line)
            kept.append(f"KEPT {path}:{i + 1}: {line.rstrip()}")
        elif OLD.search(line):
            classes = classes_for(path, i + 1, full)
            for c, pat, rep in RULES:
                if c in classes:
                    line = pat.sub(rep, line)
        out.append(line)
    return "".join(out)


def rename_path(path):
    for c, pat, rep in RULES:
        if c in ("ident", "name"):
            path = pat.sub(rep, path)
    return path


def text_of(p):
    data = p.read_bytes()
    if b"\0" in data[:8192]:
        return None
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        return None


def git(*args):
    return subprocess.run(["git", *args], check=True, capture_output=True).stdout.decode().split("\0")[:-1]


def main(argv):
    flags = {"--apply", "--check", "--full", "--since"}
    unknown = [a for a in argv if a.startswith("--") and a not in flags]
    if unknown:
        sys.exit(f"rename-gitvolt: unknown flag {unknown[0]} (see the usage at the top of this file)")
    apply = "--apply" in argv
    check = "--check" in argv
    full = argv[argv.index("--full") + 1:] if "--full" in argv else None
    if full is not None:
        files = full
    elif "--since" in argv:
        rev = argv[argv.index("--since") + 1]
        files = git("diff", "--name-only", "-z", f"{rev}...HEAD")
    else:
        files = git("ls-files", "-z")
    skip = allowlisted()
    kept, changed, moves = [], 0, []
    for f in files:
        p = Path(f)
        if f in skip or p.is_symlink() or not p.is_file():
            continue
        text = text_of(p)
        if text is not None:
            new = rename_text(text, f, full is not None, kept)
            if new != text:
                changed += 1
                if not check:
                    print(f"EDIT {f}")
                if apply:
                    p.write_bytes(new.encode("utf-8"))
        if full is None and rename_path(f) != f:
            moves.append((f, rename_path(f)))
    if check:
        sys.exit(1 if changed or moves else 0)
    for a, b in moves:
        print(f"MOVE {a} -> {b}")
        if apply:
            Path(b).parent.mkdir(parents=True, exist_ok=True)
            subprocess.run(["git", "mv", a, b], check=True)
    for line in kept:
        print(line)
    print(f"{changed} files edited, {len(moves)} paths moved, {len(kept)} lines kept", file=sys.stderr)


if __name__ == "__main__":
    main(sys.argv[1:])
