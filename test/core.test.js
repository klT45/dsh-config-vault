import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import {
  applyRestore, buildBundle, createSnapshot, createVault, decodeBundle, diffSnapshotVsCurrent,
  fromLogicalPath, importBundle, listSnapshots, loadManifest, maskText, planRestore,
  pruneSnapshots, readSnapshotFile, resolveDshHome, resolveRoots, resolveScopes,
  toLogicalPath, containsSecret,
} from '../src/core/index.js'

/** @type {string} */
let home
/** @type {string} */
let agentsHome

/**
 * Vault context for the fixture home.
 * @returns {{ home: string, agentsHome: string }}
 */
function ctx() {
  return { home, agentsHome }
}

/**
 * Build a realistic miniature DSH home + agents home.
 * @param {string} root
 * @param {string} agents
 */
async function makeHome(root, agents) {
  const patch = [
    '# dsh patch',
    '- id: agent-default-model',
    '  name: "@deepseek-ai/dsh-agent-default-model"',
    '  config:',
    '    provider: goujia',
    '    model: deepseek-v4.1-flash',
    '- id: llm-pi-ai',
    '  name: "@deepseek-ai/dsh-llm-pi-ai"',
    '  config:',
    '    providers:',
    '      goujia:',
    '        apiKeyEnv: GOUJIA_API_KEY',
    '        baseURL: https://api.gojia.cloud/v1',
    '        apiKey: sk-secret-value-1234567890',
    '',
  ].join('\n')
  const pkg = JSON.stringify({
    name: 'dsh-profile-desktop',
    private: true,
    dependencies: { dshmarket: '1.66.44' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dshmarket'] } },
  }, null, 2)
  await mkdir(join(root, 'profiles', 'desktop'), { recursive: true })
  await writeFile(join(root, 'profiles', 'desktop', 'cordis.patch.yml'), patch)
  await writeFile(join(root, 'profiles', 'desktop', 'package.json'), pkg)
  await writeFile(join(root, 'profiles', 'desktop', 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
  await mkdir(join(root, 'plugins', 'dsh-fs-encoding'), { recursive: true })
  await writeFile(join(root, 'plugins', 'dsh-fs-encoding', 'config.yaml'), 'autoGuessEncoding: false\n')
  await mkdir(join(root, 'storages'), { recursive: true })
  await writeFile(join(root, 'storages', 'workspace.json'), JSON.stringify({ workspaces: [{ path: 'C:/work' }] }))
  await writeFile(join(root, '.credentials.yaml'), 'deepseek: sk-live-credential-abcdef123456\n')
  // Clutter that must never enter a snapshot.
  await writeFile(join(root, 'profiles', 'desktop', 'cordis.patch.yml.bak-123'), '- id: stale\n')
  await writeFile(join(root, 'update.log'), 'noise\n')

  // Shared agents home: a skill plus heavy directories that must be skipped.
  await mkdir(join(agents, 'skills', 'my-skill'), { recursive: true })
  await writeFile(join(agents, 'skills', 'my-skill', 'SKILL.md'), '# my skill\n')
  await mkdir(join(agents, 'skills', 'my-skill', '.venv', 'lib'), { recursive: true })
  await writeFile(join(agents, 'skills', 'my-skill', '.venv', 'lib', 'huge.py'), 'x'.repeat(1000))
  await writeFile(join(agents, 'AGENTS.md'), '# rules\n')
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'dsh-vault-test-'))
  agentsHome = await mkdtemp(join(tmpdir(), 'dsh-vault-agents-'))
  await makeHome(home, agentsHome)
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
  await rm(agentsHome, { recursive: true, force: true })
})

