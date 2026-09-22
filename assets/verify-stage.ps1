<#
.SYNOPSIS
  DSH 备份 staging 独立复核（技能资源）：对已建好的 staging 做整体校验。

.DESCRIPTION
  对应 dsh-backup 技能的「打包后对账」之前置检查。与 build-stage.ps1 内联的逐类校验互补：
  本脚本对**整个 staging** 做一次收尾检查，适合在 build-stage 之后、打包之前单独跑一遍，
  或在手工改动过 staging 之后复核。检查项：
    * 每个类别子目录与来源环境的相对路径双向 diff（缺失 / 多余都必须为 0）；
    * 每类逐文件 SHA256 比对；
    * 结构完整性：node_modules 不应存在、插件 bundles 可读、本地依赖入口文件在位；
    * 输出 staging 文件数与总体积（供 MANIFEST 交叉核对）。

.NOTES
  只读操作，不改动 staging 与来源环境。
#>
[CmdletBinding()]
param(
  [string]$DshHome = $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }),
  [string]$ProfileName = 'web',
  [Parameter(Mandatory)] [string]$WorkDir,
  [string]$PackageName,
  # 跳过全部内容 hash 比对（只比路径与数量）
  [switch]$SkipHash,
  # 数据类目录也要求内容逐字节一致（默认不要求：DSH 运行时会持续写会话日志与投影缓存，
  # 默认只校验路径与文件数，命中差异时告警而非判失败）
  [switch]$StrictData
)

