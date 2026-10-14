//! A child's own process group, and stopping all of it (git and whatever it started: ssh, a
//! credential helper, a hook).
//!
//! Unix: the child leads a new process group (or a new session, so it has no controlling
//! terminal), and a stop signals the whole group: SIGTERM first for a write (git removes its
//! `.lock` files), SIGKILL. Windows: the child starts without a console window
//! (`CREATE_NO_WINDOW`, so none flashes up and nothing can prompt on one) and is put in a job
//! object right after it starts; a stop terminates the job, which holds everything it started.
//! There's no SIGTERM for a windowless process there, so [`Group::terminate`] kills too: a
//! write stopped mid-way may leave a `.lock` file (Remove stale lock offers to clear it).

use std::process::Command;

/// Starts the child in its own process group (Unix), so a stop reaches its children too.
pub fn own_group(cmd: &mut Command) {
    imp::own_group(cmd);
}

/// Starts the child in a new session (`setsid`, Unix): it has no controlling terminal, so ssh
/// or a credential helper can't open `/dev/tty` to prompt. It leads its own group as well.
pub fn own_session(cmd: &mut Command) {
    imp::own_session(cmd);
}

/// A started child's process group (Unix) or job (Windows).
#[derive(Debug, Clone)]
pub struct Group(imp::Group);

impl Group {
    /// The group of `child`, started with [`own_group`] or [`own_session`].
    pub fn of(child: &tokio::process::Child) -> Self {
        Self(imp::Group::of(child))
    }

    /// Asks every process in it to stop (SIGTERM). Windows: kills them (see the module docs).
    pub fn terminate(&self) {
        self.0.terminate();
    }

    /// Kills every process in it (SIGKILL).
    pub fn kill(&self) {
        self.0.kill();
    }
}

#[cfg(unix)]
mod imp {
    use nix::sys::signal::Signal;
    use std::os::unix::process::CommandExt;
    use std::process::Command;

    pub fn own_group(cmd: &mut Command) {
        cmd.process_group(0);
    }

    pub fn own_session(cmd: &mut Command) {
        // SAFETY: `setsid` is async-signal-safe and the closure touches nothing else.
        unsafe {
            cmd.pre_exec(|| nix::unistd::setsid().map(drop).map_err(std::io::Error::from));
        }
    }

    /// The leader's pid, which is the group's id. Accepted risk (1C review M7): if the leader was
    /// already reaped, its pid could in theory be reused and `killpg` would hit a stranger's
    /// group. The window is tiny (we kill on timeout/cancel while the child is still ours,
    /// before `wait` reaps it, and a zombie leader keeps its pid and group alive), so no extra
    /// guard is added.
    #[derive(Debug, Clone)]
    pub struct Group {
        pid: Option<u32>,
    }

    impl Group {
        pub fn of(child: &tokio::process::Child) -> Self {
            Self { pid: child.id() }
        }

        fn signal(&self, signal: Signal) {
            if let Some(pid) = self.pid {
                let _ = nix::sys::signal::killpg(nix::unistd::Pid::from_raw(pid as i32), signal);
            }
        }

        pub fn terminate(&self) {
            self.signal(Signal::SIGTERM);
        }

        pub fn kill(&self) {
            self.signal(Signal::SIGKILL);
        }
    }
}

#[cfg(windows)]
mod imp {
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle, RawHandle};
    use std::os::windows::process::CommandExt;
    use std::process::Command;
    use std::sync::Arc;
    use windows_sys::Win32::System::JobObjects::{AssignProcessToJobObject, CreateJobObjectW, TerminateJobObject};
    use windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;

    pub fn own_group(cmd: &mut Command) {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    pub fn own_session(cmd: &mut Command) {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    /// The job the child was put in right after it started (what it starts joins it too). If
    /// that failed, `taskkill /T` on its pid (its tree, while the parent still runs).
    #[derive(Debug, Clone)]
    pub struct Group {
        job: Option<Arc<OwnedHandle>>,
        pid: Option<u32>,
    }

    impl Group {
        pub fn of(child: &tokio::process::Child) -> Self {
            Self { job: child.raw_handle().and_then(job_for), pid: child.id() }
        }

        pub fn terminate(&self) {
            self.kill();
        }

        pub fn kill(&self) {
            match &self.job {
                // SAFETY: a job handle we own.
                Some(job) => unsafe {
                    TerminateJobObject(job.as_raw_handle(), 1);
                },
                None => {
                    if let Some(pid) = self.pid {
                        let _ = Command::new("taskkill").args(["/T", "/F", "/PID", &pid.to_string()]).creation_flags(CREATE_NO_WINDOW).output();
                    }
                }
            }
        }
    }

    fn job_for(process: RawHandle) -> Option<Arc<OwnedHandle>> {
        // SAFETY: an unnamed job with default security; the handle is checked, then owned.
        let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if job.is_null() {
            return None;
        }
        // SAFETY: `job` is a fresh valid handle that nothing else owns.
        let job = unsafe { OwnedHandle::from_raw_handle(job) };
        // SAFETY: both handles are valid; the process one is the child's, still open.
        (unsafe { AssignProcessToJobObject(job.as_raw_handle(), process) } != 0).then(|| Arc::new(job))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    /// A child that starts a grandchild and waits: killing the group stops both, so the pipe
    /// they share closes and the read ends.
    #[tokio::test]
    async fn killing_the_group_stops_the_children_too() {
        #[cfg(unix)]
        let mut cmd = {
            let mut c = Command::new("sh");
            c.args(["-c", "sleep 30 & wait"]);
            c
        };
        #[cfg(windows)]
        let mut cmd = {
            let mut c = Command::new("cmd");
            c.args(["/C", "ping -n 30 127.0.0.1 >NUL & ping -n 30 127.0.0.1"]);
            c
        };
        cmd.stdout(std::process::Stdio::piped()).stdin(std::process::Stdio::null());
        own_group(&mut cmd);
        let mut child = tokio::process::Command::from(cmd).spawn().unwrap();
        let group = Group::of(&child);
        let mut out = child.stdout.take().unwrap();
        tokio::time::sleep(Duration::from_millis(300)).await;
        group.kill();
        let status = tokio::time::timeout(Duration::from_secs(10), child.wait()).await.expect("the child stops").unwrap();
        assert!(!status.success());
        let mut rest = Vec::new();
        let read = tokio::time::timeout(Duration::from_secs(10), tokio::io::AsyncReadExt::read_to_end(&mut out, &mut rest)).await;
        assert!(read.is_ok(), "no grandchild keeps the pipe open");
    }
}
