/**
 * Snapshot store: create, list, read and prune snapshots on disk.
 *
 * Layout (all under `$DSH_HOME/config-vault/`):
 *
 *   snapshots/<id>/manifest.json   metadata + per-file hashes, written last
 *   snapshots/<id>/payload/<logical path>   e.g. payload/home/profiles/...
 *
 * Logical paths start with `home/` ($DSH_HOME) or `agents/` ($DSH_AGENTS_HOME)
 * so a snapshot is machine-portable; absolute home paths are never recorded.
 * A snapshot is assembled in a `.tmp-` sibling and renamed into place, so a
 * crash leaves no half-valid snapshot in the listing.
 */

import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { VaultError, invariant } from './errors.js'
import {
  listProfiles, snapshotDir, snapshotsDir, toVaultContext, VAULT_INTERNAL,
} from './paths.js'
import { containsSecret } from './secrets.js'
import { collectFiles, resolveScopes } from './scopes.js'
import {
  ensureDir, fromLogicalPath, newSnapshotId, nowIso, readFileIfExists, removeTree, safeJoin,
  sha256, sizeOf, writeFileAtomic,
} from './util.js'

/** Manifest schema version written by this build. */
export const MANIFEST_SCHEMA = 1
/** Maximum size of one snapshotted file (4 MiB): configuration, not data. */
export const MAX_FILE_BYTES = 4 * 1024 * 1024
/** Maximum total payload per snapshot (32 MiB). */
export const MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024
/** Default number of snapshots kept per kind when pruning. */
export const DEFAULT_KEEP_MANUAL = 30
export const DEFAULT_KEEP_AUTO = 10

/**
 * @typedef {object} SnapshotFileEntry
 * @property {string} path logical path (`home/...` or `agents/...`)
 * @property {string} scope owning scope id
 * @property {number} size bytes
 * @property {string} sha256 content hash
 * @property {boolean} secret whether the content looks secret-bearing
 */

/**
 * @typedef {object} SnapshotManifest
 * @property {number} schemaVersion
 * @property {string} id
 * @property {string} name
 * @property {string} note
 * @property {'manual'|'auto'} kind
 * @property {string} [reason] why an automatic snapshot was taken
 * @property {string} createdAt ISO timestamp
 * @property {string[]} scopes scope ids included
 * @property {string[]} profiles profile names present at creation
 * @property {string} platform
 * @property {boolean} hasCredentials snapshot contains credential-scope files
 * @property {SnapshotFileEntry[]} files
 * @property {{ files: number, bytes: number }} totals
 * @property {string[]} warnings
 */

/**
 * Read a manifest and validate its shape.
 * @param {string|object} context vault context or home path
 * @param {string} id
 * @returns {Promise<SnapshotManifest>}
 */
export async function loadManifest(context, id) {
  const { home } = toVaultContext(context)
  assertSafeId(id)
  const file = join(snapshotDir(home, id), 'manifest.json')
  const raw = await readFileIfExists(file)
  if (raw === undefined) throw new VaultError('snapshot-not-found', `no snapshot named ${id}`)
  let parsed
  try {
    parsed = JSON.parse(raw.toString('utf8'))
  } catch {
    throw new VaultError('snapshot-corrupt', `snapshot ${id} has an unreadable manifest`)
  }
  validateManifest(parsed, id)
  return parsed
}

/**
 * Validate the minimum contract of a manifest.
 * @param {unknown} value
 * @param {string} id
 */
export function validateManifest(value, id = '') {
  invariant(value !== null && typeof value === 'object', 'snapshot-corrupt', `snapshot ${id} manifest is not an object`)
  const manifest = /** @type {Record<string, unknown>} */ (value)
  invariant(manifest.schemaVersion === MANIFEST_SCHEMA, 'snapshot-unsupported', `snapshot ${id} has unsupported schema version ${String(manifest.schemaVersion)}`)
  invariant(typeof manifest.id === 'string' && manifest.id !== '', 'snapshot-corrupt', `snapshot ${id} manifest has no id`)
  invariant(Array.isArray(manifest.files), 'snapshot-corrupt', `snapshot ${id} manifest has no file index`)
  for (const entry of manifest.files) {
    invariant(entry !== null && typeof entry === 'object' && typeof entry.path === 'string' && typeof entry.sha256 === 'string', 'snapshot-corrupt', `snapshot ${id} manifest has a malformed file entry`)
  }
}