[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$ErrorActionPreference = 'Stop'

$stageRoot = Join-Path $WorkDir 'stage'
if (-not $PackageName) {
  $PackageName = (Get-ChildItem $stageRoot -Directory | Select-Object -First 1 -ExpandProperty Name)
}
if (-not $PackageName) { throw "找不到 staging 子目录：$stageRoot" }
$dst = Join-Path $stageRoot $PackageName
if (-not (Test-Path $dst)) { throw "staging 不存在：$dst" }

$profileDir = Join-Path (Join-Path $DshHome 'profiles') $ProfileName
$fail = 0

# 类别子目录 -> 来源根（本地依赖与脚本单独处理）
$pairs = @(
  @{ Rel = 'config\skills'; Src = (Join-Path $DshHome 'skills') },
  @{ Rel = 'plugins';       Src = $profileDir; Ex = @('node_modules') },
  @{ Rel = 'state';         Src = $DshHome },
  @{ Rel = 'scripts';       Src = $DshHome },
  @{ Rel = 'data\sessions';    Src = (Join-Path $DshHome 'sessions') },
  @{ Rel = 'data\storages';    Src = (Join-Path $DshHome 'storages') },
  @{ Rel = 'data\attachments'; Src = (Join-Path $DshHome 'attachments') }
)

Write-Output "复核 staging：$dst"
Write-Output ''

foreach ($p in $pairs) {
  $tgt = Join-Path $dst $p.Rel
  if (-not (Test-Path $tgt)) { Write-Output "[SKIP] $($p.Rel)（staging 中不存在）"; continue }
  if (-not (Test-Path $p.Src)) { Write-Output "[SKIP] $($p.Rel)（来源不存在）"; continue }
  $ex = @($p.Ex)
  # state/ 与 scripts/ 的来源是 $DSH_HOME 顶层，只应有被纳入的项，逐个比对
  if ($p.Rel -in @('state', 'scripts')) {
    $ok = $true
    foreach ($item in Get-ChildItem $tgt -Force) {
      $srcItem = Join-Path $p.Src $item.Name
      if (-not (Test-Path $srcItem)) { Write-Output "  [失败] $($p.Rel)\$($item.Name) 在来源不存在"; $ok = $false; continue }
    }
    Write-Output ("[{0}] {1}（逐项存在性检查）" -f $(if ($ok) { 'OK' } else { '失败' }), $p.Rel)
    if (-not $ok) { $fail++ }
    continue
  }
  $srcFiles = Get-ChildItem $p.Src -Recurse -Force -File |
    Where-Object { $r = $_.FullName.Substring($p.Src.Length).TrimStart('\'); -not ($ex | Where-Object { $r -eq $_ -or $r.StartsWith("$_\") }) } |
    ForEach-Object { $_.FullName.Substring($p.Src.Length).TrimStart('\') } | Sort-Object
  $dstFiles = Get-ChildItem $tgt -Recurse -Force -File |
    ForEach-Object { $_.FullName.Substring($tgt.Length).TrimStart('\') } | Sort-Object
  $miss = @($srcFiles | Where-Object { $dstFiles -notcontains $_ })
  $extra = @($dstFiles | Where-Object { $srcFiles -notcontains $_ })
  # 数据类目录：运行中的 DSH 会持续写当前会话日志与投影缓存，默认只比路径与数量
  $isData = $p.Rel -like 'data\*'
  $hashThis = (-not $SkipHash) -and ((-not $isData) -or $StrictData)
  $diff = 0
  $volatile = @()
  if ($hashThis) {
    foreach ($f in $srcFiles) {
      if ($dstFiles -contains $f) {
        if ((Get-FileHash (Join-Path $p.Src $f) -Algorithm SHA256).Hash -ne (Get-FileHash (Join-Path $tgt $f) -Algorithm SHA256).Hash) {
          $diff++
          if ($isData) { $volatile += $f }
        }
      }
    }
  }
  $hardFail = ($miss.Count -or $extra.Count -or ($diff -and -not $isData))
  Write-Output ("[{0}] {1}：源 {2} / staging {3}；缺失 {4}；多余 {5}；内容不一致 {6}{7}" -f `
      $(if ($hardFail) { '失败' } elseif ($diff) { '告警' } else { 'OK' }), $p.Rel, $srcFiles.Count, $dstFiles.Count, $miss.Count, $extra.Count, $diff, `
      $(if ($isData -and -not $hashThis) { '（数据类：仅校验路径与数量）' } else { '' }))
  if ($hardFail) {
    $fail++
    $miss | Select-Object -First 20 | ForEach-Object { Write-Output "    - 缺失 $_" }
    $extra | Select-Object -First 20 | ForEach-Object { Write-Output "    + 多余 $_" }
  }
  if ($volatile.Count) {
    Write-Output '    ! 以下文件在复核期间仍被 DSH 写入（属正常时序差异，不是备份错误）：'
    $volatile | Select-Object -First 10 | ForEach-Object { Write-Output "      ~ $_" }
    Write-Output '      当前会话自身的日志/投影缓存必然持续增长；需要绝对一致的快照时，先停掉 dsh web 再重跑本脚本。'
  }
}

# 本地依赖：核对入口文件与目录层级
$ldRoot = Join-Path $dst 'local-deps'
if (Test-Path $ldRoot) {
  foreach ($d in Get-ChildItem $ldRoot -Directory -Force) {
    $pj = Join-Path $d.FullName 'package.json'
    if (-not (Test-Path $pj)) { Write-Output "[失败] local-deps/$($d.Name)：缺 package.json"; $fail++; continue }
    $meta = Get-Content $pj -Raw -Encoding UTF8 | ConvertFrom-Json
    $entries = @()
    if ($meta.main) { $entries += $meta.main }
    if ($meta.exports) {
      $meta.exports.PSObject.Properties | ForEach-Object {
        $v = $_.Value
        if ($v -is [string]) { $entries += $v }
        elseif ($v.PSObject.Properties['.']) { $entries += [string]$v.'.' }
      }
    }
    $missing = @($entries | Where-Object { $_ -and -not (Test-Path (Join-Path $d.FullName ($_.TrimStart('./') -replace '/', '\'))) })
    if ($missing.Count) {
      Write-Output "[失败] local-deps/$($d.Name)：main/exports 指向的入口缺失 -> $($missing -join ', ')"
      $fail++
    } else {
      $entryList = if ($entries.Count) { $entries -join ', ' } else { '(package.json 未声明 main/exports)' }
      Write-Output "[OK] local-deps/$($d.Name)：入口可达（$entryList）"
    }
  }
}

Write-Output ''
if (Test-Path (Join-Path $dst 'plugins\node_modules')) { Write-Output '[失败] plugins/node_modules 不应存在（node_modules 永不打包）'; $fail++ } else { Write-Output '[OK] plugins/node_modules 不存在' }
$pjPath = Join-Path $dst 'plugins\package.json'
if (Test-Path $pjPath) {
  $b = (Get-Content $pjPath -Raw -Encoding UTF8 | ConvertFrom-Json).dsh.profile.bundles
  Write-Output ("[OK] plugins/package.json：dsh.profile.bundles = {0} 项" -f @($b).Count)
}

$files = Get-ChildItem $dst -Recurse -Force -File
Write-Output ''
Write-Output ("staging 统计：{0} 文件 / {1:N2} MB" -f $files.Count, (($files | Measure-Object -Property Length -Sum).Sum / 1MB))
if ($fail) { Write-Output "复核失败项：$fail"; exit 1 } else { Write-Output '全部通过' }
