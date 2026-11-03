/**
 * 备份端回归测试：符号链接（含 Windows 目录联接）不得让 staging 崩溃，
 * 且必须按真实内容打包（解引用），否则换机器还原会拿到空目录。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { stage } from '../lib/backup.mjs'
import { hashFile } from '../lib/core.mjs'

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-'))
  const real = path.join(root, 'real-skill')
  fs.mkdirSync(path.join(real, 'references'), { recursive: true })
  fs.writeFileSync(path.join(real, 'SKILL.md'), 'demo')
  fs.writeFileSync(path.join(real, 'references', 'a.md'), 'ref')
  const home = path.join(root, 'home')
  fs.mkdirSync(path.join(home, 'skills'), { recursive: true })
  fs.symlinkSync(real, path.join(home, 'skills', 'linked-skill'), process.platform === 'win32' ? 'junction' : 'dir')
  fs.writeFileSync(path.join(home, 'AGENTS.md'), 'agents')
  return { root, home, agentsHome: path.join(root, 'agents'), workDir: path.join(root, 'w') }
}

test('stage：技能目录是链接时按真实内容打包，不抛 EISDIR', () => {
  const f = fixture()
  const res = stage({
    home: f.home, agentsHome: f.agentsHome, workDir: f.workDir, packageName: 'p',
    categories: ['1'], includeCredentials: false, profiles: [],
  })
  const dir = path.join(res.stageDir, 'config', 'skills', 'linked-skill')
  assert.equal(fs.lstatSync(dir).isSymbolicLink(), false)
  assert.equal(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'), 'demo')
  assert.equal(fs.readFileSync(path.join(dir, 'references', 'a.md'), 'utf8'), 'ref')
})

test('hashFile：目录（含指向目录的链接）返回稳定标记而不是抛错', () => {
  const f = fixture()
  assert.equal(hashFile(f.home), 'dir')
  assert.equal(hashFile(path.join(f.home, 'skills', 'linked-skill')), 'dir')
  assert.equal(typeof hashFile(path.join(f.home, 'AGENTS.md')), 'string')
})
