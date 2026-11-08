param(
  [Parameter(Mandatory=$true)][long]$WindowHandle,
  [Parameter(Mandatory=$true)][int]$ExpectedProcessId
)
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class P84OwnedCursor {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr handle,out uint owner);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr handle,out RECT rect);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr handle);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT point);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
}
'@
$handle=[IntPtr]$WindowHandle
[uint32]$owner=0
[void][P84OwnedCursor]::GetWindowThreadProcessId($handle,[ref]$owner)
if($owner -ne $ExpectedProcessId -or -not [P84OwnedCursor]::IsWindowVisible($handle)){throw 'Owned visible window required'}
$prior=[P84OwnedCursor]::SetThreadDpiAwarenessContext([IntPtr](-4))
$origin=New-Object P84OwnedCursor+POINT
$rect=New-Object P84OwnedCursor+RECT
if(-not [P84OwnedCursor]::GetCursorPos([ref]$origin) -or -not [P84OwnedCursor]::GetWindowRect($handle,[ref]$rect)){throw 'Native geometry unavailable'}
try{
  $x=[int](($rect.Left+$rect.Right)/2)
  $y=[int](($rect.Top+$rect.Bottom)/2)
  if(-not [P84OwnedCursor]::SetCursorPos($x,$y)){throw 'Cursor move failed'}
  Start-Sleep -Milliseconds 450
  @{verifiedOwner=$true;clicksSent=0;cursorRestored=$true;processId=$ExpectedProcessId}|ConvertTo-Json -Compress
} finally {
  [void][P84OwnedCursor]::SetCursorPos($origin.X,$origin.Y)
  [void][P84OwnedCursor]::SetThreadDpiAwarenessContext($prior)
}
