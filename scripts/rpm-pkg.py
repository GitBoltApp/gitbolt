#!/usr/bin/env python3
"""Helpers for scripts/package-rpm.sh (the RPM built from the .deb, without rpmbuild).

Subcommands (each prints to stdout; errors go to stderr with exit status 2):
  version <deb-version>         the RPM Version: the Debian one as is. rpm sorts '~' before
                                anything too (0.1.0~alpha.1 < 0.1.0), and '+' is a separator, so
                                a stamped local build sorts after its version, as in dpkg
  filever <deb-version>         the version in the file name: SemVer, as in the .deb's and every
                                other asset's (0.1.0~alpha.1 -> 0.1.0-alpha.1)
  depends <Depends-field>       the Requires that the .deb's Depends adds to the ELF scan's, one
                                per line: git (>= 1:2.40) -> git-core >= 2.40, libgtk-4-1 ->
                                libgtk-4.so.1()(64bit). Other lib* names come from the ELF files
                                (dpkg-shlibdeps found them there), any other name fails
  elfreqs <dir>                 the shared libraries and symbol versions the ELF files under <dir>
                                need and the payload doesn't bring, as rpm's elfdeps names them:
                                libnss3.so()(64bit), libc.so.6(GLIBC_2.34)(64bit)
  build <control> <dir> <out-dir> <epoch> <license>
                                writes <out-dir>/GitVolt-<filever>-1.x86_64.rpm (printed) from the
                                .deb's control file and the payload under <dir>
  verify <data.tar> <pkg.rpm> [edited...]
                                reads the package back: its digests, the header's file list
                                against the cpio payload, and the payload against the .deb's data
                                member (same paths, types, modes, sizes and link targets, less the
                                system directories, plus RPM_EXTRA; the edited files' sizes may
                                differ), every entry root:root

The package is a v4 RPM, as rpmbuild writes it: the lead, the signature header (SHA256 and SHA1
of the header, MD5 of header and payload, sizes; no signature), the header, and a zstd-compressed
cpio (newc) payload with ./-prefixed names. Fedora's rpm 6 and openSUSE's rpm 4 both read it.
"""
import hashlib
import importlib.util
import os
import re
import stat
import struct
import subprocess
import sys

here = os.path.dirname(os.path.abspath(__file__))
sys.dont_write_bytecode = True  # no scripts/__pycache__ from the two modules below


def _load(name, file):
    spec = importlib.util.spec_from_file_location(name, os.path.join(here, file))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


archpkg = _load("archpkg", "arch-pkg.py")
version_py = _load("version_py", "version.py")


class Fail(Exception):
    pass


NAME = "gitvolt"
RELEASE = "1"
ARCH = "x86_64"
URL_DEFAULT = "https://github.com/GitVoltApp/gitvolt"

# The directories the package owns: its own. The rest of the .deb's directories belong to the
# system (filesystem, hicolor-icon-theme), and owning one with another mode is a file conflict
# (Fedora's /usr/bin is 555), so the package leaves them out. A directory in neither list fails
# the build, so a new one is never silently left unowned.
OWNED_DIRS = re.compile(r"usr/share/GitVolt(/.*)?|usr/share/doc/gitvolt(/.*)?")
SYSTEM_DIRS = re.compile(r"usr|usr/bin|usr/share|usr/share/(applications|doc|licenses|metainfo|icons)|usr/share/icons/hicolor(/[^/]+(/apps)?)?")
# The license notices: %license files, which rpm installs even with --nodocs (dnf's
# tsflags=nodocs, the default in Fedora's container images).
LICENSE_FILES = re.compile(r"usr/share/doc/gitvolt/[^/]+")
RPMFILE_DOC, RPMFILE_LICENSE = 1 << 1, 1 << 7

