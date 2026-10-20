/**
 * Host routes: `/config-vault/<action>`, all POST + JSON, all loopback-only.
 *
 * The browser half and the model-facing tool both go through this one action
 * vocabulary, so the UI cannot drift from the tool. Every action returns the
 * `{ ok: true, value }` envelope; failures use `{ ok: false, error }`.
 */

import { VaultError } from '../core/errors.js'
import { decodeBundle } from '../core/bundle.js'
import { describeScopes } from '../core/scopes.js'
import { summarizeManifest } from '../core/snapshot.js'
import { IMPORT_BODY_LIMIT, postRoute } from './http.js'

/** Largest export a route will send to the browser in one JSON response. */
const MAX_ROUTE_EXPORT_BYTES = 16 * 1024 * 1024

/**
 * Read an optional string argument.
 * @param {Record<string, unknown>} payload
 * @param {string} key
 * @returns {string|undefined}
 */
function optionalString(payload, key) {
  const value = payload[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new VaultError('invalid-argument', `参数 ${key} 必须是字符串`)
  return value
}

/**
 * Read an optional string-array argument.
 * @param {Record<string, unknown>} payload
 * @param {string} key
 * @returns {string[]|undefined}
 */
function optionalStringArray(payload, key) {
  const value = payload[key]
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new VaultError('invalid-argument', `参数 ${key} 必须是字符串数组`)
  }
  return value
}

/**
 * Read an optional boolean argument.
 * @param {Record<string, unknown>} payload
 * @param {string} key
 * @returns {boolean|undefined}
 */
function optionalBoolean(payload, key) {
  const value = payload[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'boolean') throw new VaultError('invalid-argument', `参数 ${key} 必须是布尔值`)
  return value
}

/**
 * Read a required string argument.
 * @param {Record<string, unknown>} payload
 * @param {string} key
 * @returns {string}
 */
function requiredString(payload, key) {
  const value = optionalString(payload, key)
  if (value === undefined || value === '') throw new VaultError('invalid-argument', `缺少参数 ${key}`)
  return value
}

/**
 * Read an optional non-negative integer argument.
 * @param {Record<string, unknown>} payload
 * @param {string} key
 * @returns {number|undefined}
 */
function optionalCount(payload, key) {
  const value = payload[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new VaultError('invalid-argument', `参数 ${key} 必须是非负整数`)
  }
  return value
}

/**
 * A stable export filename for a bundle.
 * @param {Date} at
 */
function exportFileName(at = new Date()) {
  const pad = value => String(value).padStart(2, '0')
  return `dsh-config-vault-${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}.json`
}

/**
 * Register every vault route on the host webserver.
 * @param {import('@deepseek-ai/cordis').Context} ctx host context with webServer
 * @param {object} vault vault handle from createVault
 * @param {{ routePrefix: string, includeCredentials: boolean, keepManual: number, keepAuto: number }} settings
 * @returns {Array<() => void>} disposers
 */
