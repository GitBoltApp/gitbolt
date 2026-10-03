//! The interactive rebase (spec #3 §3.1–§3.6): the range read, the todo, the intent, the Edit stop
//! (UX L), the Abort's kept work, the older-commit reword and conflict prediction.

pub mod edit;
pub mod plan;
pub mod predict;
pub mod reword;
pub mod run;
pub mod split;
pub mod todo;
pub mod types;
