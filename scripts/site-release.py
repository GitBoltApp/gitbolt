#!/usr/bin/env python3
"""The website's downloads: site/data/release.json, which the landing page's Downloads section
reads. .github/workflows/site-release.yml writes it; see docs/website.md.

Subcommands (errors go to stderr with exit status 2):
  pick <releases.json> [<tag>]  the tag the site shows: <tag> when given (a published release),
                                else the newest published release by SemVer that isn't a
                                pre-release, else the newest pre-release; an empty line when
                                there's no published release
  write <owner/name> <releases.json> <tag> <SHA256SUMS>
                                release.json for <tag>: its packages, found by the names
                                docs/releasing.md lists, each with its size and SHA-256
  empty                         release.json while there's no published release

<releases.json> is GitHub's release list as one JSON array (gh api --paginate
repos/<owner/name>/releases --jq '.[]' | jq -s .). Drafts and tags that aren't v<version> are
skipped. Every package must be in SHA256SUMS and match the digest GitHub reports for it.
"""
import json
import os
import re
import sys
from urllib.parse import quote

sys.dont_write_bytecode = True  # importing version.py mustn't leave scripts/__pycache__
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import version  # noqa: E402  (scripts/version.py: the SemVer rules)

SCHEMA = 1


class Fail(Exception):
    pass


def packages(v):
    """(os, kind, arch, asset name) of each package a release of version `v` may have, in the
    order the site lists them: docs/releasing.md's "Asset names are an API"."""
    pkgver = version.deb(v).replace("~", "")  # as scripts/arch-pkg.py: 0.1.0-alpha.1 -> 0.1.0alpha.1
    return [
        ("linux", "deb", "x86_64", f"GitVolt_{v}_amd64.deb"),
        ("linux", "rpm", "x86_64", f"GitVolt-{v}-1.x86_64.rpm"),
        ("linux", "arch", "x86_64", f"GitVolt-{pkgver}-1-x86_64.pkg.tar.zst"),
        ("macos", "dmg", "aarch64", f"GitVolt_{v}_aarch64.dmg"),
        ("macos", "dmg", "x86_64", f"GitVolt_{v}_x64.dmg"),
        ("windows", "nsis", "x86_64", f"GitVolt_{v}_x64-setup.exe"),
        ("windows", "msi", "x86_64", f"GitVolt_{v}_x64.msi"),
    ]


def load(path):
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError) as e:
        raise Fail(f"can't read {path}: {e}")
    if not isinstance(data, list):
        raise Fail(f"{path}: expected a JSON array of releases")
    return data


def version_of(tag):
    """The version of a v<version> tag, or None for any other tag."""
    if not isinstance(tag, str) or not tag.startswith("v"):
        return None
    try:
        version.check(tag[1:])
    except version.Fail:
        return None
    return tag[1:]


def published(releases):
    return [r for r in releases if not r.get("draft") and version_of(r.get("tag_name"))]


def is_prerelease(release):
    return bool(release.get("prerelease")) or version.parse(version_of(release["tag_name"]))[1] is not None


def newest(releases):
    best = None
    for r in releases:
        if best is None or version.cmp(version_of(r["tag_name"]), version_of(best["tag_name"])) > 0:
            best = r
    return best


def pick(releases, tag=""):
    pub = published(releases)
    if tag:
        if not any(r["tag_name"] == tag for r in pub):
            raise Fail(f"{tag} isn't a published release with a v<version> tag")
        return tag
    best = newest([r for r in pub if not is_prerelease(r)]) or newest(pub)
    return best["tag_name"] if best else ""


def read_sums(path):
    try:
        with open(path, encoding="utf-8") as f:
            lines = f.read().splitlines()
    except OSError as e:
        raise Fail(f"can't read {path}: {e}")
    sums = {}
    for n, line in enumerate(lines, 1):
        if not line.strip():
            continue
        m = re.fullmatch(r"([0-9a-f]{64}) [ *](.+)", line)
        if not m:
            raise Fail(f"{path}:{n}: not a sha256sum line: {line!r}")
        if m.group(2) in sums:
            raise Fail(f"{path}:{n}: {m.group(2)} is listed twice")
        sums[m.group(2)] = m.group(1)
    return sums


def write(repo, releases, tag, sums):
    if not re.fullmatch(r"(?!\.+/)[A-Za-z0-9_.-]+/(?!\.+$)[A-Za-z0-9_.-]+", repo):
        raise Fail(f"{repo!r} isn't an owner/name")
    release = next((r for r in published(releases) if r["tag_name"] == tag), None)
    if release is None:
        raise Fail(f"{tag} isn't a published release with a v<version> tag")
    v = version_of(tag)
    assets = {a["name"]: a for a in release.get("assets") or []}
    if "SHA256SUMS" not in assets:
        raise Fail(f"{tag} has no SHA256SUMS")
    download = f"https://github.com/{repo}/releases/download/{quote(tag)}/"
    downloads = []
    for os_name, kind, arch, name in packages(v):
        asset = assets.get(name)
        if asset is None:
            continue
        sha = sums.get(name)
        if sha is None:
            raise Fail(f"{name} isn't in {tag}'s SHA256SUMS")
        digest = asset.get("digest")
        if digest and digest.lower() != f"sha256:{sha}":
            raise Fail(f"{name}: SHA256SUMS says {sha}, GitHub says {digest}")
        if not isinstance(asset.get("size"), int):
            raise Fail(f"{name} has no size in {tag}'s release data")
        downloads.append({"os": os_name, "kind": kind, "arch": arch, "file": name,
                          "url": download + quote(name), "bytes": asset["size"], "sha256": sha})
    if not downloads:
        raise Fail(f"{tag} has none of the packages docs/releasing.md names")
    if not release.get("published_at"):
        raise Fail(f"{tag} has no published_at")
    return {"schema": SCHEMA, "release": {
        "version": v,
        "tag": tag,
        "prerelease": is_prerelease(release),
        "published": release.get("published_at"),
        "url": f"https://github.com/{repo}/releases/tag/{quote(tag)}",
        "sums": download + "SHA256SUMS",
        "downloads": downloads,
    }}


def dump(data):
    sys.stdout.write(json.dumps(data, indent=2, ensure_ascii=False) + "\n")


def main(argv):
    cmd, args = (argv[1], argv[2:]) if len(argv) >= 2 else ("", [])
    if cmd == "pick" and len(args) in (1, 2):
        print(pick(load(args[0]), args[1] if len(args) == 2 else ""))
        return
    if cmd == "write" and len(args) == 4:
        dump(write(args[0], load(args[1]), args[2], read_sums(args[3])))
        return
    if cmd == "empty" and not args:
        dump({"schema": SCHEMA, "release": None})
        return
    raise Fail(__doc__.split("Subcommands")[1])


if __name__ == "__main__":
    try:
        main(sys.argv)
    except Fail as e:
        print(f"site-release: {e}", file=sys.stderr)
        sys.exit(2)
