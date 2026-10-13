//! Renders any path of a snapshot: the two files releases write, an exact-path `Bytes` value (an
//! asset, or a table a filler retuned), then the corpus.

use super::corpus::Corpus;
use super::model::{Render, Snapshot, Value};
use super::releases::{self, Section};
use std::cell::RefCell;
use std::rc::Rc;

pub struct Content<'a> {
    pub corpus: &'a Corpus,
    /// The changelog's sections so far, one per release.
    pub sections: RefCell<Vec<Section>>,
}

impl Render for Content<'_> {
    fn render(&self, path: &str, snap: &Snapshot) -> Option<Rc<[u8]>> {
        match path {
            "Cargo.toml" => return releases::render_cargo(snap).map(|s| Rc::from(s.into_bytes())),
            "CHANGELOG.md" => return releases::render_changelog(snap, &self.sections.borrow()).map(|s| Rc::from(s.into_bytes())),
            _ => {}
        }
        if let Some(Value::Bytes(b)) = snap.get(path) {
            return Some(b.clone());
        }
        let text = self.corpus.render(path, |k| match snap.get(k)? {
            Value::Version(n) => Some((*n, None)),
            Value::Tuned(n, lit) => Some((*n, Some(lit.to_string()))),
            _ => None,
        })?;
        Some(Rc::from(text.into_bytes()))
    }
}
