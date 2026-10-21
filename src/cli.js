#!/usr/bin/env node
/**
 * Standalone CLI for the config vault: the same core the plugin exposes, so
 * a user can verify, script or rescue a configuration without the web GUI.
 *
 *   node src/cli.js status
 *   node src/cli.js scopes
 *   node src/cli.js snapshot --name "装插件前" --note "before upgrade"
 *   node src/cli.js list
 *   node src/cli.js diff <id>
 *   node src/cli.js restore <id> --apply [--scopes settings,plugins]
 *   node src/cli.js export <id> --out backup.dvault [--passphrase '...']
 *   node src/cli.js import --file backup.dvault [--passphrase '...']
 *
 * The home is `$DSH_HOME` (or `--home`), and `--json` prints raw JSON for
 * scripting.
 */

import { createVault } from './core/index.js'
import { toVaultError } from './core/errors.js'

/** Parsed command line. */
function parseArgs(argv) {
  /** @type {string[]} */
  const positional = []
  /** @type {Record<string, string|boolean>} */
  const flags = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token.startsWith('--')) {
      const key = token.slice(2)
      const next = argv[index + 1]
      if (next === undefined || next.startsWith('--')) {
        flags[key] = true
      } else {
        flags[key] = next
        index += 1
      }
    } else {
      positional.push(token)
    }
  }
  return { positional, flags }
}

/**
 * Split a comma-separated flag.
 * @param {string|boolean|undefined} value
 */
function listFlag(value) {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  return value.split(',').map(item => item.trim()).filter(Boolean)
}

/**
 * Print a human table.
 * @param {string[]} headers
 * @param {string[][]} rows
 */
function table(headers, rows) {
  const widths = headers.map((header, index) => Math.max(header.length, ...rows.map(row => (row[index] ?? '').length)))
  const line = (cells) => cells.map((cell, index) => String(cell ?? '').padEnd(widths[index])).join('  ')
  console.log(line(headers))
  console.log(widths.map(width => '-'.repeat(width)).join('  '))
  for (const row of rows) console.log(line(row))
}

/**
 * Format bytes for the terminal.
 * @param {number} bytes
 */
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`
}

/**
 * Render a diff result as a compact terminal report.
 * @param {any} diff
 */
function printDiff(diff) {
  console.log(`基线：${diff.base.kind === 'snapshot' ? `${diff.base.name} (${diff.base.id})` : '--'}  →  目标：${diff.target.kind === 'snapshot' ? diff.target.name : '当前配置'}`)
  console.log(`变更：${diff.summary.changed} 修改 / ${diff.summary.added} 新增 / ${diff.summary.removed} 缺失 / ${diff.summary.same} 未变`)
  for (const file of diff.files) {
    if (file.status === 'same') continue
    const label = file.status === 'added' ? '新增' : file.status === 'removed' ? '缺失' : '修改'
    console.log(`\n【${label}】${file.path}${file.secret ? '（含敏感值，已打码）' : ''}`)
    if (file.binary) {
      console.log('  （二进制文件，不展示内容）')
      continue
    }
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        const marker = line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' '
        console.log(`  ${marker} ${line.text}`)
      }
      console.log('  ---')
    }
    if (file.hunks.length === 0) console.log('  （无内容可展示）')
    if (file.truncated) console.log('  （已截断，仅显示前几段差异）')
    if (Array.isArray(file.jsonPaths) && file.jsonPaths.length > 0) {
      console.log(`  （JSON 变更路径：${file.jsonPaths.slice(0, 8).join(', ')}${file.jsonPaths.length > 8 ? ' …' : ''}）`)
    }
  }
  if (diff.warnings.length > 0) {
    console.log('\n提示：')
    for (const warning of diff.warnings) console.log(`  - ${warning}`)
  }
}

/**
 * Render a restore plan.
 * @param {any} plan
 */
function printPlan(plan) {
  console.log(`从快照「${plan.snapshot.name}」恢复（${plan.scopes.join(', ')}）`)
  console.log(`将覆盖 ${plan.counts.overwrite} 个、新建 ${plan.counts.create} 个、保持 ${plan.counts.unchanged} 个；快照中不存在的当前文件 ${plan.counts.extra} 个（不会删除）`)
  for (const operation of plan.operations) {
    if (operation.action === 'unchanged') continue
    console.log(`  ${operation.action === 'create' ? '新建' : '覆盖'}  ${operation.path}  (${formatBytes(operation.bytes)})${operation.secret ? '  [含密钥]' : ''}`)
  }
  if (plan.extra.length > 0) {
    console.log('\n以下当前文件不在快照中，恢复不会删除它们：')
    for (const entry of plan.extra) console.log(`  - ${entry.path}`)
  }
  if (plan.warnings.length > 0) {
    console.log('\n提示：')
    for (const warning of plan.warnings) console.log(`  - ${warning}`)
  }
  if (plan.restartRequired) console.log('\n恢复后需要重启或重载 DSH 才能完全生效。')
}

/**
 * Entry point.
 * @returns {Promise<number>} exit code
 */
async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2))
  const command = positional[0]
  const vault = createVault({
    home: typeof flags.home === 'string' ? flags.home : undefined,
    agentsHome: typeof flags['agents-home'] === 'string' ? flags['agents-home'] : undefined,
    profile: typeof flags.profile === 'string' ? flags.profile : undefined,
  })
  const json = flags.json === true

  /** @param {unknown} value */
  const output = (value) => {
    if (json) console.log(JSON.stringify(value, null, 2))
    return 0
  }

  switch (command) {
    case undefined:
    case 'help':
    case '--help':
      console.log(`DSH 配置保险箱 CLI