# What package-rpm.sh adds to the .deb's payload: Fedora's license directory, a symlink to the
# .deb's /usr/share/doc/gitvolt (as in the Arch package).
RPM_EXTRA = {"usr/share/licenses/gitvolt": ("link", 0, 0, "../doc/gitvolt")}

# Debian dependencies that the ELF scan doesn't name: Debian package -> RPM requirement. git is a
# program, not a library (git-core is its package on Fedora and openSUSE, without git's Perl and
# GUI parts), and libgtk-4-1 is named by tauri.conf.json.
DEB_TO_RPM = {"git": "git-core", "libgtk-4-1": "libgtk-4.so.1()(64bit)"}

# rpm's dependency flags
LESS, GREATER, EQUAL, RPMLIB = 1 << 1, 1 << 2, 1 << 3, 1 << 24
OPS = {"<": LESS, "<=": LESS | EQUAL, "=": EQUAL, ">=": GREATER | EQUAL, ">": GREATER}

# GitBolt's package (the app's name before 0.7.0): dnf and zypper replace it with this one. Bounded,
# so another project's gitbolt package is never touched.
OBSOLETES = [("gitbolt", LESS, "0.7.0")]

# Header data types
INT16, INT32, STRING, BIN, STRING_ARRAY, I18NSTRING = 3, 4, 6, 7, 8, 9


def rpm_version(debver):
    v = debver.strip()
    if not re.fullmatch(r"[0-9][A-Za-z0-9._+~]*", v):
        raise Fail(f"can't use the .deb version {debver!r} as an RPM version (no '-', ':' or spaces)")
    return v


def file_version(debver):
    core, pre, build = version_py.parse(rpm_version(debver))
    return core + (f"-{pre}" if pre else "") + (f"+{build}" if build else "")


def depends(field):
    out = set()
    unknown = []
    for item in field.split(","):
        item = item.strip()
        if not item:
            continue
        if "|" in item:
            raise Fail(f"alternative dependencies aren't supported: {item!r}; add a rule to scripts/rpm-pkg.py")
        m = re.fullmatch(r"([^\s(]+)\s*(?:\(\s*(<<|<=|=|>=|>>)\s*([^)\s]+)\s*\))?", item)
        if not m:
            raise Fail(f"can't parse the dependency {item!r}")
        name, op, ver = m.groups()
        if name in DEB_TO_RPM:
            target = DEB_TO_RPM[name]
            if op and not target.endswith(")"):
                op = {"<<": "<", ">>": ">"}.get(op, op)
                ver = ver.split(":", 1)[-1]  # a Debian epoch means nothing to the RPM's version
                out.add(f"{target} {op} {ver}")
            else:
                out.add(target)
        elif not name.startswith("lib"):
            unknown.append(name)
    if unknown:
        raise Fail("unknown Debian dependencies (add them to DEB_TO_RPM in scripts/rpm-pkg.py): " + ", ".join(unknown))
    return sorted(out)


def walk(root):
    found = []
    for dirpath, dirnames, filenames in os.walk(root):
        for n in dirnames + filenames:
            found.append(os.path.relpath(os.path.join(dirpath, n), root))
    return sorted(found, key=lambda p: os.fsencode(p))


def is_elf(path):
    with open(path, "rb") as f:
        head = f.read(5)
    if head[:4] != b"\x7fELF":
        return False
    if head[4] != 2:
        raise Fail(f"{path} is a 32-bit ELF file; the package is x86_64 only")
    return True


def readelf(path, opt):
    out = subprocess.run(["readelf", "-W", opt, path], capture_output=True, text=True, env={**os.environ, "LC_ALL": "C"})
    if out.returncode != 0:
        raise Fail(f"readelf {opt} {path}: {out.stderr.strip()}")
    return out.stdout


