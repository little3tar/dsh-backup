/**
 * plan → apply → verify 的集成测试（临时目录里造一个包和目标环境）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { plan, apply, verify } from '../lib/restore.mjs'
import { buildManifest } from '../lib/manifest.mjs'
import { writeJson, readText } from '../lib/core.mjs'

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

/** 造一个最小可恢复包 + 目标环境 */
function fixture() {
  const root = tmp('dshbk-')
  const pkg = path.join(root, 'pkg')
  const home = path.join(root, 'home')
  fs.mkdirSync(path.join(pkg, 'config', 'web'), { recursive: true })
  fs.mkdirSync(path.join(pkg, 'plugins', 'web'), { recursive: true })
  fs.mkdirSync(path.join(pkg, 'config', 'skills', 's-new'), { recursive: true })
  fs.mkdirSync(path.join(home, 'profiles', 'web'), { recursive: true })
  fs.mkdirSync(path.join(home, 'skills', 's-same'), { recursive: true })

  fs.writeFileSync(path.join(pkg, 'config', 'web', 'cordis.patch.yml'),
    ['# pkg', '- id: conflict', '  config:', '    v: new', '- id: new-one', '  config:', '    b: 2', ''].join('\n'))
  fs.writeFileSync(path.join(pkg, 'plugins', 'web', 'package.json'),
    JSON.stringify({ name: 'dsh-profile-web', dependencies: { 'my-local': 'file:../x', other: '1.0.0' }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }, null, 2))
  fs.writeFileSync(path.join(pkg, 'config', 'skills', 's-new', 'SKILL.md'), 'new')
  fs.writeFileSync(path.join(home, 'profiles', 'web', 'cordis.patch.yml'),
    ['# target', '- id: conflict', '  config:', '    v: old', '- id: only-target', '  config:', '    x: 1', ''].join('\n'))
  fs.writeFileSync(path.join(home, 'profiles', 'web', 'package.json'),
    JSON.stringify({ name: 'dsh-profile-web', dependencies: { 'my-local': 'file:../../old', other: '1.0.0' }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }, null, 2))
  fs.writeFileSync(path.join(home, 'skills', 's-same', 'SKILL.md'), 'same')
  fs.mkdirSync(path.join(pkg, 'config', 'skills', 's-same'), { recursive: true })
  fs.writeFileSync(path.join(pkg, 'config', 'skills', 's-same', 'SKILL.md'), 'same')

  // 本地依赖
  fs.mkdirSync(path.join(pkg, 'local-deps', 'web', 'my-local'), { recursive: true })
  fs.writeFileSync(path.join(pkg, 'local-deps', 'web', 'my-local', 'package.json'), JSON.stringify({ name: 'my-local', version: '1.0.0', main: 'index.js' }))
  fs.writeFileSync(path.join(pkg, 'local-deps', 'web', 'my-local', 'index.js'), 'module.exports=1')

  // 凭据
  fs.mkdirSync(path.join(pkg, 'credentials'), { recursive: true })
  fs.writeFileSync(path.join(pkg, 'credentials', 'credentials.yaml'), 'a: b\n')
  fs.writeFileSync(path.join(pkg, 'credentials', 'CREDENTIALS-SOURCES.txt'),
    ['# alias | 源 | 包内 | 目标', 'credentials.yaml | .credentials.yaml | credentials/credentials.yaml | $DSH_HOME/.credentials.yaml', ''].join('\n'))

  const manifest = buildManifest({ pkgDir: pkg, homeDir: home, categories: ['1', '2', '3'], credentials: true })
  writeJson(path.join(pkg, 'manifest.json'), manifest)
  return { root, pkg, home, agentsHome: path.join(root, 'agents') }
}

test('plan：识别新增/冲突/仅目标有', () => {
  const f = fixture()
  const pl = plan({ pkgDir: f.pkg, home: f.home, agentsHome: f.agentsHome, includeCredentials: false })
  const merge = pl.steps.find(s => s.op === 'merge-config')
  assert.deepEqual(merge.added, ['new-one'])
  assert.deepEqual(merge.replaced, ['conflict'])
  assert.deepEqual(merge.kept, ['only-target'])
  assert.deepEqual(merge.conflicted, ['id:conflict'])
  const cred = pl.steps.find(s => s.op === 'copy-credentials')
  assert.equal(cred.skipped, true)
  assert.ok(pl.decisions.some(d => d.id === 'credentials'))
})

test('apply：按 id 合并、保留目标独有、改写本地依赖 spec、生成备份', () => {
  const f = fixture()
  const pl = plan({ pkgDir: f.pkg, home: f.home, agentsHome: f.agentsHome, includeCredentials: true })
  const r = apply(pl, { apply: true })
  assert.equal(r.failed.length, 0)
  const merged = readText(path.join(f.home, 'profiles', 'web', 'cordis.patch.yml'))
  assert.ok(merged.includes('v: new'))
  assert.ok(merged.includes('only-target'))
  assert.ok(merged.includes('new-one'))
  assert.ok(merged.startsWith('# target'))

  const pj = JSON.parse(readText(path.join(f.home, 'profiles', 'web', 'package.json')))
  assert.ok(String(pj.dependencies['my-local']).startsWith('link:'))
  assert.ok(String(pj.dependencies['my-local']).endsWith('my-local'))

  const baks = fs.readdirSync(path.join(f.home, 'profiles', 'web')).filter(n => n.includes('.bak-'))
  assert.ok(baks.length >= 1)
  assert.ok(fs.existsSync(path.join(f.home, 'skills', 's-new', 'SKILL.md')))
  assert.equal(readText(path.join(f.home, '.credentials.yaml')), 'a: b\n')
})

test('apply 幂等：第二次不再变更', () => {
  const f = fixture()
  apply(plan({ pkgDir: f.pkg, home: f.home, agentsHome: f.agentsHome, includeCredentials: true }), { apply: true })
  const pl2 = plan({ pkgDir: f.pkg, home: f.home, agentsHome: f.agentsHome, includeCredentials: true })
  const merge = pl2.steps.find(s => s.op === 'merge-config')
  assert.equal(merge.unchanged, true)
  const r2 = apply(pl2, { apply: true })
  assert.equal(r2.failed.length, 0)
})

test('verify：恢复后通过；未恢复时报失败', () => {
  const f = fixture()
  const before = verify({ pkgDir: f.pkg, home: f.home, agentsHome: f.agentsHome })
  assert.equal(before.ok, false)
  apply(plan({ pkgDir: f.pkg, home: f.home, agentsHome: f.agentsHome, includeCredentials: true }), { apply: true })
  const after = verify({ pkgDir: f.pkg, home: f.home, agentsHome: f.agentsHome })
  assert.equal(after.failures.filter(x => x.includes('entry')).length, 0)
})

test('apply dry-run 不写盘', () => {
  const f = fixture()
  const before = readText(path.join(f.home, 'profiles', 'web', 'cordis.patch.yml'))
  apply(plan({ pkgDir: f.pkg, home: f.home, agentsHome: f.agentsHome }), { apply: false })
  assert.equal(readText(path.join(f.home, 'profiles', 'web', 'cordis.patch.yml')), before)
  assert.equal(fs.existsSync(path.join(f.home, 'skills', 's-new')), false)
})
