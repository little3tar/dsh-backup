/**
 * 恢复端：plan（只读，产出 plan.json）→ apply（默认 dry-run）→ verify（只读验收）。
 *
 * 设计要点：
 *   - plan 与 apply 分离：plan 的结果可存档、可 diff、可重放。
 *   - 配置层永远按 entry id 合并，绝不整文件覆盖。
 *   - 任何覆盖前先备份为 <名>.bak-<时间戳>。
 */

import fs from 'node:fs'
import path from 'node:path'
import {
  exists, isDir, joinRel, readText, writeText, hashFile, treeStat,
  copyWithBackup, backupPath, versionOf, spawnSyncSafe, stampNow,
} from './core.mjs'
import { parsePatch, mergePatch, entryHashes } from './patch.mjs'
import { buildManifest, listProfiles, ic } from './manifest.mjs'

/** 读包内 manifest.json；没有就按目录结构推导一份（兼容手工包） */
export function readManifest(pkgDir, homeDir) {
  const p = path.join(pkgDir, 'manifest.json')
  if (exists(p)) return JSON.parse(readText(p))
  return buildManifest({ pkgDir, homeDir, categories: ['1', '2', '3', '4', '5', '6'], credentials: exists(path.join(pkgDir, 'credentials', 'CREDENTIALS-SOURCES.txt')) })
}

/**
 * 补丁路径 → 目标文件绝对路径。
 * 布局：patches/<profile>/node_modules/<包>/<相对路径>
 * profile-extra（补丁留档）不自动应用，返回 null。
 */
export function patchTargetPath(home, patchPath) {
  const segs = String(patchPath).split('/')
  if (segs[0] !== 'patches' || !segs[1] || segs[1] === 'profile-extra') return null
  const profile = segs[1]
  let rest = segs.slice(2)
  if (rest[0] === 'node_modules') rest = rest.slice(1)
  if (rest.length < 2) return null
  return joinRel(home, 'profiles/' + profile + '/node_modules/' + rest.join('/'))
}

function hashOf(p) {
  return exists(p) ? hashFile(p) : null
}

/** 技能有两种形态：目录型（<名字>/SKILL.md）与单文件型（<名字>.md）。 */
function skillSrc(dir, name) {
  const asDir = path.join(dir, name, 'SKILL.md')
  return exists(asDir) ? { path: asDir, isDir: true } : { path: path.join(dir, name), isDir: false }
}
function skillDst(dir, name, isDir) {
  return isDir ? path.join(dir, name, 'SKILL.md') : path.join(dir, name)
}
function skillExists(dir, name) {
  return exists(path.join(dir, name, 'SKILL.md')) || exists(path.join(dir, name))
}

/**
 * 生成计划（只读）。
 * @param {{pkgDir:string, home:string, agentsHome:string, includeCredentials?:boolean, restoreData?:boolean, strategy?:string, projects?:string[], installPlugins?:boolean}} opts
 */
