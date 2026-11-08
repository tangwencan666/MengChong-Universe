param([Parameter(Mandatory=$true)][string]$WindowHandle,[Parameter(Mandatory=$true)][int]$ExpectedProcessId)
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class P85PassThrough {
  [StructLayout(LayoutKind.Sequential)]public struct Point{public int X,Y;}
  [StructLayout(LayoutKind.Sequential)]public struct Rect{public int L,T,R,B;}
  [DllImport("user32.dll")]public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")]public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")]public static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
  [DllImport("user32.dll")]public static extern bool GetWindowRect(IntPtr h,out Rect r);
  [DllImport("user32.dll")]public static extern bool GetCursorPos(out Point p);
  [DllImport("user32.dll")]public static extern bool SetCursorPos(int x,int y);
  [DllImport("user32.dll")]public static extern IntPtr WindowFromPoint(Point p);
  [DllImport("user32.dll")]public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")]public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
}
'@
$previousDpi=[P85PassThrough]::SetThreadDpiAwarenessContext([IntPtr](-4))
try{
$handle=[IntPtr]::new([long]::Parse($WindowHandle));[uint32]$actualPid=0
[void][P85PassThrough]::GetWindowThreadProcessId($handle,[ref]$actualPid)
if(-not [P85PassThrough]::IsWindow($handle) -or -not [P85PassThrough]::IsWindowVisible($handle) -or $actualPid -ne $ExpectedProcessId){throw 'Owned visible window identity mismatch'}
$bounds=New-Object P85PassThrough+Rect
if(-not [P85PassThrough]::GetWindowRect($handle,[ref]$bounds)){throw 'Owned rectangle unavailable'}
$saved=New-Object P85PassThrough+Point;[void][P85PassThrough]::GetCursorPos([ref]$saved)
$probe=New-Object P85PassThrough+Point
$probe.X=$bounds.L+[int][Math]::Round(6*($bounds.R-$bounds.L)/188.0)
$probe.Y=$bounds.T+[int][Math]::Round(6*($bounds.B-$bounds.T)/196.0)
if($probe.X -le $bounds.L -or $probe.X -ge $bounds.R -or $probe.Y -le $bounds.T -or $probe.Y -ge $bounds.B){throw 'Probe escaped owned window'}
$foreground=[P85PassThrough]::GetForegroundWindow()
try{
  if(-not [P85PassThrough]::SetCursorPos($probe.X,$probe.Y)){throw 'Owned cursor probe could not be positioned'}
  Start-Sleep -Milliseconds 200
  $cursor=New-Object P85PassThrough+Point;[void][P85PassThrough]::GetCursorPos([ref]$cursor)
  if($cursor.X -ne $probe.X -or $cursor.Y -ne $probe.Y){throw ('Cursor changed during probe; no click sent; delta='+($cursor.X-$probe.X)+','+($cursor.Y-$probe.Y))}
  $through=[P85PassThrough]::WindowFromPoint($probe) -ne $handle
  $stable=[P85PassThrough]::GetForegroundWindow() -eq $foreground
  if(-not $through -or -not $stable){throw 'Outside-control passthrough or foreground preservation failed'}
  @{processId=$ExpectedProcessId;ownedHandle=$WindowHandle;offsetDip=@{x=6;y=6};physicalPixelContext=$true;outsideControlPassedThrough=$through;foregroundStable=$stable;clicksSent=0}|ConvertTo-Json -Compress
}finally{
  $current=New-Object P85PassThrough+Point;[void][P85PassThrough]::GetCursorPos([ref]$current)
  if($current.X -eq $probe.X -and $current.Y -eq $probe.Y){[void][P85PassThrough]::SetCursorPos($saved.X,$saved.Y)}
}
}finally{[void][P85PassThrough]::SetThreadDpiAwarenessContext($previousDpi)}
