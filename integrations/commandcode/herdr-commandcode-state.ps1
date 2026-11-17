# Command Code -> Herdr status (OSC 7501), so a `commandcode` session shows up in the Agents list.
# Installed by integrations/commandcode/install.ps1 into ~/.commandcode/hooks/.
#
# Command Code runs hooks with piped stdio and windowsHide, so a hook has its own hidden console and its
# output never reaches the terminal. One watcher per session therefore attaches to the console of the
# Command Code process and writes the OSC sequences there. Hooks only tell it the new state:
#
#   SessionStart  powershell -File <this> session   finds Command Code (the nearest node.exe above it),
#                                                   skips headless runs, starts the watcher (once, ~0.7 s)
#   PreToolUse, PostToolUse, Stop                   a one-line cmd command (~50 ms, no PowerShell) that
#                                                   writes `working` / `idle` to the state file, but only
#                                                   while this terminal has a watcher (its .watch file)
#
# Files, in %TEMP%, per herdr-core terminal (HC_TERMINAL_ID):
#   herdr-commandcode-<terminal>.watch  the watcher's Command Code pid; exists while it runs
#   herdr-commandcode-<terminal>.state  the latest state a hook wrote
# The watcher reports idle at start, each state change within ~50 ms, and `state=clear` when Command
# Code exits (so the shell left in the terminal is no longer an agent), then removes both files.

param([string]$Event = "", [int]$WatchPid = 0, [string]$Terminal = "")

if (-not $Terminal) { $Terminal = $env:HC_TERMINAL_ID }
if ([string]::IsNullOrWhiteSpace($Terminal)) { exit 0 } # not in a herdr-core terminal

if ($Event -eq "session") {
    # The Command Code process: the nearest node.exe above this hook (the hook runs under cmd.exe).
    $procs = @{}
    foreach ($p in Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, Name, CommandLine) { $procs[[int]$p.ProcessId] = $p }
    $target = 0
    $at = $procs[$PID]
    for ($i = 0; $at -and $i -lt 10; $i++) {
        $at = $procs[[int]$at.ParentProcessId]
        if ($at -and $at.Name -eq "node.exe") { $target = [int]$at.ProcessId; break }
    }
    if (-not $target) { exit 0 }
    # A headless run (`-p` / `--print`, e.g. started by another agent in its own terminal) is not the
    # terminal's agent: reporting it would overwrite that agent's status.
    if (@("$($procs[$target].CommandLine)" -split '\s+' | Where-Object { $_ -in @("-p", "--print") }).Count) { exit 0 }
    Start-Process powershell -WindowStyle Hidden -ArgumentList @(
        "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$PSCommandPath`"", "watch", "$target", "$Terminal")
    exit 0
}

if ($Event -ne "watch") { exit 0 }

Add-Type -Namespace HerdrCommandCode -Name Console -MemberDefinition @'
[DllImport("kernel32.dll")] public static extern bool FreeConsole();
[DllImport("kernel32.dll")] public static extern bool AttachConsole(int pid);
[DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr sa, uint disposition, uint flags, IntPtr template);
[DllImport("kernel32.dll")] public static extern bool WriteFile(IntPtr h, byte[] buffer, int count, out int written, IntPtr overlapped);
[DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
'@

# Writes to the attached console's screen: herdr-core reads the OSC from the terminal output.
function Report([string]$Record) {
    $h = [HerdrCommandCode.Console]::CreateFileW('CONOUT$', 0x40000000, 2, [IntPtr]::Zero, 3, 0, [IntPtr]::Zero)
    if ($h -eq [IntPtr]::Zero -or $h -eq [IntPtr]-1) { return }
    $bytes = [Text.Encoding]::UTF8.GetBytes("$([char]27)]7501;$Record$([char]27)\")
    $written = 0
    [HerdrCommandCode.Console]::WriteFile($h, $bytes, $bytes.Length, [ref]$written, [IntPtr]::Zero) | Out-Null
    [HerdrCommandCode.Console]::CloseHandle($h) | Out-Null
}

$proc = Get-Process -Id $WatchPid -ErrorAction SilentlyContinue
if (-not $proc) { exit 0 }
[HerdrCommandCode.Console]::FreeConsole() | Out-Null
if (-not [HerdrCommandCode.Console]::AttachConsole($WatchPid)) { exit 0 }

$name = "herdr-commandcode-$Terminal"
$watchFile = Join-Path $env:TEMP "$name.watch"
$stateFile = Join-Path $env:TEMP "$name.state"
[IO.File]::WriteAllText($stateFile, "idle")
[IO.File]::WriteAllText($watchFile, "$WatchPid")

# app: Herdr's program key for Command Code (its icon; the mod maps it to the Command Code quota).
$last = "idle"
Report "state=idle:app=command-code"

$fsw = New-Object IO.FileSystemWatcher $env:TEMP, "$name.state"
$fsw.NotifyFilter = [IO.NotifyFilters]'LastWrite, FileName, Size'
while (-not $proc.HasExited) {
    # Wakes on a write, else every 500 ms (a missed event is caught by reading the file anyway).
    $fsw.WaitForChanged([IO.WatcherChangeTypes]'Created, Changed', 500) | Out-Null
    $state = $null
    for ($try = 0; $try -lt 3 -and $null -eq $state; $try++) {
        try { $state = [IO.File]::ReadAllText($stateFile).Trim() } catch { Start-Sleep -Milliseconds 20 }
    }
    if ($state -in @("working", "idle") -and $state -ne $last) {
        Report "state=$($state):app=command-code"
        $last = $state
    }
}

Report "state=clear"
# A new session in this terminal may already have its own watcher: only remove files that are still ours.
try {
    if ([IO.File]::ReadAllText($watchFile).Trim() -eq "$WatchPid") {
        Remove-Item -LiteralPath $watchFile, $stateFile -ErrorAction SilentlyContinue
    }
} catch { }
