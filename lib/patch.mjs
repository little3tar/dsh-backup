/**
 * cordis.patch.yml 的「按 entry id 合并」。
 *
 * 这里**不是**一个通用 YAML 解析器：patch 层是「顶层 YAML 数组，元素是 loader patch entry」，
 * 我们只需要按行切出每个 '- ' 开头的条目块、读出它的 id，然后原样搬移。
 * 保留原文的好处：注释、缩进、引号风格、!!js 表达式都不会被改写。
 */

import { hashText } from './core.mjs'

const ENTRY_START = /^-\s/
const ID_LINE = /^-\s+id:\s*(\S+)\s*$/

/**
 * @typedef {{ id: string|null, lines: string[] }} Entry
 * @typedef {{ exists?: boolean, header: string[], entries: Entry[], unkeyed: Entry[], eol: string }} PatchParts
 */

/** 拆分 patch 文本 */
export function parsePatch(text) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const header = []
  const entries = []
  let cur = null
  for (const line of text.split(/\r?\n/)) {
    if (ENTRY_START.test(line)) {
      if (cur) entries.push(cur)
      const m = ID_LINE.exec(line)
      cur = { id: m ? m[1] : null, lines: [line] }
    } else if (cur) {
      cur.lines.push(line)
    } else {
      header.push(line)
    }
  }
  if (cur) entries.push(cur)
  // 去掉条目块尾部的空行（文件末尾换行会带出一个空串）
  for (const e of entries) {
    while (e.lines.length && !e.lines[e.lines.length - 1].trim()) e.lines.pop()
  }
  return {
    header,
    entries: entries.filter(e => e.id),
    unkeyed: entries.filter(e => !e.id),
    eol,
  }
}

/** 条目内容指纹：用来判断「同 id 但内容不同」 */
export function entryHash(entry) {
  return hashText(entry.lines.join('\n'))
}

/** 每个 id 的指纹表 */
export function entryHashes(parts) {
  const map = new Map()
  for (const e of parts.entries) map.set(e.id, entryHash(e))
  return map
}

/** 把 parts 渲染回文本。有条目时丢弃 '[]' 占位行。 */
export function renderPatch(parts, orderedEntries, eol, unkeyedSource) {
  const out = []
  for (const h of parts.header) if (h.trim() !== '[]') out.push(h)
  if (!orderedEntries.length && !(unkeyedSource?.length ?? 0)) out.push('[]')
  for (const e of orderedEntries) out.push(...e.lines)
  for (const e of unkeyedSource ?? []) out.push(...e.lines)
  return out.join(eol) + eol
}

/**
 * 合并：目标顺序保留 → 同 id 用包内值替换 → 包内新 id 追加 → 目标独有保留。
 * @param {{targetText?: string|null, sourceText: string, strategy?: 'merge'|'overwrite'|'skip', appendUnkeyed?: boolean}} opts
 */
export function mergePatch({ targetText = null, sourceText, strategy = 'merge', appendUnkeyed = false }) {
  const src = parsePatch(sourceText)
  const tgt = targetText == null ? { header: [], entries: [], unkeyed: [], eol: src.eol } : parsePatch(targetText)
  const eol = targetText == null ? src.eol : tgt.eol
  const result = {
    added: [],
    replaced: [],
    kept: [],
    unkeyedAdded: 0,
    unchanged: false,
    text: targetText,
  }

  if (strategy === 'skip') {
    result.unchanged = true
    return result
  }

  if (strategy === 'overwrite') {
    const ordered = [...src.entries, ...src.unkeyed]
    const text = renderPatch({ header: src.header }, ordered, eol)
    result.added = src.entries.map(e => e.id)
    result.replaced = tgt.entries.map(e => e.id)
    result.unchanged = targetText != null && text === targetText
    result.text = text
    return result
  }

  const order = [...tgt.entries]
  const index = new Map(order.map((e, i) => [e.id, i]))
  for (const e of src.entries) {
    if (index.has(e.id)) {
      // 只有内容真的不同才算「覆盖」；同 id 同内容不该出现在变更报告里
      if (entryHash(order[index.get(e.id)]) !== entryHash(e)) result.replaced.push(e.id)
      order[index.get(e.id)] = e
    } else {
      index.set(e.id, order.length)
      order.push(e)
      result.added.push(e.id)
    }
  }
  const srcIds = new Set(src.entries.map(e => e.id))
  result.kept = tgt.entries.filter(e => !srcIds.has(e.id)).map(e => e.id)

  const unkeyed = appendUnkeyed ? [...tgt.unkeyed, ...src.unkeyed] : [...tgt.unkeyed]
  result.unkeyedAdded = appendUnkeyed ? src.unkeyed.length : 0

  const header = tgt.header.length ? tgt.header : src.header
  const text = renderPatch({ header }, order, eol, unkeyed)
  result.unchanged = targetText != null && text === targetText
  result.text = text
  return result
}

/** 统计（给报告用） */
export function patchStats(parts) {
  return { entries: parts.entries.length, unkeyed: parts.unkeyed.length, ids: parts.entries.map(e => e.id) }
}
