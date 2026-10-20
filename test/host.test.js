import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { apply } from '../src/index.js'
import { Config, resolveConfiguration } from '../src/host/config.js'
import { makeHome, fakeContext } from './helpers.js'

/** @type {string} */
let home
/** @type {string} */
let agentsHome

/**
 * Mount the plugin against a fake host context with an isolated home.
 * @param {object} [config]
 */
async function mount(config = {}) {
  const fake = fakeContext()
  apply(fake.ctx, {
    routePrefix: '/config-vault',
    home,
    agentsHome,
    ...config,
  })
  /** @param {string} action */
  const call = (action, payload = {}, options = {}) => fake.call(`/config-vault/${action}`, payload, options)
  return { ...fake, call }
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'dsh-vault-host-'))
  agentsHome = await mkdtemp(join(tmpdir(), 'dsh-vault-host-agents-'))
  await makeHome(home, agentsHome)
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
  await rm(agentsHome, { recursive: true, force: true })
})

describe('plugin config', () => {
  it('validates through the Standard Schema facade', () => {
    const valid = Config['~standard'].validate({ routePrefix: '/vault', keepAuto: 3 })
    assert.equal(valid.value.routePrefix, '/vault')
    assert.equal(valid.value.keepAuto, 3)
    assert.equal(valid.value.includeCredentials, false)

    const bad = Config['~standard'].validate({ routePrefix: 'vault/' })
    assert.ok(bad.issues.length > 0)
    assert.equal(bad.issues[0].path[0], 'routePrefix')
    assert.ok(Config['~standard'].validate({ keepManual: -1 }).issues.length > 0)
    assert.equal(resolveConfiguration(undefined).keepManual, 30)
    assert.throws(() => resolveConfiguration({ routePrefix: 'nope' }), /invalid configuration/)
  })
})

