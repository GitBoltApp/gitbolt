#!/usr/bin/env bash
# Sourced by measure-mem.sh / measure-idle.sh. Prints (one per line) every PID that belongs to
# the running gitbolt (CEF) instance:
#   - the browser process: the gitbolt executable WITHOUT a --type= switch
#     (CEF re-executes the same binary for its helpers, so helpers share its name);
#   - all of its descendants (zygote, renderer, GPU, utility/network/storage, ...);
#   - any process that is NOT a descendant but still carries this instance's
#     --user-data-dir / cache path or runs out of its CEF directory (e.g. a crashpad handler
#     that got reparented), so nothing CEF spawned for this instance is missed.
# Adapted from the CEF spike's proc-tree.sh (spike-cef/proc-tree.sh); only the binary name and
# cache identifier differ (gitbolt / dev.gitbolt.desktop, from crates/gitbolt-app's Cargo.toml
# and tauri.conf.json).
# Role of one PID, from its own --type= and its parent's: processes forked from a zygote keep
# the zygote's command line, so the parent chain is what tells them apart.
gitbolt_role() {
  local p=$1 cmd pcmd exe
  exe=$(readlink "/proc/$p/exe" 2>/dev/null || true)
  cmd=$(tr '\0' ' ' < "/proc/$p/cmdline" 2>/dev/null)
  pcmd=$(tr '\0' ' ' < "/proc/$(awk '{print $4}' "/proc/$p/stat")/cmdline" 2>/dev/null)
  case "$cmd" in
    *chrome-sandbox*) echo "setuid sandbox helper" ;;
    *--type=utility*) echo "utility ($(printf '%s' "$cmd" | grep -o -- '--utility-sub-type=[^ ]*' | cut -d= -f2))" ;;
    *--type=zygote*--no-zygote-sandbox*)
      case "$pcmd" in *--type=zygote*) echo "unsandboxed-zygote child (GPU process)";; *) echo "zygote (unsandboxed)";; esac ;;
    *--type=zygote*)
      case "$pcmd" in
        *chrome-sandbox*) echo "zygote (sandbox init)" ;;
        *--type=zygote*) case "$(tr '\0' ' ' < "/proc/$(awk '{print $4}' "/proc/$(awk '{print $4}' "/proc/$p/stat")/stat")/cmdline" 2>/dev/null)" in
                           *chrome-sandbox*) echo "zygote (sandboxed)";; *) echo "sandboxed-zygote child (renderer or sandboxed utility)";; esac ;;
        *) echo "zygote" ;;
      esac ;;
    *--type=*) printf '%s\n' "$cmd" | grep -o -- '--type=[^ ]*' | head -1 ;;
    *) echo "browser" ;;
  esac
}
#
# GITBOLT_PID=<browser pid> scopes everything to that one instance (e.g. one launched with a
# throwaway XDG_CACHE_HOME while another GitBolt runs): no lookup by name, and a non-descendant
# only counts if it carries that instance's own cache path (its XDG_CACHE_HOME), or runs the
# same executable with the same XDG_CACHE_HOME in its environment.
gitbolt_pids() {
  local main exe cache p xdg
  main=""
  if [ -n "${GITBOLT_PID:-}" ]; then
    [ -d "/proc/$GITBOLT_PID" ] || { echo "GITBOLT_PID=$GITBOLT_PID is not running" >&2; return 1; }
    main=$GITBOLT_PID
    xdg=$(tr '\0' '\n' < "/proc/$main/environ" 2>/dev/null | sed -n 's/^XDG_CACHE_HOME=//p')
    cache="${xdg:-$HOME/.cache}/dev.gitbolt.desktop"
  else
    for p in $(pgrep -x 'gitbolt'); do
      if ! tr '\0' ' ' < "/proc/$p/cmdline" 2>/dev/null | grep -q -- '--type='; then main=$p; break; fi
    done
    cache="dev.gitbolt.desktop"
  fi
  [ -n "$main" ] || { echo "no gitbolt browser process found" >&2; return 1; }
  exe=$(readlink "/proc/$main/exe")
  desc() { local c; for c in $(pgrep -P "$1"); do echo "$c"; desc "$c"; done; }
  {
    echo "$main"
    desc "$main"
    for p in $(pgrep -u "$(id -u)" .); do
      [ "$p" = "$$" ] && continue
      if tr '\0' ' ' < "/proc/$p/cmdline" 2>/dev/null | grep -qF -- "$cache"; then echo "$p"; fi
      if [ "$(readlink "/proc/$p/exe" 2>/dev/null)" = "$exe" ]; then
        if [ -z "${GITBOLT_PID:-}" ] || tr '\0' '\n' < "/proc/$p/environ" 2>/dev/null | grep -qxF "XDG_CACHE_HOME=$xdg"; then echo "$p"; fi
      fi
    done
  } | awk '!seen[$0]++'
}
