/**
 * cordis.patch.yml 的「按 key 合并」。
 *
 * patch 层是顶层 YAML 数组，元素是 loader patch entry：
 *   - override：用 id 定位某条目，覆盖它的 config / disabled 等（id 后可能跟注释）
 *   - insert：用 insert: [ ... ] 插入若干新条目（自身无 id，靠被插入条目的 id 识别）
 * 这里按行拆分而不做完整 YAML 解析：只为保留注释、缩进、引号与 !!js 表达式原样不动。
 * DSH 用 yaml 库解析，注释会被丢弃，所以 - id: foo # note 的 id 就是 foo。
 */

import { hashText } from './core.mjs'

const ENTRY_START = /^-\s/
const ID_LINE = /^-\s+id:\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^']|'')*)'|([^\s#]+))/
const INSERT_LINE = /^-\s+insert:\s*(?:#.*)?$/
const NESTED_ID = /^\s+-\s+id:\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^']|'')*)'|([^\s#]+))/

const picks = m => (m[1] ?? m[2] ?? m[3] ?? '').trim()

/** 条目 key：override 用 id，insert 用被插入 id 集合，其余用内容指纹 */
export function entryKey(entry) {
  if (entry.kind === 'override' && entry.id) return 'id:' + entry.id
  if (entry.kind === 'insert') {
    const ids = entry.insertIds.length ? entry.insertIds.slice().sort().join(',') : hashText(entry.lines.join('\n')).slice(0, 12)
    return 'insert:' + ids
  }
  return 'raw:' + hashText(entry.lines.join('\n')).slice(0, 12)
}

/** 拆分 patch 文本 */
export function parsePatch(text) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const header = []
  const raw = []
  let cur = null
  for (const line of text.split(/\r?\n/)) {
    if (ENTRY_START.test(line)) {
      if (cur) raw.push(cur)
      let kind = 'unknown'
      let id = null
      if (INSERT_LINE.test(line)) kind = 'insert'
      else {
        const m = ID_LINE.exec(line)
        if (m) { kind = 'override'; id = picks(m) }
      }
      cur = { kind, id, insertIds: [], key: '', lines: [line] }
    } else if (cur) {
      cur.lines.push(line)
    } else {
      header.push(line)
    }
  }
  if (cur) raw.push(cur)

  const entries = []
  const unkeyed = []
  for (const e of raw) {
    while (e.lines.length && !e.lines[e.lines.length - 1].trim()) e.lines.pop()
    if (e.kind === 'insert') {
      e.insertIds = e.lines.map(l => NESTED_ID.exec(l)).filter(Boolean).map(m => picks(m)).filter(Boolean)
    }
    e.key = entryKey(e)
    if (e.kind === 'unknown') unkeyed.push(e)
    else entries.push(e)
  }
  return { header, entries, unkeyed, eol }
}

/** 条目内容指纹 */
export function entryHash(entry) {
  return hashText(entry.lines.join('\n'))
}

/** key 到指纹（override / insert / unknown 全部参与） */
export function entryHashes(parts) {
  const map = new Map()
  for (const e of [...parts.entries, ...parts.unkeyed]) map.set(e.key, entryHash(e))
  return map
}

/** 把条目列表渲染回文本；有条目时丢弃 [] 占位行 */
export function renderPatch(parts, ordered) {
  const out = []
  for (const h of parts.header) if (h.trim() !== '[]') out.push(h)
  if (!ordered.length) out.push('[]')
  for (const e of ordered) out.push(...e.lines)
  return out.join(parts.eol) + parts.eol
}

/** 报告用的可读标签 */
export const entryLabel = e => (e.kind === 'override' ? e.id : e.kind === 'insert' ? 'insert:' + (e.insertIds.join(',') || '?') : e.key)

/**
 * 合并：目标顺序保留，同 key 用包内值替换，包内新 key 追加，目标独有保留。
 * insert 按「被插入 id 集合」识别，因此重复恢复不会叠出多份。
 */
export function mergePatch({ targetText = null, sourceText, strategy = 'merge' }) {
  const src = parsePatch(sourceText)
  const tgt = targetText == null
    ? { header: [], entries: [], unkeyed: [], eol: src.eol }
    : parsePatch(targetText)
  const eol = targetText == null ? src.eol : tgt.eol
  const srcAll = [...src.entries, ...src.unkeyed]
  const result = { added: [], replaced: [], conflicted: [], kept: [], inserts: [], unchanged: false, text: targetText }

  if (strategy === 'skip') { result.unchanged = true; return result }

  if (strategy === 'overwrite') {
    const text = renderPatch({ header: src.header, eol }, srcAll)
    result.added = srcAll.map(entryLabel)
    result.replaced = [...tgt.entries, ...tgt.unkeyed].map(entryLabel)
    result.inserts = src.entries.filter(e => e.kind === 'insert').map(entryLabel)
    result.unchanged = targetText != null && text === targetText
    result.text = text
    return result
  }

  const order = [...tgt.entries, ...tgt.unkeyed]
  const index = new Map(order.map((e, i) => [e.key, i]))
  for (const e of srcAll) {
    if (index.has(e.key)) {
      const prev = order[index.get(e.key)]
      if (entryHash(prev) !== entryHash(e)) { result.replaced.push(entryLabel(e)); result.conflicted.push(e.key) }
      order[index.get(e.key)] = e
    } else {
      index.set(e.key, order.length)
      order.push(e)
      result.added.push(entryLabel(e))
      if (e.kind === 'insert') result.inserts.push(entryLabel(e))
    }
  }
  const srcKeys = new Set(srcAll.map(e => e.key))
  result.kept = order.filter(e => !srcKeys.has(e.key)).map(entryLabel)

  const header = tgt.header.length ? tgt.header : src.header
  const text = renderPatch({ header, eol }, order)
  result.unchanged = targetText != null && text === targetText
  result.text = text
  return result
}

/** 统计（报告用） */
export function patchStats(parts) {
  return {
    entries: parts.entries.length + parts.unkeyed.length,
    overrides: parts.entries.filter(e => e.kind === 'override').length,
    inserts: parts.entries.filter(e => e.kind === 'insert').length,
    unknown: parts.unkeyed.length,
    ids: parts.entries.filter(e => e.kind === 'override').map(e => e.id),
  }
}
