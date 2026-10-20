/**
 * Portable bundles: one JSON file that carries one or more snapshots (and
 * their payloads) between machines, optionally encrypted with a passphrase.
 *
 * Bundle layout:
 *
 *   {
 *     format: 'dsh-config-vault-bundle',
 *     version: 1,
 *     createdAt,
 *     encrypted: false,
 *     snapshots: [{ manifest, files: { "<logical path>": "<base64>" } }]
 *   }
 *
 * Encrypted bundles replace `snapshots` with `crypto` (see crypto.js) whose
 * plaintext is the same `{ snapshots }` object.
 */

import { readFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { decryptJson, encryptJson } from './crypto.js'
import { VaultError, invariant } from './errors.js'
import { snapshotsDir, toVaultContext } from './paths.js'
import { loadManifest, readSnapshotPayload } from './snapshot.js'
import {
  ensureDir, exists, nowIso, readFileIfExists, removeTree, safeJoin, sha256, writeFileAtomic,
} from './util.js'

/** Bundle format marker. */
export const BUNDLE_FORMAT = 'dsh-config-vault-bundle'
/** Bundle format version. */
export const BUNDLE_VERSION = 1
/** Upper bound for an imported bundle (128 MiB of JSON). */
export const MAX_BUNDLE_BYTES = 128 * 1024 * 1024

/**
 * Export snapshots into one bundle object.
 * @param {string|object} context
 * @param {string[]} ids
 * @param {{ passphrase?: string }} [options]
 * @returns {Promise<object>} the bundle (JSON-serializable)
 */
export async function buildBundle(context, ids, options = {}) {
  invariant(Array.isArray(ids) && ids.length > 0, 'no-snapshots', '至少选择一个快照')
  /** @type {Array<{ manifest: object, files: Record<string, string> }>} */
  const snapshots = []
  let holdsCredentials = false
  for (const id of ids) {
    const manifest = await loadManifest(context, id)
    if (manifest.hasCredentials === true) holdsCredentials = true
    const payload = await readSnapshotPayload(context, manifest)
    /** @type {Record<string, string>} */
    const files = {}
    for (const [path, data] of payload) files[path] = data.toString('base64')
    snapshots.push({ manifest, files })
  }
  if (holdsCredentials && (typeof options.passphrase !== 'string' || options.passphrase === '')) {
    throw new VaultError('passphrase-required', '该快照包含登录凭据，导出时必须设置口令加密')
  }
  const body = { snapshots }
  if (typeof options.passphrase === 'string' && options.passphrase !== '') {
    return {
      format: BUNDLE_FORMAT,
      version: BUNDLE_VERSION,
      createdAt: nowIso(),
      encrypted: true,
      crypto: encryptJson(body, options.passphrase),
    }
  }
  return {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    createdAt: nowIso(),
    encrypted: false,
    ...body,
  }
}

/**
 * Parse and structurally validate a bundle file.
 * @param {string} file
 * @param {{ passphrase?: string }} [options]
 * @returns {Promise<{ format: string, version: number, createdAt: string, snapshots: Array<{ manifest: object, files: Record<string, string> }> }>}
 */
export async function readBundleFile(file, options = {}) {
  const raw = await readFileIfExists(file)
  if (raw === undefined) throw new VaultError('bundle-not-found', `找不到文件：${file}`)
  if (raw.length > MAX_BUNDLE_BYTES) throw new VaultError('bundle-too-large', '文件超过 128 MiB，拒绝导入')
  let bundle
  try {
    bundle = JSON.parse(raw.toString('utf8'))
  } catch {
    throw new VaultError('bundle-invalid', '文件不是合法 JSON')
  }
  return decodeBundle(bundle, options)
}

/**
 * Decode an already-parsed bundle (used by routes that receive JSON over HTTP).
 * @param {unknown} bundle
 * @param {{ passphrase?: string }} [options]
 */
export function decodeBundle(bundle, options = {}) {
  invariant(bundle !== null && typeof bundle === 'object', 'bundle-invalid', '不是有效的保险箱导出文件')
  /** @type {Record<string, any>} */
  const record = /** @type {any} */ (bundle)
  if (record.format !== BUNDLE_FORMAT) throw new VaultError('bundle-invalid', '不是 DSH 配置保险箱导出文件')
  if (record.version !== BUNDLE_VERSION) throw new VaultError('bundle-unsupported', `不支持的导出版本 ${String(record.version)}`)
  let snapshots = record.snapshots
  if (record.encrypted === true) {
    const passphrase = options.passphrase
    if (typeof passphrase !== 'string' || passphrase === '') throw new VaultError('passphrase-required', '该文件已加密，请输入口令')
    const decrypted = decryptJson(record.crypto, passphrase)
    if (decrypted === null || typeof decrypted !== 'object' || !Array.isArray(/** @type {any} */ (decrypted).snapshots)) {
      throw new VaultError('bundle-corrupt', '解密内容缺少 snapshots')
    }
    snapshots = /** @type {any} */ (decrypted).snapshots
  }
  invariant(Array.isArray(snapshots) && snapshots.length > 0, 'bundle-invalid', '文件里没有快照')
  for (const snapshot of snapshots) {
    invariant(snapshot !== null && typeof snapshot === 'object', 'bundle-invalid', '快照结构损坏')
    invariant(snapshot.manifest !== null && typeof snapshot.manifest === 'object', 'bundle-invalid', '快照缺少 manifest')
    invariant(snapshot.files !== null && typeof snapshot.files === 'object' && !Array.isArray(snapshot.files), 'bundle-invalid', '快照缺少 payload')
  }
  return {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    createdAt: typeof record.createdAt === 'string' ? record.createdAt : nowIso(),
    snapshots,
  }
}

/**
 * Import a decoded bundle as new snapshots. Every file is hash-verified
 * against its manifest before anything is written; each snapshot directory is
 * assembled under a temp name and renamed into place.
 * @param {string|object} context
 * @param {{ snapshots: Array<{ manifest: object, files: Record<string, string> }> }} bundle
 * @param {{ namePrefix?: string }} [options]
 * @returns {Promise<Array<object>>} imported manifests
 */
export async function importBundle(context, bundle, options = {}) {
  const { home } = toVaultContext(context)
  /** @type {object[]} */
  const imported = []
  for (const snapshot of bundle.snapshots) {
    /** @type {Record<string, any>} */
    const manifest = /** @type {any} */ (snapshot.manifest)
    /** @type {Record<string, string>} */
    const files = snapshot.files
    const id = await uniqueSnapshotId(home, typeof manifest.id === 'string' && manifest.id !== '' ? manifest.id : `imported-${Date.now()}`)
    const target = join(snapshotsDir(home), id)
    const temporary = join(snapshotsDir(home), `.tmp-import-${id}`)
    await ensureDir(join(temporary, 'payload'))
    try {
      /** @type {Array<{ path: string, scope: string, size: number, sha256: string, secret: boolean }>} */
      const entries = []
      for (const [path, base64] of Object.entries(files)) {
        const data = Buffer.from(base64, 'base64')
        const expected = Array.isArray(manifest.files) ? manifest.files.find(/** @param {any} entry */ entry => entry.path === path) : undefined
        if (expected === undefined) throw new VaultError('bundle-invalid', `导出的快照缺少文件索引：${path}`)
        if (sha256(data) !== expected.sha256) throw new VaultError('bundle-integrity', `导入文件校验失败：${path}`)
        await writeFileAtomic(safeJoin(join(temporary, 'payload'), path), data)
        entries.push({ path, scope: String(expected.scope ?? 'settings'), size: data.length, sha256: expected.sha256, secret: expected.secret === true })
      }
      const merged = {
        ...manifest,
        id,
        name: options.namePrefix !== undefined ? `${options.namePrefix}${String(manifest.name ?? id)}` : manifest.name ?? id,
        createdAt: nowIso(),
        files: entries,
        totals: { files: entries.length, bytes: entries.reduce((sum, entry) => sum + entry.size, 0) },
        kind: 'manual',
        reason: 'imported',
        hasCredentials: entries.some(entry => entry.scope === 'credentials'),
        warnings: [...(Array.isArray(manifest.warnings) ? manifest.warnings : []), '由导出文件导入'],
      }
      await writeFileAtomic(join(temporary, 'manifest.json'), JSON.stringify(merged, null, 2))
      await renameDirectory(temporary, target)
      imported.push(merged)
    } catch (error) {
      await removeTree(temporary)
      throw error
    }
  }
  return imported
}

/**
 * Resolve a snapshot id that does not collide with an existing snapshot, so
 * importing a bundle back into the home it came from keeps both copies.
 * @param {string} home
 * @param {string} base
 * @returns {Promise<string>}
 */
async function uniqueSnapshotId(home, base) {
  const safeBase = base.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[.-]+/, '').slice(0, 80) || 'imported'
  let candidate = safeBase
  for (let suffix = 2; await exists(join(snapshotsDir(home), candidate)); suffix += 1) {
    candidate = `${safeBase}-${suffix}`
  }
  return candidate
}

