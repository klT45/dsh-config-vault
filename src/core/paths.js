/**
 * Resolution of the DeepSeek Harness home and the file layout the vault
 * snapshots. Mirrors `@deepseek-ai/dsh-home-paths` precedence without
 * importing it: an explicit home wins, then `$DSH_HOME`, then `~/.dsh`
 * (a blank environment value counts as unset).
 */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'

/** Directory (under the DSH home) that holds vault metadata and snapshots. */
export const VAULT_DIR = 'config-vault'
/** Snapshot payload entries that are vault internals and never snapshotted. */
export const VAULT_INTERNAL = new Set([VAULT_DIR, 'cache', 'logs', 'attachments', 'sessions', 'diff-approval', 'node_modules'])

/**
 * Resolve the harness home with the documented precedence.
 * @param {{ env?: Record<string, string|undefined>, explicit?: string }} [options]
 * @returns {string} absolute home path
 */
export function resolveDshHome(options = {}) {
  const env = options.env ?? process.env
  const explicit = typeof options.explicit === 'string' ? options.explicit.trim() : ''
  if (explicit !== '') return resolve(explicit)
  const fromEnv = typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : ''
  if (fromEnv !== '') return resolve(fromEnv)
  return join(homedir(), '.dsh')
}

/**
 * Resolve the shared agents home (`$DSH_AGENTS_HOME`, default `~/.agents`),
 * which holds user-level skills and AGENTS.md rules.
 * @param {{ env?: Record<string, string|undefined>, explicit?: string }} [options]
 * @returns {string}
 */
export function resolveAgentsHome(options = {}) {
  const env = options.env ?? process.env
  const explicit = typeof options.explicit === 'string' ? options.explicit.trim() : ''
  if (explicit !== '') return resolve(explicit)
  const fromEnv = typeof env.DSH_AGENTS_HOME === 'string' ? env.DSH_AGENTS_HOME.trim() : ''
  if (fromEnv !== '') return resolve(fromEnv)
  return join(homedir(), '.agents')
}

/**
 * Normalize a vault context argument. Public APIs accept either a plain home
 * path (agents home resolved from the environment) or a context object.
 * @param {string|{ home?: string, roots?: { home: string, agents: string }, agentsHome?: string, env?: Record<string, string|undefined> }} input
 * @returns {{ home: string, roots: { home: string, agents: string } }}
 */
export function toVaultContext(input) {
  if (typeof input === 'string' && input !== '') {
    const home = resolve(input)
    return { home, roots: { home, agents: resolveAgentsHome({}) } }
  }
  const record = (input ?? {})
  if (record.roots !== undefined) {
    return { home: record.roots.home, roots: record.roots }
  }
  const roots = resolveRoots({ home: record.home, agentsHome: record.agentsHome, env: record.env })
  return { home: roots.home, roots }
}

/**
 * The logical roots a snapshot may read and restore. Logical paths are
 * `<root>/<relative>` so one snapshot can span the harness home and the
 * shared agents home without ever recording absolute machine paths.
 * @param {{ home?: string, agentsHome?: string, env?: Record<string, string|undefined> }} [options]
 * @returns {{ home: string, agents: string }}
 */
export function resolveRoots(options = {}) {
  return {
    home: resolveDshHome({ env: options.env, explicit: options.home }),
    agents: resolveAgentsHome({ env: options.env, explicit: options.agentsHome }),
  }
}

/**
 * The vault data directory for one home.
 * @param {string} home
 */
export function vaultDataDir(home) {
  return join(home, VAULT_DIR)
}

/**
 * The snapshot storage directory for one home.
 * @param {string} home
 */
export function snapshotsDir(home) {
  return join(vaultDataDir(home), 'snapshots')
}

/**
 * One snapshot directory.
 * @param {string} home
 * @param {string} id
 */
export function snapshotDir(home, id) {
  return join(snapshotsDir(home), id)
}

/**
 * List profile names present under the home, excluding internal entries.
 * @param {string} home
 * @returns {Promise<string[]>}
 */
export async function listProfiles(home) {
  let entries
  try {
    entries = await readdir(join(home, 'profiles'), { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules')
    .map(entry => entry.name)
    .sort()
}

/**
 * Detect the profile the plugin is running inside, best effort. The host
 * passes the profile through its `profileContext` service (used by the plugin
 * entry); this environment fallback is for the standalone CLI. A name from the
 * environment is only trusted when that profile actually exists in the given
 * home, so a shell exported from another harness installation cannot lie about
 * the home selected with `--home`.
 * @param {{ env?: Record<string, string|undefined>, home: string }} options
 * @returns {string|undefined}
 */
export function detectProfileName(options) {
  const env = options.env ?? process.env
  for (const key of ['DSH_PROFILE', 'DSH_ACTIVE_PROFILE']) {
    const value = typeof env[key] === 'string' ? env[key].trim() : ''
    if (value !== '' && existsSync(join(options.home, 'profiles', value))) return value
  }
  return undefined
}
