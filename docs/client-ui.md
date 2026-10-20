# Client UI contract — the 配置保险箱 settings section

Status: verified as far as possible without a browser (bundle composed into the boot graph, served with
200, factory contract unit-tested). Visual rendering must be confirmed once in a live GUI.

## Where it mounts

The browser half registers one entry in the `settings.section` slot, so the page appears as a section in
**设置** (Settings) → 配置保险箱, next to the built-in sections.

```js
const slots = ctx.get('slots')
slots.inject('settings.section', () => slots.register(
  { name: 'settings.section', id: 'config-vault', order: 40, label: '配置保险箱' },
  () => React.createElement(VaultPanel),
))
```

- `slots.inject(name, callback)` waits until the slot **type** is declared by the settings shell, so load
  order between this plugin and `@deepseek-ai/dsh-client-ui-settings-general` does not matter.
- `slots.register(def, renderFn)` returns a disposer; the render function is called by the shell and
  returns a React element. Keep it stable (hoisted) — creating a component type inside the callback makes
  React remount the panel on every render.
- The shell owns the modal, navigation and page chrome; the panel renders only its own body.

## Panel structure

| Region | Content | Empty / busy state |
|---|---|---|
| Header | title, one-line promise, chips for `home` / `profile` / snapshot count | chips hidden until `status` returns |
| Toolbar | 新建快照 / 刷新 / 导入快照包 / 导出最新快照 | buttons disabled while a request is in flight |
| Create form (toggle) | name, note, scope checkboxes (from `status.scopes`), 包含凭据 checkbox + warning | scope list comes from the host, never hardcoded |
| Snapshot list | name, kind badge (手动/自动), time, file count, bytes, scopes; per-row 对比/预演/恢复/导出/删除 | “还没有快照。先点「新建快照」。” |
| Detail area | diff renderer or restore-plan renderer | hidden until an action runs |
| Feedback | one success line, one error line | both hidden when empty |

All actions map 1:1 to `POST /config-vault/<action>` (see README); the browser half never touches the
filesystem itself.

## Data flow

```
VaultPanel
  └─ post(action, payload)  ──fetch(document.baseURI + 'config-vault/<action>')──▶ host routes
       ├─ { ok: true, value }   → render
       └─ { ok: false, error }  → setError(error.message)
```

- Requests are document-relative (`new URL('config-vault/…', document.baseURI)`) so the panel works when
  the GUI is mounted under a sub-path.
- The diff renderer shows per-file hunks; the host has already masked secret values (`••••••`), so the
  client never receives a live token.
- Restore is two-step: 恢复预演 (`plan`) → confirm dialog → 恢复 (`restore`). The host takes a safety
  snapshot before writing; the panel surfaces its id.
- Export: `export` returns `{ filename, content }`; the panel downloads it via a `Blob` + `<a download>`.
  If the snapshot contains credentials the host answers `passphrase-required` and the panel prompts for a
  passphrase once.
- Import: a hidden `<input type="file">` reads the JSON text and posts it; an encrypted bundle triggers
  the same passphrase prompt.

## Styling

No CSS files, no build. The panel injects one `<style data-plugin-css="dsh-config-vault/panel.css">`
element and uses host design tokens with fallbacks, so it follows the active light/dark theme:

```css
color: var(--dsw-alias-label-primary, #1f2329);
background: var(--dsw-alias-bg-layer-1, #fff);
border: 1px solid var(--dsw-alias-border-l1, #e5e7eb);
accent: var(--dsw-alias-brand-primary, #4d6bfe);
```

Semantics used: real `<button>`s, label-wrapped checkboxes, `title` on scope labels for their
description, `window.confirm` for destructive confirmations. Diff lines are coloured with
`+`/`-`/context classes *and* prefixed with `+`/`-`/space so the information does not depend on colour.

## Failure modes

| Symptom | Cause | Handling |
|---|---|---|
| route returns 403 | request did not come from loopback (proxy/remote GUI) | panel shows the host message; remote use is intentionally unsupported for configuration writes |
| `passphrase-required` on export | snapshot includes credentials | prompt, retry once |
| `snapshot-not-found` | stale list after another client removed it | refresh and show the error |
| 非 JSON response | route not registered (older host/profile) | “路由返回了非 JSON（HTTP …）” |

## Testing

- `test/client.test.js` evaluates `client.js` in a `node:vm` sandbox with a fake
  `window.__ModuleLoader__` and fake React, asserting: module id equals the loader entry name, factory
  returns `{ apply, inject }`, `apply` registers exactly one `settings.section`, and a missing `slots`
  service degrades with a warning instead of throwing.
- After install, open 设置 → 配置保险箱 once and confirm: list loads, 新建快照 works, 对比当前 shows a
  hunk, 恢复预演 shows counts, 恢复 asks for confirmation.
