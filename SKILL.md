---
name: dsh-backup
description: >
  备份与恢复 DeepSeek Harness (DSH) 环境。把环境视为六类组件的集合
  （配置 / 插件 / 本地依赖 / 环境补丁 / 自定义脚本 / 数据），按类别检测、选择、打包、对比、恢复。
  生成跨平台通用、自带 MANIFEST 解释与恢复指导的 ZIP，支持在无 DSH 的新环境按指导安装与恢复。
  当用户说「备份 DSH / 备份配置」、「恢复 DSH / 恢复配置 / 还原环境」、「迁移 DSH / 复刻环境 / 换机器」，或用户提供 dsh-backup-*.zip 备份包文件引用时激活。
---

# DSH 环境备份与恢复

## 环境模型（本技能的统一框架）

DSH 环境 = **六类组件**。备份/恢复的所有操作（检测、选项、清单、对比、恢复）都按这六类组织：

| # | 类别 | 内容 | 检测方式 |
|---|------|------|---------|
| 1 | **配置** | `settings.yaml`、`.credentials.yaml`、`AGENTS.md`、`skills/` 本地技能 | 读文件、列目录 |
| 2 | **插件** | `profiles/web/package.json`（依赖 + bundles）、`pnpm-lock.yaml`、各依赖**实际安装的精确版本** | 读 package.json；`pnpm list --depth 0` 取实际安装精确版本（package.json 里只有 semver 范围） |
| 3 | **本地依赖** | `package.json` 中 `file:`/`link:` 指向的源码目录（如 pet-remielle） | 解析依赖声明并检查路径存在 |
| 4 | **环境补丁** | 对 DSH 及已安装组件的自定义修改，三种形态：① 本地源码目录未提交改动（git status/diff）；② 运行部署层被改文件（全局 `node_modules\@deepseek-ai\dsh` 下 index.html 内联 style、dist CSS/JS 与官方不一致）；③ **已安装插件包内文件被改**（如 `profiles/web/node_modules/dsh-pocket/lib/proxy.mjs` 与官方 tarball 不一致） | ① git 检测；② 对比官方/查内联注入；③ 对候选包 `npm pack <pkg>@<版本>` 下载官方 tarball，解压后与本地文件逐一对比 hash，不一致即补丁。**粒度**：默认只对比用户提及/可疑的包；「全量对比」则遍历 `package.json` 全部依赖逐一对比（需联网，耗时较长） |
| 5 | **自定义脚本、目录与插件状态** | `$DSH_HOME` 下非标准文件与目录（如 `openrouter-proxy.cjs/.cmd`、`debug/`），以及**插件运行时数据目录**（如 `dsh-pocket/` 下的 `token`、`token-lan`、`settings.json` 等登录/密码状态，`bin/` 内**运行时下载的二进制**如 `cloudflared.exe`） | 扫描 `$DSH_HOME` 顶层非标准命名（非 `sessions/storages/synapse/profiles/skills/attachments` 等标准项即视为自定义）；对已知插件状态目录（`dsh-pocket` 等）单独列出并询问是否纳入；状态目录中的二进制需**查证来源**（npm 包内自带 / 运行时下载）并如实记录 |
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
- 2 插件：依赖数、bundles 列表、本地 file:/link: 声明；每个依赖的实际安装精确版本（`pnpm list --depth 0`）。
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

- 建 staging，按所选类别复制（隐藏文件 `-Force`；排除 `node_modules`、`_npmcache`、`.pnpm-store`、`.git`）。复制目录树**一律用 `Copy-Item -Recurse`（POSIX 用 `cp -a`）或按相对路径逐文件落盘**；**禁止 `Get-ChildItem -Recurse | Copy-Item -Destination <目标>` 管道形式**——管道把每个文件单独递给 Copy-Item，递归层级信息丢失，所有子目录文件被静默拍平到目标根。每次目录复制完成后立即比对源与目标的目录层级树（含空目录与嵌套深度），层级不一致即删除刚复制的内容重拷。
- 环境补丁的收集方式（对应三种形态）：
  - 源码未提交改动：`git diff` 导出为 `patches/<repo>-<日期>.patch`（或列出改动清单）。
  - 运行层修改：把被改的文件复制到 `patches/run/` 下（保留原路径结构），并在 MANIFEST 记录「官方应含什么、本地改成了什么」。
  - 插件包内修改：把被改文件复制到 `patches/node_modules/<包名>/<相对路径>`，MANIFEST 记录包名、版本、官方与本地差异；恢复时先确认目标同版本，再重应用。