def elf_info(path):
    """(soname or None, NEEDED sonames, {soname: [versions]}) of one ELF file."""
    dyn = readelf(path, "-d")
    soname = re.search(r"\(SONAME\)\s+Library soname: \[(.+?)\]", dyn)
    needed = re.findall(r"\(NEEDED\)\s+Shared library: \[(.+?)\]", dyn)
    versions = {}
    section = readelf(path, "-V").split("Version needs section", 1)
    if len(section) == 2:
        current = None
        for line in section[1].split("\n")[1:]:
            if not line.strip():
                continue
            if not line.startswith(" "):
                break  # the next section
            m = re.search(r"File: (\S+)", line)
            if m:
                current = m.group(1)
                continue
            m = re.search(r"Name: (\S+)", line)
            if m and current:
                versions.setdefault(current, []).append(m.group(1))
    return soname.group(1) if soname else None, needed, versions


def elfreqs(root):
    infos = []
    provided = set()
    for rel in walk(root):
        full = os.path.join(root, rel)
        if os.path.islink(full) or not os.path.isfile(full) or not is_elf(full):
            continue
        soname, needed, versions = elf_info(full)
        infos.append((needed, versions))
        provided.add(os.path.basename(rel))
        if soname:
            provided.add(soname)
    if not infos:
        raise Fail(f"no ELF files under {root}")
    out = set()
    for needed, versions in infos:
        for lib in needed:
            if lib not in provided:
                out.add(f"{lib}()(64bit)")
        for lib, names in versions.items():
            if lib in provided:
                continue
            for v in names:
                if v != "GLIBC_PRIVATE":
                    out.add(f"{lib}({v})(64bit)")
    return sorted(out)


def parse_req(text):
    """'name', or 'name op version', as (name, flags, version)."""
    parts = text.split()
    if len(parts) == 1:
        return parts[0], 0, ""
    if len(parts) == 3 and parts[1] in OPS:
        return parts[0], OPS[parts[1]], parts[2]
    raise Fail(f"can't parse the requirement {text!r}")


def control_fields(path):
    fields = {}
    key = None
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.rstrip("\n")
            if line.startswith((" ", "\t")) and key:
                fields[key] += "\n" + line
            elif ":" in line:
                key, value = line.split(":", 1)
                fields[key] = value.strip()
    return fields


def description(field):
    """The Debian Description's summary, and its long text as plain paragraphs."""
    lines = field.split("\n")
    body = []
    for line in lines[1:]:
        line = line[1:] if line.startswith(" ") else line
        body.append("" if line == "." else line)
    return lines[0].strip(), "\n".join(body).strip()


# --- the header -----------------------------------------------------------------------------


def encode(typ, value):
    """(count, bytes) of a value of a header type."""
    if typ in (STRING, I18NSTRING):
        return 1, value.encode() + b"\0"
    if typ == STRING_ARRAY:
        return len(value), b"".join(v.encode() + b"\0" for v in value)
    if typ == INT32:
        return len(value), struct.pack(f">{len(value)}I", *(v & 0xFFFFFFFF for v in value))
    if typ == INT16:
        return len(value), struct.pack(f">{len(value)}H", *value)
    if typ == BIN:
        return len(value), bytes(value)
    raise Fail(f"unsupported header type {typ}")


def header(region, tags):
    """An rpm header blob: the immutable region entry first, then the tags in order, their data
    aligned for their type, and the region trailer at the end of the data."""
    index = []
    store = bytearray()
    for tag, typ, value in sorted(tags, key=lambda t: t[0]):
        count, data = encode(typ, value)
        align = {INT16: 2, INT32: 4}.get(typ, 1)
        store += b"\0" * (-len(store) % align)
        index.append(struct.pack(">IIII", tag, typ, len(store), count))
        store += data
    il = len(index) + 1
    trailer_at = len(store)
    store += struct.pack(">IIiI", region, BIN, -il * 16, 16)
    return b"\x8e\xad\xe8\x01\0\0\0\0" + struct.pack(">II", il, len(store)) + struct.pack(">IIII", region, BIN, trailer_at, 16) + b"".join(index) + bytes(store)


