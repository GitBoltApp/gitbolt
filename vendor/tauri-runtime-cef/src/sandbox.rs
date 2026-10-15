// Copyright 2019-2024 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

//! Decides whether Chromium's process sandbox has to be turned off.
//!
//! On every platform the answer normally comes straight from [`SandboxPolicy`], and the
//! answer is "keep it". Only Linux and the BSDs have a case where keeping it means the
//! application cannot start at all, and detecting that case is what the bulk of this
//! module is for.
//!
//! # The Linux case
//!
//! Chromium's zygote host picks, in order, the namespace sandbox when unprivileged user
//! namespaces work, then the root-owned setuid `chrome-sandbox` helper found next to the
//! executable (or, when there is none there, at `CHROME_DEVEL_SANDBOX`). When neither is available it calls
//! `LOG(FATAL) << "No usable sandbox!"` and the process dies before a window is ever
//! shown.
//!
//! Tauri's deb and rpm bundlers install `chrome-sandbox` with mode 4755, so packaged
//! applications always have the helper. An AppImage cannot: the runtime mounts its
//! payload with `nosuid`, so a setuid binary inside it is inert. That leaves AppImages
//! relying on unprivileged user namespaces, which Ubuntu 23.10 and later restrict
//! through AppArmor — which is exactly the combination this module detects.
//!
//! Tauri's AppImage bundler does copy `chrome-sandbox` next to the main binary, so the
//! helper is *present* in every CEF AppImage and finding a file by that name proves
//! nothing; one inside an AppImage is never treated as available. Outside an AppImage
//! the file is stat'ed against the same conditions Chromium's zygote host applies —
//! owned by root, setuid, executable by others — because Chromium treats a helper that
//! fails them as a fatal error rather than falling back to another sandbox.
//!
//! GitVolt patch: AppArmor's restriction also breaks installs that *do* have the helper.
//! Chromium probes for the namespace sandbox by cloning into a new user namespace and
//! `PCHECK`s the errno when that fails, accepting only the ones it expects, which `EACCES`
//! is not. Where Ubuntu's `unprivileged_userns` AppArmor profile is
//! loaded the clone succeeds, stripped of capabilities, and the probe falls back to the
//! helper; where it is not, AppArmor denies `userns_create` with `EACCES` and the browser
//! dies at `sandbox/linux/services/credentials.cc` ("Check failed: . : Permission denied
//! (13)") before it ever considers the helper. So with a usable helper outside an
//! AppImage and the restriction on, the runtime passes `--disable-namespace-sandbox`
//! ([`SandboxDecision::KeepSetuidOnly`]): Chromium skips the probe and uses the helper,
//! which is what it settles on anyway where the probe survives: unless an AppArmor profile
//! grants this executable user namespaces, the restriction leaves them without the
//! capabilities the namespace sandbox needs.
//!
//! # The Windows case
//!
//! **A plain Windows executable runs unsandboxed, whatever the policy says.** Chromium's
//! Windows sandbox is brokered by the executable rather than by the library: CEF wants a
//! `sandbox_info` pointer from `cef_sandbox_info_create()` passed into both
//! `CefExecuteProcess` and `CefInitialize`, and when it gets a null one it sets
//! `CefSettings.no_sandbox` itself and appends `--no-sandbox`
//! (`libcef/browser/main_runner.cc`).
//!
//! Since Chromium M138 that entry point can only be linked by a binary built with
//! Chromium's own toolchain, so CEF ships prebuilt `bootstrap.exe` / `bootstrapc.exe`
//! hosts that load the application as a DLL exporting `RunWinMain` or `RunConsoleMain`
//! (named like the renamed host: `app.exe` loads `app.dll`) and hand it the pointer.
//! GitVolt patch: such an entry point passes it to [`set_windows_sandbox_info`] before
//! anything else, and the runtime hands it to every `CefExecuteProcess` and
//! `CefInitialize` call, so the renderer, GPU and utility processes run sandboxed.
//!
//! Without a pointer, the honest thing is to say so: [`windows_sandbox_unavailable`]
//! reports the gap so [`SandboxPolicy::Auto`] logs it like any other lost sandbox, and
//! [`SandboxPolicy::Required`] fails loudly instead of quietly returning a promise the
//! platform cannot keep.
//!
//! # macOS
//!
//! macOS sandboxes through `libcef_sandbox.dylib`, which the helper process loads and
//! initializes before the framework, so there is nothing to probe: the policy decides on
//! its own and [`SandboxPolicy::Auto`] always keeps the sandbox.

