/**
 * 打包与交付：pack（manifest + MANIFEST.md + ZIP + 对账）、doc（只出恢复指导）、
 * patchscan（官方 tarball 对比）、upload（WebDAV）。
 */

import fs from 'node:fs'
import path from 'node:path'
import {
  exists, isDir, ensureDir, joinRel, readText, writeText, writeJson, hashFile,
  walkFiles, treeStat, statPath, fmtSize, runTar, spawnSyncSafe, stampNow, sleepSync, AppError, EXIT, log, diag,
} from './core.mjs'
import { buildManifest, renderManifestMd, renderRecoveryDoc, ic } from './manifest.mjs'

/** 生成恢复指导文件（供人阅读 / 供 pack 并入 MANIFEST） */
export function doc({ pkgDir, home, out, force = false }) {
  const manifest = buildManifest({ pkgDir, homeDir: home, categories: ['1', '2', '3', '4', '5', '6'], credentials: exists(joinRel(pkgDir, 'credentials/CREDENTIALS-SOURCES.txt')) })
  if (exists(out) && !force) throw new AppError('目标已存在：' + out + '（加 --force 覆盖）', EXIT.ERROR)
  const text = renderRecoveryDoc(manifest)
  writeText(out, text + '\n')
  return { out, lines: text.split('\n').length, manifest }
}

/**
 * 打包：写 manifest.json + MANIFEST.md → tar 打 ZIP → 解压回读双向对账。
 * @param {{pkgDir:string, home:string, outDir:string, name?:string, categories:string[], credentials:boolean, recoveryDoc?:string, scopeNote?:string}} opts
 */
export function pack(opts) {
  const { pkgDir, home, outDir, categories, credentials, recoveryDoc, scopeNote } = opts
  const pkgName = path.basename(pkgDir)
  const manifest = buildManifest({ pkgDir, homeDir: home, categories, credentials, scopeNote })

  writeJson(path.join(pkgDir, 'manifest.json'), manifest)
  const rec = recoveryDoc && exists(recoveryDoc) ? readText(recoveryDoc) : renderRecoveryDoc(manifest)
  const md = renderManifestMd(manifest, { recoveryDoc: rec })
  writeText(path.join(pkgDir, 'MANIFEST.md'), md + '\n')

  ensureDir(outDir)
  const stamp = new Date()
  const pad = n => String(n).padStart(2, '0')
  const base = opts.name ?? 'dsh-backup-' + stamp.getFullYear() + pad(stamp.getMonth() + 1) + pad(stamp.getDate()) + '-' + pad(stamp.getHours()) + pad(stamp.getMinutes())
  const zip = path.join(outDir, base + '.zip')
  if (exists(zip)) fs.rmSync(zip, { force: true })

  runTar(['-a', '-c', '-f', zip, '-C', path.dirname(pkgDir), pkgName])

  // 打包后对账：解压回读，双向路径 diff + 逐文件 hash
  const verifyDir = path.join(path.dirname(outDir), 'verify-' + stampNow())
  ensureDir(verifyDir)
  runTar(['-xf', zip, '-C', verifyDir])
  const un = path.join(verifyDir, pkgName)
  const a = walkFiles(pkgDir, { includeNodeModules: true })
  const b = walkFiles(un, { includeNodeModules: true })
  const missing = a.filter(f => !b.includes(f))
  const extra = b.filter(f => !a.includes(f))
  const differing = a.filter(f => b.includes(f) && hashFile(path.join(pkgDir, ...f.split('/'))) !== hashFile(path.join(un, ...f.split('/'))))
  fs.rmSync(verifyDir, { recursive: true, force: true })

  const sha = hashFile(zip)
  writeText(zip + '.sha256', sha + '  ' + path.basename(zip) + '\n')
  const reconcile = { missing, extra, differing, files: a.length, ok: !missing.length && !extra.length && !differing.length }
  if (!reconcile.ok) throw new AppError('打包后对账未通过：缺失 ' + missing.length + ' / 多余 ' + extra.length + ' / 不一致 ' + differing.length, EXIT.VERIFY_FAILED)
  return { zip, sha256: sha, files: a.length, bytes: statPath(zip).bytes, reconcile, manifest }
}