def read_header(data, off):
    """{tag: value} of the header at off, and where it ends."""
    if data[off:off + 4] != b"\x8e\xad\xe8\x01":
        raise Fail(f"no header at {off}")
    il, dl = struct.unpack(">II", data[off + 8:off + 16])
    store = data[off + 16 + il * 16:off + 16 + il * 16 + dl]
    tags = {}
    for i in range(il):
        tag, typ, o, count = struct.unpack(">IIiI", data[off + 16 + i * 16:off + 32 + i * 16])
        if typ in (STRING, I18NSTRING):
            v = store[o:store.index(b"\0", o)].decode()
        elif typ == STRING_ARRAY:
            v, p = [], o
            for _ in range(count):
                e = store.index(b"\0", p)
                v.append(store[p:e].decode())
                p = e + 1
        elif typ == INT32:
            v = list(struct.unpack(f">{count}I", store[o:o + 4 * count]))
        elif typ == INT16:
            v = list(struct.unpack(f">{count}H", store[o:o + 2 * count]))
        else:
            v = bytes(store[o:o + count])
        tags[tag] = v
    return tags, off + 16 + il * 16 + dl


# --- the payload ----------------------------------------------------------------------------


def cpio_entry(ino, mode, mtime, size, name):
    name = b"./" + name.encode() + b"\0"
    head = b"070701" + b"".join(b"%08X" % v for v in (ino, mode, 0, 0, 1, mtime, size, 0, 0, 0, 0, len(name), 0))
    return head + name + b"\0" * (-(110 + len(name)) % 4)


def files_of(root, epoch):
    """The package's files, sorted by path, as dicts; the .deb's system directories left out."""
    out = []
    for rel in walk(root):
        full = os.path.join(root, rel)
        st = os.lstat(full)
        e = {"path": rel, "mode": st.st_mode, "mtime": epoch, "digest": "", "link": "", "flags": 0}
        if stat.S_ISDIR(st.st_mode):
            if not OWNED_DIRS.fullmatch(rel):
                if SYSTEM_DIRS.fullmatch(rel):
                    continue
                raise Fail(f"the directory {rel} is neither GitVolt's nor a system one: add it to OWNED_DIRS or SYSTEM_DIRS in scripts/rpm-pkg.py")
            e["size"] = 0
        elif stat.S_ISLNK(st.st_mode):
            e["link"] = os.readlink(full)
            e["size"] = len(os.fsencode(e["link"]))
        elif stat.S_ISREG(st.st_mode):
            e["size"] = st.st_size
            if st.st_size >= 1 << 32:
                raise Fail(f"{rel} is 4 GB or more; the package would need rpm's 64-bit size tags")
            e["digest"] = archpkg.digests(full)[1]
            if LICENSE_FILES.fullmatch(rel):
                e["flags"] = RPMFILE_LICENSE | RPMFILE_DOC
        else:
            raise Fail(f"unsupported file type in the payload: {rel}")
        if os.fsencode(rel) != rel.encode("utf-8", "strict"):
            raise Fail(f"not UTF-8: {rel!r}")
        out.append(e)
    return out


def write_cpio(root, files, out):
    """The newc archive of the files, in order; (uncompressed size, its SHA-256)."""
    sha = hashlib.sha256()
    size = 0
    with open(out, "wb") as f:
        def put(b):
            nonlocal size
            f.write(b)
            sha.update(b)
            size += len(b)

        for ino, e in enumerate(files, 1):
            put(cpio_entry(ino, e["mode"], e["mtime"], e["size"] if not stat.S_ISDIR(e["mode"]) else 0, e["path"]))
            if stat.S_ISLNK(e["mode"]):
                put(os.fsencode(e["link"]))
            elif stat.S_ISREG(e["mode"]):
                with open(os.path.join(root, e["path"]), "rb") as src:
                    while chunk := src.read(1 << 20):
                        put(chunk)
            else:
                continue
            put(b"\0" * (-e["size"] % 4))
        trailer = b"070701" + b"".join(b"%08X" % v for v in (0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 11, 0)) + b"TRAILER!!!\0"
        put(trailer + b"\0" * (-len(trailer) % 4))
    return size, sha.hexdigest()


