# dsh-backup

> DeepSeek Harness (DSH) 环境备份与恢复技能（Agent Skill）。

把 DSH 环境视为**六类组件**的集合（配置 / 插件 / 本地依赖 / 环境补丁 / 自定义脚本与插件状态 / 数据），按类别检测、选择、打包、对比、恢复。生成**跨平台通用、自带 MANIFEST 自包含恢复指导**的 ZIP，支持在无 DSH 的新环境按指导安装与恢复。

## 特性

- **六类环境模型**：备份/恢复的检测、选项、清单、对比、恢复都按六类组织
- **环境补丁检测**（三种形态）：
  - 本地源码目录未提交改动（git）
  - 运行部署层被改文件（index.html 内联 style / dist 与官方对比）
  - **已安装插件包内文件被改**（`npm pack` 下载官方 tarball 逐一对比 hash，支持单包 / 全量两种粒度）
- **全新环境引导**：无 Node / 无 DSH 的机器，按 MANIFEST 指导安装 Node（分平台）→ pnpm → **按来源版本**安装 DSH
- **网络与代理处理**：npm/pnpm 代理配置、镜像源、GitHub 依赖处理
- **插件状态恢复**：如 dsh-pocket 的 token / 密码，恢复后免重新初始化
- **自包含 MANIFEST**：含六类清单、恢复步骤、全新环境引导、网络处理、**恢复执行规范**（提问驱动 / 保守默认 / 每步验证）与验证清单——**任何 agent（DSH / Claude Code / Codex 等）仅凭 MANIFEST 即可完整恢复**
- **跨 agent 通用**：提问驱动不依赖特定工具名（DSH 用 `ask_user_question`，其他环境用等效方式）
- **保存位置三选项**：默认工作空间 / WebDAV（双输出：本地 + 远端）/ 自定义路径
- **配套脚本**（`assets/`）：把 SKILL.md 里的硬约束做成可直接执行的 PowerShell 脚本——补丁逐文件取证、staging 构建与即时校验、独立复核、元数据实测生成 + 打包 + 解压回读对账。全部参数化，不写死任何机器路径。

## 安装

把本仓库的 `SKILL.md` 与 `assets/` 一起放到 DSH 的技能目录：

```sh
# 方式一：直接放入
mkdir -p ~/.dsh/skills/dsh-backup
cp SKILL.md ~/.dsh/skills/dsh-backup/
cp -r assets ~/.dsh/skills/dsh-backup/

# 方式二：作为插件（可选，若需随插件管理）
dsh plugin --profile web add github:<your-org>/dsh-backup
```

DSH 会实时监听技能目录，新会话即可使用（无需重启）。

## 配套脚本（`assets/`）

| 脚本 | 环节 | 作用 |
|------|------|------|
| `compare-patches.ps1` | 补丁取证 | 取实际安装精确版本 → `npm pack` 官方 tarball → 逐文件 SHA256 对比，输出「内容被改 / 官方有本地无 / 本地有官方无」三类差异；`-ExportPatches` 可直接导出补丁目录 |
| `build-stage.ps1` | 建 staging | 按六类复制，每类复制后立即双向校验（防子目录被拍平）；自动解析 `file:`/`link:` 依赖的真实目标；默认排除 `node_modules`、运行时生成物与疑似凭据文件 |
| `verify-stage.ps1` | 独立复核 | 整树路径双向 diff + hash 比对 + 本地依赖 `main`/`exports` 入口可达性 |
| `pack-final.ps1` | 打包与对账 | MANIFEST 元数据全部实测生成 → 追加恢复指导 → 打 ZIP → 解压回读双向对账 → 与来源环境抽样复核 → 输出 SHA256 |

脚本为 PowerShell（Windows 与装了 `pwsh` 的 macOS/Linux 均可运行）；非 PowerShell 环境可按 SKILL.md 的语义描述用本机工具等效实现。

## 使用

对 DSH（或任何加载了本技能的 agent）说：

- 「备份 DSH / 备份配置」→ 备份模式
- 「恢复 DSH / 恢复配置 / 还原环境」→ 恢复模式
- 「迁移 DSH / 复刻环境 / 换机器」→ 自动进入对应模式

### 备份模式

1. **环境检测**：按六类只读检测，产出环境状态报告（含补丁检测）
2. **选项提问**：六类 + 凭据（含「全选」快捷选项）
3. **打包**：`compare-patches` → `build-stage` → `verify-stage` → `pack-final`（默认工作空间 / WebDAV / 自定义）
4. **校验**：条目数、大小、SHA256、解压回读双向对账

### 恢复模式

1. **目标环境检测**：Node → DSH → pnpm 检测链；全新机器按引导安装
2. **对比取舍**：按六类逐项提问（覆盖 / 保留 / 合并 / 路径重写）
3. **恢复执行**：引导 → 适配 → 放置 → 重装插件 → 依赖 → 补丁 → 插件状态 → 脚本 → 凭据
4. **验证**：按清单核对版本 / 插件 / 补丁 / 状态 / GUI

## MANIFEST 自包含

备份包内的 `MANIFEST.md` 是**自包含恢复指导**：包含六类清单、恢复步骤、全新环境引导、网络与代理处理、**恢复执行规范**（提问驱动 / 保守默认 / 每步验证）与恢复完成验证清单。目标机器上即使**没有本技能**、用任何 agent，仅凭 `MANIFEST.md` 也能正确执行完整恢复。

## 要求

- DeepSeek Harness 0.1.x（备份端）；恢复端不限（任何能执行 shell 的 agent 环境）
- 打包使用 ZIP（主流系统原生支持）
- 备份与恢复需要网络（npm registry / GitHub）时，按 MANIFEST 的网络与代理处理配置

## License

MIT
