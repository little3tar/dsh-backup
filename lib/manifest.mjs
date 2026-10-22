/**
 * manifest.json 的构建与渲染。
 *
 * 原则：manifest.json 是唯一事实源；MANIFEST.md 与恢复指导**只能由它渲染**，
 * 不允许手写 —— 否则文档与包内容迟早对不上。
 */

import fs from 'node:fs'
import path from 'node:path'
import { hashFile, walkFiles, treeStat, statPath, exists, joinRel, versionOf, spawnCmd } from './core.mjs'
import { parsePatch, entryHashes } from './patch.mjs'

export const GENERATOR = { name: 'dsh-backup', version: '3.0.0' }

/** 源码里不写反引号：Markdown 行内代码与代码围栏都由这两个助手生成 */
const BT = String.fromCharCode(96)
export const FENCE = BT + BT + BT
export const ic = s => BT + s + BT

/** 列出 staging 里出现过的 profile */
export function listProfiles(pkgDir) {
  const names = new Set()
  for (const sub of ['config', 'plugins']) {
    const dir = joinRel(pkgDir, sub)
    if (!exists(dir)) continue
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue
      if (['skills', 'agents-skills', 'project-skills', 'legacy-settings'].includes(ent.name)) continue
      names.add(ent.name)
    }
  }
  return [...names].sort()
}

/** 精确安装版本：优先 pnpm list，失败回退读 node_modules/<包>/package.json */
export function collectInstalled(profileDir) {
  if (!exists(profileDir)) return { source: null, list: [] }
  try {
    const r = spawnCmd('pnpm', ['list', '--depth', '0', '--json', '--dir', profileDir])
    if (r.status === 0 && r.stdout && r.stdout.trim() && r.stdout.trim() !== '{}') {
      const parsed = JSON.parse(r.stdout)
      const deps = parsed[0]?.dependencies ?? {}
      const list = Object.entries(deps).map(([name, v]) => ({ name, version: String(v?.version ?? v) }))
      if (list.length) return { source: 'pnpm list --depth 0 --json', list: list.sort((a, b) => a.name.localeCompare(b.name)) }
    }
  } catch { /* 回退 */ }
  const nm = path.join(profileDir, 'node_modules')
  const list = []
  if (exists(nm)) {
    for (const ent of fs.readdirSync(nm, { withFileTypes: true })) {
      if (!ent.isDirectory() || ent.name.startsWith('.')) continue
      const pj = path.join(nm, ent.name, 'package.json')
      if (!exists(pj)) continue
      try {
        const o = JSON.parse(fs.readFileSync(pj, 'utf8'))
        list.push({ name: ent.name, version: String(o.version ?? '未知') })
      } catch { /* 坏包跳过 */ }
    }
  }
  return { source: list.length ? 'node_modules/<包>/package.json（pnpm 不可用时的回退）' : null, list }
}

/** 声明式恢复步骤（目标无关，路径用 $DSH_HOME 占位） */
export function restoreSteps(manifest) {
  const steps = []
  for (const p of manifest.profiles) {
    if (!p.configLayer) continue
    steps.push({
      op: 'merge-yaml-array-by-key', key: 'id',
      from: p.configLayer.file,
      to: '$DSH_HOME/profiles/' + p.name + '/cordis.patch.yml',
      policy: 'keep-target-only',
      note: '同 id 用包内值覆盖，目标独有条目保留；不要整文件覆盖',
    })
  }
  for (const s of manifest.skills) {
    const to = s.root === 'user-agents' ? '$DSH_AGENTS_HOME/skills' : '$DSH_HOME/skills'
    steps.push({ op: 'copy', from: s.dir, to, kind: 'dir', note: '技能根：' + s.root })
  }
  if (manifest.credentials.length) {
    steps.push({ op: 'copy-credentials', from: 'credentials/', registry: 'credentials/CREDENTIALS-SOURCES.txt', note: '逐条按登记表落回 $DSH_HOME 根目录；明文，注意传输渠道' })
  }
  for (const d of manifest.localDeps) {
    steps.push({
      op: 'copy',
      from: 'local-deps/' + d.profile + '/' + d.dir,
      to: '$DSH_HOME/profiles/local-deps/' + d.profile + '/' + d.dir,
      kind: 'dir',
      note: '本地依赖 ' + d.name + '：落盘后把 profile 的 package.json 里 file:/link: 改成 link:<目标路径>',
    })
  }
  for (const p of manifest.profiles) {
    steps.push({ op: 'install-plugins', profile: p.name, command: 'dsh plugin --profile ' + p.name + ' install', note: '必须在本地依赖落盘与 spec 改写之后' })
  }
  if (manifest.patches.length) steps.push({ op: 'apply-patches', from: 'patches/', note: '按 patches/<profile>/<包>/<相对路径> 覆盖已安装包' })
  if (manifest.data.length) steps.push({ op: 'restore-data', from: 'data/', note: '覆盖前确认；先确认目标版本能读来源版本的数据格式' })
  return steps
}

