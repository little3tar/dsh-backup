<#
.SYNOPSIS
  DSH 备份最终打包（技能资源）：生成 MANIFEST 元数据段 → 追加恢复指导 → 打 ZIP → 双向对账 → 输出 SHA256。

.DESCRIPTION
  对应 dsh-backup 技能的「执行打包」与「打包后对账」。硬约束：
    * 元数据（字节数 / SHA256 / 条目数 / 精确版本表 / bundles）一律对 staging 实时读取生成，
      禁止手写或誊写旧备份的值；内容再变就必须重跑本脚本。
    * 打包后解压回读，做相对路径双向 diff + 逐文件 hash 比对，并抽样与来源环境复核。
    * 恢复指导正文从 -RecoveryDoc 读取（默认 <WorkDir>/manifest-recovery.md）。
      该文档由 agent 依据本次环境生成：跨平台、路径用 $DSH_HOME 书写，
      来源机器的用户名/盘符只出现在元数据区。缺该文件时只写元数据段并在末尾标注。

.NOTES
  依赖：Windows 10+ 自带 tar.exe；POSIX 用系统 tar。
#>
[CmdletBinding()]
param(
  [string]$DshHome = $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }),
  [string]$ProfileName = 'web',
  [Parameter(Mandatory)] [string]$WorkDir,
  [string]$PackageName,
  # 打包产物输出目录（默认 WorkDir 的上一级，即交付位置）
  [string]$OutputDir,
  # 恢复指导正文（Markdown）
  [string]$RecoveryDoc,
  # 来源环境状态报告（compare-patches 的输出），用于 MANIFEST 类别 4 的结论
  [string]$SourceReport,
  # 备份范围说明（写进 MANIFEST 元数据区）
  [string]$ScopeNote = '按 dsh-backup 技能六类组件打包',
  [switch]$KeepVerifyCopy
)

