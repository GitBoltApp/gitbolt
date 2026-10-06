#!/usr/bin/env bash
# Self-test for scripts/notices.py (the license notices of `just licenses`) on synthetic inputs:
# the Rust notices grouped by license with each text once and every crate's copyright lines,
# and the CEF files taken from a fake CEF distribution (LICENSE.txt read from its archive).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
helper="$here/notices.py"
fail() { echo "test-licenses: FAIL: $*" >&2; exit 1; }
work=$(mktemp -d); trap 'rm -rf "$work"' EXIT

# --- Rust: cargo-about's JSON -> THIRD-PARTY-NOTICES-rust.txt
mit_body='Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.'
python3 - "$work/about.json" "$mit_body" <<'EOF'
import json, sys
out, mit = sys.argv[1], sys.argv[2]
def crate(name, version, authors=()):
    return {"name": name, "version": version, "authors": list(authors), "license": "MIT"}
def lic(id_, name, text, crates, source="LICENSE"):
    return {"id": id_, "name": name, "text": text, "first_of_kind": True, "source_path": "/r/" + source,
            "used_by": [{"crate": c, "path": None} for c in crates]}
alpha, beta, gamma = crate("alpha", "1.0.0"), crate("beta", "0.2.1"), crate("gamma", "3.0.0", ["Gamma Devs"])
ring = crate("ringish", "0.17.0")
data = {
  "overview": [],
  "crates": [],
  "licenses": [
    lic("MIT", "MIT License", "MIT License\n\nCopyright (c) 2020 Alpha Author\n\n" + mit, [alpha]),
    # The same text, re-wrapped, with another copyright line: still one MIT text in the output.
    lic("MIT", "MIT License", "Copyright 2019-2021 Beta Team\n" + mit.replace("\n", " "), [beta]),
    # No copyright line at all: the crate's authors are listed instead.
    lic("MIT", "MIT License", mit, [gamma]),
    lic("ISC", "ISC License", "Copyright (c) 2015 Ring Folks\n\nPermission to use, copy, modify ISC.", [ring]),
    lic("Apache-2.0", "Apache License 2.0", "Apache License\nVersion 2.0\n\nAPPENDIX\n   Copyright [yyyy] [name of copyright owner]\n", [ring]),
    # A license header found in a source file: only its comment block, not the code.
    lic("BSD-3-Clause", "BSD 3-Clause", "#![allow(clippy::all)]\nuse crate::x;\n// Copied from upstream\n// Copyright 2014 Upstream Devs\n//\n// Redistribution and use in source and binary forms are permitted.\n\npub fn escape_into() {}\n", [ring], "src/copied.rs"),
  ],
}
json.dump(data, open(out, "w"))
EOF
python3 "$helper" rust "$work/about.json" "$work/rust.txt"
out=$(cat "$work/rust.txt")
grep -q 'third-party' <<<"$out" || fail "no header"
grep -Eq '^ *MIT +3$' <<<"$out" || fail "summary lacks MIT 3: $out"
grep -Eq '^ *ISC +1$' <<<"$out" || fail "summary lacks ISC 1"
grep -Eq '^ *Apache-2.0 +1$' <<<"$out" || fail "summary lacks Apache-2.0 1"
[ "$(grep -c 'Permission is hereby granted' <<<"$out")" = 1 ] || fail "the MIT text isn't printed exactly once: $out"
grep -qxF '  Copyright (c) 2020 Alpha Author' <<<"$out" || fail "alpha's copyright line"
grep -qxF '  Copyright 2019-2021 Beta Team' <<<"$out" || fail "beta's copyright line"
grep -qxF 'gamma 3.0.0' <<<"$out" || fail "gamma listed"
grep -qF 'Gamma Devs' <<<"$out" || fail "gamma's authors when it has no copyright line"
grep -qF 'APPENDIX' <<<"$out" || fail "the Apache text is missing"
grep -qxF '  Copyright [yyyy] [name of copyright owner]' <<<"$out" && fail "Apache's placeholder taken as a copyright line"
grep -qxF 'ringish 0.17.0' <<<"$out" || fail "ringish listed"
grep -qxF 'Redistribution and use in source and binary forms are permitted.' <<<"$out" || fail "the source file's license header"
grep -qxF '  Copyright 2014 Upstream Devs' <<<"$out" || fail "the source header's copyright line"
grep -qE 'escape_into|clippy|use crate' <<<"$out" && fail "code from a source file in the notices: $out"
# Most-used license first.
first=$(grep -m1 -E '^(MIT|ISC|Apache-2.0) \(' <<<"$out")
[[ $first == 'MIT (3 crates)' ]] || fail "MIT isn't the first section: $first"

# --- CEF: LICENSE.txt from the distribution archive (download-cef keeps only CREDITS.html)
cef_root="$work/tauri-cef/152.0.6"
mkdir -p "$cef_root/cef_linux_x86_64" "$work/src/cef_binary_x_linux64_minimal"
printf '<html>credits</html>\n' > "$cef_root/cef_linux_x86_64/CREDITS.html"
printf 'Copyright (c) 2008-2026 Marshall A. Greenblatt. Portions Copyright (c)\n2006-2009 Google Inc. All rights reserved.\n' > "$work/src/cef_binary_x_linux64_minimal/LICENSE.txt"
printf 'readme\n' > "$work/src/cef_binary_x_linux64_minimal/README.txt"
tar -cjf "$cef_root/cef_binary_x_linux64_minimal.tar.bz2" -C "$work/src" cef_binary_x_linux64_minimal
printf '{"type": "minimal", "name": "cef_binary_x_linux64_minimal.tar.bz2", "sha1": "abc"}\n' > "$cef_root/cef_linux_x86_64/archive.json"
python3 "$helper" cef "$cef_root/cef_linux_x86_64" "$work/out"
gzip -dc "$work/out/CHROMIUM-CREDITS.html.gz" | cmp -s - "$cef_root/cef_linux_x86_64/CREDITS.html" || fail "CHROMIUM-CREDITS.html.gz"
grep -q 'Marshall A. Greenblatt' "$work/out/CEF-LICENSE.txt" || fail "CEF-LICENSE.txt: $(cat "$work/out/CEF-LICENSE.txt")"
# No archive and no LICENSE.txt: an error, not a missing notice.
rm "$cef_root/cef_binary_x_linux64_minimal.tar.bz2"
rm -rf "$work/out2"
python3 "$helper" cef "$cef_root/cef_linux_x86_64" "$work/out2" 2>/dev/null && fail "no CEF LICENSE.txt was accepted"
# A LICENSE.txt in the CEF directory itself is used as is.
printf 'Copyright (c) CEF authors\n' > "$cef_root/cef_linux_x86_64/LICENSE.txt"
python3 "$helper" cef "$cef_root/cef_linux_x86_64" "$work/out3"
grep -q 'CEF authors' "$work/out3/CEF-LICENSE.txt" || fail "LICENSE.txt next to CREDITS.html"

# --- The CEF version from Cargo.lock (the directory download-cef unpacks into)
printf '[[package]]\nname = "cef-dll-sys"\nversion = "152.3.0+152.0.6"\n\n[[package]]\nname = "cef"\nversion = "152.3.0+152.0.6"\n' > "$work/Cargo.lock"
[ "$(python3 "$helper" cef-version "$work/Cargo.lock")" = 152.0.6 ] || fail "cef-version"
echo "test-licenses: OK"