describe('host routes', () => {
  it('registers status/list/snapshot/diff/plan/restore/export/import/remove/prune', async () => {
    const mounted = await mount()
    const paths = mounted.routes.map(route => route.path).sort()
    assert.deepEqual(paths, [
      '/config-vault/diff', '/config-vault/export', '/config-vault/import', '/config-vault/list',
      '/config-vault/plan', '/config-vault/prune', '/config-vault/remove', '/config-vault/restore',
      '/config-vault/snapshot', '/config-vault/status',
    ])
    assert.ok(mounted.routes.every(route => route.kind === 'exact'))
    assert.equal(mounted.tools.length, 1)
    assert.equal(mounted.tools[0].name, 'config_vault')
    mounted.ctx.dispose()
    assert.equal(mounted.routes.length, 0, 'disposal removes every route')
    assert.equal(mounted.tools.length, 0, 'disposal removes the tool')
  })

  it('enforces the loopback fence, method and content type', async () => {
    const mounted = await mount()
    assert.equal((await mounted.call('status', {}, { remoteAddress: '192.168.1.5' })).status, 403)
    assert.equal((await mounted.call('status', {}, { headers: { 'x-forwarded-for': '1.2.3.4' } })).status, 403)
    assert.equal((await mounted.call('status', {}, { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403)
    assert.equal((await mounted.call('status', {}, { headers: { origin: 'http://evil.example' } })).status, 403)
    assert.equal((await mounted.call('status', {}, { method: 'GET' })).status, 405)
    assert.equal((await mounted.call('status', {}, { headers: { 'content-type': 'text/plain' } })).status, 415)
    const normal = await mounted.call('status')
    assert.equal(normal.status, 200)
    assert.equal(normal.json.ok, true)
  })

  it('creates, lists, diffs, plans and restores through HTTP', async () => {
    const mounted = await mount()
    const created = await mounted.call('snapshot', { name: '基线', scopes: ['settings', 'plugins', 'workspaces'] })
    assert.equal(created.status, 200)
    assert.equal(created.json.ok, true)
    const manifest = created.json.value.snapshot
    assert.equal(manifest.name, '基线')
    assert.ok(manifest.files > 0)

    const listed = await mounted.call('list', {})
    assert.equal(listed.json.value.snapshots[0].id, manifest.id)

    const patchPath = join(home, 'profiles', 'desktop', 'cordis.patch.yml')
    await writeFile(patchPath, '# broken by a bad edit\n')
    const diff = await mounted.call('diff', { id: manifest.id })
    assert.equal(diff.json.ok, true)
    assert.ok(diff.json.value.diff.files.some(file => file.path === 'home/profiles/desktop/cordis.patch.yml' && file.status === 'changed'))

    const plan = await mounted.call('plan', { id: manifest.id })
    assert.equal(plan.json.value.plan.counts.overwrite, 1)
    assert.equal(plan.json.value.plan.restartRequired, true)

    const restored = await mounted.call('restore', { id: manifest.id })
    assert.equal(restored.json.ok, true)
    assert.equal(restored.json.value.restore.restored.length, 1)
    assert.ok(restored.json.value.restore.safetySnapshotId)
    assert.match(await readFile(patchPath, 'utf8'), /llm-pi-ai/)
  })

  it('exports to the browser and imports the same bundle back', async () => {
    const mounted = await mount()
    const created = await mounted.call('snapshot', { name: '导出用' })
    const id = created.json.value.snapshot.id
    const exported = await mounted.call('export', { ids: [id] })
    assert.equal(exported.json.ok, true)
    assert.match(exported.json.value.filename, /^dsh-config-vault-\d{8}-\d{4}\.json$/)
    assert.equal(exported.json.value.encrypted, false)
    const content = exported.json.value.content
    assert.ok(content.includes('dsh-config-vault-bundle'))

    const imported = await mounted.call('import', { content })
    assert.equal(imported.json.ok, true)
    assert.equal(imported.json.value.imported.length, 1)
    assert.notEqual(imported.json.value.imported[0].id, id, 'same-home import gets a distinct id')
    const listed = await mounted.call('list', {})
    assert.equal(listed.json.value.snapshots.length, 2)
  })

  it('reports errors in the envelope without leaking a stack', async () => {
    const mounted = await mount()
    const missing = await mounted.call('diff', { id: 'nope' })
    assert.equal(missing.json.ok, false)
    assert.equal(missing.json.error.code, 'snapshot-not-found')
    const badArgs = await mounted.call('snapshot', { scopes: 'settings' })
    assert.equal(badArgs.json.ok, false)
    assert.equal(badArgs.json.error.code, 'invalid-argument')
  })

  it('removes snapshots and prunes by kind', async () => {
    const mounted = await mount()
    const first = (await mounted.call('snapshot', { name: 'a' })).json.value.snapshot.id
    const second = (await mounted.call('snapshot', { name: 'b' })).json.value.snapshot.id
    assert.equal((await mounted.call('remove', { id: first })).json.ok, true)
    assert.equal((await mounted.call('list', {})).json.value.snapshots.length, 1)
    assert.equal((await mounted.call('prune', { keepManual: 1 })).json.ok, true)
    assert.equal((await mounted.call('list', {})).json.value.snapshots[0].id, second)
  })
})

describe('config_vault tool', () => {
  /** @param {Awaited<ReturnType<typeof mount>>} mounted */
  const toolOf = mounted => mounted.tools[0]

  it('exposes actions with a JSON schema and executes them', async () => {
    const mounted = await mount()
    const tool = toolOf(mounted)
    assert.equal(tool.parameters.required[0], 'action')
    assert.ok(tool.parameters.properties.action.enum.includes('restore'))
    assert.equal(typeof tool.execute, 'function')

    const status = await tool.execute({ action: 'status' })
    assert.equal(status.ok, true)
    assert.equal(status.home, home)
    assert.ok(status.scopes.some(scope => scope.id === 'settings'))

    const created = await tool.execute({ action: 'snapshot', name: '工具快照' })
    assert.equal(created.ok, true)
    const id = created.snapshot.id

    const listed = await tool.execute({ action: 'list' })
    assert.equal(listed.snapshots[0].id, id)

    const plan = await tool.execute({ action: 'plan', id })
    assert.equal(plan.ok, true)
    assert.ok(plan.plan.counts.unchanged > 0)

    const removed = await tool.execute({ action: 'remove', id })
    assert.equal(removed.ok, true)
    const unknown = await tool.execute({ action: 'explode' })
    assert.equal(unknown.ok, false)
    assert.equal(unknown.code, 'unknown-action')
  })

  it('renders a JSON text block and reports export files', async () => {
    const mounted = await mount()
    const tool = toolOf(mounted)
    const created = await tool.execute({ action: 'snapshot', name: 'exportable' })
    const file = join(home, 'config-vault', 'exports', 'test.json')
    const exported = await tool.execute({ action: 'export', ids: [created.snapshot.id], file })
    assert.equal(exported.ok, true)
    assert.equal(exported.file, file)
    assert.ok(exported.bytes > 0)
    assert.match(await readFile(file, 'utf8'), /dsh-config-vault-bundle/)
    const rendered = tool.output.render({ action: 'export' }, exported)
    assert.equal(rendered[0].type, 'text')
    assert.equal(JSON.parse(rendered[0].text).file, file)
  })
})
