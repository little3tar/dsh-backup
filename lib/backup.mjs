/**
 * 备份端：detect（只读盘点）、size（体积实测）、stage（建 staging）。
 */

import fs from 'node:fs'
import path from 'node:path'
import {
  log, diag, exists, isDir, ensureDir, joinRel, relOf, readText, writeText,
  hashFile, walkFiles, treeStat, statPath, copyWithBackup, fmtSize, versionOf,
  which, runTar, AppError, EXIT,
} from './core.mjs'
import { ic, FENCE } from './manifest.mjs'
import { parsePatch, patchStats } from './patch.mjs'

const CATEGORY_NAMES = { 1: '配置', 2: '插件', 3: '本地依赖', 4: '环境补丁', 5: '脚本与状态', 6: '数据' }

/** 从 patch 文本里数模型提供方（providers: 下再缩进两级的键） */
export function providersOf(text) {
  const m = /\n\s+providers:\s*\r?\n([\s\S]*?)(?=^\s{0,4}\S|\Z)/m.exec(text)
  if (!m) return []
  return [...m[1].matchAll(/^\s{6}([A-Za-z0-9][A-Za-z0-9_-]*):\s*$/gm)].map(x => x[1])
}

/** 技能根（两种形态：<名字>/SKILL.md 与单文件 <名字>.md） */
export function skillNames(dir) {
  if (!isDir(dir)) return []
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(e => (e.isDirectory() && exists(path.join(dir, e.name, 'SKILL.md'))) || (!e.isDirectory() && e.name.endsWith('.md')))
    .map(e => e.name).sort()
}

function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null }
}

/** 枚举 profile（排除共享层 node_modules 与点目录） */
export function listProfileDirs(homeDir) {
  const dir = path.join(homeDir, 'profiles')
  if (!isDir(dir)) return []
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isDirectory() && e.name !== 'node_modules' && !e.name.startsWith('.'))
    .map(e => e.name).sort()
}

/** 插件对 DSH 的版本要求（只报原始区间，判读交给 agent） */
function engineReqs(profileDir, declared) {
  const out = []
  const nm = path.join(profileDir, 'node_modules')
  for (const d of declared) {
    const pj = path.join(nm, ...d.name.split('/'), 'package.json')
    if (!exists(pj)) continue
    const meta = readJsonSafe(pj)
    if (!meta) continue
    if (meta.engines?.dsh) out.push({ name: d.name, version: meta.version, requirement: 'engines.dsh ' + meta.engines.dsh })
    else {
      const peers = Object.entries(meta.peerDependencies ?? {}).filter(([n]) => n === '@deepseek-ai/dsh' || n.startsWith('@deepseek-ai/dsh-'))
      if (peers.length) out.push({ name: d.name, version: meta.version, requirement: 'peer ' + peers.slice(0, 2).map(([n, r]) => n + ' ' + r).join('; ') + (peers.length > 2 ? ' …(' + peers.length + ' 项)' : '') })
    }
  }
  return out
}

const RUNTIME_PROFILE = new Set(['.plugin-manager', 'thinking-effort-loaded.json', '.dsh-module-fallback'])
const STANDARD_TOP = new Set(['attachments', 'sessions', 'storages', 'synapse', 'profiles', 'skills', 'logs', 'cache', 'dsh-market'])
const CONFIG_TOP = new Set(['AGENTS.md', 'settings.yaml', 'settings.yaml.imported'])