/**
 * Reject ids that could traverse out of the snapshot directory.
 * @param {string} id
 */
function assertSafeId(id) {
  if (typeof id !== 'string' || id === '' || !/^[A-Za-z0-9._-]+$/.test(id) || id.startsWith('.')) {
    throw new VaultError('invalid-snapshot-id', `invalid snapshot id: ${String(id)}`)
  }
}

/**
 * Create a snapshot of the current configuration.
 * @param {string|object} context vault context or home path
 * @param {object} [options]
 * @param {string} [options.name]
 * @param {string} [options.note]
 * @param {string[]} [options.scopes]
 * @param {boolean} [options.includeSecrets]
 * @param {'manual'|'auto'} [options.kind]
 * @param {string} [options.reason]
 * @param {number} [options.maxFileBytes]
 * @param {number} [options.maxBytes]
 * @param {Date} [options.now]
 * @returns {Promise<SnapshotManifest>}
 */
export async function createSnapshot(context, options = {}) {
  const { home, roots } = toVaultContext(context)
  const {
    name,
    note = '',
    includeSecrets = false,
    kind = 'manual',
    reason,
    maxFileBytes = MAX_FILE_BYTES,
    maxBytes = MAX_SNAPSHOT_BYTES,
    now = new Date(),
  } = options
  const { scopes, unknown } = resolveScopes(options.scopes)
  invariant(scopes.length > 0, 'no-scopes', `no known scope selected${unknown.length > 0 ? ` (unknown: ${unknown.join(', ')})` : ''}`)

  const candidates = await collectFiles(roots, scopes)
  const id = newSnapshotId(now)
  const temporary = join(snapshotsDir(home), `.tmp-${id}`)
  const final = snapshotDir(home, id)
  await ensureDir(join(temporary, 'payload'))

  /** @type {SnapshotFileEntry[]} */
  const files = []
  /** @type {string[]} */
  const warnings = []
  let totalBytes = 0
  let hasCredentials = false

  // Credentials are a scope the caller has to opt into; say so instead of
  // silently producing a backup that cannot log in after a reinstall.
  if (!scopes.some(scope => scope.id === 'credentials')) {
    for (const credentialFile of ['home/.credentials.yaml', 'home/.credentials.yml']) {
      const [, ...rest] = credentialFile.split('/')
      if (await sizeOf(join(roots.home, ...rest)) !== undefined) {
        warnings.push('凭据文件 .credentials.yaml 未包含（默认关闭 credentials 作用域）；如需备份登录凭据请显式选择该作用域')
        break
      }
    }
  }

  try {
    for (const candidate of candidates) {
      if (candidate.secret && !includeSecrets) {
        warnings.push(`已跳过密钥文件（默认排除）：${candidate.logicalPath}`)
        continue
      }
      const physical = fromLogicalPath(roots, candidate.logicalPath)
      const size = await sizeOf(physical)
      if (size === undefined) continue
      if (size > maxFileBytes) {
        warnings.push(`文件过大已跳过（>${Math.round(maxFileBytes / 1024)} KiB）：${candidate.logicalPath}`)
        continue
      }
      if (totalBytes + size > maxBytes) {
        warnings.push(`快照总量超限，剩余文件已跳过（>${Math.round(maxBytes / 1024 / 1024)} MiB）`)
        break
      }
      const data = await readFileIfExists(physical)
      if (data === undefined) continue
      const destination = join(temporary, 'payload', ...candidate.logicalPath.split('/'))
      await writeFileAtomic(destination, data)
      const text = looksTextual(candidate.logicalPath) ? data.toString('utf8') : ''
      const secret = candidate.secret || (text !== '' && containsSecret(text))
      if (candidate.scope === 'credentials') hasCredentials = true
      files.push({
        path: candidate.logicalPath,
        scope: candidate.scope,
        size: data.length,
        sha256: sha256(data),
        secret,
      })
      totalBytes += data.length
    }

    if (unknown.length > 0) warnings.push(`未知作用域已忽略：${unknown.join(', ')}`)
    if (files.length === 0) warnings.push('没有找到可备份的配置文件：请检查作用域选择是否正确，或 DSH_HOME 是否指向真实的配置目录')

    /** @type {SnapshotManifest} */
    const manifest = {
      schemaVersion: MANIFEST_SCHEMA,
      id,
      name: typeof name === 'string' && name.trim() !== '' ? name.trim() : defaultName(now),
      note: typeof note === 'string' ? note : '',
      kind: kind === 'auto' ? 'auto' : 'manual',
      ...(reason === undefined ? {} : { reason }),
      createdAt: now.toISOString(),
      scopes: scopes.map(scope => scope.id),
      profiles: await listProfiles(roots.home),
      platform: process.platform,
      hasCredentials,
      files,
      totals: { files: files.length, bytes: totalBytes },
      warnings,
    }
    await writeFileAtomic(join(temporary, 'manifest.json'), JSON.stringify(manifest, null, 2))
    await renameDirectory(temporary, final)
    return manifest
  } catch (error) {
    await removeTree(temporary)
    throw error
  }
}

