/**
 * Diff engine: what changed between a snapshot and the live configuration
 * (or between two snapshots). Diffs are line-based so they work for YAML,
 * JSON, lockfiles and any text without a parser dependency, and secret values
 * are masked on the way out: the structure of a change is always visible, the
 * value of a key never is.
 */

import { readSnapshotFile, loadManifest } from './snapshot.js'
import { collectFiles, resolveScopes } from './scopes.js'
import { toVaultContext } from './paths.js'
import { maskText, MASK } from './secrets.js'
import { fromLogicalPath, readFileIfExists, sha256 } from './util.js'
import { VaultError } from './errors.js'

/** Files bigger than this in line count fall back to a coarse changed view. */
const LINE_DIFF_MAX_LINES = 3000
/** DP cell budget for the LCS table (lines a * lines b). */
const LINE_DIFF_MAX_CELLS = 4_000_000
/** Default display budget per file. */
const DEFAULT_MAX_HUNKS = 12
const DEFAULT_MAX_LINES_PER_HUNK = 60

/**
 * @typedef {object} DiffLine
 * @property {'context'|'add'|'remove'} type
 * @property {string} text masked display text
 * @property {number} [oldLine] 1-based line number in the base
 * @property {number} [newLine] 1-based line number in the target
 */

/**
 * @typedef {object} DiffHunk
 * @property {number} oldStart
 * @property {number} newStart
 * @property {DiffLine[]} lines
 */

/**
 * @typedef {object} FileDiff
 * @property {string} path logical path
 * @property {string} scope scope id
 * @property {'added'|'removed'|'changed'|'same'} status
 * @property {number} [oldSize]
 * @property {number} [newSize]
 * @property {boolean} secret
 * @property {boolean} binary
 * @property {DiffHunk[]} hunks
 * @property {number} added number of added lines
 * @property {number} removed number of removed lines
 * @property {boolean} truncated display budget was hit
 * @property {string[]} [jsonPaths] changed JSON key paths (JSON files only)
 */

/**
 * Diff a snapshot against the live configuration.
 * @param {string} home
 * @param {string} id snapshot id (base)
 * @param {{ scopes?: string[], maxHunks?: number, maxLinesPerHunk?: number }} [options]
 * @returns {Promise<{ base: { kind: 'snapshot', id: string, name: string, createdAt: string }, target: { kind: 'current' }, scopes: string[], files: FileDiff[], summary: object, warnings: string[] }>}
 */
export async function diffSnapshotVsCurrent(context, id, options = {}) {
  const { roots } = toVaultContext(context)
  const manifest = await loadManifest(context, id)
  const scopes = resolveScopeFilter(manifest, options.scopes)
  /** @type {Map<string, { path: string, scope: string, sha256?: string, size?: number, secret?: boolean, read: () => Promise<Buffer|undefined> }>} */
  const base = new Map()
  for (const file of manifest.files) {
    if (!scopes.includes(file.scope)) continue
    base.set(file.path, {
      path: file.path,
      scope: file.scope,
      sha256: file.sha256,
      size: file.size,
      secret: file.secret,
      read: () => readSnapshotFile(context, manifest, file.path),
    })
  }
  const currentFiles = await collectFiles(roots, resolveScopes(scopes).scopes)
  /** @type {Map<string, { path: string, scope: string, sha256?: string, size?: number, secret?: boolean, read: () => Promise<Buffer|undefined> }>} */
  const target = new Map()
  for (const file of currentFiles) {
    const physical = fromLogicalPath(roots, file.logicalPath)
    target.set(file.logicalPath, {
      path: file.logicalPath,
      scope: file.scope,
      secret: file.secret,
      read: () => readFileIfExists(physical),
    })
  }
  const files = await diffMaps(base, target, options)
  return {
    base: { kind: 'snapshot', id: manifest.id, name: manifest.name, createdAt: manifest.createdAt },
    target: { kind: 'current' },
    scopes,
    files: files.files,
    summary: files.summary,
    warnings: files.warnings,
  }
}

