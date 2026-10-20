/**
 * Restore: turn a snapshot back into files on disk, safely.
 *
 * A restore is always planned first (what would be created / overwritten /
 * left unchanged / left as extra), then applied. Apply takes a safety
 * snapshot of the live configuration before the first write, verifies every
 * payload hash, writes through the atomic-replace helper, and never deletes
 * files the snapshot does not contain — a missing file in a snapshot means
 * "no opinion", not "remove".
 */

import { VaultError, invariant } from './errors.js'
import { toVaultContext } from './paths.js'
import { collectFiles, resolveScopes } from './scopes.js'
import {
  createSnapshot, loadManifest, pruneSnapshots, readSnapshotFile,
} from './snapshot.js'
import { fromLogicalPath, readFileIfExists, sha256, sizeOf, writeFileAtomic } from './util.js'

/** Restore operations that write. */
const WRITE_ACTIONS = new Set(['create', 'overwrite'])

/**
 * @typedef {object} RestoreOperation
 * @property {string} path logical path
 * @property {string} scope scope id
 * @property {'create'|'overwrite'|'unchanged'} action
 * @property {number} bytes snapshot size
 * @property {string} sha256 snapshot hash
 * @property {string} [currentSha256] live hash when the file exists
 * @property {boolean} secret file is secret-bearing
 */

/**
 * Plan a restore without touching disk (payload integrity is verified).
 * @param {string|object} context
 * @param {string} id
 * @param {{ scopes?: string[], includeSecrets?: boolean }} [options]
 * @returns {Promise<object>}
 */
export async function planRestore(context, id, options = {}) {
  const { home, roots } = toVaultContext(context)
  const manifest = await loadManifest(context, id)
  const scopes = options.scopes !== undefined && options.scopes.length > 0
    ? options.scopes.filter(scope => manifest.scopes.includes(scope))
    : [...manifest.scopes]
  if (scopes.length === 0) throw new VaultError('scope-not-in-snapshot', 'none of the requested scopes are in this snapshot', { available: manifest.scopes })

  /** @type {RestoreOperation[]} */
  const operations = []
  /** @type {string[]} */
  const warnings = []
  const snapshotPaths = new Set()

  for (const scopeId of scopes) {
    const scope = resolveScopes([scopeId]).scopes[0]
    if (scope?.restoreWarning !== undefined) warnings.push(scope.restoreWarning)
  }

  for (const file of manifest.files) {
    if (!scopes.includes(file.scope)) continue
    snapshotPaths.add(file.path)
    const physical = fromLogicalPath(roots, file.path)
    const current = await readFileIfExists(physical)
    if (file.secret && options.includeSecrets === false) {
      warnings.push(`跳过密钥文件：${file.path}`)
      continue
    }
    // Verify the payload before promising the restore.
    await readSnapshotFile(context, manifest, file.path)
    if (current === undefined) {
      operations.push({
        path: file.path, scope: file.scope, action: 'create', bytes: file.size, sha256: file.sha256,
        secret: file.secret,
      })
    } else {
      const currentSha = sha256(current)
      operations.push({
        path: file.path,
        scope: file.scope,
        action: currentSha === file.sha256 ? 'unchanged' : 'overwrite',
        bytes: file.size,
        sha256: file.sha256,
        currentSha256: currentSha,
        secret: file.secret,
      })
    }
  }

  // Files the live configuration has inside the same scopes but the snapshot
  // does not: reported, never deleted.
  const currentFiles = await collectFiles(roots, resolveScopes(scopes).scopes)
  /** @type {Array<{ path: string, scope: string }>} */
  const extra = currentFiles
    .filter(file => !snapshotPaths.has(file.logicalPath))
    .map(file => ({ path: file.logicalPath, scope: file.scope }))

  const counts = {
    create: operations.filter(operation => operation.action === 'create').length,
    overwrite: operations.filter(operation => operation.action === 'overwrite').length,
    unchanged: operations.filter(operation => operation.action === 'unchanged').length,
    extra: extra.length,
  }
  const restartRequired = scopes.some(scope => resolveScopes([scope]).scopes[0]?.restoreEffect !== 'live')
  if (counts.create + counts.overwrite > 0) {
    warnings.push('运行中的 DSH 会监听配置文件并自动重载：一次恢复多个文件可能触发多次重载，建议关闭 DSH 后恢复，或恢复后手动重启')
  }
  return {
    snapshot: { id: manifest.id, name: manifest.name, createdAt: manifest.createdAt, kind: manifest.kind },
    scopes,
    operations,
    extra,
    counts,
    warnings,
    restartRequired,
  }
}

