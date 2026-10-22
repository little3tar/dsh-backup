/**
 * 公共基础能力：退出码、参数解析、路径归一、哈希、文件树、备份式复制、tar 探测。
 * 约定（全库一致）：
 *   - 内部相对路径一律用 POSIX 分隔符 '/'，只在访问文件系统时拼接。
 *   - 输出面向 agent：--json 时只打印一个 JSON 文档到 stdout；诊断走 stderr。
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'

/** 退出码约定：agent 靠它分支，不靠读日志 */
export const EXIT = {
  OK: 0,
  NEEDS_DECISION: 10,
  VERIFY_FAILED: 20,
  ENV_MISSING: 30,
  ERROR: 1,
}

export class AppError extends Error {
  constructor(message, code = EXIT.ERROR, hint) {
    super(message)
    this.code = code
    this.hint = hint
  }
}

export const isWin = process.platform === 'win32'

/** 人类可读输出走 stdout；诊断一律 stderr，避免污染 --json 的单一文档 */
export function log(...args) {
  process.stdout.write(args.join(' ') + '\n')
}

export function diag(...args) {
  process.stderr.write(args.join(' ') + '\n')
}

export function emitJson(value) {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n')
}

/**
 * 极简参数解析：支持 "--key value"、"--key=value"、"--flag"、重复的 --key（收成数组）。
 * @param {string[]} argv
 * @param {Record<string, 'string'|'number'|'bool'|'list'>} spec
 */
export function parseArgs(argv, spec) {
  const out = {}
  const alias = { h: 'help', v: 'verbose' }
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]
    if (!raw.startsWith('-')) {
      ;(out._ ??= []).push(raw)
      continue
    }
    let key = raw.replace(/^-{1,2}/, '')
    let value
    const eq = key.indexOf('=')
    if (eq >= 0) {
      value = key.slice(eq + 1)
      key = key.slice(0, eq)
    }
    key = alias[key] ?? key
    const kind = spec[key] ?? 'string'
    if (kind === 'bool') {
      out[key] = true
      continue
    }
    if (value === undefined) {
      value = argv[++i]
      if (value === undefined) throw new AppError('--' + key + ' 缺少取值')
    }
    if (kind === 'number') out[key] = Number(value)
    else if (kind === 'list') (out[key] ??= []).push(value)
    else out[key] = value
  }
  return out
}

/** 逗号/分号/空白分隔的列表参数 */
export function splitList(value) {
  if (!value) return []
  const list = Array.isArray(value) ? value : [value]
  return list.flatMap(v => String(v).split(/[,;\s]+/)).filter(Boolean)
}

/** $DSH_HOME：环境变量优先，否则用户主目录下的 .dsh */
export function resolveHome(explicit) {
  if (explicit) return path.resolve(explicit)
  if (process.env.DSH_HOME) return path.resolve(process.env.DSH_HOME)
  return path.join(os.homedir(), '.dsh')
}

/** $DSH_AGENTS_HOME：环境变量优先，否则 ~/.agents */
export function resolveAgentsHome(explicit) {
  if (explicit) return path.resolve(explicit)
  if (process.env.DSH_AGENTS_HOME) return path.resolve(process.env.DSH_AGENTS_HOME)
  return path.join(os.homedir(), '.agents')
}

/** 绝对路径 → 相对 base 的 POSIX 路径（永远不含反斜杠） */
export function relOf(base, full) {
  const r = path.relative(path.resolve(base), path.resolve(full))
  return r.split(path.sep).join('/')
}

/** POSIX 相对路径 → 本机绝对路径 */
export function joinRel(base, rel) {
  if (!rel) return base
  return path.join(base, ...String(rel).split('/').filter(Boolean))
}

export function exists(p) {
  try {
    fs.lstatSync(p)
    return true
  } catch {
    return false
  }
}

export function isDir(p) {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

export function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true })
}

export function readText(p) {
  return fs.readFileSync(p, 'utf8')
}

export function readJson(p) {
  return JSON.parse(readText(p))
}

/** 原子写：先写临时文件再 rename，避免半截文件 */
export function writeText(p, text) {
  ensureDir(path.dirname(p))
  const tmp = p + '.tmp-' + process.pid
  fs.writeFileSync(tmp, text, 'utf8')
  fs.renameSync(tmp, p)
}

export function writeJson(p, value) {
  writeText(p, JSON.stringify(value, null, 2) + '\n')
}

export function sha256Buffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

export function hashFile(p) {
  if (!exists(p)) return null
  return sha256Buffer(fs.readFileSync(p))
}

export function hashText(text) {
  return sha256Buffer(Buffer.from(text, 'utf8'))
}

/**
 * 递归列出文件（POSIX 相对路径），跳过指定名字的目录/文件。
 * @returns {string[]} 排序后的相对路径
 */
export function walkFiles(root, { skip = new Set(['node_modules', '.git', '.pnpm']), includeNodeModules = false } = {}) {
  if (!isDir(root)) return []
  // 默认跳过 node_modules；但 staging/包内的 patches/<profile>/node_modules/... 是合法内容，需要显式包含
  const sk = includeNodeModules ? new Set([...skip].filter(n => n !== 'node_modules')) : skip
  const out = []
  const walk = (dir, prefix) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const name = ent.name
      if (sk.has(name)) continue
      const rel = prefix ? prefix + '/' + name : name
      const abs = path.join(dir, name)
      if (ent.isDirectory()) walk(abs, rel)
      else if (ent.isFile()) out.push(rel)
      else if (ent.isSymbolicLink()) out.push(rel)
    }
  }
  walk(root, '')
  return out.sort()
}

