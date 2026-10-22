---
name: dsh-backup
description: >
  备份与恢复 DeepSeek Harness (DSH) 环境。把环境视为六类组件的集合
  （配置 / 插件 / 本地依赖 / 环境补丁 / 自定义脚本与状态 / 数据），按类别检测、取证、选择、打包、对比、恢复。
  导出为「JSON 契约 + 渲染出的 MANIFEST.md」的自包含包，恢复端用同一份 Node 脚本按计划执行。
  当用户说「备份 DSH / 备份配置」、「恢复 DSH / 恢复配置 / 还原环境」、「迁移 DSH / 复刻环境 / 换机器」，或用户提供 dsh-backup-*.zip 备份包文件引用时激活。
---

# DSH 环境备份与恢复

## 设计：契约与执行器分离

| 层 | 是什么 | 谁消费 |
|---|---|---|
| `manifest.json` | 包内**唯一事实源**：profile / bundles / 配置层 entry / 依赖 / 凭据 / 补丁 / 数据 / 校验值 / 声明式恢复步骤 | 恢复端脚本、另一个 agent、任何工具 |
| `MANIFEST.md` | **由 manifest.json 渲染**的叙述版 | 人、agent |
| `plan.json` | 恢复时针对**目标机**生成的计划（含待决策项） | agent 审阅后执行 |
| `bin/dsh-backup.mjs` | 执行器：**Node 单文件、零第三方依赖、三端同一份** | 本机 shell |

两条硬规则：**数字只来自实测**（manifest.json 由脚本对 staging 实测生成，MANIFEST.md 只从它渲染）；**执行器不猜**（缺信息产出 `decisions[]` 让 agent 去问）。

为什么是 Node：DSH 自身要求 **Node ≥ 22.19**，所以「能跑 DSH 的机器必然有 Node」——它不是额外依赖，而是问题域的不变量。bash 在 Windows 不存在、PowerShell 在裸 Linux 不存在、Python 在 Windows 不保证。

## 环境模型（六类组件）

| # | 类别 | 内容 | 检测与取证方式 |
|---|------|------|---------------|
| 1 | **配置** | 每个 profile 的**用户配置层** `profiles/<名>/cordis.patch.yml`；`AGENTS.md`；5 处技能根下的技能；顶层凭据类文件 | `detect`：读文件、列目录；统计 patch 层 `- id:` 条目数；技能**两种形态都认** |
| 2 | **插件** | 逐 profile：`package.json`（依赖 + `dsh.profile.bundles`）、lock、workspace、`cordis.yml`、`compatibility.json`、**精确安装版本** | `pnpm list --depth 0 --json`，取不到回退读 `node_modules/<包>/package.json` |
| 3 | **本地依赖** | `file:`/`link:` 指向的源码目录 | 解析声明、确认目录/Junction/符号链接、记录真实目标 |
| 4 | **环境补丁** | ① 源码未提交改动 ② 部署层被改文件 ③ **插件包内文件被改** ④ profile 里的补丁留档 | ①② 看 `detect` 线索；③ `patchscan` 逐文件比官方 tarball；④ profile 非标准项枚举 |
| 5 | **脚本、目录与插件状态** | `$DSH_HOME` 顶层非标准项；插件运行时数据 | 列顶层全部条目；二进制须**查证来源** |
| 6 | **数据** | `sessions/`、`storages/`、`synapse/`、`attachments/v1/` | 体积与文件数 + **数据格式版本** |

**路径变量**：`$DSH_HOME`（Windows `%USERPROFILE%\.dsh`，macOS/Linux `~/.dsh`）、`$DSH_AGENTS_HOME`（默认 `~/.agents`）。

**profile 是备份的单位**：`$DSH_HOME/profiles/` 下可有任意多个 profile，另有共享的 `profiles/node_modules/`。**只处理一个 profile 会静默漏掉其余**。

**技能根有 5 处**：项目级 `<项目>/.dsh/skills`、项目级 `<项目>/.agents/skills`、自定义目录、用户级 `$DSH_HOME/skills`、用户级 `$DSH_AGENTS_HOME/skills`。

## 运行时规则

