---
name: dsh-backup
description: >
  备份与恢复 DeepSeek Harness (DSH) 环境。把环境视为六类组件的集合
  （配置 / 插件 / 本地依赖 / 环境补丁 / 自定义脚本 / 数据），按类别检测、选择、打包、对比、恢复。
  生成跨平台通用、自带 MANIFEST 解释与恢复指导的 ZIP，支持在无 DSH 的新环境按指导安装与恢复。
  当用户说「备份 DSH / 备份配置」、「恢复 DSH / 恢复配置 / 还原环境」、「迁移 DSH / 复刻环境 / 换机器」时激活。
---

# DSH 环境备份与恢复

## 环境模型（本技能的统一框架）

DSH 环境 = **六类组件**。备份/恢复的所有操作（检测、选项、清单、对比、恢复）都按这六类组织：

| # | 类别 | 内容 | 检测方式 |
|---|------|------|---------|
| 1 | **配置** | `settings.yaml`、`.credentials.yaml`、`AGENTS.md`、`skills/` 本地技能 | 读文件、列目录 |
| 2 | **插件** | `profiles/web/package.json`（依赖 + bundles）、`pnpm-lock.yaml` | 读 package.json |
| 3 | **本地依赖** | `package.json` 中 `file:`/`link:` 指向的源码目录（如 pet-remielle） | 解析依赖声明并检查路径存在 |
| 4 | **环境补丁** | 对 DSH 及已安装组件的自定义修改，三种形态：① 本地源码目录未提交改动（git status/diff）；② 运行部署层被改文件（全局 `node_modules\@deepseek-ai\dsh` 下 index.html 内联 style、dist CSS/JS 与官方不一致）；③ **已安装插件包内文件被改**（如 `profiles/web/node_modules/dsh-pocket/lib/proxy.mjs` 与官方 tarball 不一致） | ① git 检测；② 对比官方/查内联注入；③ 对候选包 `npm pack <pkg>@<版本>` 下载官方 tarball，解压后与本地文件逐一对比 hash，不一致即补丁。**粒度**：默认只对比用户提及/可疑的包；「全量对比」则遍历 `package.json` 全部依赖逐一对比（需联网，耗时较长） |
| 5 | **自定义脚本、目录与插件状态** | `$DSH_HOME` 下非标准文件与目录（如 `openrouter-proxy.cjs/.cmd`、`debug/`），以及**插件运行时数据目录**（如 `dsh-pocket/` 下的 `token`、`token-lan`、`settings.json` 等登录/密码状态） | 扫描 `$DSH_HOME` 顶层非标准命名（非 `sessions/storages/synapse/profiles/skills/attachments` 等标准项即视为自定义）；对已知插件状态目录（`dsh-pocket` 等）单独列出并询问是否纳入 |
| 6 | **数据** | `sessions/`、`storages/`、`synapse/`、`attachments/` | 统计体积 |

## 通用操作规范（两种模式都必须遵守）

1. **提问驱动（跨 agent 通用）**：每个决策点都向用户提问并提供选项，不让用户写大段文字。**实现方式随运行环境**：DSH 用 `ask_user_question`（结构化选项）；其他 agent 若没有同名工具，用其等效提问机制（permission prompt / 对话框），或直接以文本列出选项（如「A/B/C，回复编号或名称」）等待用户选择。**本 skill 内所有「提问」均指此通用语义**，不依赖任何特定工具名。
2. **固定套路**：备份 = 检测 → 选项 → 打包 → 校验；恢复 = 检测 → 对比 → 恢复 → 验证。流程不变。
3. **保守默认**：凭据默认不打包（选择后提示加密/私传）；覆盖已有文件前必须确认；恢复过程中不删除目标机器任何未涉及文件。
4. **执行纪律**：文件复制与打包用前台命令；确需后台时，完成后必须校验 staging 非空、ZIP 存在且条目数 > 0。
5. **权限处理**：输出到工作区外（如 `~/Documents`）可能被沙箱拒绝——按默认执行，被拒后用更宽权限（danger-full-access）重试同一命令并说明原因。
6. **ZIP 通用性**：打包统一 ZIP（Windows 资源管理器/PowerShell、macOS Finder、Linux zip/unzip 均原生支持）。个别精简环境缺命令行 `unzip` 时，用 PowerShell `Expand-Archive`、Python `python -m zipfile -e`，或图形界面双击解压，均无需额外安装。

