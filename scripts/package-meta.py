#!/usr/bin/env python3
"""The Linux packages' generated metadata, written by `just package` before the build.

Subcommands (errors go to stderr with exit status 2):
  metainfo <template> <CHANGELOG.md> <out>  the AppStream metainfo: the template with its
                                            <releases/> filled from the changelog's dated
                                            "## [<version>] - <YYYY-MM-DD>" sections (newest
                                            first, version and date) and @TAG@ replaced by the
                                            newest one's tag (v<version>), which pins the
                                            screenshot's URL to a release
  copyright <LICENSE> <out>                 /usr/share/doc/gitbolt/copyright in Debian's
                                            machine-readable format (DEP-5), with LICENSE's text
"""
import re
import sys
from xml.sax.saxutils import quoteattr

REPO = "https://github.com/GitBoltApp/gitbolt"
RELEASE = re.compile(r"## \[(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)\] - (\d{4}-\d{2}-\d{2})\s*")


class Fail(Exception):
    pass


def read(path):
    try:
        with open(path, encoding="utf-8") as f:
            return f.read()
    except OSError as e:
        raise Fail(f"can't read {path}: {e.strerror}")


def write(path, text):
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)


def releases(changelog):
    found = [m.groups() for line in changelog.split("\n") if (m := RELEASE.fullmatch(line))]
    if not found:
        raise Fail('the changelog has no dated "## [<version>] - <YYYY-MM-DD>" section')
    return found


def metainfo(template, changelog):
    rels = releases(changelog)
    if template.count("<releases/>") != 1 or "@TAG@" not in template:
        raise Fail("the template needs one <releases/> and a @TAG@")
    items = "".join(f"\n    <release version={quoteattr(v)} date={quoteattr(d)}/>" for v, d in rels)
    return template.replace("<releases/>", f"<releases>{items}\n  </releases>").replace("@TAG@", f"v{rels[0][0]}")


def copyright(license_text):
    m = re.search(r"^Copyright \(c\) (.+)$", license_text, re.M)
    if not license_text.startswith("MIT License") or not m:
        raise Fail("LICENSE isn't the MIT license with a 'Copyright (c) <year> <holder>' line")
    body = license_text.split(m.group(0), 1)[1].strip("\n")
    text = "\n".join(f" {line}" if line.strip() else " ." for line in body.split("\n"))
    return f"""Format: https://www.debian.org/doc/packaging-manuals/copyright-format/1.0/
Upstream-Name: GitBolt
Upstream-Contact: {REPO}/issues
Source: {REPO}
Comment: The binary also contains Rust crates and npm packages under their own licenses; each
 one, with its copyright lines and license text, is listed in THIRD-PARTY-NOTICES-rust.txt and
 THIRD-PARTY-NOTICES-ui.txt in this directory.

Files: *
Copyright: {m.group(1)}
License: MIT

Files: usr/share/GitBolt/*.so usr/share/GitBolt/*.so.* usr/share/GitBolt/*.pak
 usr/share/GitBolt/locales/* usr/share/GitBolt/chrome-sandbox usr/share/GitBolt/icudtl.dat
 usr/share/GitBolt/v8_context_snapshot.bin usr/share/GitBolt/vk_swiftshader_icd.json
Copyright: 2008-2020 Marshall A. Greenblatt
           2006-2009 Google Inc.
License: BSD-3-Clause
Comment: The Chromium Embedded Framework (CEF) and Chromium. CEF's license is in CEF-LICENSE.txt;
 Chromium's, and those of the projects it bundles, are in CHROMIUM-CREDITS.html.gz.

Files: usr/share/GitBolt/dictionaries/*
Copyright: 2000-2018 Kevin Atkinson, and others
License: SCOWL
Comment: Chromium's en-US Hunspell dictionary, derived from SCOWL.

License: MIT
{text}

License: BSD-3-Clause
 See CEF-LICENSE.txt in this directory.

License: SCOWL
 See DICTIONARY-en-US-LICENSE.txt in this directory: the dictionary's README, with the
 copyright and license terms of SCOWL and the works it is made from.
"""


def main(argv):
    cmd, args = (argv[1], argv[2:]) if len(argv) > 1 else ("", [])
    if cmd == "metainfo" and len(args) == 3:
        write(args[2], metainfo(read(args[0]), read(args[1])))
    elif cmd == "copyright" and len(args) == 2:
        write(args[1], copyright(read(args[0])))
    else:
        raise Fail(__doc__.split("Subcommands")[1])


if __name__ == "__main__":
    try:
        main(sys.argv)
    except Fail as e:
        print(f"package-meta: {e}", file=sys.stderr)
        sys.exit(2)
