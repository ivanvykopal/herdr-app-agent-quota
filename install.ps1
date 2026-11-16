# Copies the mod into the Herdr desktop app's mods folder (hot-reloads in the running app).
$ErrorActionPreference = "Stop"
$home_ = if ($env:HERDR_APP_HOME) { $env:HERDR_APP_HOME } else { Join-Path $env:USERPROFILE ".config\herdr-app" }
$dest = Join-Path $home_ "mods\agents-quota"
New-Item -ItemType Directory -Force $dest | Out-Null
Copy-Item (Join-Path $PSScriptRoot "mods\agents-quota\*") $dest -Force
Write-Host "Installed to $dest"
herdr-app check $dest
