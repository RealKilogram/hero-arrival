# Build distributable folder. Usage: powershell -ExecutionPolicy Bypass -File build.ps1
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$dist = Join-Path $root 'dist'
$out = Join-Path $dist 'Hero'

Write-Host "== clean =="
if (Test-Path $out) { Remove-Item $out -Recurse -Force }
New-Item -ItemType Directory -Force -Path $out | Out-Null

Write-Host "== copy electron runtime =="
# Requires an Electron runtime at .tools\electron (extract electron-v*-win32-x64.zip there).
Copy-Item (Join-Path $root '.tools\electron\*') $out -Recurse -Force

Write-Host "== trim locales =="
$keep = @('zh-CN.pak', 'en-US.pak')
Get-ChildItem (Join-Path $out 'locales') -File | Where-Object { $keep -notcontains $_.Name } | Remove-Item -Force

Write-Host "== copy app =="
$appDst = Join-Path $out 'resources\app'
New-Item -ItemType Directory -Force -Path $appDst | Out-Null
Copy-Item (Join-Path $root 'app\*') $appDst -Recurse -Force
Remove-Item (Join-Path $appDst 'app.log') -ErrorAction SilentlyContinue

Write-Host "== strip clips (no bundled assets) =="
$clipsDst = Join-Path $appDst 'assets\clips'
if (Test-Path $clipsDst) { Remove-Item $clipsDst -Recurse -Force }
New-Item -ItemType Directory -Force -Path $clipsDst | Out-Null
$guide = Join-Path $clipsDst 'README.txt'
[System.IO.File]::WriteAllText($guide, "This folder is intentionally empty - no bundled assets.`r`n`r`nImport your own clip packages from the app:`r`n  Tray icon -> Settings -> Import clip`r`n`r`nA clip package looks like:`r`n  <name>/clip.json    {`"name`":`"My Clip`",`"count`":120,`"fps`":60,`"width`":2560,`"height`":1400}`r`n  <name>/frames/000.webp, 001.webp, ...`r`n  <name>/sounds/*.mp3  (optional, one is picked at random)`r`n`r`nTo build a clip package from a video, see DSH-OCR.txt.`r`n", [System.Text.Encoding]::ASCII)

Write-Host "== generic icons (no third-party artwork) =="
$iconDst = Join-Path $appDst 'assets'
Copy-Item (Join-Path $root 'dist-assets\icon.ico') (Join-Path $iconDst 'icon.ico') -Force
Copy-Item (Join-Path $root 'dist-assets\icon.png') (Join-Path $iconDst 'icon.png') -Force
Copy-Item (Join-Path $root 'dist-assets\tray.png')  (Join-Path $iconDst 'tray.png') -Force

Copy-Item (Join-Path $root 'config-default.json') (Join-Path $appDst 'config.json') -Force
Remove-Item (Join-Path $out 'resources\default_app.asar') -ErrorAction SilentlyContinue

Write-Host "== launchers =="
$bat = "@echo off`r`ncd /d `"%~dp0`"`r`nstart `"`" `"%~dp0electron.exe`" `"%~dp0resources\app`"`r`n"
$batPath = Join-Path $out 'Start.bat'
[System.IO.File]::WriteAllText($batPath, $bat, [System.Text.Encoding]::ASCII)

$bat2 = "@echo off`r`ncd /d `"%~dp0`"`r`nstart `"`" `"%~dp0electron.exe`" `"%~dp0resources\app`" --no-sandbox`r`n"
$batPath2 = Join-Path $out 'Start-no-sandbox.bat'
[System.IO.File]::WriteAllText($batPath2, $bat2, [System.Text.Encoding]::ASCII)

Write-Host "== docs =="
Copy-Item (Join-Path $root 'README-dist.txt') (Join-Path $out 'README.txt') -Force
Copy-Item (Join-Path $root 'DSH-抠像说明.md') (Join-Path $out 'DSH-抠像说明.md') -Force

Write-Host "== size =="
$size = (Get-ChildItem $out -Recurse -File | Measure-Object Length -Sum).Sum
"{0:N1} MB" -f ($size / 1MB)

Write-Host "== zip =="
$zip = Join-Path $dist 'Hero-win64.zip'
if (Test-Path $zip) { Remove-Item $zip -Force }
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory($out, $zip, [System.IO.Compression.CompressionLevel]::Optimal, $true)
"{0:N1} MB" -f ((Get-Item $zip).Length / 1MB)
Write-Host "done: $zip"