- 生成 **MANIFEST.md**（见下），写入 staging 根。**MANIFEST 以实际复制进 staging 的内容为准**：打包前核对每类实际文件清单；检测到但复制时已消失（源目录被删等）的项，在 MANIFEST 标注「检测时存在、打包时已消失」，不得虚报已包含。**MANIFEST 必须完整填写下方模板**：含分平台 Node 安装的完整命令（如 `winget install OpenJS.NodeJS.LTS`）、具体代理命令（如 `pnpm config set proxy http://<代理>`）、镜像地址，**不得简写**（如只写「winget/brew/apt」这类省略形式），确保恢复 agent 逐字可执行。
- **元数据一律机器生成**：MANIFEST 中的字节数、hash、时间戳、条目数等元数据，必须在打包**最后一步**用命令对 staging 实际读取后生成，不得誊写检测阶段或先前备份的记录值。MANIFEST 写定之后任何文件再发生变更（改 SKILL.md、补拷文件等），必须重新生成整个元数据段并重新执行下方对账——手写/过期的元数据与内容失实同罪。
- **跨平台书写规范（正文与声称的适用范围必须一致）**：指导正文路径一律以 `$DSH_HOME` 变量加正斜杠书写，并给出各平台默认值（Windows `%USERPROFILE%\.dsh`；macOS/Linux `~/.dsh`）。来源机器的用户名、盘符、`%APPDATA%` 等只允许出现在 MANIFEST 元数据区，不得混入操作步骤。Windows 专属产物（`.cmd`、`.exe`、注册表类）标注「[Windows only]」并同时给出非 Windows 的等效方案或明确「非 Windows 跳过此项」。校验命令优先写语义描述（如「确认 X 存在且 hash 为 Y」「按 main/exports 解析入口可达」），由执行 agent 按所在平台自选工具；确需给命令时同时给 PowerShell 与 POSIX shell 两版。标题或正文声称「任何机器」时，逐条自检内容是否在该范围内成立，不成立就改声明或补齐等效方案。
- **打包后对账（防 MANIFEST 失实，必做）**：写入 MANIFEST 后，必须把「MANIFEST 描述」与「staging 实际内容 + 来源环境」三方核对一遍，重点核查以下高发失实点：
  - **相对路径结构（双向条目 diff）**：把包（或 staging）内全部相对路径清单与来源环境的实际路径清单做**双向 diff**——包内有而来源没有、来源有而包内没有，两个方向的差集都必须为空。只比「文件集合 + 内容 hash」而不比相对路径视为未完成对账：文件内容全对、目录层级错位（如子目录被拍平到根）时 hash 依然一致，恢复却必然失败。
  - **插件实际安装版本**：MANIFEST 版本清单以 `pnpm list --depth 0` 输出为准逐一核对，semver 范围（^x.y.z）不得替代精确版本；同步记录哪些依赖的包内文件与官方 tarball 存在差异（补丁检测③结果）。
  - **bundles 字段**：如实记录「有/无 + 完整列表」。以读 `profiles/web/package.json` 的 `dsh.profile.bundles` 为准，不得凭印象写「无 bundles」。
  - **脚本绝对路径**：对每个纳入的脚本 grep 硬编码绝对路径（Windows 搜 `C:/Users/`、`C:\Users\`；macOS/Linux 搜 `/Users/`、`/home/`）。有则记录**具体文件与位置**（如「openrouter-proxy.cjs 候选路径 2/3 硬编码 `C:/Users/<用户>/AppData/Roaming/npm/...`，恢复时同目录 `npm install https-proxy-agent` 兜底」）；用 `%~dp0`/`$(dirname)` 等相对路径的如实写「无绝对路径，无需改写」。不得笼统写「内部含绝对路径」。
  - **二进制来源**：插件状态目录中的二进制（如 `dsh-pocket/bin/cloudflared.exe`），查证是「npm 包内自带（`pnpm install` 可重装）」还是「运行时下载（首次使用自动拉取，恢复后需联网或手动放置）」——查法：读已安装包目录（`profiles/web/node_modules/<包>/`）是否含该文件。**不得**写「可由 pnpm install 重装」除非确认包内自带。
  - **file: 依赖的 lock 解析一致性**：对每个 `file:` 依赖，读 `pnpm-lock.yaml` 中该依赖的 `version:`/`resolution.directory` 路径，与 package.json 的 specifier 对比。junction/symlink 场景（如 repo 是指向 fork 的链接）下 lock 会记录**链接真实目标**（fork），与 specifier（repo）不一致——此时在 MANIFEST 记录「lock 中该依赖解析为 <真实目标>，与 specifier 不一致（符号链接场景）；恢复时 `pnpm install` 会按 lock 解析到该路径，若与包内 local-deps 不符，需修正 lock 中 N 处路径后重装」，并在恢复验证清单核对实际解析路径。
  对账方法示例（PowerShell）：解压 ZIP 到临时目录后，与 staging、与来源环境对应文件逐文件 `Get-FileHash` 对比，确认零差异；同时导出两侧相对路径清单（`Get-ChildItem -Recurse` 取 FullName 相对化）做双向 diff 确认零差集；`git status` 确认仓库干净。
- 打包 ZIP（`Compress-Archive` / `zip -r`），包名 `dsh-backup-<YYYYMMDD>-<HHMM>.zip`。
- 保存位置：按通用提问规范征求，**选项三个**：「使用默认位置（当前工作空间）/ WebDAV / 自定义路径」。选项文案不要写任何具体目录名（各环境不同）。
  - 选「自定义路径」：提示用户直接输入完整路径，agent 按其输入执行，不得自行假定。
  - 选「WebDAV」：**追加一个提问环节**——询问 WebDAV 地址（完整 URL，含目标根路径）与凭据（用户名/密码或令牌）。**同时在默认位置（当前工作空间）保留一份本地副本**（双输出：本地 + WebDAV，WebDAV 失败时本地仍可用）；选项说明中需向用户提示「选 WebDAV 会在默认位置同时保存一份」。上传流程：**先用 MKCOL 创建 `dsh-backup/` 子目录**（`curl -X MKCOL -u <用户>:<密码> <WebDAV根地址>/dsh-backup`；已存在则忽略 405/301 错误），再 `curl -u <用户>:<密码> -T <文件> <WebDAV根地址>/dsh-backup/<包名>`（或 PowerShell `Invoke-WebRequest -Method Put` 到该路径）；上传后校验远端存在与大小（`curl -I` / HEAD）。凭据只用于本次上传，**不得写入 MANIFEST 或任何备份文件**。
- 校验：条目数、总大小、SHA256；并按「打包后对账」把关键文件（settings.yaml、package.json、pnpm-lock.yaml、patches/、scripts/、state/ 等）的 hash 与来源环境逐一比对，确认一致后才交付。

### 4. MANIFEST.md（按六类记录，自包含）

```markdown
# DSH 备份清单
- 生成时间 / 来源机器 / 用户名 / 来源 DSH 版本
- 按类别记录：
  1. 配置：settings.yaml（模型提供方数）、skills 列表；凭据：包含/不包含
  2. 插件：依赖数、bundles 完整列表、各依赖实际安装精确版本清单（取自 `pnpm list`，不得用 package.json 的 semver 范围冒充）；registry 依赖同时核对包内文件是否与官方 tarball 一致（版本号相同不代表文件未被更改，如 pnpm 重装后补丁文件回退官方版）
  3. 本地依赖：file: 路径清单与放置要求
  4. 环境补丁：检测到的修改清单（源码未提交改动 / 运行层 index.html 内联 style / dist 文件），备份位置（patches/），恢复时如何应用
  5. 脚本：文件名与用途
  6. 数据：是否包含、各目录体积
