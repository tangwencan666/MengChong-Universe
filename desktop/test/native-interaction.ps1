param(
  [Parameter(Mandatory = $true)][long]$WindowHandle,
  [Parameter(Mandatory = $true)][int]$ExpectedProcessId,
  [Parameter(Mandatory = $true)][ValidateSet('inspect', 'click', 'drag', 'context')][string]$Action,
  [int]$OffsetX = 94,
  [int]$OffsetY = 100,
  [int]$DeltaX = 0,
  [int]$DeltaY = 0,
  [ValidateRange(100, 2000)][int]$HitTestTimeoutMs = 100
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class WeiBiYeNativeInput {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr handle, out RECT rect);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr handle, out uint process);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr handle);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT point);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr handle, uint flags);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT point);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint x, uint y, uint data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll", EntryPoint="GetWindowLongPtrW")] public static extern IntPtr GetWindowLongPtr(IntPtr handle, int index);
}
'@
function Get-CheckedRect([IntPtr]$Handle) {
  [uint32]$ownerProcess = 0
  [void][WeiBiYeNativeInput]::GetWindowThreadProcessId($Handle, [ref]$ownerProcess)
  if ($ownerProcess -ne $ExpectedProcessId) { throw 'Window does not belong to the explicitly authorized Electron instance.' }
  if (-not [WeiBiYeNativeInput]::IsWindowVisible($Handle)) { throw 'Target pet window is not visible.' }
  $rect = New-Object WeiBiYeNativeInput+RECT
  if (-not [WeiBiYeNativeInput]::GetWindowRect($Handle, [ref]$rect)) { throw 'Cannot inspect target window bounds.' }
  return $rect
}
function Convert-Rect($Rect) { return @{ x = $Rect.Left; y = $Rect.Top; width = $Rect.Right - $Rect.Left; height = $Rect.Bottom - $Rect.Top } }
$previousDpi = [WeiBiYeNativeInput]::SetThreadDpiAwarenessContext([IntPtr](-4))
$previousCursor = New-Object WeiBiYeNativeInput+POINT
[void][WeiBiYeNativeInput]::GetCursorPos([ref]$previousCursor)
$pressed = $false
$buttonUp = [uint32]4
try {
  $handle = [IntPtr]$WindowHandle
  $before = Get-CheckedRect $handle
  if ($Action -eq 'inspect') {
    $style = [WeiBiYeNativeInput]::GetWindowLongPtr($handle, -16).ToInt64()
    $extendedStyle = [WeiBiYeNativeInput]::GetWindowLongPtr($handle, -20).ToInt64()
    @{ action = $Action; processId = $ExpectedProcessId; windowHandle = "$WindowHandle"; bounds = (Convert-Rect $before); visible = $true; style = $style; extendedStyle = $extendedStyle; caption = (($style -band 0x00C00000) -ne 0); toolWindow = (($extendedStyle -band 0x80) -ne 0); topmost = (($extendedStyle -band 8) -ne 0); layered = (($extendedStyle -band 0x80000) -ne 0) } | ConvertTo-Json -Depth 4 -Compress
    exit 0
  }
  $point = New-Object WeiBiYeNativeInput+POINT
  $point.X = $before.Left + $OffsetX
  $point.Y = $before.Top + $OffsetY
  if ($point.X -le $before.Left -or $point.X -ge $before.Right -or $point.Y -le $before.Top -or $point.Y -ge $before.Bottom) { throw 'Input point must be inside the authorized pet window.' }
  # The host intentionally ignores empty space until the cursor enters the pet.
  # Positioning the cursor sends no click; allow the bounded host hit-test timer
  # to enable the pet, then verify ownership before sending any button event.
  [void][WeiBiYeNativeInput]::SetCursorPos($point.X, $point.Y)
  $hitTestStarted = [System.Diagnostics.Stopwatch]::StartNew()
  do {
    Start-Sleep -Milliseconds 50
    $hit = [WeiBiYeNativeInput]::GetAncestor([WeiBiYeNativeInput]::WindowFromPoint($point), 2)
  } while (($hit -ne $handle -or $hitTestStarted.ElapsedMilliseconds -lt 100) -and $hitTestStarted.ElapsedMilliseconds -lt $HitTestTimeoutMs)
  if ($hit -ne $handle) { throw 'Another window covers the authorized pet. No mouse input was sent.' }
  [void](Get-CheckedRect $hit)
  $endX = $point.X + $DeltaX
  $endY = $point.Y + $DeltaY
  $screen = [System.Windows.Forms.SystemInformation]::VirtualScreen
  if (-not $screen.Contains($endX, $endY)) { throw 'Mouse destination would leave the visible desktop.' }
  [void][WeiBiYeNativeInput]::SetCursorPos($point.X, $point.Y)
  if ($Action -eq 'context') {
    $buttonDown = [uint32]8; $buttonUp = [uint32]16
  } else { $buttonDown = [uint32]2; $buttonUp = [uint32]4 }
  [WeiBiYeNativeInput]::mouse_event($buttonDown, 0, 0, 0, [UIntPtr]::Zero)
  $pressed = $true
  if ($Action -eq 'drag') {
    for ($step = 1; $step -le 12; $step++) {
      [void][WeiBiYeNativeInput]::SetCursorPos([int]($point.X + $DeltaX * $step / 12), [int]($point.Y + $DeltaY * $step / 12))
      Start-Sleep -Milliseconds 16
    }
  } else { Start-Sleep -Milliseconds 50 }
  [WeiBiYeNativeInput]::mouse_event($buttonUp, 0, 0, 0, [UIntPtr]::Zero)
  $pressed = $false
  Start-Sleep -Milliseconds 150
  $after = Get-CheckedRect $handle
  @{ action = $Action; processId = $ExpectedProcessId; windowHandle = "$WindowHandle"; before = (Convert-Rect $before); after = (Convert-Rect $after); start = @{ x = $point.X; y = $point.Y }; finish = @{ x = $endX; y = $endY }; cursorRestored = $true } | ConvertTo-Json -Depth 5 -Compress
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
} finally {
  if ($pressed) { [WeiBiYeNativeInput]::mouse_event($buttonUp, 0, 0, 0, [UIntPtr]::Zero) }
  [void][WeiBiYeNativeInput]::SetCursorPos($previousCursor.X, $previousCursor.Y)
  [void][WeiBiYeNativeInput]::SetThreadDpiAwarenessContext($previousDpi)
}
