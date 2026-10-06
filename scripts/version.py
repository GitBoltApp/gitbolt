#!/usr/bin/env python3
"""GitBolt's version rules (`just release`, `just package`, fix-deb.sh, the release workflow).

A release version is SemVer without build metadata: X.Y.Z or X.Y.Z-<pre-release>, where the
pre-release is dot-separated identifiers that are each lowercase letters or a number, the first
a word: 0.1.0-alpha.1, 0.2.0-rc.2. That subset keeps one order everywhere: SemVer's, dpkg's
(0.1.0~alpha.1) and pacman's vercmp (0.1.0alpha.1; see scripts/test-version-order.sh). Mixed
identifiers such as alpha10 would sort differently in SemVer and vercmp, so they're refused.

Subcommands (errors go to stderr with exit status 2):
  check <version>       exit 0 when <version> is a valid release version
  deb <version>         the Debian version: '-' before the pre-release becomes '~' (it sorts
                        before the release); a +build stamp is kept. Idempotent.
  prerelease <version>  prints true or false
  cmp <a> <b>           prints -1, 0 or 1 by SemVer precedence
"""
import re
import sys

NUM = r"(?:0|[1-9][0-9]*)"
CORE = rf"{NUM}\.{NUM}\.{NUM}"
IDENT = rf"(?:[a-z]+|{NUM})"
PRE = rf"[a-z]+(?:\.{IDENT})*"
BUILD = r"[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*"


class Fail(Exception):
    pass


def check(v):
    if re.fullmatch(rf"{CORE}(?:-{PRE})?", v):
        return
    if not re.fullmatch(rf"{CORE}(?:-.*)?", v):
        raise Fail(f"{v!r} isn't a release version: expected X.Y.Z or X.Y.Z-<pre-release>, "
                   "numbers without leading zeros, no 'v' and no +build")
    raise Fail(f"{v!r}: the pre-release must start with a lowercase word (alpha, beta, rc), then "
               "dot-separated lowercase words or numbers without leading zeros: 0.1.0-alpha.1")


def parse(v):
    """(core, pre or None, build or None) of a release version, a +build stamped one, or the
    Debian form of either."""
    m = re.fullmatch(rf"({CORE})(?:[-~]({PRE}))?(?:\+({BUILD}))?", v)
    if not m:
        raise Fail(f"can't parse the version {v!r}")
    return m.group(1), m.group(2), m.group(3)


def deb(v):
    core, pre, build = parse(v)
    return core + (f"~{pre}" if pre else "") + (f"+{build}" if build else "")


def cmp(a, b):
    def key(v):
        core, pre, _ = parse(v)
        nums = tuple(int(x) for x in core.split("."))
        if pre is None:
            return nums, (1,)
        # Numeric identifiers sort before words, numbers numerically, and a shorter list first.
        return nums, (0, tuple((0, int(i), "") if i.isdigit() else (1, 0, i) for i in pre.split(".")))
    ka, kb = key(a), key(b)
    return (ka > kb) - (ka < kb)


def main(argv):
    if len(argv) >= 2:
        cmd, args = argv[1], argv[2:]
        if cmd == "check" and len(args) == 1:
            check(args[0])
            return
        if cmd == "deb" and len(args) == 1:
            print(deb(args[0]))
            return
        if cmd == "prerelease" and len(args) == 1:
            print("true" if parse(args[0])[1] else "false")
            return
        if cmd == "cmp" and len(args) == 2:
            print(cmp(*args))
            return
    raise Fail(__doc__.split("Subcommands")[1])


if __name__ == "__main__":
    try:
        main(sys.argv)
    except Fail as e:
        print(f"version: {e}", file=sys.stderr)
        sys.exit(2)