/**
 * Rename a prepared snapshot directory into place, tolerating the transient
 * Windows failures that otherwise leave a `.tmp-` directory behind.
 * @param {string} from
 * @param {string} to
 */
async function renameDirectory(from, to) {
  const { rename } = await import('node:fs/promises')
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(from, to)
      return
    } catch (error) {
      const code = error && error.code
      if ((code === 'EEXIST' || code === 'ENOTEMPTY' || code === 'EPERM') && attempt < 2) {
        await removeTree(to)
        continue
      }
      if (!['EACCES', 'EBUSY', 'EPERM'].includes(String(code)) || attempt >= 8) throw error
      await new Promise(resolve => setTimeout(resolve, 20 * 2 ** attempt))
    }
  }
}

/**
 * Default display name for an unlabelled snapshot.
 * @param {Date} at
 */
function defaultName(at) {
  const pad = (value) => String(value).padStart(2, '0')
  return `快照 ${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`
}

/**
 * Whether a logical path is expected to hold UTF-8 text (for secret scanning).
 * @param {string} logicalPath
 */
function looksTextual(logicalPath) {
  return /\.(ya?ml|json|toml|ini|md|txt|js|mjs|cjs|ts|tsx|jsx|css|html|xml|sh|ps1|bat|cmd|env)$/i.test(logicalPath)
    || !logicalPath.includes('.')
}

/**
 * List every valid snapshot, newest first. Invalid directories are skipped
 * with a warning entry rather than failing the whole listing.
 * @param {string|object} context
 * @param {{ kind?: 'manual'|'auto', limit?: number }} [options]
 * @returns {Promise<{ snapshots: SnapshotManifest[], invalid: Array<{ id: string, error: string }> }>}
 */
export async function listSnapshots(context, options = {}) {
  const { home } = toVaultContext(context)
  const dir = snapshotsDir(home)
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return { snapshots: [], invalid: [] }
  }
  /** @type {SnapshotManifest[]} */
  const snapshots = []
  /** @type {Array<{ id: string, error: string }>} */
  const invalid = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    try {
      const manifest = await loadManifest(context, entry.name)
      if (options.kind !== undefined && manifest.kind !== options.kind) continue
      snapshots.push(manifest)
    } catch (error) {
      invalid.push({ id: entry.name, error: error instanceof Error ? error.message : String(error) })
    }
  }
  snapshots.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
  return {
    snapshots: options.limit === undefined ? snapshots : snapshots.slice(0, options.limit),
    invalid,
  }
}

/**
 * Read one file from a snapshot payload and verify it against the manifest
 * hash, so a tampered or truncated snapshot cannot be restored.
 * @param {string|object} context
 * @param {SnapshotManifest} manifest
 * @param {string} logicalPath
 * @returns {Promise<Buffer>}
 */
export async function readSnapshotFile(context, manifest, logicalPath) {
  const { home } = toVaultContext(context)
  const entry = manifest.files.find(file => file.path === logicalPath)
  if (entry === undefined) throw new VaultError('file-not-in-snapshot', `${logicalPath} is not in snapshot ${manifest.id}`)
  const file = safeJoin(join(snapshotDir(home, manifest.id), 'payload'), logicalPath)
  const data = await readFileIfExists(file)
  if (data === undefined) throw new VaultError('snapshot-payload-missing', `snapshot ${manifest.id} is missing ${logicalPath}`)
  if (sha256(data) !== entry.sha256) throw new VaultError('snapshot-integrity', `snapshot ${manifest.id} payload for ${logicalPath} fails its integrity check (hash mismatch)`)
  return data
}

