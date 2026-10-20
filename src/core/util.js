/**
 * Small filesystem primitives shared by the vault core: hashing, bounded
 * reads, atomic writes and safe path joins. No dependency and no ambient
 * state, so every module here is directly unit-testable against a temp home.
 */

import { createHash, randomBytes } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, normalize, relative, sep } from 'node:path'

/** Windows rename can lose a race with an indexer or antivirus; retry briefly. */
const TRANSIENT_RENAME_CODES = new Set(['EACCES', 'EBUSY', 'EPERM'])

/**
 * SHA-256 hex digest of a buffer or string.
 * @param {Buffer|string} data
 * @returns {string}
 */
export function sha256(data) {
  return createHash('sha256').update(data).digest('hex')
}

/**
 * Ensure a directory (and its parents) exists.
 * @param {string} dir
 */
export async function ensureDir(dir) {
  await mkdir(dir, { recursive: true })
}

/**
 * Read a file as a Buffer, returning undefined for a missing path.
 * @param {string} file
 * @returns {Promise<Buffer|undefined>}
 */
export async function readFileIfExists(file) {
  try {
    return await readFile(file)
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return undefined
    throw error
  }
}

/**
 * Read a file as UTF-8 text, returning undefined for a missing path.
 * @param {string} file
 * @returns {Promise<string|undefined>}
 */
export async function readTextIfExists(file) {
  const buffer = await readFileIfExists(file)
  return buffer === undefined ? undefined : buffer.toString('utf8')
}

/**
 * Atomically replace `file` with `data`: write a random-suffix sibling then
 * rename it over the target, so a reader sees either the old or the new
 * complete content. Retries the transient Windows rename failures.
 * @param {string} file
 * @param {Buffer|string} data
 * @param {{ mode?: number }} [options]
 */
export async function writeFileAtomic(file, data, options = {}) {
  await ensureDir(dirname(file))
  const temp = join(dirname(file), `.${randomBytes(6).toString('hex')}.tmp`)
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8')
  try {
    await writeFile(temp, buffer, options.mode === undefined ? undefined : { mode: options.mode })
    for (let attempt = 0; ; attempt += 1) {
      try {
        await rename(temp, file)
        return
      } catch (error) {
        const code = error && error.code
        if (process.platform !== 'win32' || !TRANSIENT_RENAME_CODES.has(code) || attempt >= 8) throw error
        await new Promise(resolve => setTimeout(resolve, 20 * 2 ** attempt))
      }
    }
  } finally {
    await rm(temp, { force: true }).catch(() => {})
  }
}

/**
 * Remove a directory tree, ignoring a missing target.
 * @param {string} dir
 */
export async function removeTree(dir) {
  await rm(dir, { recursive: true, force: true })
}

/**
 * Recursively list regular files under `dir`, sorted for deterministic
 * output. Symlinks are skipped (a snapshot must never copy link targets).
 * @param {string} dir
 * @param {{ maxFiles?: number, maxDepth?: number, skip?: (name: string) => boolean }} [options]
 * @returns {Promise<string[]>} absolute paths
 */
export async function listFilesRecursive(dir, options = {}) {
  const { maxFiles = 5000, maxDepth = 12, skip } = options
  /** @type {string[]} */
  const found = []
  /**
   * @param {string} current
   * @param {number} depth
   */
  async function walk(current, depth) {
    if (found.length >= maxFiles || depth > maxDepth) return
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch (error) {
      if (error && error.code === 'ENOENT') return
      throw error
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
      if (found.length >= maxFiles) return
      if (skip !== undefined && skip(entry.name)) continue
      const absolute = join(current, entry.name)
      if (entry.isDirectory()) {
        await walk(absolute, depth + 1)
      } else if (entry.isFile()) {
        found.push(absolute)
      }
    }
  }
  await walk(dir, 0)
  return found
}

/**
 * Convert an absolute path into a logical POSIX path under one of the known
 * roots (`home`, `agents`). Returns undefined when the path is outside every
 * root.
 * @param {Record<string, string>} roots
 * @param {string} absolute
 * @returns {string|undefined}
 */
