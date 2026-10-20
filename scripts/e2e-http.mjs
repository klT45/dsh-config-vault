#!/usr/bin/env node
/**
 * End-to-end HTTP check against a *running* isolated DSH instance serving the
 * config-vault plugin. This is the real-host verification: it exercises the
 * same routes the browser half calls, including UTF-8, diff, restore, safety
 * snapshot, export/import and the credential passphrase gate.
 *
 * Usage:
 *   node scripts/e2e-http.mjs http://127.0.0.1:PORT
 *
 * The instance must use an isolated DSH_HOME (never the live ~/.dsh): the
 * script edits and restores that home's profile patch.
 */

import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const base = process.argv[2]
if (base === undefined) {
  console.error('usage: node scripts/e2e-http.mjs http://127.0.0.1:PORT')
  process.exit(2)
}

/**
 * Call one vault action.
 * @param {string} action
 * @param {object} [payload]
 */
async function call(action, payload = {}) {
  const response = await fetch(`${base}/config-vault/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const envelope = await response.json()
  return envelope
}

/** @param {string} action @param {object} [payload] */
async function expectOk(action, payload) {
  const envelope = await call(action, payload)
  assert.equal(envelope.ok, true, `${action} failed: ${JSON.stringify(envelope.error)}`)
  return envelope.value
}

/** @param {string} step */
function step(message) {
  console.log(`  ✓ ${message}`)
}

console.log(`config-vault e2e against ${base}`)

// 0. Readiness: the web server may accept connections a moment before the
// plugin's routes are mounted, so poll status instead of assuming.
let status
for (let attempt = 0; attempt < 40; attempt += 1) {
  try {
    const envelope = await call('status')
    if (envelope.ok === true) {
      status = envelope.value
      break
    }
  } catch {
    // not up yet (empty response / connection refused)
  }
  await new Promise(resolve => setTimeout(resolve, 500))
}
assert.ok(status !== undefined, 'config-vault routes did not become ready within 20s')

// 1. Status: the routes are up, the home is the isolated one, scopes exist.
assert.ok(status.home.length > 0)
assert.ok(status.scopes.some(scope => scope.id === 'credentials' && scope.defaultOn === false))
assert.ok(status.scopes.some(scope => scope.id === 'settings'))
step(`status: home=${status.home} profile=${status.profile} scopes=${status.scopes.length}`)

// 2. Create a snapshot with a Chinese name (UTF-8 round trip through JSON).
const created = await expectOk('snapshot', { name: '中文快照 ✓', scopes: ['settings', 'plugins', 'workspaces'] })
const snapshot = created.snapshot
assert.equal(snapshot.name, '中文快照 ✓')
assert.ok(snapshot.files > 0)
step(`snapshot ${snapshot.id} (${snapshot.files} files, ${snapshot.bytes} bytes)`)

// 3. Tamper with the live profile patch, then diff must see it.
const patchPath = join(status.home, 'profiles', status.profile, 'cordis.patch.yml')
const original = await readFile(patchPath, 'utf8')
await writeFile(patchPath, `${original}\n# e2e tamper\n`)
const diff = await expectOk('diff', { id: snapshot.id })
const changed = diff.diff.files.find(file => file.status === 'changed')
assert.ok(changed !== undefined, 'diff reports the tampered patch as changed')
assert.ok(changed.hunks.length > 0)
step(`diff: ${diff.diff.files.length} file(s) differ, ${changed.path}`)

// 4. Plan must promise an overwrite, and restore must roll the file back.
const plan = await expectOk('plan', { id: snapshot.id })
assert.ok(plan.plan.counts.overwrite >= 1)
assert.equal(await readFile(patchPath, 'utf8'), `${original}\n# e2e tamper\n`)
const restored = await expectOk('restore', { id: snapshot.id })
assert.ok(restored.restore.restored.length >= 1)
assert.ok(restored.restore.safetySnapshotId)
assert.equal(await readFile(patchPath, 'utf8'), original)
step(`restore: ${restored.restore.restored.length} file(s) restored, safety=${restored.restore.safetySnapshotId}`)

// 5. Export/import round trip keeps the snapshot and its name; same-home import gets a new id.
const exported = await expectOk('export', { ids: [snapshot.id] })
assert.equal(exported.encrypted, false)
assert.match(exported.filename, /^dsh-config-vault-\d{8}-\d{4}\.json$/)
const imported = await expectOk('import', { content: exported.content })
assert.equal(imported.imported.length, 1)
assert.equal(imported.imported[0].name, '中文快照 ✓')
assert.notEqual(imported.imported[0].id, snapshot.id)
step(`export/import: ${exported.filename} (${exported.bytes} bytes) -> ${imported.imported[0].id}`)

// 6. Credentials are opt-in, and a credential-bearing export requires a passphrase.
const secretSnapshot = await expectOk('snapshot', {
  name: '含凭据快照',
  scopes: ['settings', 'credentials'],
  includeSecrets: true,
})
assert.equal(secretSnapshot.snapshot.hasCredentials, true)
const needsPassphrase = await call('export', { ids: [secretSnapshot.snapshot.id] })
assert.equal(needsPassphrase.ok, false)
assert.equal(needsPassphrase.error.code, 'passphrase-required')
const encrypted = await expectOk('export', { ids: [secretSnapshot.snapshot.id], passphrase: 'e2e-passphrase' })
assert.equal(encrypted.encrypted, true)
assert.ok(!encrypted.content.includes(Buffer.from('deepseek').toString('base64')), 'ciphertext does not leak the credential document')
const decrypted = await expectOk('import', { content: encrypted.content, passphrase: 'e2e-passphrase' })
assert.equal(decrypted.imported[0].hasCredentials, true)
step(`credentials: passphrase gate enforced, encrypted bundle imported as ${decrypted.imported[0].id}`)

// 7. List and remove: listing is newest first and removal frees the id.
const listed = await expectOk('list', {})
assert.ok(listed.snapshots.length >= 4)
const removed = await expectOk('remove', { id: imported.imported[0].id })
assert.equal(removed.removed, imported.imported[0].id)
step(`list/remove: ${listed.snapshots.length} snapshots, removed ${removed.removed}`)

console.log('e2e: all assertions passed')
