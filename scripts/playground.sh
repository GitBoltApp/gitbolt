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
fixtures=(basic sync conflicts stack wip_staging)

if [ -e "$dir" ] && [ -n "$(ls -A "$dir")" ] && [ ! -f "$dir/.gitbolt-playground" ]; then
  echo "$dir isn't empty and isn't a playground (no .gitbolt-playground marker); leaving it alone" >&2
  exit 1
fi
mkdir -p "$dir"
for f in "${fixtures[@]}"; do rm -rf "${dir:?}/$f"; done
rm -rf "${dir:?}/.remotes" "${dir:?}/.worktrees" "${dir:?}/.staging"
mkdir -p "$dir/.remotes" "$dir/.worktrees" "$dir/.staging"
touch "$dir/.gitbolt-playground"

for f in "${fixtures[@]}"; do
  stage="$dir/.staging/$f"
  "$harness" fixture "$f" "$stage" > /dev/null
  # Where each piece of the fixture goes; remote URLs and worktree links are rewritten to match.
  declare -A to=()
  for entry in "$stage"/*; do
    name=$(basename "$entry")
    case "$name" in
      repo) to[$name]="$dir/$f" ;;
      *.git) to[$name]="$dir/.remotes/$f-${name%.git}.git" ;;
      wt-*) to[$name]="$dir/.worktrees/$f-${name#wt-}" ;;
      *) to[$name]="$dir/.remotes/$f-$name" ;;
    esac
  done
  for name in "${!to[@]}"; do mv "$stage/$name" "${to[$name]}"; done
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
  rm -rf "$stage"
done
rmdir "$dir/.staging"
echo "playground ready in $dir: ${fixtures[*]}"
