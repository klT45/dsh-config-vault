/**
 * CLI integration tests: the standalone command must reject bad retention
 * flags instead of deleting snapshots, and must round-trip export/import.
 */

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { createSnapshot, listSnapshots } from '../src/core/index.js'
import { makeHome } from './helpers.js'

const run = promisify(execFile)
const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url))

/** @type {string} */
let home
/** @type {string} */
let agentsHome

/** @param {string[]} args */
function cliEnv(env = {}) {
  return { ...process.env, DSH_HOME: home, DSH_AGENTS_HOME: agentsHome, ...env }
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'dsh-vault-cli-'))
  agentsHome = await mkdtemp(join(tmpdir(), 'dsh-vault-cli-agents-'))
  await makeHome(home, agentsHome)
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
  await rm(agentsHome, { recursive: true, force: true })
})

describe('cli', () => {
  it('status and list work against a real home', async () => {
    const status = await run(process.execPath, [cli, 'status'], { env: cliEnv() })
    assert.match(status.stdout, /快照数/)
    const listed = await run(process.execPath, [cli, 'list', '--json'], { env: cliEnv() })
    const parsed = JSON.parse(listed.stdout)
    assert.ok(Array.isArray(parsed.snapshots))
  })

  it('refuses a non-numeric prune retention flag and keeps every snapshot', async () => {
    await createSnapshot({ home, agentsHome }, { name: 'keep-me' })
    await assert.rejects(
      run(process.execPath, [cli, 'prune', '--keep-manual', 'abc'], { env: cliEnv() }),
      (error) => {
        assert.equal(error.code, 1, 'CLI must exit non-zero')
        assert.match(String(error.stderr), /非负整数/)
        return true
      },
    )
    const { snapshots } = await listSnapshots({ home, agentsHome })
    assert.equal(snapshots.length, 1, 'a rejected prune must not delete snapshots')
  })

  it('prunes with a valid retention count', async () => {
    for (let index = 0; index < 3; index += 1) {
      await createSnapshot({ home, agentsHome }, { name: `snap-${index}` })
    }
    const result = await run(process.execPath, [cli, 'prune', '--keep-manual', '1'], { env: cliEnv() })
    assert.match(result.stdout, /已清理/)
    const { snapshots } = await listSnapshots({ home, agentsHome })
    assert.equal(snapshots.filter(snapshot => snapshot.kind === 'manual').length, 1)
  })

  it('exports and re-imports a bundle with --json output', async () => {
    const manifest = await createSnapshot({ home, agentsHome }, { name: 'portable' })
    const file = join(home, 'bundle.json')
    const exported = await run(process.execPath, [cli, 'export', manifest.id, '--out', file, '--json'], { env: cliEnv() })
    assert.equal(JSON.parse(exported.stdout).file, file)
    assert.ok((await stat(file)).size > 0)
    const imported = await run(process.execPath, [cli, 'import', '--file', file, '--json'], { env: cliEnv() })
    assert.equal(JSON.parse(imported.stdout).length, 1)
  })
})
