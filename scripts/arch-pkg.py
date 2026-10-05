#!/usr/bin/env python3
"""Helpers for scripts/package-arch.sh (the Arch package built from the .deb, no makepkg).

Subcommands (each prints to stdout; errors go to stderr with exit status 2):
  pkgver <deb-version>          the Debian version as a pacman pkgver ('+' becomes '.')
  stamp <deb-version>           the build stamp in the version (+YYYYMMDDHHMM.) as a UTC epoch
  depends <Depends-field>       the Arch dependencies, one per line, sorted and de-duplicated
  escape <path>                 a path in mtree's escaping (tests)
  mtree <dir> <epoch> <out.gz>  writes the gzip-compressed .MTREE for everything under <dir>
  size <dir>                    installed size in bytes (apparent size, as makepkg reports it)
  verify <src.tar> <pkg.tar>    the package's payload matches the .deb's data member: same
                                paths, types, modes, sizes and link targets, every entry root:root
"""
import calendar
import fnmatch
import gzip
import hashlib
import os
import re
import stat
import sys
import tarfile
import time

# Debian package (glob) -> Arch packages. Order matters only for readability: every pattern is
# tried, and a Debian name that matches none is an error, so a new dependency is never dropped.
DEB_TO_ARCH = [
    ("libgtk-4-1", ["gtk4"]),
    ("libnss3", ["nss"]),
    ("libnspr4", ["nspr"]),
    ("libasound2*", ["alsa-lib"]),
    ("libatk*", ["at-spi2-core"]),
    ("libatspi*", ["at-spi2-core"]),
    ("libcairo2", ["cairo"]),
    ("libcups2*", ["libcups"]),
    ("libdbus-1-3", ["dbus"]),
    ("libexpat1", ["expat"]),
    ("libgbm1", ["mesa"]),
    ("libgcc-s1", ["gcc-libs", "glibc"]),
    ("libc6", ["gcc-libs", "glibc"]),
    ("libgdk-pixbuf-2.0-0", ["gdk-pixbuf2"]),
    ("libglib2.0-0*", ["glib2"]),
    ("libgraphene-1.0-0", ["graphene"]),
    ("libpango-1.0-0", ["pango"]),
    ("libudev1", ["systemd-libs"]),
    ("libwayland-client0", ["wayland"]),
    ("libx11-6", ["libx11"]),
    ("libxcb1", ["libxcb"]),
    ("libxcomposite1", ["libxcomposite"]),
    ("libxdamage1", ["libxdamage"]),
    ("libxext6", ["libxext"]),
    ("libxfixes3", ["libxfixes"]),
    ("libxkbcommon0", ["libxkbcommon"]),
    ("libxrandr2", ["libxrandr"]),
    ("git", ["git"]),
]


class Fail(Exception):
    pass


def pkgver(debver):
    v = debver.strip().replace("+", ".")
    if not v or re.search(r"[-:/\s]", v):
        raise Fail(f"can't map the .deb version {debver!r} to a pkgver (no '-', ':', '/' or spaces allowed)")
    if not re.fullmatch(r"[A-Za-z0-9._~]+", v):
        raise Fail(f"unexpected characters in the .deb version {debver!r}")
    return v


def stamp(debver):
    m = re.search(r"\+(\d{12})(\.|$)", debver)
    if not m:
        raise Fail(f"no +YYYYMMDDHHMM build stamp in {debver!r}")
    return calendar.timegm(time.strptime(m.group(1), "%Y%m%d%H%M"))


def depends(field):
    out = set()
    unknown = []
    for item in field.split(","):
        item = item.strip()
        if not item:
            continue
        if "|" in item:
            raise Fail(f"alternative dependencies aren't supported: {item!r}; add a rule to scripts/arch-pkg.py")
        name = re.split(r"[\s(:]", item, maxsplit=1)[0]
        hits = [arch for pat, arch in DEB_TO_ARCH if fnmatch.fnmatchcase(name, pat)]
        if not hits:
            unknown.append(name)
            continue
        for arch in hits:
            out.update(arch)
    if unknown:
        raise Fail("unknown Debian dependencies (add them to DEB_TO_ARCH in scripts/arch-pkg.py): " + ", ".join(unknown))
    return sorted(out)


def escape(path):
    """libarchive's mtree_quote: every byte outside '!'..'~', plus '#', '=' and '\\', becomes \\ooo."""
    b = path.encode("utf-8", "surrogateescape") if isinstance(path, str) else path
    return "".join(chr(c) if 0x21 <= c <= 0x7E and c not in b"#=\\" else "\\%03o" % c for c in b)