用法：node src/cli.js <命令> [参数]

命令：
  status                         查看保险箱状态与当前 DSH_HOME
  scopes                         列出可备份的作用域
  snapshot --name <名称> [--note <备注>] [--scopes a,b] [--include-secrets]
                                 创建快照
  list [--kind manual|auto]      列出快照
  diff <id> [--scopes a,b]       对比快照与当前配置
  restore <id> [--scopes a,b] [--include-secrets]
                                 预览恢复计划（只读）
  restore <id> --apply           执行恢复（会自动先备份当前状态）
  remove <id>                    删除快照
  export <id[,id]> --out <文件> [--passphrase <口令>]
                                 导出可移植备份
  import --file <文件> [--passphrase <口令>]
                                 导入备份文件
  prune [--keep-manual N] [--keep-auto N]
                                 按数量清理旧快照

全局参数：--home <DSH_HOME> --agents-home <共享 agents 目录> --profile <名称> --json`)
      return 0
    case 'status': {
      const stats = await vault.stats()
      if (json) return output({ home: vault.home, agentsHome: vault.agentsHome, profile: vault.profile, ...stats })
      console.log(`DSH_HOME：${vault.home}`)
      console.log(`共享 agents 目录：${vault.agentsHome}`)
      if (vault.profile !== undefined) console.log(`当前 profile：${vault.profile}`)
      console.log(`快照数：${stats.snapshots}（无效目录 ${stats.invalid.length} 个）`)
      console.log(`占用空间：${formatBytes(stats.bytes)}`)
      if (stats.newest !== undefined) console.log(`最新快照：${stats.newest}`)
      console.log(`存储目录：${stats.root}`)
      return 0
    }
    case 'scopes': {
      const scopes = vault.scopes()
      if (json) return output(scopes)
      table(['作用域', '默认', '恢复生效', '说明'], scopes.map(scope => [
        scope.id, scope.defaultOn ? '启用' : '关闭', scope.restoreEffect === 'live' ? '即时' : scope.restoreEffect === 'reload' ? '重载' : '重启', scope.description,
      ]))
      return 0
    }
    case 'snapshot': {
      const manifest = await vault.snapshot({
        name: typeof flags.name === 'string' ? flags.name : undefined,
        note: typeof flags.note === 'string' ? flags.note : undefined,
        scopes: listFlag(flags.scopes),
        includeSecrets: flags['include-secrets'] === true,
      })
      if (json) return output(manifest)
      console.log(`已创建快照：${manifest.name}  (${manifest.id})`)
      console.log(`文件 ${manifest.totals.files} 个，共 ${formatBytes(manifest.totals.bytes)}`)
      for (const warning of manifest.warnings) console.log(`提示：${warning}`)
      return 0
    }
    case 'list': {
      const { snapshots, invalid } = await vault.list({ kind: typeof flags.kind === 'string' ? /** @type {any} */ (flags.kind) : undefined })
      if (json) return output({ snapshots, invalid })
      if (snapshots.length === 0) {
        console.log('还没有快照。用 `snapshot` 创建第一个。')
        return 0
      }
      table(['ID', '名称', '类型', '时间', '文件', '大小'], snapshots.map(snapshot => [
        snapshot.id,
        snapshot.name,
        snapshot.kind === 'auto' ? '自动' : '手动',
        new Date(snapshot.createdAt).toLocaleString(),
        String(snapshot.totals.files),
        formatBytes(snapshot.totals.bytes),
      ]))
      if (invalid.length > 0) console.log(`\n有 ${invalid.length} 个目录无法读取：${invalid.map(entry => entry.id).join(', ')}`)
      return 0
    }
    case 'diff': {
      const id = positional[1]
      if (id === undefined) throw new Error('diff 需要快照 id')
      const diff = await vault.diff(id, { scopes: listFlag(flags.scopes) })
      if (json) return output(diff)
      printDiff(diff)
      return 0
    }
    case 'restore': {
      const id = positional[1]
      if (id === undefined) throw new Error('restore 需要快照 id')
      const options = { scopes: listFlag(flags.scopes), includeSecrets: flags['include-secrets'] === true }
      const plan = await vault.planRestore(id, options)
      if (flags.apply !== true) {
        if (json) return output(plan)
        printPlan(plan)
        console.log('\n这是预览。确认无误后加 --apply 执行恢复。')
        return 0
      }
      if (json) {
        const result = await vault.restore(id, options)
        return output(result)
      }
      printPlan(plan)
      const result = await vault.restore(id, options)
      console.log(`\n已恢复 ${result.restored.length} 个文件；未变 ${result.unchanged} 个。`)
      if (result.safetySnapshotId !== undefined) console.log(`恢复前状态已自动备份为：${result.safetySnapshotId}`)
      if (result.restartRequired) console.log('请重启或重载 DSH 使配置生效。')
      return 0
    }
    case 'remove': {
      const id = positional[1]
      if (id === undefined) throw new Error('remove 需要快照 id')
      await vault.remove(id)
      console.log(json ? JSON.stringify({ ok: true }) : `已删除快照 ${id}`)
      return 0
    }
    case 'export': {
      const ids = positional[1]?.split(',')
      if (ids === undefined || ids.length === 0) throw new Error('export 需要快照 id')
      const out = flags.out
      if (typeof out !== 'string' || out === '') throw new Error('export 需要 --out <文件>')
      const bundle = await vault.exportToFile(ids, out, { passphrase: typeof flags.passphrase === 'string' ? flags.passphrase : undefined })
      if (json) return output({ file: out, encrypted: bundle.encrypted === true })
      console.log(`已导出 ${ids.length} 个快照到 ${out}${bundle.encrypted === true ? '（已加密）' : ''}`)
      return 0
    }
    case 'import': {
      const file = flags.file
      if (typeof file !== 'string' || file === '') throw new Error('import 需要 --file <文件>')
      const imported = await vault.importFile(file, { passphrase: typeof flags.passphrase === 'string' ? flags.passphrase : undefined })
      if (json) return output(imported)
      console.log(`已导入 ${imported.length} 个快照：${imported.map(manifest => manifest.id).join(', ')}`)
      return 0
    }
    case 'prune': {
      // Reject junk before it reaches prune: Number('abc') is NaN, and a NaN
      // retention count would otherwise be treated as "keep 0" and delete
      // every snapshot.
      const count = (key) => {
        const raw = flags[key]
        if (raw === undefined) return undefined
        const value = typeof raw === 'string' ? Number(raw) : Number.NaN
        if (!Number.isInteger(value) || value < 0) throw new Error(`--${key} 必须是非负整数`)
        return value
      }
      const result = await vault.prune({ keepManual: count('keep-manual'), keepAuto: count('keep-auto') })
      console.log(json ? JSON.stringify(result) : `已清理 ${result.deleted.length} 个旧快照`)
      return 0
    }
    default:
      console.error(`未知命令：${command}（运行 --help 查看用法）`)
      return 2
  }
}

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((error) => {
    const { code, message } = toVaultError(error)
    console.error(`错误[${code}]：${message}`)
    process.exitCode = 1
  })
