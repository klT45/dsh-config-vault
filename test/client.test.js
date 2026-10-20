import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import vm from 'node:vm'

const CLIENT_PATH = join(import.meta.dirname, '..', 'client.js')

/**
 * Evaluate client.js in a sandbox with a fake module-loader facade and a fake
 * React, then return the registered factory result. This checks the real
 * browser contract (facade registration, CJS factory, exports shape) without a
 * browser or a React renderer.
 */
async function loadClient() {
  const source = await readFile(CLIENT_PATH, 'utf8')
  /** @type {any} */
  let registration
  const fakeReact = {
    createElement: (...args) => ({ element: true, args }),
    createContext: value => ({ value }),
    useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useCallback: callback => callback,
    useMemo: factory => factory(),
    useRef: initial => ({ current: initial }),
  }
  const window = {
    __ModuleLoader__: {
      load(value) {
        registration = value
      },
    },
  }
  const document = {
    baseURI: 'http://127.0.0.1:64200/',
    body: { appendChild: () => {}, removeChild: () => {} },
    createElement: () => ({ click: () => {}, remove: () => {}, set href(value) {}, set download(value) {} }),
  }
  const sandbox = { window, document, console, URL, Blob: class {}, setTimeout, fetch: () => { throw new Error('fetch not expected') } }
  vm.runInNewContext(source, sandbox, { filename: 'client.js' })
  assert.ok(registration, 'client.js registers a module with the loader facade')
  assert.equal(registration.id, 'dsh-config-vault', 'module id must equal the loader entry/package name')
  const exportsValue = registration.factory(name => {
    assert.equal(name, 'react')
    return fakeReact
  })
  return { registration, exportsValue }
}

/**
 * Flatten a fake React element tree into its text content.
 * @param {any} node
 * @returns {string}
 */
function textOf(node) {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'object' && node.element === true) {
    // args = [type, props, ...children]
    return node.args.slice(2).map(textOf).join('')
  }
  return ''
}

describe('client bundle contract', () => {
  it('registers the loader module id and a CJS factory', async () => {
    const { registration, exportsValue } = await loadClient()
    assert.equal(typeof registration.factory, 'function')
    assert.equal(typeof exportsValue.apply, 'function')
    assert.deepEqual([...exportsValue.inject], ['slots'])
    assert.equal(exportsValue.__test.COPY.nav, '配置保险箱')
    assert.equal(exportsValue.__test.formatBytes(2048), '2.0 KiB')
    assert.equal(exportsValue.__test.formatBytes(512), '512 B')
    assert.equal(exportsValue.__test.statusLabel('removed'), '缺失')
  })

  it('renders the panel and the diff/plan views without a react renderer', async () => {
    const { exportsValue } = await loadClient()
    const test = exportsValue.__test

    // Calling a function component with stub hooks executes its body: this
    // catches runtime errors in the panel/diff/plan render paths.
    const panel = test.VaultPanel()
    assert.equal(panel.element, true)
    assert.ok(textOf(panel).includes('配置保险箱'))
    assert.ok(textOf(panel).includes('还没有快照'))

    const diff = test.DiffView({
      diff: {
        files: [{
          path: 'home/profiles/desktop/cordis.patch.yml',
          scope: 'settings',
          status: 'changed',
          secret: false,
          binary: false,
          truncated: false,
          hunks: [{
            lines: [
              { type: 'context', text: 'model:' },
              { type: 'add', text: '  value: new' },
              { type: 'remove', text: '  value: old' },
            ],
          }],
        }],
      },
    })
    const diffText = textOf(diff)
    assert.ok(diffText.includes('修改'))
    assert.ok(diffText.includes('+  value: new'))
    assert.ok(diffText.includes('-  value: old'))
    assert.ok(diffText.includes(' cordis.patch.yml'.trim()))

    const plan = test.PlanView({
      plan: {
        counts: { create: 1, overwrite: 2, unchanged: 3, extra: 1 },
        restartRequired: true,
        warnings: ['工作区列表需要在 DSH 停止时恢复'],
        operations: [
          { path: 'home/storages/workspace.json', action: 'overwrite' },
          { path: 'home/profiles/x/cordis.patch.yml', action: 'unchanged' },
        ],
        extra: [{ path: 'home/profiles/x/pnpm-workspace.yaml' }],
      },
    })
    const planText = textOf(plan)
    assert.ok(planText.includes('恢复预演'))
    assert.ok(planText.includes('新增 1'))
    assert.ok(planText.includes('工作区列表需要在 DSH 停止时恢复'))
    assert.ok(planText.includes('home/storages/workspace.json'))
    assert.ok(!planText.includes('cordis.patch.yml'), 'unchanged files are not listed as operations')
  })

  it('registers one settings.section with a stable render function', async () => {
    const { exportsValue } = await loadClient()
    /** @type {any[]} */
    const injections = []
    /** @type {any[]} */
    const registrations = []
    const slots = {
      inject(name, callback) {
        injections.push(name)
        callback()
      },
      register(definition, render) {
        registrations.push({ definition, render })
        return () => {}
      },
    }
    const ctx = { get: name => (name === 'slots' ? slots : undefined) }
    exportsValue.apply(ctx)
    assert.deepEqual(injections, ['settings.section'])
    assert.equal(registrations.length, 1)
    const { definition, render } = registrations[0]
    assert.equal(definition.name, 'settings.section')
    assert.equal(definition.id, 'config-vault')
    assert.equal(definition.label, '配置保险箱')
    assert.equal(typeof definition.order, 'number')
    assert.equal(typeof render, 'function')
    const element = render()
    assert.equal(element.element, true, 'render returns a React element')
  })

  it('does not throw when the slots service is absent', async () => {
    const { exportsValue } = await loadClient()
    const warnings = []
    const originalWarn = console.warn
    console.warn = (...args) => warnings.push(args.join(' '))
    try {
      exportsValue.apply({ get: () => undefined })
    } finally {
      console.warn = originalWarn
    }
    assert.ok(warnings.some(line => line.includes('slots')))
  })
})