/**
 * Load every payload file of a snapshot into memory. Only used by export
 * (bounded by the snapshot limits).
 * @param {string|object} context
 * @param {SnapshotManifest} manifest
 * @returns {Promise<Map<string, Buffer>>}
 */
export async function readSnapshotPayload(context, manifest) {
  /** @type {Map<string, Buffer>} */
  const payload = new Map()
  for (const file of manifest.files) {
    payload.set(file.path, await readSnapshotFile(context, manifest, file.path))
  }
  return payload
}

/**
 * Delete one snapshot directory.
 * @param {string|object} context
 * @param {string} id
 */
export async function deleteSnapshot(context, id) {
  const { home } = toVaultContext(context)
  assertSafeId(id)
  const dir = snapshotDir(home, id)
  if (!(await readFileIfExists(join(dir, 'manifest.json')))) {
    throw new VaultError('snapshot-not-found', `no snapshot named ${id}`)
  }
  await removeTree(dir)
}

/**
 * Keep the newest N snapshots per kind, deleting older ones. Auto snapshots
 * taken before a restore are the ones worth capping.
 * @param {string|object} context
 * @param {{ keepManual?: number, keepAuto?: number, protectId?: string }} [options]
 * @returns {Promise<{ deleted: string[] }>}
 */
export async function pruneSnapshots(context, options = {}) {
  const { keepManual = DEFAULT_KEEP_MANUAL, keepAuto = DEFAULT_KEEP_AUTO, protectId } = options
  // Guard the retention counts: a NaN from an unparsed CLI flag would make
  // `slice(Math.max(0, NaN))` equal `slice(0)` and silently delete everything.
  const keepByKind = { manual: keepManual, auto: keepAuto }
  for (const [kind, keep] of Object.entries(keepByKind)) {
    if (typeof keep !== 'number' || !Number.isInteger(keep) || keep < 0) {
      throw new VaultError('invalid-argument', `保留数量（${kind === 'manual' ? 'keepManual' : 'keepAuto'}）必须是非负整数`)
    }
  }
  const { snapshots } = await listSnapshots(context)
  const deleted = []
  for (const kind of /** @type {const} */ (['manual', 'auto'])) {
    const group = snapshots.filter(snapshot => snapshot.kind === kind)
    for (const snapshot of group.slice(keepByKind[kind])) {
      if (snapshot.id === protectId) continue
      await deleteSnapshot(context, snapshot.id)
      deleted.push(snapshot.id)
    }
  }
  return { deleted }
}

/**
 * Human summary used by the tool, routes and CLI.
 * @param {SnapshotManifest} manifest
 */
export function summarizeManifest(manifest) {
  return {
    id: manifest.id,
    name: manifest.name,
    note: manifest.note,
    kind: manifest.kind,
    reason: manifest.reason,
    createdAt: manifest.createdAt,
    scopes: manifest.scopes,
    profiles: manifest.profiles,
    files: manifest.totals.files,
    bytes: manifest.totals.bytes,
    secrets: manifest.files.filter(file => file.secret).length,
    hasCredentials: manifest.hasCredentials === true,
    warnings: manifest.warnings,
  }
}

/**
 * Report the vault's on-disk footprint per snapshot (diagnostics).
 * @param {string|object} context
 */
export async function vaultStats(context) {
  const { home } = toVaultContext(context)
  const { snapshots, invalid } = await listSnapshots(context)
  return {
    root: join(home, 'config-vault'),
    snapshots: snapshots.length,
    invalid,
    bytes: snapshots.reduce((total, snapshot) => total + snapshot.totals.bytes, 0),
    newest: snapshots[0]?.id,
    oldest: snapshots[snapshots.length - 1]?.id,
  }
}

/**
 * Guard against snapshoting the vault itself (recursion).
 * @param {string} logicalPath
 */
export function isVaultInternal(logicalPath) {
  const first = logicalPath.split('/')[1] ?? ''
  return VAULT_INTERNAL.has(first)
}

export { nowIso }