export function plan(opts) {
  const { pkgDir, home, agentsHome, includeCredentials = false, restoreData = false, strategy = 'merge', projects = [], installPlugins = true } = opts
  const manifest = readManifest(pkgDir, home)
  const stamp = stampNow()
  const steps = []
  const decisions = []
  const changes = []

  for (const p of manifest.profiles) {
    const from = p.configLayer?.file ?? ('config/' + p.name + '/cordis.patch.yml')
    const srcPath = joinRel(pkgDir, from)
    if (!exists(srcPath)) continue
    const to = joinRel(home, 'profiles/' + p.name + '/cordis.patch.yml')
    const sourceText = readText(srcPath)
    const targetText = exists(to) ? readText(to) : null
    const merged = mergePatch({ targetText, sourceText, strategy })
    steps.push({
      op: 'merge-config', profile: p.name, from, to,
      added: merged.added, replaced: merged.replaced, kept: merged.kept, conflicted: merged.conflicted, inserts: merged.inserts,
      unchanged: merged.unchanged, strategy, text: merged.text,
    })
    if (merged.unchanged) changes.push({ step: 'merge-config', profile: p.name, action: 'unchanged' })
    else changes.push({ step: 'merge-config', profile: p.name, action: 'write', added: merged.added.length, replaced: merged.replaced.length, kept: merged.kept.length })
  }

  // 插件清单必须复制进目标 profile，否则 install 无从下手（此前这一环节是缺的）
  for (const p of manifest.profiles) {
    const srcDir = joinRel(pkgDir, 'plugins/' + p.name)
    if (!exists(srcDir)) continue
    const items = []
    for (const fn of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'cordis.yml', 'compatibility.json']) {
      const s = path.join(srcDir, fn)
      if (!exists(s)) continue
      const d = joinRel(home, 'profiles/' + p.name + '/' + fn)
      const same = exists(d) && hashFile(d) === hashFile(s)
      items.push({ file: fn, kind: 'file', from: 'plugins/' + p.name + '/' + fn, to: d, action: !exists(d) ? 'add' : same ? 'same' : 'update' })
    }
    const market = path.join(srcDir, '.dsh-market')
    if (exists(market)) {
      const d = joinRel(home, 'profiles/' + p.name + '/.dsh-market')
      items.push({ file: '.dsh-market', kind: 'dir', from: 'plugins/' + p.name + '/.dsh-market', to: d, action: exists(d) ? 'update' : 'add' })
    }
    if (!items.length) continue
    steps.push({ op: 'copy-plugins', profile: p.name, items })
    for (const i of items) if (i.action !== 'same') changes.push({ step: 'copy-plugins', profile: p.name, file: i.file, action: i.action })
  }

  for (const s of manifest.skills) {
    const fromDir = joinRel(pkgDir, s.dir)
    const toDir = s.root === 'user-agents' ? joinRel(agentsHome, 'skills') : joinRel(home, 'skills')
    const items = s.names.map(name => {
      const src = skillSrc(fromDir, name)
      const dstPath = skillDst(toDir, name, src.isDir)
      const same = exists(dstPath) && hashFile(src.path) === hashFile(dstPath)
      return { name, isDir: src.isDir, action: !exists(dstPath) ? 'add' : same ? 'same' : 'update' }
    })
    steps.push({ op: 'copy-skills', root: s.root, from: s.dir, to: path.isAbsolute(toDir) ? toDir : toDir, items })
    for (const i of items) if (i.action !== 'same') changes.push({ step: 'copy-skills', root: s.root, name: i.name, action: i.action })
  }

  if (manifest.credentials.length) {
    if (!includeCredentials) {
      decisions.push({ id: 'credentials', question: '是否恢复凭据 / 点文件（明文）？', options: ['恢复（--include-credentials）', '跳过'], default: '跳过' })
      steps.push({ op: 'copy-credentials', skipped: true, reason: '未指定 --include-credentials', items: [] })
    } else {
      const items = manifest.credentials.map(c => {
        const src = joinRel(pkgDir, c.packed)
        const dst = joinRel(home, c.source)
        const st = exists(dst)
        const same = st && hashFile(dst) === hashFile(src)
        return { source: c.source, target: c.target, from: c.packed, to: dst, action: !st ? 'add' : same ? 'same' : 'update' }
      })
      steps.push({ op: 'copy-credentials', items })
      for (const i of items) if (i.action !== 'same') changes.push({ step: 'copy-credentials', name: i.source, action: i.action })
    }
  }

  for (const d of manifest.localDeps) {
    const from = 'local-deps/' + d.profile + '/' + d.dir
    const to = joinRel(home, 'profiles/local-deps/' + d.profile + '/' + d.dir)
    // 以包内清单为准：plan 阶段目标 package.json 可能还没落地（copy-plugins 尚未执行）
    const pjPath = joinRel(pkgDir, 'plugins/' + d.profile + '/package.json')
    let rewrite = null
    if (exists(pjPath)) {
      try {
        const pj = JSON.parse(readText(pjPath))
        const cur = pj.dependencies?.[d.name]
        if (typeof cur === 'string' && /^(file|link):/.test(cur)) rewrite = { dependency: d.name, from: cur, to: 'link:' + to.split(path.sep).join('/') }
      } catch { /* 坏 package.json 留给 apply 处理 */ }
    }
    steps.push({ op: 'copy-local-deps', profile: d.profile, name: d.name, from, to, rewrite })
    if (rewrite) changes.push({ step: 'copy-local-deps', name: d.name, action: 'rewrite-spec' })
  }

  for (const p of manifest.profiles) {
    steps.push({
      op: 'install-plugins', profile: p.name,
      command: 'dsh plugin --profile ' + p.name + ' install',
      skip: !installPlugins,
    })
    if (installPlugins) changes.push({ step: 'install-plugins', profile: p.name, action: 'run' })
  }

  if (manifest.patches.length) {
    const items = manifest.patches.map(pt => {
      const src = joinRel(pkgDir, pt.path)
      const target = patchTargetPath(home, pt.path)
      if (!target) return { path: pt.path, target: null, skipped: true, applied: false, packageInstalled: false }
      const applied = exists(target) && hashFile(target) === hashFile(src)
      return { path: pt.path, target, skipped: false, applied, packageInstalled: exists(path.dirname(target)) }
    })
    steps.push({ op: 'apply-patches', from: 'patches/', items })
    for (const i of items) if (!i.applied && !i.skipped) changes.push({ step: 'apply-patches', path: i.path, action: 'write' })
  }

  const stateItems = []
  for (const sub of ['state', 'scripts']) {
    const dir = joinRel(pkgDir, sub)
    if (!isDir(dir)) continue
    for (const rel of fs.readdirSync(dir, { withFileTypes: true })) {
      stateItems.push({ from: sub + '/' + rel.name, to: joinRel(home, rel.name), kind: rel.isDirectory() ? 'dir' : 'file' })
    }
  }
  if (stateItems.length) {
    steps.push({ op: 'copy-state', items: stateItems })
    for (const i of stateItems) changes.push({ step: 'copy-state', path: i.from, action: 'write' })
  }

  if (manifest.data.length) {
    if (!restoreData) {
      decisions.push({ id: 'data', question: '是否恢复数据目录（覆盖前确认）？', options: ['恢复（--restore-data）', '跳过'], default: '跳过' })
      steps.push({ op: 'restore-data', skipped: true, reason: '未指定 --restore-data', items: [] })
    } else {
      const items = manifest.data.map(d => ({
        name: d.name, from: 'data/' + d.name, to: joinRel(home, d.name),
        packageFiles: d.files, targetFiles: treeStat(joinRel(home, d.name)).files,
      }))
      steps.push({ op: 'restore-data', items })
      for (const i of items) changes.push({ step: 'restore-data', name: i.name, action: 'overwrite' })
    }
  }

  const srcDsh = manifest.source?.dsh ?? null
  const tgtDsh = versionOf('dsh')
  if (srcDsh && tgtDsh && srcDsh !== tgtDsh) {
    decisions.push({ id: 'dsh-version', question: '目标 DSH（' + tgtDsh + '）与来源（' + srcDsh + '）不同：升级、降级，还是按现有版本继续？', options: ['按现有版本继续', '升级目标 DSH', '降级目标 DSH'], default: '按现有版本继续' })
  }

  return {
    schemaVersion: '1',
    createdAt: new Date().toISOString(),
    package: { dir: pkgDir, schemaVersion: manifest.schemaVersion, generator: manifest.generator, source: manifest.source, scope: manifest.scope },
    target: { home, agentsHome, dsh: tgtDsh, platform: process.platform, stamp },
    strategy,
    includeCredentials,
    restoreData,
    steps,
    decisions,
    changes,
    summary: { changes: changes.length, decisions: decisions.length, steps: steps.length },
  }
}

