/**
 * Scope model: what a "configuration snapshot" actually contains.
 *
 * Every scope owns allowlisted home-relative patterns (prefixed with the
 * logical root: `home` for `$DSH_HOME`, `agents` for `$DSH_AGENTS_HOME`), a
 * default on/off decision, the effect a restore has (live / reload /
 * restart), and whether the files may carry secrets. Patterns support one `*`
 * segment and a trailing `**` recursive tail; expansion is existence based,
 * so a scope that does not apply to this DSH version is simply empty.
 *
 * Deliberately absent from v1: MCP server definitions and agent presets are
 * cordis.patch.yml rows in this DSH version, so the `settings` scope already
 * carries them; they are not separate files.
 */

import { readdir, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { listFilesRecursive, toLogicalPath } from './util.js'

/**
 * @typedef {object} ScopeDefinition
 * @property {string} id stable scope id used by every surface
 * @property {string} label zh-CN display name
 * @property {string} description what the scope covers
 * @property {boolean} defaultOn included when the caller names no scopes
 * @property {'live'|'reload'|'restart'} restoreEffect what a restore needs to take effect
 * @property {boolean} secretScoped files here are secret-bearing by nature
 * @property {string[]} patterns logical-root-prefixed patterns (`home/...`, `agents/...`)
 * @property {string} [restoreWarning] safety note shown in a restore plan
 */

/** Files that are never configuration: backups, logs, temp files and vault internals. */
const SKIP_NAMES = [
  /\.bak($|[-.])/, /\.log$/, /\.tmp$/, /^\.tmp/, /~$/, /\.swp$/, /^\.DS_Store$/, /^Thumbs\.db$/i,
]
/** Directories never walked inside a recursive scope (heavy or generated content). */
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'cache', 'logs', 'attachments', 'sessions', 'session_projcache',
  'diff-approval', 'config-vault', '.venv', 'venv', '__pycache__', '.pytest_cache',
  'site-packages', 'dist', 'build', '.cache', '.mypy_cache', '.ruff_cache',
])

/** @type {ScopeDefinition[]} */
export const SCOPES = [
  {
    id: 'settings',
    label: '设置与插件参数',
    description: 'DSH 主页补丁与每个 profile 的 cordis.patch.yml —— 模型路由、主题、插件启停与参数、MCP 服务器、智能体预设都在这些行里',
    defaultOn: true,
    restoreEffect: 'reload',
    secretScoped: false,
    patterns: [
      'home/cordis.patch.yml',
      'home/profiles/*/cordis.patch.yml',
      'home/profiles/*/settings.yaml',
    ],
  },
  {
    id: 'plugins',
    label: '插件清单',
    description: '每个 profile 的 package.json（已安装插件与 bundle 顺序）、工作区配置、本地补丁；插件独立配置文件',
    defaultOn: true,
    restoreEffect: 'reload',
    secretScoped: false,
    patterns: [
      'home/profiles/*/package.json',
      'home/profiles/*/pnpm-workspace.yaml',
      'home/profiles/*/compatibility.json',
      'home/profiles/*/patches/**',
      'home/plugins/*/config.yaml',
      'home/plugins/*/config.yml',
      'home/plugins/*/config.json',
    ],
  },
  {
    id: 'deps',
    label: '依赖锁文件',
    description: '每个 profile 的 pnpm-lock.yaml —— 换机后精确复现插件版本，体积较大，默认关闭',
    defaultOn: false,
    restoreEffect: 'restart',
    secretScoped: false,
    patterns: ['home/profiles/*/pnpm-lock.yaml'],
  },
  {
    id: 'skills',
    label: '技能与规则',
    description: 'DSH 技能目录与 AGENTS.md/CLAUDE.md 规则文件（含共享 ~/.agents）；自动跳过虚拟环境、依赖与模型权重',
    defaultOn: true,
    restoreEffect: 'restart',
    secretScoped: false,
    patterns: [
      'home/skills/**',
      'agents/skills/**',
      'home/AGENTS.md',
      'agents/AGENTS.md',
      'home/CLAUDE.md',
      'agents/CLAUDE.md',
    ],
  },
  {
    id: 'workspaces',
    label: '工作区列表',
    description: '已登记的工作区根目录列表（只存列表，不存工作区内容）',
    defaultOn: true,
    restoreEffect: 'restart',
    secretScoped: false,
    restoreWarning: '工作区列表由运行中的宿主整体重写，必须在 DSH 停止时恢复，否则会被覆盖',
    patterns: ['home/storages/workspace.json'],
  },
  {
    id: 'credentials',
    label: '凭据（密钥）',
    description: '.credentials.yaml 登录凭据 —— 默认不备份；如开启，导出时必须设置口令加密',
    defaultOn: false,
    restoreEffect: 'restart',
    secretScoped: true,
    restoreWarning: '凭据文件包含明文密钥；导出必须加密，恢复后请确认文件权限',
    patterns: ['home/.credentials.yaml', 'home/.credentials.yml', 'home/credentials.yaml'],
  },
]

/** @type {Map<string, ScopeDefinition>} */
const SCOPES_BY_ID = new Map(SCOPES.map(scope => [scope.id, scope]))

/**
 * Look up a scope by id.
 * @param {string} id
 * @returns {ScopeDefinition|undefined}
 */
export function getScope(id) {
  return SCOPES_BY_ID.get(id)
}