[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$ErrorActionPreference = 'Stop'

$stageRoot = Join-Path $WorkDir 'stage'
if (-not $PackageName) {
  $PackageName = (Get-ChildItem $stageRoot -Directory -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Name)
}
if (-not $PackageName) { throw "找不到 staging 子目录：$stageRoot（先跑 build-stage.ps1）" }
$dst = Join-Path $stageRoot $PackageName
if (-not (Test-Path $dst)) { throw "staging 不存在：$dst" }
if (-not $OutputDir) { $OutputDir = Split-Path $WorkDir -Parent }
if (-not $OutputDir) { $OutputDir = $WorkDir }
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
$zip = Join-Path $OutputDir ("{0}.zip" -f $PackageName)
if (-not $RecoveryDoc) { $RecoveryDoc = Join-Path $WorkDir 'manifest-recovery.md' }
if (-not $SourceReport) { $SourceReport = Join-Path $WorkDir 'patch-report.txt' }

# ---------- 采集实测数据 ----------
Write-Output '### 1) 采集 staging 实测数据'
$files = Get-ChildItem $dst -Recurse -Force -File | Where-Object { $_.Name -ne 'MANIFEST.md' }
$totalBytes = ($files | Measure-Object -Property Length -Sum).Sum

function HashRow([string]$rel) {
  $p = Join-Path $dst $rel
  if (-not (Test-Path $p)) { return $null }
  $i = Get-Item $p
  '  - `{0}` —— {1} B, SHA256 `{2}`' -f $rel, $i.Length, (Get-FileHash $p -Algorithm SHA256).Hash
}
function DirStat($rel) {
  $p = Join-Path $dst $rel
  if (-not (Test-Path $p)) { return '（未纳入）' }
  $f = Get-ChildItem $p -Recurse -Force -File
  '{0} 文件 / {1:N2} MB' -f $f.Count, (($f | Measure-Object -Property Length -Sum).Sum / 1MB)
}

# 精确安装版本
$installed = @()
$specifiers = @()
$bundles = @()
$pjPath = Join-Path $dst 'plugins\package.json'
if (Test-Path $pjPath) {
  $pj = Get-Content $pjPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $bundles = @($pj.dsh.profile.bundles)
  $specifiers = @($pj.dependencies.PSObject.Properties | ForEach-Object { '{0}: {1}' -f $_.Name, $_.Value })
}
try {
  $parsed = & pnpm list --depth 0 --json --dir (Join-Path (Join-Path $DshHome 'profiles') $ProfileName) 2>$null | Out-String | ConvertFrom-Json
  foreach ($p in $parsed[0].dependencies.PSObject.Properties | Sort-Object Name) {
    # PowerShell 可能把 version 解析成单元素数组，需显式取首元素
    $item = $p.Value
    if ($item -is [array]) { $item = $item[0] }
    $installed += ('{0}@{1}' -f $p.Name, [string]$item.version)
  }
} catch { $installed += '(pnpm list 失败：原因见运行输出)' }

# 配置提供方
$providerNames = @()
$settingsPath = Join-Path $dst 'config\settings.yaml'
if (Test-Path $settingsPath) {
  $txt = Get-Content $settingsPath -Raw -Encoding UTF8
  $providerNames = @([regex]::Matches($txt, '(?m)^\s{4}([a-z0-9][a-z0-9-]*):\s*$') | ForEach-Object { $_.Groups[1].Value })
}

# skills 清单
$skillsDir = Join-Path $dst 'config\skills'
$skills = if (Test-Path $skillsDir) { @(Get-ChildItem $skillsDir -Directory).Name } else { @() }

# 脚本硬编码绝对路径
$absHits = @()
$scriptsDir = Join-Path $dst 'scripts'
if (Test-Path $scriptsDir) {
  foreach ($f in Get-ChildItem $scriptsDir -File -Force) {
    $hits = @(Select-String -Path $f.FullName -Pattern 'C:/Users/|C:\\Users\\|/Users/|/home/' -AllMatches -ErrorAction SilentlyContinue)
    if ($hits.Count) {
      foreach ($h in $hits) { $absHits += ('scripts/{0}:{1} -> {2}' -f $f.Name, $h.LineNumber, $h.Line.Trim()) }
    } else {
      $absHits += ('scripts/{0}: 无硬编码绝对路径' -f $f.Name)
    }
  }
}

# 本地依赖：源码路径、入口可达性、目录树
$localDeps = @()
$ldRoot = Join-Path $dst 'local-deps'
if (Test-Path $ldRoot) {
  $profileDir = Join-Path (Join-Path $DshHome 'profiles') $ProfileName
  $specMap = @{}
  $pjLive = Join-Path $profileDir 'package.json'
  if (Test-Path $pjLive) {
    (Get-Content $pjLive -Raw -Encoding UTF8 | ConvertFrom-Json).dependencies.PSObject.Properties |
      ForEach-Object { $specMap[$_.Name] = $_.Value }
  }
  foreach ($d in Get-ChildItem $ldRoot -Directory -Force) {
    $meta = Get-Content (Join-Path $d.FullName 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $tree = @(Get-ChildItem $d.FullName -Recurse -Force | Where-Object { -not $_.PSIsContainer } |
      ForEach-Object { $_.FullName.Substring($d.FullName.Length).TrimStart('\') -replace '\\', '/' } | Sort-Object)
    $localDeps += [pscustomobject]@{
      Dir = $d.Name; Name = $meta.name; Version = $meta.version
      Main = $meta.main; Exports = ($meta.exports.PSObject.Properties.Name -join ', ')
      Spec = $specMap[$meta.name]; Tree = $tree
    }
  }
}

# 补丁
$patchDir = Join-Path $dst 'patches'
$patchFiles = if (Test-Path $patchDir) { Get-ChildItem $patchDir -Recurse -Force -File } else { @() }
$sourceConclusion = if (Test-Path $SourceReport) { Get-Content $SourceReport -Raw -Encoding UTF8 } else { $null }

# ---------- 生成 MANIFEST ----------
Write-Output '### 2) 生成 MANIFEST 元数据段'
$md = New-Object System.Text.StringBuilder
function W([string]$s = '') { [void]$md.AppendLine($s) }

W '# DSH 备份清单（MANIFEST）'
W ''
W '> 本文件由 `pack-final.ps1` 对 **staging 实际内容** 实测生成（字节数 / SHA256 / 条目数 / 精确版本 / bundles 均为机器读取值），未誊写检测阶段或旧备份的记录。'
W ''
W '## 元数据（机器生成）'
W ''
W ('- 生成时间：{0}' -f (Get-Date).ToString('yyyy-MM-dd HH:mm:ss zzz'))
W ('- 来源机器：{0} / 用户名：{1}（**仅作溯源，不得照抄进任何命令**）' -f $env:COMPUTERNAME, $env:USERNAME)
$dshVer = '未知'
try { $dshVer = (& dsh --version 2>$null | Select-Object -First 1) } catch { }
if (-not $dshVer) {
  $gp = Join-Path $env:APPDATA 'npm\node_modules\@deepseek-ai\dsh\package.json'
  if (Test-Path $gp) { $dshVer = (Get-Content $gp -Raw -Encoding UTF8 | ConvertFrom-Json).version }
}
$pnpmVer = '未知'; try { $pnpmVer = (& pnpm --version 2>$null | Select-Object -First 1) } catch { }
W ('- 来源 DSH 版本：{0}' -f $dshVer)
W ('- 来源 Node：{0} / pnpm：{1}' -f (& node --version 2>$null), $pnpmVer)
W ('- 包内文件数（不含本文件）：{0}' -f $files.Count)
W ('- 包内总字节数（不含本文件）：{0} B（{1:N2} MB）' -f $totalBytes, ($totalBytes / 1MB))
W ('- 备份范围：{0}' -f $ScopeNote)
W ''
W '## 按类别记录'
W ''
W '### 1. 配置（`config/`、`credentials/`）'
W ''
if (Test-Path $settingsPath) {
  W ('- `config/settings.yaml`：模型提供方 {0} 个{1}' -f $providerNames.Count, $(if ($providerNames.Count) { '（' + ($providerNames -join '、') + '）' } else { '' }))
} else { W '- `config/settings.yaml`：**未纳入**' }
W ('- `config/skills/`：{0}' -f $(if ($skills.Count) { '本地技能 ' + $skills.Count + ' 个 —— ' + ($skills -join '、') } else { '未纳入' }))
if (Test-Path (Join-Path $dst 'credentials\.credentials.yaml')) {
  W '- `credentials/.credentials.yaml`：**包含（明文凭据）**——请妥善保管、勿经不信任渠道传输；恢复后建议收紧文件权限。'
} else { W '- 凭据：**未包含**（默认不打包）' }
W ''
W '### 2. 插件清单（`plugins/`）'
W ''
W '- `plugins/package.json` + `pnpm-lock.yaml` + `pnpm-workspace.yaml` + `cordis.yml` + `cordis.patch.yml`（按实际纳入情况）'
if (Test-Path (Join-Path $dst 'plugins\.dsh-market')) { W '- `plugins/.dsh-market/`：插件市场状态' }
W ('- `dsh.profile.bundles`：**{0} 项**（恢复时按此激活插件）' -f $bundles.Count)
foreach ($b in $bundles) { W ('  - `{0}`' -f $b) }
W ''
if ($specifiers.Count) {
  W '- package.json 声明的依赖（specifier，注意这是 semver 范围而非实际版本）：'
  foreach ($s in $specifiers) { W ('  - {0}' -f $s) }
  W ''
}
W '- **实际安装的精确版本**（`pnpm list --depth 0` 实测，恢复后须逐一核对）：'
foreach ($i in $installed) { W ('  - `{0}`' -f $i) }
W ''
W '> `node_modules` 不随包提供：恢复时 `pnpm install` 按 lock 与上表重建。前提是取证结论为「与官方发布版一致」。'
W ''
W '### 3. 本地依赖源码（`local-deps/`）'
W ''
if ($localDeps.Count) {
  W '这类依赖无法从任何源下载，**必须在 `pnpm install` 之前放置**：'
  W ''
  foreach ($d in $localDeps) {
    W ('- `local-deps/{0}/`（包名 `{1}`{2}）' -f $d.Dir, $d.Name, $(if ($d.Version) { '，版本 ' + $d.Version } else { '' }))
    if ($d.Spec) { W ('  - 来源依赖声明：`{0}`' -f $d.Spec) }
    W ('  - `main` / `exports`：`{0}` / `{1}`' -f $d.Main, $d.Exports)
    W '  - 包内实际文件（层级以此为准）：'
    W '    ```'
    foreach ($t in $d.Tree) { W ('    {0}' -f $t) }
    W '    ```'
    W '  - 放置要求：解压到目标机器任意目录后，把 `plugins/package.json` 中该依赖的 `link:`/`file:` 路径改写为实际位置，并按需建立 Junction / 符号链接。**层级错误时 pnpm 不报错，直到运行时按 exports 解析才失败。**'
  }
} else { W '（本次未纳入本地依赖）' }
W ''
if (Test-Path (Join-Path $dst 'plugins\pnpm-lock.yaml')) {
  W '- **lock 解析一致性**：`pnpm-lock.yaml` 中每个 `file:`/`link:` 依赖的 `specifier` 与 `version` 需与 `package.json` 一致；若不一致（符号链接真实目标被记录），恢复后要核对 `pnpm list` 的实际解析路径，必要时修正 lock。'
}
W ''
W '### 4. 环境补丁'
W ''
if ($patchFiles.Count) {
  W ('- **本包包含 {0} 个补丁文件**（`patches/`），恢复时须按目录结构重新应用：' -f $patchFiles.Count)
  foreach ($pf in ($patchFiles | Select-Object -First 50)) { W ('  - `{0}`' -f $pf.FullName.Substring($dst.Length).TrimStart('\') -replace '\\', '/') }
  W '- 提示：官方升级或重装插件会覆盖这些改动，需保留本清单以便重新应用。'
} else {
  W '- **本包未包含补丁文件。** 判定依据：打包前对 registry 依赖执行「官方 tarball vs 本地已安装包逐文件 SHA256 对比」，结论为内容一致（可重新下载，无需打包）。'
  W '- 若你正在核对本结论，请复核来源环境的取证报告；发现差异时应把差异文件放入 `patches/node_modules/<包名>/<相对路径>` 后重跑打包。'
}
if ($sourceConclusion) {
  W ''
  W '<details><summary>取证原始结论（来源环境）</summary>'
  W ''
  W '```'
  W $sourceConclusion.TrimEnd()
  W '```'
  W ''
  W '</details>'
}
W ''
W '### 5. 自定义脚本、目录与插件状态（`scripts/`、`state/`）'
W ''
$scriptsList = if (Test-Path $scriptsDir) { @(Get-ChildItem $scriptsDir -File -Force).Name } else { @() }
$stateList = if (Test-Path (Join-Path $dst 'state')) { @(Get-ChildItem (Join-Path $dst 'state') -Force).Name } else { @() }
W ('- `scripts/`：{0}' -f $(if ($scriptsList.Count) { $scriptsList -join '、' } else { '未纳入' }))
W ('- `state/`：{0}' -f $(if ($stateList.Count) { $stateList -join '、' } else { '未纳入' }))
W ''
W '- 脚本硬编码绝对路径实测：'
if ($absHits.Count) { foreach ($a in $absHits) { W ('  - {0}' -f $a) } } else { W '  - （未纳入脚本文件）' }
W ''
W '### 6. 数据（`data/`）'
W ''
foreach ($d in @('data/sessions', 'data/storages', 'data/attachments', 'data/synapse')) {
  W ('- `{0}`：{1}' -f $d, (DirStat ($d -replace '/', '\')))
}
W ''
W '## 完整性校验值（机器生成，取打包前 staging 实测值）'
W ''
$hashTargets = @()
foreach ($cand in @('config\settings.yaml', 'config\AGENTS.md', 'credentials\.credentials.yaml',
                    'plugins\package.json', 'plugins\pnpm-lock.yaml', 'plugins\pnpm-workspace.yaml',
                    'plugins\cordis.yml', 'plugins\cordis.patch.yml',
                    'scripts\openrouter-proxy.cjs', 'scripts\openrouter-proxy.cmd')) {
  if (Test-Path (Join-Path $dst $cand)) { $hashTargets += $cand }
}
foreach ($d in $localDeps) {
  foreach ($t in ($d.Tree | Select-Object -First 10)) { $hashTargets += ("local-deps\{0}\{1}" -f $d.Dir, ($t -replace '/', '\')) }
}
foreach ($h in ($hashTargets | Select-Object -Unique)) {
  $row = HashRow $h
  if ($row) { W $row }
}
W ''
W '## 完整文件清单（staging 实测相对路径）'
W ''
W '<details><summary>展开全部相对路径</summary>'
W ''
foreach ($f in ($files | ForEach-Object { $_.FullName.Substring($dst.Length).TrimStart('\') } | Sort-Object)) {
  W ('- `{0}`' -f ($f -replace '\\', '/'))
}
W ''
W '</details>'

$manifestPath = Join-Path $dst 'MANIFEST.md'
[System.IO.File]::WriteAllText($manifestPath, $md.ToString(), (New-Object System.Text.UTF8Encoding($false)))
Write-Output ('  元数据段已写出（{0} 文件 / {1:N2} MB）' -f $files.Count, ($totalBytes / 1MB))

# ---------- 追加恢复指导 ----------
Write-Output '### 3) 追加恢复指导段'
if (Test-Path $RecoveryDoc) {
  $rec = Get-Content $RecoveryDoc -Raw -Encoding UTF8
  [System.IO.File]::AppendAllText($manifestPath, $rec, (New-Object System.Text.UTF8Encoding($false)))
  Write-Output ('  已追加 {0}' -f $RecoveryDoc)
} else {
  $skeleton = @'

## 恢复步骤（**本段缺失，需补齐**）

> 打包时未找到恢复指导正文（`-RecoveryDoc`）。请在来源环境按 dsh-backup 技能补写：
> 恢复执行规范、恢复步骤、恢复完成验证清单、全新环境引导、网络与代理处理、已知差异与常见坑。
> 路径一律用 `$DSH_HOME` 书写（Windows 默认 `%USERPROFILE%\.dsh`，macOS/Linux 默认 `~/.dsh`），
> 不得把来源机器的用户名或盘符写进操作步骤。
'@
  [System.IO.File]::AppendAllText($manifestPath, $skeleton, (New-Object System.Text.UTF8Encoding($false)))
  Write-Warning ('未找到恢复指导正文：{0}（已写入占位骨架）' -f $RecoveryDoc)
}
Write-Output ('  MANIFEST 最终 {0} B / {1} 行' -f (Get-Item $manifestPath).Length, (Get-Content $manifestPath -Encoding UTF8).Count)

# ---------- 打包 ----------
Write-Output '### 4) 打包'
if (Test-Path $zip) { Remove-Item $zip -Force }
$t0 = Get-Date
& tar.exe -a -c -f $zip -C $stageRoot $PackageName
Write-Output ('  耗时 {0:N1}s；ZIP {1:N2} MB' -f ((Get-Date) - $t0).TotalSeconds, ((Get-Item $zip).Length / 1MB))

# ---------- 对账 ----------
Write-Output '### 5) 打包后双向对账'
$dc = Join-Path $WorkDir 'verify'
if (Test-Path $dc) { Remove-Item $dc -Recurse -Force }
New-Item -ItemType Directory -Force -Path $dc | Out-Null
& tar.exe -xf $zip -C $dc
$un = Join-Path $dc $PackageName
$ra = Get-ChildItem $dst -Recurse -Force -File | ForEach-Object { $_.FullName.Substring($dst.Length).TrimStart('\') } | Sort-Object
$rb = Get-ChildItem $un  -Recurse -Force -File | ForEach-Object { $_.FullName.Substring($un.Length).TrimStart('\') }  | Sort-Object
$miss = @($ra | Where-Object { $rb -notcontains $_ })
$extra = @($rb | Where-Object { $ra -notcontains $_ })
Write-Output ('  相对路径：staging {0} / 解压 {1}；缺失 {2}；多余 {3}' -f $ra.Count, $rb.Count, $miss.Count, $extra.Count)
if ($miss.Count -or $extra.Count) {
  $miss | Select-Object -First 20 | ForEach-Object { Write-Output "    - 缺失 $_" }
  $extra | Select-Object -First 20 | ForEach-Object { Write-Output "    + 多余 $_" }
}
$diff = 0
foreach ($f in $ra) {
  $p1 = Join-Path $dst $f; $p2 = Join-Path $un $f
  if (-not (Test-Path $p2)) { continue }
  if ((Get-FileHash $p1 -Algorithm SHA256).Hash -ne (Get-FileHash $p2 -Algorithm SHA256).Hash) { $diff++; Write-Output "    [不一致] $f" }
}
Write-Output ('  逐文件 hash：比对 {0}，不一致 {1}' -f $ra.Count, $diff)

# ---------- 与来源环境复核 ----------
Write-Output '### 6) 与来源环境抽样复核'
$map = @(
  @{ N = 'config\settings.yaml'; S = (Join-Path $DshHome 'settings.yaml') },
  @{ N = 'config\AGENTS.md'; S = (Join-Path $DshHome 'AGENTS.md') },
  @{ N = 'credentials\.credentials.yaml'; S = (Join-Path $DshHome '.credentials.yaml') },
  @{ N = 'plugins\package.json'; S = (Join-Path (Join-Path (Join-Path $DshHome 'profiles') $ProfileName) 'package.json') },
  @{ N = 'plugins\pnpm-lock.yaml'; S = (Join-Path (Join-Path (Join-Path $DshHome 'profiles') $ProfileName) 'pnpm-lock.yaml') }
)
foreach ($s in $scriptsList) { $map += @{ N = ('scripts\' + $s); S = (Join-Path $DshHome $s) } }
$recheck = 0
foreach ($m in $map) {
  $x = Join-Path $un $m.N
  if (-not (Test-Path $x)) { continue }
  if (-not (Test-Path $m.S)) { continue }
  $same = (Get-FileHash $x -Algorithm SHA256).Hash -eq (Get-FileHash $m.S -Algorithm SHA256).Hash
  if (-not $same) { $recheck++ }
  Write-Output ('  [{0}] {1}' -f $(if ($same) { '一致' } else { '不一致（多为运行时可变状态，需判断后重打包）' }), $m.N)
}
foreach ($d in @('sessions', 'storages', 'attachments')) {
  $sd = Join-Path $dst ('data\' + $d); $src = Join-Path $DshHome $d
  if ((Test-Path $sd) -and (Test-Path $src)) {
    $c1 = (Get-ChildItem $sd -Recurse -Force -File).Count
    $c2 = (Get-ChildItem $src -Recurse -Force -File).Count
    if ($c1 -ne $c2) { $recheck++ }
    Write-Output ('  [{0}] data/{1}：包内 {2} / 源 {3}' -f $(if ($c1 -eq $c2) { '一致' } else { '不一致' }), $d, $c1, $c2)
  }
}

if (-not $KeepVerifyCopy -and (Test-Path $dc)) { Remove-Item $dc -Recurse -Force }

$zi = Get-Item $zip
Write-Output ''
Write-Output ('ZIP    = {0}' -f $zi.FullName)
Write-Output ('SIZE   = {0:N2} MB' -f ($zi.Length / 1MB))
Write-Output ('SHA256 = {0}' -f (Get-FileHash $zip -Algorithm SHA256).Hash)
if ($diff -or $miss.Count -or $extra.Count) { Write-Output '对账未通过：请修正后重跑（勿交付）'; exit 1 }
if ($recheck) { Write-Output ('注意：{0} 个抽样项与来源当前状态不一致，请确认是否为运行时可变状态后决定是否重打包' -f $recheck) }
