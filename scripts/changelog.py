#!/usr/bin/env python3
"""CHANGELOG.md (Keep a Changelog) for `just release` and the release workflow.

Subcommands (errors go to stderr with exit status 2; a failed command leaves the file as it was):
  release <version> <YYYY-MM-DD> <file>  turns the "## [Unreleased]" heading into
                                         "## [<version>] - <date>" under a fresh, empty
                                         "## [Unreleased]". Refuses an empty Unreleased section
                                         or a version that already has a section.
  notes <version> <file>                 prints the body of the "## [<version>]" section (the
                                         release notes): up to the next "## " heading, without
                                         the surrounding blank lines or trailing link references.
"""
import re
import sys

LINK_REF = re.compile(r"\[[^\]]+\]:\s+\S")


class Fail(Exception):
    pass


def read(path):
    try:
        with open(path, encoding="utf-8") as f:
            return f.read().split("\n")
    except OSError as e:
        raise Fail(f"can't read {path}: {e.strerror}")


def heading_re(version):
    return re.compile(rf"## \[{re.escape(version)}\](?:\s+-\s+.*)?\s*")


def find(lines, version):
    """(index of the "## [version]" heading, the section's body lines), or None."""
    pattern = heading_re(version)
    for i, line in enumerate(lines):
        if pattern.fullmatch(line):
            end = next((j for j in range(i + 1, len(lines)) if lines[j].startswith("## ")), len(lines))
            body = lines[i + 1:end]
            while body and (not body[-1].strip() or LINK_REF.match(body[-1])):
                body.pop()
            while body and not body[0].strip():
                body.pop(0)
            return i, body
    return None


def release(version, date, path):
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date):
        raise Fail(f"the date {date!r} isn't YYYY-MM-DD")
    lines = read(path)
    if find(lines, version):
        raise Fail(f'{path} already has a "## [{version}]" section')
    found = find(lines, "Unreleased")
    if not found:
        raise Fail(f'{path} has no "## [Unreleased]" heading')
    i, body = found
    if not body:
        raise Fail(f"{path}: the Unreleased section is empty; list the release's changes there first")
    lines[i:i + 1] = ["## [Unreleased]", "", f"## [{version}] - {date}"]
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))


def notes(version, path):
    found = find(read(path), version)
    if not found:
        raise Fail(f'{path} has no "## [{version}]" section')
    if not found[1]:
        raise Fail(f'{path}: the "## [{version}]" section is empty')
    print("\n".join(found[1]))


def main(argv):
    cmd, args = (argv[1], argv[2:]) if len(argv) > 1 else ("", [])
    if cmd == "release" and len(args) == 3:
        release(*args)
    elif cmd == "notes" and len(args) == 2:
        notes(*args)
    else:
        raise Fail(__doc__.split("Subcommands")[1])


if __name__ == "__main__":
    try:
        main(sys.argv)
    except Fail as e:
        print(f"changelog: {e}", file=sys.stderr)
        sys.exit(2)