use crate::runtime::SandboxPolicy;

/// Whether this platform can actually sandbox, given how the runtime initializes CEF.
///
/// Windows can only when the application runs as a DLL under CEF's bootstrap, which hands
/// it the broker ([`set_windows_sandbox_info`]); see the module docs. Kept as a function
/// rather than a `cfg` at every use site so the decision table stays testable on one
/// platform.
pub(crate) fn windows_sandbox_unavailable() -> bool {
  cfg!(windows) && windows_sandbox_info().is_null()
}

/// GitVolt patch: the sandbox broker `bootstrap.exe` passed to the application DLL's
/// `RunWinMain`/`RunConsoleMain`, or null.
#[cfg(windows)]
static WINDOWS_SANDBOX_INFO: std::sync::atomic::AtomicPtr<u8> =
  std::sync::atomic::AtomicPtr::new(std::ptr::null_mut());

/// GitVolt patch: hands the runtime the sandbox broker CEF's `bootstrap.exe` gave the
/// application DLL's entry point, so every `CefExecuteProcess` and `CefInitialize` gets it
/// and the processes run sandboxed. Call it first in `RunWinMain`/`RunConsoleMain`, before
/// the CEF entry point runs.
///
/// # Safety
///
/// `info` must be the `sandbox_info` pointer the bootstrap passed in (or null), which
/// stays valid for the life of the process.
#[cfg(windows)]
pub unsafe fn set_windows_sandbox_info(info: *mut std::ffi::c_void) {
  WINDOWS_SANDBOX_INFO.store(info.cast(), std::sync::atomic::Ordering::SeqCst);
}

/// The broker for `CefExecuteProcess` and `CefInitialize`: null unless the bootstrap gave one.
pub(crate) fn windows_sandbox_info() -> *mut u8 {
  #[cfg(windows)]
  return WINDOWS_SANDBOX_INFO.load(std::sync::atomic::Ordering::SeqCst);
  #[cfg(not(windows))]
  std::ptr::null_mut()
}

/// Why the sandbox is being turned off.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SandboxDisableReason {
  /// The application asked for it through [`SandboxPolicy::Disabled`].
  Policy,
  /// AppImage, no setuid helper, and AppArmor restricts unprivileged user namespaces.
  AppImageUserNamespacesRestricted,
  /// AppImage, no setuid helper, and user namespaces are unavailable altogether.
  AppImageUserNamespacesUnavailable,
  /// Windows, where this runtime cannot supply CEF with a sandbox broker.
  WindowsBrokerUnavailable,
}

impl SandboxDisableReason {
  /// Message logged when the sandbox is dropped for this reason.
  pub(crate) fn message(self) -> &'static str {
    match self {
      Self::Policy => "the application set SandboxPolicy::Disabled",
      Self::AppImageUserNamespacesRestricted => {
        "running from an AppImage, which cannot ship the setuid chrome-sandbox helper, \
         and unprivileged user namespaces are restricted \
         (/proc/sys/kernel/apparmor_restrict_unprivileged_userns is 1)"
      }
      Self::AppImageUserNamespacesUnavailable => {
        "running from an AppImage, which cannot ship the setuid chrome-sandbox helper, \
         and unprivileged user namespaces are unavailable \
         (/proc/sys/user/max_user_namespaces is 0)"
      }
      Self::WindowsBrokerUnavailable => {
        "the Windows sandbox needs the broker CEF's bootstrap executable makes: run the \
         application as a DLL hosted by bootstrap.exe, whose entry point passes it to \
         set_windows_sandbox_info (this process is a plain executable)"
      }
    }
  }
}