| 规则 | 内容 |
|------|------|
| **用户配置只在 patch 层** | `profiles/<名>/cordis.patch.yml` 是顶层 YAML 数组，元素为 loader patch entry，**在全部 bundle 层之后应用**且热加载。`cordis.yml` 只是空入口清单。恢复**按 entry `id` 合并**，绝不整文件覆盖 |
| **profile 固定清单** | `package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`、`cordis.yml`、`cordis.patch.yml`、`compatibility.json`、`.dsh-market/`、`node_modules/`；其余都是「非标准项」 |
| **DSH CLI** | `dsh [--profile] <名>`；`dsh plugin --profile <名> <pnpm 参数…>`（首次使用初始化 profile，**已存在文件一律不动**）；`--from-default-profile` 会**覆盖**；`--dump-config` 核对组合结果 |
| **插件版本兼容** | 插件 `engines.dsh`（无则看 `\@deepseek-ai/dsh*` peer）不满足时**阻止安装与激活**；补救是换版本或 `dsh plugin allow-version` 授精确版本豁免（先告知风险） |
| **凭据优先级 4 层** | `$DSH_HOME/.credentials.yaml` > 进程环境变量 > `<调用目录>/.env` > `$DSH_HOME/.env` |
| **附件路径** | `$DSH_HOME/attachments/v1` |
| **部署层前端产物** | `require.resolve('@deepseek-ai/dsh-web-frontend/package.json')` + `/dist/index.html`，不要写死嵌套路径 |
| **数据格式** | `sessions/`、`storages/` 版本化，跨版本恢复前先确认目标能读来源 |

## 命令速查

唯一入口 `bin/dsh-backup.mjs`。全局：`--home`、`--agents-home`、`--json`、`--help`。

| 子命令 | 写盘 | 作用 |
|---|---|---|
| `detect` | 否 | 六类只读盘点 → Markdown / `--json` |
| `size` | 只写探测 ZIP | 文件数 / 原始体积 / 压缩后 / 压缩率 / 耗时 |
| `stage` | 写 staging | 按六类复制，每类复制后立即双向校验 |
| `doc` | 是 | 生成恢复指导骨架 |
| `pack` | 是 | 写 `manifest.json` + `MANIFEST.md` → ZIP → **解压回读对账** |
| `patchscan` | 是（下载） | 逐 profile 与官方 tarball 逐文件 SHA256 对比；`--export` 导出差异；**registry 失败自动 fallback**（默认 npm 配置 → npmmirror → npmjs，也可 `--registry` 显式给链） |
| `upload` | 远端写 | PROPFIND → MKCOL → PUT → **PROPFIND 核长度** |
| `plan` | 否（可 `--out`） | 包 vs 目标 → `plan.json`（含 `decisions[]`） |
| `apply` | **默认 dry-run** | `--apply` 才写盘；覆盖前备份 `.bak-<时间戳>` |
| `verify-staging` | 否 | 复核 staging 与来源环境（agent 手工改过 staging、或间隔较久后打包前跑） |
| `verify` | 否 | 目标机验收；失败退出码 20 |

**退出码**：`0` 成功 / `1` 错误 / `20` 验收失败 / `30` 环境缺失。**`--json` 时 stdout 只有一个 JSON 文档**，诊断走 stderr。

## 通用操作规范

1. **提问驱动**：每个决策点都向用户提问并给选项（DSH 用 `ask_user_question`，其他 agent 用等效机制）。
2. **固定套路**：备份 = 检测 → 取证 → 选项 → 打包 → 对账 → 交付；恢复 = 检测 → 对比 → 执行 → 验证。
3. **保守默认**：凭据默认不打包；覆盖前必须确认；恢复不删除目标机器未涉及的文件。
4. **只给选项、不下结论**：用实测数字说话。
5. **执行纪律**：复制与打包用前台命令；完成后校验 staging 非空、ZIP 存在且条目数 > 0。
6. **权限处理**：沙箱拒绝时用更宽权限重试同一条命令并说明原因；包管理器缓存被拒时把缓存指到工作区内。
7. **ZIP 通用性**：三端都有 `tar`，执行器自动探测并检查退出码，失败即抛错。
8. **凭据卫生**：口令只用于本次操作，不写进 MANIFEST 或任何备份文件。

---

## 备份模式

### 1. 环境检测（只读）

```bash
node bin/dsh-backup.mjs detect --json --out env-report.json
```

