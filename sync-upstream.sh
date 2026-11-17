#!/bin/sh
# Brings a newer shipped `agents` mod into this one. main.js is upstream's file plus a few hooks into this
# mod's own modules, so a three-way merge carries the hooks over: this mod's main.js, the version it was
# forked from (upstream/agents/), and the `agents` mod the installed app ships now.
#
# Needs the Herdr app running (`herdr-app do mod.clone`) and git (`git merge-file`); on Windows run it from
# Git Bash. UPSTREAM_DIR=<folder with main.js and mod.json> merges that copy instead of cloning.
# Exit 0: merged cleanly or nothing to do; 1: conflicts left in mods/agents-quota/main.js; 2: error.
set -eu
cd "$(dirname "$0")"
mod=mods/agents-quota
base=upstream/agents
new=$(mktemp -d)
trap 'rm -rf "$new"' EXIT

if [ -n "${UPSTREAM_DIR:-}" ]; then
  cp "$UPSTREAM_DIR/main.js" "$UPSTREAM_DIR/mod.json" "$new/"
else
  apphome=${HERDR_APP_HOME:-$HOME/.config/herdr-app}
  tmp=agents-quota-upstream-sync
  rm -rf "$apphome/mods/$tmp"
  herdr-app do mod.clone "{\"name\":\"agents\",\"as\":\"$tmp\"}" >/dev/null || { echo "mod.clone failed: is the Herdr app running?" >&2; exit 2; }
  cp "$apphome/mods/$tmp/main.js" "$apphome/mods/$tmp/mod.json" "$new/"
  extra=$(ls "$apphome/mods/$tmp" | grep -v -x -e main.js -e mod.json -e gpui-kit.d.ts -e jsconfig.json || true)
  rm -rf "$apphome/mods/$tmp"
  [ -z "$extra" ] || echo "Upstream now also ships: $extra (not merged; compare by hand)." >&2
  # mod.clone writes the clone's own name where the mod opens itself (its sort menu); this one is agents-quota.
  sed "s/\"$tmp\"/\"agents-quota\"/g" "$new/main.js" > "$new/main.js.sed" && mv "$new/main.js.sed" "$new/main.js"
fi

# The repo keeps LF (.gitattributes), but a clone on Windows and an older checkout can be CRLF: with mixed
# endings every line differs and the merge is one whole-file conflict. Compare and merge LF only.
for f in "$new/main.js" "$base/main.js" "$mod/main.js"; do
  tr -d '\r' < "$f" > "$new/lf" && cat "$new/lf" > "$f"
done

version() { sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$1" | head -n 1; }
old_v=$(version "$base/mod.json")
new_v=$(version "$new/mod.json")
if cmp -s "$base/main.js" "$new/main.js"; then
  echo "agents $new_v: main.js unchanged since $old_v, nothing to merge."
  exit 0
fi

status=0
git merge-file -L agents-quota -L "agents $old_v" -L "agents $new_v" "$mod/main.js" "$base/main.js" "$new/main.js" || status=$?
if [ "$status" -gt 127 ]; then echo "git merge-file failed ($status); nothing changed." >&2; exit 2; fi

# The new upstream is the base of the next merge; mod.json records which version this mod is built on.
cp "$new/main.js" "$new/mod.json" "$base/"
sed "s/\(\"version\": *\"\)[^\"]*\"/\1$new_v\"/" "$mod/mod.json" > "$new/mod.json.sed" && cp "$new/mod.json.sed" "$mod/mod.json"

if [ "$status" -eq 0 ]; then
  echo "Merged agents $old_v -> $new_v into $mod/main.js. Review with 'git diff', then run ./install.sh."
else
  echo "Merged agents $old_v -> $new_v with $status conflict(s) in $mod/main.js: resolve the <<<<<<< blocks, then run ./install.sh." >&2
  exit 1
fi
