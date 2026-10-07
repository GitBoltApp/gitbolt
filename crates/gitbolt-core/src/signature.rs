//! Commit signature status through the user's own gpg/ssh configuration (spec §5.1, §9.1).

use crate::error::GbError;
use crate::git::{GitCli, GitInvocation};
use crate::payload::{SignatureKind, SignaturePayload};
use gix::ObjectId;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};

/// git's signature placeholders, NUL-separated: status `%G?`, signer `%GS`, key `%GK`, fingerprint
/// `%GF` and trust `%GT`.
pub const SIGNATURE_FORMAT: &str = "--format=%G?%x00%GS%x00%GK%x00%GF%x00%GT";

pub fn unsigned() -> SignaturePayload {
    SignaturePayload { kind: SignatureKind::Unsigned, signer: String::new(), key: String::new(), fingerprint: String::new(), trust: String::new(), detail: None }
}

/// Parses `SIGNATURE_FORMAT`'s output. `signed` says whether the raw commit has a
/// `gpgsig` header: git answers `N` when it can't verify at all (for example SSH signing without
/// `gpg.ssh.allowedSignersFile`), and that must not read as "not signed".
pub fn parse_signature_status(stdout: &[u8], stderr: &str, signed: bool) -> SignaturePayload {
    let text = String::from_utf8_lossy(stdout);
    let mut f = text.trim_end_matches('\n').split('\0');
    let mut next = || f.next().unwrap_or("").to_string();
    let (code, signer, key, fingerprint, trust) = (next(), next(), next(), next(), next());
    let trust = if trust == "undefined" { String::new() } else { trust };
    let git_says = stderr.lines().map(str::trim).find(|l| !l.is_empty()).map(|l| l.trim_start_matches("error: ").to_string());
    let (kind, detail) = match code.as_str() {
        "G" => (SignatureKind::Verified, None),
        "U" => (SignatureKind::Unverified, Some("Good signature from a key that isn't trusted".to_string())),
        "B" => (SignatureKind::Bad, Some("Bad signature".to_string())),
        "R" => (SignatureKind::Bad, Some("Good signature made by a revoked key".to_string())),
        "X" => (SignatureKind::Expired, Some("Good signature that has expired".to_string())),
        "Y" => (SignatureKind::Expired, Some("Good signature made by an expired key".to_string())),
        "E" => (SignatureKind::UnknownKey, git_says.or(Some("The signature can't be checked (missing key?)".to_string()))),
        _ if signed => (SignatureKind::UnknownKey, git_says.or(Some("Signed, but git couldn't verify the signature".to_string()))),
        _ => (SignatureKind::Unsigned, None),
    };
    SignaturePayload { kind, signer, key, fingerprint, trust, detail }
}

/// The commit's signature status. An OpenPGP signature is checked by one `gpg --verify` of the
/// signature and payload read in process (`verify_openpgp`); anything else (SSH, X.509), or a gpg
/// that can't be run, goes through `git log --format=%G?…` as before. Both give the same verdict.
/// `tmp`: a private directory for the signature file gpg reads.
pub async fn signature_status(cli: &GitCli, cwd: &Path, tmp: &Path, id: ObjectId, signed: bool) -> Result<SignaturePayload, GbError> {
    signature_status_within(cli, cwd, tmp, id, signed, GPG_TIMEOUT).await
}

/// `signature_status`, with gpg given `timeout` (tests).
pub(crate) async fn signature_status_within(cli: &GitCli, cwd: &Path, tmp: &Path, id: ObjectId, signed: bool, timeout: Duration) -> Result<SignaturePayload, GbError> {
    if !signed {
        return Ok(unsigned());
    }
    if let Some(s) = verify_openpgp(cli, cwd, tmp, id, timeout).await {
        return Ok(s);
    }
    git_signature_status(cli, cwd, id).await
}

/// The status as `git log %G?…` reports it (git runs gpg, ssh-keygen or gpgsm itself).
pub async fn git_signature_status(cli: &GitCli, cwd: &Path, id: ObjectId) -> Result<SignaturePayload, GbError> {
    let id = id.to_string();
    let out = cli.run(GitInvocation::new(cwd, ["log", "-1", "--no-show-signature", SIGNATURE_FORMAT, id.as_str(), "--"])).await?;
    Ok(parse_signature_status(&out.stdout, &out.stderr, true))
}

/// The header that carries this object format's signature (git's `gpg_sig_headers`).
fn signature_header(hash: gix::hash::Kind) -> &'static [u8] {
    // gix is built for SHA-1 only here; a SHA-256 repository would sign in `gpgsig-sha256`.
    #[allow(unreachable_patterns)]
    match hash {
        gix::hash::Kind::Sha1 => b"gpgsig",
        _ => b"gpgsig-sha256",
    }
}

/// git's `parse_buffer_signed_by_header`: the signature in `header` (continuation lines
/// unindented) and the payload it signs, which is the commit without any `gpgsig*` header
/// (another object format's signature is left out too). `None` when there's no such header.
pub fn split_signed(raw: &[u8], header: &[u8]) -> Option<(Vec<u8>, Vec<u8>)> {
    let (mut signature, mut payload) = (Vec::new(), Vec::new());
    let (mut in_signature, mut saw_signature, mut other_signature) = (false, false, false);
    let mut at = 0;
    while at < raw.len() {
        let mut next = raw[at..].iter().position(|b| *b == b'\n').map_or(raw.len(), |i| at + i + 1);
        let line = &raw[at..next];
        let sig = if in_signature && line.first() == Some(&b' ') {
            Some(&line[1..])
        } else if line.starts_with(header) && line.get(header.len()) == Some(&b' ') {
            other_signature = false;
            Some(&line[header.len() + 1..])
        } else {
            if line.starts_with(b"gpgsig") {
                other_signature = true;
            } else if other_signature && line.first() != Some(&b' ') {
                other_signature = false;
            }
            None
        };
        match sig {
            Some(s) => {
                signature.extend_from_slice(s);
                saw_signature = true;
                in_signature = true;
            }
            None => {
                if line.first() == Some(&b'\n') {
                    // The blank line: the message follows, all of it payload.
                    next = raw.len();
                }
                if !other_signature {
                    payload.extend_from_slice(&raw[at..next]);
                }
                in_signature = false;
            }
        }
        at = next;
    }
    saw_signature.then_some((signature, payload))
}