/// Whether `--no-sandbox` has to be appended, and why.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SandboxDecision {
  /// Leave the sandbox alone.
  Keep,
  /// GitVolt patch: keep the sandbox, but append `--disable-namespace-sandbox` so Chromium
  /// goes straight to the setuid helper without probing user namespaces, a probe that
  /// aborts the browser when AppArmor denies them outright (see the module docs).
  KeepSetuidOnly,
  /// Append `--no-sandbox`, logging `reason`.
  Disable(SandboxDisableReason),
  /// [`SandboxPolicy::Required`] asked for a sandbox this platform cannot provide, so
  /// startup fails rather than silently running without one.
  Refuse(SandboxDisableReason),
}

/// Decides whether to disable the sandbox, from inputs the caller has already gathered.
///
/// Kept free of I/O so every combination can be unit tested.
///
/// `apparmor_restrict_unprivileged_userns` and `max_user_namespaces` are the values read
/// from `/proc/sys/kernel/apparmor_restrict_unprivileged_userns` and
/// `/proc/sys/user/max_user_namespaces`; [`None`] means the file could not be read,
/// which is treated as no evidence of a restriction rather than as a restriction.
///
/// `windows_broker_unavailable` is [`windows_sandbox_unavailable`]: on Windows CEF drops
/// the sandbox itself when the embedder hands it no broker, so the runtime cannot keep a
/// sandbox there however the policy is set.
pub(crate) fn sandbox_decision(
  policy: SandboxPolicy,
  windows_broker_unavailable: bool,
  running_from_appimage: bool,
  sandbox_helper_available: bool,
  apparmor_restrict_unprivileged_userns: Option<u64>,
  max_user_namespaces: Option<u64>,
) -> SandboxDecision {
  if let SandboxPolicy::Disabled = policy {
    return SandboxDecision::Disable(SandboxDisableReason::Policy);
  }

  // CEF flips `no_sandbox` on for us when it gets a null broker, so `Keep` here would be
  // a decision the platform overrules a moment later. Reporting it instead keeps the
  // rule that a lost sandbox is always named out loud.
  if windows_broker_unavailable {
    return match policy {
      SandboxPolicy::Required => {
        SandboxDecision::Refuse(SandboxDisableReason::WindowsBrokerUnavailable)
      }
      _ => SandboxDecision::Disable(SandboxDisableReason::WindowsBrokerUnavailable),
    };
  }

  // GitVolt patch: the namespace sandbox cannot work under the AppArmor restriction, and
  // probing for it can abort the browser, so a usable helper is taken directly. Inside an
  // AppImage the helper Chromium finds is the inert one next to the executable, so the
  // AppImage cases below stay as they were.
  if !running_from_appimage
    && sandbox_helper_available
    && apparmor_restrict_unprivileged_userns == Some(1)
  {
    return SandboxDecision::KeepSetuidOnly;
  }

  match policy {
    SandboxPolicy::Disabled => SandboxDecision::Disable(SandboxDisableReason::Policy),
    SandboxPolicy::Required => SandboxDecision::Keep,
    SandboxPolicy::Auto => {
      // Everything but an AppImage can ship the setuid helper, so a missing sandbox
      // there is a packaging or system problem we should not paper over.
      if !running_from_appimage || sandbox_helper_available {
        return SandboxDecision::Keep;
      }

      if apparmor_restrict_unprivileged_userns == Some(1) {
        SandboxDecision::Disable(SandboxDisableReason::AppImageUserNamespacesRestricted)
      } else if max_user_namespaces == Some(0) {
        SandboxDecision::Disable(SandboxDisableReason::AppImageUserNamespacesUnavailable)
      } else {
        SandboxDecision::Keep
      }
    }
  }
}

/// Whether this process was launched with Chromium's `--no-sandbox` switch.
///
/// A child process inherits the switch from the browser process that spawned it, so this
/// is how a macOS helper learns that entering the sandbox would be wrong. It is read off
/// the real command line rather than off [`SandboxPolicy`] because a helper never sees
/// the `Cef` builder.
#[cfg(target_os = "macos")]
pub(crate) fn launched_without_sandbox() -> bool {
  std::env::args().any(|arg| arg == "--no-sandbox")
}