/** 由 staging 目录构建 manifest 对象 */
export function buildManifest(opts) {
  const { pkgDir, homeDir, categories, credentials: includeCredentials, scopeNote } = opts
  const profiles = listProfiles(pkgDir).map(name => {
    const pjPath = joinRel(pkgDir, 'plugins/' + name + '/package.json')
    let bundles = []
    let declared = []
    if (exists(pjPath)) {
      const pj = JSON.parse(fs.readFileSync(pjPath, 'utf8'))
      bundles = pj?.dsh?.profile?.bundles ?? []
      declared = Object.entries(pj?.dependencies ?? {}).map(([n, s]) => ({ name: n, spec: String(s) }))
    }
    const patchPath = joinRel(pkgDir, 'config/' + name + '/cordis.patch.yml')
    let configLayer = null
    if (exists(patchPath)) {
      const parts = parsePatch(fs.readFileSync(patchPath, 'utf8'))
      const hashes = entryHashes(parts)
      configLayer = {
        file: 'config/' + name + '/cordis.patch.yml',
        entries: parts.entries.map(e => ({ id: e.id, sha256: hashes.get(e.id) })),
        unkeyed: parts.unkeyed.length,
      }
    }
    return { name, bundles, declared, configLayer, installed: collectInstalled(joinRel(homeDir, 'profiles/' + name)) }
  })

  const skills = []
  for (const [root, dir] of [['user-dsh', 'config/skills'], ['user-agents', 'config/agents-skills']]) {
    const abs = joinRel(pkgDir, dir)
    if (!exists(abs)) continue
    const names = fs.readdirSync(abs, { withFileTypes: true }).filter(e => e.isDirectory() || e.name.endsWith('.md')).map(e => e.name).sort()
    skills.push({ root, dir, names })
  }
  const projRoot = joinRel(pkgDir, 'config/project-skills')
  if (exists(projRoot)) {
    for (const proj of fs.readdirSync(projRoot, { withFileTypes: true })) {
      if (!proj.isDirectory()) continue
      for (const sub of fs.readdirSync(path.join(projRoot, proj.name), { withFileTypes: true })) {
        if (!sub.isDirectory()) continue
        const rel = 'config/project-skills/' + proj.name + '/' + sub.name
        const names = fs.readdirSync(joinRel(pkgDir, rel), { withFileTypes: true }).filter(e => e.isDirectory() || e.name.endsWith('.md')).map(e => e.name).sort()
        if (names.length) skills.push({ root: 'project:' + proj.name + '/' + sub.name, dir: rel, names })
      }
    }
  }

  const localDeps = []
  const ldRoot = joinRel(pkgDir, 'local-deps')
  if (exists(ldRoot)) {
    for (const pd of fs.readdirSync(ldRoot, { withFileTypes: true })) {
      if (!pd.isDirectory()) continue
      for (const d of fs.readdirSync(path.join(ldRoot, pd.name), { withFileTypes: true })) {
        if (!d.isDirectory()) continue
        const pj = path.join(ldRoot, pd.name, d.name, 'package.json')
        const meta = exists(pj) ? JSON.parse(fs.readFileSync(pj, 'utf8')) : {}
        localDeps.push({ profile: pd.name, dir: d.name, name: meta.name ?? d.name, version: meta.version ?? null, main: meta.main ?? null })
      }
    }
  }

  const credentials = []
  const reg = joinRel(pkgDir, 'credentials/CREDENTIALS-SOURCES.txt')
  if (exists(reg)) {
    for (const line of fs.readFileSync(reg, 'utf8').split(/\r?\n/)) {
      if (!line.trim() || line.trim().startsWith('#')) continue
      const parts = line.split(/\s*\|\s*/)
      if (parts.length < 4) continue
      credentials.push({ source: parts[1], packed: parts[2], target: parts[3], sha256: hashFile(joinRel(pkgDir, parts[2])) })
    }
  }

  const patches = []
  const patDir = joinRel(pkgDir, 'patches')
  if (exists(patDir)) {
    for (const rel of walkFiles(patDir, { includeNodeModules: true })) {
      if (path.basename(rel) === 'PROFILE-EXTRAS.txt') continue
      const segs = rel.split('/')
      // profile-extra 是「补丁留档」，不作为可应用的补丁记录
      if (segs[0] === 'profile-extra') {
        patches.push({ profile: segs[1] ?? null, package: null, archive: true, path: 'patches/' + rel, sha256: hashFile(joinRel(patDir, rel)) })
        continue
      }
      // 新布局 patches/<profile>/node_modules/<包>/<相对路径>；@scope 占两段
      let i = 1
      let pkgSegs = []
      if (segs[i] === 'node_modules') i++
      if (segs[i] && segs[i].startsWith('@')) pkgSegs = [segs[i], segs[i + 1]]
      else if (segs[i]) pkgSegs = [segs[i]]
      patches.push({ profile: segs[0], package: pkgSegs.filter(Boolean).join('/') || null, path: 'patches/' + rel, sha256: hashFile(joinRel(patDir, rel)) })
    }
  }

  const data = []
  for (const name of ['sessions', 'storages', 'attachments', 'synapse']) {
    const st = treeStat(joinRel(pkgDir, 'data/' + name))
    if (st.exists) data.push({ name, files: st.files, bytes: st.bytes })
  }

  const files = walkFiles(pkgDir, { includeNodeModules: true }).filter(rel => rel !== 'MANIFEST.md' && rel !== 'manifest.json')
  const entries = files.map(rel => {
    const st = statPath(joinRel(pkgDir, rel))
    return { path: rel, bytes: st.bytes, sha256: hashFile(joinRel(pkgDir, rel)) }
  })
  const totalBytes = entries.reduce((s, e) => s + e.bytes, 0)

  const manifest = {
    schemaVersion: '1',
    generator: GENERATOR,
    createdAt: new Date().toISOString(),
    source: {
      platform: process.platform,
      dsh: versionOf('dsh'),
      node: versionOf('node'),
      pnpm: versionOf('pnpm'),
      machine: process.env.COMPUTERNAME ?? process.env.HOSTNAME ?? null,
      user: process.env.USERNAME ?? process.env.USER ?? null,
      note: 'machine/user 仅作溯源，不得写进任何恢复命令',
    },
    scope: {
      // 类别按包内实际内容推导，避免 CLI 旗标与包内容不一致
      categories: (() => {
        const has = rel => exists(joinRel(pkgDir, rel))
        const found = []
        if (has('config')) found.push('1')
        if (has('plugins')) found.push('2')
        if (has('local-deps')) found.push('3')
        if (has('patches')) found.push('4')
        if (has('state') || has('scripts')) found.push('5')
        if (has('data')) found.push('6')
        return found.length ? found : categories
      })(),
      // 以「包里实际有没有登记表」为准，避免 CLI 旗标与包内容不一致
      credentials: exists(joinRel(pkgDir, 'credentials/CREDENTIALS-SOURCES.txt')) || Boolean(includeCredentials),
      profiles: profiles.map(p => p.name),
      note: scopeNote ?? null,
    },
    profiles, skills, localDeps, credentials, patches, data,
    integrity: { files: entries.length, bytes: totalBytes, sha256Index: entries },
  }
  manifest.restore = { steps: restoreSteps(manifest) }
  return manifest
}

