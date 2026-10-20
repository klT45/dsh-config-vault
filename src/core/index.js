/**
 * Public core API of the config vault. The host plugin, the CLI and the
 * tests all consume this one object, so behaviour cannot drift between the
 * model-facing tool, the HTTP routes and a terminal run.
 */

import {
  buildBundle, decodeBundle, exportBundleToFile, importBundle, peekBundleFile, readBundleFile,
} from './bundle.js'
import { diffSnapshotVsCurrent, diffSnapshots, changedJsonPaths } from './diff.js'
import { VaultError, toVaultError } from './errors.js'
import {
  detectProfileName, listProfiles, resolveAgentsHome, resolveDshHome, resolveRoots, snapshotsDir,
  toVaultContext, vaultDataDir,
} from './paths.js'
import { applyRestore, planRestore } from './restore.js'
import { collectScopeFiles, describeScopes, resolveScopes } from './scopes.js'
import {
  createSnapshot, deleteSnapshot, listSnapshots, loadManifest, pruneSnapshots,
  readSnapshotFile, summarizeManifest, vaultStats,
} from './snapshot.js'

export * from './errors.js'
export * from './paths.js'
export * from './scopes.js'
export * from './secrets.js'
export * from './util.js'
export { MASK } from './secrets.js'
export {
  createSnapshot, deleteSnapshot, listSnapshots, loadManifest, pruneSnapshots, readSnapshotFile,
  summarizeManifest, vaultStats, MAX_FILE_BYTES, MAX_SNAPSHOT_BYTES, MANIFEST_SCHEMA,
} from './snapshot.js'
export { diffSnapshotVsCurrent, diffSnapshots, changedJsonPaths } from './diff.js'
export { planRestore, applyRestore } from './restore.js'
export {
  buildBundle, decodeBundle, exportBundleToFile, importBundle, peekBundleFile, readBundleFile,
  BUNDLE_FORMAT, BUNDLE_VERSION, MAX_BUNDLE_BYTES,
} from './bundle.js'
export { encryptJson, decryptJson } from './crypto.js'
export { VaultError, toVaultError } from './errors.js'
export { collectScopeFiles } from './scopes.js'

/**
 * @typedef {object} Vault
 * @property {string} home resolved DSH home
 * @property {string|undefined} profile running profile, when detectable
 * @property {() => Array<object>} scopes scope descriptors for a picker
 * @property {(options?: object) => Promise<object>} snapshot create a snapshot
 * @property {(options?: object) => Promise<{ snapshots: object[], invalid: object[] }>} list list snapshots
 * @property {(id: string, options?: object) => Promise<object>} diff snapshot vs live config
 * @property {(baseId: string, targetId: string, options?: object) => Promise<object>} diffTwo snapshot vs snapshot
 * @property {(id: string, options?: object) => Promise<object>} planRestore dry-run a restore
 * @property {(id: string, options?: object) => Promise<object>} restore apply a restore
 * @property {(id: string) => Promise<void>} remove delete one snapshot
 * @property {(ids: string[], options?: object) => Promise<object>} export build a portable bundle
 * @property {(ids: string[], file: string, options?: object) => Promise<object>} exportToFile write a bundle file
 * @property {(file: string, options?: object) => Promise<object[]>} importFile import a bundle file
 * @property {(bundle: object, options?: object) => Promise<object[]>} importBundle import a decoded bundle
 * @property {(file: string, options?: object) => Promise<object>} peek inspect a bundle file header
 * @property {(options?: object) => Promise<object>} stats vault footprint
 */

/**
 * Create a vault handle bound to one DSH home.
 * @param {{ home?: string, env?: Record<string, string|undefined>, profile?: string }} [options]
 * @returns {Vault}
 */
export function createVault(options = {}) {
  const env = options.env ?? process.env
  const context = toVaultContext({ home: options.home, agentsHome: options.agentsHome, env })
  const profile = options.profile ?? detectProfileName({ env, home: context.home })
  return {
    home: context.home,
    agentsHome: context.roots.agents,
    profile,
    scopes: () => describeScopes(),
    snapshot: (snapshotOptions = {}) => createSnapshot(context, snapshotOptions),
    list: (listOptions = {}) => listSnapshots(context, listOptions),
    diff: (id, diffOptions = {}) => diffSnapshotVsCurrent(context, id, diffOptions),
    diffTwo: (baseId, targetId, diffOptions = {}) => diffSnapshots(context, baseId, targetId, diffOptions),
    planRestore: (id, restoreOptions = {}) => planRestore(context, id, restoreOptions),
    restore: (id, restoreOptions = {}) => applyRestore(context, id, restoreOptions),
    remove: (id) => deleteSnapshot(context, id),
    export: (ids, exportOptions = {}) => buildBundle(context, ids, exportOptions),
    exportToFile: (ids, file, exportOptions = {}) => exportBundleToFile(context, ids, file, exportOptions),
    importFile: (file, importOptions = {}) => readBundleFile(file, importOptions).then(bundle => importBundle(context, bundle, importOptions)),
    importBundle: (bundle, importOptions = {}) => importBundle(context, decodeBundle(bundle, importOptions), importOptions),
    peek: (file, peekOptions = {}) => peekBundleFile(file, peekOptions),
    stats: () => vaultStats(context),
    prune: (pruneOptions = {}) => pruneSnapshots(context, pruneOptions),
  }
}

export { vaultDataDir, snapshotsDir }