/**
 * Diff two snapshots (base = older/left, target = newer/right).
 * @param {string} home
 * @param {string} baseId
 * @param {string} targetId
 * @param {{ scopes?: string[], maxHunks?: number, maxLinesPerHunk?: number }} [options]
 */
export async function diffSnapshots(context, baseId, targetId, options = {}) {
  const baseManifest = await loadManifest(context, baseId)
  const targetManifest = await loadManifest(context, targetId)
  const allowed = options.scopes !== undefined && options.scopes.length > 0
    ? options.scopes
    : intersectScopes(baseManifest.scopes, targetManifest.scopes)
  /** @type {Map<string, any>} */
  const base = new Map()
  for (const file of baseManifest.files) {
    if (!allowed.includes(file.scope)) continue
    base.set(file.path, {
      path: file.path, scope: file.scope, sha256: file.sha256, size: file.size, secret: file.secret,
      read: () => readSnapshotFile(context, baseManifest, file.path),
    })
  }
  /** @type {Map<string, any>} */
  const target = new Map()
  for (const file of targetManifest.files) {
    if (!allowed.includes(file.scope)) continue
    target.set(file.path, {
      path: file.path, scope: file.scope, sha256: file.sha256, size: file.size, secret: file.secret,
      read: () => readSnapshotFile(context, targetManifest, file.path),
    })
  }
  const files = await diffMaps(base, target, options)
  return {
    base: { kind: 'snapshot', id: baseManifest.id, name: baseManifest.name, createdAt: baseManifest.createdAt },
    target: { kind: 'snapshot', id: targetManifest.id, name: targetManifest.name, createdAt: targetManifest.createdAt },
    scopes: allowed,
    files: files.files,
    summary: files.summary,
    warnings: files.warnings,
  }
}

/**
 * Restrict a request to scopes the snapshot actually contains.
 * @param {{ scopes: string[] }} manifest
 * @param {string[]|undefined} requested
 */
function resolveScopeFilter(manifest, requested) {
  if (requested === undefined || requested.length === 0) return [...manifest.scopes]
  const allowed = requested.filter(scope => manifest.scopes.includes(scope))
  if (allowed.length === 0) throw new VaultError('scope-not-in-snapshot', 'none of the requested scopes are in this snapshot', { available: manifest.scopes })
  return allowed
}

/**
 * Intersect two scope lists preserving base order.
 * @param {string[]} a
 * @param {string[]} b
 */
function intersectScopes(a, b) {
  return a.filter(scope => b.includes(scope))
}

/**
 * Diff two file maps. Hash equality short-circuits the content compare.
 * @param {Map<string, any>} base
 * @param {Map<string, any>} target
 * @param {{ maxHunks?: number, maxLinesPerHunk?: number }} options
 */
async function diffMaps(base, target, options = {}) {
  const paths = new Set([...base.keys(), ...target.keys()])
  /** @type {FileDiff[]} */
  const files = []
  /** @type {string[]} */
  const warnings = []
  const summary = { added: 0, removed: 0, changed: 0, same: 0, total: 0, secretFiles: 0 }
  for (const path of [...paths].sort()) {
    const oldEntry = base.get(path)
    const newEntry = target.get(path)
    if (oldEntry === undefined && newEntry === undefined) continue
    summary.total += 1
    if (oldEntry !== undefined && newEntry === undefined) {
      summary.removed += 1
      const oldData = await oldEntry.read()
      const shown = oldData === undefined ? undefined : wholeFileDiff(oldData, 'remove', options)
      files.push({
        path, scope: oldEntry.scope, status: 'removed', oldSize: oldEntry.size, secret: oldEntry.secret === true,
        ...(shown ?? { binary: false, hunks: [], added: 0, removed: 0, truncated: false }),
      })
      continue
    }
    if (oldEntry === undefined && newEntry !== undefined) {
      summary.added += 1
      const newData = await newEntry.read()
      const shown = newData === undefined ? undefined : wholeFileDiff(newData, 'add', options)
      files.push({
        path, scope: newEntry.scope, status: 'added', newSize: newEntry.size, secret: newEntry.secret === true,
        ...(shown ?? { binary: false, hunks: [], added: 0, removed: 0, truncated: false }),
      })
      continue
    }
    if (oldEntry.sha256 !== undefined && newEntry.sha256 !== undefined && oldEntry.sha256 === newEntry.sha256) {
      summary.same += 1
      continue
    }
    const oldData = await oldEntry.read()
    const newData = await newEntry.read()
    if (oldData === undefined || newData === undefined) continue
    if (sha256(oldData) === sha256(newData)) {
      summary.same += 1
      continue
    }
    summary.changed += 1
    if (oldEntry.secret === true || newEntry.secret === true) summary.secretFiles += 1
    const diff = diffBuffers(path, oldData, newData, {
      maxHunks: options.maxHunks ?? DEFAULT_MAX_HUNKS,
      maxLinesPerHunk: options.maxLinesPerHunk ?? DEFAULT_MAX_LINES_PER_HUNK,
    })
    files.push({
      path,
      scope: newEntry.scope,
      status: 'changed',
      oldSize: oldData.length,
      newSize: newData.length,
      secret: oldEntry.secret === true || newEntry.secret === true,
      ...diff,
    })
    if (diff.truncated) warnings.push(`${path} 的差异过大，仅显示前 ${options.maxHunks ?? DEFAULT_MAX_HUNKS} 段`)
  }
  return { files, summary, warnings }
}

