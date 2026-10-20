# DSH host plugin API — contract this package relies on

Status: verified against **DSH 0.2.1-rc.2** on Windows (Electron-packaged build), 2026-10-20.
Scope: only the surfaces `dsh-config-vault` uses. No `@deepseek-ai/*` import is required at runtime;
everything below is plain ESM / standard interfaces, which is why this package has zero dependencies.

Evidence base (recorded during development on a Windows DSH 0.2.1-rc.2 install):

| Evidence | Establishes |
|---|---|
| A runnable plain-ESM probe plugin booted in an isolated `DSH_HOME` | `name`/`inject`/`Config`/`apply`, route registration, lazy tool registration, teardown, config validation rejection |
| Probe boot log | plugin applied, tool registered, HMR re-applied a config override |
| Probe boot with an invalid config value (`greeting: 42`) | the Loader **rejects** the row instead of mounting it |
| An isolated boot of this plugin + `scripts/e2e-http.mjs` | the real plugin's routes answer over HTTP and the full snapshot/diff/restore/export flow works |
| `dsh-config-vault/client.js` composed into `window.__DSH_BOOT__` and served in a `/plugins/??…` combo | the browser half is discovered and served without a build step |

## 1. Package manifest

```json
{
  "name": "dsh-config-vault",
  "type": "module",
  "main": "src/index.js",
  "exports": {
    ".": "./src/index.js",
    "./client": "./client.js",
    "./package.json": "./package.json"
  },
  "icon": "icon.svg",
  "dsh": {
    "engines": { "dsh": ">=0.2.1-rc.2" },
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web" }
  }
}
```

- `exports['./client']` is what the client-modules subsystem serves at `/plugins/<package>/client.js`
  and composes into the boot graph; it does **not** have to be a built `lib/client.js` — any file works.
- `dsh.bundle.patch` is a loader patch list. `insert` adds the plugin row when the package is listed in
  `dsh.profile.bundles`:

```yaml
- insert:
    - id: config-vault
      name: dsh-config-vault
      config:
        routePrefix: /config-vault
```

- `dsh.client.inject` (external module requests) can be omitted when React + the slots service are enough
  (verified with `@dshp/token-meter`, which registers a settings section with no `inject` list).
- `icon` may be svg/png/jpg/webp ≤ 256 KiB; the host inlines it as a data URL on the plugin card.

## 2. Host half entry

```js
export const name = 'dsh-config-vault'   // loader label
export const inject = ['webServer']      // hard service dependencies
export const Config = { '~standard': { version: 1, vendor: '…', validate } }  // optional
export function apply(ctx, config) { /* register routes/tools */ }
```

- `Config` accepts the **Standard Schema v1** interface (`~standard.validate(raw)` returning `{ value }`
  or `{ issues }`). A `@deepseek-ai/schemastery` schema is *not* required. Trade-off: without
  schemastery the Host cannot auto-generate a settings form for the row; this plugin ships its own
  settings page instead.
- If `Config` validation fails, boot fails loudly — confirmed with the probe (`greeting: 42`).
- `apply(ctx, config)` receives the validated config. `ctx` is the Cordis context.

## 3. Services used

```js
export function apply(ctx, config) {
  const disposers = ctx.webServer.register({ kind: 'exact', path: '/config-vault/status', handler })
  ctx.effect(() => () => disposers.forEach(dispose => dispose()), 'config-vault: routes')

  ctx.inject(['tools'], (toolCtx) => {
    toolCtx.effect(() => toolCtx.tools.register(toolDefinition), 'config-vault: tool')
  })

  const profile = ctx.get('profileContext')   // { name, home, dir, patchPath, ... }
  ctx.logger?.info?.('config-vault: home=%s', profile?.home)
}
```

- `webServer.register({ kind: 'exact' | 'prefix', path, handler })` → disposer. Handler is
  `(req: IncomingMessage, res: ServerResponse)`; the host does not implement bodies for you.