/** 只读盘点 */
export function detect({ home, agentsHome, profileFilter = [] }) {
  const profiles = []
  const names = profileFilter.length ? profileFilter : listProfileDirs(home)
  for (const name of names) {
    const dir = path.join(home, 'profiles', name)
    const pj = readJsonSafe(path.join(dir, 'package.json'))
    const declared = Object.entries(pj?.dependencies ?? {}).map(([n, s]) => ({ name: n, spec: String(s) }))
    const bundles = pj?.dsh?.profile?.bundles ?? []
    const patchFile = path.join(dir, 'cordis.patch.yml')
    let patch = null
    if (exists(patchFile)) {
      const text = readText(patchFile)
      const st = patchStats(parsePatch(text))
      patch = {
        file: 'profiles/' + name + '/cordis.patch.yml',
        bytes: statPath(patchFile).bytes,
        entries: st.entries, overrides: st.overrides, inserts: st.inserts, unknown: st.unknown,
        ids: st.ids, providers: providersOf(text),
      }
    }
    const extras = []
    if (isDir(dir)) {
      const fixed = new Set(['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'cordis.yml', 'cordis.patch.yml', 'compatibility.json', '.dsh-market', 'node_modules'])
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        if (fixed.has(ent.name)) continue
        const st = statPath(path.join(dir, ent.name))
        extras.push({ name: ent.name, kind: ent.isDirectory() ? 'dir' : 'file', files: st.files, bytes: st.bytes, runtime: RUNTIME_PROFILE.has(ent.name) })
      }
    }
    profiles.push({ name, dir: 'profiles/' + name, exists: isDir(dir), bundles, declared, patch, extras, engines: engineReqs(dir, declared) })
  }

  const skills = []
  for (const [root, dir] of [['user-dsh', path.join(home, 'skills')], ['user-agents', path.join(agentsHome, 'skills')]]) {
    if (isDir(dir)) skills.push({ root, dir: relOf(home, dir), names: skillNames(dir) })
  }

  const localDeps = []
  for (const p of profiles) {
    for (const d of p.declared.filter(x => /^(file|link):/.test(x.spec))) {
      const inst = path.join(home, 'profiles', p.name, 'node_modules', ...d.name.split('/'))
      let target = null
      if (exists(inst)) {
        try {
          const lst = fs.lstatSync(inst)
          target = lst.isSymbolicLink() ? fs.realpathSync(inst) : inst
        } catch { target = inst }
      } else if (!path.isAbsolute(d.spec.replace(/^(file|link):/, ''))) {
        const cand = path.resolve(home, 'profiles', p.name, d.spec.replace(/^(file|link):/, ''))
        if (exists(cand)) target = cand
      }
      localDeps.push({ profile: p.name, name: d.name, spec: d.spec, target, type: target && exists(inst) ? 'link' : 'missing' })
    }
  }

  const top = isDir(home) ? fs.readdirSync(home, { withFileTypes: true }) : []
  const dotFiles = top.filter(e => !e.isDirectory() && e.name.startsWith('.'))
    .map(e => ({ name: e.name, bytes: statPath(path.join(home, e.name)).bytes })).sort((a, b) => a.name.localeCompare(b.name))
  const topLevel = top.filter(e => !STANDARD_TOP.has(e.name) && !CONFIG_TOP.has(e.name) && !(e.name.startsWith('.') && !e.isDirectory()))
    .map(e => ({ name: e.name, kind: e.isDirectory() ? 'dir' : 'file', ...statPath(path.join(home, e.name)) }))

  const data = ['sessions', 'storages', 'attachments', 'synapse'].map(name => ({ name, ...treeStat(path.join(home, name)) }))

  return {
    generatedAt: new Date().toISOString(),
    home,
    agentsHome,
    versions: { dsh: versionOf('dsh'), node: versionOf('node'), pnpm: versionOf('pnpm') },
    profiles, skills, localDeps, dotFiles, topLevel, data,
  }
}

/** 渲染 detect 的 Markdown */
export function renderDetect(report) {
  const L = []
  const w = (s = '') => L.push(s)
  const v = report.versions
  w('# DSH 环境检测报告（只读）')
  w('')
  w('- 生成时间：' + report.generatedAt)
  w('- ' + ic('$DSH_HOME') + '：' + report.home)
  w('- ' + ic('$DSH_AGENTS_HOME') + '：' + report.agentsHome)
  w('- profile（' + report.profiles.length + ' 个）：' + (report.profiles.map(p => p.name).join('、') || '（无）'))
  w('- 版本：DSH ' + (v.dsh ?? '未知') + ' / Node ' + (v.node ?? '未知') + ' / pnpm ' + (v.pnpm ?? '未知'))
  w('')
  w('## 0 profile 总览')
  w('')
  for (const p of report.profiles) {
    w('### profile ' + ic(p.name))
    w('')
    if (p.patch) {
      const ins = p.patch.inserts ? ' + ' + p.patch.inserts + ' 条 insert' : ''
      w('- 用户配置层 ' + ic(p.patch.file) + '：' + p.patch.bytes + ' B，**' + p.patch.entries + ' 条 entry（' + p.patch.overrides + ' override' + ins + (p.patch.unknown ? ' / ' + p.patch.unknown + ' 未识别' : '') + '）**')
      if (p.patch.providers.length) w('  - 模型提供方 ' + p.patch.providers.length + ' 个：' + p.patch.providers.join('、'))
    } else w('- 用户配置层：**不存在**（≠ 无配置需求）')
    w('- bundles ' + p.bundles.length + ' 项；依赖声明 ' + p.declared.length + ' 个')
    if (p.extras.length) {
      w('- 固定清单之外的项（类别 4 补丁留档候选）：')
      for (const e of p.extras) w('  - [' + e.kind + '] ' + ic(e.name) + '：' + e.files + ' 文件 / ' + fmtSize(e.bytes) + (e.runtime ? '（运行时生成，恢复无价值）' : ''))
    }
    if (p.engines.length) {
      w('- 插件对 DSH 的版本要求（不满足会阻止安装/激活）：')
      for (const e of p.engines) w('  - ' + e.name + '@' + e.version + ' → ' + e.requirement)
    }
    w('')
  }
  w('## 1 配置')
  w('')
  for (const s of report.skills) w('- 技能根 ' + ic(s.root) + '（' + ic(s.dir) + '）：' + s.names.length + ' 个 —— ' + s.names.join('、'))
  if (!report.skills.length) w('- 技能根：一个都没找到')
  w('- 顶层点文件（凭据/身份/状态候选，仅记名与大小）：' + report.dotFiles.length + ' 个')
  for (const f of report.dotFiles) w('  - ' + ic(f.name) + '：' + f.bytes + ' B')
  w('')
  w('## 2 本地依赖（file:/link:）')
  w('')
  if (report.localDeps.length) for (const d of report.localDeps) w('- ' + ic(d.name) + '（profile ' + d.profile + '）：' + d.spec + ' → ' + (d.target ?? '**找不到**'))
  else w('- 无')
  w('')
  w('## 3 自定义脚本与状态（顶层非标准项）')
  w('')
  if (report.topLevel.length) for (const t of report.topLevel) w('- [' + t.kind + '] ' + ic(t.name) + '：' + t.files + ' 文件 / ' + fmtSize(t.bytes))
  else w('- 无')
  w('')
  w('## 4 数据')
  w('')
  for (const d of report.data) w('- ' + ic(d.name) + '：' + (d.exists ? d.files + ' 文件 / ' + fmtSize(d.bytes) : '不存在'))
  return L.join('\n')
}

/** 体积实测：tar 试压一次 */
export function size({ targets, workDir, keepZip }) {
  ensureDir(workDir)
  const rows = []
  let i = 0
  for (const t of targets) {
    if (!exists(t)) { rows.push({ path: t, missing: true }); continue }
    const st = treeStat(t)
    i++
    const zip = path.join(workDir, 'probe-' + i + '.zip')
    if (exists(zip)) fs.rmSync(zip, { force: true })
    const t0 = Date.now()
    runTar(['-a', '-c', '-f', zip, '-C', path.dirname(t), path.basename(t)])
    const seconds = (Date.now() - t0) / 1000
    const zipBytes = statPath(zip).bytes
    rows.push({ path: t, files: st.files, bytes: st.bytes, zipBytes, ratio: st.bytes ? Math.round((100 * zipBytes) / st.bytes) : 0, seconds })
    if (!keepZip) fs.rmSync(zip, { force: true })
  }
  return { rows }
}

/**
 * 复核 staging：把 staging 与**来源环境当前状态**逐类对一遍（只读）。
 * 场景：agent 手工改过 staging，或两轮之间来源环境变了，打包前用它确认。
 * 口径：整目录照搬的（skills、data）做双向比对；plugins / local-deps / state 做子集比对
 *      （来源比 staging 多出的项是有意排除的，不算失败）。
 */
export function verifyStaging({ stagingDir, home, agentsHome }) {
  const failures = []
  const warnings = []
  const oks = []
  const bad = s => failures.push(s)
  const warn = s => warnings.push(s)
  const ok = s => oks.push(s)
  const walk = (dir, skip) => walkFiles(dir, skip ? { skip } : {})
  const walkPkg = dir => walkFiles(dir, { includeNodeModules: true })
  const H = p => (exists(p) ? hashFile(p) : null)

  const exact = (rel, srcDir, label) => {
    const dstDir = path.join(stagingDir, ...rel.split('/'))
    if (!exists(dstDir)) { bad(label + '：staging 缺 ' + rel); return }
    if (!exists(srcDir)) { bad(label + '：来源不存在 ' + srcDir); return }
    const a = walk(srcDir)
    const b = walkPkg(dstDir)
    const missing = a.filter(f => !b.includes(f))
    const extra = b.filter(f => !a.includes(f))
    const diff = a.filter(f => b.includes(f) && H(path.join(srcDir, ...f.split('/'))) !== H(path.join(dstDir, ...f.split('/'))))
    if (missing.length) bad(label + '：staging 缺 ' + missing.length + ' 个文件（' + missing.slice(0, 3).join('、') + '）')
    if (extra.length) bad(label + '：staging 多出 ' + extra.length + ' 个文件（' + extra.slice(0, 3).join('、') + '）')
    if (diff.length) bad(label + '：内容不一致 ' + diff.length + ' 个（' + diff.slice(0, 3).join('、') + '）')
    if (!missing.length && !extra.length && !diff.length) ok(label + '：' + a.length + ' 个文件与来源一一对应')
  }

  const subset = (rel, srcDir, label) => {
    const dstDir = path.join(stagingDir, ...rel.split('/'))
    if (!exists(dstDir)) { bad(label + '：staging 缺 ' + rel); return }
    if (!exists(srcDir)) { bad(label + '：来源不存在 ' + srcDir); return }
    const b = walkPkg(dstDir)
    const missing = b.filter(f => !exists(path.join(srcDir, ...f.split('/'))))
    const diff = b.filter(f => exists(path.join(srcDir, ...f.split('/'))) && H(path.join(dstDir, ...f.split('/'))) !== H(path.join(srcDir, ...f.split('/'))))
    if (missing.length) bad(label + '：' + missing.length + ' 个文件在来源找不到（' + missing.slice(0, 3).join('、') + '）')
    if (diff.length) bad(label + '：' + diff.length + ' 个文件与来源不一致')
    if (!missing.length && !diff.length) ok(label + '：' + b.length + ' 个文件都能映回来源')
  }

  exact('config/skills', path.join(home, 'skills'), '技能 user-dsh')
  if (exists(path.join(stagingDir, 'config', 'agents-skills'))) {
    exact('config/agents-skills', path.join(agentsHome, 'skills'), '技能 user-agents')
  }
  if (exists(path.join(stagingDir, 'config', 'AGENTS.md'))) {
    if (H(path.join(stagingDir, 'config', 'AGENTS.md')) !== H(path.join(home, 'AGENTS.md'))) bad('config/AGENTS.md：与来源不一致')
    else ok('config/AGENTS.md：与来源一致')
  }

  const cfgRoot = path.join(stagingDir, 'config')
  if (exists(cfgRoot)) {
    for (const ent of fs.readdirSync(cfgRoot, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue
      if (['skills', 'agents-skills', 'project-skills', 'legacy-settings'].includes(ent.name)) continue
      const rel = 'config/' + ent.name + '/cordis.patch.yml'
      const a = H(path.join(stagingDir, ...rel.split('/')))
      if (a == null) continue
      if (a !== H(path.join(home, 'profiles', ent.name, 'cordis.patch.yml'))) bad('配置层 ' + ent.name + '：与来源 cordis.patch.yml 不一致')
      else ok('配置层 ' + ent.name + '：与来源一致')
    }
  }

  const pluginsDir = path.join(stagingDir, 'plugins')
  if (exists(pluginsDir)) {
    for (const ent of fs.readdirSync(pluginsDir, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue
      subset('plugins/' + ent.name, path.join(home, 'profiles', ent.name), '插件清单 ' + ent.name)
    }
  }

  const ldDir = path.join(stagingDir, 'local-deps')
  if (exists(ldDir)) {
    for (const pd of fs.readdirSync(ldDir, { withFileTypes: true })) {
      if (!pd.isDirectory()) continue
      for (const d of fs.readdirSync(path.join(ldDir, pd.name), { withFileTypes: true })) {
        if (!d.isDirectory()) continue
        const pj = path.join(stagingDir, 'local-deps', pd.name, d.name, 'package.json')
        let depName = d.name
        if (exists(pj)) { try { depName = JSON.parse(readText(pj)).name } catch { /* 保留目录名 */ } }
        const inst = path.join(home, 'profiles', pd.name, 'node_modules', ...depName.split('/'))
        let srcDir = inst
        if (exists(inst)) { try { srcDir = fs.realpathSync(inst) } catch { /* 保留原值 */ } }
        if (!exists(srcDir)) { warn('本地依赖 ' + pd.name + '/' + depName + '：找不到来源目录，跳过比对'); continue }
        subset('local-deps/' + pd.name + '/' + d.name, srcDir, '本地依赖 ' + depName)
      }
    }
  }

  for (const sub of ['state', 'scripts']) {
    const dir = path.join(stagingDir, sub)
    if (!exists(dir)) continue
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const src = path.join(home, ent.name)
      if (!exists(src)) { bad(sub + '/' + ent.name + '：来源不存在'); continue }
      if (ent.isDirectory()) subset(sub + '/' + ent.name, src, sub + '/' + ent.name)
      else if (H(path.join(dir, ent.name)) !== H(src)) bad(sub + '/' + ent.name + '：与来源不一致')
      else ok(sub + '/' + ent.name + '：与来源一致')
    }
  }

  const regPath = path.join(stagingDir, 'credentials', 'CREDENTIALS-SOURCES.txt')
  if (exists(regPath)) {
    for (const line of fs.readFileSync(regPath, 'utf8').split(/\r?\n/)) {
      if (!line.trim() || line.startsWith('#')) continue
      const parts = line.split(/\s*\|\s*/)
      if (parts.length < 4) continue
      const packed = H(path.join(stagingDir, ...parts[2].split('/')))
      const src = H(path.join(home, parts[1]))
      if (packed == null) bad('凭据 ' + parts[1] + '：包内文件缺失')
      else if (packed !== src) warn('凭据 ' + parts[1] + '：与来源当前内容不同（运行时可能已变）')
      else ok('凭据 ' + parts[1] + '：与来源一致')
    }
  }

  for (const name of ['sessions', 'storages', 'attachments', 'synapse']) {
    const dst = path.join(stagingDir, 'data', name)
    if (!exists(dst)) continue
    const a = treeStat(path.join(home, name))
    const b = treeStat(dst)
    if (!a.exists) warn('data/' + name + '：来源已不存在')
    else if (b.files !== a.files) warn('data/' + name + '：staging ' + b.files + ' / 来源 ' + a.files + '（运行时可能仍在写）')
    else ok('data/' + name + '：' + b.files + ' 个文件与来源一致')
  }

  return { ok: failures.length === 0, failures, warnings, oks, checkedAt: new Date().toISOString() }
}

/** 建 staging：按六类复制并逐类校验 */
export function stage(opts) {
  const { home, agentsHome, workDir, packageName, categories, includeCredentials, profiles,
    excludeTopLevel = [], extraTopLevel = [], projectDirs = [], excludeProfileExtra = [] } = opts
  const stamp = opts.stamp
  const stageRoot = path.join(workDir, 'stage')
  const dst = path.join(stageRoot, packageName)
  if (exists(dst)) fs.rmSync(dst, { recursive: true, force: true })
  ensureDir(dst)
  const report = []
  const say = s => { log(s); report.push(s) }
  const changes = []

  const copyDir = (src, rel, label, { exclude = new Set() } = {}) => {
    if (!isDir(src)) { say('[SKIP] ' + rel + '（源不存在：' + src + '）'); return false }
    const target = path.join(dst, ...rel.split('/'))
    ensureDir(target)
    for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
      if (exclude.has(ent.name)) continue
      // dereference：目录联接/符号链接按真实内容复制，包才能在别的机器上还原
      fs.cpSync(path.join(src, ent.name), path.join(target, ent.name), { recursive: true, force: true, dereference: true })
    }
    const srcFiles = walkFiles(src, { skip: exclude, includeNodeModules: true })
    const dstFiles = walkFiles(target, { includeNodeModules: true })
    const missing = srcFiles.filter(f => !dstFiles.includes(f))
    const extra = dstFiles.filter(f => !srcFiles.includes(f))
    const diff = srcFiles.filter(f => dstFiles.includes(f) && hashFile(path.join(src, ...f.split('/'))) !== hashFile(path.join(target, ...f.split('/'))))
    say('[' + (missing.length || extra.length || diff.length ? 'FAIL' : 'OK') + '] ' + rel + '：源 ' + srcFiles.length + ' 文件 / staging ' + dstFiles.length + '；缺失 ' + missing.length + '；多余 ' + extra.length + '；内容不一致 ' + diff.length)
    if (missing.length || extra.length || diff.length) {
      throw new AppError('复制校验失败：' + rel + '（层级或内容不一致）', EXIT.ERROR)
    }
    changes.push({ op: 'stage-dir', rel, files: srcFiles.length })
    return true
  }
  const copyFile = (src, rel) => {
    if (!exists(src)) { say('[SKIP] ' + rel + '（源不存在：' + src + '）'); return false }
    const target = path.join(dst, ...rel.split('/'))
    ensureDir(path.dirname(target))
    fs.copyFileSync(src, target)
    const same = hashFile(src) === hashFile(target)
    say('[' + (same ? 'OK' : 'FAIL') + '] ' + rel)
    if (!same) throw new AppError('复制校验失败：' + rel, EXIT.ERROR)
    changes.push({ op: 'stage-file', rel })
    return true
  }

  // 1 配置
  if (categories.includes('1')) {
    say('=== 1 配置 ===')
    copyFile(path.join(home, 'AGENTS.md'), 'config/AGENTS.md')
    copyDir(path.join(home, 'skills'), 'config/skills', 'user-dsh')
    if (isDir(path.join(agentsHome, 'skills'))) copyDir(path.join(agentsHome, 'skills'), 'config/agents-skills', 'user-agents')
    for (const pd of projectDirs) {
      const projName = path.basename(pd)
      for (const sub of ['.dsh', '.agents']) {
        const src = path.join(pd, sub, 'skills')
        if (isDir(src)) copyDir(src, 'config/project-skills/' + projName + '/' + sub, 'project ' + projName)
      }
    }
    for (const pn of profiles) {
      copyFile(path.join(home, 'profiles', pn, 'cordis.patch.yml'), 'config/' + pn + '/cordis.patch.yml')
    }
    for (const legacy of ['settings.yaml', 'settings.yaml.imported']) {
      if (exists(path.join(home, legacy))) {
        copyFile(path.join(home, legacy), 'config/legacy-settings/' + legacy)
        say('[NOTE] ' + legacy + '：不是配置载体，仅作溯源')
      }
    }
  }

  // 2 插件清单
  if (categories.includes('2')) {
    say('=== 2 插件清单 ===')
    for (const pn of profiles) {
      const dir = path.join(home, 'profiles', pn)
      if (!exists(path.join(dir, 'package.json'))) throw new AppError('找不到 profile 清单：' + pn, EXIT.ERROR)
      for (const f of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'cordis.yml', 'compatibility.json']) {
        copyFile(path.join(dir, f), 'plugins/' + pn + '/' + f)
      }
      if (isDir(path.join(dir, '.dsh-market'))) copyDir(path.join(dir, '.dsh-market'), 'plugins/' + pn + '/.dsh-market')
    }
  }

  // 3 本地依赖
  if (categories.includes('3')) {
    say('=== 3 本地依赖源码 ===')
    let n = 0
    for (const pn of profiles) {
      const pj = readJsonSafe(path.join(home, 'profiles', pn, 'package.json'))
      for (const [name, spec] of Object.entries(pj?.dependencies ?? {})) {
        if (!/^(file|link):/.test(String(spec))) continue
        const inst = path.join(home, 'profiles', pn, 'node_modules', ...name.split('/'))
        let src = null
        if (exists(inst)) {
          try { src = fs.lstatSync(inst).isSymbolicLink() ? fs.realpathSync(inst) : inst } catch { src = inst }
        }
        if (!src || !exists(src)) { say('[WARN] ' + pn + '/' + name + '：找不到源码目录（这类依赖无法从任何源下载）'); continue }
        copyDir(src, 'local-deps/' + pn + '/' + (name.replace(/[@/]/g, '-')), 'local dep ' + name)
        n++
      }
    }
    if (!n) say('[SKIP] 所选 profile 没有 file:/link: 依赖')
  }

  // 4 补丁（compare 产物 + profile 内的非标准项）
  if (categories.includes('4')) {
    say('=== 4 环境补丁 ===')
    const patchSrc = path.join(workDir, 'patches')
    if (isDir(patchSrc)) copyDir(patchSrc, 'patches', 'compare-patches 导出')
    else say('[SKIP] 未发现 ' + patchSrc + '（若取证结论是「与官方一致」，正常）')
    const fixed = new Set(['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'cordis.yml', 'cordis.patch.yml', 'compatibility.json', '.dsh-market', 'node_modules'])
    const extrasLog = ['# profile 目录内非标准项（类别 4 候选；由 stage 自动登记）', '# 处置 | profile | 名称 | 说明']
    for (const pn of profiles) {
      const dir = path.join(home, 'profiles', pn)
      if (!isDir(dir)) continue
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        if (fixed.has(ent.name)) continue
        if (RUNTIME_PROFILE.has(ent.name)) { extrasLog.push('未纳入（运行时自动生成物） | ' + pn + ' | ' + ent.name + ' | 恢复后自动重建'); continue }
        if (excludeProfileExtra.includes(ent.name)) { extrasLog.push('未纳入（按用户选择排除） | ' + pn + ' | ' + ent.name + ' | 需在 MANIFEST 说明影响'); continue }
        const rel = 'patches/profile-extra/' + pn + '/' + ent.name
        const src = path.join(dir, ent.name)
        if (ent.isDirectory()) copyDir(src, rel)
        else copyFile(src, rel)
        extrasLog.push('已纳入 | ' + pn + ' | ' + ent.name + ' | ' + (ent.isDirectory() ? '目录' : '文件'))
      }
    }
    writeText(path.join(dst, 'patches', 'profile-extra', 'PROFILE-EXTRAS.txt'), extrasLog.join('\n') + '\n')
    say('[OK] patches/profile-extra/PROFILE-EXTRAS.txt（' + (extrasLog.length - 2) + ' 条处置记录）')
  }

  // 5 凭据 + 顶层非标准项
  const credSpecs = []
  if (categories.includes('1') && includeCredentials) {
    for (const [name, sub] of [['.credentials.yaml', 'credentials/credentials.yaml'], ['.env', 'credentials/env']]) {
      if (!exists(path.join(home, name))) continue
      copyFile(path.join(home, name), sub)
      credSpecs.push({ alias: name.replace(/^\./, ''), source: name, packed: sub })
    }
  } else if (categories.includes('1')) {
    say('[SKIP] 凭据：未开启 --include-credentials')
  }
  if (categories.includes('5')) {
    say('=== 5 脚本与状态 ===')
    if (includeCredentials) {
      for (const ent of fs.readdirSync(home, { withFileTypes: true })) {
        if (ent.isDirectory() || !ent.name.startsWith('.')) continue
        if (ent.name === '.credentials.yaml' || ent.name === '.env') continue
        const alias = ent.name.replace(/^\./, '')
        copyFile(path.join(home, ent.name), 'credentials/' + alias)
        credSpecs.push({ alias, source: ent.name, packed: 'credentials/' + alias })
      }
    }
    const top = fs.readdirSync(home, { withFileTypes: true }).filter(e => {
      if (STANDARD_TOP.has(e.name) || CONFIG_TOP.has(e.name)) return false
      if (e.name.startsWith('.') && !e.isDirectory()) return false
      if (excludeTopLevel.includes(e.name)) return false
      return true
    })
    for (const extra of extraTopLevel) {
      const p = path.join(home, extra)
      if (exists(p)) top.push({ name: extra, isDirectory: () => isDir(p) })
    }
    for (const ent of top) {
      const rel = ent.isDirectory() ? 'state/' + ent.name : 'scripts/' + ent.name
      if (ent.isDirectory()) copyDir(path.join(home, ent.name), rel)
      else copyFile(path.join(home, ent.name), rel)
    }
  }
  if (credSpecs.length) {
    const lines = ['# 凭据 / 身份 / 状态类文件来源与恢复位置（stage 自动登记）', '# alias | 来源文件名 | 包内位置 | 恢复目标']
    for (const c of credSpecs) lines.push(c.alias + ' | ' + c.source + ' | ' + c.packed + ' | $DSH_HOME/' + c.source)
    writeText(path.join(dst, 'credentials', 'CREDENTIALS-SOURCES.txt'), lines.join('\n') + '\n')
    say('[OK] credentials/ 登记：' + credSpecs.map(c => c.source).join('、'))
  }

  // 6 数据
  if (categories.includes('6')) {
    say('=== 6 数据 ===')
    for (const d of ['sessions', 'storages', 'attachments', 'synapse']) {
      if (isDir(path.join(home, d))) copyDir(path.join(home, d), 'data/' + d)
      else say('[SKIP] data/' + d + '（不存在）')
    }
  }

  const st = treeStat(dst)
  say('')
  say('staging 完成：' + st.files + ' 文件 / ' + fmtSize(st.bytes))
  writeText(path.join(workDir, 'stage-report.txt'), report.join('\n') + '\n')
  return { stageDir: dst, files: st.files, bytes: st.bytes, changes, report }
}
