# dsh-backup

> DeepSeek Harness (DSH) 环境备份与恢复技能。**JSON 契约 + Node 单文件执行器 + 由契约渲染的 Markdown。**

把 DSH 环境视为**六类组件**（配置 / 插件 / 本地依赖 / 环境补丁 / 自定义脚本与状态 / 数据），按类别检测、选择、打包、恢复。导出的包是自包含的：一个 `manifest.json`（唯一事实源）+ 由它渲染的 `MANIFEST.md` + 原始文件，另一个 agent 仅凭包就能恢复。

## 为什么是这个形态

- **契约用 JSON**：可被 schema 校验、可结构化合并（配置层按 entry key：override 的 `id`、`insert:` 列表的被插入 `id` 集合）、可 diff、可重放。YAML 只作为**载荷**原样搬运，不参与格式转换。
- **执行器用 Node**：DSH 自身要求 Node ≥ 22.19，「能跑 DSH 的机器必然有 Node」，所以它不是额外依赖。一份 `.mjs` 三端同跑，零第三方依赖。
- **计划与执行分离**：`plan` 只读地产出 `plan.json`，agent 审阅后 `apply --apply` 才写盘，覆盖前一律 `.bak-<时间戳>`。

## 安装

把 `SKILL.md`、`bin/`、`lib/`、`schema/` 放到 DSH 技能目录：

```sh
mkdir -p ~/.dsh/skills/dsh-backup
cp -r SKILL.md bin lib schema ~/.dsh/skills/dsh-backup/
```

DSH 会实时监听技能目录，新会话即可使用。

## 用法

```sh
node bin/dsh-backup.mjs --help

# 备份
node bin/dsh-backup.mjs detect --json --out env.json
node bin/dsh-backup.mjs size --work ./w
node bin/dsh-backup.mjs patchscan --work ./w --export ./w/patches
node bin/dsh-backup.mjs patchscan --work ./w --registry https://registry.npmmirror.com   # registry fallback
node bin/dsh-backup.mjs stage --work ./w --categories 1,2,3,4,5,6 --include-credentials   # 含类别 4 时自动 patchscan
node bin/dsh-backup.mjs doc  --pkg ./w/stage/<包名> --out ./w/manifest-recovery.md
node bin/dsh-backup.mjs pack --pkg ./w/stage/<包名> --out ./out
DSH_WEBDAV_USER=... DSH_WEBDAV_PASSWORD=... node bin/dsh-backup.mjs upload --file ./out/*.zip --url '<WebDAV 根>' --sub-dir Backup

# 恢复
node bin/dsh-backup.mjs plan --pkg <解压后的包> --out plan.json
node bin/dsh-backup.mjs apply --plan plan.json          # dry-run
node bin/dsh-backup.mjs apply --plan plan.json --apply  # 执行
node bin/dsh-backup.mjs verify --pkg <解压后的包>
```

**退出码**：`0` 成功 / `1` 错误 / `20` 验收失败 / `30` 环境缺失。`--json` 时 stdout 只有一个 JSON 文档，诊断走 stderr。

## 契约

| 文件 | 位置 | 说明 |
|---|---|---|
| `manifest.json` | 包内 | 唯一事实源；结构见 `schema/manifest.schema.json` |
| `MANIFEST.md` | 包内 | 由 manifest 渲染，人/agent 阅读；不手写 |
| `plan.json` | 恢复时生成 | 针对目标机的具体计划，含 `decisions[]`；结构见 `schema/plan.schema.json` |

## 开发

```sh
node --test          # patch 合并 + plan/apply/verify 集成测试
```

## 要求

- **Node ≥ 22.19**（与 DSH 一致；DSH 的 zstd 能力依赖它）
- 系统 `tar`（Windows 10+ 自带 bsdtar；macOS/Linux 用系统 tar），脚本自动探测
- 备份/恢复需要网络（npm registry / GitHub）时按 MANIFEST 的网络与代理处理配置

## License

MIT
