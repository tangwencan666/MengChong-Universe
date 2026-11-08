param(
  [Parameter(Mandatory = $true)][long]$WindowHandle,
  [Parameter(Mandatory = $true)][int]$ExpectedProcessId,
  [Parameter(Mandatory = $true)][string]$OutputPath,
  [Parameter(Mandatory = $true)][string]$AllowedDirectory
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class WeiBiYeNativeCapture {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr handle, out RECT rect);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr handle, out uint process);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr handle);
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
}
'@
$bitmap = $null
$graphics = $null
$previousDpi = [WeiBiYeNativeCapture]::SetThreadDpiAwarenessContext([IntPtr](-4))
try {
  $root = [System.IO.Path]::GetFullPath($AllowedDirectory).TrimEnd('\') + '\'
  $destination = [System.IO.Path]::GetFullPath($OutputPath)
  if (-not $destination.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'Screenshot destination must be inside the P6 evidence directory.' }
  if ([System.IO.File]::Exists($destination)) { throw 'Refusing to overwrite an existing screenshot.' }
  $handle = [IntPtr]$WindowHandle
  [uint32]$ownerProcess = 0
  [void][WeiBiYeNativeCapture]::GetWindowThreadProcessId($handle, [ref]$ownerProcess)
  if ($ownerProcess -ne $ExpectedProcessId) { throw 'Capture window does not belong to the authorized Electron instance.' }
  if (-not [WeiBiYeNativeCapture]::IsWindowVisible($handle)) { throw 'Capture window is not visible.' }
  $rect = New-Object WeiBiYeNativeCapture+RECT
  if (-not [WeiBiYeNativeCapture]::GetWindowRect($handle, [ref]$rect)) { throw 'Cannot inspect capture bounds.' }
  $width = $rect.Right - $rect.Left
  $height = $rect.Bottom - $rect.Top
  if ($width -lt 100 -or $height -lt 100 -or $width -gt 10000 -or $height -gt 10000) { throw 'Unexpected capture dimensions.' }
  $bitmap = [System.Drawing.Bitmap]::new($width, $height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.CopyFromScreen($rect.Left, $rect.Top, 0, 0, [System.Drawing.Size]::new($width, $height), [System.Drawing.CopyPixelOperation]::SourceCopy)
  $bitmap.Save($destination, [System.Drawing.Imaging.ImageFormat]::Png)
  $hashAlgorithm = [System.Security.Cryptography.SHA256]::Create()
  $hashStream = [System.IO.File]::OpenRead($destination)
  try { $fileHash = [BitConverter]::ToString($hashAlgorithm.ComputeHash($hashStream)).Replace('-', '') }
  finally { $hashStream.Dispose(); $hashAlgorithm.Dispose() }
  @{ file = $destination; source = 'Windows CopyFromScreen'; composite = $false; processId = $ownerProcess; windowHandle = "$WindowHandle"; bounds = @{ x = $rect.Left; y = $rect.Top; width = $width; height = $height }; sha256 = $fileHash } | ConvertTo-Json -Depth 4 -Compress
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
} finally {
  if ($null -ne $graphics) { $graphics.Dispose() }
  if ($null -ne $bitmap) { $bitmap.Dispose() }
  [void][WeiBiYeNativeCapture]::SetThreadDpiAwarenessContext($previousDpi)
}
