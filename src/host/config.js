/**
 * Plugin configuration, declared as a hand-written Standard Schema v1 object.
 *
 * The Cordis Loader validates a plugin row's `config` through
 * `Config['~standard'].validate(raw)` before calling `apply`, so this needs no
 * `@deepseek-ai/schemastery` dependency and the package keeps a zero-dependency
 * runtime. Trade-off: without a schemastery schema the Host cannot
 * auto-generate a Settings form for the row; the vault ships its own UI
 * section instead, and these values are set in `cordis.patch.yml`.
 */

/** Default route prefix owned by this plugin. */
export const DEFAULT_ROUTE_PREFIX = '/config-vault'

/**
 * @typedef {object} VaultConfig
 * @property {string} routePrefix HTTP path prefix for the vault routes
 * @property {boolean} includeCredentials whether snapshots include credentials by default
 * @property {number} keepManual manual snapshots kept by prune
 * @property {number} keepAuto automatic snapshots kept by prune
 * @property {string} [home] optional DSH home override (testing/advanced)
 */

/** @type {VaultConfig} */
const DEFAULTS = {
  routePrefix: DEFAULT_ROUTE_PREFIX,
  includeCredentials: false,
  keepManual: 30,
  keepAuto: 10,
}

/**
 * Validate and normalize raw row config.
 * @param {unknown} raw
 * @returns {{ value: VaultConfig } | { issues: Array<{ message: string, path: Array<string|number> }> }}
 */
function validate(raw) {
  const input = raw === undefined || raw === null ? {} : raw
  if (typeof input !== 'object' || Array.isArray(input)) {
    return { issues: [{ message: 'config 必须是对象', path: [] }] }
  }
  /** @type {Record<string, unknown>} */
  const record = /** @type {any} */ (input)
  /** @type {Array<{ message: string, path: Array<string|number> }>} */
  const issues = []

  let routePrefix = DEFAULTS.routePrefix
  if (record.routePrefix !== undefined) {
    if (typeof record.routePrefix !== 'string' || !/^\/[A-Za-z0-9._~\-/]*$/.test(record.routePrefix) || record.routePrefix.endsWith('/')) {
      issues.push({ message: 'routePrefix 必须是以 / 开头的路径且不能以 / 结尾', path: ['routePrefix'] })
    } else {
      routePrefix = record.routePrefix
    }
  }

  let includeCredentials = DEFAULTS.includeCredentials
  if (record.includeCredentials !== undefined) {
    if (typeof record.includeCredentials !== 'boolean') {
      issues.push({ message: 'includeCredentials 必须是布尔值', path: ['includeCredentials'] })
    } else {
      includeCredentials = record.includeCredentials
    }
  }

  /** @param {'keepManual'|'keepAuto'} key */
  const readCount = (key) => {
    const value = record[key]
    if (value === undefined) return DEFAULTS[key]
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 1000) {
      issues.push({ message: `${key} 必须是 0-1000 的整数`, path: [key] })
      return DEFAULTS[key]
    }
    return value
  }
  const keepManual = readCount('keepManual')
  const keepAuto = readCount('keepAuto')

  let home
  if (record.home !== undefined) {
    if (typeof record.home !== 'string') issues.push({ message: 'home 必须是字符串', path: ['home'] })
    else if (record.home.trim() !== '') home = record.home.trim()
  }

  let agentsHome
  if (record.agentsHome !== undefined) {
    if (typeof record.agentsHome !== 'string') issues.push({ message: 'agentsHome 必须是字符串', path: ['agentsHome'] })
    else if (record.agentsHome.trim() !== '') agentsHome = record.agentsHome.trim()
  }

  if (issues.length > 0) return { issues }
  return {
    value: {
      routePrefix,
      includeCredentials,
      keepManual,
      keepAuto,
      ...(home === undefined ? {} : { home }),
      ...(agentsHome === undefined ? {} : { agentsHome }),
    },
  }
}

/** Standard Schema v1 facade the Loader validates with. */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-config-vault',
    validate,
  },
}

/**
 * Resolve the effective configuration regardless of how the plugin was
 * instantiated (Loader-validated object, raw row object, or nothing).
 * @param {unknown} config
 * @returns {VaultConfig}
 */
export function resolveConfiguration(config) {
  const validated = validate(config)
  if ('issues' in validated) {
    const detail = validated.issues.map(issue => `${issue.path.join('.') || 'config'}: ${issue.message}`).join('; ')
    throw new Error(`config-vault: invalid configuration — ${detail}`)
  }
  return validated.value
}
