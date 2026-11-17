# Command Code hook: reports the agent's status to Herdr (OSC 7501), so a `commandcode` session shows
# up in the Agents list. Installed by integrations/commandcode/install.ps1 into ~/.commandcode/hooks/.
#
# Usage (from ~/.commandcode/settings.json): powershell -NoProfile -ExecutionPolicy Bypass -File <this> <event>
#   session  SessionStart              -> idle, and a hidden watcher that clears the status when Command Code exits
#   working  PreToolUse / PostToolUse  -> working
#   idle     Stop                      -> idle (herdr-core makes it done if you weren't looking)
#
# Command Code runs hooks with piped stdio and windowsHide, so the hook has its own hidden console and
# its output never reaches the terminal. The hook therefore attaches to the console of the Command Code
# process (the nearest node.exe ancestor) and writes the OSC sequence there.

param([string]$Event = "", [int]$WatchPid = 0)

if ([string]::IsNullOrWhiteSpace($env:HC_TERMINAL_ID)) { exit 0 } # not in a herdr-core terminal

Add-Type -Namespace HerdrCommandCode -Name Console -MemberDefinition @'
[DllImport("kernel32.dll")] public static extern bool FreeConsole();
[DllImport("kernel32.dll")] public static extern bool AttachConsole(int pid);
[DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr sa, uint disposition, uint flags, IntPtr template);
[DllImport("kernel32.dll")] public static extern bool WriteFile(IntPtr h, byte[] buffer, int count, out int written, IntPtr overlapped);
[DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
'@

function Attach([int]$ProcessId) {
    [HerdrCommandCode.Console]::FreeConsole() | Out-Null
    return [HerdrCommandCode.Console]::AttachConsole($ProcessId)
}

# Writes to the attached console's screen: herdr-core reads the OSC from the terminal output.
function Report([string]$Record) {
    $h = [HerdrCommandCode.Console]::CreateFileW('CONOUT$', 0x40000000, 2, [IntPtr]::Zero, 3, 0, [IntPtr]::Zero)
    if ($h -eq [IntPtr]::Zero -or $h -eq [IntPtr]-1) { return }
    $bytes = [Text.Encoding]::UTF8.GetBytes("$([char]27)]7501;$Record$([char]27)\")
    $written = 0
    [HerdrCommandCode.Console]::WriteFile($h, $bytes, $bytes.Length, [ref]$written, [IntPtr]::Zero) | Out-Null
    [HerdrCommandCode.Console]::CloseHandle($h) | Out-Null
}

# The watcher: holds Command Code's console, and when Command Code exits, clears the status so the
# shell left in the terminal is no longer listed as an agent.
if ($Event -eq "watch") {
    if (-not (Attach $WatchPid)) { exit 0 }
    Wait-Process -Id $WatchPid -ErrorAction SilentlyContinue
    Report "state=clear"
    Remove-Item -LiteralPath (Join-Path $env:TEMP "herdr-commandcode-$WatchPid.last") -ErrorAction SilentlyContinue
    exit 0
}

$state = @{ session = "idle"; working = "working"; idle = "idle" }[$Event]
if (-not $state) { exit 0 }

# When this event happened: hooks run async and take about a second each, so they can finish out of
# order, and only the newest one reports (a Stop's idle must not be overwritten by an earlier working).
$stamp = [DateTime]::UtcNow.Ticks

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

$stampFile = Join-Path $env:TEMP "herdr-commandcode-$target.last"
try { if ([long][IO.File]::ReadAllText($stampFile) -gt $stamp) { exit 0 } } catch { }
[IO.File]::WriteAllText($stampFile, [string]$stamp)

if ($Event -eq "session") {
    Start-Process powershell -WindowStyle Hidden -ArgumentList @(
        "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$PSCommandPath`"", "watch", "$target")
}

if (-not (Attach $target)) { exit 0 }
try { if ([IO.File]::ReadAllText($stampFile) -ne $stamp) { exit 0 } } catch { }
# app: Herdr's program key for Command Code (its icon; the mod maps it to the Command Code quota).
Report "state=$($state):app=command-code"