describe('paths and scopes', () => {
  it('resolves the home with documented precedence', () => {
    assert.equal(resolveDshHome({ env: { DSH_HOME: home }, explicit: undefined }), home)
    assert.equal(resolveDshHome({ env: { DSH_HOME: '' }, explicit: home }), home)
    assert.equal(resolveDshHome({ env: { DSH_HOME: '' }, explicit: '' }), join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh'))
  })

  it('resolves default scopes and rejects unknown ids quietly', () => {
    const { scopes, unknown } = resolveScopes(['settings', 'plugins', 'nope'])
    assert.deepEqual(scopes.map(scope => scope.id), ['settings', 'plugins'])
    assert.deepEqual(unknown, ['nope'])
    const defaults = resolveScopes(undefined)
    assert.ok(defaults.scopes.every(scope => scope.defaultOn))
    assert.ok(!defaults.scopes.some(scope => scope.id === 'credentials'))
    assert.ok(defaults.scopes.some(scope => scope.id === 'skills'))
  })

  it('maps logical paths safely across roots', () => {
    const roots = resolveRoots({ home, agentsHome })
    assert.equal(fromLogicalPath(roots, 'home/profiles/desktop/cordis.patch.yml'), join(home, 'profiles', 'desktop', 'cordis.patch.yml'))
    assert.equal(fromLogicalPath(roots, 'agents/skills/my-skill/SKILL.md'), join(agentsHome, 'skills', 'my-skill', 'SKILL.md'))
    assert.equal(toLogicalPath(roots, join(home, 'a', 'b.txt')), 'home/a/b.txt')
    assert.equal(toLogicalPath(roots, join(agentsHome, 'skills', 's', 'SKILL.md')), 'agents/skills/s/SKILL.md')
    assert.throws(() => fromLogicalPath(roots, 'home/../escape.txt'), /unsafe|escape/)
    assert.throws(() => fromLogicalPath(roots, 'home//etc/passwd'), /unsafe|absolute/)
    assert.throws(() => fromLogicalPath(roots, 'elsewhere/x'), /unknown root/)
    assert.throws(() => fromLogicalPath(roots, '/etc/passwd'), /absolute|unknown root/)
  })
})

describe('snapshot', () => {
  it('captures default scopes, excludes credentials and clutter', async () => {
    const manifest = await createSnapshot(ctx(), { name: '第一次' })
    assert.equal(manifest.kind, 'manual')
    const paths = manifest.files.map(file => file.path)
    assert.ok(paths.includes('home/profiles/desktop/cordis.patch.yml'))
    assert.ok(paths.includes('home/profiles/desktop/package.json'))
    assert.ok(paths.includes('home/storages/workspace.json'))
    assert.ok(paths.includes('agents/skills/my-skill/SKILL.md'))
    assert.ok(paths.includes('agents/AGENTS.md'))
    assert.ok(!paths.some(path => path.includes('credentials')), 'credentials excluded by default')
    assert.ok(!paths.some(path => path.includes('.venv')), 'virtual environments skipped in skills')
    assert.ok(!paths.some(path => path.includes('.bak-')), 'backup files excluded')
    assert.ok(!paths.includes('home/update.log'), 'logs excluded')
    assert.ok(manifest.warnings.some(warning => warning.includes('凭据文件')), 'credential exclusion is reported')
    const patchEntry = manifest.files.find(file => file.path.endsWith('cordis.patch.yml'))
    assert.equal(patchEntry.secret, true, 'inline key marks the file secret-bearing')
    const payload = await readSnapshotFile(ctx(), manifest, 'home/profiles/desktop/cordis.patch.yml')
    assert.match(payload.toString('utf8'), /sk-secret-value-1234567890/, 'payload keeps original bytes')
  })

  it('can include secret-scoped files on request', async () => {
    const manifest = await createSnapshot(ctx(), { includeSecrets: true, scopes: ['settings', 'credentials'] })
    const paths = manifest.files.map(file => file.path)
    assert.ok(paths.includes('home/.credentials.yaml'))
    assert.equal(manifest.hasCredentials, true)
  })

  it('lists newest first and validates integrity', async () => {
    const older = await createSnapshot(ctx(), { name: 'old', now: new Date('2026-01-01T00:00:00Z') })
    const newer = await createSnapshot(ctx(), { name: 'new', now: new Date('2026-02-01T00:00:00Z') })
    const { snapshots } = await listSnapshots(ctx())
    assert.deepEqual(snapshots.map(snapshot => snapshot.id), [newer.id, older.id])
    assert.equal((await loadManifest(ctx(), older.id)).name, 'old')

    // Tamper with one payload byte: reads must refuse.
    const target = join(home, 'config-vault', 'snapshots', older.id, 'payload', 'home', 'profiles', 'desktop', 'package.json')
    await writeFile(target, '{"tampered":true}')
    const tamperedManifest = await loadManifest(ctx(), older.id)
    await assert.rejects(() => readSnapshotFile(ctx(), tamperedManifest, 'home/profiles/desktop/package.json'), /integrity/i)
  })

  it('prunes by kind while protecting one id', async () => {
    for (let index = 0; index < 3; index += 1) {
      await createSnapshot(ctx(), { kind: 'auto', name: `auto-${index}`, now: new Date(Date.UTC(2026, 0, index + 1)) })
    }
    const autos = (await listSnapshots(ctx(), { kind: 'auto' })).snapshots
    const result = await pruneSnapshots(ctx(), { keepAuto: 1, protectId: autos[2].id })
    assert.equal(result.deleted.length, 1)
    assert.ok((await listSnapshots(ctx(), { kind: 'auto' })).snapshots.some(snapshot => snapshot.id === autos[2].id))
  })
})

describe('diff', () => {
  it('reports added, changed and removed files and masks secrets', async () => {
    const manifest = await createSnapshot(ctx())
    const patchPath = join(home, 'profiles', 'desktop', 'cordis.patch.yml')
    const original = await readFile(patchPath, 'utf8')
    await writeFile(patchPath, original.replace('deepseek-v4.1-flash', 'gpt-6-astra').replace('sk-secret-value-1234567890', 'sk-rotated-value-0987654321'))
    await writeFile(join(home, 'storages', 'workspace.json'), JSON.stringify({ workspaces: [{ path: 'C:/other' }] }))
    await rm(join(home, 'plugins', 'dsh-fs-encoding', 'config.yaml'))

    const diff = await diffSnapshotVsCurrent(ctx(), manifest.id)
    const byPath = new Map(diff.files.map(file => [file.path, file]))
    assert.equal(byPath.get('home/profiles/desktop/cordis.patch.yml').status, 'changed')
    assert.equal(byPath.get('home/storages/workspace.json').status, 'changed')
    assert.equal(byPath.get('home/plugins/dsh-fs-encoding/config.yaml').status, 'removed')

    // Added and removed files carry a whole-file hunk rather than a bare label.
    await writeFile(join(home, 'profiles', 'desktop', 'settings.yaml'), 'locale:\n  preference: zh\n')
    const diff2 = await diffSnapshotVsCurrent(ctx(), manifest.id)
    const added = diff2.files.find(file => file.path === 'home/profiles/desktop/settings.yaml')
    assert.equal(added.status, 'added')
    assert.ok(added.hunks.length > 0)
    assert.ok(added.hunks[0].lines.every(line => line.type === 'add'))
    const removed = diff2.files.find(file => file.path === 'home/plugins/dsh-fs-encoding/config.yaml')
    assert.ok(removed.hunks.length > 0)
    assert.ok(removed.hunks[0].lines.every(line => line.type === 'remove'))

    const patchDiff = byPath.get('home/profiles/desktop/cordis.patch.yml')
    const displayed = patchDiff.hunks.flatMap(hunk => hunk.lines.map(line => line.text)).join('\n')
    assert.ok(displayed.includes('gpt-6-astra'), 'non-secret change is visible')
    assert.ok(!displayed.includes('sk-rotated-value-0987654321'), 'secret value is masked in display')
    assert.ok(displayed.includes('••••••'), 'mask marker present')
    const jsonDiff = byPath.get('home/storages/workspace.json')
    assert.ok(Array.isArray(jsonDiff.jsonPaths) && jsonDiff.jsonPaths.length > 0, 'JSON structural paths are reported')
  })
})

describe('restore', () => {
  it('plans and applies a restore, taking a safety snapshot and never deleting extras', async () => {
    const manifest = await createSnapshot(ctx(), { name: 'baseline' })
    const patchPath = join(home, 'profiles', 'desktop', 'cordis.patch.yml')
    const baseline = await readFile(patchPath)
    await writeFile(patchPath, '# broken\n')
    await writeFile(join(home, 'profiles', 'desktop', 'package.json'), JSON.stringify({ name: 'broken' }))
    await writeFile(join(home, 'plugins', 'dsh-fs-encoding', 'config.yaml'), 'autoGuessEncoding: true\n')
    await writeFile(join(home, 'profiles', 'desktop', 'pnpm-workspace.yaml'), 'packages:\n  - .\n')
    await rm(join(home, 'plugins', 'dsh-fs-encoding', 'config.yaml'))

    const plan = await planRestore(ctx(), manifest.id)
    assert.equal(plan.counts.overwrite, 2)
    assert.equal(plan.counts.create, 1)
    assert.ok(plan.extra.some(entry => entry.path === 'home/profiles/desktop/pnpm-workspace.yaml'))
    assert.equal(plan.restartRequired, true)

    const result = await applyRestore(ctx(), manifest.id)
    assert.equal(result.restored.length, 3)
    assert.ok(result.safetySnapshotId)
    assert.deepEqual(await readFile(patchPath), baseline)
    assert.equal(JSON.parse(await readFile(join(home, 'profiles', 'desktop', 'package.json'), 'utf8')).name, 'dsh-profile-desktop')
    assert.equal(await readFile(join(home, 'plugins', 'dsh-fs-encoding', 'config.yaml'), 'utf8'), 'autoGuessEncoding: false\n')
    // The extra live file was reported and left alone.
    assert.equal(await readFile(join(home, 'profiles', 'desktop', 'pnpm-workspace.yaml'), 'utf8'), 'packages:\n  - .\n')
    // The safety snapshot shows what was live before the restore.
    const safety = await loadManifest(ctx(), result.safetySnapshotId)
    const safetyPatch = await readSnapshotFile(ctx(), safety, 'home/profiles/desktop/cordis.patch.yml')
    assert.equal(safetyPatch.toString('utf8'), '# broken\n')
  })

  it('restores a subset of scopes only', async () => {
    const manifest = await createSnapshot(ctx())
    await writeFile(join(home, 'storages', 'workspace.json'), '{"workspaces":[]}')
    await writeFile(join(home, 'profiles', 'desktop', 'package.json'), '{"name":"broken"}')
    const result = await applyRestore(ctx(), manifest.id, { scopes: ['workspaces'] })
    assert.equal(result.restored.length, 1)
    assert.equal(result.restored[0].path, 'home/storages/workspace.json')
    assert.equal(await readFile(join(home, 'profiles', 'desktop', 'package.json'), 'utf8'), '{"name":"broken"}', 'other scope untouched')
  })
})

describe('bundles', () => {
  it('round-trips an unencrypted bundle', async () => {
    const manifest = await createSnapshot(ctx(), { name: 'portable' })
    const bundle = await buildBundle(ctx(), [manifest.id])
    assert.equal(bundle.encrypted, false)
    const json = JSON.parse(JSON.stringify(bundle))
    const imported = await importBundle(ctx(), decodeBundle(json))
    assert.equal(imported.length, 1)
    const restoredManifest = await loadManifest(ctx(), imported[0].id)
    assert.equal(restoredManifest.name, 'portable')
    assert.notEqual(imported[0].id, manifest.id, 'import into the same home stays distinct')
    const data = await readSnapshotFile(ctx(), restoredManifest, 'home/profiles/desktop/cordis.patch.yml')
    assert.match(data.toString('utf8'), /dsh-llm-pi-ai/)
  })

  it('requires a passphrase to export credential-bearing snapshots', async () => {
    const manifest = await createSnapshot(ctx(), { includeSecrets: true, scopes: ['settings', 'credentials'] })
    await assert.rejects(() => buildBundle(ctx(), [manifest.id]), /口令/)
    const bundle = await buildBundle(ctx(), [manifest.id], { passphrase: 'correct horse' })
    assert.equal(bundle.encrypted, true)
    assert.ok(!JSON.stringify(bundle).includes('sk-live-credential'), 'ciphertext does not leak secrets')
    assert.throws(() => decodeBundle(JSON.parse(JSON.stringify(bundle)), { passphrase: 'wrong pass' }), /口令/)
    const imported = await importBundle(ctx(), decodeBundle(JSON.parse(JSON.stringify(bundle)), { passphrase: 'correct horse' }))
    assert.equal(imported.length, 1)
    const restored = await loadManifest(ctx(), imported[0].id)
    const credentials = await readSnapshotFile(ctx(), restored, 'home/.credentials.yaml')
    assert.match(credentials.toString('utf8'), /sk-live-credential/)
  })

  it('rejects tampered bundle payloads', async () => {
    const manifest = await createSnapshot(ctx())
    const bundle = JSON.parse(JSON.stringify(await buildBundle(ctx(), [manifest.id])))
    const path = 'home/profiles/desktop/cordis.patch.yml'
    bundle.snapshots[0].files[path] = Buffer.from('evil: true').toString('base64')
    await assert.rejects(() => importBundle(ctx(), decodeBundle(bundle)), /校验失败/)
  })
})

describe('secrets', () => {
  it('masks YAML keys and inline provider tokens', () => {
    const text = [
      'apiKey: sk-abcdefghijklmnopqrstuvwxyz',
      'baseURL: https://example.test/v1',
      'password: "hunter2"',
      'note: token ghp_abcdefghijklmnopqrstuvwxyz0123',
    ].join('\n')
    const masked = maskText(text)
    assert.ok(!masked.includes('sk-abcdefghijklmnopqrstuvwxyz'))
    assert.ok(!masked.includes('hunter2'))
    assert.ok(!masked.includes('ghp_abcdefghijklmnopqrstuvwxyz0123'))
    assert.ok(masked.includes('baseURL: https://example.test/v1'))
    assert.ok(containsSecret(text))
    assert.ok(!containsSecret('model: deepseek-v4.1-flash'))
  })
})

describe('vault handle', () => {
  it('binds every operation to one home', async () => {
    const vault = createVault({ home, agentsHome })
    const created = await vault.snapshot({ name: 'via handle' })
    const listed = await vault.list()
    assert.equal(listed.snapshots[0].id, created.id)
    const diff = await vault.diff(created.id)
    assert.deepEqual(diff.files, [])
    const plan = await vault.planRestore(created.id)
    assert.equal(plan.counts.unchanged > 0, true)
  })
})