/// Whether a `chrome-sandbox` candidate passes the checks Chromium's zygote host makes
/// before it will use the helper, given the `st_uid` and `st_mode` a `stat` reported.
///
/// `ZygoteHostImpl::Init` requires the file to be owned by root, to carry the setuid bit
/// and to be executable by others; a file that is there but fails any of those aborts
/// with "The SUID sandbox helper binary was found, but is not configured correctly", so
/// a half-configured helper must not count as available.
#[cfg(any(
  target_os = "linux",
  target_os = "dragonfly",
  target_os = "freebsd",
  target_os = "netbsd",
  target_os = "openbsd"
))]
pub(crate) fn helper_stat_is_usable(uid: u32, mode: u32) -> bool {
  /// `S_ISUID`.
  const SETUID: u32 = 0o4000;
  /// `S_IXOTH`.
  const OTHER_EXECUTE: u32 = 0o0001;

  uid == 0 && mode & SETUID != 0 && mode & OTHER_EXECUTE != 0
}

/// Gathers the inputs [`sandbox_decision`] needs from the environment and the filesystem.
#[cfg(any(
  target_os = "linux",
  target_os = "dragonfly",
  target_os = "freebsd",
  target_os = "netbsd",
  target_os = "openbsd"
))]
pub(crate) fn resolve_sandbox_decision(policy: SandboxPolicy) -> SandboxDecision {
  let running_from_appimage = running_from_appimage();
  sandbox_decision(
    policy,
    windows_sandbox_unavailable(),
    running_from_appimage,
    sandbox_helper_available(running_from_appimage),
    read_sysctl("/proc/sys/kernel/apparmor_restrict_unprivileged_userns"),
    read_sysctl("/proc/sys/user/max_user_namespaces"),
  )
}

/// The policy's own answer, with nothing to probe: neither Windows nor macOS has an
/// equivalent of the AppImage case. macOS therefore keeps the sandbox under
/// [`SandboxPolicy::Auto`]; Windows cannot, for the reason in the module docs.
#[cfg(not(any(
  target_os = "linux",
  target_os = "dragonfly",
  target_os = "freebsd",
  target_os = "netbsd",
  target_os = "openbsd"
)))]
pub(crate) fn resolve_sandbox_decision(policy: SandboxPolicy) -> SandboxDecision {
  sandbox_decision(
    policy,
    windows_sandbox_unavailable(),
    false,
    false,
    None,
    None,
  )
}

/// AppImage runtimes export `APPIMAGE` with the path of the mounted image.
#[cfg(any(
  target_os = "linux",
  target_os = "dragonfly",
  target_os = "freebsd",
  target_os = "netbsd",
  target_os = "openbsd"
))]
fn running_from_appimage() -> bool {
  std::env::var_os("APPIMAGE").is_some_and(|path| !path.is_empty())
}

/// Whether Chromium can find *and use* the setuid `chrome-sandbox` helper.
///
/// GitVolt patch: asks about the helper Chromium itself picks
/// ([`chromium_helper_candidate`]), so a `CHROME_DEVEL_SANDBOX` exported by the user's
/// shell can't hide a good helper next to a packaged executable, or stand in for a bad one.
///
/// The helper next to the executable is disregarded entirely when running from an
/// AppImage: the bundler always copies `chrome-sandbox` there, and the AppImage runtime
/// mounts the payload `nosuid`, so the setuid bit `stat` still reports has no effect.
#[cfg(any(
  target_os = "linux",
  target_os = "dragonfly",
  target_os = "freebsd",
  target_os = "netbsd",
  target_os = "openbsd"
))]
fn sandbox_helper_available(running_from_appimage: bool) -> bool {
  use std::os::unix::fs::MetadataExt;

  let exe = std::env::current_exe().ok();
  let next_to_exe = exe
    .as_deref()
    .and_then(std::path::Path::parent)
    .map(|dir| dir.join("chrome-sandbox"))
    .filter(|helper| helper.exists());
  // SAFETY: `getuid` has no preconditions and cannot fail.
  let uid = unsafe { libc::getuid() };
  let exe_owned_by_current_user = exe
    .and_then(|exe| std::fs::metadata(exe).ok())
    .is_some_and(|metadata| metadata.uid() == uid);

  match chromium_helper_candidate(
    next_to_exe,
    exe_owned_by_current_user,
    std::env::var_os("CHROME_DEVEL_SANDBOX"),
  ) {
    None => false,
    Some(HelperCandidate::NextToExe(_)) if running_from_appimage => false,
    Some(HelperCandidate::NextToExe(helper) | HelperCandidate::Devel(helper)) => {
      helper_path_is_usable(&helper)
    }
  }
}

