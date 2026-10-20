/**
 * dsh-config-vault — Host entry.
 *
 * A DSH plugin that snapshots the harness configuration (settings patches,
 * plugin manifest, skills/rules, workspace list, optionally credentials),
 * diffs a snapshot against the live configuration, and restores it after an
 * automatic safety snapshot. The browser half (`./client`) renders the same
 * actions as a Settings section; the model half is the `config_vault` tool.
 *
 * Everything is plain ESM with zero runtime dependencies, so the package can
 * be installed as-is: no build, no bundler, no TypeScript.
 */

import { createVault } from './core/index.js'
import { resolveConfiguration } from './host/config.js'
import { registerRoutes } from './host/routes.js'
import { buildTool } from './host/tool.js'

export { Config } from './host/config.js'
export { createVault } from './core/index.js'

/** Plugin name shown in the loader tree. */
export const name = 'dsh-config-vault'

/** The HTTP routes need the host webserver; without it the plugin waits. */
export const inject = ['webServer']

/** Route prefix used when no config overrides it (kept for diagnostics). */
export { DEFAULT_ROUTE_PREFIX } from './host/config.js'

/**
 * Mount routes, the model tool and the vault handle.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {unknown} config row config validated by the Loader
 */
export function apply(ctx, config) {
  const settings = resolveConfiguration(config)
  // The booted profile service is authoritative: it knows the profile name and
  // the resolved home. Environment variables are only a fallback for direct
  // invocation (CLI/tests).
  const profileContext = typeof ctx.get === 'function' ? ctx.get('profileContext') : undefined
  const vault = createVault({
    home: settings.home ?? profileContext?.home,
    agentsHome: settings.agentsHome,
    profile: profileContext?.name,
    env: process.env,
  })

  const disposers = registerRoutes(ctx, vault, settings)
  ctx.effect(() => () => {
    for (const dispose of disposers) dispose()
  }, 'config-vault: routes')

  // Tools are optional in some compositions (headless/sdk), so wait for the
  // service instead of making it a hard injection.
  ctx.inject(['tools'], (toolCtx) => {
    toolCtx.effect(() => {
      const dispose = toolCtx.tools.register(buildTool(vault, settings))
      toolCtx.logger?.info?.('config-vault: tool registered (config_vault)')
      return dispose
    }, 'config-vault: config_vault tool')
  })

  ctx.logger?.info?.('config-vault: home=%s routes=%s/*', vault.home, settings.routePrefix)
}