function fmtSize(bytes) {
  if (bytes == null) return '未统计'
  if (bytes >= 1024 ** 3) return (bytes / 1024 ** 3).toFixed(2) + ' GB'
  if (bytes >= 1024 ** 2) return (bytes / 1024 ** 2).toFixed(2) + ' MB'
  if (bytes >= 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return bytes + ' B'
}

/** 渲染 MANIFEST.md */
export function renderManifestMd(m, { recoveryDoc = null } = {}) {
  const L = []
  const w = (s = '') => L.push(s)
  w('# DSH 备份清单（MANIFEST）')
  w('')
  w('> 本文件由 ' + ic('manifest.json') + ' **渲染**生成，数字全部来自打包时的实测值；不要手工修改。')
  w('')
  w('## 元数据')
  w('')
  w('- 生成时间：' + m.createdAt)
  w('- 生成器：' + m.generator.name + ' ' + m.generator.version)
  w('- 来源机器：' + (m.source.machine ?? '未知') + ' / ' + (m.source.user ?? '未知') + '（**仅作溯源，不得照抄进任何命令**）')
  w('- 来源 DSH：' + (m.source.dsh ?? '未知') + '；Node：' + (m.source.node ?? '未知') + '；pnpm：' + (m.source.pnpm ?? '未知'))
  w('- 覆盖 profile：' + (m.scope.profiles.join('、') || '（无）'))
  w('- 类别：' + m.scope.categories.join(',') + '；凭据：' + (m.scope.credentials ? '包含' : '不包含'))
  w('- 包内文件数：' + m.integrity.files + '；总字节：' + m.integrity.bytes + '（' + fmtSize(m.integrity.bytes) + '）')
  w('')
  w('## 按类别记录')
  w('')
  w('### 1. 配置（用户配置层按 entry id 合并）')
  w('')
  for (const p of m.profiles) {
    if (!p.configLayer) { w('- profile ' + ic(p.name) + '：包内无配置层'); continue }
    w('- profile ' + ic(p.name) + '：' + ic(p.configLayer.file) + '，' + p.configLayer.entries.length + ' 条 entry')
    if (p.configLayer.entries.length) w('  - entry id：' + p.configLayer.entries.map(e => e.id).join('、'))
    w('  - 恢复目标：' + ic('$DSH_HOME/profiles/' + p.name + '/cordis.patch.yml') + '；**按 entry ' + ic('id') + ' 合并，不要整文件覆盖**')
  }
  for (const s of m.skills) w('- 技能根 ' + ic(s.root) + '（' + ic(s.dir) + '）：' + s.names.length + ' 个 —— ' + s.names.join('、'))
  if (!m.skills.length) w('- 技能：未纳入')
  w('')
  w('### 2. 插件清单')
  w('')
  for (const p of m.profiles) {
    w('- profile ' + ic(p.name) + '：bundles ' + p.bundles.length + ' 项；依赖声明 ' + p.declared.length + ' 个')
    if (p.bundles.length) w('  - bundles：' + p.bundles.map(b => ic(b)).join('、'))
    if (p.installed.source) w('  - 精确版本来源：' + p.installed.source + '（' + p.installed.list.length + ' 个）')
  }
  w('')
  w('### 3. 本地依赖')
  w('')
  if (m.localDeps.length) {
    for (const d of m.localDeps) w('- profile ' + ic(d.profile) + ' / ' + ic('local-deps/' + d.profile + '/' + d.dir + '/') + '（包名 ' + ic(d.name) + (d.version ? '，版本 ' + d.version : '') + '）')
    w('- 放置：解压到目标机任意目录后，把 profile 的 ' + ic('package.json') + ' 里对应声明改成 ' + ic('link:<该目录>') + '，再安装')
  } else w('（本次未纳入）')
  w('')
  w('### 4. 环境补丁')
  w('')
  if (m.patches.length) {
    w('- 共 ' + m.patches.length + ' 个补丁文件：')
    for (const p of m.patches.slice(0, 50)) w('  - ' + ic(p.path))
    w('- 恢复：按 ' + ic('patches/<profile>/node_modules/<包>/<相对路径>') + ' 覆盖到已安装包（与 node_modules 同构，scope 也天然正确）；' + ic('profile-extra/') + ' 下的留档不自动应用')
  } else w('- 未包含补丁文件（取证结论为与官方发布版一致）')
  w('')
  w('### 5. 凭据 / 点文件')
  w('')
  if (m.credentials.length) {
    w('| 来源文件 | 包内位置 | 恢复目标 |')
    w('|---|---|---|')
    for (const c of m.credentials) w('| ' + ic(c.source) + ' | ' + ic(c.packed) + ' | ' + ic(c.target) + ' |')
    w('')
    w('> 明文凭据，仅经可信渠道传输；恢复后按需收紧权限。')
  } else w('- 未纳入（默认不打包）')
  w('')
  w('### 6. 数据')
  w('')
  if (m.data.length) for (const d of m.data) w('- ' + ic(d.name) + '：' + d.files + ' 文件 / ' + fmtSize(d.bytes) + '（覆盖前确认）')
  else w('- 未纳入')
  w('')
  w('## 完整性校验值')
  w('')
  w(FENCE + 'json')
  w(JSON.stringify(m.integrity.sha256Index, null, 2))
  w(FENCE)
  w('')
  w('## 完整文件清单')
  w('')
  w('<details><summary>展开全部相对路径</summary>')
  w('')
  for (const f of m.integrity.sha256Index) w('- ' + ic(f.path))
  w('')
  w('</details>')
  w('')
  if (recoveryDoc) {
    w(recoveryDoc.replace(/\s+$/, ''))
    w('')
  } else {
    w('## 恢复步骤')
    w('')
    w('见 ' + ic('manifest.json') + ' 的 ' + ic('restore.steps') + '；可用 ' + ic('dsh-backup plan') + ' 生成针对目标机器的具体计划。')
    w('')
  }
  return L.join('\n')
}

/** 渲染「恢复指导」段 */
export function renderRecoveryDoc(m) {
  const L = []
  const w = (s = '') => L.push(s)
  w('## 恢复步骤（本段由 manifest.json 实测内容生成）')
  w('')
  w('> 数字来自打包时实测值；标有 **TODO** 的地方需要按来源环境补写叙述（绝对路径、端口、代理）。')
  w('')
  w('### 0. 这次备份里有什么')
  w('')
  w('- 来源 DSH：' + (m.source.dsh ?? '未知') + '；Node：' + (m.source.node ?? '未知') + '；pnpm：' + (m.source.pnpm ?? '未知'))
  w('- 覆盖 profile：' + m.profiles.map(p => p.name + '（bundles ' + p.bundles.length + ' 项 / 用户配置 ' + (p.configLayer?.entries.length ?? 0) + ' 条）').join('、'))
  w('- 技能：' + (m.skills.map(s => s.root + ' ' + s.names.length + ' 个').join(' / ') || '未纳入'))
  w('- 本地依赖：' + (m.localDeps.map(d => d.name + '（' + d.profile + '）').join('、') || '无'))
  w('- 凭据 / 点文件：' + m.credentials.length + ' 个')
  w('- 补丁文件：' + m.patches.length + ' 个')
  w('- 数据：' + (m.data.length ? m.data.map(d => d.name + '（' + d.files + ' 文件）').join('、') : '未纳入'))
  w('')
  w('### 1. 目标环境检测与引导')
  w('')
  w('1. 检测链：' + ic('node --version') + ' → ' + ic('dsh --version') + ' → ' + ic('pnpm --version') + '；无 Node 走文末「全新环境引导」。')
  w('2. 目标 DSH 应与来源 ' + (m.source.dsh ?? '（未知）') + ' 一致；不一致先与用户确认升级还是按现有版本继续。')
  w('3. 解压到**固定绝对路径**（不要用临时目录）。')
  w('')
  w('### 2~9. 按 manifest.restore.steps 执行')
  w('')
  w('每一步都是声明式操作，' + ic('dsh-backup plan') + ' 会针对目标机把它解析成具体动作并指出冲突：')
  w('')
  w(FENCE + 'json')
  w(JSON.stringify(m.restore.steps, null, 2))
  w(FENCE)
  w('')
  w('> 手工执行时的关键顺序：**用户配置层按 id 合并 → 技能 → 凭据 → 本地依赖落盘并改 spec → 安装插件 → 补丁 → 状态 → 数据**。')
  w('')
  w('## 恢复完成验证清单')
  w('')
  w('- [ ] ' + ic('dsh --version') + ' 与来源版本一致（或按决策的版本）')
  w('- [ ] 每个 profile 的 ' + ic('pnpm list --depth 0') + ' 与 manifest.json 的 ' + ic('installed') + ' 一致')
  w('- [ ] 每个 profile 的 ' + ic('cordis.patch.yml') + ' 已按 ' + ic('id') + ' 合并，目标自有条目未丢失')
  w('- [ ] ' + ic('file:/link:') + ' 依赖按 ' + ic('main/exports') + ' 能解析到入口')
  w('- [ ] 补丁在位（逐文件 sha256）')
  w('- [ ] 凭据就位且 sha256 与 manifest.json 一致')
  w('- [ ] ' + ic('dsh web') + ' 可访问；旧会话看不到新插件工具时新建会话或硬刷新')
  w('')
  w('## 全新环境引导')
  w('')
  w('- Node **22.19+**（pnpm 11 需 22+；DSH 的 zstd 需 22.19+）：Windows ' + ic('winget install OpenJS.NodeJS.LTS') + '；macOS ' + ic('brew install node') + '；Linux ' + ic('apt-get install -y nodejs npm') + ' 或 nvm。')
  w('- pnpm：' + ic('corepack enable pnpm') + '；失败则 ' + ic('npm install -g pnpm') + '。')
  w('- DSH：' + ic('npm install -g @deepseek-ai/dsh@' + (m.source.dsh ?? '<来源版本>')) + '（按来源版本，不要取 latest）。')
  w('- 每步安装后验证版本再继续。')
  w('')
  w('## 网络与代理处理')
  w('')
  w('- pnpm / npm：' + ic('config set proxy') + ' 与 ' + ic('config set https-proxy') + '；国内镜像 ' + ic('--registry https://registry.npmmirror.com') + '。')
  w('- pnpm 11+ 起 ' + ic('.npmrc') + ' 只保留 registry/auth，其余设置写 ' + ic('pnpm-workspace.yaml') + ' 或全局 ' + ic('config.yaml') + '。')
  w('- GitHub 直连不可达：配代理、换镜像，或手动放源码后改成 ' + ic('link:') + '。')
  w('')
  w('## 已知差异与常见坑')
  w('')
  w('- TODO：来源环境的绝对路径、端口、代理脚本依赖等需要重写的地方。')
  w('- ' + ic('cordis.patch.yml') + ' 被整文件覆盖 → 目标机器自有配置丢失（必须按 id 合并）。')
  w('- 安装插件之后才放本地依赖 → 解析失败（必须先放源码并改 spec）。')
  w('- 跨 DSH 版本直接覆盖 ' + ic('sessions/storages') + ' → 数据格式可能不兼容。')
  w('- 插件 ' + ic('engines.dsh') + ' 不满足目标版本 → 阻止安装/激活，换版本或授精确版本豁免。')
  return L.join('\n')
}