/// Where the setuid helper Chromium will use was found.
#[cfg(any(
  target_os = "linux",
  target_os = "dragonfly",
  target_os = "freebsd",
  target_os = "netbsd",
  target_os = "openbsd"
))]
#[derive(Debug, Clone, PartialEq, Eq)]
enum HelperCandidate {
  /// `chrome-sandbox` in the executable's directory.
  NextToExe(std::path::PathBuf),
  /// The path in `CHROME_DEVEL_SANDBOX`.
  Devel(std::path::PathBuf),
}

/// GitVolt patch: the helper path Chromium's `SetuidSandboxHost::GetSandboxBinaryPath`
/// settles on. A `chrome-sandbox` that exists next to the executable always wins, usable
/// or not. Only when there is none is `CHROME_DEVEL_SANDBOX` read, and only when the
/// executable belongs to the user running it (a "user-managed build"), so a root-owned
/// packaged install never consults it. An empty value names no helper.
///
/// `next_to_exe` is the candidate next to the executable when it exists. Kept free of I/O
/// so both orders can be unit tested.
#[cfg(any(
  target_os = "linux",
  target_os = "dragonfly",
  target_os = "freebsd",
  target_os = "netbsd",
  target_os = "openbsd"
))]
fn chromium_helper_candidate(
  next_to_exe: Option<std::path::PathBuf>,
  exe_owned_by_current_user: bool,
  devel_sandbox: Option<std::ffi::OsString>,
) -> Option<HelperCandidate> {
  if let Some(helper) = next_to_exe {
    return Some(HelperCandidate::NextToExe(helper));
  }
  if !exe_owned_by_current_user {
    return None;
  }
  devel_sandbox
    .filter(|path| !path.is_empty())
    .map(|path| HelperCandidate::Devel(path.into()))
}

/// Stats `path` and hands what it reports to [`helper_stat_is_usable`].
#[cfg(any(
  target_os = "linux",
  target_os = "dragonfly",
  target_os = "freebsd",
  target_os = "netbsd",
  target_os = "openbsd"
))]
fn helper_path_is_usable(path: &std::path::Path) -> bool {
  use std::os::unix::fs::MetadataExt;

  let Ok(metadata) = std::fs::metadata(path) else {
    return false;
  };

  let usable = helper_stat_is_usable(metadata.uid(), metadata.mode());
  if !usable {
    log::debug!(
      "ignoring the chrome-sandbox helper at {}: it is not a root-owned setuid binary executable by others",
      path.display()
    );
  }
  usable
}

/// Reads a numeric sysctl, returning [`None`] when it is missing or unparseable.
#[cfg(any(
  target_os = "linux",
  target_os = "dragonfly",
  target_os = "freebsd",
  target_os = "netbsd",
  target_os = "openbsd"
))]
fn read_sysctl(path: &str) -> Option<u64> {
  std::fs::read_to_string(path).ok()?.trim().parse().ok()
}

#[cfg(test)]
mod tests {
  use super::*;