---

## 备份模式

### 1. 环境检测（只读，按六类）

逐类检测并产出「环境状态报告」：
- DSH 版本：`dsh --version`（失败则读 npm 全局 `@deepseek-ai/dsh/package.json`）。
- 1 配置：`settings.yaml` 存在与模型提供方数量；`skills/` 技能列表。
- 2 插件：依赖数、bundles 列表、本地 file:/link: 声明。
- 3 本地依赖：每个 `file:` 路径是否存在。
- 4 环境补丁：
  - 源码：`$DSH_HOME` 下疑似 DSH 源码目录（如 `deepseek-harness`）的 `git status --short` / `git diff --name-only`。
  - 运行层：读全局 `dsh-web-frontend\dist\index.html` 检测内联 `<style>...overflow...</style>` 等非官方注入；dist CSS/JS 文件名与官方 hash 对比（不一致即疑似被改）。
- 5 脚本：`openrouter-proxy.*` 等。
- 6 数据：各目录体积（MB）。

### 2. 备份选项（提问，多选；按「通用操作规范」的提问语义）

按六类给选项，每项带说明与体积，**并在选项最前提供「全选」快捷选项**（一次性选择全部类别与凭据）：
- （快捷）**全选**（1-6 全部 + 凭据）
- 1 配置（推荐）
- 2 插件清单（推荐）
- 3 本地依赖源码（推荐，不备则无法重装）
- 4 **环境补丁**（若检测到修改：推荐；说明「含 N 处自定义修改，恢复时重新应用」。补丁检测③需**联网** `npm pack` 对比官方包；提问中说明两种粒度：默认单包（只对比用户提及/可疑的包）/ **全量对比**（遍历全部依赖逐一对比，耗时较长、保证完整）——由用户选择）
- 5 **自定义脚本、目录与插件状态**（推荐；说明含插件状态目录如 dsh-pocket 的 token/密码时，恢复后免重新初始化）
- 6 数据（可选，按需）

默认推荐 1+2+3+4+5；6 与凭据由用户决定。

### 3. 执行打包

- 建 staging，按所选类别复制（隐藏文件 `-Force`；排除 `node_modules`、`_npmcache`、`.pnpm-store`、`.git`）。
- 环境补丁的收集方式（对应三种形态）：
  - 源码未提交改动：`git diff` 导出为 `patches/<repo>-<日期>.patch`（或列出改动清单）。
  - 运行层修改：把被改的文件复制到 `patches/run/` 下（保留原路径结构），并在 MANIFEST 记录「官方应含什么、本地改成了什么」。
  - 插件包内修改：把被改文件复制到 `patches/node_modules/<包名>/<相对路径>`，MANIFEST 记录包名、版本、官方与本地差异；恢复时先确认目标同版本，再重应用。
