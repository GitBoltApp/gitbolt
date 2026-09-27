//! Commit signature status through the user's own gpg/ssh configuration (spec §5.1, §9.1).

use crate::error::GbError;
use crate::git::{GitCli, GitInvocation};
use crate::payload::{SignatureKind, SignaturePayload};
use gix::ObjectId;
use std::path::Path;

pub const SIGNATURE_FORMAT: &str = "--format=%G?%x00%GS%x00%GK%x00%GF%x00%GT";

pub fn unsigned() -> SignaturePayload {
    SignaturePayload { kind: SignatureKind::Unsigned, signer: String::new(), key: String::new(), fingerprint: String::new(), trust: String::new(), detail: None }
}

/// Parses `%G?%x00%GS%x00%GK%x00%GF%x00%GT`. `signed` says whether the raw commit has a
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

pub async fn signature_status(cli: &GitCli, cwd: &Path, id: ObjectId, signed: bool) -> Result<SignaturePayload, GbError> {
    if !signed {
        return Ok(unsigned());
    }
    let id = id.to_string();
    let out = cli.run(GitInvocation::new(cwd, ["log", "-1", "--no-show-signature", SIGNATURE_FORMAT, id.as_str(), "--"])).await?;
    Ok(parse_signature_status(&out.stdout, &out.stderr, true))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::log::CommandLog;
    use crate::testing::{isolated_git_env, TestRepo};
    use std::sync::Arc;

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

    /// F11: the throwaway repo's own config carries `gpg.format`/`user.signingkey`, never
    /// `-c user.signingkey=...` on the command line, and the user's global git config is never
    /// touched (`isolated_git_env` already points `GIT_CONFIG_GLOBAL` at `/dev/null`).
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

        let unconfigured = signature_status(&cli, r.path(), trusted, true).await.unwrap();
        assert_eq!(unconfigured.kind, SignatureKind::UnknownKey, "signed, but git can't verify without allowed signers");

        let allowed = r.root().join("allowed_signers");
        std::fs::write(&allowed, format!("ada@example.com {}", std::fs::read_to_string(key.with_extension("pub")).unwrap())).unwrap();
        r.git(&["config", "gpg.ssh.allowedSignersFile", allowed.to_str().unwrap()]);
        let ok = signature_status(&cli, r.path(), trusted, true).await.unwrap();
        assert_eq!((ok.kind, ok.signer.as_str()), (SignatureKind::Verified, "ada@example.com"));
        assert!(ok.key.starts_with("SHA256:"));
        assert_eq!(signature_status(&cli, r.path(), stranger, true).await.unwrap().kind, SignatureKind::Unverified);

        let before = cli.log().entries().len();
        let base = ObjectId::from_hex(r.git(&["rev-parse", "HEAD~2"]).as_bytes()).unwrap();
        assert_eq!(signature_status(&cli, r.path(), base, false).await.unwrap().kind, SignatureKind::Unsigned);
        assert_eq!(cli.log().entries().len(), before, "unsigned commits never run git");
    }
}
