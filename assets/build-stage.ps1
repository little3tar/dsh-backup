<#
.SYNOPSIS
  DSH 备份 staging 构建（技能资源）：按六类组件把来源环境的内容复制成待打包目录树。

.DESCRIPTION
  对应 dsh-backup 技能的「执行打包 → 建 staging」。要点（都是硬约束，别改）：
    * 复制目录树一律用 Copy-Item -Recurse 逐层调用；禁止
      Get-ChildItem -Recurse | Copy-Item -Destination <目标> —— 管道会把子目录文件拍平到根。
    * 每类复制完立刻比对该类「源 vs staging」的相对路径与内容 hash，不一致就报错退出。
    * 排除 node_modules、包管理器缓存、.git 与运行时自动生成物（如 .dsh-module-fallback）。
    * file:/link: 依赖的源码目录按原样打包（这类依赖无法从任何源下载）。
    * 凭据默认不打包，必须用 -IncludeCredentials 显式开启。

.NOTES
  输出：<WorkDir>/stage/<PackageName>/ 与 <WorkDir>/stage-report.txt（供人工复核）
#>
[CmdletBinding()]
param(
  # DSH 配置根：Windows 默认 %USERPROFILE%\.dsh，macOS/Linux 默认 ~/.dsh
  [string]$DshHome = $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }),

  # 插件的 profile 名
  [string]$ProfileName = 'web',

  # 工作目录（staging 与中间产物都落在这里）
  [string]$WorkDir,

  # 备份包名（也是 staging 子目录名）；默认按时间戳生成
  [string]$PackageName = ("dsh-backup-{0}" -f (Get-Date -Format 'yyyyMMdd-HHmm')),

  # 纳入的类别：1 配置 / 2 插件 / 3 本地依赖 / 4 补丁(由 compare-patches 产出) / 5 脚本与状态 / 6 数据
  [string[]]$Categories = @('1', '2', '3', '4', '5', '6'),

  # 显式开启凭据打包（默认关闭；开启后包内含明文凭据）
  [switch]$IncludeCredentials,

  # 不纳入的 $DSH_HOME 顶层条目（插件状态目录等，按用户选择排除）
  [string[]]$ExcludeTopLevel = @(),

  # 额外要纳入的 $DSH_HOME 顶层条目（如 llm-deepseek 这类插件数据目录）
  [string[]]$ExtraTopLevel = @(),

  # 已知的运行时自动生成物，永不打包
  [string[]]$RuntimeGenerated = @('.dsh-module-fallback')
)