- 恢复执行规范（**执行本清单时必须遵守**，与 dsh-backup 技能一致；即使没有 skill 本体也照此执行）：
  - **提问驱动**：每个决策点（恢复哪些类别、冲突处理、覆盖/保留/合并、路径重写、凭据）向用户提问并提供选项；DSH 环境用 `ask_user_question`，其他环境用等效提问机制或文本选项（如「A/B/C，回复编号或名称」）等待用户回答，不要自行决定。
  - **保守默认**：覆盖已有文件前必须确认；不删除目标机器任何未涉及的文件；凭据（若含）只用于恢复，不写入日志或额外文件。
  - **每步验证**：安装后验证版本、放置后验证存在、补丁应用后验证在位；全部完成后按「恢复完成验证清单」逐项核对。
- 恢复步骤（跨平台；路径以 `$DSH_HOME` 变量书写，平台差异显式标注）：
  - **跨平台书写规范**：正文所有路径用 `$DSH_HOME` + 正斜杠（Windows 默认 `%USERPROFILE%\.dsh`，macOS/Linux 默认 `~/.dsh`）；来源机器的用户名、盘符只出现在顶部元数据区，不得进入操作步骤；Windows 专属项标「[Windows only]」并给非 Windows 等效或「跳过」说明；校验命令写语义描述，执行 agent 按平台自选工具。
  1. 全新环境引导（见下「全新环境引导」；已有环境则跳过 Node/pnpm/DSH 安装）
  2. 解压本包到目标 $DSH_HOME（或按清单放置）
  3. 重装插件：cd profiles/web && pnpm install（构建脚本被拦截则 pnpm approve-builds --all；GitHub/npm 源不可达时按「网络与代理处理」配置后再装）。**自引用式 file: 依赖（指向 node_modules 内的，如 dsh-web-scroll-fix）必须先放置再执行本步**；外部目录 file: 依赖（如 pet-remielle repo）也建议先放置。若目标机器正在运行 dsh web GUI 且插件含 Electron/vendor 二进制，pnpm 替换插件目录会因文件被进程映射报 ERR_PNPM_EPERM——先停止 GUI 或切换网页模式再装
  4. 本地依赖：按清单放置，必要时改 file: 路径。**自引用式 / file: 本地依赖为高风险项**：MANIFEST 必须列出其完整预期目录树（含子目录层级，对照其 package.json 的 `files`/`main`/`exports`）；放置后核对实际层级与该目录树一致。层级错误时 pnpm 不报错，直到运行时按 exports 解析才失败
  5. 环境补丁：按 patches/ 说明重新应用——运行层：把 patches/run/index.html 中的内联 `<style>…</style>` 注入目标 index.html 的 `<head>`（或直接替换该文件）；插件包内：确认目标安装同版本后，把 patches/node_modules/<包>/<路径> 覆盖到对应位置。官方升级会覆盖，需保留本清单重应用
  6. 插件状态：按清单恢复（如 dsh-pocket 的 token/settings.json）
  7. 环境适配：路径重写（绝对路径替换为当前用户）；代理脚本依赖适配；本地代理（如 sing-box）说明
  8. 凭据说明（若含）；启动 dsh web