/**
 * Diff two buffers: text gets line hunks, binary gets a summary only.
 * @param {string} path
 * @param {Buffer} oldData
 * @param {Buffer} newData
 * @param {{ maxHunks: number, maxLinesPerHunk: number }} budget
 */
function diffBuffers(path, oldData, newData, budget) {
  const oldText = decodeText(oldData)
  const newText = decodeText(newData)
  if (oldText === undefined || newText === undefined) {
    return { binary: true, hunks: [], added: 0, removed: 0, truncated: false }
  }
  const oldLines = splitLines(oldText)
  const newLines = splitLines(newText)
  const ops = lineOps(oldLines, newLines)
  const hunks = buildHunks(ops, budget)
  const added = ops.filter(op => op.type === 'add').length
  const removed = ops.filter(op => op.type === 'remove').length
  /** @type {string[]|undefined} */
  let jsonPaths
  if (/\.(json)$/i.test(path)) {
    try {
      jsonPaths = changedJsonPaths(JSON.parse(oldText), JSON.parse(newText)).slice(0, 200)
    } catch {
      jsonPaths = undefined
    }
  }
  return {
    binary: false,
    hunks: hunks.hunks,
    added,
    removed,
    truncated: hunks.truncated,
    ...(jsonPaths === undefined ? {} : { jsonPaths }),
  }
}

/**
 * Render an added or removed file as one whole-file hunk, so the client and
 * CLI show the content instead of a bare "added/removed" line. Masked and
 * line-capped like any other hunk.
 * @param {Buffer} data
 * @param {'add'|'remove'} type
 * @param {{ maxLinesPerHunk?: number }} [options]
 * @returns {{ binary: boolean, hunks: DiffHunk[], added: number, removed: number, truncated: boolean }}
 */
function wholeFileDiff(data, type, options = {}) {
  const text = decodeText(data)
  if (text === undefined) return { binary: true, hunks: [], added: 0, removed: 0, truncated: false }
  const lines = splitLines(text)
  // A trailing newline ends the last line rather than starting an empty one.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  const maxLines = options.maxLinesPerHunk ?? DEFAULT_MAX_LINES_PER_HUNK
  const shown = lines.slice(0, maxLines)
  /** @type {DiffHunk[]} */
  const hunks = shown.length === 0 ? [] : [{
    oldStart: type === 'remove' ? 1 : 0,
    newStart: type === 'add' ? 1 : 0,
    lines: shown.map((line, index) => ({
      type,
      text: maskText(line),
      ...(type === 'remove' ? { oldLine: index + 1 } : { newLine: index + 1 }),
    })),
  }]
  return {
    binary: false,
    hunks,
    added: type === 'add' ? lines.length : 0,
    removed: type === 'remove' ? lines.length : 0,
    truncated: shown.length < lines.length,
  }
}