export function toLogicalPath(roots, absolute) {
  for (const [key, root] of Object.entries(roots)) {
    const rel = relative(root, absolute)
    if (rel === '') continue
    if (isAbsolute(rel) || rel.split(/[\\/]/).some(segment => segment === '..')) continue
    return `${key}/${rel.split(sep).join('/')}`
  }
  return undefined
}

/**
 * Join a relative POSIX path onto a physical directory, refusing traversal
 * and absolute forms. Generic safety gate for payload directories.
 * @param {string} root
 * @param {string} logicalPath
 * @returns {string}
 */
export function safeJoin(root, logicalPath) {
  if (typeof logicalPath !== 'string' || logicalPath === '') {
    throw new VaultPathError('path-escape', 'empty logical path')
  }
  if (logicalPath.startsWith('/') || /^[a-zA-Z]:/.test(logicalPath) || logicalPath.startsWith('\\')) {
    throw new VaultPathError('path-escape', `absolute logical path refused: ${logicalPath}`)
  }
  const segments = logicalPath.split('/')
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..' || /[\\:]/.test(segment))) {
    throw new VaultPathError('path-escape', `unsafe logical path refused: ${logicalPath}`)
  }
  const target = normalize(join(root, ...segments))
  const normalizedRoot = normalize(root)
  if (target !== normalizedRoot && !target.startsWith(normalizedRoot + sep)) {
    throw new VaultPathError('path-escape', `path escapes its root: ${logicalPath}`)
  }
  return target
}

/**
 * Resolve a logical path (`home/...` or `agents/...`) to its physical path.
 * This is the single write-safety gate for restore: it may only ever touch
 * configured roots and never escape them.
 * @param {Record<string, string>} roots
 * @param {string} logicalPath
 * @returns {string}
 */
export function fromLogicalPath(roots, logicalPath) {
  if (typeof logicalPath !== 'string' || logicalPath === '') {
    throw new VaultPathError('path-escape', 'empty logical path')
  }
  const [key, ...rest] = logicalPath.split('/')
  const root = roots[key]
  if (root === undefined) {
    throw new VaultPathError('path-escape', `unknown root "${key}" in logical path: ${logicalPath}`)
  }
  if (rest.length === 0) throw new VaultPathError('path-escape', `logical path has no file: ${logicalPath}`)
  return safeJoin(root, rest.join('/'))
}

/**
 * Split a logical path into its root key and the root-relative tail.
 * @param {Record<string, string>} roots
 * @param {string} logicalPath
 * @returns {{ key: string, root: string, relativePath: string }}
 */
export function splitLogicalPath(roots, logicalPath) {
  const [key, ...rest] = logicalPath.split('/')
  const root = roots[key]
  if (root === undefined || rest.length === 0) {
    throw new VaultPathError('path-escape', `unknown or incomplete logical path: ${logicalPath}`)
  }
  return { key, root, relativePath: rest.join('/') }
}

/** Error raised by the path-safety gate. */
export class VaultPathError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message)
    this.name = 'VaultPathError'
    this.code = code
  }
}

/**
 * Whether a path exists (any type).
 * @param {string} file
 * @returns {Promise<boolean>}
 */
export async function exists(file) {
  try {
    await lstat(file)
    return true
  } catch {
    return false
  }
}

/**
 * Byte size of a file, or undefined when missing.
 * @param {string} file
 * @returns {Promise<number|undefined>}
 */
export async function sizeOf(file) {
  try {
    return (await stat(file)).size
  } catch {
    return undefined
  }
}

/**
 * A compact, sortable snapshot id: UTC stamp plus random suffix, so two
 * snapshots in the same second never collide and lexical order is time order.
 * @param {Date} [at]
 * @returns {string}
 */
export function newSnapshotId(at = new Date()) {
  const stamp = at.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
  return `${stamp}-${randomBytes(3).toString('hex')}`
}

/**
 * Current time as an ISO string.
 * @returns {string}
 */
export function nowIso() {
  return new Date().toISOString()
}
