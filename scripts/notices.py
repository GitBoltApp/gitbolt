#!/usr/bin/env python3
"""Helpers for scripts/licenses.sh (`just licenses`): the third-party notices the packages ship.

Subcommands (errors go to stderr with exit status 2):
  rust <about.json> <out.txt>   THIRD-PARTY-NOTICES-rust.txt from `cargo about generate --format json`:
                                the crates grouped by license, each crate with the copyright lines
                                of its license files, each license's text printed once
  cef <cef-dir> <out-dir>       CEF-LICENSE.txt and CHROMIUM-CREDITS.html.gz from the CEF distribution
                                the build used. download-cef keeps only CREDITS.html when it
                                unpacks, so LICENSE.txt is read from the archive next to it
                                (archive.json names it) unless a LICENSE.txt sits beside CREDITS.html
  cef-version <Cargo.lock>      the CEF version of the `cef` crate (its version after '+'), i.e. the
                                directory under ~/.cache/tauri-cef the build unpacks into
"""
import gzip
import json
import os
import re
import shutil
import sys
import tarfile


class Fail(Exception):
    pass


# A copyright line: "Copyright ...", "(c) ...", "© ...", optionally behind comment markers. Not the
# license's own mentions ("the above copyright notice", "COPYRIGHT HOLDERS") or a template's
# placeholder ("Copyright [yyyy] [name of copyright owner]").
COPYRIGHT = re.compile(r"^(copyright\b|\(c\)\s|©)", re.I)
NOT_COPYRIGHT = re.compile(r"\[yyyy\]|<year>|\{yyyy\}|\[name of copyright owner\]|^copyright\s+(notice|holders?|owner|license|and\b|law)", re.I)


def as_copyright(line):
    """The line as a copyright line (comment markers stripped), or None."""
    s = line.strip().lstrip("#*/;- ").strip()
    return s if COPYRIGHT.match(s) and not NOT_COPYRIGHT.search(s) and len(s) < 300 else None


def copyright_lines(text):
    return [c for c in map(as_copyright, text.splitlines()) if c]


def without_copyright(text):
    """The license text minus its copyright lines (listed per package instead), trimmed."""
    keep = [line.rstrip() for line in text.replace("\r\n", "\n").split("\n") if not as_copyright(line)]
    body = "\n".join(keep).strip("\n")
    return re.sub(r"\n{3,}", "\n\n", body)


def text_key(text):
    """Texts that differ only in copyright lines, a title line, wrapping or punctuation are one."""
    lines = [line for line in without_copyright(text).split("\n") if line.strip()]
    if lines and len(lines[0]) < 60 and re.search(r"licen[cs]e", lines[0], re.I) and not lines[0].rstrip().endswith("."):
        lines = lines[1:]
    return re.sub(r"[^a-z0-9]", "", " ".join(lines).lower())


def render(title, intro, unit, groups):
    """groups: {license id: {"packages": {label: [copyright lines] or None}, "authors": {label: str},
    "texts": [(key, text, set(labels))]}} -> the notices file's text."""
    order = sorted(groups, key=lambda i: (-len(groups[i]["packages"]), i))
    width = max(len(i) for i in order) if order else 10
    out = [title, "=" * len(title), "", intro, "", "Summary", "-------"]
    for lid in order:
        out.append(f"  {lid.ljust(width)}  {len(groups[lid]['packages']):>4}")
    out.append("")
    for lid in order:
        g = groups[lid]
        n = len(g["packages"])
        out += ["", "=" * 100, f"{lid} ({n} {unit}{'' if n == 1 else 's'})", "=" * 100, ""]
        for label in sorted(g["packages"], key=str.lower):
            out.append(label)
            lines = g["packages"][label]
            if lines:
                out += [f"  {c}" for c in lines]
            else:
                who = g["authors"].get(label)
                out.append(f"  (no copyright line in its license files{'; authors: ' + who if who else ''})")
        texts = sorted(g["texts"], key=lambda t: (-len(t[2]), t[0]))
        for i, (_, text, users) in enumerate(texts, 1):
            head = f"--- {lid} license text"
            if len(texts) > 1:
                head += f" ({i} of {len(texts)}; used by {', '.join(sorted(users, key=str.lower))})"
            out += ["", head + " ---", "", text, ""]
    return "\n".join(out).rstrip("\n") + "\n"


def add(groups, lid, label, text, authors=None):
    g = groups.setdefault(lid, {"packages": {}, "authors": {}, "texts": []})
    lines = g["packages"].setdefault(label, [])
    for c in copyright_lines(text or ""):
        if c not in lines:
            lines.append(c)
    if authors:
        g["authors"][label] = authors
    if text and text.strip():
        key = text_key(text)
        for k, _, users in g["texts"]:
            if k == key:
                users.add(label)
                break
        else:
            g["texts"].append((key, without_copyright(text), {label}))