/**
 * Normalize display lines: drop a UTF-8 BOM and unify CRLF so an editor that
 * added one does not turn every line into a change. The stored payload keeps
 * the original bytes; restore is always byte-exact.
 * @param {string} text
 * @returns {string[]}
 */
function splitLines(text) {
  return text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').split('\n')
}

/**
 * Decode a buffer as UTF-8 text, returning undefined for binary content.
 * @param {Buffer} data
 * @returns {string|undefined}
 */
function decodeText(data) {
  if (data.includes(0)) return undefined
  const text = data.toString('utf8')
  // Replacement characters mean this was not valid UTF-8.
  return text.includes('\uFFFD') ? undefined : text
}

/**
 * Produce an edit script between two line arrays with an LCS table. The
 * table is capped: beyond the budget the tail is summarized as a wholesale
 * change, which is honest and keeps the tool cheap on lockfiles.
 * @param {string[]} oldLines
 * @param {string[]} newLines
 * @returns {Array<{ type: 'context'|'add'|'remove', oldIndex?: number, newIndex?: number, text: string }>}
 */
function lineOps(oldLines, newLines) {
  const n = oldLines.length
  const m = newLines.length
  if (n * m > LINE_DIFF_MAX_CELLS || n > LINE_DIFF_MAX_LINES || m > LINE_DIFF_MAX_LINES) {
    return coarseOps(oldLines, newLines)
  }
  // Classic LCS lengths, one row at a time (Int32Array keeps memory flat).
  const width = m + 1
  const table = new Int32Array((n + 1) * width)
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i * width + j] = oldLines[i] === newLines[j]
        ? table[(i + 1) * width + j + 1] + 1
        : Math.max(table[(i + 1) * width + j], table[i * width + j + 1])
    }
  }
  /** @type {Array<{ type: 'context'|'add'|'remove', oldIndex?: number, newIndex?: number, text: string }>} */
  const ops = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      ops.push({ type: 'context', oldIndex: i, newIndex: j, text: oldLines[i] })
      i += 1
      j += 1
    } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
      ops.push({ type: 'remove', oldIndex: i, text: oldLines[i] })
      i += 1
    } else {
      ops.push({ type: 'add', newIndex: j, text: newLines[j] })
      j += 1
    }
  }
  while (i < n) {
    ops.push({ type: 'remove', oldIndex: i, text: oldLines[i] })
    i += 1
  }
  while (j < m) {
    ops.push({ type: 'add', newIndex: j, text: newLines[j] })
    j += 1
  }
  return ops
}

/**
 * Fallback edit script for oversized files: common prefix/suffix as context,
 * everything between them replaced.
 * @param {string[]} oldLines
 * @param {string[]} newLines
 */
function coarseOps(oldLines, newLines) {
  /** @type {Array<{ type: 'context'|'add'|'remove', oldIndex?: number, newIndex?: number, text: string }>} */
  const ops = []
  let prefix = 0
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) {
    ops.push({ type: 'context', oldIndex: prefix, newIndex: prefix, text: oldLines[prefix] })
    prefix += 1
  }
  let suffix = 0
  while (
    suffix < oldLines.length - prefix
    && suffix < newLines.length - prefix
    && oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1
  }
  for (let index = prefix; index < oldLines.length - suffix; index += 1) {
    ops.push({ type: 'remove', oldIndex: index, text: oldLines[index] })
  }
  for (let index = prefix; index < newLines.length - suffix; index += 1) {
    ops.push({ type: 'add', newIndex: index, text: newLines[index] })
  }
  for (let index = 0; index < suffix; index += 1) {
    ops.push({
      type: 'context',
      oldIndex: oldLines.length - suffix + index,
      newIndex: newLines.length - suffix + index,
      text: oldLines[oldLines.length - suffix + index],
    })
  }
  return ops
}

/**
 * Group an edit script into hunks with 3 lines of context, honoring the
 * display budget. Two change runs separated by at most 2*CONTEXT unchanged
 * lines share a hunk; wider gaps start a new one.
 * @param {Array<{ type: 'context'|'add'|'remove', oldIndex?: number, newIndex?: number, text: string }>} ops
 * @param {{ maxHunks: number, maxLinesPerHunk: number }} budget
 */