[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$ErrorActionPreference = 'Stop'

# pwsh -File 调用时 "-Categories 1,2,3" 会作为单个字符串传入，需自行拆分
$Categories = @($Categories | ForEach-Object { $_ -split '[,;\s]+' } | Where-Object { $_ })
$ExcludeTopLevel = @($ExcludeTopLevel | ForEach-Object { $_ -split '[,;]' } | Where-Object { $_ })
$ExtraTopLevel = @($ExtraTopLevel | ForEach-Object { $_ -split '[,;]' } | Where-Object { $_ })
$valid = @('1', '2', '3', '4', '5', '6')
$unknown = @($Categories | Where-Object { $valid -notcontains $_ })
if ($unknown.Count) { throw "未知类别：$($unknown -join ',')（可选 1-6）" }
if (-not $Categories.Count) { throw '未指定任何类别（-Categories）' }

if (-not $WorkDir) { $WorkDir = Join-Path ([System.IO.Path]::GetTempPath()) 'dsh-backup-work' }
$stageRoot = Join-Path $WorkDir 'stage'
$dst = Join-Path $stageRoot $PackageName
$report = New-Object System.Collections.Generic.List[string]
function Say([string]$s) { Write-Output $s; $report.Add($s) }

if (-not (Test-Path $DshHome)) { throw "DSH 配置根不存在：$DshHome" }
if (Test-Path $dst) { Remove-Item $dst -Recurse -Force }
New-Item -ItemType Directory -Force -Path $dst | Out-Null
Say "staging = $dst"
Say "类别 = $($Categories -join ',')；凭据 = $(if ($IncludeCredentials) { '包含' } else { '不包含' })"
Say ''

# --- 复制原语：逐层复制，保留层级；复制后立即校验 ---
function Copy-DirVerified([string]$src, [string]$rel, [string[]]$excludeNames = @()) {
  if (-not (Test-Path $src)) { Say "[SKIP] $rel（源不存在：$src）"; return }
  $target = Join-Path $dst $rel
  New-Item -ItemType Directory -Force -Path $target | Out-Null
  Get-ChildItem -LiteralPath $src -Force |
    Where-Object { $excludeNames -notcontains $_.Name } |
    ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $target -Recurse -Force }

  $srcFiles = Get-ChildItem $src -Recurse -Force -File |
    Where-Object { $r = $_.FullName.Substring($src.Length).TrimStart('\'); -not ($excludeNames | Where-Object { $r -eq $_ -or $r.StartsWith("$_\") }) } |
    ForEach-Object { $_.FullName.Substring($src.Length).TrimStart('\') } | Sort-Object
  $dstFiles = Get-ChildItem $target -Recurse -Force -File |
    ForEach-Object { $_.FullName.Substring($target.Length).TrimStart('\') } | Sort-Object
  $miss = @($srcFiles | Where-Object { $dstFiles -notcontains $_ })
  $extra = @($dstFiles | Where-Object { $srcFiles -notcontains $_ })
  $diff = 0
  foreach ($f in $srcFiles) {
    if ($dstFiles -contains $f) {
      if ((Get-FileHash (Join-Path $src $f) -Algorithm SHA256).Hash -ne (Get-FileHash (Join-Path $target $f) -Algorithm SHA256).Hash) { $diff++ }
    }
  }
  Say ("[OK] {0}：源 {1} 文件 / staging {2} 文件；缺失 {3}；多余 {4}；内容不一致 {5}" -f $rel, $srcFiles.Count, $dstFiles.Count, $miss.Count, $extra.Count, $diff)
  if ($miss.Count -or $extra.Count -or $diff) {
    $miss | Select-Object -First 20 | ForEach-Object { Say "    - 缺失 $_" }
    $extra | Select-Object -First 20 | ForEach-Object { Say "    + 多余 $_" }
    throw "复制校验失败：$rel（层级或内容不一致，已中止，请勿直接打包）"
  }
}

function Copy-FileVerified([string]$src, [string]$rel) {
  if (-not (Test-Path $src)) { Say "[SKIP] $rel（源不存在：$src）"; return }
  $target = Join-Path $dst $rel
  New-Item -ItemType Directory -Force -Path (Split-Path $target -Parent) | Out-Null
  Copy-Item -LiteralPath $src -Destination $target -Force
  $same = (Get-FileHash $src -Algorithm SHA256).Hash -eq (Get-FileHash $target -Algorithm SHA256).Hash
  Say ("[{0}] {1}" -f $(if ($same) { 'OK' } else { '不一致' }), $rel)
  if (-not $same) { throw "复制校验失败：$rel" }
}

# --- 1 配置 ---
if ($Categories -contains '1') {
  Say '=== 1 配置 ==='
  Copy-FileVerified (Join-Path $DshHome 'settings.yaml') 'config/settings.yaml'
  Copy-FileVerified (Join-Path $DshHome 'AGENTS.md')     'config/AGENTS.md'
  Copy-DirVerified  (Join-Path $DshHome 'skills')        'config/skills'
  if ($IncludeCredentials) {
    Copy-FileVerified (Join-Path $DshHome '.credentials.yaml') 'credentials/.credentials.yaml'
  } else {
    Say '[SKIP] credentials/.credentials.yaml（未开启 -IncludeCredentials）'
  }
}

# --- 2 插件（profile 清单与锁文件；node_modules 永不打包）---
if ($Categories -contains '2') {
  Say '=== 2 插件清单 ==='
  $profileDir = Join-Path (Join-Path $DshHome 'profiles') $ProfileName
  $pkgJsonPath = Join-Path $profileDir 'package.json'
  if (-not (Test-Path $pkgJsonPath)) { throw "找不到 profile 清单：$pkgJsonPath" }
  foreach ($f in @('package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'cordis.yml', 'cordis.patch.yml')) {
    Copy-FileVerified (Join-Path $profileDir $f) ('plugins/' + $f)
  }
  if (Test-Path (Join-Path $profileDir '.dsh-market')) {
    Copy-DirVerified (Join-Path $profileDir '.dsh-market') 'plugins/.dsh-market'
  }
}

# --- 3 本地依赖（file:/link: 指向的源码目录，自动解析）---
$localDeps = @()
if ($Categories -contains '3') {
  Say '=== 3 本地依赖源码 ==='
  $profileDir = Join-Path (Join-Path $DshHome 'profiles') $ProfileName
  $pkgJson = Get-Content (Join-Path $profileDir 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  $nodeModules = Join-Path $profileDir 'node_modules'
  foreach ($p in $pkgJson.dependencies.PSObject.Properties) {
    $spec = [string]$p.Value
    if ($spec -notmatch '^(file|link):') { continue }
    $rel = $spec -replace '^(file|link):', ''
    # 安装位置优先按 node_modules 里的实际对象（Junction/符号链接会暴露真实目标）
    $installedPath = Join-Path $nodeModules ($p.Name -replace '/', '\')
    $targetPath = $null
    if (Test-Path $installedPath) {
      $item = Get-Item $installedPath -Force
      if ($item.LinkType -and $item.Target) {
        $targetPath = @($item.Target)[0]
        if (-not [System.IO.Path]::IsPathRooted($targetPath)) { $targetPath = Join-Path $nodeModules $targetPath }
      }
    }
    if (-not $targetPath) {
      $candidate = $rel
      if (-not [System.IO.Path]::IsPathRooted($candidate)) { $candidate = Join-Path $profileDir $candidate }
      if (Test-Path $candidate) { $targetPath = (Get-Item $candidate -Force).FullName }
    }
    if (-not $targetPath -or -not (Test-Path $targetPath)) {
      Say "[WARN] $($p.Name)：声明 $spec，但找不到实际源码目录，请人工确认（这类依赖无法从任何源下载）"
      continue
    }
    $localDeps += [pscustomobject]@{ Name = $p.Name; Spec = $spec; Source = $targetPath }
    Copy-DirVerified $targetPath ('local-deps/' + ($p.Name -replace '/', '-'))
  }
  if ($localDeps.Count -eq 0) { Say '[SKIP] 该 profile 没有 file:/link: 依赖' }
}

# --- 4 补丁（由 compare-patches.ps1 -ExportPatches 产出）---
if ($Categories -contains '4') {
  Say '=== 4 环境补丁 ==='
  $patchSrc = Join-Path $WorkDir 'patches'
  if (Test-Path $patchSrc) {
    Copy-DirVerified $patchSrc 'patches'
  } else {
    Say "[SKIP] 未发现 $patchSrc —— 若取证结论是「与官方发布版一致」，这是正常的（无补丁可打包）"
  }
}

# --- 5 自定义脚本、目录与插件状态 ---
if ($Categories -contains '5') {
  Say '=== 5 自定义脚本与插件状态 ==='
  # 凭据性质的顶层文件：只在 -IncludeCredentials 时纳入（内含令牌/登录态）
  $credentialLike = @('.openai-codex-auth.json', '.anthropic-auth.json', '.auth.json')
  $standard = @('attachments', 'sessions', 'storages', 'synapse', 'profiles', 'skills')
  $topLevel = Get-ChildItem $DshHome -Force | Where-Object {
    $standard -notcontains $_.Name -and
    $_.Name -notin @('.credentials.yaml', 'settings.yaml', 'AGENTS.md') -and
    $ExcludeTopLevel -notcontains $_.Name -and
    ($IncludeCredentials -or $credentialLike -notcontains $_.Name)
  }
  $topLevel += Get-ChildItem $DshHome -Force -ErrorAction SilentlyContinue | Where-Object { $ExtraTopLevel -contains $_.Name }
  foreach ($item in ($topLevel | Sort-Object Name -Unique)) {
    if ($RuntimeGenerated -contains $item.Name) { Say "[SKIP] $($item.Name)（运行时自动生成物）"; continue }
    if ($item.PSIsContainer) {
      Copy-DirVerified $item.FullName ('state/' + $item.Name)
    } else {
      Copy-FileVerified $item.FullName ('scripts/' + $item.Name)
    }
  }
  if (-not $IncludeCredentials) {
    $skipped = @(Get-ChildItem $DshHome -Force -ErrorAction SilentlyContinue | Where-Object { $credentialLike -contains $_.Name })
    if ($skipped.Count) { Say ("[SKIP] 疑似凭据文件未纳入（需 -IncludeCredentials）：" + ($skipped.Name -join '、')) }
  }
  if ($ExcludeTopLevel.Count) { Say ("[SKIP] 按用户选择排除：" + ($ExcludeTopLevel -join '、')) }
}

# --- 6 数据 ---
if ($Categories -contains '6') {
  Say '=== 6 数据 ==='
  foreach ($d in @('sessions', 'storages', 'attachments', 'synapse')) {
    $p = Join-Path $DshHome $d
    if (Test-Path $p) { Copy-DirVerified $p ('data/' + $d) } else { Say "[SKIP] data/$d（不存在）" }
  }
}

# --- 汇总 ---
$files = Get-ChildItem $dst -Recurse -Force -File
Say ''
Say ("staging 完成：{0} 文件 / {1:N2} MB" -f $files.Count, (($files | Measure-Object -Property Length -Sum).Sum / 1MB))
if ($localDeps.Count) {
  Say '本轮纳入的本地依赖（恢复时必须在 pnpm install 之前放置）：'
  foreach ($d in $localDeps) { Say ("  - {0}  {1}  ->  {2}" -f $d.Name, $d.Spec, $d.Source) }
}
$reportPath = Join-Path $WorkDir 'stage-report.txt'
[System.IO.File]::WriteAllLines($reportPath, $report, (New-Object System.Text.UTF8Encoding($false)))
Say "报告已写出：$reportPath"
Say "STAGE=$dst"