/// An OpenPGP armor, the way git tells formats apart when verifying (`get_format_by_sig`).
pub fn is_openpgp(signature: &[u8]) -> bool {
    signature.starts_with(b"-----BEGIN PGP SIGNATURE-----") || signature.starts_with(b"-----BEGIN PGP MESSAGE-----")
}

/// The last `gpg.program` or `gpg.openpgp.program` in `config`'s order (git's
/// `git_gpg_config`: both set the OpenPGP program, whichever is read last wins), from fully
/// trusted sections only.
fn last_gpg_program(config: &gix::config::File) -> Option<gix::bstr::BString> {
    let mut found = None;
    for section in config.sections() {
        let sub = section.header().subsection_name().map(|s| s.to_ascii_lowercase());
        let ours = section.header().name().eq_ignore_ascii_case(b"gpg") && matches!(sub.as_deref(), None | Some(b"openpgp"));
        if ours
            && section.meta().trust == gix::sec::Trust::Full
            && let Some(v) = section.values("program").pop()
        {
            found = Some(v);
        }
    }
    found
}

/// git's OpenPGP program (a path: `~/` is the home), else `gpg`. The repository's resolved
/// config (system, global, local, includes followed), then the profile's include
/// (`GitCli::include_path`, passed to git as `-c`, so read last) with its own includes followed.
fn gpg_program(repo: &gix::Repository, include: Option<&Path>) -> std::path::PathBuf {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let from_include = include.and_then(|p| {
        let mut file = gix::config::File::from_path_no_includes(p.to_path_buf(), gix::config::Source::Api).ok()?;
        let options = gix::config::file::init::Options { includes: gix::config::file::includes::Options::follow_without_conditional(home.as_deref()), lossy: true, ignore_io_errors: true };
        let _ = file.resolve_includes(options);
        last_gpg_program(&file)
    });
    let value = from_include.or_else(|| last_gpg_program(repo.config_snapshot().plumbing())).filter(|v| !v.is_empty());
    let Some(value) = value else { return "gpg".into() };
    let path = gix::path::from_bstring(value);
    match (path.strip_prefix("~"), std::env::var_os("HOME")) {
        (Ok(rest), Some(home)) => Path::new(&home).join(rest),
        _ => path,
    }
}

/// git's `parse_gpg_output` and the `SIGNATURE_FORMAT` fields it would print from gpg's
/// status lines: one GOODSIG/BADSIG/ERRSIG/EXPSIG/EXPKEYSIG/REVKEYSIG (a second one is an error,
/// 'E'), VALIDSIG's fingerprint, TRUST_*'s level. A good signature from a key whose validity is
/// undefined or never is 'U' (pretty.c); marginal, full and ultimate are 'G', as git shows them.
pub fn gpg_status_as_git_format(status: &str) -> Vec<u8> {
    const RESULTS: [(char, &str); 6] = [('G', "GOODSIG "), ('B', "BADSIG "), ('E', "ERRSIG "), ('X', "EXPSIG "), ('Y', "EXPKEYSIG "), ('R', "REVKEYSIG ")];
    const LEVELS: [&str; 5] = ["UNDEFINED", "NEVER", "MARGINAL", "FULLY", "ULTIMATE"];
    let (mut result, mut signer, mut key, mut fingerprint, mut trust) = ('N', "", "", "", 0usize);
    let mut exclusive = 0;
    let error = || b"E\0\0\0\0undefined".to_vec();
    for line in status.lines() {
        let Some(line) = line.strip_prefix("[GNUPG:] ") else { continue };
        if let Some((code, rest)) = RESULTS.iter().find_map(|(c, p)| line.strip_prefix(p).map(|r| (*c, r))) {
            exclusive += 1;
            if exclusive > 1 {
                return error();
            }
            result = code;
            let (k, uid) = rest.split_once(' ').unwrap_or((rest, ""));
            key = k;
            if code != 'E' && !uid.is_empty() {
                signer = uid;
            }
        } else if let Some(rest) = line.strip_prefix("VALIDSIG ") {
            fingerprint = rest.split(' ').next().unwrap_or("");
        } else if let Some(rest) = line.strip_prefix("TRUST_") {
            match LEVELS.iter().position(|l| *l == rest.split(' ').next().unwrap_or("")) {
                Some(level) => trust = level,
                None => return error(),
            }
        }
    }
    let code = if result == 'G' && trust < 2 { 'U' } else { result };
    format!("{code}\0{signer}\0{key}\0{fingerprint}\0{}", LEVELS[trust].to_ascii_lowercase()).into_bytes()
}

/// One `gpg --verify` of an OpenPGP-signed commit, with the arguments git gives it. `None` when the
/// commit isn't OpenPGP-signed, or gpg couldn't be run or answered oddly: git decides then.
/// How long gpg may take to check one signature before the check says it didn't answer.
pub const GPG_TIMEOUT: Duration = Duration::from_secs(10);

/// What gpg is handed: the program, the signature (in a 0600 temp file in the app's private
/// temp dir, removed on drop) and the payload.
struct GpgCheck {
    program: PathBuf,
    signature: tempfile::NamedTempFile,
    payload: Vec<u8>,
}