/** 改写 profile package.json 里的 file:/link: 声明 */
function rewriteSpec(pjPath, depName, newSpec) {
  const text = readText(pjPath)
  const re = new RegExp('("' + depName.replace(/[.*+?^\${}()|[\]\\]/g, '\\$&') + '"\\s*:\\s*")(file|link):[^"]*(")')
  const next = text.replace(re, (_, a, __, c) => a + newSpec + c)
  if (next === text) return false
  backupPath(pjPath, stampNow())
  writeText(pjPath, next)
  return true
}

/**
 * 执行计划。apply=false 时只报告。
 * @returns {{applied:boolean, log:string[], failed:string[], backupStamp:string}}
 */
export function apply(pl, { apply: doApply = false } = {}) {
  const out = { applied: doApply, log: [], failed: [], backupStamp: pl.target.stamp }
  const say = s => out.log.push(s)
  const tag = doApply ? '[APPLY]' : '[DRY]'
  const home = pl.target.home

  for (const step of pl.steps) {
    if (step.skipped) { say('[SKIP] ' + step.op + '：' + (step.reason ?? '')); continue }
    if (step.op === 'merge-config') {
      if (step.unchanged) { say('[SKIP] merge-config ' + step.profile + '：与目标现有内容一致'); continue }
      say(tag + ' merge-config ' + step.profile + '：新增 ' + step.added.length + ' / 覆盖 ' + step.replaced.length + ' / 保留目标独有 ' + step.kept.length)
      if (!doApply) continue
      const bak = backupPath(step.to, pl.target.stamp)
      writeText(step.to, step.text)
      if (bak) say('        原文件备份为 ' + path.basename(bak))
    } else if (step.op === 'copy-plugins') {
      for (const item of step.items) {
        if (item.action === 'same') { say('[SKIP] plugins ' + step.profile + '/' + item.file + '：一致'); continue }
        say(tag + ' plugins ' + step.profile + '/' + item.file + '：' + item.action)
        if (!doApply) continue
        copyWithBackup(joinRel(pl.package.dir, item.from), item.to, { apply: true, stamp: pl.target.stamp })
      }
    } else if (step.op === 'copy-skills') {
      for (const item of step.items) {
        if (item.action === 'same') { say('[SKIP] skill ' + step.root + '/' + item.name + '：内容一致'); continue }
        say(tag + ' skill ' + step.root + '/' + item.name + '：' + item.action)
        if (!doApply) continue
        const fromDir = joinRel(pl.package.dir, step.from)
        const toDir = step.root === 'user-agents' ? joinRel(pl.target.agentsHome, 'skills') : joinRel(home, 'skills')
        const src = skillSrc(fromDir, item.name)
        copyWithBackup(src.path, skillDst(toDir, item.name, src.isDir), { apply: true, stamp: pl.target.stamp })
      }
    } else if (step.op === 'copy-credentials') {
      for (const item of step.items) {
        if (item.action === 'same') { say('[SKIP] credential ' + item.source + '：目标已一致'); continue }
        say(tag + ' credential ' + item.source + '：' + item.action)
        if (!doApply) continue
        copyWithBackup(joinRel(pl.package.dir, item.from), item.to, { apply: true, stamp: pl.target.stamp })
        try { fs.chmodSync(item.to, 0o600) } catch { /* Windows 上忽略 */ }
      }
    } else if (step.op === 'copy-local-deps') {
      say(tag + ' local-dep ' + step.name + ' → ' + step.to)
      if (!doApply) continue
      copyWithBackup(joinRel(pl.package.dir, step.from), step.to, { apply: true, stamp: pl.target.stamp })
      if (step.rewrite) {
        const pjPath = joinRel(home, 'profiles/' + step.profile + '/package.json')
        const ok = rewriteSpec(pjPath, step.rewrite.dependency, step.rewrite.to)
        say((ok ? tag : '[WARN]') + ' 改写 ' + step.profile + '/package.json：' + step.rewrite.dependency + ' → ' + step.rewrite.to)
      }
    } else if (step.op === 'install-plugins') {
      if (step.skip) { say('[SKIP] install ' + step.profile + '（--skip-install）'); continue }
      say(tag + ' 安装 ' + step.profile + '：' + step.command)
      if (!doApply) continue
      const r = spawnSyncSafe('dsh', ['plugin', '--profile', step.profile, 'install'])
      if (r.status !== 0) { out.failed.push('install ' + step.profile + '：' + (r.stderr || r.stdout || 'exit ' + r.status)); say('[FAIL] 安装 ' + step.profile) }
      else say('[APPLY] 安装 ' + step.profile + ' 完成')
    } else if (step.op === 'apply-patches') {
      for (const item of step.items) {
        if (item.skipped) { say('[SKIP] patch ' + item.path + '：留档项，不自动应用'); continue }
        if (item.applied) { say('[SKIP] patch ' + item.path + '：已生效'); continue }
        if (!item.packageInstalled) { out.failed.push('patch ' + item.path + '：目标未安装该包'); say('[FAIL] patch ' + item.path + '：目标未安装该包'); continue }
        say(tag + ' patch ' + item.path)
        if (!doApply) continue
        copyWithBackup(joinRel(pl.package.dir, item.path), item.target, { apply: true, stamp: pl.target.stamp })
      }
    } else if (step.op === 'copy-state') {
      for (const item of step.items) {
        say(tag + ' state ' + item.from + ' → ' + item.to)
        if (!doApply) continue
        copyWithBackup(joinRel(pl.package.dir, item.from), item.to, { apply: true, stamp: pl.target.stamp })
      }
    } else if (step.op === 'restore-data') {
      for (const item of step.items) {
        say(tag + ' data ' + item.name + '（覆盖 ' + item.targetFiles + ' 文件）')
        if (!doApply) continue
        copyWithBackup(joinRel(pl.package.dir, item.from), item.to, { apply: true, stamp: pl.target.stamp })
      }
    }
  }
  return out
}