/** 目录统计：文件数与总字节 */
export function treeStat(dir) {
  if (!isDir(dir)) return { exists: false, files: 0, bytes: 0 }
  let files = 0
  let bytes = 0
  const walk = d => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, ent.name)
      if (ent.isDirectory()) walk(abs)
      else if (ent.isFile()) {
        files++
        bytes += fs.statSync(abs).size
      }
    }
  }
  walk(dir)
  return { exists: true, files, bytes }
}

/** 单个文件或目录统计 */
export function statPath(p) {
  if (!exists(p)) return { exists: false, files: 0, bytes: 0 }
  const st = fs.lstatSync(p)
  if (st.isDirectory()) return treeStat(p)
  return { exists: true, files: 1, bytes: st.size }
}

/** 覆盖前备份：返回备份路径；不存在则返回 null */
export function backupPath(p, stamp) {
  if (!exists(p)) return null
  const bak = p + '.bak-' + stamp
  fs.renameSync(p, bak)
  return bak
}

/**
 * 带备份的复制。apply=false 时只报告不写。
 * @returns {{changed:boolean, backup:string|null}}
 */
export function copyWithBackup(src, dst, { apply, stamp }) {
  if (!apply) return { changed: true, backup: null }
  ensureDir(path.dirname(dst))
  const backup = backupPath(dst, stamp)
  fs.cpSync(src, dst, { recursive: true, force: true })
  return { changed: true, backup }
}

export function stampNow() {
  const d = new Date()
  const p = n => String(n).padStart(2, '0')
  return (
    d.getFullYear() +
    p(d.getMonth() + 1) +
    p(d.getDate()) +
    '-' +
    p(d.getHours()) +
    p(d.getMinutes()) +
    p(d.getSeconds())
  )
}

/** 在 PATH 里探测可执行文件，返回其路径或 null（不抛错） */
export function which(cmd) {
  const probe = spawnCmd(cmd, ['--version'])
  return probe.error ? null : cmd
}

/**
 * 调外部命令。Windows 的 dsh/pnpm/npm 是 .cmd shim，直接 spawn 会 ENOENT，
 * 必须经 shell 并自行加引号；POSIX 直接用 argv 数组（避免 shell 注入与引号错乱）。
 */
export function spawnCmd(cmd, args = [], opts = {}) {
  if (isWin) {
    const q = s => (/[\s"]/.test(String(s)) ? '"' + String(s).replace(/"/g, '\\"') + '"' : String(s))
    const line = [cmd, ...args].map(q).join(' ')
    return spawnSync(line, { encoding: 'utf8', windowsHide: true, shell: true, ...opts })
  }
  return spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, ...opts })
}

let tarCache

/** tar 三端都有，但名字不同（Windows 是 tar.exe）；探测一次并缓存 */
export function findTar() {
  if (tarCache !== undefined) return tarCache
  for (const cand of isWin ? ['tar.exe', 'tar'] : ['tar']) {
    const r = spawnSync(cand, ['--version'], { encoding: 'utf8', windowsHide: true })
    if (!r.error) {
      tarCache = cand
      return cand
    }
  }
  tarCache = null
  return null
}

/** 调 tar；失败即抛错（不静默继续） */
export function runTar(args) {
  const tar = findTar()
  if (!tar) throw new AppError('找不到 tar（Windows 10+ 自带 bsdtar；macOS/Linux 需系统 tar）', EXIT.ENV_MISSING)
  const r = spawnSync(tar, args, { encoding: 'utf8', windowsHide: true })
  if (r.status !== 0) {
    throw new AppError('tar 失败：' + args.join(' ') + '\n' + (r.stderr || ''), EXIT.ERROR)
  }
  return r
}

/** 运行子进程并返回 {status, stdout, stderr}，不抛错（由调用方判读） */
export function spawnSyncSafe(cmd, args = [], opts = {}) {
  return spawnCmd(cmd, args, opts)
}

/** 命令版本字符串（如 dsh --version），取不到返回 null */
export function versionOf(cmd) {
  try {
    const r = spawnCmd(cmd, ['--version'])
    if (r.status !== 0 || !r.stdout) return null
    return r.stdout.trim().split(/\r?\n/)[0]
  } catch {
    return null
  }
}

/** 同步 sleep（不依赖事件循环），用于「隔一会儿再取一次 hash」的稳定性探测 */
export function sleepSync(ms) {
  if (!ms || ms <= 0) return
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) } catch { /* 环境不支持就跳过 */ }
}

/** 人类可读体积 */
export function fmtSize(bytes) {
  if (bytes == null) return '未统计'
  if (bytes >= 1024 ** 3) return (bytes / 1024 ** 3).toFixed(2) + ' GB'
  if (bytes >= 1024 ** 2) return (bytes / 1024 ** 2).toFixed(2) + ' MB'
  if (bytes >= 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return bytes + ' B'
}