/// Blocking: opens the repository afresh (`gpg.program` may have changed since it was opened),
/// splits the commit and writes the signature file. `Ok(None)`: not an OpenPGP signature.
fn prepare_gpg_check(cwd: &Path, tmp: &Path, include: Option<&Path>, id: ObjectId) -> Result<Option<GpgCheck>, GbError> {
    let repo = gix::open(cwd).map_err(crate::error::gix_err)?;
    let raw = crate::details::read_commit(&repo, id)?;
    let Some((signature, payload)) = split_signed(&raw, signature_header(repo.object_hash())) else { return Ok(None) };
    if !is_openpgp(&signature) {
        return Ok(None);
    }
    let program = gpg_program(&repo, include);
    let mut file = tempfile::Builder::new().prefix("signature-").tempfile_in(tmp)?;
    std::io::Write::write_all(&mut file, &signature)?;
    Ok(Some(GpgCheck { program, signature: file, payload }))
}

/// "Couldn't check": gpg hung, crashed or printed no status. Not settled, so it's asked again
/// after `UNSETTLED_TTL`.
fn gpg_did_not_answer(why: &str) -> SignaturePayload {
    SignaturePayload { kind: SignatureKind::UnknownKey, detail: Some(format!("gpg didn't answer ({why})")), ..unsigned() }
}

/// One `gpg --verify` of an OpenPGP-signed commit, with the arguments git gives it. `None` when the
/// commit isn't OpenPGP-signed or gpg can't be started at all: git decides then. A gpg that hangs
/// past `timeout`, fails or prints no status gives `gpg_did_not_answer`, never a second try
/// through git (which would run the same gpg again).
async fn verify_openpgp(cli: &GitCli, cwd: &Path, tmp: &Path, id: ObjectId, timeout: Duration) -> Option<SignaturePayload> {
    let (dir, tmp_dir, include) = (cwd.to_path_buf(), tmp.to_path_buf(), cli.include_path());
    let check = crate::api::blocking(move || prepare_gpg_check(&dir, &tmp_dir, include.as_deref(), id)).await.ok()??;
    let args: [std::ffi::OsString; 5] = ["--keyid-format=long".into(), "--status-fd=1".into(), "--verify".into(), check.signature.path().into(), "-".into()];
    // gpg exits 1 for a bad signature and 2 when it can't check one (no public key).
    let inv = GitInvocation::new(cwd, args).stdin(check.payload).ok_exit(1).ok_exit(2).timeout(Some(timeout));
    let out = match cli.run_program(&check.program, inv).await {
        Ok(out) => out,
        Err(e) if crate::git::is_spawn_failure(&e) => return None,
        Err(e) => {
            let why = if e.message.contains("timed out") { format!("no answer in {}s", timeout.as_secs_f32()) } else { e.message };
            return Some(gpg_did_not_answer(&why));
        }
    };
    let status = String::from_utf8_lossy(&out.stdout);
    if !status.contains("[GNUPG:] ") {
        return Some(gpg_did_not_answer("no status"));
    }
    Some(parse_signature_status(&gpg_status_as_git_format(&status), "", true))
}

/// How long a verdict that depends on what's trusted right now (an unknown key, an untrusted
/// one) is reused: a key imported or trusted outside GitBolt shows within this.
pub const UNSETTLED_TTL: Duration = Duration::from_secs(60);

/// The modification times of the git config files a verdict can depend on (`gpg.program`,
/// `gpg.ssh.allowedSignersFile`…): the repository's and its worktree's, the system and global
/// ones, the profile include, and `loaded` (every file the repository's config was read from,
/// includes too: `config_files`). Only metadata is read. Blocking.
pub fn config_stamp(git_dir: &Path, common_dir: &Path, include: Option<&Path>, loaded: Vec<PathBuf>) -> Vec<Option<SystemTime>> {
    let mut files = vec![common_dir.join("config"), git_dir.join("config.worktree")];
    let truthy = |v: std::ffi::OsString| !matches!(v.to_string_lossy().to_ascii_lowercase().as_str(), "" | "0" | "false" | "no" | "off");
    if !std::env::var_os("GIT_CONFIG_NOSYSTEM").is_some_and(truthy) {
        files.push(std::env::var_os("GIT_CONFIG_SYSTEM").map_or_else(|| PathBuf::from("/etc/gitconfig"), PathBuf::from));
    }
    match std::env::var_os("GIT_CONFIG_GLOBAL") {
        Some(global) => files.push(global.into()),
        None => {
            let home = std::env::var_os("HOME").map(PathBuf::from);
            let xdg = std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from).or_else(|| home.as_ref().map(|h| h.join(".config")));
            files.extend(xdg.map(|x| x.join("git").join("config")));
            files.extend(home.map(|h| h.join(".gitconfig")));
        }
    }
    files.extend(include.map(Path::to_path_buf));
    for f in loaded {
        if !files.contains(&f) {
            files.push(f);
        }
    }
    files.iter().map(|f| std::fs::metadata(f).and_then(|m| m.modified()).ok()).collect()
}

/// Every file `repo`'s config was read from (system, global, local, included ones), in order.
pub fn config_files(repo: &gix::Repository) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    for section in repo.config_snapshot().plumbing().sections() {
        if let Some(p) = &section.meta().path
            && !out.contains(p)
        {
            out.push(p.clone());
        }
    }
    out
}

struct CachedVerdict {
    value: SignaturePayload,
    /// `None`: kept for the session (a settled verdict). Otherwise until this instant, and only
    /// while the config files are as they were (`stamp`).
    until: Option<Instant>,
    stamp: Vec<Option<SystemTime>>,
    used: u64,
}

