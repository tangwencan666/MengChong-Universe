param([Parameter(Mandatory=$true)][long]$WindowHandle,[Parameter(Mandatory=$true)][int]$ExpectedProcessId,[Parameter(Mandatory=$true)][string]$OutputPath)
$ErrorActionPreference='Stop'
$project=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
$destination=[IO.Path]::GetFullPath($OutputPath)
$parent=[IO.Path]::GetDirectoryName($destination)
if(-not $parent.StartsWith((Join-Path $project '.verification\p86\p862-ui-'),[StringComparison]::OrdinalIgnoreCase) -or -not(Test-Path -LiteralPath $parent -PathType Container)){throw 'Only a new owned UI evidence directory is allowed'}
if(Test-Path -LiteralPath $destination){throw 'Refusing to overwrite a screenshot'}
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class P862WindowCapture {
 [StructLayout(LayoutKind.Sequential)] public struct RECT {public int Left,Top,Right,Bottom;}
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr handle,out uint process);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr handle);
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr handle,out RECT rect);
 [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr handle,IntPtr dc,uint flags);
 [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
}
'@
$previous=[P862WindowCapture]::SetThreadDpiAwarenessContext([IntPtr](-4))
$bitmap=$null;$graphics=$null;$dc=[IntPtr]::Zero
try{
 $handle=[IntPtr]$WindowHandle;[uint32]$owner=0
 [void][P862WindowCapture]::GetWindowThreadProcessId($handle,[ref]$owner)
 if($owner -ne $ExpectedProcessId -or -not[P862WindowCapture]::IsWindowVisible($handle)){throw 'The capture must be a visible window of the owned Electron process'}
 $rect=New-Object P862WindowCapture+RECT
 if(-not[P862WindowCapture]::GetWindowRect($handle,[ref]$rect)){throw 'No native window bounds'}
 $width=$rect.Right-$rect.Left;$height=$rect.Bottom-$rect.Top
 if($width -lt 300 -or $height -lt 300 -or $width -gt 5000 -or $height -gt 5000){throw 'Unsupported capture geometry'}
 $bitmap=[Drawing.Bitmap]::new($width,$height);$graphics=[Drawing.Graphics]::FromImage($bitmap);$dc=$graphics.GetHdc()
 if(-not[P862WindowCapture]::PrintWindow($handle,$dc,2)){throw 'Owned PrintWindow capture unavailable'}
 $graphics.ReleaseHdc($dc);$dc=[IntPtr]::Zero
 $colors=[Collections.Generic.HashSet[int]]::new()
 for($y=20;$y -lt $height;$y+=37){for($x=20;$x -lt $width;$x+=37){[void]$colors.Add($bitmap.GetPixel($x,$y).ToArgb())}}
 if($colors.Count -lt 15){throw 'Capture appears blank; renderer screenshots remain separate evidence'}
 $bitmap.Save($destination,[Drawing.Imaging.ImageFormat]::Png)
 @{source='Windows PrintWindow, owned HWND only';composite=$false;file=$destination;pid=$owner;windowHandle=$WindowHandle;width=$width;height=$height;sampledColors=$colors.Count}|ConvertTo-Json -Compress
}finally{
 if($dc -ne [IntPtr]::Zero){$graphics.ReleaseHdc($dc)}
 if($null -ne $graphics){$graphics.Dispose()};if($null -ne $bitmap){$bitmap.Dispose()}
 [void][P862WindowCapture]::SetThreadDpiAwarenessContext($previous)
}