def sha256_file(path):
    return archpkg.digests(path)[1]


def build(control, root, outdir, epoch, license_):
    fields = control_fields(control)
    debver = fields["Version"]
    version = rpm_version(debver)
    summary, desc = description(fields["Description"])
    url = fields.get("Homepage") or URL_DEFAULT
    epoch = int(epoch)

    reqs = {parse_req(r) for r in depends(fields.get("Depends", "")) + elfreqs(root)}
    rpmlib = [("rpmlib(CompressedFileNames)", "3.0.4-1"), ("rpmlib(FileDigests)", "4.6.0-1"),
              ("rpmlib(PayloadFilesHavePrefix)", "4.0-1"), ("rpmlib(PayloadIsZstd)", "5.4.18-1")]
    if "~" in version:
        rpmlib.append(("rpmlib(TildeInVersions)", "4.10.0-1"))
    reqs |= {(n, RPMLIB | LESS | EQUAL, v) for n, v in rpmlib}
    reqs = sorted(reqs)
    # The ELF scan and the Depends may name one library twice (libgtk-4.so.1()(64bit)).
    if len({r[0] for r in reqs}) != len(reqs):
        raise Fail(f"conflicting requirements: {reqs}")

    files = files_of(root, epoch)
    if not files:
        raise Fail(f"no files under {root}")
    work = os.path.join(outdir, f".rpm-work.{os.getpid()}")
    os.makedirs(work)
    try:
        cpio = os.path.join(work, "payload.cpio")
        raw_size, raw_sha = write_cpio(root, files, cpio)
        if raw_size >= 1 << 32:
            raise Fail("the payload is 4 GB or more")
        payload = cpio + ".zst"
        subprocess.run(["zstd", "-19", "-T0", "-q", "--rm", cpio, "-o", payload], check=True)
        payload_sha = sha256_file(payload)

        dirs = sorted({"/" + os.path.dirname(e["path"]) + "/" for e in files})
        dir_index = {d: i for i, d in enumerate(dirs)}
        n = len(files)
        evr = f"{version}-{RELEASE}"
        tags = [
            (100, STRING_ARRAY, ["C"]),
            (1000, STRING, NAME),
            (1001, STRING, version),
            (1002, STRING, RELEASE),
            (1090, STRING_ARRAY, [o[0] for o in OBSOLETES]),
            (1114, INT32, [o[1] for o in OBSOLETES]),
            (1115, STRING_ARRAY, [o[2] for o in OBSOLETES]),
            (1004, I18NSTRING, summary),
            (1005, I18NSTRING, desc),
            (1006, INT32, [epoch]),
            (1007, STRING, "gitvolt-build"),
            (1009, INT32, [sum(e["size"] for e in files)]),
            (1014, STRING, license_),
            (1015, STRING, "GitVolt build"),
            (1016, I18NSTRING, "Unspecified"),
            (1020, STRING, url),
            (1021, STRING, "linux"),
            (1022, STRING, ARCH),
            (1028, INT32, [e["size"] for e in files]),
            (1030, INT16, [e["mode"] for e in files]),
            (1033, INT16, [0] * n),
            (1034, INT32, [e["mtime"] for e in files]),
            (1035, STRING_ARRAY, [e["digest"] for e in files]),
            (1036, STRING_ARRAY, [e["link"] for e in files]),
            (1037, INT32, [e["flags"] for e in files]),
            (1039, STRING_ARRAY, ["root"] * n),
            (1040, STRING_ARRAY, ["root"] * n),
            (1044, STRING, f"{NAME}-{evr}.src.rpm"),
            (1045, INT32, [0xFFFFFFFF] * n),
            (1047, STRING_ARRAY, [NAME, f"{NAME}(x86-64)"]),
            (1048, INT32, [r[1] for r in reqs]),
            (1049, STRING_ARRAY, [r[0] for r in reqs]),
            (1050, STRING_ARRAY, [r[2] for r in reqs]),
            (1095, INT32, [1] * n),
            (1096, INT32, list(range(1, n + 1))),
            (1097, STRING_ARRAY, [""] * n),
            (1112, INT32, [EQUAL, EQUAL]),
            (1113, STRING_ARRAY, [evr, evr]),
            (1116, INT32, [dir_index["/" + os.path.dirname(e["path"]) + "/"] for e in files]),
            (1117, STRING_ARRAY, [os.path.basename(e["path"]) for e in files]),
            (1118, STRING_ARRAY, dirs),
            (1124, STRING, "cpio"),
            (1125, STRING, "zstd"),
            (1126, STRING, "19"),
            (5011, INT32, [8]),  # file digests: SHA-256
            (5062, STRING, "utf-8"),
            (5092, STRING_ARRAY, [payload_sha]),
            (5093, INT32, [8]),
            (5097, STRING_ARRAY, [raw_sha]),
        ]
        hdr = header(63, tags)
        md5 = hashlib.md5(hdr)
        with open(payload, "rb") as f:
            while chunk := f.read(1 << 20):
                md5.update(chunk)
        total = len(hdr) + os.path.getsize(payload)
        if total >= 1 << 32:
            raise Fail("the package is 4 GB or more")
        sig = header(62, [
            (269, STRING, hashlib.sha1(hdr).hexdigest()),
            (273, STRING, hashlib.sha256(hdr).hexdigest()),
            (1000, INT32, [total]),
            (1004, BIN, md5.digest()),
            (1007, INT32, [raw_size]),
        ])
        lead = struct.pack(">4sBBhh66shh16s", b"\xed\xab\xee\xdb", 3, 0, 0, 1, f"{NAME}-{evr}".encode()[:65], 1, 5, b"")
        name = f"GitVolt-{file_version(debver)}-{RELEASE}.{ARCH}.rpm"
        tmp = os.path.join(work, name)
        with open(tmp, "wb") as out, open(payload, "rb") as f:
            out.write(lead + sig + b"\0" * (-len(sig) % 8) + hdr)
            while chunk := f.read(1 << 20):
                out.write(chunk)
        final = os.path.join(outdir, name)
        os.replace(tmp, final)
        return final
    finally:
        for f in os.listdir(work):
            os.remove(os.path.join(work, f))
        os.rmdir(work)


