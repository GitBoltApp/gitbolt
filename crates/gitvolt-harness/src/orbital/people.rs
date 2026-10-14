//! Orbital's six contributors (all made up), where they work from and when.

use super::history::Sig;
use std::path::Path;
use std::process::Command;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    Lead,
    Rendering,
    Art,
    Audio,
    Design,
    Tools,
}

#[derive(Debug)]
pub struct Person {
    pub handle: &'static str,
    pub name: &'static str,
    pub email: &'static str,
    pub tz_minutes: i32,
    /// Local working hours, [start, end).
    pub hours: (u32, u32),
    /// The chance they work on a given weekend day.
    pub weekend: f32,
    pub role: Role,
}

pub const PEOPLE: [Person; 6] = [
    Person { handle: "ilse", name: "Ilse Varga", email: "ilse.varga@example.com", tz_minutes: 60, hours: (9, 18), weekend: 0.05, role: Role::Lead },
    Person { handle: "teodor", name: "Teodor Brandvik", email: "teodor.brandvik@example.com", tz_minutes: 60, hours: (10, 19), weekend: 0.1, role: Role::Rendering },
    Person { handle: "noor", name: "Noor Achterberg", email: "noor.achterberg@example.com", tz_minutes: -300, hours: (11, 20), weekend: 0.15, role: Role::Art },
    Person { handle: "kasimir", name: "Kasimir Oduya", email: "kasimir.oduya@example.com", tz_minutes: 120, hours: (8, 17), weekend: 0.05, role: Role::Audio },
    Person { handle: "wen", name: "Wen Castellano", email: "wen.castellano@example.com", tz_minutes: -480, hours: (9, 23), weekend: 0.2, role: Role::Design },
    Person { handle: "rafe", name: "Rafe Lindqvist", email: "rafe.lindqvist@example.com", tz_minutes: 0, hours: (8, 16), weekend: 0.03, role: Role::Tools },
];

pub fn find(handle: &str) -> Option<&'static Person> {
    PEOPLE.iter().find(|p| p.handle == handle)
}

pub fn person(handle: &str) -> &'static Person {
    find(handle).unwrap_or_else(|| panic!("no contributor {handle:?}"))
}

impl Person {
    pub fn sig(&'static self, time: i64) -> Sig<'static> {
        Sig { name: self.name, email: self.email, time, tz_minutes: self.tz_minutes }
    }
}

/// The core's isolated git env, plus SHA-1 (the history stream assumes it, whatever the machine's default).
pub fn git_env() -> Vec<(std::ffi::OsString, std::ffi::OsString)> {
    let mut env = gitvolt_core::testing::isolated_git_env();
    env.push(("GIT_DEFAULT_HASH".into(), "sha1".into()));
    env
}

pub fn git_as(dir: &Path, who: &Person, when: i64, args: &[&str]) -> Result<String, String> {
    let date = format!("@{when} {}", super::history::tz(who.tz_minutes));
    let out = Command::new("git")
        .current_dir(dir)
        .args(["-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", "-c", "core.hooksPath=/dev/null"])
        .args(args)
        .envs(git_env())
        .env("GIT_AUTHOR_NAME", who.name)
        .env("GIT_AUTHOR_EMAIL", who.email)
        .env("GIT_COMMITTER_NAME", who.name)
        .env("GIT_COMMITTER_EMAIL", who.email)
        .env("GIT_AUTHOR_DATE", &date)
        .env("GIT_COMMITTER_DATE", &date)
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim_end().to_string())
    } else {
        Err(format!("git {args:?}: {}", String::from_utf8_lossy(&out.stderr)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn six_fictional_people_with_distinct_emails() {
        let mut emails: Vec<&str> = PEOPLE.iter().map(|p| p.email).collect();
        emails.sort();
        emails.dedup();
        assert_eq!(emails.len(), 6);
        assert!(PEOPLE.iter().all(|p| p.email.ends_with("@example.com")));
        assert_eq!(person("noor").name, "Noor Achterberg");
        assert_eq!(person("wen").sig(1).tz_minutes, -480);
    }

    #[test]
    fn git_as_commits_as_that_person_at_that_time() {
        let dir = tempfile::tempdir().unwrap();
        git_as(dir.path(), person("rafe"), 1_800_000_000, &["init", "-q", "-b", "main"]).unwrap();
        std::fs::write(dir.path().join("f"), "x\n").unwrap();
        git_as(dir.path(), person("rafe"), 1_800_000_000, &["add", "f"]).unwrap();
        git_as(dir.path(), person("rafe"), 1_800_000_000, &["commit", "-q", "-m", "Add f"]).unwrap();
        let log = git_as(dir.path(), person("rafe"), 0, &["log", "-1", "--format=%an|%ae|%cn|%at|%ct"]).unwrap();
        assert_eq!(log, "Rafe Lindqvist|rafe.lindqvist@example.com|Rafe Lindqvist|1800000000|1800000000");
    }
}