/** 验收（只读） */
export function verify({ pkgDir, home, agentsHome }) {
  const manifest = readManifest(pkgDir, home)
  const failures = []
  const warnings = []
  const oks = []
  const ok = s => oks.push(s)
  const bad = s => failures.push(s)
  const warn = s => warnings.push(s)

  for (const p of manifest.profiles) {
    const pjPath = joinRel(home, 'profiles/' + p.name + '/package.json')
    if (!exists(pjPath)) { bad('profile ' + p.name + '：目标缺 package.json'); continue }
    let tgt
    try { tgt = JSON.parse(readText(pjPath)) } catch { bad('profile ' + p.name + '：package.json 解析失败'); continue }
    const tb = tgt?.dsh?.profile?.bundles ?? []
    const missing = p.bundles.filter(b => !tb.includes(b))
    if (missing.length) bad('profile ' + p.name + '：缺 bundles ' + missing.join('、'))
    else ok('profile ' + p.name + '：bundles 已覆盖（' + tb.length + ' 项）')
    const notInstalled = Object.keys(tgt.dependencies ?? {}).filter(n => !exists(joinRel(home, 'profiles/' + p.name + '/node_modules/' + n)))
    if (notInstalled.length) bad('profile ' + p.name + '：' + notInstalled.length + ' 个依赖未安装（' + notInstalled.join('、') + '）')
    else ok('profile ' + p.name + '：声明的依赖都在 node_modules 里')
  }

  for (const p of manifest.profiles) {
    if (!p.configLayer) continue
    const to = joinRel(home, 'profiles/' + p.name + '/cordis.patch.yml')
    if (!exists(to)) { bad('profile ' + p.name + '：目标缺 cordis.patch.yml'); continue }
    const tgt = parsePatch(readText(to))
    const tgtHashes = entryHashes(tgt)
    const label = e => e.label ?? e.id ?? e.key
    const missing = p.configLayer.entries.filter(e => !tgtHashes.has(e.key))
    const diff = p.configLayer.entries.filter(e => tgtHashes.has(e.key) && tgtHashes.get(e.key) !== e.sha256)
    if (missing.length) bad('profile ' + p.name + '：' + missing.length + ' 条 entry 未合并（' + missing.map(label).join('、') + '）')
    else if (diff.length) warn('profile ' + p.name + '：' + diff.length + ' 条 entry 与包内不同（' + diff.map(label).join('、') + '）')
    else ok('profile ' + p.name + '：' + p.configLayer.entries.length + ' 条 entry 全部在位且一致')
  }

  for (const s of manifest.skills) {
    const toDir = s.root === 'user-agents' ? joinRel(agentsHome, 'skills') : joinRel(home, 'skills')
    const missing = s.names.filter(n => !skillExists(toDir, n))
    if (missing.length) bad('技能 ' + s.root + '：缺 ' + missing.length + ' 个（' + missing.join('、') + '）')
    else ok('技能 ' + s.root + '：' + s.names.length + ' 个都在目标')
  }

  for (const c of manifest.credentials) {
    const dst = joinRel(home, c.source)
    if (!exists(dst)) bad('凭据 ' + c.source + '：目标不存在')
    else if (hashFile(dst) !== c.sha256) bad('凭据 ' + c.source + '：与包内不一致')
    else ok('凭据 ' + c.source + '：已恢复且一致')
  }

  for (const pt of manifest.patches) {
    const target = patchTargetPath(home, pt.path)
    if (!target) { warn('补丁 ' + pt.path + '：留档项，不作为补丁校验'); continue }
    if (!exists(target)) bad('补丁 ' + pt.path + '：目标未安装该包')
    else if (hashFile(target) !== pt.sha256) bad('补丁 ' + pt.path + '：未生效')
    else ok('补丁 ' + pt.path + '：已生效')
  }

  for (const d of manifest.localDeps) {
    const nm = joinRel(home, 'profiles/' + d.profile + '/node_modules/' + d.name)
    if (!exists(nm)) bad('本地依赖 ' + d.name + '：未链接进 profile ' + d.profile)
    else ok('本地依赖 ' + d.name + '：已在 node_modules 中')
  }

  for (const d of manifest.data) {
    const st = treeStat(joinRel(home, d.name))
    if (!st.exists) warn('data/' + d.name + '：目标没有该目录')
    else if (st.files < d.files) warn('data/' + d.name + '：包内 ' + d.files + ' 文件 / 目标 ' + st.files + ' 文件')
    else ok('data/' + d.name + '：目标 ' + st.files + ' 文件（包内 ' + d.files + '）')
  }

  return { ok: failures.length === 0, failures, warnings, oks, checkedAt: new Date().toISOString() }
}