- 恢复完成验证清单：
  - `dsh --version` 与来源版本一致（或按用户决策的现有版本）
  - 插件在位且实际安装精确版本与 MANIFEST 版本清单逐一一致（`pnpm list --depth 0` 核对）
  - **file: 依赖实际解析路径与 MANIFEST 记录一致**（`pnpm list` 输出中 `dsh-pet-remielle@file:...` 等路径正确，未被 lock 旧路径带偏）
  - **file: 本地依赖入口可达**：放置后按其 package.json 的 `main`/`exports` 实际解析一次入口（如 `node -e "require.resolve('<包名>')"` 或逐项确认 exports 指向的目标文件存在），并核对目录层级与 MANIFEST 预期目录树一致。文件清单与 hash 一致不代表结构正确，以入口可达为准
  - 补丁在位：目标 index.html 含内联 style；proxy.mjs 等与 patches/ 一致
  - 插件状态已放置（如 dsh-pocket token）
  - 运行时二进制就位（如 dsh-pocket 的 cloudflared.exe 已存在，或首次使用时自动下载成功）
  - `dsh web` 启动、GUI 可访问；异常则重启并硬刷新浏览器（Ctrl+Shift+R）
  - **恢复前创建的旧会话可能看不到新插件工具（会话投影缓存旧）**——新建会话或硬刷新后生效，属正常现象，不必重装
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
- 已有环境 `dsh --version` 与 MANIFEST 来源版本不一致时：向用户提问是否升级（升级可能影响现有配置、需重装插件）或按现有版本继续（部分插件可能不兼容）。
- 全新机器（无 Node）：按 MANIFEST「全新环境引导」安装 Node → pnpm → DSH（按来源版本）；每步验证版本；npm/GitHub 不可达时按「网络与代理处理」配置。
- `$DSH_HOME` 状态：全新 / 已有配置。
- 读取备份包 MANIFEST.md 与包内内容；解压到**固定绝对路径**（建议目标机器上的独立目录，勿用 `$env:TEMP`——不同权限下其解析值不同，权限切换后路径失联）。

### 2. 对比与取舍（按六类逐项提问；同「通用操作规范」的通用提问语义）