function buildHunks(ops, budget) {
  const CONTEXT = 3
  /** @type {number[]} */
  const changeIndices = []
  for (let index = 0; index < ops.length; index += 1) {
    if (ops[index].type !== 'context') changeIndices.push(index)
  }
  if (changeIndices.length === 0) return { hunks: [], truncated: false, consumed: 0 }

  /** @type {Array<{ start: number, end: number }>} */
  const ranges = []
  let start = changeIndices[0]
  let end = changeIndices[0]
  for (const index of changeIndices.slice(1)) {
    if (index - end > CONTEXT * 2) {
      ranges.push({ start, end })
      start = index
    }
    end = index
  }
  ranges.push({ start, end })

  /** @type {DiffHunk[]} */
  const hunks = []
  let clippedAny = false
  for (const range of ranges) {
    if (hunks.length >= budget.maxHunks) break
    const from = Math.max(0, range.start - CONTEXT)
    const to = Math.min(ops.length - 1, range.end + CONTEXT)
    const slice = ops.slice(from, to + 1)
    const clipped = slice.slice(0, budget.maxLinesPerHunk)
    if (clipped.length < slice.length) clippedAny = true
    const first = clipped[0]
    hunks.push({
      oldStart: (first.oldIndex ?? range.start) + 1,
      newStart: (first.newIndex ?? range.start) + 1,
      lines: clipped.map(op => ({
        type: op.type,
        text: maskText(op.text),
        ...(op.oldIndex === undefined ? {} : { oldLine: op.oldIndex + 1 }),
        ...(op.newIndex === undefined ? {} : { newLine: op.newIndex + 1 }),
      })),
    })
  }
  return { hunks, truncated: clippedAny || hunks.length < ranges.length }
}

/**
 * Compare parsed JSON documents by flattened key path.
 * @param {unknown} oldValue
 * @param {unknown} newValue
 * @param {string} [prefix]
 * @returns {string[]} `+ path`, `- path`, `~ path` markers
 */
export function changedJsonPaths(oldValue, newValue, prefix = '') {
  /** @type {string[]} */
  const changes = []
  const kind = (value) => (Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value)
  const oldKind = kind(oldValue)
  const newKind = kind(newValue)
  if (oldKind !== newKind) {
    changes.push(`~ ${prefix || '(root)'} (${oldKind} → ${newKind})`)
    return changes
  }
  if (oldKind === 'object') {
    const oldObject = /** @type {Record<string, unknown>} */ (oldValue)
    const newObject = /** @type {Record<string, unknown>} */ (newValue)
    for (const key of new Set([...Object.keys(oldObject), ...Object.keys(newObject)])) {
      const path = `${prefix}${prefix === '' ? '' : '.'}${key}`
      const displayPath = /(api[_-]?key|token|secret|password)/i.test(key) ? `${path.replace(/[^.]+$/, '')}${MASK}` : path
      if (!(key in oldObject)) changes.push(`+ ${displayPath}`)
      else if (!(key in newObject)) changes.push(`- ${displayPath}`)
      else changes.push(...changedJsonPaths(oldObject[key], newObject[key], path))
    }
    return changes
  }
  if (oldKind === 'array') {
    const oldArray = /** @type {unknown[]} */ (oldValue)
    const newArray = /** @type {unknown[]} */ (newValue)
    if (oldArray.length !== newArray.length) changes.push(`~ ${prefix}.length (${oldArray.length} → ${newArray.length})`)
    const limit = Math.min(oldArray.length, newArray.length)
    for (let index = 0; index < limit; index += 1) {
      changes.push(...changedJsonPaths(oldArray[index], newArray[index], `${prefix}[${index}]`))
    }
    return changes
  }
  if (oldValue !== newValue) {
    const display = /(api[_-]?key|token|secret|password)/i.test(prefix) ? MASK : `${truncate(String(oldValue))} → ${truncate(String(newValue))}`
    changes.push(`~ ${prefix || '(root)'}: ${display}`)
  }
  return changes
}

/**
 * Shorten a long scalar for display.
 * @param {string} value
 */
function truncate(value) {
  return value.length <= 60 ? value : `${value.slice(0, 57)}...`
}
