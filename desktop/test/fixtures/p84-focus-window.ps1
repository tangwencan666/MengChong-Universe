param([Parameter(Mandatory=$true)][string]$EvidenceDirectory)
$ErrorActionPreference='Stop'
$project=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
$directory=[IO.Path]::GetFullPath($EvidenceDirectory)
if(-not $directory.StartsWith((Join-Path $project '.verification\p84\'),[StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path -LiteralPath $directory -PathType Container)){throw 'Owned evidence required'}
$ready=Join-Path $directory 'focus-window.json'
if(Test-Path -LiteralPath $ready){throw 'Fresh focus fixture required'}
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class P84OwnedFocusWindow {
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr handle);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr handle, int command);
}
'@
$form=New-Object Windows.Forms.Form
$form.Text='P84 independent foreground probe'
$form.Width=480;$form.Height=280;$form.StartPosition='CenterScreen'
$label=New-Object Windows.Forms.Label
$label.Text='P84 verifies that desktop pets do not steal foreground focus. This owned test window closes automatically.'
$label.Dock='Fill';$label.TextAlign='MiddleCenter';$form.Controls.Add($label)
$timer=New-Object Windows.Forms.Timer
$timer.Interval=100
$timer.Add_Tick({
  if(Test-Path -LiteralPath (Join-Path $directory 'stop-focus')){$form.Close();return}
  if(-not (Test-Path -LiteralPath $ready)){
    # The child console is hidden; explicitly reveal only this owned test form.
    [void][P84OwnedFocusWindow]::ShowWindow($form.Handle,4)
    if([P84OwnedFocusWindow]::IsWindowVisible($form.Handle)){
      @{pid=$PID;handle=$form.Handle.ToInt64().ToString()}|ConvertTo-Json -Compress|Set-Content -LiteralPath $ready -Encoding UTF8
    }
  }
})
$form.Add_Shown({
  $timer.Start()
})
try{[Windows.Forms.Application]::Run($form)}finally{$timer.Stop();$timer.Dispose();$form.Dispose()}