必须有：版本链、**profile 枚举**、逐 profile 的 patch 条目数与模型提供方、bundles、精确版本、`engines.dsh` 要求、profile 非标准项、本地依赖、顶层点文件、数据体积。

### 2. 插件补丁取证

```bash
node bin/dsh-backup.mjs patchscan --work <WorkDir> --export <WorkDir>/patches
# 大陆网络不稳时可显式给 registry 链（按顺序尝试，成功即止）
node bin/dsh-backup.mjs patchscan --work <WorkDir> --export <WorkDir>/patches \
  --registry "https://registry.npmmirror.com,https://registry.npmjs.org"
```

原则：**与官方发布版一致的不打包**。三类差异：内容不一致（真补丁）/ 官方有本地无（可疑删改）/ 本地有官方无（多为安装产物）。结论写进 MANIFEST（对比了哪些包、多少文件、差异数）。

### 3. 备份选项（提问，多选）

按六类给选项，每项带实测体积，最前给「全选」，默认推荐 1+2+3+4+5。

`node_modules` 是否打包用数字说话：

```bash
node bin/dsh-backup.mjs size --work <WorkDir>
```

给出每个 `node_modules` 的文件数 / 原始体积 / 压缩后 / 压缩率 / 耗时，再让用户选：不打包（默认，需联网重装）或打包（离线，但包体大一到两个数量级，且仍替代不了类别 3）。

### 4. 凭据 / 顶层点文件

判据是「**能不能重新生成**」，不是「在不在名单里」。顶层**全部点文件**都是候选，逐个判定。默认不打包；用户要求完全复刻时逐个点名询问。纳入时（`--include-credentials`）自动生成 `credentials/CREDENTIALS-SOURCES.txt`（`来源文件名 | 包内位置 | 恢复目标`）。包内 `credentials/` 只是分类，**恢复目标都在 `$DSH_HOME` 根目录**。未纳入的项在 MANIFEST 对应类别里逐条写「文件名 + 用途 + 恢复影响」。

### 5. 执行打包

```bash
$W = '<可写工作目录>'
node bin/dsh-backup.mjs stage --work $W --categories 1,2,3,4,5,6 --include-credentials
node bin/dsh-backup.mjs doc   --pkg $W/stage/<包名> --out $W/manifest-recovery.md
node bin/dsh-backup.mjs pack  --pkg $W/stage/<包名> --out <交付目录>
node bin/dsh-backup.mjs upload --file <交付目录>/dsh-backup-*.zip --url '<WebDAV 根>' --sub-dir dsh-backup
# 凭据优先读环境变量，避免落在命令行里：DSH_WEBDAV_USER / DSH_WEBDAV_PASSWORD
```

WebDAV 要点（实测过真实 NAS）：

- **根目录常常不接受 PUT**（返回 405），文件只能写进已存在的子目录 → 用 `--sub-dir` 指向一个已存在、可写的集合。
- `MKCOL` 返回 405 时脚本会用 PROPFIND 复核：目录确实不存在 → 明确报错让你先建目录（服务器可能禁止建目录）。
- 存在性一律用 PROPFIND 核 `getcontentlength`，不要用 HEAD（部分服务对 HEAD 返回 404 而文件存在）。
- 删历史包必须 `--delete-remote <文件名>` 逐个点名；DELETE 成功是 `204`。

**staging 布局**：

```text
config/<profile>/cordis.patch.yml   用户配置层
config/AGENTS.md
config/skills/                      $DSH_HOME/skills
config/agents-skills/               $DSH_AGENTS_HOME/skills
config/project-skills/<项目>/<根>/
config/legacy-settings/             历史遗留配置（仅溯源）
plugins/<profile>/{package.json,pnpm-lock.yaml,pnpm-workspace.yaml,cordis.yml,compatibility.json}
plugins/<profile>/.dsh-market/
local-deps/<profile>/<包目录>/
patches/                            patchscan 的 --export 产物
patches/profile-extra/<profile>/    profile 内非标准项（补丁留档）+ PROFILE-EXTRAS.txt
credentials/                        凭据 + CREDENTIALS-SOURCES.txt
state/ scripts/                     顶层非标准项（目录 → state，文件 → scripts）
data/{sessions,storages,attachments,synapse}/
```

