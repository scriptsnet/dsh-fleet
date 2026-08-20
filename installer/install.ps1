# dsh-fleet one-shot installer (Windows)
# Installs the DeepSeek Harness portable build + registers the dsh-fleet plugin.
# Fully offline: no pnpm, no GitHub needed (same result as `dsh plugin add`, done manually).
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File install.ps1 -HarnessZip "D:\DeepSeek-Harness-便携版.zip"
#   powershell -ExecutionPolicy Bypass -File install.ps1 -HarnessDir "E:\DeepSeekHarness" -InstallDir "D:\DeepSeekHarness"
#   powershell -ExecutionPolicy Bypass -File install.ps1 -HarnessZip "..." -InstallDir "D:\DeepSeekHarness" -Start -AutoStart
#
# Params:
#   -HarnessZip  path to the portable zip (auto-detected in cwd/parent if omitted)
#   -HarnessDir  path to an extracted harness folder (contains DeepSeek Harness.exe)
#   -InstallDir  destination folder (default: <drive of this script>\DeepSeekHarness)
#   -PluginPath  dsh-fleet plugin package folder (default: parent of this script)
#   -Start       launch the harness right after install
#   -AutoStart   create a Startup-folder shortcut (unattended auto-start on login)
param(
  [string]$HarnessZip = '',
  [string]$HarnessDir = '',
  [string]$InstallDir = '',
  [string]$PluginPath = '',
  [switch]$Start,
  [switch]$AutoStart
)
$ErrorActionPreference = 'Stop'
$exeName = 'DeepSeek Harness.exe'

# ps2exe 打包后 $PSScriptRoot 为空，需从调用路径推导脚本目录
$scriptDir = $PSScriptRoot
if (-not $scriptDir) {
  try { $scriptDir = Split-Path -Parent ([System.Diagnostics.Process]::GetCurrentProcess().MainModule.FileName) } catch { }
}
if (-not $scriptDir -or -not (Test-Path $scriptDir)) { $scriptDir = Split-Path -Parent $PSCommandPath }

function Log($m) { Write-Host "[$([DateTime]::Now.ToString('HH:mm:ss'))] $m" }

# ---------- resolve paths ----------
if (-not $PluginPath) { $PluginPath = Join-Path $scriptDir '..' }
$PluginPath = [System.IO.Path]::GetFullPath($PluginPath)
if (-not (Test-Path (Join-Path $PluginPath 'package.json'))) { Write-Error "invalid plugin package path: $PluginPath (no package.json)"; exit 1 }

if (-not $InstallDir) {
  $drive = [System.IO.Path]::GetPathRoot($PSScriptRoot).TrimEnd('\')
  $InstallDir = Join-Path $drive 'DeepSeekHarness'
}
$InstallDir = [System.IO.Path]::GetFullPath($InstallDir)

# ---------- locate harness source ----------
$harnessExe = $null
if ($HarnessDir) {
  $candidate = Join-Path $HarnessDir $exeName
  if (Test-Path $candidate) { $harnessExe = $candidate }
  else { Write-Error "no $exeName inside -HarnessDir"; exit 1 }
}
if (-not $harnessExe -and -not $HarnessZip) {
  $candidates = @(
    (Join-Path $scriptDir '..\..\DeepSeek Harness.exe'),
    (Join-Path $scriptDir '..\DeepSeek Harness.exe'),
    (Join-Path (Get-Location) $exeName),
    (Join-Path (Get-Location) 'DeepSeek-Harness-便携版.zip')
  )
  foreach ($c in $candidates) {
    if (Test-Path $c) {
      if ($c -like '*DeepSeek Harness.exe') { $harnessExe = $c }
      else { $HarnessZip = $c }
      break
    }
  }
}
if (-not $harnessExe -and -not $HarnessZip) {
  Write-Error 'harness source not found: pass -HarnessZip (portable zip) or -HarnessDir (extracted folder)'
  exit 1
}

# ---------- 1/3 install harness ----------
if (Test-Path (Join-Path $InstallDir $exeName)) {
  Log "1/3 harness already installed at $InstallDir (skip copy)"
} elseif ($harnessExe) {
  Log "1/3 copying harness folder to $InstallDir ... (large folder, please wait)"
  Copy-Item -Path (Split-Path $harnessExe -Parent) -Destination $InstallDir -Recurse -Force
} else {
  Log "1/3 extracting $HarnessZip ... (large file, please wait)"
  $tmp = Join-Path $env:TEMP ('dsh-fleet-unpack-' + [guid]::NewGuid().ToString('N'))
  Expand-Archive -Path $HarnessZip -DestinationPath $tmp -Force
  $found = Get-ChildItem -Path $tmp -Filter $exeName -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $found) { Remove-Item $tmp -Recurse -Force; Write-Error "no $exeName inside the zip (not a DeepSeek Harness portable build?)"; exit 1 }
  Copy-Item -Path $found.DirectoryName -Destination $InstallDir -Recurse -Force
  Remove-Item $tmp -Recurse -Force
}
if (-not (Test-Path (Join-Path $InstallDir $exeName))) { Write-Error "install failed: no $exeName in $InstallDir"; exit 1 }