/// Signature verdicts keyed by (the repository's git directory, commit id), at most `cap`; the
/// least recently used goes first. The signature bytes never change, but git's verdict depends
/// on the keyring, the trust database and the config (`gpg.ssh.allowedSignersFile`,
/// `gpg.program`), which differ per repository. A settled verdict (verified, bad, expired,
/// unsigned) is kept for the session; an unknown key or an untrusted one for `UNSETTLED_TTL`, and
/// never past a change to a config file (`config_stamp`), so setting up `allowedSignersFile`
/// shows on the very next look.
pub struct SignatureCache {
    cap: usize,
    entries: HashMap<(PathBuf, ObjectId), CachedVerdict>,
    clock: u64,
}

impl SignatureCache {
    pub fn new(cap: usize) -> Self {
        Self { cap: cap.max(1), entries: HashMap::new(), clock: 0 }
    }

    pub fn get(&mut self, key: &(PathBuf, ObjectId), stamp: &[Option<SystemTime>]) -> Option<SignaturePayload> {
        self.clock += 1;
        let e = self.entries.get_mut(key)?;
        if e.until.is_some_and(|t| Instant::now() >= t || e.stamp != stamp) {
            self.entries.remove(key);
            return None;
        }
        e.used = self.clock;
        Some(e.value.clone())
    }

