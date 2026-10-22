#!/usr/bin/env node
/**
 * dsh-backup CLI。单一入口、零第三方依赖：
 *   node bin/dsh-backup.mjs <子命令> [选项]
 * 约定：--json 时 stdout 只有一个 JSON 文档；诊断一律走 stderr。
 * 退出码：0 成功 / 1 错误 / 20 验收失败 / 30 环境缺失。
 */

import path from 'node:path'
import fs from 'node:fs'
import {
  EXIT, AppError, log, diag, emitJson, parseArgs, splitList, resolveHome, resolveAgentsHome,
  exists, readText, writeJson, fmtSize,
} from '../lib/core.mjs'
import { detect, renderDetect, size as measureSize, stage, listProfileDirs, verifyStaging } from '../lib/backup.mjs'
import { doc, pack, patchscan, upload } from '../lib/artifact.mjs'
import { plan, apply, verify, renderPlan } from '../lib/restore.mjs'

const COMMANDS = {
  detect: {
    summary: '只读盘点来源环境（六类），输出 Markdown 或 --json',
    args: { profile: 'list', out: 'string' },
  },
  size: {
    summary: '实测目录体积/压缩率，供「是否打包 node_modules」选项使用',
    args: { target: 'list', work: 'string', 'keep-zip': 'bool' },
  },
  stage: {
    summary: '按六类建 staging（复制后立即校验）',
    args: { work: 'string', name: 'string', categories: 'string', 'include-credentials': 'bool', profile: 'list', project: 'list', 'exclude-top': 'list', 'extra-top': 'list', 'exclude-profile-extra': 'list' },
  },
  doc: {
    summary: '生成恢复指导（manifest-recovery.md）',
    args: { pkg: 'string', out: 'string', force: 'bool' },
  },
  pack: {
    summary: '写 manifest.json + MANIFEST.md → 打 ZIP → 解压回读对账',
    args: { work: 'string', pkg: 'string', out: 'string', name: 'string', categories: 'string', 'include-credentials': 'bool', recovery: 'string', 'scope-note': 'string' },
  },
  patchscan: {
    summary: '逐 profile 与官方 tarball 逐文件对比（类别 4 形态③）',
    args: { work: 'string', profile: 'list', packages: 'list', offline: 'bool', export: 'string', registry: 'list', settle: 'number' },
  },
  upload: {
    summary: '上传 ZIP 到 WebDAV 并校验远端长度',
    args: { file: 'string', url: 'string', user: 'string', password: 'string', 'sub-dir': 'string', 'remote-name': 'string', insecure: 'bool', 'delete-remote': 'list', 'timeout': 'number' },
  },
  plan: {
    summary: '只读：对比包与目标，产出 plan.json（含待决策项）',
    args: { pkg: 'string', out: 'string', 'include-credentials': 'bool', 'restore-data': 'bool', strategy: 'string', project: 'list', 'skip-install': 'bool' },
  },
  apply: {
    summary: '执行计划（默认 dry-run，加 --apply 才写盘）',
    args: { plan: 'string', pkg: 'string', apply: 'bool', 'include-credentials': 'bool', 'restore-data': 'bool', strategy: 'string', 'skip-install': 'bool' },
  },
  'verify-staging': {
    summary: '只读复核 staging 与来源环境（手工改过 staging 后跑）',
    args: { pkg: 'string', work: 'string', out: 'string' },
  },
  verify: {
    summary: '只读验收（失败退出码 20）',
    args: { pkg: 'string', out: 'string' },
  },
}

const GLOBAL = { home: 'string', 'agents-home': 'string', json: 'bool', verbose: 'bool', help: 'bool', h: 'bool', v: 'bool' }

function usage() {
  const lines = ['dsh-backup —— DSH 环境备份 / 恢复（Node 单文件，零依赖）', '', '用法：node bin/dsh-backup.mjs <子命令> [选项]', '', '子命令：']
  for (const [name, spec] of Object.entries(COMMANDS)) lines.push('  ' + name.padEnd(15) + spec.summary)
  lines.push('', '全局选项：--home <dir>  --agents-home <dir>  --json  --help')
  lines.push('', '退出码：0 成功 / 1 错误 / 20 验收失败 / 30 环境缺失')
  return lines.join('\n')
}