/**
 * Resolve the requested scope ids into definitions, applying the default set
 * when the caller names none. Unknown ids are reported rather than silently
 * dropped.
 * @param {string[]|undefined} requested
 * @returns {{ scopes: ScopeDefinition[], unknown: string[] }}
 */
export function resolveScopes(requested) {
  if (requested === undefined || requested.length === 0) {
    return { scopes: SCOPES.filter(scope => scope.defaultOn), unknown: [] }
  }
  /** @type {ScopeDefinition[]} */
  const scopes = []
  const unknown = []
  for (const id of requested) {
    const scope = SCOPES_BY_ID.get(id)
    if (scope === undefined) unknown.push(id)
    else if (!scopes.includes(scope)) scopes.push(scope)
  }
  return { scopes, unknown }
}

/**
 * Whether a file name is ignored as non-configuration clutter.
 * @param {string} name
 */
export function isIgnoredName(name) {
  return SKIP_NAMES.some(pattern => pattern.test(name))
}

/**
 * Whether a directory name is skipped during recursive collection.
 * @param {string} name
 */
export function isSkippedDir(name) {
  return SKIP_DIRS.has(name)
}

/**
 * Expand one logical-root-prefixed pattern into absolute file paths.
 * @param {{ home: string, agents: string }} roots
 * @param {string} pattern
 * @returns {Promise<Array<{ logicalPath: string, absolute: string }>>}
 */
async function expandPattern(roots, pattern) {
  const [rootKey, ...segments] = pattern.split('/')
  const root = roots[rootKey]
  if (root === undefined) throw new Error(`unknown logical root in pattern: ${pattern}`)
  if (segments.length === 0) return []
  /** @type {Array<{ logicalPath: string, absolute: string }>} */
  const found = []
  /** @type {string[]} */
  let candidates = [root]
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]
    const last = index === segments.length - 1
    /** @type {string[]} */
    const next = []
    for (const candidate of candidates) {
      if (segment === '**') {
        if (!last) throw new Error(`unsupported pattern segment after **: ${pattern}`)
        const files = await listFilesRecursive(candidate, {
          skip: name => isIgnoredName(name) || isSkippedDir(name),
        }).catch(() => [])
        next.push(...files)
        continue
      }
      if (segment === '*') {
        let entries
        try {
          entries = await readdir(candidate, { withFileTypes: true })
        } catch {
          continue
        }
        for (const entry of entries) {
          if (isSkippedDir(entry.name) || isIgnoredName(entry.name)) continue
          const absolute = join(candidate, entry.name)
          if (last) next.push(absolute)
          else if (entry.isDirectory()) next.push(absolute)
        }
        continue
      }
      next.push(join(candidate, segment))
    }
    candidates = next
  }
  for (const candidate of candidates) {
    try {
      const info = await stat(candidate)
      if (!info.isFile()) continue
      const logicalPath = toLogicalPath(roots, candidate)
      if (logicalPath === undefined) continue
      found.push({ logicalPath, absolute: candidate })
    } catch {
      // missing path: the pattern simply does not apply on this machine
    }
  }
  return found
}

/**
 * Expand one scope into logical file paths.
 * @param {{ home: string, agents: string }} roots
 * @param {ScopeDefinition} scope
 * @returns {Promise<string[]>}
 */
export async function collectScopeFiles(roots, scope) {
  const seen = new Set()
  for (const pattern of scope.patterns) {
    for (const file of await expandPattern(roots, pattern)) seen.add(file.logicalPath)
  }
  return [...seen].sort()
}

/**
 * Expand a list of scopes into snapshot candidates. A file claimed by two
 * scopes keeps the first scope in registry order.
 * @param {{ home: string, agents: string }} roots
 * @param {ScopeDefinition[]} scopes
 * @returns {Promise<Array<{ logicalPath: string, scope: string, secret: boolean }>>}
 */
export async function collectFiles(roots, scopes) {
  /** @type {Map<string, { logicalPath: string, scope: string, secret: boolean }>} */
  const byPath = new Map()
  for (const scope of scopes) {
    for (const logicalPath of await collectScopeFiles(roots, scope)) {
      if (byPath.has(logicalPath)) continue
      byPath.set(logicalPath, {
        logicalPath,
        scope: scope.id,
        secret: scope.secretScoped || isSecretFile(logicalPath),
      })
    }
  }
  return [...byPath.values()].sort((a, b) => (a.logicalPath < b.logicalPath ? -1 : 1))
}

/**
 * Name-based secret file detection. Content-based masking lives in
 * `secrets.js`; this is the coarse gate for whole-file exclusion.
 * @param {string} logicalPath
 */
export function isSecretFile(logicalPath) {
  const base = logicalPath.split('/').pop() ?? ''
  return /credential/i.test(base) || /secret/i.test(base) || /\.env(\.|$)/i.test(base)
}

/**
 * The public description of every scope for tools and UI.
 * @returns {Array<Pick<ScopeDefinition, 'id'|'label'|'description'|'defaultOn'|'restoreEffect'|'secretScoped'|'restoreWarning'>>}
 */
export function describeScopes() {
  return SCOPES.map(scope => ({
    id: scope.id,
    label: scope.label,
    description: scope.description,
    defaultOn: scope.defaultOn,
    restoreEffect: scope.restoreEffect,
    secretScoped: scope.secretScoped,
    restoreWarning: scope.restoreWarning,
  }))
}

/**
 * Relative path helper used by tests and diagnostics.
 * @param {string} home
 * @param {string} absolute
 */
export function relativeToHome(home, absolute) {
  return relative(home, absolute).split('\\').join('/')
}
