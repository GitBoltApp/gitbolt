#!/usr/bin/env bash
# Build (or reset) the try-out playground: one folder whose direct children are the repos, so
# "Add a folder" in GitBolt lists them all. Their local bare remotes and helper clones live in
# .remotes/ and linked worktrees in .worktrees/ (hidden folders, which the folder scan skips).
#
#   scripts/playground.sh HARNESS DIR
#
# Resetting deletes only what this script made: DIR must be empty, missing, or carry the
# .gitbolt-playground marker.
set -euo pipefail
harness=$1
dir=${2/#\~/$HOME}
fixtures=(orbital basic sync conflicts stack wip_staging rebase_lab previews submodules lfs)
# A fixture's folder name: rebase_lab is the playground's rebase-lab.
folder() { case "$1" in rebase_lab) echo rebase-lab ;; *) echo "$1" ;; esac; }

if [ -e "$dir" ] && [ -n "$(ls -A "$dir")" ] && [ ! -f "$dir/.gitbolt-playground" ]; then
  echo "$dir isn't empty and isn't a playground (no .gitbolt-playground marker); leaving it alone" >&2
  exit 1
fi
mkdir -p "$dir"
for f in "${fixtures[@]}"; do rm -rf "${dir:?}/$(folder "$f")"; done
rm -rf "${dir:?}/.remotes" "${dir:?}/.worktrees" "${dir:?}/.staging"
mkdir -p "$dir/.remotes" "$dir/.worktrees" "$dir/.staging"
touch "$dir/.gitbolt-playground"

for f in "${fixtures[@]}"; do
  n=$(folder "$f")
  stage="$dir/.staging/$f"
  # The submodules' sources are built where they stay, in .remotes/, and only the repository moves;
  # .gitmodules has relative URLs, so each is pinned to its source after the move (below).
  [ "$f" = submodules ] && stage="$dir/.remotes/$n"
  "$harness" showcase "$f" "$stage" > /dev/null
  # Orbital's origin borrows the repository's objects (objects/info/alternates, a relative
  # path); the move below would break that, so it gets its own copy first.
  for entry in "$stage"/*.git; do
    [ -f "$entry/objects/info/alternates" ] || continue
    git -C "$entry" repack -a -d -q
    rm "$entry/objects/info/alternates"
  done
  # Where each piece of the fixture goes; remote URLs and worktree links are rewritten to match.
  declare -A to=()
  for entry in "$stage"/*; do
    name=$(basename "$entry")
    if [ "$f" = submodules ] && [ "$name" != repo ]; then to[$name]="$stage/$name"; continue; fi
    case "$name" in
      repo) to[$name]="$dir/$n" ;;
      *.git) to[$name]="$dir/.remotes/$n-${name%.git}.git" ;;
      wt-*) to[$name]="$dir/.worktrees/$n-${name#wt-}" ;;
      *) to[$name]="$dir/.remotes/$n-$name" ;;
    esac
  done
  for name in "${!to[@]}"; do [ "$stage/$name" = "${to[$name]}" ] || mv "$stage/$name" "${to[$name]}"; done
  # Remote URLs point at the staging paths: map each onto where that piece now lives.
  for name in "${!to[@]}"; do
    target=${to[$name]}
    [ -d "$target/.git" ] || [ -f "$target/HEAD" ] || continue
    # Your global signing (commit.gpgsign, tag.forceSignAnnotated) would need a pinentry for every
    # throwaway commit: the playground signs nothing.
    git -C "$target" config commit.gpgsign false
    git -C "$target" config tag.gpgSign false
    git -C "$target" config tag.forceSignAnnotated false
    # Its own identity too: nothing in the playground leans on your global config.
    git -C "$target" config user.name "Playground User"
    git -C "$target" config user.email "playground@example.invalid"
    for remote in $(git -C "$target" remote 2>/dev/null); do
      url=$(git -C "$target" remote get-url "$remote")
      case "$url" in "$stage"/*)
        rest=${url#"$stage"/}; first=${rest%%/*}
        [ -n "${to[$first]:-}" ] && git -C "$target" remote set-url "$remote" "${to[$first]}${rest#"$first"}"
      ;; esac
    done
  done
  # Linked worktrees moved with their folder: point both sides at the new places.
  if [ -n "${to[repo]:-}" ]; then
    for name in "${!to[@]}"; do
      case "$name" in wt-*) git -C "${to[repo]}" worktree repair "${to[$name]}" 2>/dev/null ;; esac
    done
  fi
  unset to
  if [ "$f" = submodules ]; then
    # Relative URLs (../netcode-src) would resolve against the moved repository's origin; submodule
    # init keeps a URL that's already set, so point each at where its source stayed.
    for key in $(git -C "$dir/$n" config -f .gitmodules --name-only --get-regexp '^submodule\..*\.url$'); do
      url=$(git -C "$dir/$n" config -f .gitmodules "$key")
      case "$url" in ../*) git -C "$dir/$n" config "$key" "$dir/.remotes/$n/${url#../}" ;; esac
    done
  fi
  [ "$f" = submodules ] || rm -rf "$stage"
done
rmdir "$dir/.staging"
cat > "$dir/README.md" <<'EOF'
# GitBolt playground

Add this folder in GitBolt ("Add a folder") to list every repo. What to try in each:

- **orbital**: a 2D space-trading game in Rust, two years and over a thousand commits by six people. Scroll the graph; open any commit; every preview type is in its history (sprites, the HUD font, sounds, the design PDF, the press kit, tables, the save file). `balance/fuel-rework` conflicts with main (text, table, image); `feature/hud-polish` is set up for an interactive rebase onto main; `feature/autopilot` is ahead of origin, `feature/station-ui` behind, `feature/trade-routes` diverged; two stashes; main has staged and unstaged changes. `git -C .remotes/orbital-origin.git update-ref refs/heads/main refs/demo/teammate` plays the teammate's push, then Fetch.
- **basic**: the game's website: a small history with a merged branch, a tag, a stash and a dirty linked worktree.
- **sync**: the modding kit: a remote that moved. Fetch, pull, push; `main` is behind, `feature/lua-hooks` has diverged, `feature/mod-manifest` has no upstream.
- **conflicts**: merge `feature/price-rework` into `main` for text, binary and delete/modify conflicts, then resolve them.
- **stack**: `feature/cargo-model` > `cargo-ui` > `cargo-tests` stacked on a moved `main`. Rebase a branch and watch the stack follow; multi-select commits and use Squash.
- **wip_staging**: uncommitted changes to a ship. Stage and unstage files and hunks, then commit.
- **rebase-lab**: `feature/docking` has six commits. Right-click `main`'s chip > "Interactive rebase feature/docking onto main": "Slow the approach to 1.5 m/s" shows a conflict warning. Drag "Reword the alignment check" above "Note the clamp's alignment check" and the warning appears on it; drag it back and it clears.
- **previews**: open "Refresh the press kit for 1.1" and pick a file: images (PNG, GIF, ICO, SVG), audio, video, a font, a PDF, HTML, CSV/TSV, Markdown and a save file in hex, each previewed and diffed.
- **submodules**: `libs/netcode` is checked out past its recorded commit with an edit; `libs/shaders` isn't initialised. The palette (Ctrl+P) has the Submodules actions; initialising one from a local folder needs `git config --global protocol.file.allow always` (git refuses local submodule clones by default).
- **lfs**: the title art through Git LFS. Its two versions diff as images; `art/ships.psd` was never downloaded (Download needs git-lfs).

EOF
echo "playground ready in $dir: $(for f in "${fixtures[@]}"; do folder "$f"; done | tr '\n' ' ')"
