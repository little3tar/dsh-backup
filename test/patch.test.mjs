/**
 * patch 合并的单元测试：node --test test/
 * 覆盖：新增 / 冲突 / 目标独有保留 / 空模板 [] / 无 id 条目 / 幂等 / overwrite / skip。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { parsePatch, mergePatch } from '../lib/patch.mjs'

const TARGET = ['# target header', '- id: keep-me', '  config:', '    a: 1', '- id: conflict', '  config:', '    v: old', '- id: only-target', '  config:', '    x: 1'].join('\n') + '\n'
const SOURCE = ['# package header', '- id: conflict', '  config:', '    v: new', '- id: new-one', '  config:', '    b: 2'].join('\n') + '\n'

test('解析：header 与 entry 边界', () => {
  const p = parsePatch(TARGET)
  assert.deepEqual(p.entries.map(e => e.id), ['keep-me', 'conflict', 'only-target'])
  assert.equal(p.header[0], '# target header')
  assert.equal(p.unkeyed.length, 0)
})

test('合并：目标顺序保留 + 冲突替换 + 新增追加 + 目标独有保留', () => {
  const r = mergePatch({ targetText: TARGET, sourceText: SOURCE })
  assert.deepEqual(r.added, ['new-one'])
  assert.deepEqual(r.replaced, ['conflict'])
  assert.deepEqual(r.kept, ['keep-me', 'only-target'])
  const out = parsePatch(r.text)
  assert.deepEqual(out.entries.map(e => e.id), ['keep-me', 'conflict', 'only-target', 'new-one'])
  assert.equal(out.entries[1].lines.join('\n').includes('v: new'), true)
  assert.equal(r.text.startsWith('# target header'), true)
})

test('合并：同 id 同内容不计入 replaced', () => {
  const tgt = ['- id: same', '  config:', '    v: 1'].join('\n') + '\n'
  const src = ['- id: same', '  config:', '    v: 1'].join('\n') + '\n'
  const r = mergePatch({ targetText: tgt, sourceText: src })
  assert.deepEqual(r.replaced, [])
  assert.equal(r.unchanged, true)
})

test('合并：结果幂等（再合并一次内容不变）', () => {
  const first = mergePatch({ targetText: TARGET, sourceText: SOURCE }).text
  const second = mergePatch({ targetText: first, sourceText: SOURCE })
  assert.equal(second.unchanged, true)
  assert.equal(second.text, first)
})

test('合并：空模板 [] 会被移除再追加条目', () => {
  const tgt = '# empty template\n[]\n'
  const r = mergePatch({ targetText: tgt, sourceText: SOURCE })
  assert.equal(r.text.includes('[]'), false)
  assert.equal(parsePatch(r.text).entries.length, 2)
})

test('合并：目标不存在时用包内 header 新建', () => {
  const r = mergePatch({ targetText: null, sourceText: SOURCE })
  assert.equal(r.text.startsWith('# package header'), true)
  assert.equal(r.added.length, 2)
})

test('合并：无 id 条目默认只保留目标侧', () => {
  const tgt = '- name: plain\n  config:\n    a: 1\n'
  const src = '- name: other\n  config:\n    b: 2\n'
  const r = mergePatch({ targetText: tgt, sourceText: src })
  assert.equal(r.text.includes('plain'), true)
  assert.equal(r.text.includes('other'), false)
  assert.equal(r.unkeyedAdded, 0)
})

test('合并：appendUnkeyed 才追加包内无 id 条目', () => {
  const tgt = '- name: plain\n  config:\n    a: 1\n'
  const src = '- name: other\n  config:\n    b: 2\n'
  const r = mergePatch({ targetText: tgt, sourceText: src, appendUnkeyed: true })
  assert.equal(r.text.includes('other'), true)
  assert.equal(r.unkeyedAdded, 1)
})

test('overwrite：用包内整文件替换', () => {
  const r = mergePatch({ targetText: TARGET, sourceText: SOURCE, strategy: 'overwrite' })
  const out = parsePatch(r.text)
  assert.deepEqual(out.entries.map(e => e.id), ['conflict', 'new-one'])
  assert.equal(r.text.startsWith('# package header'), true)
})

test('skip：完全不动', () => {
  const r = mergePatch({ targetText: TARGET, sourceText: SOURCE, strategy: 'skip' })
  assert.equal(r.unchanged, true)
  assert.equal(r.text, TARGET)
})

test('CRLF 目标保持 CRLF', () => {
  const tgt = TARGET.replace(/\n/g, '\r\n')
  const r = mergePatch({ targetText: tgt, sourceText: SOURCE })
  assert.equal(r.text.includes('\r\n'), true)
  assert.equal(/\r?\n/.test(r.text), true)
  assert.equal(r.text.split('\n').filter(l => l.endsWith('\r')).length > 5, true)
})