- `ctx.effect(body)` runs `body()` and registers its returned disposer for unload/HMR.
- `ctx.inject(['service'], callback)` waits for optional services; use it for `tools`, which headless
  compositions may not have.
- `profileContext` is provided by the launcher before plugin packages mount:
  `{ name: 'vault', home, dir, patchPath, startedBundles, cwd, … }`. It is the authoritative source
  for the profile name and `$DSH_HOME`; environment fallbacks are for standalone use.
- `ctx.get('slots')` on the client tree; `ctx.get(name)` returns `undefined` for an unavailable service.

## 4. Model-facing tool definition

```js
{
  name: 'config_vault',
  description: '…',
  parameters: { type: 'object', additionalProperties: false, properties: {…}, required: ['action'] },
  output: {
    schema: { type: 'object', additionalProperties: true },
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
  },
  timeoutMs: 120_000,
  async execute(args, exec) { return { ok: true, … } },
}
```

`execute` may return a plain object or throw; this plugin returns `{ ok, … }` objects so the model can
read failures as data. `exec` carries the calling session (`exec.agent.session…` when present).

## 5. Browser half

The bundle is plain CJS-in-a-closure registered with the boot kernel facade:

```js
window.__ModuleLoader__.load({
  id: 'dsh-config-vault',            // MUST equal the loader entry / package name
  factory: (require) => {
    const module = { exports: {} }
    const React = require('react')   // shared browser module table; no bundler needed
    const h = React.createElement

    function apply(ctx) {
      const slots = ctx.get('slots')
      slots.inject('settings.section', () => slots.register(
        { name: 'settings.section', id: 'config-vault', order: 40, label: '配置保险箱' },
        () => React.createElement(VaultPanel),   // render function, hovered on re-render
      ))
    }

    module.exports.apply = apply
    module.exports.inject = ['slots']
    return module.exports
  },
})
```

Details that matter:

- `id` must be the loader entry name (`dsh-config-vault`); a mismatch makes ModuleLoader report
  "loaded without registering …".
- `require('react')` resolves from the frozen platform module table; do not import React yourself.
- `slots.register(def, renderFn)`: `def.id` is the registration id (free-form), `label` may be a string
  or a locale-following thunk, `order` sorts the settings navigation. `renderFn` returns a React element
  and must be stable across renders (hoist it; do not create a component type inside the callback).
- Style with host CSS variables (`--dsw-alias-*`) and inject a `<style data-plugin-css="…">` element;
  no CSS file machinery is needed.
- `ctx.locale.register(ns, { zh, en })` exists, but a plugin may hardcode copy; this one does (zh-first).

## 6. Route trust

The plugin implements its own fence on every route (see `src/host/http.js`):

1. socket peer must be 127/8, `::1` or `::ffff:127.0.0.1`;
2. `Host` must be a loopback authority;
3. any `X-Forwarded-For` / `CF-Connecting-IP` refuses the request (a proxy makes both 1 and 2 describe
   the proxy);
4. `Sec-Fetch-Site: cross-site` and a mismatching `Origin` are refused;
5. mutations are POST + `application/json` only, bodies are bounded.

Same-origin browser `fetch('/config-vault/…')` from the served GUI works without an extra token; the
web shell's own token gate is not needed for loopback routes (verified by running the e2e script
against an isolated boot).

## 7. Not verified / caveats

- The settings page was **not** visually inspected in a browser during development; the client bundle
  was verified as: composed into the boot graph, served with 200, contains the expected module id, and
  its factory/slot registration contract is covered by `test/client.test.js`. Install and open
  设置 → 配置保险箱 once after install to confirm rendering in your build.
- `dsh.client.inject` composition rules are documented by `@deepseek-ai/dsh-client-modules`; this
  package deliberately lists no external modules.
- Host release changes can change these contracts; `dsh.engines.dsh` pins the tested range.
