<#
.SYNOPSIS
  DSH 备份取证（技能资源）：把已安装的依赖与官方发布 tarball 逐文件对比，判定「是否可重新下载」。

.DESCRIPTION
  对应 dsh-backup 技能的「插件补丁取证」环节（类别 4 形态②③）。判定原则：
  与官方发布版一致 → 不需要打包，恢复时按精确版本重装即可；
  不一致 → 是真补丁，必须打包并标注恢复办法。

  本脚本对 package.json 的每个 registry 依赖：
    1. 用 pnpm list --depth 0 取实际安装的精确版本；
    2. npm pack <包名>@<精确版本> 下载官方 tarball（缓存指向工作区，避免沙箱拒绝写用户级缓存）；
    3. 解压后与 profiles/web/node_modules/<包> 逐文件 SHA256 对比；
    4. 输出三类差异：内容不一致（真补丁）/ 官方有本地无（可疑删改）/ 本地有官方无（多为安装机制产物）。
  发现真补丁时，用 -ExportPatches 把差异文件导出成可直接打包的补丁目录树。

.NOTES
  需要联网。npm cache 与下载物都落在 -WorkDir 内，全部是工作区内操作。
#>
[CmdletBinding()]
param(
  # DSH 配置根：Windows 默认 %USERPROFILE%\.dsh，macOS/Linux 默认 ~/.dsh
  [string]$DshHome = $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }),

  # 插件的 profile 名（决定 profiles/<名字>/package.json 与 node_modules）
  [string]$ProfileName = 'web',

  # 工作目录：官方 tarball、解压结果、补丁导出都落在这里
  [string]$WorkDir,

  # 官方 tarball 下载目录（默认为 <WorkDir>/official）
  [string]$TarballDir,

  # 解压目录（默认为 <WorkDir>/official-unpacked）
  [string]$UnpackDir,

  # 指定后把「内容不一致」的文件导出为补丁目录树（默认不导出，只报告）
  [string]$ExportPatches,

  # 只对比这些包（默认对比 package.json 的全部 registry 依赖）
  [string[]]$Packages,

  # 跳过下载，只用已有的 tarball/解压结果做对比（离线复核）
  [switch]$Offline
)

