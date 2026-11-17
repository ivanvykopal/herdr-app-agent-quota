# Installs the Command Code -> Herdr status hook (Windows): copies herdr-commandcode-state.ps1 to
# ~/.commandcode/hooks/ and adds its hooks to ~/.commandcode/settings.json, keeping everything else there.
# Running it again replaces the earlier entries. Takes effect for Command Code sessions started afterwards.
$ErrorActionPreference = "Stop"

$dir = Join-Path $env:USERPROFILE ".commandcode"
$hookDir = Join-Path $dir "hooks"
$script = Join-Path $hookDir "herdr-commandcode-state.ps1"
$settingsPath = Join-Path $dir "settings.json"

New-Item -ItemType Directory -Force $hookDir | Out-Null
Copy-Item (Join-Path $PSScriptRoot "herdr-commandcode-state.ps1") $script -Force

$settings = [pscustomobject]@{}
if (Test-Path -LiteralPath $settingsPath) {
    $raw = Get-Content -LiteralPath $settingsPath -Raw
    if (-not [string]::IsNullOrWhiteSpace($raw)) { $settings = $raw | ConvertFrom-Json }
    Copy-Item -LiteralPath $settingsPath "$settingsPath.bak" -Force
}
if (-not $settings.PSObject.Properties["hooks"]) {
    $settings | Add-Member -NotePropertyName hooks -NotePropertyValue ([pscustomobject]@{})
}

# SessionStart starts the session's watcher (PowerShell, once). The frequent events only write the new state
# for the watcher, in cmd (Command Code's hook shell on Windows): no PowerShell start per tool call. `if exist`
# keeps a terminal without a watcher (not a herdr-core terminal, or a headless run) from getting files.
# Async: Command Code never waits for them.
$state = '"%TEMP%\herdr-commandcode-%HC_TERMINAL_ID%'
$write = { param($s) "if exist $state.watch`" (echo $s)>$state.state`"" }
$commands = [ordered]@{
    SessionStart = "powershell -NoProfile -ExecutionPolicy Bypass -File `"$script`" session"
    PreToolUse   = & $write "working"
    PostToolUse  = & $write "working"
    Stop         = & $write "idle"
}
foreach ($name in $commands.Keys) {
    $groups = @()
    if ($settings.hooks.PSObject.Properties[$name]) {
        # Drop this integration's earlier entries (all name `herdr-commandcode-`), keep the person's own.
        $groups = @($settings.hooks.$name | Where-Object { -not (@($_.hooks) | Where-Object { "$($_.command)" -match "herdr-commandcode-" }) })
    }
    $groups += [pscustomobject]@{ hooks = @([pscustomobject]@{ type = "command"; command = $commands[$name]; timeout = 30; async = $true }) }
    $settings.hooks | Add-Member -NotePropertyName $name -NotePropertyValue $groups -Force
}

$json = $settings | ConvertTo-Json -Depth 20
[IO.File]::WriteAllText($settingsPath, $json, (New-Object System.Text.UTF8Encoding $false))
Write-Host "Command Code hooks installed: $settingsPath (restart running commandcode sessions)"