- 生成 **MANIFEST.md**（见下），写入 staging 根。**MANIFEST 以实际复制进 staging 的内容为准**：打包前核对每类实际文件清单；检测到但复制时已消失（源目录被删等）的项，在 MANIFEST 标注「检测时存在、打包时已消失」，不得虚报已包含。
- 打包 ZIP（`Compress-Archive` / `zip -r`），包名 `dsh-backup-<YYYYMMDD>-<HHMM>.zip`。
- 保存位置：按通用提问规范征求，**选项三个**：「使用默认位置（当前工作空间）/ WebDAV / 自定义路径」。选项文案不要写任何具体目录名（各环境不同）。
  - 选「自定义路径」：提示用户直接输入完整路径，agent 按其输入执行，不得自行假定。
  - 选「WebDAV」：**追加一个提问环节**——询问 WebDAV 地址（完整 URL，含目标目录路径）与凭据（用户名/密码或令牌）。**同时在默认位置（当前工作空间）保留一份本地副本**（双输出：本地 + WebDAV，WebDAV 失败时本地仍可用）；选项说明中需向用户提示「选 WebDAV 会在默认位置同时保存一份」。上传：`curl -u <用户>:<密码> -T <文件> <WebDAV地址>/<包名>`（或 PowerShell `Invoke-WebRequest -Method Put`）；上传后校验远端存在与大小（`curl -I` / HEAD）。凭据只用于本次上传，**不得写入 MANIFEST 或任何备份文件**。
- 校验：条目数、总大小、SHA256。

### 4. MANIFEST.md（按六类记录，自包含）

```markdown
# DSH 备份清单
- 生成时间 / 来源机器 / 用户名 / 来源 DSH 版本
- 按类别记录：
  1. 配置：settings.yaml（模型提供方数）、skills 列表；凭据：包含/不包含
  2. 插件：依赖数、bundles 完整列表
  3. 本地依赖：file: 路径清单与放置要求
  4. 环境补丁：检测到的修改清单（源码未提交改动 / 运行层 index.html 内联 style / dist 文件），备份位置（patches/），恢复时如何应用
  5. 脚本：文件名与用途
  6. 数据：是否包含、各目录体积
- 恢复执行规范（**执行本清单时必须遵守**，与 dsh-backup 技能一致；即使没有 skill 本体也照此执行）：
  - **提问驱动**：每个决策点（恢复哪些类别、冲突处理、覆盖/保留/合并、路径重写、凭据）向用户提问并提供选项；DSH 环境用 `ask_user_question`，其他环境用等效提问机制或文本选项（如「A/B/C，回复编号或名称」）等待用户回答，不要自行决定。
  - **保守默认**：覆盖已有文件前必须确认；不删除目标机器任何未涉及的文件；凭据（若含）只用于恢复，不写入日志或额外文件。
  - **每步验证**：安装后验证版本、放置后验证存在、补丁应用后验证在位；全部完成后按「恢复完成验证清单」逐项核对。
- 恢复步骤（任何 agent / 任何机器）：
  1. 全新环境引导（见下「全新环境引导」；已有环境则跳过 Node/pnpm/DSH 安装）
  2. 解压本包到目标 $DSH_HOME（或按清单放置）
  3. 重装插件：cd profiles/web && pnpm install（构建脚本被拦截则 pnpm approve-builds --all；GitHub/npm 源不可达时按「网络与代理处理」配置后再装）
  4. 本地依赖：按清单放置，必要时改 file: 路径
  5. 环境补丁：按 patches/ 说明重新应用——运行层：把 patches/run/index.html 中的内联 `<style>…</style>` 注入目标 index.html 的 `<head>`（或直接替换该文件）；插件包内：确认目标安装同版本后，把 patches/node_modules/<包>/<路径> 覆盖到对应位置。官方升级会覆盖，需保留本清单重应用
  6. 插件状态：按清单恢复（如 dsh-pocket 的 token/settings.json）
  7. 环境适配：路径重写（绝对路径替换为当前用户）；代理脚本依赖适配；本地代理（如 sing-box）说明
  8. 凭据说明（若含）；启动 dsh web
- 恢复完成验证清单：
  - `dsh --version` 与来源版本一致
  - 插件在位（`pnpm list` 或 node_modules 确认，含本地依赖）
  - 补丁在位：目标 index.html 含内联 style；proxy.mjs 等与 patches/ 一致
  - 插件状态已放置（如 dsh-pocket token）
  - `dsh web` 启动、GUI 可访问；异常则重启并硬刷新浏览器（Ctrl+Shift+R）
- 全新环境引导（目标机器无 Node / 无 DSH 时）：
  - 检测顺序：node --version → dsh --version → pnpm（corepack pnpm --version）
  - 安装 Node：Windows 用 winget install OpenJS.NodeJS.LTS 或官网安装包；macOS 用 brew install node；Linux 用 apt/apt-get install nodejs npm（或 nvm）。目标 Node >= 22.19（node:zlib 的 zstd 需要）
  - 启用 pnpm：corepack enable pnpm（若 corepack 需联网拉 pnpm 且失败，改用 npm install -g pnpm）
  - 安装 DSH：**按来源版本** `npm install -g @deepseek-ai/dsh@<来源版本>`
  - 每步安装后验证版本再继续
- 网络与代理处理（npm registry / GitHub 不可达时）：
  - pnpm：`pnpm config set https-proxy http://<代理>` / `pnpm config set proxy http://<代理>`（或 `--store-dir` 前先配置）
  - npm：`npm config set proxy http://<代理>` / `npm config set https-proxy http://<代理>`
  - 或改用国内镜像源：npm `--registry https://registry.npmmirror.com`；pnpm `--registry` 同；GitHub 依赖（如 github: 形式的插件）不可达时配置代理，或用镜像/手动放置源码