function requireArg(opts, key, hint) {
  if (!opts[key]) throw new AppError('缺少 --' + key + (hint ? '（' + hint + '）' : ''), EXIT.ERROR)
  return opts[key]
}

async function main(argv) {
  const [cmd, ...rest] = argv
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') { log(usage()); return EXIT.OK }
  const spec = COMMANDS[cmd]
  if (!spec) throw new AppError('未知子命令：' + cmd + '\n\n' + usage(), EXIT.ERROR)

  const opts = parseArgs(rest, { ...GLOBAL, ...spec.args })
  if (opts.help) { log(usage()); return EXIT.OK }

  const home = resolveHome(opts.home)
  const agentsHome = resolveAgentsHome(opts['agents-home'])
  const wantJson = Boolean(opts.json)
  const emit = (value, text) => { if (wantJson) emitJson(value); else if (text) log(text) }

  if (cmd === 'detect') {
    const report = detect({ home, agentsHome, profileFilter: splitList(opts.profile) })
    if (opts.out) { ensureOut(opts.out); fs.writeFileSync(opts.out, wantJson ? JSON.stringify(report, null, 2) + '\n' : renderDetect(report) + '\n', 'utf8') }
    emit(report, renderDetect(report))
    return EXIT.OK
  }

  if (cmd === 'size') {
    const targets = splitList(opts.target)
    if (!targets.length) {
      const profiles = listProfileDirs(home)
      for (const p of profiles) targets.push(joinRel(home, 'profiles/' + p + '/node_modules'))
      targets.push(joinRel(home, 'profiles/node_modules'))
    }
    const work = resolveWork(opts.work)
    const result = measureSize({ targets, workDir: work, keepZip: Boolean(opts['keep-zip']) })
    const text = ['# 备份体积实测', '', '| 目录 | 文件数 | 原始 | 压缩后 | 压缩率 | 耗时 |', '|---|---|---|---|---|---|']
      .concat(result.rows.map(r => r.missing ? '| ' + r.path + ' | （不存在） | - | - | - | - |' : '| ' + r.path + ' | ' + r.files + ' | ' + fmtSize(r.bytes) + ' | ' + fmtSize(r.zipBytes) + ' | ' + r.ratio + '% | ' + r.seconds.toFixed(1) + 's |'))
      .join('\n')
    emit(result, text)
    return EXIT.OK
  }

  if (cmd === 'stage') {
    const work = resolveWork(opts.work)
    const categories = splitList(opts.categories)
    const cats = categories.length ? categories : ['1', '2', '3', '4', '5', '6']
    const result = stage({
      home, agentsHome, workDir: work,
      packageName: opts.name ?? 'dsh-backup-' + new Date().toISOString().slice(0, 10).replace(/-/g, ''),
      categories: cats,
      includeCredentials: Boolean(opts['include-credentials']),
      profiles: splitList(opts.profile).length ? splitList(opts.profile) : listProfileDirs(home),
      excludeTopLevel: splitList(opts['exclude-top']),
      extraTopLevel: splitList(opts['extra-top']),
      excludeProfileExtra: splitList(opts['exclude-profile-extra']),
      projectDirs: splitList(opts.project),
    })
    if (wantJson) emitJson({ stageDir: result.stageDir, files: result.files, bytes: result.bytes })
    return EXIT.OK
  }

  if (cmd === 'doc') {
    const pkg = path.resolve(requireArg(opts, 'pkg', 'staging 目录'))
    const out = path.resolve(opts.out ?? path.join(path.dirname(pkg), 'manifest-recovery.md'))
    const r = doc({ pkgDir: pkg, home, out, force: Boolean(opts.force) })
    emit({ out: r.out, lines: r.lines }, '恢复指导已写出：' + r.out)
    return EXIT.OK
  }

  if (cmd === 'pack') {
    const pkg = path.resolve(requireArg(opts, 'pkg', 'staging 目录'))
    const outDir = path.resolve(opts.out ?? path.join(path.dirname(pkg), 'out'))
    const r = pack({
      pkgDir: pkg, home, outDir,
      name: opts.name,
      categories: splitList(opts.categories).length ? splitList(opts.categories) : ['1', '2', '3', '4', '5', '6'],
      credentials: Boolean(opts['include-credentials']),
      recoveryDoc: opts.recovery,
      scopeNote: opts['scope-note'],
    })
    emit({ zip: r.zip, sha256: r.sha256, files: r.files, bytes: r.bytes, reconcile: r.reconcile }, 'ZIP    = ' + r.zip + '\nSIZE   = ' + fmtSize(r.bytes) + '\nSHA256 = ' + r.sha256 + '\n对账   = 缺失 ' + r.reconcile.missing.length + ' / 多余 ' + r.reconcile.extra.length + ' / 不一致 ' + r.reconcile.differing.length)
    return EXIT.OK
  }

  if (cmd === 'patchscan') {
    const work = resolveWork(opts.work)
    const r = patchscan({
      home, workDir: work,
      profiles: splitList(opts.profile).length ? splitList(opts.profile) : listProfileDirs(home),
      packages: splitList(opts.packages),
      offline: Boolean(opts.offline),
      exportDir: opts.export ? path.resolve(opts.export) : null,
      registries: splitList(opts.registry),
      settleMs: opts.settle,
    })
    const lines = r.results.flatMap(x => [
      '===== [' + x.profile + '] ' + x.package + '@' + x.version + ' =====',
      '  官方 ' + x.official + ' / 本地 ' + x.local + ' / 内容不一致 ' + x.modified.length,
      ...(x.modified.length ? ['  [内容不一致 → 真补丁]', ...x.modified.map(f => '    * ' + f)] : []),
      ...(x.onlyOfficial.length ? ['  [官方有本地无 → 可疑删改，请人工确认]', ...x.onlyOfficial.slice(0, 20).map(f => '    - ' + f)] : []),
      ...(x.onlyLocal.length ? ['  [本地有官方无 → 多为安装产物（' + x.onlyLocal.length + ' 项）]'] : []),
    ])
    const reg = Object.entries(r.registryUsed ?? {}).map(([k, v]) => '  ' + k + ' ← ' + v).join('\n')
    const vol = (r.volatile ?? []).map(v => '  [' + v.profile + '] ' + v.package + ' → ' + v.rel).join('\n')
    emit(r, lines.join('\n') + (reg ? '\nregistry 来源：\n' + reg : '') + (vol ? '\n运行时重写、已排除（volatile）：\n' + vol : '') + '\n结论：' + r.conclusion)
    return EXIT.OK
  }

  if (cmd === 'upload') {
    const r = await upload({
      file: path.resolve(requireArg(opts, 'file', 'ZIP 路径')),
      url: requireArg(opts, 'url', 'WebDAV 目标根'),
      user: opts.user, password: opts.password,
      subDir: opts['sub-dir'], remoteName: opts['remote-name'],
      insecure: Boolean(opts.insecure),
      deleteRemote: splitList(opts['delete-remote']),
      connectTimeoutSec: opts.timeout ?? 20,
    })
    const del = (r.deleted ?? []).map(d => '  ' + d.name + ' → ' + d.status).join('\n')
    emit(r, '远端路径：' + r.remotePath + '\n远端字节：' + r.remoteBytes + '（本地 ' + r.bytes + '）\nSHA256 = ' + r.sha256 + (del ? '\n已删除：\n' + del : ''))
    return EXIT.OK
  }

  if (cmd === 'plan') {
    const pkg = path.resolve(requireArg(opts, 'pkg', '解压后的包目录'))
    const pl = plan({ pkgDir: pkg, home, agentsHome, includeCredentials: Boolean(opts['include-credentials']), restoreData: Boolean(opts['restore-data']), strategy: opts.strategy ?? 'merge', installPlugins: !opts['skip-install'] })
    if (opts.out) { ensureOut(opts.out); writeJson(path.resolve(opts.out), pl) }
    emit(pl, renderPlan(pl))
    return EXIT.OK
  }

  if (cmd === 'apply') {
    let pl
    if (opts.plan) {
      const p = path.resolve(opts.plan)
      if (!exists(p)) throw new AppError('找不到计划文件：' + p, EXIT.ERROR)
      pl = JSON.parse(readText(p))
    } else {
      const pkg = path.resolve(requireArg(opts, 'pkg', '包目录或 --plan'))
      pl = plan({ pkgDir: pkg, home, agentsHome, includeCredentials: Boolean(opts['include-credentials']), restoreData: Boolean(opts['restore-data']), strategy: opts.strategy ?? 'merge', installPlugins: !opts['skip-install'] })
    }
    const r = apply(pl, { apply: Boolean(opts.apply) })
    emit(r, r.log.join('\n') + '\n\n' + (r.applied ? '已执行' : 'dry-run：确认无误后加 --apply') + '\n失败项：' + r.failed.length)
    return r.failed.length ? EXIT.VERIFY_FAILED : EXIT.OK
  }

  if (cmd === 'verify-staging') {
    const staging = opts.pkg ? path.resolve(opts.pkg) : findStaging(opts.work)
    const r = verifyStaging({ stagingDir: staging, home, agentsHome })
    const text = [...r.oks.map(s => '[OK]   ' + s), ...r.warnings.map(s => '[WARN] ' + s), ...r.failures.map(s => '[FAIL] ' + s), '', '失败：' + r.failures.length + '；告警：' + r.warnings.length].join('\n')
    if (opts.out) { ensureOut(opts.out); fs.writeFileSync(opts.out, text + '\n', 'utf8') }
    emit(r, text)
    return r.ok ? EXIT.OK : EXIT.VERIFY_FAILED
  }

  if (cmd === 'verify') {
    const pkg = path.resolve(requireArg(opts, 'pkg', '包目录'))
    const r = verify({ pkgDir: pkg, home, agentsHome })
    const text = [...r.oks.map(s => '[OK]   ' + s), ...r.warnings.map(s => '[WARN] ' + s), ...r.failures.map(s => '[FAIL] ' + s), '', '失败：' + r.failures.length + '；告警：' + r.warnings.length].join('\n')
    if (opts.out) { ensureOut(opts.out); fs.writeFileSync(opts.out, text + '\n', 'utf8') }
    emit(r, text)
    return r.ok ? EXIT.OK : EXIT.VERIFY_FAILED
  }

  throw new AppError('未实现的子命令：' + cmd, EXIT.ERROR)
}