LICENSE_FILE = re.compile(r"licen[cs]e|copying|notice|copyright|unlicense|patents", re.I)
COMMENT = re.compile(r"^\s*(//+!?|/\*+|\*+/?|#(?![!\[]))\s?")


def comment_block(text):
    """A license header cargo-about found in a source file: its comment lines without the markers
    (the code around it is no notice)."""
    return "\n".join(COMMENT.sub("", line).rstrip() for line in text.split("\n") if COMMENT.match(line))


def rust(about_json, out_path):
    with open(about_json, encoding="utf-8") as f:
        data = json.load(f)
    groups = {}
    for lic in data["licenses"]:
        text = lic.get("text", "")
        source = os.path.basename(lic.get("source_path") or "")
        if source and not LICENSE_FILE.search(source):
            text = comment_block(text)
        for use in lic["used_by"]:
            c = use["crate"]
            authors = ", ".join(re.sub(r"\s*<[^>]*>", "", a) for a in c.get("authors") or [])
            add(groups, lic["id"], f"{c['name']} {c['version']}", text, authors)
    if not groups:
        raise Fail(f"no licenses in {about_json}")
    for lid, g in groups.items():
        if not g["texts"]:
            raise Fail(f"no license text for {lid}")
    text = render(
        "GitBolt: third-party notices for the Rust crates",
        "GitBolt's binary is built from the Rust crates below. Each crate is listed under the license\n"
        "GitBolt uses it under, with the copyright lines from its license files; the full text of each\n"
        "license follows its list. Generated by `just licenses` (cargo-about) from Cargo.lock.",
        "crate", groups)
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(text)


def cef(cef_dir, out_dir):
    credits = os.path.join(cef_dir, "CREDITS.html")
    if not os.path.isfile(credits):
        raise Fail(f"no CREDITS.html in {cef_dir}")
    os.makedirs(out_dir, exist_ok=True)
    license_txt = os.path.join(cef_dir, "LICENSE.txt")
    if os.path.isfile(license_txt):
        with open(license_txt, "rb") as f:
            text = f.read()
    else:
        try:
            with open(os.path.join(cef_dir, "archive.json"), encoding="utf-8") as f:
                archive = os.path.join(os.path.dirname(os.path.abspath(cef_dir)), json.load(f)["name"])
        except (OSError, KeyError, ValueError) as e:
            raise Fail(f"no LICENSE.txt in {cef_dir}, and its archive.json doesn't name the archive: {e}")
        if not os.path.isfile(archive):
            raise Fail(f"no LICENSE.txt in {cef_dir}, and the CEF archive {archive} is gone; "
                       "delete the CEF directory so the next build downloads it again")
        text = None
        # Stream mode reads only as far as the member: LICENSE.txt is among the first few entries.
        with tarfile.open(archive, "r|bz2") as t:
            for m in t:
                if m.isfile() and m.name.count("/") == 1 and m.name.endswith("/LICENSE.txt"):
                    text = t.extractfile(m).read()
                    break
        if not text:
            raise Fail(f"no top-level LICENSE.txt in {archive}")
    with open(os.path.join(out_dir, "CEF-LICENSE.txt"), "wb") as f:
        f.write(text)
    # About 20 MB of HTML: shipped gzipped (about 2 MB), as Debian does for large docs. mtime 0
    # keeps the output reproducible.
    with open(credits, "rb") as src, open(os.path.join(out_dir, "CHROMIUM-CREDITS.html.gz"), "wb") as raw:
        with gzip.GzipFile(filename="", mode="wb", fileobj=raw, compresslevel=9, mtime=0) as dst:
            shutil.copyfileobj(src, dst)


def cef_version(lock):
    with open(lock, encoding="utf-8") as f:
        m = re.search(r'\[\[package\]\]\nname = "cef"\nversion = "[^"+]*\+([^"]+)"', f.read())
    if not m:
        raise Fail(f"no `cef` crate with a +<CEF version> in {lock}")
    return m.group(1)


def main(argv):
    cmd, args = argv[1], argv[2:]
    if cmd == "rust":
        rust(*args)
    elif cmd == "cef":
        cef(*args)
    elif cmd == "cef-version":
        print(cef_version(*args))
    else:
        raise Fail(f"unknown subcommand {cmd}")


if __name__ == "__main__":
    try:
        main(sys.argv)
    except Fail as e:
        print(f"notices: {e}", file=sys.stderr)
        sys.exit(2)
