#!/usr/bin/env python3
"""Usage: scripts/set-version.py <version>  (part of `just release`)

Sets GitBolt's version everywhere it's recorded, editing only the version lines (no
reformatting): crates/gitbolt-app/tauri.conf.json (what the packages are named after), the
workspace's [workspace.package] in Cargo.toml and the workspace members' entries in Cargo.lock,
ui/package.json, and ui/package-lock.json's two copies. Each file is parsed again afterwards
and must differ from the original only in those versions. Errors exit with status 2 before
any file is written.
"""
import json
import os
import re
import sys
import tomllib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class Fail(Exception):
    pass


def sub_once(text, pattern, version, what):
    """Replaces group 2 of the single first match of pattern (groups: prefix, old, suffix)."""
    m = re.search(pattern, text, re.M)
    if not m:
        raise Fail(f"can't find {what}")
    return text[:m.start(2)] + version + text[m.end(2):]


def json_edit(rel, version, edits):
    """edits: (pattern, key path) pairs, each pattern matching one version line."""
    path = os.path.join(ROOT, rel)
    text = open(path, encoding="utf-8").read()
    want = json.loads(text)
    for pattern, keys in edits:
        text = sub_once(text, pattern, version, f"{'.'.join(keys) or '?'} in {rel}")
        node = want
        for k in keys[:-1]:
            node = node[k]
        if keys[-1] not in node:
            raise Fail(f"{rel} has no {'.'.join(keys)}")
        node[keys[-1]] = version
    if json.loads(text) != want:
        raise Fail(f"editing {rel} changed more than its version")
    return path, text


def main(argv):
    if len(argv) != 2:
        raise Fail(__doc__.splitlines()[0])
    version = argv[1]
    if not re.fullmatch(r"[0-9A-Za-z.+-]+", version):
        raise Fail(f"unexpected characters in {version!r}")
    writes = []

    writes.append(json_edit("crates/gitbolt-app/tauri.conf.json", version,
                            [(r'^(  "version": ")([^"]*)(")', ["version"])]))
    writes.append(json_edit("ui/package.json", version, [(r'^(  "version": ")([^"]*)(")', ["version"])]))
    writes.append(json_edit("ui/package-lock.json", version, [
        (r'^(  "version": ")([^"]*)(")', ["version"]),
        (r'^(    "": \{\n(?:      .*\n)*?      "version": ")([^"]*)(")', ["packages", "", "version"]),
    ]))

    cargo_toml = os.path.join(ROOT, "Cargo.toml")
    text = open(cargo_toml, encoding="utf-8").read()
    want = tomllib.loads(text)
    want["workspace"]["package"]["version"] = version
    text = sub_once(text, r'^(\[workspace\.package\]\n(?:[^\[\n].*\n|\n)*?version = ")([^"]*)(")', version,
                    "[workspace.package] version in Cargo.toml")
    if tomllib.loads(text) != want:
        raise Fail("editing Cargo.toml changed more than its version")
    writes.append((cargo_toml, text))

    members = []
    for m in want["workspace"]["members"]:
        with open(os.path.join(ROOT, m, "Cargo.toml"), "rb") as f:
            pkg = tomllib.load(f)["package"]
        if pkg.get("version") != {"workspace": True}:
            raise Fail(f"{m}/Cargo.toml doesn't take the workspace version")
        members.append(pkg["name"])
    lock_path = os.path.join(ROOT, "Cargo.lock")
    text = open(lock_path, encoding="utf-8").read()
    want = tomllib.loads(text)
    for p in want["package"]:
        if p["name"] in members and "source" not in p:
            p["version"] = version
    for name in members:
        text = sub_once(text, rf'^(\[\[package\]\]\nname = "{re.escape(name)}"\nversion = ")([^"]*)(")', version,
                        f"{name} in Cargo.lock")
    if tomllib.loads(text) != want:
        raise Fail("editing Cargo.lock changed more than the workspace members' versions")
    writes.append((lock_path, text))

    for path, text in writes:
        with open(path, "w", encoding="utf-8") as f:
            f.write(text)
    print(f"set-version: {version} in " + ", ".join(os.path.relpath(p, ROOT) for p, _ in writes))


if __name__ == "__main__":
    try:
        main(sys.argv)
    except Fail as e:
        print(f"set-version: {e}", file=sys.stderr)
        sys.exit(2)
