param(
  [Parameter(Mandatory = $true)][int]$ExpectedProcessId,
  [Parameter(Mandatory = $true)][string]$WindowsJson
)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class WeiBiYeNativeObservation {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr handle, out RECT rect);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr handle, out uint process);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr handle);
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
}
'@
$previousDpi = [WeiBiYeNativeObservation]::SetThreadDpiAwarenessContext([IntPtr](-4))
try {
  $windows = ConvertFrom-Json -InputObject $WindowsJson
  if ($windows.Count -lt 1 -or $windows.Count -gt 4) { throw 'Only the explicitly authorized application windows may be measured.' }
  $observed = @()
  foreach ($window in $windows) {
    $handle = [IntPtr]([long]$window.handle)
    [uint32]$ownerProcess = 0
    [void][WeiBiYeNativeObservation]::GetWindowThreadProcessId($handle, [ref]$ownerProcess)
    if ($ownerProcess -ne $ExpectedProcessId) { throw 'Window does not belong to the authorized Electron instance.' }
    $rect = New-Object WeiBiYeNativeObservation+RECT
    if (-not [WeiBiYeNativeObservation]::IsWindowVisible($handle) -or -not [WeiBiYeNativeObservation]::GetWindowRect($handle, [ref]$rect)) { throw 'Expected a visible native pet window.' }
    $observed += @{ petId = $window.petId; handle = $window.handle; processId = $ownerProcess;
      boundsPhysical = @{ x = $rect.Left; y = $rect.Top; width = $rect.Right - $rect.Left; height = $rect.Bottom - $rect.Top } }
  }
  @{ source = 'Win32 GetWindowRect with per-monitor-aware physical coordinates'; observedAt = [DateTime]::UtcNow.ToString('o'); windows = $observed } | ConvertTo-Json -Depth 5 -Compress
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
} finally { [void][WeiBiYeNativeObservation]::SetThreadDpiAwarenessContext($previousDpi) }