# ---------- 2/3 register dsh-fleet plugin (offline equivalent of dsh plugin add) ----------
$web = Join-Path $InstallDir 'data\profiles\web'
$pkgJson = Join-Path $web 'package.json'
if (-not (Test-Path $pkgJson)) { Write-Error "profile manifest not found: $pkgJson (incomplete harness folder?)"; exit 1 }

Log '2/3 registering dsh-fleet plugin ...'
$destPkg = Join-Path $web 'node_modules\dsh-fleet'
if (Test-Path $destPkg) { Remove-Item $destPkg -Recurse -Force }
New-Item -ItemType Directory -Path $destPkg -Force | Out-Null
Copy-Item -Path (Join-Path $PluginPath '*') -Destination $destPkg -Recurse -Force -Exclude 'node_modules', 'demo', 'installer'

$json = Get-Content $pkgJson -Raw | ConvertFrom-Json
$deps = $json.dependencies
$names = @($deps.PSObject.Properties.Name)
if ($names -notcontains 'dsh-fleet') {
  $deps | Add-Member -NotePropertyName 'dsh-fleet' -NotePropertyValue 'file:dsh-fleet' -Force
}
if ($null -eq $json.dsh) {
  $json | Add-Member -NotePropertyName 'dsh' -NotePropertyValue ([pscustomobject]@{ profile = [pscustomobject]@{ bundles = @() } }) -Force
}
if ($null -eq $json.dsh.profile.bundles) {
  $json.dsh.profile | Add-Member -NotePropertyName 'bundles' -NotePropertyValue @() -Force
}
if (@($json.dsh.profile.bundles) -notcontains 'dsh-fleet') {
  $json.dsh.profile.bundles += 'dsh-fleet'
}
$text = $json | ConvertTo-Json -Depth 12
[System.IO.File]::WriteAllText($pkgJson, $text, (New-Object System.Text.UTF8Encoding($false)))

# ---------- 放行 47900 入站（跨机组队必需；需管理员，失败则提示） ----------
try {
  if ($null -eq (Get-NetFirewallRule -DisplayName 'dsh-fleet-47900' -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -DisplayName 'dsh-fleet-47900' -Direction Inbound -Protocol TCP -LocalPort 47900 -Action Allow -Profile Any -ErrorAction Stop | Out-Null
    Log '已放行 47900/tcp 入站（Windows 防火墙）'
  }
} catch {
  Log '警告：无法自动添加防火墙规则（需要管理员权限）。手动执行：'
  Log '  netsh advfirewall firewall add rule name=dsh-fleet-47900 dir=in action=allow protocol=TCP localport=47900'
}

# ---------- 3/3 auto-start ----------
if ($AutoStart) {
  Log '3/3 creating startup shortcut ...'
  $startup = [Environment]::GetFolderPath('Startup')
  $lnkPath = Join-Path $startup 'DeepSeek Harness.lnk'
  $ws = New-Object -ComObject WScript.Shell
  $lnk = $ws.CreateShortcut($lnkPath)
  $lnk.TargetPath = Join-Path $InstallDir $exeName
  $lnk.WorkingDirectory = $InstallDir
  $lnk.Save()
  Log "3/3 shortcut created: $lnkPath"
}

Log "install complete: $InstallDir"
Log '  - plugin registered in data\profiles\web (active after harness restart)'
Log '  - machine identity is generated on first boot (data\fleet\identity.json)'
Log '  - after boot, ask fleet_card in any session for this machine card; fleet_add joins others'
if ($Start) {
  Log 'launching DeepSeek Harness ...'
  Start-Process -FilePath (Join-Path $InstallDir $exeName) -WorkingDirectory $InstallDir
}
