//! Commit-author avatars by name: the people an account's API data already showed (MR/PR
//! authors, assignees, reviewers, approvers, note authors), by display name and username. A commit
//! author whose email the forge doesn't know gets the picture of the one person with that exact
//! name (case and spacing aside); two people with that name get none. Kept in memory per account
//! (so per host), never logged.

use gitbolt_core::forge::{ForgeDiscussion, ForgeMr, ForgeMrDetail, ForgeUser};
use std::collections::HashMap;
use std::sync::Mutex;

/// Names kept per account: beyond it, new names aren't learned (the session's people fit).
pub const MAX_NAMES: usize = 5000;

/// `name` folded for matching: lowercase, inner whitespace runs as one space, trimmed.
pub fn normalize(name: &str) -> String {
    name.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NameMatch {
    /// Nobody seen has that name.
    Unknown,
    /// Exactly one person has it: their `avatar_url`, if any.
    One(Option<String>),
    /// Two or more people have it: never a guess.
    Many,
}

#[derive(Default)]
pub struct KnownNames {
    /// Normalized display name or username → user id → that user's `avatar_url`.
    by_name: Mutex<HashMap<String, HashMap<u64, Option<String>>>>,
}

impl KnownNames {
    pub fn learn(&self, u: &ForgeUser) {
        let mut map = self.by_name.lock().expect("known names poisoned");
        for key in [normalize(&u.name), normalize(&u.username)] {
            if key.is_empty() || (map.len() >= MAX_NAMES && !map.contains_key(&key)) {
                continue;
            }
            map.entry(key).or_default().insert(u.id, u.avatar_url.clone());
        }
    }

    pub fn learn_all<'a>(&self, users: impl IntoIterator<Item = &'a ForgeUser>) {
        for u in users {
            self.learn(u);
        }
    }

    /// An MR's author and approvers.
    pub fn learn_mr(&self, m: &ForgeMr) {
        self.learn(&m.author);
        self.learn_all(m.review.reviews.iter().map(|r| &r.user));
    }

    pub fn learn_mrs(&self, mrs: &[ForgeMr]) {
        for m in mrs {
            self.learn_mr(m);
        }
    }

    /// An MR's author, approvers, reviewers and assignees.
    pub fn learn_detail(&self, d: &ForgeMrDetail) {
        self.learn_mr(&d.mr);
        self.learn_all(d.reviewers.iter().chain(&d.assignees));
    }

    /// The notes' authors.
    pub fn learn_discussions(&self, ds: &[ForgeDiscussion]) {
        self.learn_all(ds.iter().flat_map(|d| &d.notes).map(|n| &n.author));
    }

    /// Who has exactly `name` (normalized), by display name or username.
    pub fn find(&self, name: &str) -> NameMatch {
        let key = normalize(name);
        let map = self.by_name.lock().expect("known names poisoned");
        match map.get(&key).filter(|_| !key.is_empty()) {
            None => NameMatch::Unknown,
            Some(ids) if ids.len() == 1 => NameMatch::One(ids.values().next().cloned().flatten()),
            Some(_) => NameMatch::Many,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn user(id: u64, username: &str, name: &str, avatar: Option<&str>) -> ForgeUser {
        ForgeUser { id, username: username.into(), name: name.into(), avatar_url: avatar.map(str::to_string), web_url: String::new(), email: None }
    }

    #[test]
    fn one_person_by_exact_name_or_username_any_case_and_spacing() {
        let k = KnownNames::default();
        k.learn(&user(1, "mham", "Margaret Hamilton", Some("https://g/uploads/m.png")));
        assert_eq!(k.find("  margaret   HAMILTON "), NameMatch::One(Some("https://g/uploads/m.png".into())));
        assert_eq!(k.find("MHam"), NameMatch::One(Some("https://g/uploads/m.png".into())));
        assert_eq!(k.find("Margaret"), NameMatch::Unknown, "a full name only");
        assert_eq!(k.find(""), NameMatch::Unknown);
        k.learn(&user(1, "mham", "Margaret Hamilton", None));
        assert_eq!(k.find("margaret hamilton"), NameMatch::One(None), "the same person again: their latest");
    }

    #[test]
    fn two_people_with_one_name_is_no_answer() {
        let k = KnownNames::default();
        k.learn(&user(1, "jsmith", "John Smith", Some("https://g/uploads/1.png")));
        k.learn(&user(2, "jsmith2", "john smith", Some("https://g/uploads/2.png")));
        assert_eq!(k.find("John Smith"), NameMatch::Many);
        // A username one person has and another's display name: still two people.
        k.learn(&user(3, "ada", "Ada Lovelace", None));
        k.learn(&user(4, "ada2", "Ada", None));
        assert_eq!(k.find("ada"), NameMatch::Many);
    }
}