# --- reading it back ------------------------------------------------------------------------


def read_rpm(path):
    """(signature tags, header tags, header bytes, payload bytes) of a package."""
    with open(path, "rb") as f:
        data = f.read()
    if data[:4] != b"\xed\xab\xee\xdb" or data[4] != 3:
        raise Fail(f"{path} isn't a v3 lead RPM")
    sig, end = read_header(data, 96)
    start = end + (-end % 8)
    hdr, end = read_header(data, start)
    return sig, hdr, data[start:end], data[end:]


def cpio_entries(raw):
    out = []
    p = 0
    while True:
        if raw[p:p + 6] != b"070701":
            raise Fail(f"bad cpio header at {p}")
        f = [int(raw[p + 6 + 8 * i:p + 14 + 8 * i], 16) for i in range(13)]
        namesize, size = f[11], f[6]
        name = raw[p + 110:p + 110 + namesize - 1].decode()
        p += 110 + namesize
        p += -p % 4
        if name == "TRAILER!!!":
            return out
        body = raw[p:p + size]
        p += size
        p += -p % 4
        out.append((name, f[1], f[2], f[3], size, body))


def verify(src, pkg, edited=()):
    sig, hdr, hdr_bytes, payload = read_rpm(pkg)
    problems = []
    if sig[273] != hashlib.sha256(hdr_bytes).hexdigest():
        problems.append("the header's SHA-256 doesn't match")
    if sig[269] != hashlib.sha1(hdr_bytes).hexdigest():
        problems.append("the header's SHA-1 doesn't match")
    if sig[1004] != hashlib.md5(hdr_bytes + payload).digest() or sig[1000] != [len(hdr_bytes) + len(payload)]:
        problems.append("the MD5 or size of header and payload doesn't match")
    if hdr[5092] != [hashlib.sha256(payload).hexdigest()]:
        problems.append("the payload digest doesn't match")
    raw = subprocess.run(["zstd", "-dcq"], input=payload, capture_output=True, check=True).stdout
    if hdr[5097] != [hashlib.sha256(raw).hexdigest()] or sig[1007] != [len(raw)]:
        problems.append("the uncompressed payload's digest or size doesn't match")
    names = [hdr[1118][d] + b for d, b in zip(hdr[1116], hdr[1117])]
    entries = cpio_entries(raw)
    if [n for n, *_ in entries] != ["." + n for n in names]:
        problems.append("the payload's files aren't the header's, in its order")
    if names != sorted(names, key=lambda s: s.encode()):
        problems.append("the header's files aren't sorted")
    got = {}
    for i, (name, mode, uid, gid, size, body) in enumerate(entries):
        rel = name[2:]
        kind = "dir" if stat.S_ISDIR(mode) else "link" if stat.S_ISLNK(mode) else "file" if stat.S_ISREG(mode) else "other"
        link = body.decode() if kind == "link" else ""
        if i < len(names):
            want = (hdr[1030][i], hdr[1028][i], hdr[1036][i], hdr[1039][i], hdr[1040][i])
            if want != (mode, size if kind != "dir" else 0, link, "root", "root") or (uid, gid) != (0, 0):
                problems.append(f"the header and payload differ on {rel}: {want} vs {(mode, size, link, uid, gid)}")
            if kind == "file" and hdr[1035][i] != hashlib.sha256(body).hexdigest():
                problems.append(f"the digest of {rel} doesn't match")
        got[rel] = (kind, 0 if kind == "link" else mode & 0o7777, size if kind == "file" else 0, link)
    deb = archpkg.entries(src, False)
    for name in sorted(set(deb) | set(got)):
        if name not in got:
            if deb[name][0] == "dir" and not OWNED_DIRS.fullmatch(name):
                continue
            problems.append(f"missing from the package: {name}")
        elif name not in deb:
            if RPM_EXTRA.get(name) != got[name]:
                problems.append(f"not in the .deb: {name}")
        elif deb[name][:4] != got[name] and not (name in edited and deb[name][:2] + deb[name][3:4] == got[name][:2] + got[name][3:4]):
            problems.append(f"differs: {name}: .deb {deb[name][:4]} vs package {got[name]}")
    if problems:
        raise Fail("package check failed:\n  " + "\n  ".join(problems[:50]))
    return len(got)


def main(argv):
    cmd, args = argv[1], argv[2:]
    if cmd == "version":
        print(rpm_version(args[0]))
    elif cmd == "filever":
        print(file_version(args[0]))
    elif cmd == "depends":
        print("\n".join(depends(args[0])))
    elif cmd == "elfreqs":
        print("\n".join(elfreqs(args[0])))
    elif cmd == "build":
        print(build(*args))
    elif cmd == "verify":
        print(verify(args[0], args[1], set(args[2:])))
    else:
        raise Fail(f"unknown subcommand {cmd}")


if __name__ == "__main__":
    try:
        main(sys.argv)
    except (Fail, version_py.Fail, archpkg.Fail) as e:
        print(f"package-rpm: {e}", file=sys.stderr)
        sys.exit(2)
