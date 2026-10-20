/**
 * Shared fixtures for the core and host tests.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import assert from 'node:assert/strict'

/** Minimal but realistic DSH patch file. */
export const SAMPLE_PATCH = [
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

/**
 * Populate a miniature DSH home plus shared agents home.
 * @param {string} home
 * @param {string} agentsHome
 */
export async function makeHome(home, agentsHome) {
  const pkg = JSON.stringify({
    name: 'dsh-profile-desktop',
    private: true,
    dependencies: { dshmarket: '1.66.44' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dshmarket', 'dsh-config-vault'] } },
  }, null, 2)
  await mkdir(join(home, 'profiles', 'desktop'), { recursive: true })
  await writeFile(join(home, 'profiles', 'desktop', 'cordis.patch.yml'), SAMPLE_PATCH)
  await writeFile(join(home, 'profiles', 'desktop', 'package.json'), pkg)
  await writeFile(join(home, 'profiles', 'desktop', 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
  await mkdir(join(home, 'plugins', 'dsh-fs-encoding'), { recursive: true })
  await writeFile(join(home, 'plugins', 'dsh-fs-encoding', 'config.yaml'), 'autoGuessEncoding: false\n')
  await mkdir(join(home, 'storages'), { recursive: true })
  await writeFile(join(home, 'storages', 'workspace.json'), JSON.stringify({ workspaces: [{ path: 'C:/work' }] }))
  await writeFile(join(home, '.credentials.yaml'), 'deepseek: sk-live-credential-abcdef123456\n')
  await writeFile(join(home, 'profiles', 'desktop', 'cordis.patch.yml.bak-123'), '- id: stale\n')
  await writeFile(join(home, 'update.log'), 'noise\n')

  await mkdir(join(agentsHome, 'skills', 'my-skill'), { recursive: true })
  await writeFile(join(agentsHome, 'skills', 'my-skill', 'SKILL.md'), '# my skill\n')
  await mkdir(join(agentsHome, 'skills', 'my-skill', '.venv', 'lib'), { recursive: true })
  await writeFile(join(agentsHome, 'skills', 'my-skill', '.venv', 'lib', 'huge.py'), 'x'.repeat(1000))
  await writeFile(join(agentsHome, 'AGENTS.md'), '# rules\n')
}

/**
 * Fake Cordis host context with the pieces the plugin touches: webserver
 * routes, tools, effects, lazy injection and a logger.
 * @param {{ remoteAddress?: string, host?: string }} [options]
 */
export function fakeContext(options = {}) {
  /** @type {Array<{ kind: string, path: string, handler: Function }>} */
  const routes = []
  /** @type {Array<object>} */
  const tools = []
  /** @type {Array<() => void>} */
  const effects = []
  /** @type {string[]} */
  const logs = []
  const remoteAddress = options.remoteAddress ?? '127.0.0.1'
  const host = options.host ?? '127.0.0.1:64200'

  const fakeTools = {
    register(definition) {
      tools.push(definition)
      return () => {
        const index = tools.indexOf(definition)
        if (index >= 0) tools.splice(index, 1)
      }
    },
  }

  const ctx = {
    logger: {
      info: (...args) => logs.push(args.map(String).join(' ')),
      warn: (...args) => logs.push(args.map(String).join(' ')),
    },
    webServer: {
      register(route) {
        routes.push(route)
        return () => {
          const index = routes.indexOf(route)
          if (index >= 0) routes.splice(index, 1)
        }
      },
    },
    effect(body) {
      const disposer = body()
      if (typeof disposer === 'function') effects.push(disposer)
      return disposer
    },
    inject(deps, callback) {
      assert.deepEqual(deps, ['tools'])
      /** @type {Array<() => void>} */
      const childDisposers = []
      const childCtx = {
        tools: fakeTools,
        logger: ctx.logger,
        effect(body) {
          const disposer = body()
          if (typeof disposer === 'function') childDisposers.push(disposer)
        },
      }
      callback(childCtx)
      const fiber = {
        dispose() {
          while (childDisposers.length > 0) childDisposers.pop()()
        },
      }
      effects.push(() => fiber.dispose())
      return fiber
    },
    dispose() {
      while (effects.length > 0) effects.pop()()
    },
  }

  /**
   * Call one registered route with a request body and headers.
   * @param {string} path
   * @param {object} [body]
   * @param {{ method?: string, headers?: Record<string, string>, remoteAddress?: string, rawBody?: string }} [invokeOptions]
   */
  async function call(path, body = {}, invokeOptions = {}) {
    const route = routes.find(candidate => candidate.path === path)
    if (route === undefined) throw new Error(`no route ${path} (have ${routes.map(item => item.path).join(', ')})`)
    const method = invokeOptions.method ?? 'POST'
    const headers = {
      host,
      'content-type': 'application/json',
      origin: `http://${host}`,
      ...invokeOptions.headers,
    }
    const rawBody = invokeOptions.rawBody ?? (body === undefined ? '' : JSON.stringify(body))
    const chunks = rawBody === '' ? [] : [Buffer.from(rawBody)]
    const request = {
      method,
      headers,
      socket: { remoteAddress: invokeOptions.remoteAddress ?? remoteAddress },
      async *[Symbol.asyncIterator]() {
        for (const chunk of chunks) yield chunk
      },
    }
    let status = 0
    let responseBody = ''
    /** @type {Record<string, string|number>} */
    let responseHeaders = {}
    const response = {
      writeHead(code, hdrs = {}) {
        status = code
        responseHeaders = hdrs
      },
      end(chunk = '') {
        responseBody += chunk
      },
    }
    await route.handler(request, response)
    let parsed
    try {
      parsed = JSON.parse(responseBody)
    } catch {
      parsed = undefined
    }
    return { status, headers: responseHeaders, body: responseBody, json: parsed }
  }

  return { ctx, routes, tools, effects, logs, call }
}