  /// Shorthand for the `Auto` policy, which is the only one that inspects the system, on
  /// a platform whose sandbox broker works.
  fn auto(
    running_from_appimage: bool,
    sandbox_helper_available: bool,
    apparmor: Option<u64>,
    max_user_namespaces: Option<u64>,
  ) -> SandboxDecision {
    sandbox_decision(
      SandboxPolicy::Auto,
      false,
      running_from_appimage,
      sandbox_helper_available,
      apparmor,
      max_user_namespaces,
    )
  }

  #[test]
  fn explicit_policies_ignore_the_system() {
    for appimage in [false, true] {
      for helper in [false, true] {
        assert_eq!(
          sandbox_decision(
            SandboxPolicy::Disabled,
            false,
            appimage,
            helper,
            Some(1),
            Some(0)
          ),
          SandboxDecision::Disable(SandboxDisableReason::Policy)
        );
        assert!(
          matches!(
            sandbox_decision(
              SandboxPolicy::Required,
              false,
              appimage,
              helper,
              Some(1),
              Some(0)
            ),
            SandboxDecision::Keep | SandboxDecision::KeepSetuidOnly
          ),
          "Required must keep the sandbox even when Chromium will abort"
        );
      }
    }
  }

  #[test]
  fn a_platform_without_a_broker_never_reports_a_sandbox_it_does_not_have() {
    // CEF sets `no_sandbox` itself when it gets a null broker, so claiming `Keep` here
    // would be a decision the platform overrules a moment later.
    assert_eq!(
      sandbox_decision(SandboxPolicy::Auto, true, false, false, None, None),
      SandboxDecision::Disable(SandboxDisableReason::WindowsBrokerUnavailable)
    );
  }

  #[test]
  fn required_refuses_to_start_where_the_sandbox_cannot_be_provided() {
    // The whole point of `Required` is that running unsandboxed is not an acceptable
    // outcome, so it must fail rather than come up without one.
    assert_eq!(
      sandbox_decision(SandboxPolicy::Required, true, false, false, None, None),
      SandboxDecision::Refuse(SandboxDisableReason::WindowsBrokerUnavailable)
    );
  }

  #[test]
  fn disabled_is_answered_before_the_platform_is_consulted() {
    // An application that asked for no sandbox is told what it asked for, not what the
    // platform could not give it.
    assert_eq!(
      sandbox_decision(SandboxPolicy::Disabled, true, false, false, None, None),
      SandboxDecision::Disable(SandboxDisableReason::Policy)
    );
  }

  #[test]
  fn auto_keeps_the_sandbox_outside_an_appimage() {
    // A deb or rpm install ships the setuid helper, and a system that lost it should
    // fail loudly rather than silently run unsandboxed.
    assert_eq!(auto(false, false, Some(1), Some(0)), SandboxDecision::Keep);
    assert_eq!(auto(false, true, None, None), SandboxDecision::Keep);
  }

  #[test]
  fn a_usable_helper_under_the_apparmor_restriction_skips_the_namespace_probe() {
    // The packaged install on a system without Ubuntu's `unprivileged_userns` profile:
    // the probe would abort on EACCES, so Chromium is sent straight to the helper.
    for policy in [SandboxPolicy::Auto, SandboxPolicy::Required] {
      for max_user_namespaces in [None, Some(0), Some(47801)] {
        assert_eq!(
          sandbox_decision(policy, false, false, true, Some(1), max_user_namespaces),
          SandboxDecision::KeepSetuidOnly,
          "{policy:?}, max_user_namespaces {max_user_namespaces:?}"
        );
      }
    }
  }

  #[test]
  fn without_the_apparmor_restriction_the_namespace_sandbox_is_left_to_chromium() {
    for apparmor in [None, Some(0)] {
      assert_eq!(auto(false, true, apparmor, Some(47801)), SandboxDecision::Keep);
      assert_eq!(
        sandbox_decision(SandboxPolicy::Required, false, false, true, apparmor, Some(47801)),
        SandboxDecision::Keep
      );
    }
  }