[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$ErrorActionPreference = 'Stop'

# pwsh -File 调用时 "-Packages a,b" 会作为单个字符串传入，需自行拆分
$Packages = @($Packages | ForEach-Object { $_ -split '[,;\s]+' } | Where-Object { $_ })

if (-not $WorkDir) { $WorkDir = Join-Path ([System.IO.Path]::GetTempPath()) 'dsh-backup-work' }
if (-not $TarballDir) { $TarballDir = Join-Path $WorkDir 'official-tarballs' }
if (-not $UnpackDir) { $UnpackDir = Join-Path $WorkDir 'official-unpacked' }
$npmCache = Join-Path $WorkDir 'npm-cache'

foreach ($d in @($WorkDir, $TarballDir, $UnpackDir, $npmCache)) {
  New-Item -ItemType Directory -Force -Path $d | Out-Null
}

$profileDir = Join-Path (Join-Path $DshHome 'profiles') $ProfileName
$pkgJsonPath = Join-Path $profileDir 'package.json'
if (-not (Test-Path $pkgJsonPath)) { throw "找不到 profile 清单：$pkgJsonPath" }
$localRoot = Join-Path $profileDir 'node_modules'
if (-not (Test-Path $localRoot)) { throw "找不到已安装依赖目录：$localRoot" }

$pkgJson = Get-Content $pkgJsonPath -Raw -Encoding UTF8 | ConvertFrom-Json
$depNames = @($pkgJson.dependencies.PSObject.Properties |
  Where-Object { $_.Value -notmatch '^(file|link|workspace|portal):' } |
  ForEach-Object { $_.Name })
if ($Packages) { $depNames = $depNames | Where-Object { $Packages -contains $_ } }

# 实际安装的精确版本（pnpm list 的 dependencies 是 { name = { version = 'x.y.z' } }）
# 注意：PowerShell 可能把 version 解析成单元素数组，必须显式取首个元素再转字符串，否则查表会落空
$installed = @{}
try {
  $parsed = & pnpm list --depth 0 --json --dir $profileDir 2>$null | Out-String | ConvertFrom-Json
  foreach ($p in $parsed[0].dependencies.PSObject.Properties) {
    $item = $p.Value
    if ($item -is [array]) { $item = $item[0] }
    $installed[$p.Name] = [string]$item.version
  }
} catch {
  Write-Warning ('pnpm list 解析失败：{0}' -f $_.Exception.Message)
}
if (-not $installed.Count) { throw '取不到任何实际安装版本（pnpm list 失败）：请确认 pnpm 可用且 profile 已安装依赖' }

Write-Output "依赖对比：$($depNames.Count) 个 registry 依赖"
Write-Output "本地依赖目录：$localRoot"
Write-Output ''

$summary = @()
$patchFiles = @()

foreach ($name in ($depNames | Sort-Object)) {
  $ver = $installed[$name]
  if (-not $ver) {
    Write-Warning ("[{0}] 取不到实际安装版本，跳过" -f $name)
    continue
  }
  $safeName = ($name -replace '[/@]', '-').Trim('-')
  $tgz = Join-Path $TarballDir ("{0}-{1}.tgz" -f $safeName, $ver)
  $unpacked = Join-Path $UnpackDir $safeName
  $localPkg = Join-Path $localRoot ($name -replace '/', '\')

  if (-not $Offline) {
    if (-not (Test-Path $tgz)) {
      Write-Output ("[{0}@{1}] 下载官方 tarball ..." -f $name, $ver)
      & npm pack ("{0}@{1}" -f $name, $ver) --cache $npmCache --pack-destination $TarballDir --silent 2>&1 | Out-Null
    }
    if (-not (Test-Path $tgz)) { Write-Warning ("[{0}] tarball 下载失败，跳过" -f $name); continue }
    if (-not (Test-Path (Join-Path $unpacked 'package'))) {
      New-Item -ItemType Directory -Force -Path $unpacked | Out-Null
      & tar.exe -xzf $tgz -C $unpacked
    }
  }

  $offBase = Join-Path $unpacked 'package'
  if (-not (Test-Path $offBase)) { Write-Warning ("[{0}] 缺少官方解压内容，跳过（离线模式请先下载）" -f $name); continue }
  if (-not (Test-Path $localPkg)) { Write-Warning ("[{0}] 本地未安装，跳过" -f $name); continue }

  $offFiles = Get-ChildItem $offBase -Recurse -Force -File | ForEach-Object { $_.FullName.Substring($offBase.Length).TrimStart('\') }
  $locFiles = Get-ChildItem $localPkg -Recurse -Force -File | ForEach-Object { $_.FullName.Substring($localPkg.Length).TrimStart('\') }

  $onlyOff = @($offFiles | Where-Object { $locFiles -notcontains $_ })
  $onlyLoc = @($locFiles | Where-Object { $offFiles -notcontains $_ })
  $modified = @()
  foreach ($f in $offFiles) {
    if ($locFiles -contains $f) {
      $p1 = Join-Path $offBase $f; $p2 = Join-Path $localPkg $f
      if ((Get-FileHash $p1 -Algorithm SHA256).Hash -ne (Get-FileHash $p2 -Algorithm SHA256).Hash) {
        $modified += $f
        $patchFiles += [pscustomobject]@{ Package = $name; Version = $ver; Rel = $f; LocalPath = $p2 }
      }
    }
  }

  Write-Output ("===== {0}@{1} =====" -f $name, $ver)
  Write-Output ("  官方 {0} / 本地 {1} / 内容不一致 {2}" -f $offFiles.Count, $locFiles.Count, $modified.Count)
  if ($modified.Count) { Write-Output '  [内容不一致 → 真补丁]'; $modified | ForEach-Object { Write-Output "    * $_" } }
  if ($onlyOff.Count)   { Write-Output '  [官方有本地无 → 可疑删改，请人工确认]'; $onlyOff | Select-Object -First 20 | ForEach-Object { Write-Output "    - $_" } }
  if ($onlyLoc.Count)   { Write-Output ('  [本地有官方无 → 多为安装机制产物（共 {0} 项，示例）]' -f $onlyLoc.Count); $onlyLoc | Select-Object -First 10 | ForEach-Object { Write-Output "    + $_" } }
  if (-not $modified.Count -and -not $onlyOff.Count) { Write-Output '  => 与官方发布版一致，可重新下载，无需打包' }

  $summary += [pscustomobject]@{
    Package = $name; Version = $ver
    Official = $offFiles.Count; Local = $locFiles.Count
    Modified = $modified.Count; OnlyOfficial = $onlyOff.Count; OnlyLocal = $onlyLoc.Count
  }
}

Write-Output ''
Write-Output '===== 汇总 ====='
$summary | Format-Table -AutoSize | Out-String -Width 200 | Write-Output

$bad = @($summary | Where-Object { $_.Modified -gt 0 -or $_.OnlyOfficial -gt 0 })
Write-Output ("结论：{0} 个依赖与官方一致；{1} 个存在需处理的差异" -f ($summary.Count - $bad.Count), $bad.Count)

if ($ExportPatches) {
  if ($patchFiles.Count -eq 0) {
    Write-Output '没有内容不一致的文件，未导出补丁。'
  } else {
    foreach ($pf in $patchFiles) {
      $dest = Join-Path (Join-Path $ExportPatches $pf.Package) $pf.Rel
      New-Item -ItemType Directory -Force -Path (Split-Path $dest -Parent) | Out-Null
      Copy-Item -LiteralPath $pf.LocalPath -Destination $dest -Force
    }
    Write-Output ("已导出 {0} 个补丁文件到 {1}（可直接作为备份包的 patches/node_modules 内容）" -f $patchFiles.Count, $ExportPatches)
  }
}
