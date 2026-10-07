//! What differs between Unix and Windows, one module per concern. Each has a Unix side (the
//! code GitBolt always had) and a Windows side; callers use the one API and stay free of `cfg`.
//!
//! - [`fs`]: permission bits, private files and folders, file identity, directory sync, symlinks.
//! - [`osstr`]: OS strings from git's bytes.
//! - [`process`]: a child's own process group (or session) and stopping all of it.
//! - [`ipc`]: the local endpoint askpass and the single-instance guard listen on (a Unix
//!   socket, a Windows named pipe).
//! - [`random`]: the OS's CSPRNG.

pub mod fs;
pub mod ipc;
pub mod osstr;
pub mod process;
pub mod random;