  #[test]
  fn the_restriction_without_a_usable_helper_changes_nothing() {
    // Chromium aborts with "No usable sandbox!" without the namespace sandbox or the
    // helper, so the switch is only passed when the helper is there to fall back on.
    assert_eq!(auto(false, false, Some(1), Some(47801)), SandboxDecision::Keep);
    assert_eq!(
      sandbox_decision(SandboxPolicy::Required, false, false, false, Some(1), Some(47801)),
      SandboxDecision::Keep
    );
  }

  #[test]
  fn an_appimage_keeps_its_own_decisions_under_the_restriction() {
    // Tauri's bundler puts an inert helper next to the executable, so a usable one can
    // only come from `CHROME_DEVEL_SANDBOX` in an image without it; the AppImage table is
    // kept as it was either way.
    assert_eq!(auto(true, true, Some(1), Some(47801)), SandboxDecision::Keep);
    assert_eq!(
      auto(true, false, Some(1), Some(47801)),
      SandboxDecision::Disable(SandboxDisableReason::AppImageUserNamespacesRestricted)
    );
  }

  #[test]
  fn disabled_wins_over_the_setuid_only_choice() {
    assert_eq!(
      sandbox_decision(SandboxPolicy::Disabled, false, false, true, Some(1), None),
      SandboxDecision::Disable(SandboxDisableReason::Policy)
    );
  }

  #[test]
  fn auto_keeps_the_sandbox_when_the_helper_is_available() {
    assert_eq!(auto(true, true, Some(1), Some(0)), SandboxDecision::Keep);
  }

  #[test]
  fn auto_keeps_the_sandbox_when_user_namespaces_work() {
    assert_eq!(
      auto(true, false, Some(0), Some(31231)),
      SandboxDecision::Keep
    );
  }

  #[test]
  fn auto_disables_for_an_appimage_restricted_by_apparmor() {
    assert_eq!(
      auto(true, false, Some(1), Some(31231)),
      SandboxDecision::Disable(SandboxDisableReason::AppImageUserNamespacesRestricted)
    );
  }

  #[test]
  fn auto_disables_for_an_appimage_without_user_namespaces() {
    assert_eq!(
      auto(true, false, Some(0), Some(0)),
      SandboxDecision::Disable(SandboxDisableReason::AppImageUserNamespacesUnavailable)
    );
    // The AppArmor sysctl only exists on kernels carrying that patch.
    assert_eq!(
      auto(true, false, None, Some(0)),
      SandboxDecision::Disable(SandboxDisableReason::AppImageUserNamespacesUnavailable)
    );
  }

  #[test]
  fn unreadable_sysctls_are_not_evidence_of_a_restriction() {
    // Nothing readable: assume namespaces work and let Chromium have the last word.
    assert_eq!(auto(true, false, None, None), SandboxDecision::Keep);
  }

  #[test]
  fn apparmor_restriction_is_reported_over_a_missing_namespace_quota() {
    // Both point the same way; the AppArmor one is the actionable message.
    assert_eq!(
      auto(true, false, Some(1), Some(0)),
      SandboxDecision::Disable(SandboxDisableReason::AppImageUserNamespacesRestricted)
    );
  }

  /// The platforms with nothing to probe answer from the policy alone, which is what
  /// [`resolve_sandbox_decision`] passes there. Asserted everywhere so the contract
  /// cannot drift on the platforms that do not compile that arm.
  #[test]
  fn nothing_to_probe_means_the_policy_decides() {
    assert_eq!(
      sandbox_decision(SandboxPolicy::Auto, false, false, false, None, None),
      SandboxDecision::Keep,
      "Auto must keep the sandbox where there is no AppImage case to escape"
    );
    assert_eq!(
      sandbox_decision(SandboxPolicy::Required, false, false, false, None, None),
      SandboxDecision::Keep
    );
    assert_eq!(
      sandbox_decision(SandboxPolicy::Disabled, false, false, false, None, None),
      SandboxDecision::Disable(SandboxDisableReason::Policy),
      "Disabled is the only way for macOS to lose the sandbox"
    );
  }