- 取舍/注意：备份时已知差异、绝对路径清单、补丁与官方版本的关系、插件状态清单
```

---

## 恢复模式

### 1. 目标环境检测

- 检测链：`node --version` → `dsh --version` → `corepack pnpm --version`。
- 全新机器（无 Node）：按 MANIFEST「全新环境引导」安装 Node → pnpm → DSH（按来源版本）；每步验证版本；npm/GitHub 不可达时按「网络与代理处理」配置。
- `$DSH_HOME` 状态：全新 / 已有配置。
- 读取备份包 MANIFEST.md 与包内内容。

### 2. 对比与取舍（按六类逐项提问；同「通用操作规范」的通用提问语义）

- 1 配置冲突：目标已有值 vs 包内值 → 覆盖/保留/合并。
- 2 插件差异：目标已装 vs 包内（多/少/版本）→ 说明并让用户决定是否对齐。
- 3 本地依赖：目标缺失 → 放置或改路径。
- 4 环境补丁：目标是否有相同修改（检测方法同备份，粒度与备份时一致：单包或全量对比）→ 已有则跳过/覆盖；没有则应用，并提示「官方升级会覆盖，需保留补丁记录」。
- 5 脚本与插件状态：放置 + 依赖适配（如代理脚本的 https-proxy-agent）；插件状态目录（如 dsh-pocket token）恢复，避免重新初始化。
- 6 数据：可选恢复。
- 环境适配（统一处理，逐项确认）：路径重写（绝对路径替换旧用户名）；代理脚本 require 绝对路径重写；本地代理（如 sing-box）说明与 `OPENROUTER_PROXY` 覆盖；GitHub 依赖源不可达时的代理/镜像处理。

### 3. 恢复执行

按用户选择逐一执行：全新环境引导（若需）→ 路径/环境适配 → 放置文件 → 重装插件（pnpm install + approve-builds）→ 本地依赖 → 补丁应用 → 插件状态恢复 → 脚本适配 → 凭据（若含且确认）。每完成一项汇报。

### 4. 验证

关键文件就位检查；提示重启 `dsh web`；硬刷新浏览器（Ctrl+Shift+R）一并提示。

---

## 常见坑（恢复失败的最常见原因）

- `file:` 本地依赖源码缺失（第 3 类）——恢复时优先检查。
- 环境补丁被官方升级覆盖（第 4 类）——补丁记录要保留、恢复后重应用。
- 凭据丢失（第 1 类）——默认不打包，需用户显式选择。
- 代理脚本依赖绝对路径（第 5 类）——新环境需单独安装依赖或改 require。
- 全新机器安装链断裂（无 Node / npm/GitHub 源不可达）——按「全新环境引导」与「网络与代理处理」逐步验证，每步确认后再继续。