/** 逐 profile 取实际安装精确版本（registry 依赖） */
function installedVersions(profileDir, names) {
  const map = new Map()
  try {
    const r = spawnSyncSafe('pnpm', ['list', '--depth', '0', '--json', '--dir', profileDir])
    if (r.status === 0 && r.stdout?.trim()) {
      const deps = JSON.parse(r.stdout)[0]?.dependencies ?? {}
      for (const [n, v] of Object.entries(deps)) map.set(n, String(v?.version ?? v))
    }
  } catch { /* 回退 */ }
  for (const n of names) {
    if (map.has(n)) continue
    const pj = path.join(profileDir, 'node_modules', ...n.split('/'), 'package.json')
    if (exists(pj)) { try { map.set(n, JSON.parse(readText(pj)).version) } catch { /* 跳过 */ } }
  }
  return map
}

/**
 * 官方 tarball 逐文件对比（类别 4 形态③）。
 * @param {{home:string, profiles:string[], workDir:string, packages?:string[], offline?:boolean, exportDir?:string}} opts
 */
export function patchscan(opts) {
  const { home, profiles, workDir, packages = [], offline = false, exportDir = null, registries = [] } = opts
  // registry 链：显式给的优先；否则 npm 默认配置 → npmmirror → npmjs（大陆网络下第二次尝试通常才成功）
  const chain = registries.length ? registries : [null, 'https://registry.npmmirror.com', 'https://registry.npmjs.org']
  const registryUsed = {}
  const cacheDir = path.join(workDir, 'npm-cache')
  const tarDir = path.join(workDir, 'official')
  const unpackDir = path.join(workDir, 'official-unpacked')
  for (const d of [cacheDir, tarDir, unpackDir]) ensureDir(d)

  const results = []
  for (const pn of profiles) {
    const profileDir = path.join(home, 'profiles', pn)
    if (!exists(path.join(profileDir, 'package.json'))) { diag('[WARN] ' + pn + '：缺 package.json，跳过'); continue }
    const pj = JSON.parse(readText(path.join(profileDir, 'package.json')))
    let names = Object.entries(pj.dependencies ?? {}).filter(([, s]) => !/^(file|link|workspace|portal):/.test(String(s))).map(([n]) => n)
    if (packages.length) names = names.filter(n => packages.includes(n))
    const versions = installedVersions(profileDir, names)
    for (const name of names.sort()) {
      const version = versions.get(name)
      if (!version) { diag('[WARN] ' + name + '：取不到实际安装版本，跳过'); continue }
      const safe = name.replace(/[@/]/g, '-').replace(/^-+|-+$/g, '')
      const tgz = path.join(tarDir, safe + '-' + version + '.tgz')
      // 必须按 name@version 隔离：同一个包在两个 profile 里可能是不同版本，
      // 共用解压目录会让后一个版本沿用前一个版本的残留文件（实测造成 55 个假补丁）
      const unpacked = path.join(unpackDir, safe + '-' + version)
      const localPkg = path.join(profileDir, 'node_modules', ...name.split('/'))
      if (!offline) {
        if (!exists(tgz)) {
          for (const reg of chain) {
            const args = ['pack', name + '@' + version, '--cache', cacheDir, '--pack-destination', tarDir, '--silent']
            if (reg) args.push('--registry', reg)
            spawnSyncSafe('npm', args)
            if (exists(tgz)) { registryUsed[name] = reg ?? 'npm 配置的默认 registry'; break }
            diag('[WARN] ' + name + '：' + (reg ?? '默认 registry') + ' 下载失败，试下一个')
          }
        }
        if (!exists(tgz)) { diag('[WARN] ' + name + '：所有 registry 都失败，跳过'); continue }
        if (exists(unpacked)) fs.rmSync(unpacked, { recursive: true, force: true })
        ensureDir(unpacked)
        runTar(['-xzf', tgz, '-C', unpacked])
      }
      const offBase = path.join(unpacked, 'package')
      if (!exists(offBase)) { diag('[WARN] ' + name + '：缺少官方解压内容，跳过'); continue }
      if (!exists(localPkg)) { diag('[WARN] ' + name + '：本地未安装，跳过'); continue }

      const offFiles = walkFiles(offBase)
      const locFiles = walkFiles(localPkg)
      const onlyOfficial = offFiles.filter(f => !locFiles.includes(f))
      const onlyLocal = locFiles.filter(f => !offFiles.includes(f))
      const modified = offFiles.filter(f => locFiles.includes(f) && hashFile(path.join(offBase, ...f.split('/'))) !== hashFile(path.join(localPkg, ...f.split('/'))))
      results.push({ profile: pn, package: name, version, official: offFiles.length, local: locFiles.length, modified, onlyOfficial, onlyLocal, localPkg })
    }
  }
  // 稳定性探测：插件会在运行时重写自己包内的产物（实测 dsh-pet-remielle 重写 lib/client.js 与 src/index.js），
  // 这类差异不是补丁 —— 隔 settleMs 再取一次 hash，前后不一致的标为 volatile，不导出。
  const settleMs = opts.settleMs ?? 2000
  const volatile = []
  if (settleMs > 0) {
    const cand = []
    for (const r of results) for (const f of r.modified) cand.push({ r, f, abs: path.join(r.localPkg, ...f.split('/')) })
    if (cand.length) {
      const before = cand.map(c => hashFile(c.abs))
      sleepSync(settleMs)
      for (let i = 0; i < cand.length; i++) {
        if (hashFile(cand[i].abs) !== before[i]) volatile.push({ profile: cand[i].r.profile, package: cand[i].r.package, rel: cand[i].f })
      }
    }
  }
  for (const r of results) {
    const vk = new Set(volatile.filter(v => v.profile === r.profile && v.package === r.package).map(v => v.rel))
    if (vk.size) { r.volatile = [...vk]; r.modified = r.modified.filter(f => !vk.has(f)) }
    delete r.localPkg
  }

  const exported = []
  if (exportDir) {
    for (const r of results) {
      for (const f of r.modified) {
        // 布局与 node_modules 同构：patches/<profile>/node_modules/<包>/<相对路径>（scope 也天然正确）
        const src = path.join(home, 'profiles', r.profile, 'node_modules', ...r.package.split('/'), ...f.split('/'))
        const dest = path.join(exportDir, r.profile, 'node_modules', ...r.package.split('/'), ...f.split('/'))
        ensureDir(path.dirname(dest))
        fs.copyFileSync(src, dest)
        exported.push({ profile: r.profile, package: r.package, version: r.version, rel: f })
      }
    }
  }

  return { results, exported, volatile, registryUsed, conclusion: results.every(r => !r.modified.length && !r.onlyOfficial.length) ? 'all-clean' : 'has-differences' }
}

