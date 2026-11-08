param([string]$SourceDirectory='', [string]$OutputDirectory='')
$ErrorActionPreference='Stop'
$desktopRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if(-not $SourceDirectory){$SourceDirectory=Join-Path ([Environment]::GetFolderPath('Desktop')) (-join ([char[]]@(0x56fe,0x7247,0x5e93)))}
$sourceRoot=[IO.Path]::GetFullPath($SourceDirectory)
if(-not (Test-Path -LiteralPath $sourceRoot -PathType Container)){throw 'Explicit source directory missing'}
$localRoot=Join-Path $desktopRoot 'local-preview'
if(-not $OutputDirectory){$OutputDirectory=Join-Path $localRoot 'p85-eight-v1'}
$destination=[IO.Path]::GetFullPath($OutputDirectory)
if(-not $destination.StartsWith($localRoot+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'Output must be a new project local-preview directory'}
if(Test-Path -LiteralPath $destination){throw 'Existing output refused; choose a new versioned directory'}
if((Get-Item -LiteralPath $sourceRoot).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Source link refused'}
$plan=([IO.File]::ReadAllText((Join-Path $desktopRoot 'assets\p85-source-plan.json'),[Text.Encoding]::UTF8)|ConvertFrom-Json)
$sourceFiles=@(Get-ChildItem -LiteralPath $sourceRoot -File|Where-Object {$_.Extension -match '^\.(png|jpe?g)$'})
$resolved=@{}
foreach($entry in $plan.sources.PSObject.Properties){
  $matches=@($sourceFiles|Where-Object {(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant() -eq $entry.Value.sha256})
  if($matches.Count -ne 1){throw ('Source content absent or ambiguous: '+$entry.Name)}
  if($matches[0].Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Source file link refused'}
  $resolved[$entry.Name]=$matches[0]
}
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Drawing;
using System.Drawing.Imaging;
using System.Drawing.Drawing2D;
public static class P85ExactRaster {
  public static int[] Info(string path) {
    using(var b=new Bitmap(path)) {
      bool alpha=(b.PixelFormat & PixelFormat.Alpha)!=0;
      int min=255,max=0;
      if(alpha) for(int y=0;y<b.Height;y++) for(int x=0;x<b.Width;x++){int a=b.GetPixel(x,y).A;min=Math.Min(min,a);max=Math.Max(max,a);}
      else max=255;
      return new[]{b.Width,b.Height,alpha?1:0,min,max};
    }
  }
  static bool Background(Color c) { return Math.Max(c.R,Math.Max(c.G,c.B))-Math.Min(c.R,Math.Min(c.G,c.B))<=18 && Math.Min(c.R,Math.Min(c.G,c.B))>=172; }
  public static Bitmap Crop(string path,int x,int y,int w,int h,bool remove,int[] masks) {
    using(var original=new Bitmap(path)) {
      if(x<0||y<0||w<=0||h<=0||x+w>original.Width||y+h>original.Height)throw new Exception("Crop escaped source");
      var b=new Bitmap(w,h,PixelFormat.Format32bppArgb);
      using(var g=Graphics.FromImage(b)){g.CompositingMode=CompositingMode.SourceCopy;g.DrawImage(original,new Rectangle(0,0,w,h),x,y,w,h,GraphicsUnit.Pixel);}
      if(masks!=null) using(var g=Graphics.FromImage(b)){g.CompositingMode=CompositingMode.SourceCopy;for(int i=0;i<masks.Length;i+=4)g.FillRectangle(Brushes.Transparent,masks[i],masks[i+1],masks[i+2],masks[i+3]);}
      if(remove) {
        var seen=new bool[w*h];var queue=new int[w*h];int head=0,tail=0;
        for(int i=0;i<w*h;i++){int px=i%w,py=i/w;if(px==0||py==0||px==w-1||py==h-1){seen[i]=true;if(Background(b.GetPixel(px,py))||b.GetPixel(px,py).A==0)queue[tail++]=i;}}
        while(head<tail){int at=queue[head++],px=at%w,py=at/w;b.SetPixel(px,py,Color.Transparent);
          foreach(int next in new[]{at-1,at+1,at-w,at+w}){
            if(next<0||next>=w*h||seen[next]||Math.Abs(next%w-px)+Math.Abs(next/w-py)!=1)continue;
            seen[next]=true;var c=b.GetPixel(next%w,next/w);if(c.A==0||Background(c))queue[tail++]=next;
          }
        }
      }
      int left=w,top=h,right=-1,bottom=-1;
      for(int py=0;py<h;py++)for(int px=0;px<w;px++)if(b.GetPixel(px,py).A>8){left=Math.Min(left,px);right=Math.Max(right,px);top=Math.Min(top,py);bottom=Math.Max(bottom,py);}
      if(right<left){b.Dispose();throw new Exception("Empty foreground refused");}
      var trimmed=b.Clone(new Rectangle(left,top,right-left+1,bottom-top+1),PixelFormat.Format32bppArgb);b.Dispose();return trimmed;
    }
  }
  public static void Save(Bitmap b,string path,double scale) {
    using(var canvas=new Bitmap(256,256,PixelFormat.Format32bppArgb)) {
      canvas.SetResolution(96,96);
      int w=Math.Max(1,(int)Math.Round(b.Width*scale)),h=Math.Max(1,(int)Math.Round(b.Height*scale));
      if(w>232||h>232)throw new Exception("Normalized frame budget exceeded");
      using(var g=Graphics.FromImage(canvas)){
        g.Clear(Color.Transparent);g.CompositingMode=CompositingMode.SourceCopy;g.CompositingQuality=CompositingQuality.HighQuality;
        g.InterpolationMode=InterpolationMode.HighQualityBicubic;g.PixelOffsetMode=PixelOffsetMode.HighQuality;
        g.DrawImage(b,new Rectangle((256-w)/2,244-h,w,h),new Rectangle(0,0,b.Width,b.Height),GraphicsUnit.Pixel);
      }
      using(var stream=new FileStream(path,FileMode.CreateNew,FileAccess.Write,FileShare.None))canvas.Save(stream,ImageFormat.Png);
    }
  }
}
'@ -ReferencedAssemblies System.Drawing
$inventory=foreach($file in $sourceFiles){
  $info=[P85ExactRaster]::Info($file.FullName)
  $match=@($plan.sources.PSObject.Properties|Where-Object {$resolved[$_.Name].FullName -eq $file.FullName})
  [ordered]@{file=$file.Name;extension=$file.Extension;width=$info[0];height=$info[1];bytes=$file.Length;has_alpha_channel=($info[2] -eq 1);alpha_min=$info[3];alpha_max=$info[4];sha256=(Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant();inspection=if($match.Count){$match[0].Value.content}else{'Not processed'};license=$plan.license}
}
$frames=@()
try{
  foreach($frame in $plan.frames){
    $r=$frame.rect;$masks=@();foreach($mask in $frame.exclude_background_labels){$masks+=@($mask)};foreach($mask in $frame.exclude_non_target_regions){$masks+=@($mask)}
    $bitmap=[P85ExactRaster]::Crop($resolved[$frame.source].FullName,$r[0],$r[1],$r[2],$r[3],$frame.transparent_background,([int[]]$masks))
    $frames+=@{spec=$frame;bitmap=$bitmap}
  }
  New-Item -ItemType Directory -Path $destination -ErrorAction Stop|Out-Null
  $outputs=foreach($frame in $frames){
    $spec=$frame.spec;$family=@($frames|Where-Object {$_.spec.species_id -eq $spec.species_id -and $_.spec.runtime -eq $spec.runtime})
    $width=($family|ForEach-Object {$_.bitmap.Width}|Measure-Object -Maximum).Maximum
    $height=($family|ForEach-Object {$_.bitmap.Height}|Measure-Object -Maximum).Maximum
    $scale=[Math]::Min(232.0/$width,232.0/$height)
    $name='p85-'+$spec.species_id+'-'+$spec.view+'-v1.png';$file=Join-Path $destination $name
    [P85ExactRaster]::Save($frame.bitmap,$file,$scale)
    $info=[P85ExactRaster]::Info($file)
    [ordered]@{file=$name;species_id=$spec.species_id;view=$spec.view;source=$resolved[$spec.source].Name;source_sha256=$plan.sources.($spec.source).sha256;source_rect=$spec.rect;excluded_background_labels=$spec.exclude_background_labels;excluded_non_target_regions=$spec.exclude_non_target_regions;runtime=$spec.runtime;reason=$spec.reason;operation='original-source crop; neutral-edge background flood fill; shared-scale resampling; no generated anatomy, views or facial edits';scale=$scale;width=$info[0];height=$info[1];alpha_min=$info[3];alpha_max=$info[4];bytes=(Get-Item -LiteralPath $file).Length;sha256=(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()}
  }
  $record=[ordered]@{version=1;source_directory=$sourceRoot;output_directory=$destination;license=$plan.license;inventory=@($inventory);outputs=@($outputs)}
  [IO.File]::WriteAllText((Join-Path $destination 'processing.json'),($record|ConvertTo-Json -Depth 12),[Text.UTF8Encoding]::new($false))
  $public=[ordered]@{version=1;license=$plan.license;inventory=@($inventory);frames=@($outputs)}
  [IO.File]::WriteAllText((Join-Path $destination 'ASSET_PROVENANCE.json'),($public|ConvertTo-Json -Depth 12),[Text.UTF8Encoding]::new($false))
  [IO.File]::WriteAllText((Join-Path $destination 'ASSET_NOTICE.md'),'User-supplied reference art. Local verification only. Redistribution and commercial rights are unverified. Reference overlays and watermarks are preserved. Not included in the default installer. No generated anatomy, directions or facial edits. Originals remain unchanged.',[Text.UTF8Encoding]::new($false))
  Write-Output ('Created '+$outputs.Count+' local-only frames and source inventory in '+$destination)
}finally{foreach($frame in $frames){$frame.bitmap.Dispose()}}