/** 渲染 plan 的 Markdown（给人看的摘要） */
export function renderPlan(pl) {
  const L = []
  const w = (s = '') => L.push(s)
  w('# 恢复计划')
  w('')
  w('- 包：' + pl.package.dir + '（生成器 ' + (pl.package.generator?.name ?? '?') + ' ' + (pl.package.generator?.version ?? '') + '）')
  w('- 目标 ' + ic('$DSH_HOME') + '：' + pl.target.home)
  w('- 来源 DSH：' + (pl.package.source?.dsh ?? '未知') + '；目标 DSH：' + (pl.target.dsh ?? '未知'))
  w('- 策略：' + pl.strategy + '；凭据：' + (pl.includeCredentials ? '恢复' : '跳过') + '；数据：' + (pl.restoreData ? '恢复' : '跳过'))
  w('- 变更点：' + pl.summary.changes + '；待决策：' + pl.summary.decisions)
  w('')
  if (pl.decisions.length) {
    w('## 待决策（需要向用户提问）')
    w('')
    for (const d of pl.decisions) w('- **' + d.id + '**：' + d.question + '（默认：' + d.default + '）')
    w('')
  }
  w('## 变更点')
  w('')
  for (const c of pl.changes) w('- ' + JSON.stringify(c))
  return L.join('\n')
}
