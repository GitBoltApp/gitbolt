//! Orbital's repository state between commits: each key holds a corpus block's version, a
//! retuned constant (or a header cut down to the imports its file uses so far), a generated value
//! or an asset's bytes. A path's file renders from the keys
//! under it (`path` and `path#…`); a commit is a list of edits.

use std::collections::{BTreeMap, BTreeSet};
use std::ops::Bound;
use std::rc::Rc;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Value {
    Version(u16),
    Tuned(u16, Rc<str>),
    Text(Rc<str>),
    Bytes(Rc<[u8]>),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Edit {
    pub key: String,
    pub value: Option<Value>,
}

impl Edit {
    pub fn set(key: impl Into<String>, value: Value) -> Edit {
        Edit {
            key: key.into(),
            value: Some(value),
        }
    }

    pub fn remove(key: impl Into<String>) -> Edit {
        Edit {
            key: key.into(),
            value: None,
        }
    }
}

pub fn path_of(key: &str) -> &str {
    key.split_once('#').map_or(key, |(p, _)| p)
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Snapshot {
    map: BTreeMap<String, Value>,
}

impl Snapshot {
    pub fn get(&self, key: &str) -> Option<&Value> {
        self.map.get(key)
    }

    /// Applies the edits in order and returns the paths they touched (removing a missing key
    /// still counts).
    pub fn apply(&mut self, edits: &[Edit]) -> BTreeSet<String> {
        let mut touched = BTreeSet::new();
        for e in edits {
            match &e.value {
                Some(v) => {
                    self.map.insert(e.key.clone(), v.clone());
                }
                None => {
                    self.map.remove(&e.key);
                }
            }
            touched.insert(path_of(&e.key).to_string());
        }
        touched
    }

    /// The keys of one file, in key order: `path` itself and every `path#…`.
    pub fn under<'a>(&'a self, path: &'a str) -> impl Iterator<Item = (&'a str, &'a Value)> + 'a {
        // Every key of the file sorts among the keys that start with `path` ("src/a.rs x" and
        // "src/a.rs.bak" sit there too, hence the filter).
        self.map
            .range::<str, _>((Bound::Included(path), Bound::Unbounded))
            .take_while(move |(k, _)| k.starts_with(path))
            .filter(move |(k, _)| k.len() == path.len() || k[path.len()..].starts_with('#'))
            .map(|(k, v)| (k.as_str(), v))
    }

    pub fn keys(&self) -> impl Iterator<Item = (&String, &Value)> {
        self.map.iter()
    }

    pub fn paths(&self) -> BTreeSet<String> {
        self.map.keys().map(|k| path_of(k).to_string()).collect()
    }
}

/// The paths whose keys differ between two snapshots.
pub fn changed_paths(a: &Snapshot, b: &Snapshot) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    for (k, v) in &a.map {
        if b.map.get(k) != Some(v) {
            out.insert(path_of(k).to_string());
        }
    }
    for k in b.map.keys() {
        if !a.map.contains_key(k) {
            out.insert(path_of(k).to_string());
        }
    }
    out
}

/// A path's file in a snapshot, or `None` when the snapshot has no such file.
pub trait Render {
    fn render(&self, path: &str, snap: &Snapshot) -> Option<Rc<[u8]>>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn apply_reports_paths_and_under_finds_a_files_keys() {
        let mut s = Snapshot::default();
        let touched = s.apply(&[
            Edit::set("src/a.rs#header", Value::Version(1)),
            Edit::set("src/a.rs#item:go", Value::Version(1)),
            Edit::set("src/a.rs x", Value::Version(1)),
            Edit::set("README.md", Value::Version(2)),
        ]);
        assert_eq!(
            touched.into_iter().collect::<Vec<_>>(),
            ["README.md", "src/a.rs", "src/a.rs x"]
        );
        let keys: Vec<&str> = s.under("src/a.rs").map(|(k, _)| k).collect();
        assert_eq!(keys, ["src/a.rs#header", "src/a.rs#item:go"]);
        s.apply(&[Edit::remove("src/a.rs#item:go")]);
        assert_eq!(s.under("src/a.rs").count(), 1);
        assert_eq!(path_of("src/a.rs#item:go"), "src/a.rs");
    }

    #[test]
    fn under_skips_neighbours_and_includes_the_bare_path() {
        let mut s = Snapshot::default();
        s.apply(&[
            Edit::set("a.rs", Value::Text("whole".into())),
            Edit::set("a.rs.bak", Value::Version(1)),
            Edit::set("a.rs#z", Value::Version(1)),
            Edit::set("a.rsx#k", Value::Version(1)),
            Edit::set("a.r", Value::Version(1)),
        ]);
        let keys: Vec<&str> = s.under("a.rs").map(|(k, _)| k).collect();
        assert_eq!(keys, ["a.rs", "a.rs#z"]);
        assert_eq!(
            s.paths().into_iter().collect::<Vec<_>>(),
            ["a.r", "a.rs", "a.rs.bak", "a.rsx"]
        );
        assert_eq!(s.get("a.rs#z"), Some(&Value::Version(1)));
    }

    #[test]
    fn changed_paths_compares_two_snapshots() {
        let mut a = Snapshot::default();
        a.apply(&[
            Edit::set("x#k", Value::Version(1)),
            Edit::set("y", Value::Text("1".into())),
        ]);
        let mut b = a.clone();
        b.apply(&[
            Edit::set("x#k", Value::Version(2)),
            Edit::set("z", Value::Bytes(Rc::from(&b"z"[..]))),
        ]);
        assert_eq!(
            changed_paths(&a, &b).into_iter().collect::<Vec<_>>(),
            ["x", "z"]
        );
        assert!(changed_paths(&a, &a).is_empty());
    }
}
