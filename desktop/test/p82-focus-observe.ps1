param(
  [Parameter(Mandatory = $true)][long]$WindowHandle,
  [Parameter(Mandatory = $true)][int]$ExpectedProcessId
)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class P82FocusProbe {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
}
'@
$expectedHandle = [IntPtr]$WindowHandle
[uint32]$owner = 0
[void][P82FocusProbe]::GetWindowThreadProcessId($expectedHandle, [ref]$owner)
if ($owner -ne $ExpectedProcessId) { throw 'Focus probe does not belong to this Electron runtime.' }
$baseline = [P82FocusProbe]::GetForegroundWindow()
if ($baseline -eq [IntPtr]::Zero -or $baseline -eq $expectedHandle) { throw 'No independent foreground baseline; no focus was changed.' }
[uint32]$foregroundOwner = 0
[void][P82FocusProbe]::GetWindowThreadProcessId($baseline, [ref]$foregroundOwner)
$samples = @()
for ($index = 0; $index -lt 4; $index++) {
  $actual = [P82FocusProbe]::GetForegroundWindow()
  $samples += @{ at = [DateTime]::UtcNow.ToString('o'); foreground = $actual.ToInt64().ToString(); expected = ($actual -eq $baseline) }
  if ($index -lt 3) { Start-Sleep -Milliseconds 750 }
}
$stable = @($samples | Where-Object { -not $_.expected }).Count -eq 0
@{ source = 'Win32 GetForegroundWindow'; processId = $ExpectedProcessId; baselineIsOtherProcess = ($foregroundOwner -ne $ExpectedProcessId); stable = $stable; samples = $samples } | ConvertTo-Json -Depth 4 -Compress
if (-not $stable) { exit 1 }
