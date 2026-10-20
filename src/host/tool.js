/**
 * Model-facing tool `config_vault`.
 *
 * The tool is the same action vocabulary as the HTTP routes, so a model can
 * snapshot, inspect and roll back DSH configuration without a browser. It
 * returns plain objects; `render` serialises them to pretty JSON text.
 *
 * Destructive actions are explicit (`restore`, `remove`, `prune`) and a
 * restore always takes a safety snapshot first, which `output` reports as
 * `safetySnapshotId` so the model can point the user at the rollback.
 */

import { stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { VaultError } from '../core/errors.js'
import { summarizeManifest } from '../core/snapshot.js'
import { describeScopes } from '../core/scopes.js'
import { ensureDir } from '../core/util.js'

/** Tool name registered with the model. */
export const TOOL_NAME = 'config_vault'

/**
 * @typedef {object} ToolArguments
 * @property {string} action
 * @property {string} [id]
 * @property {string[]} [ids]
 * @property {string} [name]
 * @property {string} [note]
 * @property {string[]} [scopes]
 * @property {boolean} [includeSecrets]
 * @property {string} [passphrase]
 * @property {string} [file]
 * @property {number} [keepManual]
 * @property {number} [keepAuto]
 */

/**
 * Build the tool definition for one vault handle.
 * @param {object} vault vault handle from createVault
 * @param {{ includeCredentials: boolean, keepManual: number, keepAuto: number }} settings
 * @returns {object} cordis ToolDefinition
 */
export function buildTool(vault, settings) {
  /** @param {unknown} args */
  const readArgs = (args) => (typeof args === 'object' && args !== null ? /** @type {ToolArguments} */ (args) : {})

  /**
   * Execute one action, converting thrown errors into a result object the
   * model can read and react to instead of an exception.
   * @param {ToolArguments} input
   */
  async function run(input) {
    switch (input.action) {
      case 'status': {
        const { snapshots, invalid } = await vault.list({ limit: 50 })
        return {
          ok: true,
          home: vault.home,
          agentsHome: vault.agentsHome,
          profile: vault.profile,
          stats: await vault.stats(),
          scopes: describeScopes(),
          snapshots: snapshots.map(summarizeManifest),
          invalid,
        }
      }
      case 'list': {
        const { snapshots, invalid } = await vault.list({ limit: 200 })
        return { ok: true, snapshots: snapshots.map(summarizeManifest), invalid }
      }
      case 'snapshot': {
        const manifest = await vault.snapshot({
          name: input.name,
          note: input.note,
          scopes: input.scopes,
          includeSecrets: input.includeSecrets ?? settings.includeCredentials,
        })
        return { ok: true, snapshot: summarizeManifest(manifest) }
      }
      case 'diff':
        return { ok: true, diff: await vault.diff(requireId(input), { scopes: input.scopes }) }
      case 'plan':
        return { ok: true, plan: await vault.planRestore(requireId(input), { scopes: input.scopes, includeSecrets: input.includeSecrets }) }
      case 'restore': {
        const result = await vault.restore(requireId(input), {
          scopes: input.scopes,
          includeSecrets: input.includeSecrets,
        })
        return { ok: true, restore: result, note: '恢复前的配置已自动快照，可用 safetySnapshotId 回滚' }
      }
      case 'remove':
        await vault.remove(requireId(input))
        return { ok: true, removed: requireId(input) }
      case 'prune':
        return {
          ok: true,
          prune: await vault.prune({
            keepManual: input.keepManual ?? settings.keepManual,
            keepAuto: input.keepAuto ?? settings.keepAuto,
          }),
        }
      case 'export': {
        // Tools run inside the DSH host: write the bundle to a file the user
        // can copy instead of streaming a large blob through the model.
        const ids = input.ids !== undefined && input.ids.length > 0
          ? input.ids
          : (await vault.list({ limit: 1 })).snapshots.map(manifest => manifest.id)
        if (ids.length === 0) throw new VaultError('no-snapshots', '还没有任何快照可导出')
        const file = input.file !== undefined && input.file !== ''
          ? input.file
          : join(vault.home, 'config-vault', 'exports', `export-${Date.now()}.json`)
        await ensureDir(dirname(file))
        const bundle = await vault.exportToFile(ids, file, { passphrase: input.passphrase })
        const info = await stat(file)
        return { ok: true, file, snapshots: ids, encrypted: bundle.encrypted === true, bytes: info.size }
      }
      case 'import': {
        if (input.file === undefined || input.file === '') throw new VaultError('invalid-argument', 'import 需要 file 参数')
        const imported = await vault.importFile(input.file, { passphrase: input.passphrase })
        return { ok: true, imported: imported.map(summarizeManifest) }
      }
      default:
        throw new VaultError('unknown-action', `未知操作：${String(input.action)}`)
    }
  }

  /**
   * @param {ToolArguments} input
   * @returns {string}
   */
  function requireId(input) {
    if (input.id === undefined || input.id === '') throw new VaultError('invalid-argument', '缺少参数 id')
    return input.id
  }

  return {
    name: TOOL_NAME,
    description: [
      'DSH 配置保险箱：为当前 DSH 配置（设置补丁、插件清单、技能与规则、工作区列表，凭据需显式开启）创建快照，',
      '对比快照与当前磁盘的差异，预览并回滚到任一快照。恢复前会自动创建安全快照，绝不删除快照之外的文件。',
      'action 可选：status(查看状态与作用域)、list(列出快照)、snapshot(新建快照)、diff(快照 vs 当前)、',
      'plan(恢复预演)、restore(执行恢复)、remove(删除快照)、export(导出 JSON 包到文件)、import(从 JSON 包导入)、prune(清理旧快照)。',
    ].join(''),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['status', 'list', 'snapshot', 'diff', 'plan', 'restore', 'remove', 'export', 'import', 'prune'],
          description: '要执行的操作',
        },
        id: { type: 'string', description: '快照 id（diff/plan/restore/remove 需要）' },
        ids: { type: 'array', items: { type: 'string' }, description: '导出多个快照 id（export，缺省导出最新一个）' },
        name: { type: 'string', description: '快照名称（snapshot 可选）' },
        note: { type: 'string', description: '快照备注（snapshot 可选）' },
        scopes: {
          type: 'array',
          items: { type: 'string' },
          description: '作用域 id 列表：settings/plugins/deps/skills/workspaces/credentials；缺省为核心作用域，credentials 默认不含',
        },
        includeSecrets: { type: 'boolean', description: '是否包含凭据等密钥文件（默认 false）' },
        passphrase: { type: 'string', description: '导出口令；包含凭据的快照必须提供' },
        file: { type: 'string', description: '导出/导入的 JSON 包文件绝对路径' },
        keepManual: { type: 'number', description: 'prune 保留的手动快照数' },
        keepAuto: { type: 'number', description: 'prune 保留的自动快照数' },
      },
      required: ['action'],
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    timeoutMs: 120_000,
    async execute(args) {
      const input = readArgs(args)
      if (typeof input.action !== 'string' || input.action === '') {
        return { ok: false, code: 'invalid-argument', message: '缺少 action' }
      }
      try {
        return await run(input)
      } catch (error) {
        return {
          ok: false,
          code: typeof error?.code === 'string' ? error.code : 'internal',
          message: error instanceof Error ? error.message : String(error),
        }
      }
    },
  }
}