  /// Without a bootstrap the runtime hands CEF a null Windows sandbox broker, and CEF
  /// answers that by dropping the sandbox itself. Asserted on every platform so the answer
  /// cannot drift away from what `resolve_sandbox_decision` passes. Once the bootstrap's
  /// broker is set (one test, as it is process-wide), the sandbox is available and CEF
  /// gets that pointer.
  #[test]
  fn the_windows_broker_is_reported_as_unavailable_only_on_windows() {
    assert_eq!(windows_sandbox_unavailable(), cfg!(windows));
    assert!(windows_sandbox_info().is_null());
    #[cfg(windows)]
    {
      let mut broker = 0u8;
      // SAFETY: a stand-in pointer, never handed to CEF; reset before the test ends.
      unsafe { set_windows_sandbox_info((&raw mut broker).cast()) };
      assert!(!windows_sandbox_unavailable());
      assert_eq!(windows_sandbox_info(), &raw mut broker);
      unsafe { set_windows_sandbox_info(std::ptr::null_mut()) };
      assert!(windows_sandbox_unavailable());
    }
  }

  #[cfg(any(
    target_os = "linux",
    target_os = "dragonfly",
    target_os = "freebsd",
    target_os = "netbsd",
    target_os = "openbsd"
  ))]
  #[test]
  fn the_helper_next_to_the_executable_wins_over_chrome_devel_sandbox() {
    // A packaged install whose user's shell exports CHROME_DEVEL_SANDBOX: Chromium still
    // uses the helper it ships, so that is the one to stat.
    let packaged = std::path::PathBuf::from("/usr/share/App/chrome-sandbox");
    for owned in [false, true] {
      assert_eq!(
        chromium_helper_candidate(Some(packaged.clone()), owned, Some("/opt/dev/chrome-sandbox".into())),
        Some(HelperCandidate::NextToExe(packaged.clone()))
      );
    }
  }

  #[cfg(any(
    target_os = "linux",
    target_os = "dragonfly",
    target_os = "freebsd",
    target_os = "netbsd",
    target_os = "openbsd"
  ))]
  #[test]
  fn chrome_devel_sandbox_is_read_only_for_a_user_owned_executable_without_a_helper() {
    let devel = || Some(std::ffi::OsString::from("/usr/local/lib/app/chrome-sandbox"));
    // `just run-app`: the build's copy deleted, the binary the developer's own.
    assert_eq!(
      chromium_helper_candidate(None, true, devel()),
      Some(HelperCandidate::Devel("/usr/local/lib/app/chrome-sandbox".into()))
    );
    // A root-owned install never consults the variable.
    assert_eq!(chromium_helper_candidate(None, false, devel()), None);
    assert_eq!(chromium_helper_candidate(None, true, None), None);
    assert_eq!(chromium_helper_candidate(None, true, Some("".into())), None);
  }

  #[cfg(any(
    target_os = "linux",
    target_os = "dragonfly",
    target_os = "freebsd",
    target_os = "netbsd",
    target_os = "openbsd"
  ))]
  #[test]
  fn a_correctly_installed_helper_is_usable() {
    // Mode 4755, which is what the deb and rpm bundlers install.
    assert!(helper_stat_is_usable(0, 0o104755));
  }

  #[cfg(any(
    target_os = "linux",
    target_os = "dragonfly",
    target_os = "freebsd",
    target_os = "netbsd",
    target_os = "openbsd"
  ))]
  #[test]
  fn a_helper_missing_any_of_chromiums_conditions_is_not_usable() {
    // Chromium aborts outright on a helper that fails these, so "present but wrong" has
    // to read as unavailable.
    assert!(
      !helper_stat_is_usable(1000, 0o104755),
      "a helper not owned by root cannot raise privileges"
    );
    assert!(
      !helper_stat_is_usable(0, 0o100755),
      "without the setuid bit the helper runs as the calling user"
    );
    assert!(
      !helper_stat_is_usable(0, 0o104750),
      "the helper has to be executable by others"
    );
    // What `fs::copy` produces in an AppDir: right name, none of the bits.
    assert!(!helper_stat_is_usable(1000, 0o100644));
  }
}