要点：复制后立即**双向校验**（相对路径集合 + 逐文件 SHA256，不一致直接抛错）；排除 `node_modules`、缓存、`.git`、运行时生成物（`.dsh-module-fallback`、`.plugin-manager`、`thinking-effort-loaded.json`）；profile 里的补丁留档单列并逐条登记；恢复指导骨架由 `doc` 生成，agent 只补 `TODO` 处叙述。

`pack` 必然做：写 `manifest.json` → 渲染 `MANIFEST.md` → 打 ZIP → **解压回读双向对账**（缺失/多余/不一致都必须为 0）→ 写 `<zip>.sha256`。对账不过退出 20，不产出可交付包。

---

## 恢复模式

### 1. 目标环境检测

检测链 `node --version`（必须 22.19+）→ `dsh --version` → `pnpm --version`；读包内 `manifest.json`（没有就由目录推导），解压到**固定绝对路径**。目标 DSH 与来源不同 → 进 `decisions[]`，先问用户。

### 2. 对比与取舍

```bash
node bin/dsh-backup.mjs plan --pkg '<解压后的包>' --out plan.json
```

`plan.json` 给出：配置层**新增 / 冲突 / 仅目标有**、技能逐条 `add|update|same`、凭据逐条状态、本地依赖 spec 改写、补丁是否已生效、数据文件数，以及 `decisions[]`（凭据、数据、DSH 版本差异）。逐项问用户，选择通过 `--include-credentials` / `--restore-data` / `--strategy` 回到计划。

### 3. 恢复执行

```bash
node bin/dsh-backup.mjs apply --plan plan.json            # dry-run
node bin/dsh-backup.mjs apply --plan plan.json --apply    # 真正执行
```

顺序（脚本强制）：**配置层按 id 合并 → 技能 → 凭据 → 本地依赖落盘并改写 spec → 安装插件 → 补丁 → 脚本与状态 → 数据**。覆盖前改名 `.bak-<时间戳>`；插件走 `dsh plugin --profile <名> install`（GUI 运行中会 `ERR_PNPM_EPERM`，先停 GUI）；凭据落盘后收紧到 0600。

### 4. 验证

```bash
node bin/dsh-backup.mjs verify --pkg '<解压后的包>' --out verify.md
```

核对：bundles 覆盖与依赖已安装、**包内每条 entry id 都在目标且 hash 一致**、技能名在位、凭据 hash、补丁 hash、本地依赖已链接、数据文件数。失败退出码 20。再人工补核入口可达与 `dsh web` 可访问。

---

## 常见坑

### 备份端

- **用户配置被当成不存在**——配置只在 `profiles/<名>/cordis.patch.yml`。
- **只处理一个 profile**——静默漏掉其余 profile。
- **技能根漏扫**——漏 `$DSH_AGENTS_HOME/skills` 与项目级；漏单文件 `<名字>.md`。
- **忽略 profile 里的补丁留档**——如 `dsh-ops-patch-<日期>/`。
- **子目录被拍平**——执行器用「相对路径集合 + 逐文件 hash」兜住；自定义脚本照做。
- **MANIFEST 手写或过期**——数字必须由 `pack` 实测生成。
- **记录不完整**——未纳入项要写「文件名 + 用途 + 恢复影响」。
- **运行时可变状态混进快照**——插件写回 `cordis.patch.yml`（窗口坐标等）；判断性质后重跑 `pack`。
- **WebDAV 用 HEAD 判存在**——部分服务返回 404 而文件存在；一律用 PROPFIND 核 `getcontentlength`。

### 恢复端

- **整文件覆盖 `cordis.patch.yml`**——抹掉目标自有条目；必须按 id 合并。
- **先装插件后放本地依赖**——顺序反了解析失败。
- **`file:`/`link:` 层级错误**——pnpm 不报错，运行时才失败；要验入口可达。
- **凭据放错位置**——包内 `credentials/` 只是分类，目标是 `$DSH_HOME` 根。
- **`engines.dsh` 不兼容**——阻止安装/激活；换版本或授豁免。
- **跨版本覆盖数据**——先确认数据格式兼容。
- **`ERR_PNPM_EPERM`**——先停 GUI。
- **全新机器**——先装 Node 22.19+ 再装 DSH，不要跳步。

### 指导撰写

- **声称跨平台却平台特化**——路径统一用 `$DSH_HOME`，平台专属项标注并给等效方案。
- **把叙述当数字**——能由 `manifest.json` 渲染的就不要手写。