/**
 * Apply a restore. Takes a pre-restore safety snapshot unless disabled, then
 * writes every planned file atomically and verifies the result hash.
 * @param {string|object} context
 * @param {string} id
 * @param {object} [options]
 * @param {string[]} [options.scopes]
 * @param {boolean} [options.includeSecrets]
 * @param {boolean} [options.safetySnapshot] default true
 * @param {string} [options.safetyName]
 * @param {boolean} [options.prune] default true
 * @returns {Promise<object>}
 */
export async function applyRestore(context, id, options = {}) {
  const { roots } = toVaultContext(context)
  const plan = await planRestore(context, id, { scopes: options.scopes, includeSecrets: options.includeSecrets })
  const manifest = await loadManifest(context, id)
  const writes = plan.operations.filter(operation => WRITE_ACTIONS.has(operation.action))
  /** @type {string[]} */
  const warnings = [...plan.warnings]
  if (writes.length === 0) {
    return { restored: [], unchanged: plan.counts.unchanged, extra: plan.extra, warnings }
  }

  /** @type {string|undefined} */
  let safetySnapshotId
  if (options.safetySnapshot !== false) {
    // The safety snapshot must be able to roll back exactly what this restore
    // touches, including secret-bearing files when the snapshot has them.
    const touchesSecrets = plan.operations.some(operation => operation.secret)
    const safety = await createSnapshot(context, {
      name: typeof options.safetyName === 'string' && options.safetyName !== ''
        ? options.safetyName
        : `恢复前自动备份（${manifest.name}）`,
      note: `before restore of ${manifest.id}`,
      scopes: plan.scopes,
      includeSecrets: options.includeSecrets === true || touchesSecrets,
      kind: 'auto',
      reason: `pre-restore:${manifest.id}`,
    })
    safetySnapshotId = safety.id
  }

  /** @type {Array<{ path: string, scope: string, action: 'create'|'overwrite' }>} */
  const restored = []
  try {
    for (const operation of writes) {
      const data = await readSnapshotFile(context, manifest, operation.path)
      const target = fromLogicalPath(roots, operation.path)
      await writeFileAtomic(target, data)
      const written = await readFileIfExists(target)
      invariant(written !== undefined && sha256(written) === operation.sha256, 'restore-write-failed', `restored file does not match its snapshot hash: ${operation.path}`)
      restored.push({ path: operation.path, scope: operation.scope, action: /** @type {'create'|'overwrite'} */ (operation.action) })
    }
  } catch (error) {
    warnings.push(`恢复中断：${error instanceof Error ? error.message : String(error)}`)
    warnings.push('已写入的文件保持现状；恢复前的自动备份可用于回滚')
    throw Object.assign(
      error instanceof Error ? error : new VaultError('internal', String(error)),
      { restored, safetySnapshotId, warnings },
    )
  }

  if (options.prune !== false) {
    await pruneSnapshots(context, { protectId: safetySnapshotId }).catch(() => {})
  }
  return {
    restored,
    unchanged: plan.counts.unchanged,
    extra: plan.extra,
    safetySnapshotId,
    warnings,
    restartRequired: plan.restartRequired,
  }
}

/**
 * Whether a live file exists for a logical path (diagnostics).
 * @param {string|object} context
 * @param {string} logicalPath
 */
export async function liveFileExists(context, logicalPath) {
  const { roots } = toVaultContext(context)
  return (await sizeOf(fromLogicalPath(roots, logicalPath))) !== undefined
}