/** --work 时从 <work>/stage 下取第一个包目录 */
function findStaging(work) {
  const root = path.join(resolveWork(work ?? undefined), 'stage')
  if (!fs.existsSync(root)) throw new AppError('找不到 staging 目录：' + root + '（用 --pkg 指定）', EXIT.ERROR)
  const dirs = fs.readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory())
  if (!dirs.length) throw new AppError('staging 目录为空：' + root, EXIT.ERROR)
  return path.join(root, dirs[0].name)
}

function resolveWork(work) {
  const w = path.resolve(work ?? path.join(process.cwd(), '.dsh-backup-work'))
  fs.mkdirSync(w, { recursive: true })
  return w
}

function ensureOut(p) {
  const dir = path.dirname(path.resolve(p))
  fs.mkdirSync(dir, { recursive: true })
}

/** Node 版本下限与 DSH 一致：22.19（zstd） */
function checkNode() {
  const [maj, min] = process.versions.node.split('.').map(Number)
  if (maj < 22 || (maj === 22 && min < 19)) {
    throw new AppError('需要 Node 22.19+（当前 ' + process.versions.node + '）；DSH 的 zstd 能力依赖它', EXIT.ENV_MISSING)
  }
}

try {
  checkNode()
  const code = await main(process.argv.slice(2))
  process.exit(code)
} catch (err) {
  if (err instanceof AppError) {
    diag('[错误] ' + err.message)
    if (err.hint) diag('       提示：' + err.hint)
    process.exit(err.code)
  }
  diag('[未捕获] ' + (err?.stack ?? err))
  process.exit(EXIT.ERROR)
}
