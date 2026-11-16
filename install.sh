#!/bin/sh
# Copies the mod into the Herdr desktop app's mods folder (hot-reloads in the running app).
set -eu
home="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
dest="$home/mods/agents-quota"
mkdir -p "$dest"
cp "$(dirname "$0")"/mods/agents-quota/* "$dest"/
echo "Installed to $dest"
herdr-app check "$dest"