/** WebDAV：PROPFIND 探测 → 按需 MKCOL → PUT → PROPFIND 校验内容长度 */
export async function upload(opts) {
  const {
    file, url, subDir, remoteName, insecure = false, deleteRemote = [], connectTimeoutSec = 20,
    user = process.env.DSH_WEBDAV_USER,
    password = process.env.DSH_WEBDAV_PASSWORD,
  } = opts
  if (!exists(file)) throw new AppError('本地文件不存在：' + file, EXIT.ERROR)
  const auth = user || password ? 'Basic ' + Buffer.from((user ?? '') + ':' + (password ?? '')).toString('base64') : null
  const root = url.replace(/\/+$/, '')
  const base = subDir ? root + '/' + subDir.replace(/^\/+|\/+$/g, '') : root

  const req = async (method, target, { body = null, depth = null } = {}) => {
    const headers = { Authorization: auth ?? undefined }
    if (auth) headers.Authorization = auth
    if (depth != null) headers.Depth = String(depth)
    const res = await fetch(target, { method, headers, body, signal: AbortSignal.timeout(connectTimeoutSec * 1000) })
    const text = await res.text().catch(() => '')
    return { status: res.status, text }
  }

  const out = { url: base, steps: [], remotePath: null, sha256: hashFile(file), bytes: statPath(file).bytes }
  const probe = await req('PROPFIND', base + '/', { depth: 1 })
  out.steps.push({ step: 'propfind', status: probe.status })
  if (probe.status === 404 && subDir) {
    const parts = subDir.replace(/^\/+|\/+$/g, '').split('/')
    let cur = root
    for (const part of parts) {
      cur = cur + '/' + part
      const mk = await req('MKCOL', cur)
      out.steps.push({ step: 'mkcol', url: cur, status: mk.status })
      if (![201, 405, 301].includes(mk.status)) throw new AppError('MKCOL 失败（' + mk.status + '）：' + cur + '（409 表示上级集合不存在）', EXIT.ERROR)
      if (mk.status === 405 || mk.status === 301) {
        // 405 既可能表示「已存在」，也可能表示「服务器不允许建目录」——用 PROPFIND 复核
        const chk = await req('PROPFIND', cur + '/', { depth: 0 })
        out.steps.push({ step: 'mkcol-check', url: cur, status: chk.status })
        if (chk.status === 404) throw new AppError('目录不存在，且服务器不允许 MKCOL（405）：' + cur + '；请先用其他方式建好该目录，或改用 --sub-dir 指向已存在的可写目录', EXIT.ERROR)
      }
    }
  } else if (![207, 200].includes(probe.status)) {
    throw new AppError('PROPFIND 探测失败（' + probe.status + '）：' + base, probe.status === 401 ? EXIT.ERROR : EXIT.ENV_MISSING)
  }

  const name = remoteName ?? path.basename(file)
  const target = base + '/' + name
  const put = await fetch(target, {
    method: 'PUT',
    headers: auth ? { Authorization: auth } : {},
    body: fs.readFileSync(file),
    signal: AbortSignal.timeout(Math.max(connectTimeoutSec * 1000, 900000)),
  })
  out.steps.push({ step: 'put', status: put.status })
  if (![200, 201, 204].includes(put.status)) {
    const hint = put.status === 405
      ? '（405 = 该路径不接受写入。常见原因：服务器只允许在子目录里放文件，根目录不可写；用 --sub-dir 指向一个已存在且可写的目录）'
      : put.status === 401 || put.status === 403 ? '（认证或权限不足）' : ''
    throw new AppError('PUT 失败（' + put.status + '）：' + target + hint, EXIT.ERROR)
  }

  // 存在性校验用 PROPFIND 列目录核 getcontentlength（HEAD 在部分服务上会误报 404）
  const list = await req('PROPFIND', base + '/', { depth: 1 })
  const m = new RegExp('<D:href>[^<]*' + name.replace(/[.*+?^\${}()|[\]\\]/g, '\\$&') + '</D:href>[\\s\\S]*?<D:getcontentlength>(\\d+)</D:getcontentlength>').exec(list.text)
  const remoteBytes = m ? Number(m[1]) : null
  out.remotePath = target
  out.remoteBytes = remoteBytes
  out.verified = remoteBytes === out.bytes
  out.steps.push({ step: 'verify', status: list.status, remoteBytes })
  if (!out.verified) throw new AppError('上传后校验失败：远端 ' + remoteBytes + ' B ≠ 本地 ' + out.bytes + ' B', EXIT.VERIFY_FAILED)

  if (deleteRemote.length) {
    out.deleted = []
    for (const d of deleteRemote) {
      const r = await req('DELETE', base + '/' + d)
      out.steps.push({ step: 'delete', name: d, status: r.status })
      if (![204, 200, 404].includes(r.status)) throw new AppError('DELETE 失败（' + r.status + '）：' + d, EXIT.ERROR)
      out.deleted.push({ name: d, status: r.status })
    }
  }
  return out
}