    /// Keeps `value`, except that an unsettled verdict never replaces a settled one (a check that
    /// raced a slower, definitive one, or gpg not answering once).
    pub fn put(&mut self, key: (PathBuf, ObjectId), value: SignaturePayload, stamp: Vec<Option<SystemTime>>) {
        self.clock += 1;
        if !settled(value.kind) && self.entries.get(&key).is_some_and(|e| e.until.is_none()) {
            return;
        }
        let until = (!settled(value.kind)).then(|| Instant::now() + UNSETTLED_TTL);
        self.entries.insert(key, CachedVerdict { value, until, stamp, used: self.clock });
        while self.entries.len() > self.cap {
            let Some(oldest) = self.entries.iter().min_by_key(|(_, e)| e.used).map(|(k, _)| k.clone()) else { break };
            self.entries.remove(&oldest);
        }
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

/// Whether a verdict holds for the session. An unknown key and an unverified signature both
/// change when the user trusts the key (or adds it to the allowed signers).
pub fn settled(kind: SignatureKind) -> bool {
    !matches!(kind, SignatureKind::UnknownKey | SignatureKind::Unverified)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::TestRepo;
    #[cfg(unix)] // used by Unix-only tests
    use crate::{
        log::CommandLog,
        testing::{isolated_git_env, GpgHome},
    };
    #[cfg(unix)]
    use std::sync::Arc;

    #[cfg(unix)] // helper of Unix-only tests
    fn cli() -> GitCli {
        GitCli::new(Arc::new(CommandLog::new(100))).with_env(isolated_git_env())
    }

    #[test]
    fn maps_every_status_letter() {
        let v = parse_signature_status(b"G\0a@x\0SHA256:k\0SHA256:k\0fully\n", "", true);
        assert_eq!((v.kind, v.signer.as_str(), v.trust.as_str(), v.detail), (SignatureKind::Verified, "a@x", "fully", None));
        let u = parse_signature_status(b"U\0\0K\0K\0undefined\n", "", true);
        assert_eq!((u.kind, u.trust.as_str()), (SignatureKind::Unverified, ""));
        assert_eq!(parse_signature_status(b"B\0\0\0\0\n", "", true).kind, SignatureKind::Bad);
        assert_eq!(parse_signature_status(b"R\0\0\0\0\n", "", true).kind, SignatureKind::Bad);
        assert_eq!(parse_signature_status(b"X\0\0\0\0\n", "", true).kind, SignatureKind::Expired);
        assert_eq!(parse_signature_status(b"Y\0\0\0\0\n", "", true).kind, SignatureKind::Expired);
        assert_eq!(parse_signature_status(b"E\0\0\0\0\n", "", true).kind, SignatureKind::UnknownKey);
        let n = parse_signature_status(b"N\0\0\0\0undefined\n", "error: gpg.ssh.allowedSignersFile needs to be configured and exist for ssh signature verification\n", true);
        assert_eq!(n.kind, SignatureKind::UnknownKey);
        assert!(n.detail.unwrap().starts_with("gpg.ssh.allowedSignersFile"));
        assert_eq!(parse_signature_status(b"N\0\0\0\0undefined\n", "", false).kind, SignatureKind::Unsigned);
    }

    /// Spec §17.1: signature status with a test GPG key. One commit signed by a throwaway key is
    /// read three ways: by the keyring that made it (the key is ultimately trusted: verified), by
    /// one that holds only its public half (untrusted: unverified) and by an empty one (unknown).
    #[cfg(unix)] // signing: the test's gpg/ssh-keygen wrappers are sh scripts (Windows signing is phase 2)
    #[tokio::test]
    async fn gpg_signatures_are_verified_by_git() {
        if let Some(reason) = crate::testing::gpg_signing_unavailable() {
            eprintln!("{reason}; skipping");
            return;
        }
        let (maker, reader, stranger) = (GpgHome::new(), GpgHome::new(), GpgHome::new());
        let made = maker.gpg(&["--quick-generate-key", "Ada Lovelace <ada@example.com>", "ed25519", "sign", "never"]);
        if !made.status.success() {
            eprintln!("gpg can't make a key here ({}); skipping", String::from_utf8_lossy(&made.stderr).trim());
            return;
        }
        let public = maker.gpg(&["--export"]).stdout;
        let mut import = std::process::Command::new("gpg")
            .arg("--homedir").arg(reader.home()).args(["--batch", "--import"])
            .stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        std::io::Write::write_all(import.stdin.as_mut().unwrap(), &public).unwrap();
        assert!(import.wait().unwrap().success());

        let r = TestRepo::new();
        r.commit("base");
        r.git(&["config", "gpg.program", maker.program.to_str().unwrap()]);
        r.git(&["config", "user.signingkey", "ada@example.com"]);
        r.write("signed.txt", "x\n");
        r.git(&["add", "-A"]);
        r.git(&["commit", "-q", "-S", "-m", "signed"]);
        let id = ObjectId::from_hex(r.git(&["rev-parse", "HEAD"]).as_bytes()).unwrap();
        let cli = cli();
        let read_with = |home: &GpgHome| {
            r.git(&["config", "gpg.program", home.program.to_str().unwrap()]);
            signature_status(&cli, r.path(), r.root(), id, true)
        };

        let ok = read_with(&maker).await.unwrap();
        assert_eq!(ok.kind, SignatureKind::Verified, "{ok:?}");
        assert!(ok.signer.contains("ada@example.com"), "{ok:?}");
        assert!(!ok.fingerprint.is_empty(), "{ok:?}");
        let untrusted = read_with(&reader).await.unwrap();
        assert_eq!(untrusted.kind, SignatureKind::Unverified, "{untrusted:?}");
        let unknown = read_with(&stranger).await.unwrap();
        assert_eq!(unknown.kind, SignatureKind::UnknownKey, "{unknown:?}");
    }

    /// F11: the throwaway repo's own config carries `gpg.format`/`user.signingkey`, never
    /// `-c user.signingkey=...` on the command line, and the user's global git config is never
    /// touched (`isolated_git_env` already points `GIT_CONFIG_GLOBAL` at `/dev/null`).
    #[cfg(unix)] // signing: the test's gpg/ssh-keygen wrappers are sh scripts (Windows signing is phase 2)
    #[tokio::test]
    async fn ssh_signatures_are_verified_by_git() {
        if let Some(reason) = crate::testing::ssh_signing_unavailable() {
            eprintln!("{reason}; skipping");
            return;
        }
        let r = TestRepo::new();
        r.commit("base");
        r.git(&["config", "gpg.format", "ssh"]);
        let (key, other) = (r.root().join("key"), r.root().join("other"));
        for (k, comment) in [(&key, "trusted"), (&other, "stranger")] {
            let out = std::process::Command::new("ssh-keygen").args(["-q", "-t", "ed25519", "-N", "", "-C", comment, "-f"]).arg(k).output().unwrap();
            assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        }
        let sign = |k: &std::path::Path, msg: &str| {
            r.git(&["config", "user.signingkey", k.to_str().unwrap()]);
            r.write(&format!("{msg}.txt"), msg);
            r.git(&["add", "-A"]);
            r.git(&["commit", "-q", "-S", "-m", msg]);
            ObjectId::from_hex(r.git(&["rev-parse", "HEAD"]).as_bytes()).unwrap()
        };
        let trusted = sign(&key, "trusted");
        let stranger = sign(&other, "stranger");
        let cli = cli();

        let unconfigured = signature_status(&cli, r.path(), r.root(), trusted, true).await.unwrap();
        assert_eq!(unconfigured.kind, SignatureKind::UnknownKey, "signed, but git can't verify without allowed signers");

        let allowed = r.root().join("allowed_signers");
        std::fs::write(&allowed, format!("ada@example.com {}", std::fs::read_to_string(key.with_extension("pub")).unwrap())).unwrap();
        r.git(&["config", "gpg.ssh.allowedSignersFile", allowed.to_str().unwrap()]);
        let ok = signature_status(&cli, r.path(), r.root(), trusted, true).await.unwrap();
        assert_eq!((ok.kind, ok.signer.as_str()), (SignatureKind::Verified, "ada@example.com"));
        assert!(ok.key.starts_with("SHA256:"));
        assert_eq!(signature_status(&cli, r.path(), r.root(), stranger, true).await.unwrap().kind, SignatureKind::Unverified);

        let before = cli.log().entries().len();
        let base = ObjectId::from_hex(r.git(&["rev-parse", "HEAD~2"]).as_bytes()).unwrap();
        assert_eq!(signature_status(&cli, r.path(), r.root(), base, false).await.unwrap().kind, SignatureKind::Unsigned);
        assert_eq!(cli.log().entries().len(), before, "unsigned commits never run git");
    }

    #[test]
    fn splits_a_signed_commit_as_git_does() {
        let raw = b"tree t\nparent p\nauthor A <a@x> 1 +0000\ncommitter C <c@x> 1 +0000\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n abc\n -----END PGP SIGNATURE-----\ngpgsig-sha256 -----BEGIN PGP SIGNATURE-----\n other\n -----END PGP SIGNATURE-----\nmergetag object o\n type commit\n\nMessage\n\n gpgsig not a header\n";
        let (sig, payload) = split_signed(raw, b"gpgsig").unwrap();
        assert_eq!(sig, b"-----BEGIN PGP SIGNATURE-----\n\nabc\n-----END PGP SIGNATURE-----\n");
        // Every gpgsig* header (and its continuation lines) is left out; other headers stay.
        assert_eq!(payload, b"tree t\nparent p\nauthor A <a@x> 1 +0000\ncommitter C <c@x> 1 +0000\nmergetag object o\n type commit\n\nMessage\n\n gpgsig not a header\n");
        assert!(is_openpgp(&sig));
        let (sha256, _) = split_signed(raw, b"gpgsig-sha256").unwrap();
        assert_eq!(sha256, b"-----BEGIN PGP SIGNATURE-----\nother\n-----END PGP SIGNATURE-----\n");
        assert!(split_signed(b"tree t\n\ngpgsig x\n", b"gpgsig").is_none(), "only headers count");
        assert!(!is_openpgp(b"-----BEGIN SSH SIGNATURE-----\n"));
    }

    #[test]
    fn reads_gpg_status_lines_as_git_does() {
        let fmt = |s: &str| String::from_utf8(gpg_status_as_git_format(s)).unwrap().replace('\0', "|");
        let good = "[GNUPG:] NEWSIG\n[GNUPG:] GOODSIG 0123456789ABCDEF Ada <ada@x>\n[GNUPG:] VALIDSIG FPR1 2024-01-01 1 0 4 0 22 8 00 PRIMARY\n";
        assert_eq!(fmt(&format!("{good}[GNUPG:] TRUST_ULTIMATE 0 pgp\n")), "G|Ada <ada@x>|0123456789ABCDEF|FPR1|ultimate");
        assert_eq!(fmt(&format!("{good}[GNUPG:] TRUST_FULLY\n")), "G|Ada <ada@x>|0123456789ABCDEF|FPR1|fully");
        assert_eq!(fmt(&format!("{good}[GNUPG:] TRUST_MARGINAL 0 pgp\n")), "G|Ada <ada@x>|0123456789ABCDEF|FPR1|marginal");
        assert_eq!(fmt(&format!("{good}[GNUPG:] TRUST_UNDEFINED 0 pgp\n")), "U|Ada <ada@x>|0123456789ABCDEF|FPR1|undefined");
        assert_eq!(fmt(&format!("{good}[GNUPG:] TRUST_NEVER 0 pgp\n")), "U|Ada <ada@x>|0123456789ABCDEF|FPR1|never");
        assert_eq!(fmt(good), "U|Ada <ada@x>|0123456789ABCDEF|FPR1|undefined", "no trust line: undefined");
        assert_eq!(fmt("[GNUPG:] ERRSIG B5690EEEBB952194 1 8 00 1791034685 9 -\n[GNUPG:] NO_PUBKEY B5690EEEBB952194\n"), "E||B5690EEEBB952194||undefined");
        assert_eq!(fmt("[GNUPG:] BADSIG 0123456789ABCDEF Ada <ada@x>\n"), "B|Ada <ada@x>|0123456789ABCDEF||undefined");
        assert_eq!(fmt("[GNUPG:] EXPKEYSIG 0123456789ABCDEF Ada <ada@x>\n"), "Y|Ada <ada@x>|0123456789ABCDEF||undefined");
        assert_eq!(fmt("[GNUPG:] REVKEYSIG 0123456789ABCDEF Ada <ada@x>\n"), "R|Ada <ada@x>|0123456789ABCDEF||undefined");
        assert_eq!(fmt("[GNUPG:] EXPSIG 0123456789ABCDEF Ada <ada@x>\n"), "X|Ada <ada@x>|0123456789ABCDEF||undefined");
        assert_eq!(fmt(&format!("{good}[GNUPG:] BADSIG 1 B\n")), "E||||undefined", "two signatures: rejected");
        assert_eq!(fmt(&format!("{good}[GNUPG:] TRUST_WHATEVER\n")), "E||||undefined");
        assert_eq!(fmt("gpg: no status at all\n"), "N||||undefined");
    }

    /// A signing key for `uid` made in `home` at a fixed past time, expiring after `expire`; and a
    /// `gpg.program` wrapper that signs (and verifies) as of a little later.
    #[cfg(unix)] // helper of Unix-only tests
    fn past_key(home: &GpgHome, uid: &str, expire: &str) -> PathBuf {
        let made = home.gpg(&["--faked-system-time", "20200101T000000!", "--quick-generate-key", uid, "ed25519", "sign", expire]);
        assert!(made.status.success(), "{}", String::from_utf8_lossy(&made.stderr));
        let wrapper = home.home().parent().unwrap().join("gpg-past.sh");
        std::fs::write(&wrapper, format!("#!/bin/sh\nexec gpg --homedir {} --faked-system-time 20200601T000000! \"$@\"\n", crate::platform::fs::to_git_path(home.home()))).unwrap();
        crate::platform::fs::set_mode(&wrapper, 0o755).unwrap();
        wrapper
    }

    #[cfg(unix)] // helper of Unix-only tests
    fn commit_object(r: &TestRepo, raw: &[u8]) -> ObjectId {
        let mut child = std::process::Command::new("git")
            .args(["hash-object", "-t", "commit", "-w", "--stdin"])
            .current_dir(r.path())
            .envs(isolated_git_env())
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        std::io::Write::write_all(child.stdin.as_mut().unwrap(), raw).unwrap();
        let out = child.wait_with_output().unwrap();
        ObjectId::from_hex(String::from_utf8(out.stdout).unwrap().trim().as_bytes()).unwrap()
    }

    /// The direct `gpg --verify` gives git's verdict, signer, key, fingerprint and trust: a good
    /// signature (ultimate trust), an untrusted key, an unknown key, a tampered payload, an expired
    /// key. And it is one gpg run, not git.
    #[cfg(unix)] // signing: the test's gpg/ssh-keygen wrappers are sh scripts (Windows signing is phase 2)
    #[tokio::test]
    async fn direct_gpg_verification_matches_git() {
        if let Some(reason) = crate::testing::gpg_signing_unavailable() {
            eprintln!("{reason}; skipping");
            return;
        }
        let (maker, reader, stranger, old) = (GpgHome::new(), GpgHome::new(), GpgHome::new(), GpgHome::new());
        let made = maker.gpg(&["--quick-generate-key", "Ada Lovelace <ada@example.com>", "ed25519", "sign", "never"]);
        if !made.status.success() {
            eprintln!("gpg can't make a key here ({}); skipping", String::from_utf8_lossy(&made.stderr).trim());
            return;
        }
        let public = reader.home().join("pub.gpg");
        std::fs::write(&public, maker.gpg(&["--export"]).stdout).unwrap();
        assert!(reader.gpg(&["--import", public.to_str().unwrap()]).status.success());

        let r = TestRepo::new();
        r.commit("base");
        r.git(&["config", "gpg.program", maker.program.to_str().unwrap()]);
        r.git(&["config", "user.signingkey", "ada@example.com"]);
        r.write("signed.txt", "x\n");
        r.git(&["add", "-A"]);
        r.git(&["commit", "-q", "-S", "-m", "signed"]);
        let good = ObjectId::from_hex(r.git(&["rev-parse", "HEAD"]).as_bytes()).unwrap();
        let raw = r.git(&["cat-file", "commit", "HEAD"]) + "\n";
        let tampered = commit_object(&r, raw.replace("\n\nsigned", "\n\nsigneD").as_bytes());
        // An expired key: made and used in 2020, expired a year later.
        let past = past_key(&old, "Old Key <old@example.com>", "1y");
        r.git(&["config", "gpg.program", past.to_str().unwrap()]);
        r.git(&["config", "user.signingkey", "old@example.com"]);
        r.write("old.txt", "x\n");
        r.git(&["add", "-A"]);
        r.git(&["commit", "-q", "-S", "-m", "old"]);
        let expired = ObjectId::from_hex(r.git(&["rev-parse", "HEAD"]).as_bytes()).unwrap();

        // Marginal validity: the reader trusts the key directly, marginally.
        let colons = String::from_utf8(maker.gpg(&["--with-colons", "--list-keys", "ada@example.com"]).stdout).unwrap();
        let fpr = colons.lines().find_map(|l| l.strip_prefix("fpr:")).unwrap().trim_matches(':').to_string();
        let marginal = GpgHome::new();
        let public2 = marginal.home().join("pub.gpg");
        std::fs::write(&public2, maker.gpg(&["--export"]).stdout).unwrap();
        assert!(marginal.gpg(&["--import", public2.to_str().unwrap()]).status.success());
        std::fs::write(marginal.home().join("trust.txt"), format!("{fpr}:4:\n")).unwrap();
        assert!(marginal.gpg(&["--import-ownertrust", marginal.home().join("trust.txt").to_str().unwrap()]).status.success());
        let direct_trust = marginal.home().parent().unwrap().join("gpg-direct.sh");
        std::fs::write(&direct_trust, format!("#!/bin/sh\nexec gpg --homedir {} --trust-model direct \"$@\"\n", crate::platform::fs::to_git_path(marginal.home()))).unwrap();
        crate::platform::fs::set_mode(&direct_trust, 0o755).unwrap();

        let cli = cli();
        let cases = [(&maker.program, good, SignatureKind::Verified), (&reader.program, good, SignatureKind::Unverified), (&direct_trust, good, SignatureKind::Verified), (&stranger.program, good, SignatureKind::UnknownKey), (&maker.program, tampered, SignatureKind::Bad), (&old.program, expired, SignatureKind::Expired)];
        for (program, id, want) in cases {
            r.git(&["config", "gpg.program", program.to_str().unwrap()]);
            let before = cli.log().entries().len();
            let direct = signature_status(&cli, r.path(), r.root(), id, true).await.unwrap();
            let runs = cli.log().entries()[before..].to_vec();
            assert_eq!(runs.len(), 1, "one process: {runs:?}");
            assert_eq!(runs[0].args[0], program.to_str().unwrap(), "gpg itself, not git: {runs:?}");
            assert!(runs[0].args.iter().any(|a| a == "--status-fd=1"));
            let via_git = git_signature_status(&cli, r.path(), id).await.unwrap();
            assert_eq!(direct.kind, want, "{direct:?}");
            if *program == direct_trust {
                assert_eq!(direct.trust, "marginal", "git counts a marginally valid key as good, and so do we");
            }
            assert_eq!((direct.kind, &direct.signer, &direct.key, &direct.fingerprint, &direct.trust), (via_git.kind, &via_git.signer, &via_git.key, &via_git.fingerprint, &via_git.trust), "{want:?}");
        }
        let leftovers = std::fs::read_dir(r.root()).unwrap().filter_map(Result::ok).filter(|e| e.file_name().to_string_lossy().starts_with("signature-")).count();
        assert_eq!(leftovers, 0, "the signature files are removed");
    }

    #[test]
    fn the_cache_keeps_settled_verdicts_and_briefly_the_others() {
        let key = |n: u8| (PathBuf::from("/r/.git"), ObjectId::from_hex(format!("{n:02x}").repeat(20).as_bytes()).unwrap());
        let with = |kind| SignaturePayload { kind, ..unsigned() };
        let stamp = vec![None];
        let mut c = SignatureCache::new(2);
        c.put(key(1), with(SignatureKind::Verified), stamp.clone());
        c.put(key(2), with(SignatureKind::UnknownKey), stamp.clone());
        assert_eq!(c.get(&key(1), &stamp).unwrap().kind, SignatureKind::Verified);
        assert_eq!(c.get(&key(2), &stamp).unwrap().kind, SignatureKind::UnknownKey, "within the TTL");
        let changed = vec![Some(SystemTime::UNIX_EPOCH)];
        assert_eq!(c.get(&key(1), &changed).unwrap().kind, SignatureKind::Verified, "settled: whatever the config");
        assert!(c.get(&key(2), &changed).is_none(), "a config change drops an unsettled verdict");
        c.put(key(2), with(SignatureKind::Bad), stamp.clone());
        c.get(&key(1), &stamp);
        c.put(key(3), with(SignatureKind::Verified), stamp.clone());
        assert_eq!(c.len(), 2);
        assert!(c.get(&key(2), &stamp).is_none(), "the least recently used went");
        assert!(c.get(&key(1), &stamp).is_some());
        // An unsettled verdict never replaces a settled one; a settled one replaces anything.
        c.put(key(1), with(SignatureKind::UnknownKey), stamp.clone());
        assert_eq!(c.get(&key(1), &stamp).unwrap().kind, SignatureKind::Verified);
        c.put(key(1), with(SignatureKind::Bad), stamp.clone());
        assert_eq!(c.get(&key(1), &stamp).unwrap().kind, SignatureKind::Bad);
    }

    #[cfg(unix)] // helper of Unix-only tests
    fn script(dir: &Path, name: &str, body: &str) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        crate::platform::fs::set_mode(&path, 0o755).unwrap();
        path
    }

    /// A commit carrying an OpenPGP-armored gpgsig header (not a real signature: the stub
    /// programs below never read it).
    #[cfg(unix)] // helper of Unix-only tests
    fn pgp_signed_commit(r: &TestRepo) -> ObjectId {
        let raw = r.git(&["cat-file", "commit", "HEAD"]);
        let (head, msg) = raw.split_once("\n\n").unwrap();
        let signed = format!("{head}\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n iHUEABYKAB0WIQ==\n -----END PGP SIGNATURE-----\n\n{msg}\n");
        commit_object(r, signed.as_bytes())
    }

    /// A gpg that hangs is given up on after the timeout: "gpg didn't answer", an unknown key
    /// (asked again later), and never a second try through git (which would hang on it too).
    #[cfg(unix)] // signing: the test's gpg/ssh-keygen wrappers are sh scripts (Windows signing is phase 2)
    #[tokio::test]
    async fn a_hanging_gpg_gives_up_without_asking_git() {
        let r = TestRepo::new();
        r.commit("base");
        let id = pgp_signed_commit(&r);
        let hang = script(r.root(), "gpg-hang.sh", "sleep 30");
        r.git(&["config", "gpg.program", hang.to_str().unwrap()]);
        let cli = cli();
        let started = Instant::now();
        let s = signature_status_within(&cli, r.path(), r.root(), id, true, Duration::from_millis(300)).await.unwrap();
        assert!(started.elapsed() < Duration::from_secs(5), "{:?}", started.elapsed());
        assert_eq!(s.kind, SignatureKind::UnknownKey);
        assert!(s.detail.as_deref().unwrap().starts_with("gpg didn't answer"), "{s:?}");
        assert!(!settled(s.kind), "retried after the TTL");
        let runs = cli.log().entries();
        assert_eq!(runs.len(), 1, "{runs:?}");
        assert_eq!(runs[0].args[0], hang.to_str().unwrap());
        assert!(!runs.iter().any(|e| e.args.iter().any(|a| a == "log")), "no git log %G? fallback");

        // A gpg that fails without a status line: the same verdict, no git either.
        let broken = script(r.root(), "gpg-broken.sh", "echo nope >&2; exit 7");
        r.git(&["config", "gpg.program", broken.to_str().unwrap()]);
        let before = cli.log().entries().len();
        let s = signature_status(&cli, r.path(), r.root(), id, true).await.unwrap();
        assert_eq!(s.kind, SignatureKind::UnknownKey);
        assert_eq!(cli.log().entries().len(), before + 1, "one run, no git");

        // A program that can't be started at all: git decides.
        r.git(&["config", "gpg.program", r.root().join("no-such-gpg").to_str().unwrap()]);
        let before = cli.log().entries().len();
        signature_status(&cli, r.path(), r.root(), id, true).await.unwrap();
        assert!(cli.log().entries()[before..].iter().any(|e| e.args.iter().any(|a| a == "log")), "the git path ran");
    }

    /// git's precedence: `gpg.program` and `gpg.openpgp.program` set the same thing, the last one
    /// read wins (here across an included file), and the profile include comes last of all.
    #[test]
    fn the_gpg_program_is_the_last_one_git_would_read() {
        let r = TestRepo::new();
        r.commit("base");
        // Isolated: the user's own global config never decides the answer.
        let mut only_repo = gix::open::Permissions::isolated();
        only_repo.config.includes = true;
        let program = |include: Option<&Path>| gpg_program(&gix::open_opts(r.path(), gix::open::Options::default().permissions(only_repo)).unwrap(), include);
        assert_eq!(program(None), PathBuf::from("gpg"));
        r.git(&["config", "gpg.openpgp.program", "/opt/first"]);
        r.git(&["config", "gpg.program", "/opt/second"]);
        assert_eq!(program(None), PathBuf::from("/opt/second"), "gpg.program read last wins over gpg.openpgp.program");
        let included = r.root().join("included.config");
        std::fs::write(&included, "[gpg \"openpgp\"]\n\tprogram = /opt/included\n").unwrap();
        r.git(&["config", "include.path", included.to_str().unwrap()]);
        assert_eq!(program(None), PathBuf::from("/opt/included"), "an include read after the others wins");
        let profile = r.root().join("profile.config");
        let nested = r.root().join("nested.config");
        std::fs::write(&nested, "[gpg]\n\tprogram = /opt/profile-nested\n").unwrap();
        std::fs::write(&profile, format!("[include]\n\tpath = {}\n", crate::platform::fs::to_git_path(&nested))).unwrap();
        assert_eq!(program(Some(&profile)), PathBuf::from("/opt/profile-nested"), "the profile include (and its includes) last");
    }

    #[test]
    fn the_config_stamp_covers_system_and_included_files() {
        let r = TestRepo::new();
        r.commit("base");
        let included = r.root().join("included.config");
        std::fs::write(&included, "[gpg]\n\tprogram = gpg\n").unwrap();
        r.git(&["config", "include.path", included.to_str().unwrap()]);
        let repo = gix::open(r.path()).unwrap();
        let files = config_files(&repo);
        assert!(files.iter().any(|f| f.ends_with("included.config")), "{files:?}");
        let stamp = || config_stamp(repo.git_dir(), repo.common_dir(), None, config_files(&repo));
        let before = stamp();
        std::thread::sleep(Duration::from_millis(20));
        std::fs::write(&included, "[gpg]\n\tprogram = gpg2\n").unwrap();
        assert_ne!(stamp(), before, "an included file's change is seen");
    }
}
