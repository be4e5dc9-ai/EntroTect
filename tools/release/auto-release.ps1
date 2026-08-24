# =====================================================================
# EntroTect 一键发布:自动提交 -> 打包 -> 清理旧安装包 -> 重算校验和
# -> 静默安装 -> 验证版本
#
# 用法(仓库根目录):
#   powershell -ExecutionPolicy Bypass -File tools\release\auto-release.ps1
#   powershell -ExecutionPolicy Bypass -File tools\release\auto-release.ps1 -Version 0.2.13
#   powershell -ExecutionPolicy Bypass -File tools\release\auto-release.ps1 -Message "fix: ..."
# =====================================================================

param(
  [string]$Message = "chore: auto release",
  [string]$Version = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$root = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$appPkg = Join-Path $root "packages\app-desktop\package.json"
$releaseDir = Join-Path $root "release"
$releasePy = Join-Path $root "tools\release\release.py"
$python = Join-Path $root "tools\.venv\Scripts\python.exe"

function Step([string]$label) {
  Write-Host ""
  Write-Host "==> $label" -ForegroundColor Cyan
}

function Get-AppVersion {
  $data = Get-Content -LiteralPath $appPkg -Raw -Encoding UTF8 | ConvertFrom-Json
  return $data.version
}

# ---- 1. 自动提交 ------------------------------------------------------
Step "1/6 自动提交工作区改动"
git -C $root add -A
$changes = git -C $root status --porcelain
if ($changes) {
  git -C $root commit -m $Message
  Write-Host "已提交: $Message" -ForegroundColor Green
} else {
  Write-Host "无待提交改动,跳过" -ForegroundColor Yellow
}

# ---- 2. 打包 ----------------------------------------------------------
Step "2/6 构建 NSIS 安装包"
if ($Version -ne "") {
  & $python $releasePy --version $Version
} else {
  & $python $releasePy
}
if ($LASTEXITCODE -ne 0) { throw "打包失败(exit $LASTEXITCODE)" }

# ---- 2.5 版本号变更提交(打包脚本可能 bump package.json version) ---------
Step "提交版本号变更"
$bump = git -C $root status --porcelain
if ($bump) {
  git -C $root add -A
  git -C $root commit -m "chore: bump desktop release to $(Get-AppVersion)"
  Write-Host "已提交版本号 $(Get-AppVersion)" -ForegroundColor Green
} else {
  Write-Host "版本号无变化" -ForegroundColor Yellow
}

# ---- 3. 清理旧版本安装包 ----------------------------------------------
Step "3/6 清理旧版本安装包(保留当前版本)"
$current = Get-AppVersion
$keep = "EntroTect-Setup-$current"
$removed = @()
Get-ChildItem -LiteralPath $releaseDir -Filter "EntroTect-Setup-*" |
  Where-Object { $_.Name -notlike "$keep*" } |
  ForEach-Object {
    $removed += $_.Name
    Remove-Item -LiteralPath $_.FullName -Force
  }
if ($removed.Count -gt 0) {
  Write-Host "已删除: $($removed -join ', ')" -ForegroundColor Green
} else {
  Write-Host "无旧版本包" -ForegroundColor Yellow
}

# ---- 4. 重算校验和 ----------------------------------------------------
Step "4/6 重算 SHA256SUMS.txt"
$sums = Get-ChildItem -LiteralPath $releaseDir -Filter "EntroTect-Setup-$current*.exe" |
  Get-FileHash -Algorithm SHA256 |
  ForEach-Object { "{0}  {1}" -f $_.Hash.ToLowerInvariant(), (Split-Path ($_.Path) -Leaf) }
$sums = @($sums)
$sums | Set-Content -LiteralPath (Join-Path $releaseDir "SHA256SUMS.txt") -Encoding UTF8
Write-Host "SHA256SUMS.txt 已更新($($sums.Count) 项)" -ForegroundColor Green

# ---- 5. 静默安装 ------------------------------------------------------
Step "5/6 静默安装 $current"
$installer = Join-Path $releaseDir "EntroTect-Setup-$current.exe"
if (-not (Test-Path -LiteralPath $installer)) { throw "安装包不存在: $installer" }
$process = Start-Process -FilePath $installer -ArgumentList "/S" -Wait -PassThru
if ($process.ExitCode -ne 0) { throw "安装失败(exit $($process.ExitCode))" }
Write-Host "安装器退出码 0" -ForegroundColor Green

# ---- 6. 验证 ----------------------------------------------------------
Step "6/6 验证安装版本"
$reg = Get-ChildItem -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall" -ErrorAction SilentlyContinue |
  ForEach-Object { Get-ItemProperty -LiteralPath $_.PSPath -ErrorAction SilentlyContinue } |
  Where-Object { $_.DisplayName -like "*EntroTect*" } | Select-Object -First 1
$uninstall = $reg.UninstallString -replace '^"', '' -replace '"\s*/.+$', ''
$exe = Join-Path (Split-Path $uninstall) "EntroTect.exe"
if (-not (Test-Path -LiteralPath $exe)) { throw "未找到已安装的 EntroTect.exe: $exe" }
$fileVer = (Get-Item -LiteralPath $exe).VersionInfo.FileVersion
Write-Host "注册表版本 : $($reg.DisplayVersion)" -ForegroundColor Green
Write-Host "文件版本   : $fileVer" -ForegroundColor Green
Write-Host "安装位置   : $(Split-Path $uninstall)" -ForegroundColor Gray
if ($fileVer -ne $current) { throw "版本不匹配: 期望 $current,实际 $fileVer" }

Write-Host ""
Write-Host "=== 发布完成: EntroTect $current ===" -ForegroundColor Green