def walk(root):
    """Every path under root (relative, without './'), sorted bytewise like makepkg's LC_COLLATE=C glob."""
    found = []
    for dirpath, dirnames, filenames in os.walk(root):
        for n in dirnames + filenames:
            found.append(os.path.relpath(os.path.join(dirpath, n), root))
    return sorted(found, key=lambda p: os.fsencode(p))


def digests(path):
    md5, sha = hashlib.md5(), hashlib.sha256()
    with open(path, "rb") as f:
        while chunk := f.read(1 << 20):
            md5.update(chunk)
            sha.update(chunk)
    return md5.hexdigest(), sha.hexdigest()


def mtree_lines(root, epoch):
    """pacman's .MTREE (bsdtar --format=mtree with makepkg's options): one /set, then per-entry overrides."""
    lines = ["#mtree", "/set type=file uid=0 gid=0 mode=644"]
    for rel in walk(root):
        if rel == ".MTREE":
            continue
        full = os.path.join(root, rel)
        st = os.lstat(full)
        attrs = [f"time={epoch}.0"]
        if stat.S_ISLNK(st.st_mode):
            attrs += ["mode=777", "type=link", "link=" + escape(os.readlink(full))]
        elif stat.S_ISDIR(st.st_mode):
            mode = stat.S_IMODE(st.st_mode)
            if mode != 0o644:
                attrs.append("mode=%o" % mode)
            attrs.append("type=dir")
        elif stat.S_ISREG(st.st_mode):
            mode = stat.S_IMODE(st.st_mode)
            if mode != 0o644:
                attrs.append("mode=%o" % mode)
            md5, sha = digests(full)
            attrs += [f"size={st.st_size}", f"md5digest={md5}", f"sha256digest={sha}"]
        else:
            raise Fail(f"unsupported file type in the payload: {rel}")
        lines.append("./" + escape(rel) + " " + " ".join(attrs))
    return lines


def write_mtree(root, epoch, out):
    data = ("\n".join(mtree_lines(root, int(epoch))) + "\n").encode()
    with open(out, "wb") as raw, gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0, compresslevel=9) as gz:
        gz.write(data)


def installed_size(root):
    total = 0
    for rel in walk(root):
        if rel.startswith("."):
            continue
        st = os.lstat(os.path.join(root, rel))
        if stat.S_ISREG(st.st_mode) or stat.S_ISLNK(st.st_mode):
            total += st.st_size
    return total


def entries(tarpath, skip_meta):
    got = {}
    with tarfile.open(tarpath, "r|") as t:
        for m in t:
            name = m.name[2:] if m.name.startswith("./") else m.name
            name = name.rstrip("/")
            if name in ("", ".") or (skip_meta and name in (".PKGINFO", ".MTREE")):
                continue
            kind = "dir" if m.isdir() else "link" if m.issym() else "hardlink" if m.islnk() else "file" if m.isfile() else "other"
            # A symlink's mode means nothing on Linux (tar records 755 or 777 depending on the tool).
            got[name] = (kind, 0 if m.issym() else m.mode & 0o7777, m.size if m.isfile() else 0, m.linkname if (m.issym() or m.islnk()) else "", m.uid, m.gid, m.uname, m.gname)
    return got


def verify(src, pkg):
    a = entries(src, False)
    b = entries(pkg, True)
    problems = []
    for name in sorted(set(a) | set(b)):
        if name not in b:
            problems.append(f"missing from the package: {name}")
        elif name not in a:
            problems.append(f"not in the .deb: {name}")
        elif a[name][:4] != b[name][:4]:
            problems.append(f"differs: {name}: .deb {a[name][:4]} vs package {b[name][:4]}")
    for name, e in b.items():
        if e[4:] != (0, 0, "root", "root"):
            problems.append(f"not root:root: {name} {e[4:]}")
    if problems:
        raise Fail("payload check failed:\n  " + "\n  ".join(problems[:50]))
    return len(b)


def main(argv):
    cmd, args = argv[1], argv[2:]
    if cmd == "pkgver":
        print(pkgver(args[0]))
    elif cmd == "stamp":
        print(stamp(args[0]))
    elif cmd == "depends":
        print("\n".join(depends(args[0])))
    elif cmd == "escape":
        print(escape(args[0]))
    elif cmd == "mtree":
        write_mtree(args[0], args[1], args[2])
    elif cmd == "size":
        print(installed_size(args[0]))
    elif cmd == "verify":
        print(verify(args[0], args[1]))
    else:
        raise Fail(f"unknown subcommand {cmd}")


if __name__ == "__main__":
    try:
        main(sys.argv)
    except Fail as e:
        print(f"package-arch: {e}", file=sys.stderr)
        sys.exit(2)