/**
 * Rename a prepared snapshot directory into place, clearing a stale target
 * left by an interrupted import and retrying the transient Windows failures.
 * @param {string} from
 * @param {string} to
 */
async function renameDirectory(from, to) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(from, to)
      return
    } catch (error) {
      const code = error && error.code
      if (code === 'EEXIST' || code === 'ENOTEMPTY' || code === 'EPERM') {
        if (await exists(to)) {
          if (attempt < 2) {
            await removeTree(to)
            continue
          }
        }
      }
      if (!['EACCES', 'EBUSY', 'EPERM'].includes(String(code)) || attempt >= 8) throw error
      await new Promise(resolve => setTimeout(resolve, 20 * 2 ** attempt))
    }
  }
}

/**
 * Export snapshots straight to a bundle file.
 * @param {string|object} context
 * @param {string[]} ids
 * @param {string} file
 * @param {{ passphrase?: string }} [options]
 */
export async function exportBundleToFile(context, ids, file, options = {}) {
  const bundle = await buildBundle(context, ids, options)
  await writeFileAtomic(file, JSON.stringify(bundle, null, 2))
  return bundle
}

/**
 * Read a bundle file's header without decrypting payloads (fast peek used to
 * decide whether a passphrase is needed before the full import).
 * @param {string} file
 * @param {{ passphrase?: string }} [options]
 */
export async function peekBundleFile(file, options = {}) {
  const raw = await readFile(file)
  const parsed = JSON.parse(raw.toString('utf8'))
  const decoded = decodeBundle(parsed, options)
  return {
    format: decoded.format,
    version: decoded.version,
    encrypted: parsed.encrypted === true,
    createdAt: decoded.createdAt,
    snapshotCount: decoded.snapshots.length,
    snapshots: decoded.snapshots.map(snapshot => ({
      name: snapshot.manifest.name,
      createdAt: snapshot.manifest.createdAt,
      scopes: snapshot.manifest.scopes,
      files: Array.isArray(snapshot.manifest.files) ? snapshot.manifest.files.length : 0,
    })),
  }
}

/**
 * Size guard for importing a bundle received in memory.
 * @param {unknown} bundle
 */
export function assertBundleSize(bundle) {
  const bytes = Buffer.byteLength(JSON.stringify(bundle), 'utf8')
  if (bytes > MAX_BUNDLE_BYTES) throw new VaultError('bundle-too-large', '导入内容超过 128 MiB')
}