- 1 配置冲突：目标已有值 vs 包内值 → 覆盖/保留/合并。
- 2 插件差异：逐项对比目标已装与 MANIFEST 记录——数量（多/少）、实际安装精确版本、包内文件是否被改（patches/ 记录项核 hash；registry 包重装后文件可能回退官方版而版本号不变）→ 说明差异并让用户决定是否对齐。
- 3 本地依赖：目标缺失 → 放置或改路径。
- 4 环境补丁：目标是否有相同修改（检测方法同备份，粒度与备份时一致：单包或全量对比）→ 已有则跳过/覆盖；没有则应用，并提示「官方升级会覆盖，需保留补丁记录」。
- 5 脚本与插件状态：放置 + 依赖适配（如代理脚本的 https-proxy-agent）；插件状态目录（如 dsh-pocket token）恢复，避免重新初始化；若含运行时下载二进制（cloudflared.exe 等），确认其就位或可联网下载。
- 6 数据：可选恢复。
- 环境适配（统一处理，逐项确认）：路径重写（绝对路径替换旧用户名）；代理脚本 require 绝对路径重写；本地代理（如 sing-box）说明与 `OPENROUTER_PROXY` 覆盖；GitHub 依赖源不可达时的代理/镜像处理。

### 3. 恢复执行

按用户选择逐一执行：全新环境引导（若需）→ 路径/环境适配 → 放置文件（**自引用式 file: 本地依赖如 dsh-web-scroll-fix 必须在本步先放置**）→ 重装插件（pnpm install + approve-builds；**若目标机器正运行 dsh web GUI 且插件含 Electron/vendor 二进制，pnpm 会因文件被进程映射报 ERR_PNPM_EPERM——先停 GUI 或切换网页模式再装**）→ 其余本地依赖 → 补丁应用 → 插件状态恢复 → 脚本适配 → 凭据（若含且确认）。每完成一项汇报。

### 4. 验证

关键文件就位检查 + **目录层级与入口可达验证**（file:/自引用依赖按 `main`/`exports` 实际解析一次，层级对照 MANIFEST 预期目录树）；提示重启 `dsh web`；硬刷新浏览器一并提示。

---

## 常见坑（恢复失败的最常见原因）

- `file:` 本地依赖源码缺失（第 3 类）——恢复时优先检查。
- 环境补丁被官方升级覆盖（第 4 类）——补丁记录要保留、恢复后重应用。
- 凭据丢失（第 1 类）——默认不打包，需用户显式选择。
- 代理脚本依赖绝对路径（第 5 类）——新环境需单独安装依赖或改 require。
- **pnpm install 报 ERR_PNPM_EPERM（重命名/删除插件目录失败）**——插件含 Electron/vendor 二进制且 dsh web GUI 正在运行（进程映射文件）；先停 GUI 或切网页模式再装。
- **file: 依赖被 pnpm-lock.yaml 旧路径带偏**——符号链接场景下 lock 记录链接真实目标，与 package.json specifier 不一致；恢复后核对 `pnpm list` 实际解析路径，必要时修正 lock。
- **恢复前创建的旧会话看不到新插件工具**——会话投影缓存旧，新建会话或硬刷新（Ctrl+Shift+R）后生效，不是安装失败。
- **MANIFEST 与内容失实**（任何类别）——恢复 agent 只信 MANIFEST 会误判（如把「无 bundles」当真而漏配插件激活、把「无绝对路径」当真而不改路径、把「可 pnpm 重装」当真而漏放二进制）。生成时必须按「打包后对账」逐条核对。
- 插件状态中的运行时下载二进制（如 cloudflared.exe）未就位（第 5 类）——`pnpm install` 不会重装它；恢复后需联网自动下载或手动放置，网络受限时功能不可用。
- 全新机器安装链断裂（无 Node / npm/GitHub 源不可达）——按「全新环境引导」与「网络与代理处理」逐步验证，每步确认后再继续。
- **打包复制把子目录拍平**——`Get-ChildItem -Recurse | Copy-Item` 管道写法丢失层级，文件内容与 hash 全对但相对路径错位，恢复后 `main`/`exports` 解析失败。用 `Copy-Item -Recurse` / `cp -a`，复制后比对目录树。
- **MANIFEST 元数据过期**——字节数、时间戳等手写/誊写字段在内容更新后未同步，严格对账的恢复 agent 必然判失实。元数据只在打包最后一步机器生成，内容再变即重新生成。
- **指导声称跨平台却 Windows 特化**——正文硬编码 `C:\Users\<用户>`、`%APPDATA%`、`.cmd` 脚本会让其他平台 agent 卡住或误执行。路径用 `$DSH_HOME` 变量、平台专属项显式标注并给等效方案。