export function registerRoutes(ctx, vault, settings) {
  const prefix = settings.routePrefix

  /** @param {string} action @param {(payload: Record<string, unknown>) => Promise<unknown>} handler @param {{ limit?: number }} [options] */
  const route = (action, handler, options) => ctx.webServer.register({
    kind: 'exact',
    path: `${prefix}/${action}`,
    handler: postRoute(handler, options),
  })

  const disposers = [
    route('status', async () => {
      const stats = await vault.stats()
      const listed = await vault.list({ limit: 200 })
      return {
        home: vault.home,
        agentsHome: vault.agentsHome,
        profile: vault.profile,
        scopes: describeScopes(),
        stats,
        snapshots: listed.snapshots.map(summarizeManifest),
        invalid: listed.invalid,
        routePrefix: prefix,
        running: true,
      }
    }),

    route('list', async payload => {
      const kind = optionalString(payload, 'kind')
      if (kind !== undefined && kind !== 'manual' && kind !== 'auto') {
        throw new VaultError('invalid-argument', 'kind 只能是 manual 或 auto')
      }
      const limit = optionalCount(payload, 'limit')
      const { snapshots, invalid } = await vault.list({ kind: /** @type {'manual'|'auto'|undefined} */ (kind), limit })
      return { snapshots: snapshots.map(summarizeManifest), invalid }
    }),

    route('snapshot', async payload => {
      const manifest = await vault.snapshot({
        name: optionalString(payload, 'name'),
        note: optionalString(payload, 'note'),
        scopes: optionalStringArray(payload, 'scopes'),
        includeSecrets: optionalBoolean(payload, 'includeSecrets') ?? settings.includeCredentials,
      })
      return { snapshot: summarizeManifest(manifest) }
    }),

    route('diff', async payload => {
      const scopes = optionalStringArray(payload, 'scopes')
      if (payload.mode === 'between') {
        const diff = await vault.diffTwo(requiredString(payload, 'baseId'), requiredString(payload, 'targetId'), { scopes })
        return { diff }
      }
      return { diff: await vault.diff(requiredString(payload, 'id'), { scopes }) }
    }),

    route('plan', async payload => {
      const plan = await vault.planRestore(requiredString(payload, 'id'), {
        scopes: optionalStringArray(payload, 'scopes'),
        includeSecrets: optionalBoolean(payload, 'includeSecrets'),
      })
      return { plan }
    }),

    route('restore', async payload => {
      const result = await vault.restore(requiredString(payload, 'id'), {
        scopes: optionalStringArray(payload, 'scopes'),
        includeSecrets: optionalBoolean(payload, 'includeSecrets'),
        safetySnapshot: optionalBoolean(payload, 'safetySnapshot'),
        prune: optionalBoolean(payload, 'prune'),
      })
      return { restore: result }
    }),

    route('remove', async payload => {
      const id = requiredString(payload, 'id')
      await vault.remove(id)
      return { removed: id }
    }),

    route('prune', async payload => ({
      prune: await vault.prune({
        keepManual: optionalCount(payload, 'keepManual') ?? settings.keepManual,
        keepAuto: optionalCount(payload, 'keepAuto') ?? settings.keepAuto,
      }),
    })),

    route('export', async payload => {
      const ids = optionalStringArray(payload, 'ids')
      const manifestIds = ids ?? (await vault.list({ limit: 1 })).snapshots.map(snapshot => snapshot.id)
      if (manifestIds.length === 0) throw new VaultError('no-snapshots', '还没有任何快照可导出')
      const bundle = await vault.export(manifestIds, { passphrase: optionalString(payload, 'passphrase') })
      const content = JSON.stringify(bundle)
      if (Buffer.byteLength(content) > MAX_ROUTE_EXPORT_BYTES) {
        throw new VaultError('export-too-large', `导出内容超过 ${Math.round(MAX_ROUTE_EXPORT_BYTES / 1024 / 1024)} MiB 的浏览器上限，请改用工具或 CLI 导出到文件`)
      }
      return {
        filename: exportFileName(),
        content,
        encrypted: bundle.encrypted === true,
        snapshots: manifestIds,
        bytes: Buffer.byteLength(content),
      }
    }),

    route('import', async payload => {
      const passphrase = optionalString(payload, 'passphrase')
      /** @type {any} */
      let parsed
      const content = optionalString(payload, 'content')
      if (content !== undefined) {
        try {
          parsed = JSON.parse(content)
        } catch {
          throw new VaultError('bundle-invalid', '导入内容不是合法 JSON')
        }
      } else if (payload.bundle !== undefined && typeof payload.bundle === 'object') {
        parsed = payload.bundle
      } else {
        throw new VaultError('invalid-argument', '缺少导入内容')
      }
      const imported = await vault.importBundle(decodeBundle(parsed, { passphrase }), {})
      return { imported: imported.map(summarizeManifest) }
    }, { limit: IMPORT_BODY_LIMIT }),
  ]

  ctx.logger?.info?.('config-vault: routes registered at %s/*', prefix)
  return disposers
}
